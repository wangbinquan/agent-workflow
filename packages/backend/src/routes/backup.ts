// POST /api/backup — produce a tarball under ~/.agent-workflow/backups/.
// The Settings page "Export backup" button calls this.

import type { Hono } from 'hono'
import { createBackup } from '@/services/backup'
import { ensureCredentialsSealed } from '@/services/repoCredentials'
import type { AppDeps } from '@/server'

export function mountBackupRoutes(app: Hono, deps: AppDeps): void {
  app.post('/api/backup', async (c) => {
    // RFC-204: seal before the snapshot — same reason as the backup CLI, this
    // route can be the first thing that runs after an upgrade.
    ensureCredentialsSealed(deps.db, deps.secretBox, { blockOnCredentialedPath: true })
    const r = await createBackup({ db: deps.db })
    return c.json({
      path: r.path,
      sizeBytes: r.sizeBytes,
      contents: r.contents,
    })
  })
}
