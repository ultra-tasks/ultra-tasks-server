import { describe, expect, it } from 'vitest';
import {
  newBrowserLogin,
  browserLoginGrantContext,
  browserLoginSignedData,
  receiveBrowserLogin,
  validatePendingBrowserLogin,
} from '../src/browser-login';
import { createAccountBundle, sign, unlockBundleWithMasterKey } from '../src/vault';
import { fingerprint, randomKey } from '../src/encoding';
import { grantKey } from '../src/sharing';

describe('recipient-bound browser vault grant', () => {
  const fixture = async () => {
    const serverId = crypto.randomUUID(),
      accountId = crypto.randomUUID();
    const vault = await createAccountBundle('a password that stays on the browser', {
      serverId,
      accountId,
    });
    const created = await newBrowserLogin({
      serverId,
      serverUrl: 'https://own-server.example.test',
      redirectUri: 'app.ultratasks://account-login',
      deviceName: 'My iPhone',
    });
    const flow = {
      request: { ...created.input, ticket: randomKey(), expiresAt: Date.now() + 300000 },
      privateKey: created.privateKey,
      verifier: created.verifier,
    };
    const identity = {
      accountId,
      vaultVersion: 1,
      bundleHash: await fingerprint(vault.bundle),
    };
    const grant = await grantKey(
      flow.request.publicKey,
      vault.masterKey,
      browserLoginGrantContext(flow.request, identity),
    );
    const data = { ...identity, grant };
    const approval = {
      ...data,
      signature: await sign(
        vault.secrets.signingPrivateKey,
        browserLoginSignedData(flow.request, data),
      ),
    };
    return { flow, vault, approval };
  };
  it('opens the original vault without a password and authenticates its identity', async () => {
    const { flow, vault, approval } = await fixture();
    const master = await receiveBrowserLogin(
      flow,
      approval,
      vault.bundle.signingPublicKey,
    );
    expect(master).toBe(vault.masterKey);
    expect(
      (
        await unlockBundleWithMasterKey(
          vault.bundle,
          { serverId: flow.request.serverId, accountId: approval.accountId },
          master,
        )
      ).secrets,
    ).toEqual(vault.secrets);
    await expect(
      unlockBundleWithMasterKey(
        vault.bundle,
        { serverId: crypto.randomUUID(), accountId: approval.accountId },
        master,
      ),
    ).rejects.toThrow();
  });
  it('rejects changed request, account, bundle, expiry and signature', async () => {
    const { flow, vault, approval } = await fixture();
    for (const request of [
      { ...flow.request, state: randomKey() },
      { ...flow.request, serverId: crypto.randomUUID() },
      { ...flow.request, serverUrl: 'https://another-server.example.test' },
      { ...flow.request, expiresAt: flow.request.expiresAt + 1 },
      { ...flow.request, redirectUri: 'ultratasks://account-login' as const },
    ])
      await expect(
        receiveBrowserLogin(
          { ...flow, request },
          approval,
          vault.bundle.signingPublicKey,
        ),
      ).rejects.toThrow();
    for (const changed of [
      { ...approval, accountId: crypto.randomUUID() },
      { ...approval, bundleHash: randomKey() },
      { ...approval, signature: randomKey() },
    ])
      await expect(
        receiveBrowserLogin(flow, changed, vault.bundle.signingPublicKey),
      ).rejects.toThrow();
  });
  it('cannot decrypt even a correctly signed grant with another device private key', async () => {
    const { flow, vault, approval } = await fixture();
    const other = await newBrowserLogin({
      serverId: flow.request.serverId,
      serverUrl: flow.request.serverUrl,
      redirectUri: flow.request.redirectUri,
      deviceName: 'Another device',
    });
    await expect(
      receiveBrowserLogin(
        { ...flow, privateKey: other.privateKey },
        approval,
        vault.bundle.signingPublicKey,
      ),
    ).rejects.toThrow();
    await expect(
      validatePendingBrowserLogin({ ...flow, privateKey: other.privateKey }),
    ).rejects.toThrow();
    await expect(
      validatePendingBrowserLogin({ ...flow, verifier: randomKey() }),
    ).rejects.toThrow();
  });
});
