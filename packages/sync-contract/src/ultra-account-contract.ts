import { z } from 'zod';

const encoded = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const UltraEnvelopeSchema = z
  .object({
    v: z.literal(1),
    nonce: encoded.length(16),
    data: encoded.min(22).max(100000),
  })
  .strict();
export const UltraPublicKeySchema = z
  .object({
    kty: z.literal('EC'),
    crv: z.literal('P-256'),
    x: encoded.length(43),
    y: encoded.length(43),
    ext: z.boolean().optional(),
    key_ops: z.array(z.literal('verify')).max(1).optional(),
  })
  .strict();
export const UltraBundleSchema = z
  .object({
    v: z.literal(1),
    kdf: z
      .object({
        v: z.literal(1),
        salt: encoded.length(22),
        memory: z.literal(65536),
        iterations: z.literal(3),
        parallelism: z.literal(1),
      })
      .strict(),
    passwordWrap: UltraEnvelopeSchema,
    recoveryWrap: UltraEnvelopeSchema,
    vault: UltraEnvelopeSchema,
    encryptionPublicKey: UltraPublicKeySchema,
    signingPublicKey: UltraPublicKeySchema,
  })
  .strict();
export const UltraUsernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_]{2,31}$/)
  .refine(
    (name) =>
      ![
        'admin',
        'administrator',
        'support',
        'ultratasks',
        'ultra_tasks',
        'security',
        'system',
      ].includes(name),
  );
export const UltraIdentitySchema = z
  .object({ serverId: z.string().uuid(), accountId: z.string().uuid() })
  .strict();
export const UltraRecordHeaderSchema = z
  .object({
    v: z.literal(2),
    serverId: z.string().uuid(),
    scopeId: z.string().uuid(),
    entityId: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value)),
    entityType: z.string().min(1).max(64),
    actorId: z.string().uuid(),
    deviceId: z.string().uuid(),
    mutationId: z.string().uuid(),
    epoch: z.number().int().positive(),
    generation: z.number().int().positive(),
    controlVersion: z.number().int().positive(),
    counter: z.number().int().positive(),
    baseRevision: z.number().int().nonnegative(),
    revision: z.number().int().positive(),
  })
  .strict()
  .refine((header) => header.revision === header.baseRevision + 1);
export const UltraSignedRecordSchema = z
  .object({
    header: UltraRecordHeaderSchema,
    payload: UltraEnvelopeSchema,
    signature: encoded.length(86),
  })
  .strict();
export const UltraScopeRoleSchema = z.enum(['owner', 'editor', 'viewer']);
export const ULTRA_PROTOCOL_VERSION = 2 as const;
export const ULTRA_OPAQUE_KSF = 'memory-constrained' as const;
export const ULTRA_RECOVERY_WARNING =
  'Save this recovery key somewhere safe, such as your password manager, or print a copy. If you lose both your password and this key, and have no unlocked device, your encrypted data cannot be recovered. Ultra Tasks cannot decrypt it for you.';
