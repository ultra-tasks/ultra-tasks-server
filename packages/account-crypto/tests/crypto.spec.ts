import { describe, expect, it, vi } from 'vitest';
import {
  createAccountBundle,
  unlockBundle,
  rewrapPassword,
  randomKey,
  grantKey,
  receiveKey,
  encryptRecord,
  decryptRecord,
  RecordHeader,
  opaqueClient,
  opaqueServer,
  opaqueReady,
  canonical,
  formatRecoveryKey,
  parseRecoveryKey,
  AccountClient,
} from '../src';

const identity = { serverId: crypto.randomUUID(), accountId: crypto.randomUUID() };
const password = 'my long account password';
describe('account encryption and protocol foundation', () => {
  it('refreshes concurrent requests once and persists the rotated credential before use', async () => {
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    let refreshes = 0;
    let persisted = '';
    const client = new AccountClient(async (path, _body, accessToken) => {
      if (path === '/sessions/refresh') {
        refreshes += 1;
        await Promise.resolve();
        return { accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 600 };
      }
      expect(accessToken).toBe('new-access');
      expect(persisted).toBe('new-refresh');
      return {};
    });
    try {
      client.adoptTokens({
        accessToken: 'old-access',
        refreshToken: 'old-refresh',
        expiresIn: 600,
      });
      client.onTokensChanged = async () => {
        persisted = client.tokens!.refreshToken;
      };
      now.mockReturnValue(start + 550000);
      await Promise.all([client.request('/me'), client.request('/sessions')]);
      expect(refreshes).toBe(1);
    } finally {
      now.mockRestore();
    }
  });
  it('unlocks offline with either the password or printable recovery key; rejects wrong credentials and identities', async () => {
    const account = await createAccountBundle(password, identity);
    expect((await unlockBundle(account.bundle, identity, { password })).masterKey).toBe(
      account.masterKey,
    );
    expect(
      (await unlockBundle(account.bundle, identity, { recoveryKey: account.recoveryKey }))
        .masterKey,
    ).toBe(account.masterKey);
    await expect(
      unlockBundle(account.bundle, identity, { password: 'a different long password' }),
    ).rejects.toThrow();
    await expect(
      unlockBundle(
        account.bundle,
        { ...identity, accountId: crypto.randomUUID() },
        { recoveryKey: account.recoveryKey },
      ),
    ).rejects.toThrow();
    expect(formatRecoveryKey(parseRecoveryKey(account.recoveryKey))).toBe(
      account.recoveryKey,
    );
    const rotated = await rewrapPassword(
      account.bundle,
      account.masterKey,
      'my replacement long password',
      identity,
    );
    expect(rotated.vault).toEqual(account.bundle.vault);
    expect(
      (
        await unlockBundle(rotated, identity, {
          password: 'my replacement long password',
        })
      ).masterKey,
    ).toBe(account.masterKey);
    expect(
      (await unlockBundle(rotated, identity, { recoveryKey: account.recoveryKey }))
        .masterKey,
    ).toBe(account.masterKey);
    await expect(unlockBundle(rotated, identity, { password })).rejects.toThrow();
    await expect(
      unlockBundle(
        { ...rotated, kdf: { ...rotated.kdf, memory: 1 } } as unknown as typeof rotated,
        identity,
        { password },
      ),
    ).rejects.toThrow('Unsupported KDF');
  });
  it('shares one project across independent passwords and excludes a removed member on rotation', async () => {
    const alice = await createAccountBundle(password, identity);
    const bobIdentity = { ...identity, accountId: crypto.randomUUID() };
    const bob = await createAccountBundle('bob uses another password', bobIdentity);
    await expect(
      unlockBundle(
        { ...alice.bundle, encryptionPublicKey: bob.bundle.encryptionPublicKey },
        identity,
        { password },
      ),
    ).rejects.toThrow('public keys');
    const key = randomKey();
    const scopeId = crypto.randomUUID();
    const grantContext = {
      serverId: identity.serverId,
      scopeId,
      recipientId: bobIdentity.accountId,
      epoch: 1,
    };
    const grant = await grantKey(bob.bundle.encryptionPublicKey, key, grantContext);
    const unlocked = await unlockBundle(bob.bundle, bobIdentity, {
      password: 'bob uses another password',
    });
    expect(
      await receiveKey(unlocked.secrets.encryptionPrivateKey, grant, grantContext),
    ).toBe(key);
    await expect(
      receiveKey(alice.secrets.encryptionPrivateKey, grant, grantContext),
    ).rejects.toThrow();
    await expect(
      receiveKey(unlocked.secrets.encryptionPrivateKey, grant, {
        ...grantContext,
        epoch: 2,
      }),
    ).rejects.toThrow();
    const header: RecordHeader = {
      v: 2,
      serverId: identity.serverId,
      scopeId,
      entityId: 'task-one',
      entityType: 'task',
      actorId: identity.accountId,
      deviceId: crypto.randomUUID(),
      mutationId: crypto.randomUUID(),
      epoch: 2,
      generation: 1,
      controlVersion: 1,
      counter: 1,
      baseRevision: 0,
      revision: 1,
    };
    const rotatedKey = randomKey();
    const record = await encryptRecord(
      header,
      { title: 'private title' },
      rotatedKey,
      alice.secrets.signingPrivateKey,
    );
    expect(
      await decryptRecord(record, header, rotatedKey, alice.bundle.signingPublicKey),
    ).toEqual({ title: 'private title' });
    await expect(
      decryptRecord(record, header, key, alice.bundle.signingPublicKey),
    ).rejects.toThrow();
    await expect(
      decryptRecord(
        record,
        { ...header, scopeId: crypto.randomUUID() },
        rotatedKey,
        alice.bundle.signingPublicKey,
      ),
    ).rejects.toThrow();
    await expect(
      decryptRecord(
        { ...record, signature: 'a'.repeat(86) },
        header,
        rotatedKey,
        alice.bundle.signingPublicKey,
      ),
    ).rejects.toThrow();
  });
  it('completes a real pinned OPAQUE exchange and refuses a wrong password', async () => {
    await opaqueReady;
    const serverSetup = opaqueServer.createSetup();
    const userIdentifier = canonical(identity);
    const started = opaqueClient.startRegistration({ password });
    const response = opaqueServer.createRegistrationResponse({
      serverSetup,
      userIdentifier,
      registrationRequest: started.registrationRequest,
    });
    const registration = opaqueClient.finishRegistration({
      ...started,
      ...response,
      password,
      keyStretching: 'memory-constrained',
    });
    for (const attempt of [password, 'not the correct password']) {
      const login = opaqueClient.startLogin({ password: attempt });
      const challenge = opaqueServer.startLogin({
        serverSetup,
        userIdentifier,
        registrationRecord: registration.registrationRecord,
        startLoginRequest: login.startLoginRequest,
      });
      const result = opaqueClient.finishLogin({
        ...login,
        ...challenge,
        password: attempt,
        keyStretching: 'memory-constrained',
      });
      if (attempt === password) {
        expect(result).toBeDefined();
        expect(
          opaqueServer.finishLogin({
            serverLoginState: challenge.serverLoginState,
            finishLoginRequest: result!.finishLoginRequest,
          }).sessionKey,
        ).toBe(result!.sessionKey);
      } else expect(result).toBeUndefined();
    }
  });
});
