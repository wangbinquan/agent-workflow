import { rimrafDir } from './helpers/cleanup'
// RFC-033-T4: HTTP surface for batch import + per-row retry + snapshot read.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { __resetBatchImportForTests } from '../src/services/repoBatchImport'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  tmp: string
}

function buildHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-batch-http-'))
  const appHome = join(tmp, 'home')
  mkdirSync(appHome, { recursive: true })
  process.env.AGENT_WORKFLOW_HOME = appHome
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: join(tmp, 'config.json'),
    opencodeVersion: '1.14.25',
    dbVersion: 8,
    db,
  })
  return { db, app, tmp }
}

async function req(app: Hono, path: string, init?: RequestInit): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
}

describe('cached-repos batch import HTTP (RFC-033)', () => {
  let h: Harness

  beforeEach(() => {
    __resetBatchImportForTests()
    h = buildHarness()
  })
  afterEach(() => {
    __resetBatchImportForTests()
    resetBroadcastersForTests()
    rimrafDir(h.tmp)
  })

  test('POST /batch-import returns 201 + snapshot immediately', async () => {
    // Use only invalid URLs so we don't actually trigger git clone in this test.
    const t0 = Date.now()
    const res = await req(h.app, '/api/cached-repos/batch-import', {
      method: 'POST',
      body: JSON.stringify({ urls: ['not-a-url', 'still-not'] }),
    })
    const elapsed = Date.now() - t0
    expect(res.status).toBe(201)
    expect(elapsed).toBeLessThan(500)
    const body = (await res.json()) as { batchId: string; state: string; rows: unknown[] }
    expect(body.batchId).toBeTruthy()
    expect(body.state).toBe('completed') // all invalid → instantly completed
    expect(body.rows.length).toBe(2)
  })

  test('POST /batch-import 400 on empty array', async () => {
    const res = await req(h.app, '/api/cached-repos/batch-import', {
      method: 'POST',
      body: JSON.stringify({ urls: [] }),
    })
    expect(res.status).toBe(422) // ValidationError → 422 per util/errors
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('batch-request-invalid')
  })

  test('POST /batch-import 400 on > 100 urls', async () => {
    const urls = Array.from({ length: 101 }, (_, i) => `https://h/${i}.git`)
    const res = await req(h.app, '/api/cached-repos/batch-import', {
      method: 'POST',
      body: JSON.stringify({ urls }),
    })
    expect(res.status).toBe(422)
  })

  test('GET /imports/:batchId returns the snapshot, 404 after expiry', async () => {
    const start = await req(h.app, '/api/cached-repos/batch-import', {
      method: 'POST',
      body: JSON.stringify({ urls: ['not-a-url'] }),
    })
    const startBody = (await start.json()) as { batchId: string }
    const batchId = startBody.batchId

    const got = await req(h.app, `/api/cached-repos/imports/${batchId}`)
    expect(got.status).toBe(200)
    const snap = (await got.json()) as { batchId: string; state: string }
    expect(snap.batchId).toBe(batchId)

    const missing = await req(h.app, '/api/cached-repos/imports/nonexistent')
    expect(missing.status).toBe(404)
    const missingBody = (await missing.json()) as { code: string }
    expect(missingBody.code).toBe('batch-not-found')
  })

  test('POST /imports/:batchId/rows/:rowId/retry happy path with URL override', async () => {
    const start = await req(h.app, '/api/cached-repos/batch-import', {
      method: 'POST',
      body: JSON.stringify({ urls: ['not-a-url'] }),
    })
    const startBody = (await start.json()) as {
      batchId: string
      rows: Array<{ rowId: string; status: string }>
    }
    const batchId = startBody.batchId
    const rowId = startBody.rows[0]!.rowId
    expect(startBody.rows[0]!.status).toBe('failed')

    // Retry with another invalid URL (still failure-mode, but exercises the
    // override path without triggering real git).
    const retried = await req(h.app, `/api/cached-repos/imports/${batchId}/rows/${rowId}/retry`, {
      method: 'POST',
      body: JSON.stringify({ url: 'also-not-a-url' }),
    })
    expect(retried.status).toBe(200)
    const snap = (await retried.json()) as { rows: Array<{ rowId: string; status: string }> }
    expect(snap.rows[0]?.rowId).toBe(rowId)
    expect(snap.rows[0]?.status).toBe('failed')
  })

  test('POST retry 404 on unknown batch / row', async () => {
    const r1 = await req(h.app, '/api/cached-repos/imports/nope/rows/r/retry', {
      method: 'POST',
      body: '{}',
    })
    expect(r1.status).toBe(404)
    const b1 = (await r1.json()) as { code: string }
    expect(b1.code).toBe('batch-not-found')

    const start = await req(h.app, '/api/cached-repos/batch-import', {
      method: 'POST',
      body: JSON.stringify({ urls: ['not-a-url'] }),
    })
    const startBody = (await start.json()) as { batchId: string }
    const r2 = await req(
      h.app,
      `/api/cached-repos/imports/${startBody.batchId}/rows/missing/retry`,
      { method: 'POST', body: '{}' },
    )
    expect(r2.status).toBe(404)
  })

  test('credential URL is redacted in HTTP response body', async () => {
    const cred = 'https://x-token-auth:s3cr3t@github.com/foo/bar.git'
    const res = await req(h.app, '/api/cached-repos/batch-import', {
      method: 'POST',
      body: JSON.stringify({ urls: [cred] }),
    })
    expect(res.status).toBe(201)
    const text = await res.text()
    expect(text).not.toContain('s3cr3t')
    expect(text).not.toContain('x-token-auth')
  })
})
