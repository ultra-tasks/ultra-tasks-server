import { z } from 'zod';
import { UltraPublicKeySchema, UltraSignedRecordSchema } from './ultra-account-contract';

const id = z.string().uuid();
const signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
export const UltraKeyGrantSchema = z
  .object({
    v: z.literal(1),
    enc: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
    data: z.string().regex(/^[A-Za-z0-9_-]{64}$/),
  })
  .strict();
export const UltraMembershipSchema = z
  .object({
    authorization: z
      .object({
        serverId: id,
        scopeId: id,
        ownerId: id,
        accountId: id,
        role: z.enum(['owner', 'editor', 'viewer']),
        epoch: z.number().int().positive(),
        inviteId: id,
        encryptionPublicKey: UltraPublicKeySchema,
        signingPublicKey: UltraPublicKeySchema,
        grant: UltraKeyGrantSchema,
      })
      .strict(),
    signature,
  })
  .strict();
export const UltraDeviceCertificateSchema = z
  .object({
    serverId: id,
    accountId: id,
    deviceId: id,
    publicKey: UltraPublicKeySchema,
    signature,
  })
  .strict();
export const UltraSyncWriteSchema = z
  .object({
    record: UltraSignedRecordSchema,
    deleted: z.boolean(),
    restore: z.boolean().optional(),
  })
  .strict();
export const UltraMutationSchema = z
  .object({
    v: z.literal(2),
    serverId: id,
    scopeId: id,
    epoch: z.number().int().positive(),
    generation: z.number().int().positive(),
    controlVersion: z.number().int().positive(),
    deviceId: id,
    counter: z.number().int().positive().max(2147483647),
    mutationId: id,
    certificate: UltraDeviceCertificateSchema,
    membership: UltraMembershipSchema,
    writes: z.array(UltraSyncWriteSchema).min(1).max(100),
    signature,
  })
  .strict();
