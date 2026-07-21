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
// All three endpoints are ADMIN-ONLY: a restore rolls back the WHOLE instance
// (every user's tasks/resources), which is not a member-level power.

import type { Hono } from 'hono'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { actorOf } from '@/auth/actor'
import { extractMigrationsTo, IS_EMBEDDED } from '@/embed'
import {
  clearPendingRestore,
  listFailedRestores,
  readPendingRestore,
  stagePendingRestore,
} from '@/services/pendingRestore'
import { validateBackupForStage } from '@/services/restore'
import { Paths } from '@/util/paths'
import type { AppDeps } from '@/server'

export function mountRestoreRoutes(app: Hono, _deps: AppDeps): void {
  app.get('/api/restore/pending', (c) => {
    if (actorOf(c).user.role !== 'admin') return c.json({ error: 'admin only' }, 403)
    return c.json({ pending: readPendingRestore(), failed: listFailedRestores() })
  })

  app.delete('/api/restore/pending', (c) => {
    if (actorOf(c).user.role !== 'admin') return c.json({ error: 'admin only' }, 403)
    const cleared = clearPendingRestore()
    return c.json({ cleared })
  })

  app.post('/api/restore', async (c) => {
    if (actorOf(c).user.role !== 'admin') return c.json({ error: 'admin only' }, 403)
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

    // Impl-gate P2-16: a unique per-request path (the old fixed upload.tar.gz +
    // rm of the whole dir made concurrent uploads clobber/delete each other).
    const uploadDir = join(Paths.root, '.restore-upload')
    mkdirSync(uploadDir, { recursive: true })
    const tmpTar = join(uploadDir, `upload-${ulid()}.tar.gz`)
    try {
      writeFileSync(tmpTar, Buffer.from(await file.arrayBuffer()))

      let migrationsFolder = Paths.migrationsDir
      if (IS_EMBEDDED) {
        migrationsFolder = join(Paths.root, 'runtime', 'migrations')
        await extractMigrationsTo(migrationsFolder)
      }

      // Impl-gate P1-1: full stage-depth validation (db.sqlite present +
      // quick_check + downgrade gate) — NOT just the manifest read. Staging an
      // arbitrary/corrupt tarball used to arm a deterministic boot-fail loop.
      const plan = await validateBackupForStage(tmpTar, { migrationsFolder })

      // Stage for the next boot; the swap runs while the DB is closed.
      stagePendingRestore(tmpTar, { now: Date.now() })
      return c.json({
        status: 'staged',
        direction: plan.direction,
        message: 'restart the daemon to apply the restore (agent-workflow stop && start)',
      })
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
    } finally {
      rmSync(tmpTar, { force: true })
    }
  })
}
