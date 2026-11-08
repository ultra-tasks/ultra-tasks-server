import { canonical, decode, encode, fingerprint, randomKey, utf8 } from './encoding';
import { grantKey, receiveKey, type KeyGrant } from './sharing';
import { sign, verify } from './vault';
import type { AccountClient } from './account-client';

export const BROWSER_LOGIN_RETURNS = [
  'ultratasks://account-login',
  'app.ultratasks://account-login',
  'urn:ultra-tasks:web',
] as const;
export type BrowserLoginReturn = (typeof BROWSER_LOGIN_RETURNS)[number];
export interface BrowserLoginRequest {
  v: 1;
  ticket: string;
  serverId: string;
  serverUrl: string;
  state: string;
  proofHash: string;
  publicKey: JsonWebKey;
  redirectUri: BrowserLoginReturn;
  deviceName: string;
  identifier?: string;
  expiresAt: number;
}
export interface PendingBrowserLogin {
  request: BrowserLoginRequest;
  verifier: string;
  privateKey: JsonWebKey;
}
export interface BrowserLoginApproval {
  accountId: string;
  vaultVersion: number;
  bundleHash: string;
  grant: KeyGrant;
  signature: string;
}
export const browserLoginProof = async (verifier: string): Promise<string> => {
  if (decode(verifier).length !== 32) throw new Error('Invalid sign-in proof');
  return encode(await crypto.subtle.digest('SHA-256', utf8(verifier)));
};
export const browserLoginGrantContext = (
  request: BrowserLoginRequest,
  approval: Pick<BrowserLoginApproval, 'accountId' | 'vaultVersion' | 'bundleHash'>,
) => ({
  serverId: request.serverId,
  scopeId: canonical({
    purpose: 'browser-login-v1',
    request,
    vaultVersion: approval.vaultVersion,
    bundleHash: approval.bundleHash,
  }),
  recipientId: approval.accountId,
  epoch: 1,
});
export const browserLoginSignedData = (
  request: BrowserLoginRequest,
  approval: Omit<BrowserLoginApproval, 'signature'>,
) => ({ action: 'browser-login-v1', request, ...approval });
export const browserLoginReturnUrl = (
  request: BrowserLoginRequest,
): string | undefined =>
  request.redirectUri === 'urn:ultra-tasks:web'
    ? undefined
    : request.redirectUri + '?result=' + request.ticket + '&state=' + request.state;
export const browserLoginUrl = async (request: BrowserLoginRequest): Promise<string> =>
  request.serverUrl +
  '/account?login=' +
  request.ticket +
  '#binding=' +
  (await fingerprint(request));
export const newBrowserLogin = async (input: {
  serverId: string;
  serverUrl: string;
  redirectUri: BrowserLoginReturn;
  deviceName: string;
  identifier?: string;
}) => {
  if (!BROWSER_LOGIN_RETURNS.includes(input.redirectUri))
    throw new Error('Unsupported app return');
  const key = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const exported = await crypto.subtle.exportKey('jwk', key.publicKey);
  const privateKey = await crypto.subtle.exportKey('jwk', key.privateKey);
  const verifier = randomKey();
  return {
    privateKey,
    verifier,
    input: {
      ...input,
      v: 1 as const,
      state: randomKey(),
      proofHash: await browserLoginProof(verifier),
      publicKey: { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y },
    },
  };
};
export const validatePendingBrowserLogin = async (
  flow: PendingBrowserLogin,
): Promise<void> => {
  const r = flow.request;
  if (
    r.v !== 1 ||
    r.expiresAt <= Date.now() ||
    r.expiresAt > Date.now() + 300000 ||
    !BROWSER_LOGIN_RETURNS.includes(r.redirectUri) ||
    [r.ticket, r.state, r.proofHash].some((v) => decode(v).length !== 32) ||
    (await browserLoginProof(flow.verifier)) !== r.proofHash ||
    !flow.privateKey.d ||
    ['kty', 'crv', 'x', 'y'].some(
      (k) =>
        flow.privateKey[k as keyof JsonWebKey] !== r.publicKey[k as keyof JsonWebKey],
    )
  )
    throw new Error('Invalid or expired app sign-in');
};
export const approveBrowserLogin = async (
  client: AccountClient,
  request: BrowserLoginRequest,
): Promise<void> => {
  if (
    !client.unlocked ||
    !client.account ||
    !client.bundle ||
    client.capabilities?.serverId !== request.serverId ||
    request.expiresAt <= Date.now()
  )
    throw new Error('Sign in on the requesting server first');
  const identity = {
    accountId: client.account.id,
    vaultVersion: client.account.vaultVersion,
    bundleHash: await fingerprint(client.bundle),
  };
  const grant = await grantKey(
    request.publicKey,
    client.unlocked.masterKey,
    browserLoginGrantContext(request, identity),
  );
  const approval = { ...identity, grant };
  await client.request('/browser-login/approve', {
    ticket: request.ticket,
    ...approval,
    signature: await sign(
      client.unlocked.secrets.signingPrivateKey,
      browserLoginSignedData(request, approval),
    ),
  });
};
export const receiveBrowserLogin = async (
  flow: PendingBrowserLogin,
  approval: BrowserLoginApproval,
  publicKey: JsonWebKey,
): Promise<string> => {
  const { signature, ...data } = approval;
  if (!(await verify(publicKey, browserLoginSignedData(flow.request, data), signature)))
    throw new Error('Invalid app sign-in signature');
  return receiveKey(
    flow.privateKey,
    approval.grant,
    browserLoginGrantContext(flow.request, approval),
  );
};
