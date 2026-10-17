// POST /api/backup — produce a tarball under ~/.agent-workflow/backups/.
// The Settings page "Export backup" button calls this.

import type { Hono } from 'hono'
import { actorOf } from '@/auth/actor'
import type {
  DirectAuthorityBinding,
  DirectCommandContextFactory,
  DirectQueryContextFactory,
} from '@/modules/identity-access/public/participants'
import type { SystemOperationDescriptors } from '@/modules/system-operations/public/operations'
import { registerOperationRoute } from '@/routes/operationRoute'
import { directRequestAuthority } from '@/routes/operationAuthority'
import { safeJsonOrThrowInvalid } from '@/util/http'
import { ValidationError } from '@/util/errors'
import { z } from 'zod'

interface BackupRouteSystemOperations {
  readonly operations: Pick<
    SystemOperationDescriptors,
    'requestBackup' | 'hostedBackupCatalog' | 'verifyHostedBackup'
  >
}

interface BackupRouteIdentityAccess {
  readonly contexts: DirectCommandContextFactory & DirectQueryContextFactory
  readonly directAuthority: DirectAuthorityBinding
}

export function mountBackupRoutes(
  app: Hono,
  systemOperations: BackupRouteSystemOperations,
  identityAccess: BackupRouteIdentityAccess,
): void {
  // Standalone keeps its original contract: the body is not read and an
  // HTTP-requested backup never captures worktrees (only the scheduled one
  // does). A hosted deployment — the one whose backups have a catalog — decodes
  // the request, so an explicit worktree request reaches its refusal (RFC-370
  // v3 V5, C10).
  const hosted = systemOperations.operations.hostedBackupCatalog !== undefined
  registerOperationRoute(app, {
    descriptor: systemOperations.operations.requestBackup,
    method: 'POST',
    path: '/api/backup',
    executionGroup: 'maintenance',
    tokenAccess: 'allow',
    decode: hosted
      ? async (c) => {
          const parsed = z
            .object({ includeWorktrees: z.boolean().default(false) })
            .strict()
            .safeParse(c.req.raw.body === null ? {} : await safeJsonOrThrowInvalid(c.req.raw))
          if (!parsed.success)
            throw new ValidationError('backup-invalid', 'invalid backup payload', {
              issues: parsed.error.issues,
            })
          return parsed.data
        }
      : () => ({ includeWorktrees: false }),
    context: (c) =>
      identityAccess.contexts.fromAuthority(
        directRequestAuthority(identityAccess.directAuthority, actorOf(c)),
        'http',
      ),
    encode: (c, output) => c.json(output),
  })
  if (systemOperations.operations.hostedBackupCatalog)
    registerOperationRoute(app, {
      descriptor: systemOperations.operations.hostedBackupCatalog,
      method: 'GET',
      path: '/api/backup',
      tokenAccess: 'allow',
      decode: () => ({}),
      context: (c) =>
        identityAccess.contexts.queryFromAuthority(
          directRequestAuthority(identityAccess.directAuthority, actorOf(c)),
          'http',
        ),
      encode: (c, output) => c.json(output),
    })
  if (systemOperations.operations.verifyHostedBackup)
    registerOperationRoute(app, {
      descriptor: systemOperations.operations.verifyHostedBackup,
      method: 'POST',
      path: '/api/backup/:backupId/verify',
      tokenAccess: 'allow',
      decode: (c) => ({ backupId: c.req.param('backupId') }),
      context: (c) =>
        identityAccess.contexts.queryFromAuthority(
          directRequestAuthority(identityAccess.directAuthority, actorOf(c)),
          'http',
        ),
      encode: (c, output) => c.json(output),
    })
}
