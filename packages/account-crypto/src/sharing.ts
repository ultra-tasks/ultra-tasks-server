import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import { canonical, decode, encode, utf8 } from './encoding';
import { Envelope, open, seal, sign, verify } from './vault';

const suite = (): CipherSuite =>
  new CipherSuite({
    kem: new DhkemP256HkdfSha256(),
    kdf: new HkdfSha256(),
    aead: new Aes256Gcm(),
  });
export interface KeyGrant {
  v: 1;
  enc: string;
  data: string;
}
export interface GrantContext {
  serverId: string;
  scopeId: string;
  recipientId: string;
  epoch: number;
}
export const grantKey = async (
  publicKey: JsonWebKey,
  contentKey: string,
  identity: GrantContext,
): Promise<KeyGrant> => {
  if (decode(contentKey).length !== 32 || publicKey.d) throw new Error('Invalid grant');
  const key = await crypto.subtle.importKey(
    'jwk',
    publicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
  const sender = await suite().createSenderContext({
    recipientPublicKey: key,
    info: utf8(canonical(identity)),
  });
  return {
    v: 1,
    enc: encode(sender.enc),
    data: encode(await sender.seal(decode(contentKey), utf8(canonical(identity)))),
  };
};
export const receiveKey = async (
  privateKey: JsonWebKey,
  grant: KeyGrant,
  identity: GrantContext,
): Promise<string> => {
  if (grant.v !== 1) throw new Error('Unsupported grant');
  const key = await crypto.subtle.importKey(
    'jwk',
    privateKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const receiver = await suite().createRecipientContext({
    recipientKey: key,
    enc: decode(grant.enc),
    info: utf8(canonical(identity)),
  });
  const contentKey = encode(
    await receiver.open(decode(grant.data), utf8(canonical(identity))),
  );
  if (decode(contentKey).length !== 32) throw new Error('Invalid content key');
  return contentKey;
};
export interface RecordHeader {
  v: 2;
  serverId: string;
  scopeId: string;
  entityId: string;
  entityType: string;
  actorId: string;
  deviceId: string;
  mutationId: string;
  epoch: number;
  generation: number;
  controlVersion: number;
  counter: number;
  baseRevision: number;
  revision: number;
}
export interface SignedRecord {
  header: RecordHeader;
  payload: Envelope;
  signature: string;
}
export const encryptRecord = async (
  header: RecordHeader,
  value: unknown,
  contentKey: string,
  signingKey: JsonWebKey,
): Promise<SignedRecord> => {
  if (header.v !== 2 || header.revision !== header.baseRevision + 1 || header.epoch < 1)
    throw new Error('Invalid record header');
  const payload = await seal(contentKey, JSON.stringify(value), canonical(header));
  return { header, payload, signature: await sign(signingKey, { header, payload }) };
};
export const decryptRecord = async (
  record: SignedRecord,
  expected: RecordHeader,
  contentKey: string,
  signingKey: JsonWebKey,
): Promise<unknown> => {
  if (
    canonical(record.header) !== canonical(expected) ||
    !(await verify(
      signingKey,
      { header: record.header, payload: record.payload },
      record.signature,
    ))
  )
    throw new Error('Record authentication failed');
  return JSON.parse(await open(contentKey, record.payload, canonical(expected)));
};
