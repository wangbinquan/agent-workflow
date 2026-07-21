// RFC-213 PR-1b — POST /api/restore stages an uploaded backup for next-boot apply
// (never hot-swaps). MUTATION CHECK (manually verified): drop the
// stagePendingRestore call → no marker written → the hasPendingRestore assertion reds.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { Hono, type MiddlewareHandler } from 'hono'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb } from '../src/db/client'
import type { AppDeps } from '../src/server'
import type { Actor } from '../src/auth/actor'
import { createBackup } from '../src/services/backup'
import { hasPendingRestore, stagePendingRestore } from '../src/services/pendingRestore'
import { mountRestoreRoutes } from '../src/routes/restore'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const savedHome = process.env.AGENT_WORKFLOW_HOME
const tmps: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'rfc213-route-'))
  tmps.push(d)
  return d
}
afterEach(() => {
  if (savedHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
  else process.env.AGENT_WORKFLOW_HOME = savedHome
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Impl-gate P1-5: the routes are ADMIN-ONLY now — inject an actor the way
 *  multiAuth does (c.set('actor', …)). Default admin keeps the older tests'
 *  behaviour; role='user' exercises the 403 gate. */
function appWithRoute(role: 'admin' | 'user' = 'admin'): Hono {
  const app = new Hono()
  const inject: MiddlewareHandler = (c, next) => {
    const actor: Actor = {
      user: { id: 'u1', username: 'u1', displayName: 'u1', role, status: 'active' },
      source: 'daemon',
      permissions: new Set(),
    }
    c.set('actor', actor)
    return next()
  }
  app.use('*', inject)
  mountRestoreRoutes(app, {} as AppDeps) // route uses Paths + services, not deps
  return app
}

describe('POST /api/restore', () => {
  test('stages an uploaded backup for next-boot apply', async () => {
    const appHome = tmp()
    process.env.AGENT_WORKFLOW_HOME = appHome
    const db = openDb({ path: join(appHome, 'db.sqlite'), migrationsFolder: MIGRATIONS })
    const backup = await createBackup({ db, appHome, now: 1 })
    ;(db as unknown as { $client: Database }).$client.close()

    const form = new FormData()
    form.append('file', new Blob([readFileSync(backup.path)]), 'backup.tar.gz')
    const res = await appWithRoute().request('/api/restore', { method: 'POST', body: form })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string }
    expect(body.status).toBe('staged')
    expect(hasPendingRestore(appHome)).toBe(true)
  })

  test('rejects a request with no file', async () => {
    process.env.AGENT_WORKFLOW_HOME = tmp()
    const res = await appWithRoute().request('/api/restore', {
      method: 'POST',
      body: new FormData(),
    })
    expect(res.status).toBe(400)
  })
})

// ---------------------------------------------------------------------------
// 实现门（2026-07-22）回归锁 — P1-1 入口校验 / P1-5 admin 门 + pending 可见可取消
// ---------------------------------------------------------------------------

describe('impl-gate P1-1 — stage-depth validation at the door', () => {
  test('a tarball with no db.sqlite is rejected 400 and nothing is staged', async () => {
    const appHome = tmp()
    process.env.AGENT_WORKFLOW_HOME = appHome
    // any .tar.gz that is NOT a backup (here: garbage bytes → extract fails, or
    // a tar without db.sqlite → validation fails); both must 400, never stage.
    const form = new FormData()
    form.append('file', new Blob([Buffer.from('not a tarball at all')]), 'x.tar.gz')
    const res = await appWithRoute().request('/api/restore', { method: 'POST', body: form })
    expect(res.status).toBe(400)
    expect(hasPendingRestore(appHome)).toBe(false)
  })
})

describe('impl-gate P1-5 — admin gate + pending visibility + cancel', () => {
  test('all three endpoints refuse non-admin with 403', async () => {
    process.env.AGENT_WORKFLOW_HOME = tmp()
    const app = appWithRoute('user')
    const post = await app.request('/api/restore', { method: 'POST', body: new FormData() })
    expect(post.status).toBe(403)
    const get = await app.request('/api/restore/pending')
    expect(get.status).toBe(403)
    const del = await app.request('/api/restore/pending', { method: 'DELETE' })
    expect(del.status).toBe(403)
  })

  test('GET reflects a staged restore; DELETE cancels it', async () => {
    const appHome = tmp()
    process.env.AGENT_WORKFLOW_HOME = appHome
    const app = appWithRoute()

    const empty = (await (await app.request('/api/restore/pending')).json()) as {
      pending: unknown
      failed: unknown[]
    }
    expect(empty.pending).toBeNull()
    expect(empty.failed).toEqual([])

    // stage something real, then observe + cancel through the API
    const db = openDb({ path: join(appHome, 'db.sqlite'), migrationsFolder: MIGRATIONS })
    const backup = await createBackup({ db, appHome, now: 1 })
    ;(db as unknown as { $client: Database }).$client.close()
    stagePendingRestore(backup.path, { appHome, now: 42 })

    const got = (await (await app.request('/api/restore/pending')).json()) as {
      pending: { requestedAt: number; stagedBytes: number | null } | null
    }
    expect(got.pending?.requestedAt).toBe(42)
    expect((got.pending?.stagedBytes ?? 0) > 0).toBe(true)

    const del = (await (
      await app.request('/api/restore/pending', { method: 'DELETE' })
    ).json()) as { cleared: boolean }
    expect(del.cleared).toBe(true)
    expect(hasPendingRestore(appHome)).toBe(false)

    const again = (await (
      await app.request('/api/restore/pending', { method: 'DELETE' })
    ).json()) as { cleared: boolean }
    expect(again.cleared).toBe(false)
  })
})
