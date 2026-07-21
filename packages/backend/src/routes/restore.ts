// POST /api/restore — RFC-213 PR-1b UI path.
//
// Upload a backup tarball; validate its version gate; STAGE it (never hot-swap
// the live DB). The daemon applies it on the next boot (before openDb), so the
// user must restart to complete the restore. This mirrors the CLI `restore
// --stage` — safe while the daemon is running.

import type { Hono } from 'hono'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractMigrationsTo, IS_EMBEDDED } from '@/embed'
import { stagePendingRestore } from '@/services/pendingRestore'
import { planRestore } from '@/services/restore'
import { Paths } from '@/util/paths'
import type { AppDeps } from '@/server'

export function mountRestoreRoutes(app: Hono, _deps: AppDeps): void {
  app.post('/api/restore', async (c) => {
    let form: Awaited<ReturnType<Request['formData']>>
    try {
      form = await c.req.raw.formData()
    } catch (err) {
      return c.json(
        { error: `failed to parse multipart body: ${err instanceof Error ? err.message : err}` },
        400,
      )
    }
    const file = form.get('file')
    if (file === null || typeof file === 'string') {
      return c.json({ error: "multipart field 'file' (a backup .tar.gz) is required" }, 400)
    }

    const uploadDir = join(Paths.root, '.restore-upload')
    mkdirSync(uploadDir, { recursive: true })
    const tmpTar = join(uploadDir, 'upload.tar.gz')
    try {
      writeFileSync(tmpTar, Buffer.from(await file.arrayBuffer()))

      let migrationsFolder = Paths.migrationsDir
      if (IS_EMBEDDED) {
        migrationsFolder = join(Paths.root, 'runtime', 'migrations')
        await extractMigrationsTo(migrationsFolder)
      }

      const plan = await planRestore(tmpTar, { migrationsFolder })
      if (plan.direction === 'downgrade') {
        return c.json(
          { error: 'this backup is NEWER than the running binary; cannot downgrade' },
          400,
        )
      }

      // Stage for the next boot; the swap runs while the DB is closed.
      stagePendingRestore(tmpTar, { now: Date.now() })
      return c.json({
        status: 'staged',
        direction: plan.direction,
        message: 'restart the daemon to apply the restore (agent-workflow stop && start)',
      })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500)
    } finally {
      rmSync(uploadDir, { recursive: true, force: true })
    }
  })
}
