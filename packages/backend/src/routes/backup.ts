// POST /api/backup — produce a tarball under ~/.agent-workflow/backups/.
// The Settings page "Export backup" button calls this.

import type { Hono } from 'hono'
import { actorOf } from '@/auth/actor'
import type {
  DirectAuthorityBinding,
  DirectCommandContextFactory,
} from '@/modules/identity-access/public/participants'
import type { SystemOperationDescriptors } from '@/modules/system-operations/public/operations'
import { registerOperationRoute } from '@/routes/operationRoute'
import { directRequestAuthority } from '@/routes/operationAuthority'

interface BackupRouteSystemOperations {
  readonly operations: Pick<SystemOperationDescriptors, 'requestBackup'>
}

interface BackupRouteIdentityAccess {
  readonly contexts: DirectCommandContextFactory
  readonly directAuthority: DirectAuthorityBinding
}

export function mountBackupRoutes(
  app: Hono,
  systemOperations: BackupRouteSystemOperations,
  identityAccess: BackupRouteIdentityAccess,
): void {
  registerOperationRoute(app, {
    descriptor: systemOperations.operations.requestBackup,
    method: 'POST',
    path: '/api/backup',
    tokenAccess: 'allow',
    decode: () => ({ includeWorktrees: false }),
    context: (c) =>
      identityAccess.contexts.fromAuthority(
        directRequestAuthority(identityAccess.directAuthority, actorOf(c)),
        'http',
      ),
    encode: (c, output) => c.json(output),
  })
}
