import { argon2id } from 'hash-wasm';
import { canonical, decode, encode, randomKey, utf8 } from './encoding';

export interface Envelope {
  v: 1;
  nonce: string;
  data: string;
}
export interface Kdf {
  v: 1;
  salt: string;
  memory: 65536;
  iterations: 3;
  parallelism: 1;
}
export interface VaultContext {
  serverId: string;
  accountId: string;
}
export interface VaultSecrets {
  personalKey: string;
  encryptionPrivateKey: JsonWebKey;
  signingPrivateKey: JsonWebKey;
}
export interface AccountBundle {
  v: 1;
  kdf: Kdf;
  passwordWrap: Envelope;
  recoveryWrap: Envelope;
  vault: Envelope;
  encryptionPublicKey: JsonWebKey;
  signingPublicKey: JsonWebKey;
}
export const context = (identity: VaultContext, purpose: string): string =>
  canonical({ app: 'ultra-tasks', v: 1, ...identity, purpose });
export const seal = async (
  key: string,
  plaintext: string,
  aad: string,
): Promise<Envelope> => {
  const raw = decode(key);
  if (raw.length !== 32) throw new Error('Invalid key length');
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const imported = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [
    'encrypt',
  ]);
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: utf8(aad) },
    imported,
    utf8(plaintext),
  );
  return { v: 1, nonce: encode(nonce), data: encode(data) };
};
export const open = async (
  key: string,
  envelope: Envelope,
  aad: string,
): Promise<string> => {
  if (
    envelope.v !== 1 ||
    decode(envelope.nonce).length !== 12 ||
    decode(key).length !== 32
  )
    throw new Error('Invalid envelope');
  const imported = await crypto.subtle.importKey('raw', decode(key), 'AES-GCM', false, [
    'decrypt',
  ]);
  const result = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decode(envelope.nonce), additionalData: utf8(aad) },
    imported,
    decode(envelope.data),
  );
  return new TextDecoder('utf-8', { fatal: true }).decode(result);
};
export const newKdf = (): Kdf => ({
  v: 1,
  salt: encode(crypto.getRandomValues(new Uint8Array(16))),
  memory: 65536,
  iterations: 3,
  parallelism: 1,
});
export const passwordKey = async (password: string, kdf: Kdf): Promise<string> => {
  // Fixed v1 parameters: a server cannot downgrade them or request unbounded work.
  if (
    kdf.v !== 1 ||
    kdf.memory !== 65536 ||
    kdf.iterations !== 3 ||
    kdf.parallelism !== 1 ||
    decode(kdf.salt).length !== 16
  )
    throw new Error('Unsupported KDF');
  if (password.length < 12 || password.length > 1024)
    throw new Error('Use a password of 12–1024 characters');
  return encode(
    await argon2id({
      password,
      salt: decode(kdf.salt),
      memorySize: kdf.memory,
      iterations: kdf.iterations,
      parallelism: kdf.parallelism,
      hashLength: 32,
      outputType: 'binary',
    }),
  );
};
const pair = async (
  algorithm: 'ECDH' | 'ECDSA',
): Promise<{ publicKey: JsonWebKey; privateKey: JsonWebKey }> => {
  const keys = await crypto.subtle.generateKey(
    { name: algorithm, namedCurve: 'P-256' },
    true,
    algorithm === 'ECDH' ? ['deriveBits'] : ['sign', 'verify'],
  );
  return {
    publicKey: await crypto.subtle.exportKey('jwk', keys.publicKey),
    privateKey: await crypto.subtle.exportKey('jwk', keys.privateKey),
  };
};
export const formatRecoveryKey = (key: string): string =>
  'UTRK1-' +
  (
    Array.from(decode(key))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .match(/.{1,8}/g) ?? []
  ).join('-');
export const parseRecoveryKey = (printed: string): string => {
  const compact = printed
    .trim()
    .replace(/^UTRK1-/i, '')
    .replace(/[\s-]/g, '')
    .toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(compact)) throw new Error('Invalid recovery key');
  return encode(Uint8Array.from(compact.match(/../g)!, (part) => parseInt(part, 16)));
};
export const createAccountBundle = async (
  password: string,
  identity: VaultContext,
): Promise<{
  bundle: AccountBundle;
  masterKey: string;
  secrets: VaultSecrets;
  recoveryKey: string;
}> => {
  const [encryption, signing] = await Promise.all([pair('ECDH'), pair('ECDSA')]);
  const secrets: VaultSecrets = {
    personalKey: randomKey(),
    encryptionPrivateKey: encryption.privateKey,
    signingPrivateKey: signing.privateKey,
  };
  const masterKey = randomKey();
  const recoveryKey = randomKey();
  const kdf = newKdf();
  const bundle: AccountBundle = {
    v: 1,
    kdf,
    passwordWrap: await seal(
      await passwordKey(password, kdf),
      masterKey,
      context(identity, 'password:' + canonical(kdf)),
    ),
    recoveryWrap: await seal(recoveryKey, masterKey, context(identity, 'recovery')),
    vault: await seal(masterKey, JSON.stringify(secrets), context(identity, 'vault')),
    encryptionPublicKey: encryption.publicKey,
    signingPublicKey: signing.publicKey,
  };
  return { bundle, masterKey, secrets, recoveryKey: formatRecoveryKey(recoveryKey) };
};
export const unlockBundle = async (
  bundle: AccountBundle,
  identity: VaultContext,
  credential: { password: string } | { recoveryKey: string },
): Promise<{ masterKey: string; secrets: VaultSecrets }> => {
  if (bundle.v !== 1) throw new Error('Unsupported vault version');
  const masterKey =
    'password' in credential
      ? await open(
          await passwordKey(credential.password, bundle.kdf),
          bundle.passwordWrap,
          context(identity, 'password:' + canonical(bundle.kdf)),
        )
      : await open(
          parseRecoveryKey(credential.recoveryKey),
          bundle.recoveryWrap,
          context(identity, 'recovery'),
        );
  return unlockBundleWithMasterKey(bundle, identity, masterKey);
};
/** Opens a recipient-encrypted browser grant without knowing the account password. */
export const unlockBundleWithMasterKey = async (
  bundle: AccountBundle,
  identity: VaultContext,
  masterKey: string,
): Promise<{ masterKey: string; secrets: VaultSecrets }> => {
  if (bundle.v !== 1 || decode(masterKey).length !== 32) throw new Error('Invalid vault');
  const secrets = JSON.parse(
    await open(masterKey, bundle.vault, context(identity, 'vault')),
  ) as VaultSecrets;
  if (
    decode(secrets.personalKey).length !== 32 ||
    !secrets.signingPrivateKey.d ||
    !secrets.encryptionPrivateKey.d
  )
    throw new Error('Invalid vault');
  const publicMaterial = (key: JsonWebKey): string =>
    canonical({ kty: key.kty, crv: key.crv, x: key.x, y: key.y });
  if (
    bundle.encryptionPublicKey.d ||
    bundle.signingPublicKey.d ||
    publicMaterial(secrets.encryptionPrivateKey) !==
      publicMaterial(bundle.encryptionPublicKey) ||
    publicMaterial(secrets.signingPrivateKey) !== publicMaterial(bundle.signingPublicKey)
  )
    throw new Error('Account public keys do not match the encrypted vault');
  return { masterKey, secrets };
};
export const rewrapPassword = async (
  bundle: AccountBundle,
  masterKey: string,
  password: string,
  identity: VaultContext,
): Promise<AccountBundle> => {
  const kdf = newKdf();
  return {
    ...bundle,
    kdf,
    passwordWrap: await seal(
      await passwordKey(password, kdf),
      masterKey,
      context(identity, 'password:' + canonical(kdf)),
    ),
  };
};
export const sign = async (privateKey: JsonWebKey, value: unknown): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'jwk',
    privateKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  return encode(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      utf8(canonical(value)),
    ),
  );
};
export const verify = async (
  publicKey: JsonWebKey,
  value: unknown,
  signature: string,
): Promise<boolean> => {
  try {
    if (publicKey.d) return false;
    const key = await crypto.subtle.importKey(
      'jwk',
      publicKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      decode(signature),
      utf8(canonical(value)),
    );
  } catch {
    return false;
  }
};
