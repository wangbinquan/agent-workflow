// RFC-193 T7 — GET /api/tasks/:taskId/port-artifacts/... （design §4.7 / case 7）。
//
// 锁定：元数据/内容双形态、MIME 按源扩展名、portName percent-encode 往返、
// 跨任务 nodeRunId 404 同形、无归档时 worktree 回退、回退也 miss → 404、
// 截断响应头。ACL 面由 provider-neutral TaskExecution read model 闭合，
// 多用户不可见→404 同形行为（RFC-285 B1，旧 403）由 worktree-files-acl.test.ts
// 对同一原语覆盖，含 byte-oracle）。

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { archivePortArtifacts } from '../src/services/portArtifacts'
import { createApp } from '../src/server'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import {
  createProviderHttpApplication,
  type ProviderHttpApplication,
} from './helpers/providerHttpApplication'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const HEADERS = { Authorization: 'Bearer tok' }

interface Harness<Database extends ProviderNeutralDatabase = DbClient> {
  db: Database
  appHome: string
  worktree: string
  taskId: string
  runId: string
  app: ReturnType<typeof createApp>
  cleanup: () => void
}

function buildHarness(): Promise<Harness>
function buildHarness(provider: ProviderHarnessContext): Promise<Harness<ProviderNeutralDatabase>>
async function buildHarness(
  provider?: ProviderHarnessContext,
): Promise<Harness<ProviderNeutralDatabase>> {
  const nativeDb = provider === undefined ? createInMemoryDb(MIGRATIONS) : undefined
  const db = provider?.db ?? nativeDb!
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc193-api-'))
  const cleanup = () => rmSync(appHome, { recursive: true, force: true })
  provider?.retainCleanup(cleanup)
  const worktree = join(appHome, 'wt')
  mkdirSync(worktree, { recursive: true })

  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
  })
  const taskId = ulid()
  await db.insert(tasks).values({
    name: 'fixture',
    id: taskId,
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/repo',
    worktreePath: worktree,
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    status: 'done',
    inputs: '{}',
    startedAt: Date.now(),
    ...(provider === undefined ? {} : providerTaskLineage(taskId)),
  })
  const runId = ulid()
  await db.insert(nodeRuns).values({
    id: runId,
    taskId,
    nodeId: 'w',
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
    status: 'done',
    startedAt: Date.now(),
    finishedAt: Date.now(),
  })

  const app =
    nativeDb !== undefined
      ? createApp({
          token: 'tok',
          configPath: '',
          opencodeVersion: '1.14.25',
          dbVersion: 1,
          db: nativeDb,
        })
      : await provider!.createApp(appHome)
  return {
    db,
    appHome,
    worktree,
    taskId,
    runId,
    app,
    cleanup,
  }
}

async function seedArchivedPort(
  h: Harness<ProviderNeutralDatabase>,
  portName: string,
  files: Record<string, string | Buffer>,
) {
  const items: Array<{ sourceAbs: string; sourcePath: string }> = []
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(h.worktree, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
    items.push({ sourceAbs: abs, sourcePath: rel })
  }
  const res = archivePortArtifacts({
    appHome: h.appHome,
    taskId: h.taskId,
    nodeRunId: h.runId,
    portName,
    items,
    worktreeDirName: '',
    worktreeRootAbs: h.worktree,
  })
  await h.db.insert(nodeRunOutputs).values({
    nodeRunId: h.runId,
    portName,
    content: Object.keys(files).join('\n'),
    kind: Object.keys(files).length > 1 ? 'list<path<md>>' : 'path<md>',
    archiveJson: res.archiveJson,
  })
}

describeEachProvider('RFC-193 GET /api/tasks/:taskId/port-artifacts (case 7)', (harness) => {
  describe('fixture lifetime', () => {
    let h: Harness<ProviderNeutralDatabase>
    let application: ProviderHttpApplication | undefined
    let cleanup: (() => void) | undefined
    let previousHome: string | undefined
    let homeAssigned = false
    beforeEach(async () => {
      h = await buildHarness({
        db: harness.db,
        retainCleanup(value) {
          cleanup = value
        },
        async createApp(appHome) {
          previousHome = process.env.AGENT_WORKFLOW_HOME
          process.env.AGENT_WORKFLOW_HOME = appHome
          homeAssigned = true
          application = await createProviderHttpApplication(harness, {
            token: 'tok',
            configPath: join(appHome, 'config.json'),
            opencodeVersion: '1.14.25',
            dbVersion: 1,
            appHome,
          })
          return application.app
        },
      })
    })
    afterEach(async () => {
      try {
        await application?.dispose()
      } finally {
        application = undefined
        try {
          cleanup?.()
        } finally {
          cleanup = undefined
          if (homeAssigned) {
            if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
            else process.env.AGENT_WORKFLOW_HOME = previousHome
          }
          homeAssigned = false
        }
      }
    })

    test('metadata form lists items with size/truncated/source', async () => {
      await seedArchivedPort(h, 'doc', { 'a.md': '# A' })
      const res = await h.app.fetch(
        new Request(`http://localhost/api/tasks/${h.taskId}/port-artifacts/${h.runId}/doc`, {
          headers: HEADERS,
        }),
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { items: Array<Record<string, unknown>> }
      expect(body.items).toHaveLength(1)
      expect(body.items[0]).toMatchObject({ path: 'a.md', truncated: false, source: 'archive' })
      expect(body.items[0]!.size).toBe(Buffer.byteLength('# A'))
    })

    test('item form returns bytes with markdown MIME; worktree can vanish (GC immunity)', async () => {
      await seedArchivedPort(h, 'doc', { 'a.md': '# GC immune' })
      rmSync(h.worktree, { recursive: true, force: true }) // simulate worktree GC
      const res = await h.app.fetch(
        new Request(`http://localhost/api/tasks/${h.taskId}/port-artifacts/${h.runId}/doc?item=0`, {
          headers: HEADERS,
        }),
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('text/markdown')
      expect(await res.text()).toBe('# GC immune')
    })

    test('binary artifact round-trips exact bytes with image MIME', async () => {
      const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe])
      await seedArchivedPort(h, 'img', { 'shot.png': bin })
      const res = await h.app.fetch(
        new Request(`http://localhost/api/tasks/${h.taskId}/port-artifacts/${h.runId}/img?item=0`, {
          headers: HEADERS,
        }),
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('image/png')
      expect(Buffer.compare(Buffer.from(await res.arrayBuffer()), bin)).toBe(0)
    })
  })
})

describe('RFC-193 GET /api/tasks/:taskId/port-artifacts (case 7)', () => {
  let h: Harness
  let prevHome: string | undefined
  beforeEach(async () => {
    h = await buildHarness()
    // 路由经 Paths.root（AGENT_WORKFLOW_HOME 惰性 getter）定位归档根。
    prevHome = process.env.AGENT_WORKFLOW_HOME
    process.env.AGENT_WORKFLOW_HOME = h.appHome
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = prevHome
    h.cleanup()
  })

  test('portName percent-encode round-trip (hostile name)', async () => {
    await seedArchivedPort(h, '../evil', { 'a.md': 'safe' })
    const res = await h.app.fetch(
      new Request(
        `http://localhost/api/tasks/${h.taskId}/port-artifacts/${h.runId}/${encodeURIComponent('../evil')}?item=0`,
        { headers: HEADERS },
      ),
    )
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('safe')
  })
})

describeEachProvider('RFC-193 GET /api/tasks/:taskId/port-artifacts (case 7)', (harness) => {
  describe('fixture lifetime', () => {
    let h: Harness<ProviderNeutralDatabase>
    let application: ProviderHttpApplication | undefined
    let cleanup: (() => void) | undefined
    let previousHome: string | undefined
    let homeAssigned = false
    beforeEach(async () => {
      h = await buildHarness({
        db: harness.db,
        retainCleanup(value) {
          cleanup = value
        },
        async createApp(appHome) {
          previousHome = process.env.AGENT_WORKFLOW_HOME
          process.env.AGENT_WORKFLOW_HOME = appHome
          homeAssigned = true
          application = await createProviderHttpApplication(harness, {
            token: 'tok',
            configPath: join(appHome, 'config.json'),
            opencodeVersion: '1.14.25',
            dbVersion: 1,
            appHome,
          })
          return application.app
        },
      })
    })
    afterEach(async () => {
      try {
        await application?.dispose()
      } finally {
        application = undefined
        try {
          cleanup?.()
        } finally {
          cleanup = undefined
          if (homeAssigned) {
            if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
            else process.env.AGENT_WORKFLOW_HOME = previousHome
          }
          homeAssigned = false
        }
      }
    })

    test('legacy row (no archive) falls back to worktree; both-missing → 404', async () => {
      writeFileSync(join(h.worktree, 'legacy.md'), 'FROM WORKTREE')
      await h.db.insert(nodeRunOutputs).values({
        nodeRunId: h.runId,
        portName: 'legacy',
        content: 'legacy.md',
        kind: 'path<md>',
        archiveJson: null,
      })
      const ok = await h.app.fetch(
        new Request(
          `http://localhost/api/tasks/${h.taskId}/port-artifacts/${h.runId}/legacy?item=0`,
          {
            headers: HEADERS,
          },
        ),
      )
      expect(ok.status).toBe(200)
      expect(await ok.text()).toBe('FROM WORKTREE')

      rmSync(join(h.worktree, 'legacy.md'))
      const miss = await h.app.fetch(
        new Request(
          `http://localhost/api/tasks/${h.taskId}/port-artifacts/${h.runId}/legacy?item=0`,
          {
            headers: HEADERS,
          },
        ),
      )
      expect(miss.status).toBe(404)
    })
  })
})

describe('RFC-193 GET /api/tasks/:taskId/port-artifacts (case 7)', () => {
  let h: Harness
  let prevHome: string | undefined
  beforeEach(async () => {
    h = await buildHarness()
    // 路由经 Paths.root（AGENT_WORKFLOW_HOME 惰性 getter）定位归档根。
    prevHome = process.env.AGENT_WORKFLOW_HOME
    process.env.AGENT_WORKFLOW_HOME = h.appHome
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = prevHome
    h.cleanup()
  })

  test('cross-task nodeRunId → 404 (same shape as not-found)', async () => {
    await seedArchivedPort(h, 'doc', { 'a.md': 'x' })
    const otherTask = ulid()
    const workflowId = ulid()
    await h.db.insert(workflows).values({
      id: workflowId,
      name: 'wf2',
      definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
    })
    await h.db.insert(tasks).values({
      name: 'other',
      id: otherTask,
      workflowId,
      workflowSnapshot: '{}',
      repoPath: '/repo',
      worktreePath: h.worktree,
      baseBranch: 'main',
      branch: 'agent-workflow/' + otherTask,
      status: 'done',
      inputs: '{}',
      startedAt: Date.now(),
    })
    const res = await h.app.fetch(
      new Request(`http://localhost/api/tasks/${otherTask}/port-artifacts/${h.runId}/doc?item=0`, {
        headers: HEADERS,
      }),
    )
    expect(res.status).toBe(404)
  })
})

describeEachProvider('RFC-193 GET /api/tasks/:taskId/port-artifacts (case 7)', (harness) => {
  describe('fixture lifetime', () => {
    let h: Harness<ProviderNeutralDatabase>
    let application: ProviderHttpApplication | undefined
    let cleanup: (() => void) | undefined
    let previousHome: string | undefined
    let homeAssigned = false
    beforeEach(async () => {
      h = await buildHarness({
        db: harness.db,
        retainCleanup(value) {
          cleanup = value
        },
        async createApp(appHome) {
          previousHome = process.env.AGENT_WORKFLOW_HOME
          process.env.AGENT_WORKFLOW_HOME = appHome
          homeAssigned = true
          application = await createProviderHttpApplication(harness, {
            token: 'tok',
            configPath: join(appHome, 'config.json'),
            opencodeVersion: '1.14.25',
            dbVersion: 1,
            appHome,
          })
          return application.app
        },
      })
    })
    afterEach(async () => {
      try {
        await application?.dispose()
      } finally {
        application = undefined
        try {
          cleanup?.()
        } finally {
          cleanup = undefined
          if (homeAssigned) {
            if (previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
            else process.env.AGENT_WORKFLOW_HOME = previousHome
          }
          homeAssigned = false
        }
      }
    })

    test('truncated artifact carries the truncation response header', async () => {
      const { WORKTREE_FILE_MAX_BYTES } = await import('@agent-workflow/shared')
      await seedArchivedPort(h, 'big', { 'big.md': 'x'.repeat(WORKTREE_FILE_MAX_BYTES + 5) })
      const res = await h.app.fetch(
        new Request(`http://localhost/api/tasks/${h.taskId}/port-artifacts/${h.runId}/big?item=0`, {
          headers: HEADERS,
        }),
      )
      expect(res.status).toBe(200)
      expect(res.headers.get('x-aw-artifact-truncated')).toBe('1')
    })
  })
})

describe('RFC-193 GET /api/tasks/:taskId/port-artifacts (case 7)', () => {
  let h: Harness
  let prevHome: string | undefined
  beforeEach(async () => {
    h = await buildHarness()
    // 路由经 Paths.root（AGENT_WORKFLOW_HOME 惰性 getter）定位归档根。
    prevHome = process.env.AGENT_WORKFLOW_HOME
    process.env.AGENT_WORKFLOW_HOME = h.appHome
  })
  afterEach(() => {
    if (prevHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = prevHome
    h.cleanup()
  })

  test('route delegates visibility and artifact rows to the provider read model', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'routes', 'port-artifacts.ts'),
      'utf8',
    )
    expect(src).toContain('taskExecutionReadModels.portArtifacts.find')
    expect(src).not.toMatch(/@\/db|drizzle-orm/)
    // RFC-285 B1：不可见分支必须与 missing 分支同形 404（旧 403 task-not-visible
    // 已退役且不得回潮）。
    expect(src).toContain("throw new NotFoundError('task-not-found'")
    expect(src).not.toContain('task-not-visible')
  })
})

// RFC-359 W49: borrow the selected database while retaining the native seed core.
interface ProviderHarnessContext {
  db: ProviderNeutralDatabase
  createApp(appHome: string): Promise<ReturnType<typeof createApp>>
  retainCleanup(cleanup: () => void): void
}
function providerTaskLineage(id: string) {
  return {
    executionLineageId: id,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: id, workflowRevision: null },
    ]),
  }
}
