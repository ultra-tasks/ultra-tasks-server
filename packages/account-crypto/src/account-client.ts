import { client as opaque, ready } from '@serenity-kit/opaque';
import { randomKey, encode, utf8 } from './encoding';
import {
  AccountBundle,
  VaultContext,
  VaultSecrets,
  createAccountBundle,
  unlockBundle,
  rewrapPassword,
  sign,
} from './vault';

export interface AccountInfo {
  id: string;
  email: string;
  username: string | null;
  displayName: string;
  vaultVersion: number;
}
export interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
export interface Capabilities {
  protocol: 2;
  serverId: string;
  features: Record<string, boolean>;
  requireTermsConsent?: boolean;
  hasOperatorTerms?: boolean;
}
export interface LoginResult extends Partial<Tokens> {
  mfaToken?: string;
  factors?: string[];
  account?: AccountInfo;
}
export type Transport = (
  path: string,
  body?: object,
  accessToken?: string,
  method?: string,
) => Promise<unknown>;
export class AccountApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export const httpTransport =
  (baseUrl: string, timeoutMs = 30000): Transport =>
  async (path, body, accessToken, method = body ? 'POST' : 'GET') => {
    const headers = new Headers();
    if (body) headers.set('Content-Type', 'application/json');
    if (accessToken) headers.set('Authorization', 'Bearer ' + accessToken);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(
        baseUrl.replace(/\/$/, '') + '/api/v2/accounts' + path,
        {
          method,
          cache: 'no-store',
          credentials: 'omit',
          headers,
          signal: controller.signal,
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      const result = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new AccountApiError(
          response.status,
          result.error ?? 'Account request failed',
        );
      return result;
    } catch (error) {
      if (controller.signal.aborted)
        throw new TypeError('Account server request timed out');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

/** Passwords and unwrapped keys exist only in this client's memory, never in HTTP bodies. */
export class AccountClient {
  capabilities?: Capabilities;
  account?: AccountInfo;
  tokens?: Tokens;
  bundle?: AccountBundle;
  unlocked?: { masterKey: string; secrets: VaultSecrets };
  private pending?: { password: string; mfaToken: string };
  private refreshAt = 0;
  private refreshing?: Promise<void>;
  onTokensChanged?: () => Promise<void>;
  adoptTokens(tokens: Tokens): void {
    this.tokens = tokens;
    const earlyRefreshSeconds = Math.max(0, Math.min(600, tokens.expiresIn) - 60);
    const earlyRefreshMs = earlyRefreshSeconds * 1000;
    this.refreshAt = Date.now() + earlyRefreshMs;
  }
  constructor(readonly transport: Transport) {}
  async init(): Promise<Capabilities> {
    await ready;
    const capabilities = (await this.transport('/capabilities')) as Capabilities;
    if (capabilities.protocol !== 2 || !/^[0-9a-f-]{36}$/i.test(capabilities.serverId))
      throw new Error('Unsupported account server');
    this.capabilities = capabilities;
    return capabilities;
  }
  identity(accountId = this.account?.id): VaultContext {
    if (!this.capabilities || !accountId) throw new Error('No account identity');
    return { serverId: this.capabilities.serverId, accountId };
  }
  async prepareRegistration(
    details: {
      email: string;
      username?: string;
      displayName: string;
      termsAccepted?: boolean;
    },
    password: string,
  ): Promise<{
    recoveryKey: string;
    request: {
      registrationToken: string;
      registrationRecord: string;
      bundle: AccountBundle;
    };
  }> {
    if (!this.capabilities) await this.init();
    const start = opaque.startRegistration({ password });
    const response = (await this.transport('/register/start', {
      ...details,
      registrationRequest: start.registrationRequest,
    })) as {
      serverId: string;
      accountId: string;
      registrationToken: string;
      registrationResponse: string;
      keyStretching: string;
    };
    if (
      response.serverId !== this.capabilities!.serverId ||
      response.keyStretching !== 'memory-constrained'
    )
      throw new Error('Account server identity or crypto changed');
    const result = opaque.finishRegistration({
      ...start,
      registrationResponse: response.registrationResponse,
      password,
      keyStretching: 'memory-constrained',
    });
    const vault = await createAccountBundle(password, this.identity(response.accountId));
    return {
      recoveryKey: vault.recoveryKey,
      request: {
        registrationToken: response.registrationToken,
        registrationRecord: result.registrationRecord,
        bundle: vault.bundle,
      },
    };
  }
  async register(
    prepared: Awaited<ReturnType<AccountClient['prepareRegistration']>>,
  ): Promise<void> {
    await this.transport('/register/finish', prepared.request);
  }
  async login(
    identifier: string,
    password: string,
    deviceName = 'This device',
  ): Promise<LoginResult> {
    this.lock();
    if (!this.capabilities) await this.init();
    const started = opaque.startLogin({ password });
    const response = (await this.transport('/login/start', {
      identifier,
      startLoginRequest: started.startLoginRequest,
      deviceName,
    })) as {
      loginToken: string;
      loginResponse: string;
      serverId: string;
      keyStretching: string;
    };
    if (
      response.serverId !== this.capabilities!.serverId ||
      response.keyStretching !== 'memory-constrained'
    )
      throw new Error('Account server identity or crypto changed');
    const proof = opaque.finishLogin({
      ...started,
      password,
      loginResponse: response.loginResponse,
      keyStretching: 'memory-constrained',
    });
    if (!proof) throw new Error('Invalid email, username, or password');
    const result = (await this.transport('/login/finish', {
      loginToken: response.loginToken,
      finishLoginRequest: proof.finishLoginRequest,
    })) as LoginResult;
    if (result.mfaToken) this.pending = { password, mfaToken: result.mfaToken };
    else await this.finishLogin(result as Tokens, password);
    return result;
  }
  async finishLogin(tokens: Tokens, password: string): Promise<void> {
    if (!tokens.accessToken || !tokens.refreshToken)
      throw new Error('Incomplete session');
    const result = (await this.transport('/me', undefined, tokens.accessToken)) as {
      account: AccountInfo;
      bundle: AccountBundle;
    };
    const unlocked = await unlockBundle(result.bundle, this.identity(result.account.id), {
      password,
    });
    this.tokens = tokens;
    this.refreshAt = Date.now() + 540000;
    this.account = result.account;
    this.bundle = result.bundle;
    this.unlocked = unlocked;
    this.pending = undefined;
  }
  async completeMfa(code: string): Promise<void> {
    if (!this.pending) throw new Error('Sign in first');
    const pending = this.pending;
    const result = (await this.transport('/mfa/complete', {
      mfaToken: pending.mfaToken,
      code,
    })) as Tokens;
    await this.finishLogin(result, pending.password);
  }
  async webauthnLoginOptions(): Promise<{ options: object; credentialToken: string }> {
    if (!this.pending) throw new Error('Sign in first');
    return this.transport('/mfa/webauthn/options', {
      mfaToken: this.pending.mfaToken,
    }) as Promise<{ options: object; credentialToken: string }>;
  }
  async completeWebauthn(credentialToken: string, credential: unknown): Promise<void> {
    if (!this.pending) throw new Error('Sign in first');
    const password = this.pending.password;
    const result = (await this.transport('/mfa/webauthn/complete', {
      credentialToken,
      credential,
    })) as Tokens;
    await this.finishLogin(result, password);
  }
  async startBrowserMfa(): Promise<{
    url: string;
    ticket: string;
    deviceSecret: string;
  }> {
    if (!this.pending) throw new Error('Sign in first');
    const deviceSecret = randomKey();
    const proofHash = encode(await crypto.subtle.digest('SHA-256', utf8(deviceSecret)));
    const result = (await this.transport('/mfa/browser/start', {
      mfaToken: this.pending.mfaToken,
      proofHash,
    })) as { ticket: string; url: string };
    return { ...result, deviceSecret };
  }
  async pollBrowserMfa(flow: { ticket: string; deviceSecret: string }): Promise<boolean> {
    const pending = this.pending;
    if (!pending) throw new Error('Sign in first');
    const result = (await this.transport('/mfa/browser/poll', {
      ticket: flow.ticket,
      deviceSecret: flow.deviceSecret,
    })) as Tokens | { pending: true };
    if (this.pending !== pending) throw new Error('Login was cancelled');
    if ('pending' in result) return false;
    await this.finishLogin(result, pending.password);
    return true;
  }
  async request<T>(path: string, data?: object, method?: string): Promise<T> {
    if (!this.tokens) throw new Error('Sign in first');
    if (Date.now() >= this.refreshAt) {
      this.refreshing ??= this.transport('/sessions/refresh', {
        refreshToken: this.tokens.refreshToken,
      })
        .then(async (tokens) => {
          this.adoptTokens(tokens as Tokens);
          await this.onTokensChanged?.();
        })
        .finally(() => {
          this.refreshing = undefined;
        });
      await this.refreshing;
    }
    return this.transport(path, data, this.tokens.accessToken, method) as Promise<T>;
  }
  async deleteAccount(): Promise<void> {
    if (!this.unlocked || !this.account) throw new Error('Unlock the account first');
    const data = {
      action: 'delete-account',
      ...this.identity(),
      vaultVersion: this.account.vaultVersion,
    };
    await this.request('/delete', {
      vaultVersion: data.vaultVersion,
      signature: await sign(this.unlocked.secrets.signingPrivateKey, data),
    });
    this.lock();
  }
  async changePassword(password: string): Promise<void> {
    if (!this.unlocked || !this.bundle) throw new Error('Unlock the account first');
    const started = opaque.startRegistration({ password });
    const response = await this.request<{
      registrationResponse: string;
      changeToken: string;
    }>('/password/start', { registrationRequest: started.registrationRequest });
    const registration = opaque.finishRegistration({
      ...started,
      password,
      registrationResponse: response.registrationResponse,
      keyStretching: 'memory-constrained',
    });
    const bundle = await rewrapPassword(
      this.bundle,
      this.unlocked.masterKey,
      password,
      this.identity(),
    );
    const proof = {
      action: 'password',
      token: response.changeToken,
      registrationRecord: registration.registrationRecord,
      bundle,
    };
    this.tokens = await this.request<Tokens>('/password/finish', {
      changeToken: response.changeToken,
      registrationRecord: registration.registrationRecord,
      bundle,
      signature: await sign(this.unlocked.secrets.signingPrivateKey, proof),
    });
    this.bundle = bundle;
    this.refreshAt = Date.now() + 540000;
    if (this.account) this.account.vaultVersion += 1;
  }
  async recover(
    mailToken: string,
    recoveryKey: string,
    password: string,
    code?: string,
  ): Promise<void> {
    if (!this.capabilities) await this.init();
    const started = opaque.startRegistration({ password });
    const response = (await this.transport('/recovery/start', {
      token: mailToken,
      registrationRequest: started.registrationRequest,
    })) as {
      accountId: string;
      serverId: string;
      keyStretching: string;
      bundle: AccountBundle;
      registrationResponse: string;
      recoveryToken: string;
    };
    if (
      response.serverId !== this.capabilities!.serverId ||
      response.keyStretching !== 'memory-constrained'
    )
      throw new Error('Account server identity or crypto changed');
    const identity = this.identity(response.accountId);
    const unlocked = await unlockBundle(response.bundle, identity, { recoveryKey });
    const registration = opaque.finishRegistration({
      ...started,
      password,
      registrationResponse: response.registrationResponse,
      keyStretching: 'memory-constrained',
    });
    const bundle = await rewrapPassword(
      response.bundle,
      unlocked.masterKey,
      password,
      identity,
    );
    const proof = {
      action: 'recover',
      token: response.recoveryToken,
      registrationRecord: registration.registrationRecord,
      bundle,
    };
    await this.transport('/recovery/finish', {
      recoveryToken: response.recoveryToken,
      registrationRecord: registration.registrationRecord,
      bundle,
      signature: await sign(unlocked.secrets.signingPrivateKey, proof),
      ...(code ? { code } : {}),
    });
    this.lock();
  }
  lock(): void {
    this.pending = undefined;
    this.tokens = undefined;
    this.unlocked = undefined;
    this.account = undefined;
    this.bundle = undefined;
  }
}
