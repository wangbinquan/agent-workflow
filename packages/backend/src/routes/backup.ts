// POST /api/backup — produce a tarball under ~/.agent-workflow/backups/.
// The Settings page "Export backup" button calls this.

import type { Hono } from 'hono'
import { createBackup } from '@/services/backup'
import { ensureCredentialsSealed } from '@/services/repoCredentials'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'

export function mountBackupRoutes(app: Hono, deps: AppDeps): void {
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/backup',
      permissions: ['backup:run'],
      tokenAccess: 'allow',
      summary: 'Run a backup',
    },
    async (c) => {
      // RFC-204: seal before the snapshot — same reason as the backup CLI, this
      // route can be the first thing that runs after an upgrade.
      ensureCredentialsSealed(deps.db, deps.secretBox, { blockOnCredentialedPath: true })
      const r = await createBackup({ db: deps.db })
      return c.json({
        path: r.path,
        sizeBytes: r.sizeBytes,
        contents: r.contents,
      })
    },
  )
}
