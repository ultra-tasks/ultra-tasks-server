import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AccountApiError,
  AccountClient,
  canonical,
  createAccountBundle,
  httpTransport,
  opaqueClient,
  opaqueReady,
  opaqueServer,
  randomKey,
  type Transport,
} from '../src';

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const password = 'a long synthetic account password';
const identity = { serverId: crypto.randomUUID(), accountId: crypto.randomUUID() };
const account = {
  id: identity.accountId,
  email: 'dana@example.test',
  username: null,
  displayName: '',
  vaultVersion: 1,
};
type Reply = (body: Record<string, unknown>) => unknown;
interface Call {
  path: string;
  body?: Record<string, unknown>;
  accessToken?: string;
  method?: string;
}

/** A just-enough account server: real OPAQUE and vault, scripted session/challenge replies. */
const fixture = async () => {
  await opaqueReady;
  const setup = opaqueServer.createSetup();
  const userIdentifier = canonical(identity);
  const started = opaqueClient.startRegistration({ password });
  const response = opaqueServer.createRegistrationResponse({
    serverSetup: setup,
    userIdentifier,
    registrationRequest: started.registrationRequest,
  });
  const record = opaqueClient.finishRegistration({
    ...started,
    ...response,
    password,
    keyStretching: 'memory-constrained',
  }).registrationRecord;
  const vault = await createAccountBundle(password, identity);
  return { setup, userIdentifier, record, bundle: vault.bundle };
};

describe('device verification in the account client', () => {
  let shared: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    shared = await fixture();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const server = (
    features: Record<string, boolean | string>,
    replies: { finish?: Reply; verify?: Reply; resend?: Reply; mfa?: Reply } = {},
  ) => {
    const calls: Call[] = [];
    let loginState = '';
    const session = () => ({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 600,
      account,
    });
    const transport: Transport = async (path, body, accessToken, method) => {
      const request = body as Record<string, unknown> | undefined;
      calls.push({ path, body: request, accessToken, method });
      switch (path) {
        case '/capabilities':
          return { protocol: 2, serverId: identity.serverId, features: { ...features } };
        case '/login/start': {
          const login = opaqueServer.startLogin({
            serverSetup: shared.setup,
            registrationRecord: shared.record,
            userIdentifier: shared.userIdentifier,
            startLoginRequest: String(request!.startLoginRequest),
          });
          loginState = login.serverLoginState;
          return {
            loginToken: randomKey(),
            loginResponse: login.loginResponse,
            serverId: identity.serverId,
            keyStretching: 'memory-constrained',
          };
        }
        case '/login/finish':
          opaqueServer.finishLogin({
            serverLoginState: loginState,
            finishLoginRequest: String(request!.finishLoginRequest),
          });
          return (replies.finish ?? session)(request!);
        case '/login/device/verify':
          return (replies.verify ?? session)(request!);
        case '/login/device/resend':
          return replies.resend!(request!);
        case '/mfa/complete':
          return (replies.mfa ?? session)(request!);
        case '/me':
          return {
            account,
            bundle: shared.bundle,
            settings: features.newDeviceEmailVerification
              ? { newDeviceEmailVerification: true }
              : undefined,
          };
        default:
          return {};
      }
    };
    const calledWith = (path: string) => calls.filter((call) => call.path === path);
    return { transport, calls, calledWith };
  };
  const verification = (overrides: Record<string, unknown> = {}) => ({
    kind: 'email',
    token: randomKey(),
    expiresIn: 600,
    resendAfter: 30,
    resendsLeft: 3,
    emailHint: 'd***@example.test',
    ...overrides,
  });
  const supported = { newDeviceEmailVerification: true, trustedDevices: true };

  it('sends none of the new keys to a server that does not advertise the feature', async () => {
    const saved = randomKey();
    const fake = server({ passwordAccounts: true });
    const client = new AccountClient(fake.transport);
    await client.login('dana@example.test', password, 'Laptop', { deviceToken: saved });
    const body = fake.calledWith('/login/finish')[0].body!;
    expect(Object.keys(body).sort()).toEqual(['finishLoginRequest', 'loginToken']);
    expect(client.unlocked).toBeDefined();
    // Nothing was sent, so nothing new was issued; the caller's own token is handed back.
    expect(client.deviceToken).toBe(saved);
    expect(await client.getSecuritySettings()).toEqual({
      newDeviceEmailVerification: false,
      available: false,
    });
  });

  it('declares support and sends only a well-formed saved device token when advertised', async () => {
    const saved = randomKey();
    const fake = server(supported);
    const client = new AccountClient(fake.transport);
    await client.login('dana@example.test', password, 'Laptop', { deviceToken: saved });
    expect(fake.calledWith('/login/finish')[0].body).toMatchObject({
      clientFeatures: ['deviceEmail'],
      deviceToken: saved,
    });
    // A recognised device gets no new token; the SDK keeps reporting the saved one.
    expect(client.deviceToken).toBe(saved);

    const malformed = server(supported);
    await new AccountClient(malformed.transport).login(
      'dana@example.test',
      password,
      'Laptop',
      { deviceToken: 'not a token' },
    );
    expect(malformed.calledWith('/login/finish')[0].body).toEqual(
      expect.objectContaining({ clientFeatures: ['deviceEmail'] }),
    );
    expect(malformed.calledWith('/login/finish')[0].body).not.toHaveProperty(
      'deviceToken',
    );
  });

  it('stops at the email code, unlocks only after verification and adopts the new device token', async () => {
    const issued = randomKey();
    const challenge = verification();
    const fake = server(supported, {
      finish: () => ({ verification: challenge }),
      verify: (body) => {
        if (body.code !== '12345678')
          throw new AccountApiError(401, 'Invalid or expired verification code');
        return {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          expiresIn: 600,
          account,
          deviceToken: issued,
        };
      },
    });
    const client = new AccountClient(fake.transport);
    const result = await client.login('dana@example.test', password, 'Laptop');
    expect(result.verification).toEqual(challenge);
    expect(client.pendingDeviceVerification).toEqual(challenge);
    expect(client.unlocked).toBeUndefined();
    expect(client.tokens).toBeUndefined();
    await expect(client.completeMfa('123456')).rejects.toThrow('Sign in first');
    await expect(client.completeDeviceVerification('00000000')).rejects.toMatchObject({
      status: 401,
    });
    expect(client.unlocked).toBeUndefined();
    expect(client.pendingDeviceVerification).toBeDefined();

    await client.completeDeviceVerification('1234 5678');
    expect(fake.calledWith('/login/device/verify').at(-1)!.body).toEqual({
      token: challenge.token,
      code: '12345678',
    });
    expect(client.unlocked).toBeDefined();
    expect(client.deviceToken).toBe(issued);
    expect(client.pendingDeviceVerification).toBeUndefined();
    await expect(client.completeDeviceVerification('12345678')).rejects.toThrow(
      'Sign in first',
    );
    // Locking ends the session but the device token identifies the installation.
    client.lock();
    expect(client.deviceToken).toBe(issued);
  });

  it('asks for another code through the same challenge and surfaces limits as codes', async () => {
    const challenge = verification();
    const next = verification({ token: challenge.token, resendsLeft: 2 });
    let resends = 0;
    const fake = server(supported, {
      finish: () => ({ verification: challenge }),
      resend: () => {
        if (resends++ > 0)
          throw new AccountApiError(
            429,
            'Wait before requesting another code.',
            'resend_too_soon',
          );
        return { verification: next };
      },
    });
    const client = new AccountClient(fake.transport);
    await client.login('dana@example.test', password);
    await expect(client.resendDeviceVerification()).resolves.toEqual(next);
    expect(client.pendingDeviceVerification).toEqual(next);
    expect(fake.calledWith('/login/device/resend')[0].body).toEqual({
      token: challenge.token,
    });
    await expect(client.resendDeviceVerification()).rejects.toMatchObject({
      status: 429,
      code: 'resend_too_soon',
    });
    expect(client.pendingDeviceVerification).toEqual(next);
  });

  it('keeps the saved token through MFA and adopts a newly issued one', async () => {
    const saved = randomKey();
    const issued = randomKey();
    const fake = server(supported, {
      finish: () => ({ mfaToken: randomKey(), factors: ['totp'] }),
      mfa: () => ({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresIn: 600,
        account,
      }),
    });
    const client = new AccountClient(fake.transport);
    const pending = await client.login('dana@example.test', password, 'Laptop', {
      deviceToken: saved,
    });
    expect(pending.mfaToken).toBeDefined();
    expect(pending.verification).toBeUndefined();
    await client.completeMfa('123456');
    expect(client.deviceToken).toBe(saved);

    const fresh = server(supported, {
      finish: () => ({ mfaToken: randomKey(), factors: ['totp'] }),
      mfa: () => ({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresIn: 600,
        account,
        deviceToken: issued,
      }),
    });
    const second = new AccountClient(fresh.transport);
    await second.login('dana@example.test', password);
    await second.completeMfa('123456');
    expect(second.deviceToken).toBe(issued);
  });

  it('reports the token of the last successful sign-in and leaves it alone after a failed attempt', async () => {
    const issued = randomKey();
    const session = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresIn: 600,
      account,
    };
    let reply: Reply = () => ({ ...session, deviceToken: issued });
    const fake = server(supported, { finish: (body) => reply(body) });
    const client = new AccountClient(fake.transport);
    await client.login('dana@example.test', password);
    expect(client.deviceToken).toBe(issued);
    // A recognised device is issued nothing and presented nothing: no token to keep.
    reply = () => session;
    await client.login('dana@example.test', password);
    expect(client.deviceToken).toBeUndefined();
    reply = () => ({ ...session, deviceToken: issued });
    await client.login('dana@example.test', password);
    // A refused attempt must not erase what an application is about to persist.
    reply = () => {
      throw new AccountApiError(
        503,
        'Email could not be delivered.',
        'email_delivery_failed',
      );
    };
    await expect(client.login('dana@example.test', password)).rejects.toMatchObject({
      status: 503,
      code: 'email_delivery_failed',
    });
    expect(client.deviceToken).toBe(issued);
  });

  it('keeps a newly issued device token even when unlocking the vault fails afterwards', async () => {
    const issued = randomKey();
    const challenge = verification();
    const fake = server(supported, {
      finish: () => ({ verification: challenge }),
      verify: () => ({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresIn: 600,
        account,
        deviceToken: issued,
      }),
    });
    let failMe = false;
    const client = new AccountClient(async (path, body, token, method) => {
      if (path === '/me' && failMe) throw new TypeError('network unavailable');
      return fake.transport(path, body, token, method);
    });
    await client.login('dana@example.test', password);
    failMe = true;
    // The server shows the token once; losing it would cost the person another email.
    await expect(client.completeDeviceVerification('12345678')).rejects.toThrow(
      'network',
    );
    expect(client.deviceToken).toBe(issued);
    expect(client.unlocked).toBeUndefined();
  });

  it('looks at the capabilities again after a 426 and retries once with support declared', async () => {
    const features: Record<string, boolean | string> = { passwordAccounts: true };
    const issued = randomKey();
    const fake = server(features, {
      finish: (body) => {
        if (body.clientFeatures)
          return {
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            expiresIn: 600,
            account,
            deviceToken: issued,
          };
        // The operator switched the feature on after this client read the capabilities.
        features.newDeviceEmailVerification = true;
        throw new AccountApiError(
          426,
          'Update Ultra Tasks to sign in on a new device.',
          'client_update_required',
        );
      },
    });
    const client = new AccountClient(fake.transport);
    await client.login('dana@example.test', password);
    expect(client.unlocked).toBeDefined();
    expect(client.deviceToken).toBe(issued);
    expect(fake.calledWith('/capabilities')).toHaveLength(2);
    expect(fake.calledWith('/login/finish')).toHaveLength(2);
    expect(fake.calledWith('/login/finish')[1].body).toMatchObject({
      clientFeatures: ['deviceEmail'],
    });

    // A server that really cannot offer the step stays a clear refusal, tried only once more.
    const stuck = server(
      { passwordAccounts: true },
      {
        finish: () => {
          throw new AccountApiError(
            426,
            'Update Ultra Tasks to sign in on a new device.',
            'client_update_required',
          );
        },
      },
    );
    await expect(
      new AccountClient(stuck.transport).login('dana@example.test', password),
    ).rejects.toMatchObject({ status: 426, code: 'client_update_required' });
    expect(stuck.calledWith('/login/finish')).toHaveLength(1);
  });

  it('ends the pending code step when the server has dropped the challenge, but not on a cooldown refusal', async () => {
    const challenge = verification();
    const failures = [
      new AccountApiError(
        429,
        'Wait a moment before requesting another code.',
        'resend_too_soon',
      ),
      new AccountApiError(503, 'Email could not be delivered.', 'email_delivery_failed'),
    ];
    const fake = server(supported, {
      finish: () => ({ verification: challenge }),
      resend: () => {
        throw failures.shift()!;
      },
    });
    const client = new AccountClient(fake.transport);
    await client.login('dana@example.test', password);
    await expect(client.resendDeviceVerification()).rejects.toMatchObject({
      status: 429,
    });
    expect(client.pendingDeviceVerification).toEqual(challenge);
    await expect(client.resendDeviceVerification()).rejects.toMatchObject({
      status: 503,
    });
    expect(client.pendingDeviceVerification).toBeUndefined();
    await expect(client.completeDeviceVerification('12345678')).rejects.toThrow(
      'Sign in first',
    );
  });

  it('refreshes capabilities that are older than ten minutes before deciding which keys to send', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-18T10:00:00Z'));
    const features: Record<string, boolean | string> = { passwordAccounts: true };
    const fake = server(features);
    const client = new AccountClient(fake.transport);
    await client.init();
    features.newDeviceEmailVerification = true;
    await client.login('dana@example.test', password);
    expect(fake.calledWith('/login/finish')[0].body).not.toHaveProperty('clientFeatures');
    vi.setSystemTime(new Date('2026-11-18T10:11:00Z'));
    await client.login('dana@example.test', password);
    expect(fake.calledWith('/login/finish')[1].body).toMatchObject({
      clientFeatures: ['deviceEmail'],
    });
    expect(fake.calledWith('/capabilities')).toHaveLength(2);
  });

  it('exposes settings, trusted devices and revocation through authenticated requests', async () => {
    const device = {
      id: crypto.randomUUID(),
      label: 'Laptop',
      createdAt: 1,
      lastSeenAt: 2,
      current: true,
      sessions: 1,
    };
    const fake = server(supported);
    const respond = fake.transport;
    const client = new AccountClient(async (path, body, token, method) => {
      if (path === '/devices') {
        fake.calls.push({ path, body: body as never, accessToken: token, method });
        return [device];
      }
      if (path === '/security/new-device-email') {
        fake.calls.push({ path, body: body as never, accessToken: token, method });
        return { newDeviceEmailVerification: (body as { enabled: boolean }).enabled };
      }
      return respond(path, body, token, method);
    });
    await client.login('dana@example.test', password);
    expect(await client.getSecuritySettings()).toEqual({
      newDeviceEmailVerification: true,
      available: true,
    });
    expect(await client.devices()).toEqual([device]);
    await client.revokeDevice(device.id);
    expect(fake.calledWith('/devices/revoke')[0]).toMatchObject({
      body: { deviceId: device.id },
      accessToken: 'access-token',
    });
    // No code unless one is given: the body stays exactly what servers before the change accept.
    expect(fake.calledWith('/devices/revoke')[0].body).toEqual({ deviceId: device.id });
    // Removing another device while a second factor is enrolled needs its code.
    await client.revokeDevice(device.id, ' 123456 ');
    expect(fake.calledWith('/devices/revoke')[1].body).toEqual({
      deviceId: device.id,
      code: '123456',
    });
    await client.revokeDevice(device.id, '   ');
    expect(fake.calledWith('/devices/revoke')[2].body).toEqual({ deviceId: device.id });
    expect(await client.setNewDeviceEmailVerification(false, ' 123456 ')).toEqual({
      newDeviceEmailVerification: false,
    });
    expect(fake.calledWith('/security/new-device-email')[0].body).toEqual({
      enabled: false,
      code: '123456',
    });
    await client.setNewDeviceEmailVerification(true);
    expect(fake.calledWith('/security/new-device-email')[1].body).toEqual({
      enabled: true,
    });
  });

  it('registers with only an email address and password', async () => {
    const fake = server(supported);
    const client = new AccountClient(async (path, body, token, method) => {
      if (path === '/register/start') {
        fake.calls.push({ path, body: body as never });
        throw new Error('stop after the first request');
      }
      return fake.transport(path, body, token, method);
    });
    await expect(
      client.prepareRegistration({ email: 'new@example.test' }, password),
    ).rejects.toThrow('stop after the first request');
    const sent = fake.calledWith('/register/start')[0].body!;
    expect(Object.keys(sent).sort()).toEqual(['email', 'registrationRequest']);
  });

  it('sends the device keys with a browser sign-in redemption only when advertised', async () => {
    for (const advertised of [false, true]) {
      const fake = server(
        advertised
          ? { ...supported, browserLogin: true }
          : { passwordAccounts: true, browserLogin: true },
      );
      const client = new AccountClient(async (path, body, token, method) => {
        if (path === '/browser-login/start')
          return {
            ...(body as object),
            ticket: randomKey(),
            expiresAt: Date.now() + 300000,
          };
        if (path === '/browser-login/poll') {
          fake.calls.push({ path, body: body as never });
          return { pending: true };
        }
        return fake.transport(path, body, token, method);
      });
      const saved = randomKey();
      await client.startBrowserLogin(
        'https://accounts.example.test',
        'urn:ultra-tasks:web',
        'Phone',
      );
      expect(await client.pollBrowserLogin({ deviceToken: saved })).toBe(false);
      const sent = fake.calledWith('/browser-login/poll')[0].body!;
      if (advertised)
        expect(sent).toMatchObject({
          clientFeatures: ['deviceEmail'],
          deviceToken: saved,
        });
      else expect(sent).not.toHaveProperty('clientFeatures');
    }
  });

  it('carries the machine-readable reason of a refused request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: 'Update Ultra Tasks to sign in on a new device.',
              code: 'client_update_required',
            }),
            { status: 426 },
          ),
      ),
    );
    const error = await httpTransport('https://sync.example.test')(
      '/login/finish',
      {},
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AccountApiError);
    expect(error).toMatchObject({
      status: 426,
      code: 'client_update_required',
      message: 'Update Ultra Tasks to sign in on a new device.',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Nope' }), { status: 401 })),
    );
    const plain = await httpTransport('https://sync.example.test')('/me').catch(
      (reason: unknown) => reason,
    );
    expect(plain).toMatchObject({ status: 401, message: 'Nope' });
    expect((plain as AccountApiError).code).toBeUndefined();
  });
});
