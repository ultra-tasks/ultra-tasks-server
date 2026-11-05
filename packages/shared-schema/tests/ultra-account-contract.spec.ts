import { describe, expect, it } from 'vitest';
import {
  UltraEnvelopeSchema,
  UltraPublicKeySchema,
  UltraRecordHeaderSchema,
  UltraUsernameSchema,
} from '../src/ultra-account-contract';

describe('Ultra v2 account and record boundary', () => {
  it('requires authenticated scope, generation, control, author and revision metadata', () => {
    const id = '5e1115d2-35de-48ab-b4d7-43d4efb49f6e';
    const header = {
      v: 2,
      serverId: id,
      scopeId: id,
      entityId: 'task',
      entityType: 'task',
      actorId: id,
      deviceId: id,
      mutationId: id,
      epoch: 1,
      generation: 1,
      controlVersion: 1,
      counter: 1,
      baseRevision: 2,
      revision: 3,
    };
    expect(UltraRecordHeaderSchema.safeParse(header).success).toBe(true);
    for (const field of [
      'serverId',
      'scopeId',
      'actorId',
      'deviceId',
      'epoch',
      'generation',
      'controlVersion',
      'counter',
    ])
      expect(
        UltraRecordHeaderSchema.safeParse({ ...header, [field]: undefined }).success,
      ).toBe(false);
    expect(UltraRecordHeaderSchema.safeParse({ ...header, revision: 5 }).success).toBe(
      false,
    );
    expect(UltraRecordHeaderSchema.safeParse({ ...header, v: 1 }).success).toBe(false);
  });
  it('rejects plaintext/downgraded envelopes and private material in public keys', () => {
    expect(
      UltraEnvelopeSchema.safeParse({ v: 1, nonce: 'a'.repeat(16), data: 'a'.repeat(22) })
        .success,
    ).toBe(true);
    expect(
      UltraEnvelopeSchema.safeParse({ v: 0, nonce: 'a'.repeat(16), data: 'plaintext' })
        .success,
    ).toBe(false);
    const key = { kty: 'EC', crv: 'P-256', x: 'a'.repeat(43), y: 'a'.repeat(43) };
    expect(UltraPublicKeySchema.safeParse(key).success).toBe(true);
    expect(UltraPublicKeySchema.safeParse({ ...key, d: 'private' }).success).toBe(false);
  });
  it('normalizes handles and rejects reserved or ambiguous names', () => {
    expect(UltraUsernameSchema.parse(' Alice_1 ')).toBe('alice_1');
    for (const name of ['admin', 'support', 'a', 'аlice', 'alice@example.test'])
      expect(UltraUsernameSchema.safeParse(name).success).toBe(false);
  });
});
