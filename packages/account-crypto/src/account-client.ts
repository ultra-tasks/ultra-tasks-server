import { randomKey, encode, utf8, canonical, fingerprint } from './encoding';

// Keep optional password WASM out of an application's initial module graph.
const opaqueClient = async () => {
  const { client, ready } = await import('@serenity-kit/opaque');
  await ready;
  return client;
};
import {
  newBrowserLogin,
  validatePendingBrowserLogin,
  receiveBrowserLogin,
  type BrowserLoginRequest,
  type BrowserLoginReturn,
  type BrowserLoginApproval,
  type PendingBrowserLogin,
} from './browser-login';
import {
  AccountBundle,
  VaultContext,
  VaultSecrets,
  createAccountBundle,
  unlockBundle,
  unlockBundleWithMasterKey,
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
  /**
   * Boolean flags, plus a few string-valued descriptors such as
   * `sessionLifetime: 'sliding-v1'`. Compare booleans with `=== true`.
   */
  features: Record<string, boolean | string>;
  requireTermsConsent?: boolean;
  hasOperatorTerms?: boolean;
}
/** Pending new-device email challenge returned by sign-in and by resend. */
export interface DeviceVerification {
  kind: 'email';
  /** Opaque challenge handle; the SDK keeps it, apps only display the other fields. */
  token: string;
  /** Seconds until the code expires. */
  expiresIn: number;
  /** Seconds before another code may be requested. */
  resendAfter: number;
  resendsLeft?: number;
  /** Masked address such as `d***@example.test`; never the full address. */
  emailHint: string;
}
export interface LoginOptions {
  /** The device token saved by an earlier sign-in on this installation, if any. */
  deviceToken?: string;
}
export interface LoginResult extends Partial<Tokens> {
  mfaToken?: string;
  factors?: string[];
  account?: AccountInfo;
  /** Present when the server needs an email code before it issues a session. */
  verification?: DeviceVerification;
  /** Present only when the server newly trusted this device; store it securely. */
  deviceToken?: string;
}
export interface DeviceInfo {
  id: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
  /** Live sessions that belong to this device. */
  sessions: number;
}
export interface SecuritySettings {
  newDeviceEmailVerification: boolean;
  /** False on servers that do not offer the feature; hide the control then. */
  available: boolean;
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
    /** Stable machine-readable reason, for example `client_update_required`. */
    readonly code?: string,
  ) {
    super(message);
  }
}
/** Sign-in that stopped at an MFA or email-code step; the password stays in memory only. */
interface PendingSignIn {
  password: string;
  mfaToken?: string;
  verification?: DeviceVerification;
  /** The valid device token presented at sign-in, kept for the MFA step. */
  deviceToken?: string;
}
const DEVICE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const CAPABILITIES_MAX_AGE = 600000;
const validDeviceToken = (value?: string): string | undefined =>
  value !== undefined && DEVICE_TOKEN.test(value) ? value : undefined;
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
      const result = (await response.json()) as { error?: string; code?: string };
      if (!response.ok)
        throw new AccountApiError(
          response.status,
          result.error ?? 'Account request failed',
          typeof result.code === 'string' ? result.code : undefined,
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
  private pending?: PendingSignIn;
  private refreshAt = 0;
  private refreshing?: Promise<void>;
  private browserLogin?: PendingBrowserLogin;
  private capabilitiesAt?: number;
  private currentDeviceToken?: string;
  onTokensChanged?: () => Promise<void>;
  /**
   * The device token to persist after a sign-in on this client: the one the server newly
   * issued, otherwise the valid one passed to `login()` or `pollBrowserLogin()`. Store it
   * in protected storage and pass it to the next sign-in. `lock()` deliberately keeps it: it
   * identifies the installation, not the unlocked session. A newly issued token is shown
   * once, so it is kept as soon as it arrives, even if unlocking the vault then fails; a
   * failed attempt that did not receive one leaves the previous value untouched.
   */
  get deviceToken(): string | undefined {
    return this.currentDeviceToken;
  }
  /** The email challenge waiting for a code, if sign-in stopped at that step. */
  get pendingDeviceVerification(): DeviceVerification | undefined {
    return this.pending?.verification;
  }
  adoptTokens(tokens: Tokens): void {
    this.tokens = tokens;
    const earlyRefreshSeconds = Math.max(0, Math.min(600, tokens.expiresIn) - 60);
    const earlyRefreshMs = earlyRefreshSeconds * 1000;
    this.refreshAt = Date.now() + earlyRefreshMs;
  }
  constructor(readonly transport: Transport) {}
  async init(): Promise<Capabilities> {
    await opaqueClient();
    const capabilities = (await this.transport('/capabilities')) as Capabilities;
    if (capabilities.protocol !== 2 || !/^[0-9a-f-]{36}$/i.test(capabilities.serverId))
      throw new Error('Unsupported account server');
    this.capabilities = capabilities;
    this.capabilitiesAt = Date.now();
    return capabilities;
  }
  /** Capabilities decide which keys a sign-in may send, so a stale copy is refreshed. */
  private async freshCapabilities(): Promise<Capabilities> {
    if (
      !this.capabilities ||
      (this.capabilitiesAt !== undefined &&
        Date.now() - this.capabilitiesAt > CAPABILITIES_MAX_AGE)
    )
      await this.init();
    return this.capabilities!;
  }
  private deviceEmailAdvertised(): boolean {
    return this.capabilities?.features.newDeviceEmailVerification === true;
  }
  /** Keys that older servers reject are sent only after the server advertised support. */
  private deviceFeatureKeys(deviceToken?: string): {
    clientFeatures?: string[];
    deviceToken?: string;
  } {
    if (!this.deviceEmailAdvertised()) return {};
    const token = validDeviceToken(deviceToken);
    return { clientFeatures: ['deviceEmail'], ...(token ? { deviceToken: token } : {}) };
  }
  private adoptDeviceToken(issued?: string, presented?: string): void {
    this.currentDeviceToken = validDeviceToken(issued) ?? validDeviceToken(presented);
  }
  async startBrowserLogin(
    serverUrl: string,
    redirectUri: BrowserLoginReturn,
    deviceName: string,
    identifier?: string,
  ): Promise<PendingBrowserLogin> {
    this.lock();
    await this.init();
    if (!this.capabilities!.features.browserLogin)
      throw new Error('Update this server to use browser sign-in');
    const url = new URL(serverUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        ))
    )
      throw new Error('Invalid account server URL');
    const created = await newBrowserLogin({
      serverId: this.capabilities!.serverId,
      serverUrl: url.href.replace(/\/$/, ''),
      redirectUri,
      deviceName,
      ...(identifier?.trim() ? { identifier: identifier.trim().toLowerCase() } : {}),
    });
    const request = (await this.transport(
      '/browser-login/start',
      created.input,
    )) as BrowserLoginRequest;
    const { ticket: _ticket, expiresAt: _expiry, ...binding } = request;
    if (canonical(binding) !== canonical(created.input))
      throw new Error('Account sign-in request changed');
    const flow = { request, verifier: created.verifier, privateKey: created.privateKey };
    await validatePendingBrowserLogin(flow);
    this.browserLogin = flow;
    return flow;
  }
  async resumeBrowserLogin(flow: PendingBrowserLogin): Promise<void> {
    await validatePendingBrowserLogin(flow);
    await this.init();
    if (this.capabilities!.serverId !== flow.request.serverId)
      throw new Error('Account server identity changed');
    this.browserLogin = flow;
  }
  async cancelBrowserLogin(): Promise<void> {
    const flow = this.browserLogin;
    this.browserLogin = undefined;
    if (flow)
      await this.transport('/browser-login/cancel', {
        ticket: flow.request.ticket,
        state: flow.request.state,
        verifier: flow.verifier,
        serverId: flow.request.serverId,
      });
  }
  /**
   * Redeems an approved browser sign-in. Pass the device token saved by an earlier
   * sign-in on this installation so the server reuses that device record; a newly
   * trusted device is returned as `deviceToken` afterwards.
   */
  async pollBrowserLogin(options: LoginOptions = {}): Promise<boolean> {
    const flow = this.browserLogin;
    if (!flow) throw new Error('No pending app sign-in');
    await validatePendingBrowserLogin(flow);
    const result = (await this.transport('/browser-login/poll', {
      ticket: flow.request.ticket,
      state: flow.request.state,
      verifier: flow.verifier,
      serverId: flow.request.serverId,
      ...this.deviceFeatureKeys(options.deviceToken),
    })) as
      | { pending: true }
      | {
          request: BrowserLoginRequest;
          approval: BrowserLoginApproval;
          tokens: Tokens;
          deviceToken?: string;
        };
    if ('pending' in result) return false;
    if (this.browserLogin !== flow) {
      await this.revokeBrowserSession(result.tokens);
      throw new Error('Login was cancelled');
    }
    try {
      if (canonical(result.request) !== canonical(flow.request))
        throw new Error('App sign-in binding changed');
      const me = (await this.transport('/me', undefined, result.tokens.accessToken)) as {
        account: AccountInfo;
        bundle: AccountBundle;
      };
      if (
        this.capabilities!.serverId !== flow.request.serverId ||
        me.account.id !== result.approval.accountId ||
        me.account.vaultVersion !== result.approval.vaultVersion ||
        (await fingerprint(me.bundle)) !== result.approval.bundleHash ||
        (flow.request.identifier &&
          ![me.account.email, me.account.username].includes(flow.request.identifier))
      )
        throw new Error('Account sign-in identity changed');
      const key = await receiveBrowserLogin(
        flow,
        result.approval,
        me.bundle.signingPublicKey,
      );
      const unlocked = await unlockBundleWithMasterKey(
        me.bundle,
        this.identity(me.account.id),
        key,
      );
      if (this.browserLogin !== flow) throw new Error('Login was cancelled');
      this.account = me.account;
      this.bundle = me.bundle;
      this.unlocked = unlocked;
      this.adoptTokens(result.tokens);
      this.adoptDeviceToken(result.deviceToken, options.deviceToken);
      this.browserLogin = undefined;
      return true;
    } catch (error) {
      await this.revokeBrowserSession(result.tokens);
      throw error;
    }
  }
  private async revokeBrowserSession(tokens: Tokens): Promise<void> {
    try {
      const sessions = (await this.transport(
        '/sessions',
        undefined,
        tokens.accessToken,
      )) as { id: string; current: boolean }[];
      const current = sessions.find((s) => s.current);
      if (current)
        await this.transport(
          '/sessions/revoke',
          { sessionId: current.id },
          tokens.accessToken,
        );
    } catch {
      /* Session may already have been revoked. Never install a rejected grant. */
    }
  }
  identity(accountId = this.account?.id): VaultContext {
    if (!this.capabilities || !accountId) throw new Error('No account identity');
    return { serverId: this.capabilities.serverId, accountId };
  }
  async prepareRegistration(
    details: {
      email: string;
      /** Legacy; new sign-ups send only email and password. */
      username?: string;
      /** Legacy; the server defaults it to an empty string. */
      displayName?: string;
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
    const opaque = await opaqueClient();
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
  /**
   * Password sign-in. The result is one of: a session (the client is unlocked), an MFA
   * challenge (`mfaToken`, finish with `completeMfa`/WebAuthn), or a new-device email
   * challenge (`verification`, finish with `completeDeviceVerification`). Pass the
   * device token from the previous sign-in on this installation in `options`.
   */
  async login(
    identifier: string,
    password: string,
    deviceName = 'This device',
    options: LoginOptions = {},
  ): Promise<LoginResult> {
    this.lock();
    await this.freshCapabilities();
    try {
      return await this.signIn(identifier, password, deviceName, options);
    } catch (error) {
      // A server that switched the feature on after our capabilities were fetched refuses a
      // client that did not declare support. Look once more and retry with the right keys.
      if (
        error instanceof AccountApiError &&
        error.code === 'client_update_required' &&
        !this.deviceEmailAdvertised()
      ) {
        await this.init();
        if (this.deviceEmailAdvertised())
          return this.signIn(identifier, password, deviceName, options);
      }
      throw error;
    }
  }
  private async signIn(
    identifier: string,
    password: string,
    deviceName: string,
    options: LoginOptions,
  ): Promise<LoginResult> {
    const opaque = await opaqueClient();
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
      ...this.deviceFeatureKeys(options.deviceToken),
    })) as LoginResult;
    const presented = validDeviceToken(options.deviceToken);
    if (result.mfaToken)
      this.pending = { password, mfaToken: result.mfaToken, deviceToken: presented };
    else if (result.verification)
      this.pending = { password, verification: result.verification };
    else {
      // A new token is shown once: keep it before the vault unlock, which can still fail.
      this.adoptDeviceToken(result.deviceToken, presented);
      await this.finishLogin(result as Tokens, password);
    }
    return result;
  }
  /** Submits the emailed code. Failure leaves the challenge pending so the user can retry. */
  async completeDeviceVerification(code: string): Promise<void> {
    const pending = this.pending;
    if (!pending?.verification) throw new Error('Sign in first');
    const result = (await this.transport('/login/device/verify', {
      token: pending.verification.token,
      code: code.replace(/\s+/g, ''),
    })) as Tokens & { deviceToken?: string };
    if (this.pending !== pending) throw new Error('Login was cancelled');
    this.adoptDeviceToken(result.deviceToken);
    await this.finishLogin(result, pending.password);
  }
  /**
   * Asks for a replacement code; the server enforces the cooldown and the resend limit (429,
   * the challenge stays). A refusal that means the challenge is gone (expired, locked, or
   * mail could not be delivered) ends the pending sign-in: sign in again.
   */
  async resendDeviceVerification(): Promise<DeviceVerification> {
    const pending = this.pending;
    if (!pending?.verification) throw new Error('Sign in first');
    let result: { verification: DeviceVerification };
    try {
      result = (await this.transport('/login/device/resend', {
        token: pending.verification.token,
      })) as { verification: DeviceVerification };
    } catch (error) {
      if (
        error instanceof AccountApiError &&
        (error.status === 401 || error.status === 503) &&
        this.pending === pending
      )
        this.pending = undefined;
      throw error;
    }
    if (this.pending !== pending) throw new Error('Login was cancelled');
    pending.verification = result.verification;
    return result.verification;
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
  private pendingMfa(): PendingSignIn & { mfaToken: string } {
    const pending = this.pending;
    if (!pending?.mfaToken) throw new Error('Sign in first');
    return pending as PendingSignIn & { mfaToken: string };
  }
  private async finishMfaLogin(
    pending: PendingSignIn,
    result: Tokens & { deviceToken?: string },
  ): Promise<void> {
    this.adoptDeviceToken(result.deviceToken, pending.deviceToken);
    await this.finishLogin(result, pending.password);
  }
  async completeMfa(code: string): Promise<void> {
    const pending = this.pendingMfa();
    const result = (await this.transport('/mfa/complete', {
      mfaToken: pending.mfaToken,
      code,
    })) as Tokens & { deviceToken?: string };
    await this.finishMfaLogin(pending, result);
  }
  async webauthnLoginOptions(): Promise<{ options: object; credentialToken: string }> {
    const pending = this.pendingMfa();
    return this.transport('/mfa/webauthn/options', {
      mfaToken: pending.mfaToken,
    }) as Promise<{ options: object; credentialToken: string }>;
  }
  async completeWebauthn(credentialToken: string, credential: unknown): Promise<void> {
    const pending = this.pendingMfa();
    const result = (await this.transport('/mfa/webauthn/complete', {
      credentialToken,
      credential,
    })) as Tokens & { deviceToken?: string };
    await this.finishMfaLogin(pending, result);
  }
  async startBrowserMfa(): Promise<{
    url: string;
    ticket: string;
    deviceSecret: string;
  }> {
    const pending = this.pendingMfa();
    const deviceSecret = randomKey();
    const proofHash = encode(await crypto.subtle.digest('SHA-256', utf8(deviceSecret)));
    const result = (await this.transport('/mfa/browser/start', {
      mfaToken: pending.mfaToken,
      proofHash,
    })) as { ticket: string; url: string };
    return { ...result, deviceSecret };
  }
  async pollBrowserMfa(flow: { ticket: string; deviceSecret: string }): Promise<boolean> {
    const pending = this.pendingMfa();
    const result = (await this.transport('/mfa/browser/poll', {
      ticket: flow.ticket,
      deviceSecret: flow.deviceSecret,
    })) as (Tokens & { deviceToken?: string }) | { pending: true };
    if (this.pending !== pending) throw new Error('Login was cancelled');
    if ('pending' in result) return false;
    await this.finishMfaLogin(pending, result);
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
  /** Account security settings. `available` is false on servers without the feature. */
  async getSecuritySettings(): Promise<SecuritySettings> {
    const me = await this.request<{
      settings?: { newDeviceEmailVerification?: boolean };
    }>('/me');
    const capabilities = await this.freshCapabilities();
    return {
      newDeviceEmailVerification: me.settings?.newDeviceEmailVerification === true,
      available: capabilities.features.newDeviceEmailVerification === true,
    };
  }
  /**
   * Turns new-device email verification on or off. Needs a sign-in from the last ten
   * minutes and, to turn it off while a second factor is enrolled, a valid MFA code.
   */
  async setNewDeviceEmailVerification(
    enabled: boolean,
    code?: string,
  ): Promise<{ newDeviceEmailVerification: boolean }> {
    return this.request('/security/new-device-email', {
      enabled,
      ...(code?.trim() ? { code: code.trim() } : {}),
    });
  }
  /** Trusted devices, most recently active first. Check `features.trustedDevices` first. */
  async devices(): Promise<DeviceInfo[]> {
    return this.request<DeviceInfo[]>('/devices');
  }
  /**
   * Removes a device and ends every session bound to it. Removing the device you are signed in on
   * needs nothing more. Removing another one needs a sign-in from the last ten minutes and, while
   * a second factor is enrolled, a valid MFA or recovery code in `code`.
   */
  async revokeDevice(deviceId: string, code?: string): Promise<void> {
    await this.request('/devices/revoke', {
      deviceId,
      ...(code?.trim() ? { code: code.trim() } : {}),
    });
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
    const opaque = await opaqueClient();
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
    const opaque = await opaqueClient();
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
    this.browserLogin = undefined;
    this.pending = undefined;
    this.tokens = undefined;
    this.unlocked = undefined;
    this.account = undefined;
    this.bundle = undefined;
  }
}
