// Locks in RFC-005 PR-B T13 worktree-files proxy + path traversal hardening.
// If this goes red, check packages/backend/src/routes/worktree-files.ts —
// a regression here means the markdown image proxy may read files outside
// the task worktree.
//
// RFC-359 AC-6：整份套件跑双引擎。此前一半用例经 `createApp` 自建 SQLite 应用、另一半走
// provider 装配；现在只剩后者一条路——同一套判据在两个引擎的**完整生产装配**上各跑一遍。
// 五个注册面合并成一个：每个 `describeEachProvider` 注册面都要现建一个 PostgreSQL 库并跑
// 完整迁移（beforeAll，本机 ~1.5s），合并后这份开销只付一次。

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { tasks } from '../src/db/schema'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import {
  createProviderHttpApplication,
  type ProviderHttpApplication,
} from './helpers/providerHttpApplication'

interface Harness {
  db: ProviderNeutralDatabase
  worktree: string
  outside: string
  taskId: string
  app: ProviderHttpApplication['app']
  cleanup: () => void
}

interface HarnessApplicationInput {
  db: ProviderNeutralDatabase
  token: string
  configPath: string
  opencodeVersion: string
  dbVersion: number
}

async function buildHarness(
  createDatabase: () => ProviderNeutralDatabase,
  createApplication: (input: HarnessApplicationInput) => Promise<Harness['app']>,
  onDirectory: (directory: string) => void,
): Promise<Harness> {
  const db = createDatabase()
  const worktree = mkdtempSync(join(tmpdir(), 'aw-wt-'))
  onDirectory(worktree)
  const outside = mkdtempSync(join(tmpdir(), 'aw-outside-'))
  onDirectory(outside)
  // Seed an outside-of-worktree secret to test traversal attempts read it.
  writeFileSync(join(outside, 'secrets.txt'), 'TOP SECRET')
  // Seed worktree content.
  mkdirSync(join(worktree, 'design', 'img'), { recursive: true })
  writeFileSync(join(worktree, 'design', 'img', 'diagram.png'), 'BINARY_PNG_BYTES')
  writeFileSync(join(worktree, 'design', 'spec.md'), '# Spec\nbody')

  const taskId = ulid()
  // Pre-create a workflow row (foreign key target).
  const workflowId = ulid()
  await db.insert((await import('../src/db/schema')).workflows).values({
    id: workflowId,
    name: 'wf',
    description: '',
    definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })

  await db.insert(tasks).values({
    name: 'fixture-task',

    id: taskId,
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/repo',
    worktreePath: worktree,
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    baseCommit: null,
    status: 'done',
    inputs: '{}',
    maxDurationMs: null,
    maxTotalTokens: null,
    startedAt: Date.now(),
    finishedAt: Date.now(),
    // PostgreSQL 的迁移只投影 DDL，不带 `rfc328_tasks_lineage_after_insert` 那条 SQLite
    // 触发器，所以直插 `tasks` 的夹具两侧都显式写 lineage，两个引擎的起点才相同。
    executionLineageId: taskId,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ]),
  })

  const app = await createApplication({
    token: 'tok',
    configPath: '',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })

  return {
    db,
    worktree,
    outside,
    taskId,
    app,
    cleanup: () => {
      rmSync(worktree, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    },
  }
}

const HEADERS = { Authorization: 'Bearer tok' }

describeEachProvider('GET /api/worktree-files/:taskId/* — RFC-005 T13', (harness) => {
  describe('application lifetime', () => {
    let h: Harness
    let application: ProviderHttpApplication | undefined
    let appHome: string | undefined
    let restoreHome: (() => void) | undefined
    let ownedDirectories: string[] = []
    beforeEach(async () => {
      application = undefined
      appHome = undefined
      restoreHome = undefined
      ownedDirectories = []
      const previousHome = process.env.AGENT_WORKFLOW_HOME
      appHome = mkdtempSync(join(tmpdir(), 'rfc359-w50-proxy-'))
      restoreHome = () => {
        if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
        else process.env.AGENT_WORKFLOW_HOME = previousHome
      }
      process.env.AGENT_WORKFLOW_HOME = appHome
      h = await buildHarness(
        () => harness.db,
        async (input) => {
          application = await createProviderHttpApplication(harness, {
            token: input.token,
            configPath: join(appHome!, 'config.json'),
            opencodeVersion: input.opencodeVersion,
            dbVersion: input.dbVersion,
            appHome: appHome!,
          })
          return application.app
        },
        (directory) => ownedDirectories.push(directory),
      )
    })
    afterEach(async () => {
      try {
        await application?.dispose()
      } finally {
        try {
          h.cleanup()
        } finally {
          for (const directory of ownedDirectories)
            rmSync(directory, { recursive: true, force: true })
          restoreHome?.()
          if (appHome !== undefined) rmSync(appHome, { recursive: true, force: true })
        }
      }
    })

    test('returns file content with correct mime type for known extensions', async () => {
      const res = await h.app.fetch(
        new Request(`http://localhost/api/worktree-files/${h.taskId}/design/img/diagram.png`, {
          headers: HEADERS,
        }),
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/png')
      expect(await res.text()).toBe('BINARY_PNG_BYTES')
    })

    test('renders markdown with proper mime', async () => {
      const res = await h.app.fetch(
        new Request(`http://localhost/api/worktree-files/${h.taskId}/design/spec.md`, {
          headers: HEADERS,
        }),
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/markdown')
      expect(await res.text()).toContain('# Spec')
    })

    // The attack cases below assert the specific rejection `code`, not just "some
    // 4xx". A range check passes no matter WHICH branch fired — and tightening
    // these three revealed that two of them were not testing what their names
    // claimed: WHATWG URL parsing collapses `..` and `%2e%2e` path segments BEFORE
    // routing, so those requests never reach the handler's containment check at
    // all. They land on a different task id and get a plain 404. The containment
    // branch (`worktree-file-escapes-worktree`) therefore had ZERO real coverage
    // while three tests appeared to guard it. `attack 4` below is the vector that
    // actually reaches it. (design/test-guard-audit-2026-07-21 gap B1-routes-7.)
    test('attack 1: a literal ../ segment is collapsed by URL parsing, never reaching the worktree', async () => {
      const res = await h.app.fetch(
        new Request(`http://localhost/api/worktree-files/${h.taskId}/../outside/secrets.txt`, {
          headers: HEADERS,
        }),
      )
      // Normalised to /api/worktree-files/outside/secrets.txt — a different,
      // non-existent task. Refused before any filesystem access.
      expect(res.status).toBe(404)
      expect(await res.text()).not.toContain('TOP SECRET')
    })

    test('attack 2: absolute path /etc/passwd is refused as absolute, not merely 4xx', async () => {
      const res = await h.app.fetch(
        new Request(`http://localhost/api/worktree-files/${h.taskId}//etc/passwd`, {
          headers: HEADERS,
        }),
      )
      expect(res.status).toBe(422)
      expect((await res.clone().json()) as { code: string }).toMatchObject({
        code: 'worktree-file-absolute-path',
      })
      expect(await res.text()).not.toContain('root:')
    })

    test('attack 3: %2E%2E is a dot-segment too — also collapsed before routing', async () => {
      // The URL spec treats `%2e%2e` as a double-dot segment (case-insensitive),
      // so this is the same shape as attack 1, not a distinct bypass.
      const res = await h.app.fetch(
        new Request(`http://localhost/api/worktree-files/${h.taskId}/%2E%2E/outside/secrets.txt`, {
          headers: HEADERS,
        }),
      )
      expect(res.status).toBe(404)
      expect(await res.text()).not.toContain('TOP SECRET')
    })

    test('attack 4: encoded SLASH survives normalisation and is caught by the containment check', async () => {
      // `..%2Foutside%2Fsecrets.txt` is a single path segment as far as the URL
      // parser is concerned (no dot-segment to collapse), so it arrives intact;
      // the handler's single decodeURIComponent then turns it into
      // `../outside/secrets.txt`. This is the request that must be stopped by
      // resolve()+prefix containment, and the only one in this file that
      // exercises it. Deleting that check turns this red — and nothing else.
      const res = await h.app.fetch(
        new Request(`http://localhost/api/worktree-files/${h.taskId}/..%2Foutside%2Fsecrets.txt`, {
          headers: HEADERS,
        }),
      )
      expect(res.status).toBe(422)
      expect((await res.clone().json()) as { code: string }).toMatchObject({
        code: 'worktree-file-escapes-worktree',
      })
      expect(await res.text()).not.toContain('TOP SECRET')
    })

    test('malformed percent encoding is a client error, never an uncaught 500', async () => {
      const res = await h.app.fetch(
        new Request(`http://localhost/api/worktree-files/${h.taskId}/%E0%A4%A`, {
          headers: HEADERS,
        }),
      )
      expect(res.status).toBe(422)
      expect((await res.json()) as { code: string }).toMatchObject({
        code: 'worktree-file-invalid-encoding',
      })
    })

    test('missing file → 404', async () => {
      const res = await h.app.fetch(
        new Request(`http://localhost/api/worktree-files/${h.taskId}/no/such/path.png`, {
          headers: HEADERS,
        }),
      )
      expect(res.status).toBe(404)
    })

    test('unknown task → 404', async () => {
      const res = await h.app.fetch(
        new Request(`http://localhost/api/worktree-files/no_such_task/design/spec.md`, {
          headers: HEADERS,
        }),
      )
      expect(res.status).toBe(404)
    })

    test('missing relative path (just /api/worktree-files/:taskId) → 422', async () => {
      const res = await h.app.fetch(
        new Request(`http://localhost/api/worktree-files/${h.taskId}`, { headers: HEADERS }),
      )
      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(res.status).toBeLessThan(500)
    })

    test('directory target (not a regular file) → 404', async () => {
      const res = await h.app.fetch(
        new Request(`http://localhost/api/worktree-files/${h.taskId}/design`, { headers: HEADERS }),
      )
      expect(res.status).toBe(404)
    })

    test('no auth → 401', async () => {
      const res = await h.app.fetch(
        new Request(`http://localhost/api/worktree-files/${h.taskId}/design/spec.md`),
      )
      expect(res.status).toBe(401)
    })

    test('unknown extension → octet-stream (no auto-render of exotic types)', async () => {
      writeFileSync(join(h.worktree, 'data.xyz'), 'opaque')
      const res = await h.app.fetch(
        new Request(`http://localhost/api/worktree-files/${h.taskId}/data.xyz`, {
          headers: HEADERS,
        }),
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/octet-stream')
    })
  })
})
