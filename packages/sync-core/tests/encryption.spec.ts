import { describe, expect, it } from 'vitest';
import {
  WebCryptoNotAvailableError,
  decrypt,
  encrypt,
  isCryptoSubtleAvailable,
  setArgon2ParamsForTesting,
} from '../src';

describe('encryption primitives', () => {
  it('exposes Web Crypto availability check', () => {
    expect(typeof isCryptoSubtleAvailable()).toBe('boolean');
  });

  it('round-trips a string through encrypt/decrypt with the same password', async () => {
    if (!isCryptoSubtleAvailable()) {
      return;
    }

    setArgon2ParamsForTesting({ parallelism: 1, memorySize: 8, iterations: 1 });
    try {
      const plaintext = 'hello sync world';
      const ciphertext = await encrypt(plaintext, 'correct horse battery staple');
      expect(ciphertext).not.toBe(plaintext);
      await expect(decrypt(ciphertext, 'correct horse battery staple')).resolves.toBe(
        plaintext,
      );
    } finally {
      setArgon2ParamsForTesting();
    }
  });

  it('exports WebCryptoNotAvailableError', () => {
    expect(new WebCryptoNotAvailableError()).toBeInstanceOf(Error);
  });
});
