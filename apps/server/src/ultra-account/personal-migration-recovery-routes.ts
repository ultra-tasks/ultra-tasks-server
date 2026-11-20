import type { FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { verify } from '@ultra-tasks/account-crypto';
import { AccountError, type UltraConfig } from './security';
import { cursorMutationId, type MemberRow, type ScopeRow } from './scope-store';
import type { UltraDb } from './store';

interface Context {
  route: (
    method: 'GET' | 'POST',
    url: string,
    run: (req: FastifyRequest) => Promise<unknown>,
  ) => unknown;
  withScope: <T>(
    req: FastifyRequest,
    write: boolean,
    run: (tx: UltraDb, scope: ScopeRow, member: MemberRow) => Promise<T>,
  ) => Promise<T>;
  owner: (member: MemberRow) => void;
  config: UltraConfig;
}

const sourceCommand = z.object({
  deviceId: z.string().uuid(),
  controlVersion: z.number().int().positive(),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});

export const registerPersonalMigrationRecovery = ({
  route,
  withScope,
  owner,
  config,
}: Context): void => {
  route('POST', '/scopes/:scopeId/migration/recover', (req) => {
    const { signature, ...observed } = sourceCommand
      .extend({
        sequence: z.number().int().positive(),
        cursorMutationId: z.string().min(1).max(200),
      })
      .strict()
      .parse(req.body);
    return withScope(req, true, async (tx, scope, member) => {
      owner(member);
      if (
        scope.kind !== 'personal' ||
        !(await verify(
          scope.owner_key,
          {
            action: 'recover-personal-migration',
            serverId: config.serverId,
            scopeId: scope.id,
            ...observed,
          },
          signature,
        ))
      )
        throw new AccountError(403);
      if (scope.state === 'active') return { complete: true };
      if (
        scope.state !== 'migrating' ||
        !scope.migration_device ||
        scope.migration_device === observed.deviceId ||
        scope.control_version !== observed.controlVersion ||
        scope.sequence !== observed.sequence ||
        (await cursorMutationId(tx, scope)) !== observed.cursorMutationId
      )
        throw new AccountError(
          409,
          'Setup has changed. Reload it before recovering uploaded data.',
        );

      // Keep every signed head. The earlier setup device cannot send more migration
      // writes after this point, even if it downloads the new control version.
      await tx.$executeRaw(
        Prisma.sql`UPDATE ultra_scopes SET state='active', control_version=control_version+1, recovered_from_migration=true WHERE id=${scope.id}`,
      );
      return { complete: true };
    });
  });

  route('POST', '/scopes/:scopeId/migration/rejoin', (req) => {
    const { signature, ...observed } = sourceCommand.strict().parse(req.body);
    return withScope(req, true, async (tx, scope, member) => {
      owner(member);
      if (
        scope.kind !== 'personal' ||
        scope.state !== 'active' ||
        scope.control_version !== observed.controlVersion ||
        (scope.migration_device && scope.migration_device !== observed.deviceId) ||
        !(await verify(
          scope.owner_key,
          {
            action: 'rejoin-personal-migration',
            serverId: config.serverId,
            scopeId: scope.id,
            ...observed,
          },
          signature,
        ))
      )
        throw new AccountError(
          409,
          'The recovered workspace changed before this device connected',
        );
      await tx.$executeRaw(
        Prisma.sql`UPDATE ultra_scopes SET migration_device=NULL WHERE id=${scope.id}`,
      );
      return { complete: true };
    });
  });
};
