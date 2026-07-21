// RFC-213 PR-1b — POST /api/restore stages an uploaded backup for next-boot apply
// (never hot-swaps). MUTATION CHECK (manually verified): drop the
// stagePendingRestore call → no marker written → the hasPendingRestore assertion reds.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { Hono } from 'hono'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb } from '../src/db/client'
import type { AppDeps } from '../src/server'
import { createBackup } from '../src/services/backup'
import { hasPendingRestore } from '../src/services/pendingRestore'
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

function appWithRoute(): Hono {
  const app = new Hono()
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
