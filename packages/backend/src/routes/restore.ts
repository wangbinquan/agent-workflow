// /api/restore — RFC-213 PR-1b UI path.
//
// Upload a backup tarball; validate it to the SAME depth the boot apply will
// enforce (impl-gate P1-1); STAGE it (never hot-swap the live DB). The daemon
// applies it on the next boot (before openDb), so the user must restart to
// complete the restore. This mirrors the CLI `restore --stage`.
//
// Impl-gate P1-5 (2026-07-22): the armed state is visible and cancelable —
// GET  /api/restore/pending  → { pending, failed[] }
// DELETE /api/restore/pending → dis-arm
// All three endpoints require `backup:run`: a restore rolls back the WHOLE
// instance (every user's tasks/resources), which is not a member-level power.

import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type {
  DirectAuthorityBinding,
  DirectCommandContextFactory,
  DirectQueryContextFactory,
} from '@/modules/identity-access/public/participants'
import type { SystemOperationDescriptors } from '@/modules/system-operations/public/operations'
import type { RestoreArtifactRef } from '@/modules/system-operations/public/types'
import { directRequestAuthority } from '@/routes/operationAuthority'
import { registerOperationRoute } from '@/routes/operationRoute'

interface RestoreRouteSystemOperations {
  readonly operations: Pick<
    SystemOperationDescriptors,
    'getRecoveryStatus' | 'cancelStagedRestore' | 'stageRestore'
  >
  readonly artifacts: {
    ingestHttpUpload(upload: { arrayBuffer(): Promise<ArrayBuffer> }): Promise<RestoreArtifactRef>
  }
}

interface SystemOperationContextFactory {
  readonly contexts: DirectCommandContextFactory & DirectQueryContextFactory
  readonly directAuthority: DirectAuthorityBinding
}

export function mountRestoreRoutes(
  app: Hono,
  systemOperations: RestoreRouteSystemOperations,
  identityAccess: SystemOperationContextFactory,
): void {
  registerOperationRoute(app, {
    descriptor: systemOperations.operations.getRecoveryStatus,
    method: 'GET',
    path: '/api/restore/pending',
    tokenAccess: 'allow',
    decode: () => ({}),
    context: (c) => queryContext(identityAccess, actorOf(c)),
    encode: (c, output) => c.json(output),
  })

  registerOperationRoute(app, {
    descriptor: systemOperations.operations.cancelStagedRestore,
    method: 'DELETE',
    path: '/api/restore/pending',
    tokenAccess: 'allow',
    decode: () => ({}),
    context: (c) => commandContext(identityAccess, actorOf(c)),
    encode: (c, output) => c.json(output),
  })

  registerOperationRoute(app, {
    descriptor: systemOperations.operations.stageRestore,
    method: 'POST',
    path: '/api/restore',
    tokenAccess: 'allow',
    decode: async (c) => {
      let form: Awaited<ReturnType<Request['formData']>>
      try {
        form = await c.req.raw.formData()
      } catch (err) {
        throw new Error(
          `failed to parse multipart body: ${err instanceof Error ? err.message : err}`,
        )
      }
      const file = form.get('file')
      if (file === null || typeof file === 'string') {
        throw new Error("multipart field 'file' (a backup .tar.gz) is required")
      }
      return {
        artifactRef: await systemOperations.artifacts.ingestHttpUpload(file),
        noSafetyBackup: false,
        noMigrate: false,
        skipIntegrityCheck: false,
      }
    },
    context: (c) => commandContext(identityAccess, actorOf(c)),
    encode: (c, output) =>
      c.json({
        status: 'staged' as const,
        direction: output.direction,
        message: 'restart the daemon to apply the restore (agent-workflow stop && start)',
      }),
    mapError: (error, c) =>
      c.json({ error: error instanceof Error ? error.message : String(error) }, 400),
  })
}

function commandContext(factory: SystemOperationContextFactory, actor: Actor) {
  return factory.contexts.fromAuthority(
    directRequestAuthority(factory.directAuthority, actor),
    'http',
  )
}

function queryContext(factory: SystemOperationContextFactory, actor: Actor) {
  return factory.contexts.queryFromAuthority(
    directRequestAuthority(factory.directAuthority, actor),
    'http',
  )
}
