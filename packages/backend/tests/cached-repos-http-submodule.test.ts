// RFC-034 T8 — locks the cached-repos HTTP surface emitting submodule
// telemetry fields. We focus on serializer / schema shape rather than re-
// exercising the full clone path (covered in git-repo-cache-submodule.test.ts).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { cachedRepos } from '../src/db/schema'
import { describeEachProvider } from './helpers/eachProvider'
import {
  createProviderHttpApplication,
  type ProviderHttpApplication,
} from './helpers/providerHttpApplication'

const TOKEN = 'a'.repeat(64)

async function req(app: Hono, path: string, init?: RequestInit): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  })
}

describeEachProvider('cached-repos HTTP RFC-034 submodule telemetry', (harness) => {
  // Dispose application-owned work before the outer harness resets its database.
  describe('complete application lifetime', () => {
    let app: Hono
    let application: ProviderHttpApplication | undefined
    let tmp: string | undefined
    let previousAppHome: string | undefined
    beforeEach(async () => {
      previousAppHome = process.env.AGENT_WORKFLOW_HOME
      application = undefined
      tmp = mkdtempSync(join(tmpdir(), 'aw-rfc034-http-'))
      const appHome = join(tmp, 'home')
      mkdirSync(appHome, { recursive: true })
      process.env.AGENT_WORKFLOW_HOME = appHome
      application = await createProviderHttpApplication(harness, {
        token: TOKEN,
        configPath: join(tmp, 'config.json'),
        opencodeVersion: '1.14.25',
        dbVersion: 17,
        appHome,
      })
      app = application.app
    })

    afterEach(async () => {
      try {
        await application?.dispose()
      } finally {
        if (previousAppHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
        else process.env.AGENT_WORKFLOW_HOME = previousAppHome
        if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true })
      }
    })

    test('GET /api/cached-repos serializes the three submodule columns', async () => {
      const now = Date.now()
      await harness.db
        .insert(cachedRepos)
        .values({
          id: ulid(),
          urlHash: 'aaaa1111',
          urlRedacted: 'git@github.com:foo/with-subs.git',
          localPath: '/tmp/aw-mock-cache/aaaa1111',
          defaultBranch: 'main',
          lastFetchedAt: now,
          createdAt: now,
          hasSubmodules: true,
          lastSubmoduleSyncOk: false,
          lastSubmoduleSyncError: 'fatal: permission denied (publickey)',
        })
        .run()
      await harness.db
        .insert(cachedRepos)
        .values({
          id: ulid(),
          urlHash: 'bbbb2222',
          urlRedacted: 'git@github.com:foo/no-subs.git',
          localPath: '/tmp/aw-mock-cache/bbbb2222',
          defaultBranch: 'main',
          lastFetchedAt: now,
          createdAt: now,
          // legacy row — submodule columns omitted, should serialize as null
        })
        .run()

      const res = await req(app, '/api/cached-repos')
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
    })
  })
})
