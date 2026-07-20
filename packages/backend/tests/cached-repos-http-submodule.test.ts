// RFC-034 T8 — locks the cached-repos HTTP surface emitting submodule
// telemetry fields. We focus on serializer / schema shape rather than re-
// exercising the full clone path (covered in git-repo-cache-submodule.test.ts).

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos } from '../src/db/schema'
import { createApp } from '../src/server'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  tmp: string
}

function buildHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc034-http-'))
  const appHome = join(tmp, 'home')
  mkdirSync(appHome, { recursive: true })
  process.env.AGENT_WORKFLOW_HOME = appHome
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: join(tmp, 'config.json'),
    opencodeVersion: '1.14.25',
    dbVersion: 17,
    db,
  })
  return { db, app, tmp }
}

async function req(app: Hono, path: string, init?: RequestInit): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  })
}

describe('cached-repos HTTP RFC-034 submodule telemetry', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })

  test('GET /api/cached-repos serializes the three submodule columns', async () => {
    const now = Date.now()
    h.db
      .insert(cachedRepos)
      .values({
        id: ulid(),
        urlHash: 'aaaa1111',
        url: 'git@github.com:foo/with-subs.git',
        localPath: '/tmp/aw-mock-cache/aaaa1111',
        defaultBranch: 'main',
        lastFetchedAt: now,
        createdAt: now,
        hasSubmodules: true,
        lastSubmoduleSyncOk: false,
        lastSubmoduleSyncError: 'fatal: permission denied (publickey)',
      })
      .run()
    h.db
      .insert(cachedRepos)
      .values({
        id: ulid(),
        urlHash: 'bbbb2222',
        url: 'git@github.com:foo/no-subs.git',
        localPath: '/tmp/aw-mock-cache/bbbb2222',
        defaultBranch: 'main',
        lastFetchedAt: now,
        createdAt: now,
        // legacy row — submodule columns omitted, should serialize as null
      })
      .run()

    const res = await req(h.app, '/api/cached-repos')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      items: Array<{
        urlRedacted: string
        hasSubmodules: boolean | null
        lastSubmoduleSyncOk: boolean | null
        lastSubmoduleSyncError: string | null
      }>
    }
    const subRow = body.items.find((r) => r.urlRedacted.includes('with-subs'))!
    expect(subRow.hasSubmodules).toBe(true)
    expect(subRow.lastSubmoduleSyncOk).toBe(false)
    expect(subRow.lastSubmoduleSyncError).toContain('permission denied')

    const legacy = body.items.find((r) => r.urlRedacted.includes('no-subs'))!
    expect(legacy.hasSubmodules).toBeNull()
    expect(legacy.lastSubmoduleSyncOk).toBeNull()
    expect(legacy.lastSubmoduleSyncError).toBeNull()

    rmSync(h.tmp, { recursive: true, force: true })
  })
})
