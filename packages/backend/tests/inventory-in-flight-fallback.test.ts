// RFC-062: in-flight inventory fallback. When the runner hasn't yet read
// inventory.json off disk and persisted it to `node_runs.inventory_snapshot_json`
// (i.e. the agent run is still `status='running'`), GET /inventory should
// transparently read runRoot/inventory.json instead of returning a misleading
// `file-missing` reason that blames the dump plugin. Locks in:
//   - AC-1 running + file exists → captured snapshot
//   - AC-2 running + file missing → reason='in-flight'
//   - AC-3 running + file corrupt → reason='parse-failed' (propagated)
//   - AC-4 running + DB column has data → DB still wins (no disk read needed)
//   - AC-5 terminal states (done/canceled/failed) + file on disk → NULL stays
//          NULL (DB is authoritative; runRoot may not be cleaned yet)
//   - AC-7 non-agent kind → 410 still wins, in-flight branch never reached
//   - AC-8 pending state → file-missing (not in-flight; opencode not started)
//   - dump-plugin-written {captured:false, reason:'dump-plugin-internal-error'}
//          stub is NOT promoted to 'in-flight' — propagate verbatim so the
//          original plugin failure surface stays visible.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { runRootFor } from '../src/services/inventory'
import type { InventorySnapshot, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function buildApp(): { db: DbClient; app: Hono } {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: '',
    opencodeVersion: '1.15.0',
    dbVersion: 1,
    db,
  })
  return { db, app }
}

async function req(app: Hono, path: string): Promise<Response> {
  return app.request(path, { headers: { Authorization: `Bearer ${TOKEN}` } })
}

type NodeRunStatus = 'pending' | 'running' | 'done' | 'canceled' | 'failed'
type NodeKind =
  | 'agent-single'
  | 'input'
  | 'output'
  | 'wrapper-git'
  | 'wrapper-loop'
  | 'wrapper-fanout'
  | 'review'
  | 'clarify'

interface SeedOpts {
  nodeKind?: NodeKind
  runStatus?: NodeRunStatus
  inventoryJson?: string | null
}

async function seed(
  db: DbClient,
  opts: SeedOpts = {},
): Promise<{ taskId: string; nodeRunId: string }> {
  const taskId = `task_${ulid()}`
  const workflowId = `wf_${taskId}`
  const nodeId = 'n1'
  const def: WorkflowDefinition = {
    $schema_version: 3,
    inputs: [],
    nodes: [
      {
        id: nodeId,
        kind: opts.nodeKind ?? 'agent-single',
        agentName: 'coder',
      } as WorkflowNode,
    ],
    edges: [],
    outputs: [],
  }
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    name: 'fixture-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/test',
    worktreePath: '/tmp/test',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: opts.runStatus === 'running' ? 'running' : 'done',
    inputs: '{}',
    startedAt: 1000,
  })
  const nodeRunId = ulid()
  await db.insert(nodeRuns).values({
    id: nodeRunId,
    taskId,
    nodeId,
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
    clarifyIteration: 0,
    status: opts.runStatus ?? 'done',
    promptText: 'go',
    startedAt: 1000,
    inventorySnapshotJson: opts.inventoryJson ?? null,
  })
  return { taskId, nodeRunId }
}

function makeCapturedSnapshot(label = 'coder'): InventorySnapshot {
  return {
    captured: true,
    schemaVersion: 1,
    capturedAt: 1700000000000,
    agents: [
      {
        name: label,
        mode: 'primary',
        modelProviderId: 'anthropic',
        modelId: 'claude-opus-4-7',
        readonly: false,
        source: 'inline',
      },
    ],
    skills: [{ name: 'foo', source: 'managed', path: '/x', description: null }],
    mcps: [{ name: 'memcache', type: 'local', status: 'connected', hint: null }],
    plugins: [{ specifier: 'file:///a.mjs', source: 'inline' }],
  }
}

let appHomeOverride: string
const originalAppHome = process.env.AGENT_WORKFLOW_HOME

beforeAll(() => {
  appHomeOverride = mkdtempSync(join(tmpdir(), 'aw-rfc062-'))
  process.env.AGENT_WORKFLOW_HOME = appHomeOverride
})
afterAll(() => {
  if (originalAppHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
  else process.env.AGENT_WORKFLOW_HOME = originalAppHome
  rmSync(appHomeOverride, { recursive: true, force: true })
})

beforeEach(() => {
  resetBroadcastersForTests()
})
afterEach(() => {
  resetBroadcastersForTests()
})

describe('RFC-062 GET /inventory in-flight fallback', () => {
  test('AC-1: running + DB NULL + runRoot has valid inventory.json → captured snapshot', async () => {
    const { db, app } = buildApp()
    const { taskId, nodeRunId } = await seed(db, { runStatus: 'running', inventoryJson: null })
    const runRoot = runRootFor(taskId, nodeRunId)
    mkdirSync(runRoot, { recursive: true })
    writeFileSync(join(runRoot, 'inventory.json'), JSON.stringify(makeCapturedSnapshot()), 'utf-8')
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InventorySnapshot
    expect(body.captured).toBe(true)
    if (body.captured) {
      expect(body.agents[0]?.name).toBe('coder')
      expect(body.skills[0]?.name).toBe('foo')
      expect(body.mcps[0]?.status).toBe('connected')
      expect(body.plugins[0]?.specifier).toBe('file:///a.mjs')
    }
  })

  test('AC-2: running + DB NULL + runRoot dir exists but inventory.json absent → in-flight', async () => {
    // Realistic queueMicrotask race window: runner.ts:376 already
    // mkdirSync'd runRoot before launching opencode, but the dump plugin's
    // first dump() call hasn't completed yet so inventory.json doesn't exist.
    const { db, app } = buildApp()
    const { taskId, nodeRunId } = await seed(db, { runStatus: 'running', inventoryJson: null })
    mkdirSync(runRootFor(taskId, nodeRunId), { recursive: true })
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InventorySnapshot
    expect(body.captured).toBe(false)
    if (!body.captured) {
      expect(body.reason).toBe('in-flight')
      expect(body.message).toBeNull()
    }
  })

  test('running + runRoot dir NEVER created → reason=plugin-load-failed (real diagnostic)', async () => {
    // Distinct from AC-2: when runRoot itself is missing, the runner couldn't
    // mkdir it (disk full / permission denied / runner crashed before launch).
    // `plugin-load-failed` is the accurate diagnostic; don't mask it with
    // 'in-flight' which would imply "the plugin is still working on it".
    const { db, app } = buildApp()
    const { taskId, nodeRunId } = await seed(db, { runStatus: 'running', inventoryJson: null })
    // Intentionally do NOT create runRoot.
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InventorySnapshot
    expect(body.captured).toBe(false)
    if (!body.captured) expect(body.reason).toBe('plugin-load-failed')
  })

  test('AC-3: running + DB NULL + runRoot file corrupt → reason=parse-failed', async () => {
    const { db, app } = buildApp()
    const { taskId, nodeRunId } = await seed(db, { runStatus: 'running', inventoryJson: null })
    const runRoot = runRootFor(taskId, nodeRunId)
    mkdirSync(runRoot, { recursive: true })
    writeFileSync(join(runRoot, 'inventory.json'), '{ this is not json', 'utf-8')
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InventorySnapshot
    expect(body.captured).toBe(false)
    if (!body.captured) expect(body.reason).toBe('parse-failed')
  })

  test('AC-4: running + DB has valid JSON → DB path wins (file on disk is ignored)', async () => {
    const { db, app } = buildApp()
    const dbSnap = makeCapturedSnapshot('from-db')
    const { taskId, nodeRunId } = await seed(db, {
      runStatus: 'running',
      inventoryJson: JSON.stringify(dbSnap),
    })
    // Plant a *different* snapshot on disk; the DB should still win.
    const runRoot = runRootFor(taskId, nodeRunId)
    mkdirSync(runRoot, { recursive: true })
    writeFileSync(
      join(runRoot, 'inventory.json'),
      JSON.stringify(makeCapturedSnapshot('from-disk')),
      'utf-8',
    )
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InventorySnapshot
    expect(body.captured).toBe(true)
    if (body.captured) expect(body.agents[0]?.name).toBe('from-db')
  })

  test('AC-5a: status=done + DB NULL + runRoot file still on disk → reason=file-missing', async () => {
    // Models the case where runner step 12 cleanup failed but step 11 DB
    // write also didn't happen — DB NULL is authoritative for terminal rows.
    const { db, app } = buildApp()
    const { taskId, nodeRunId } = await seed(db, { runStatus: 'done', inventoryJson: null })
    const runRoot = runRootFor(taskId, nodeRunId)
    mkdirSync(runRoot, { recursive: true })
    writeFileSync(join(runRoot, 'inventory.json'), JSON.stringify(makeCapturedSnapshot()), 'utf-8')
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InventorySnapshot
    expect(body.captured).toBe(false)
    if (!body.captured) expect(body.reason).toBe('file-missing')
  })

  test('AC-5b: status=canceled + DB NULL + runRoot file on disk → file-missing', async () => {
    const { db, app } = buildApp()
    const { taskId, nodeRunId } = await seed(db, { runStatus: 'canceled', inventoryJson: null })
    const runRoot = runRootFor(taskId, nodeRunId)
    mkdirSync(runRoot, { recursive: true })
    writeFileSync(join(runRoot, 'inventory.json'), JSON.stringify(makeCapturedSnapshot()), 'utf-8')
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InventorySnapshot
    expect(body.captured).toBe(false)
    if (!body.captured) expect(body.reason).toBe('file-missing')
  })

  test('AC-5c: status=failed + DB NULL + runRoot file on disk → file-missing', async () => {
    const { db, app } = buildApp()
    const { taskId, nodeRunId } = await seed(db, { runStatus: 'failed', inventoryJson: null })
    const runRoot = runRootFor(taskId, nodeRunId)
    mkdirSync(runRoot, { recursive: true })
    writeFileSync(join(runRoot, 'inventory.json'), JSON.stringify(makeCapturedSnapshot()), 'utf-8')
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InventorySnapshot
    expect(body.captured).toBe(false)
    if (!body.captured) expect(body.reason).toBe('file-missing')
  })

  test('AC-7: non-agent kinds still return 410 (in-flight branch never reached)', async () => {
    const { db, app } = buildApp()
    for (const kind of ['wrapper-git', 'review', 'clarify', 'input', 'output'] as const) {
      const { taskId, nodeRunId } = await seed(db, {
        nodeKind: kind,
        runStatus: 'running',
        inventoryJson: null,
      })
      const runRoot = runRootFor(taskId, nodeRunId)
      mkdirSync(runRoot, { recursive: true })
      writeFileSync(
        join(runRoot, 'inventory.json'),
        JSON.stringify(makeCapturedSnapshot()),
        'utf-8',
      )
      const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
      expect(res.status).toBe(410)
    }
  })

  test('AC-8: status=pending + DB NULL + no runRoot → reason=file-missing (NOT in-flight)', async () => {
    // Pending = opencode not yet started; "in-flight" would mislead the user
    // into thinking inventory is being generated when it really isn't yet.
    const { db, app } = buildApp()
    const { taskId, nodeRunId } = await seed(db, { runStatus: 'pending', inventoryJson: null })
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InventorySnapshot
    expect(body.captured).toBe(false)
    if (!body.captured) expect(body.reason).toBe('file-missing')
  })

  test('dump-plugin internal error stub is propagated verbatim — NOT promoted to in-flight', async () => {
    const { db, app } = buildApp()
    const { taskId, nodeRunId } = await seed(db, { runStatus: 'running', inventoryJson: null })
    const runRoot = runRootFor(taskId, nodeRunId)
    mkdirSync(runRoot, { recursive: true })
    writeFileSync(
      join(runRoot, 'inventory.json'),
      JSON.stringify({
        captured: false,
        reason: 'dump-plugin-internal-error',
        message: 'agents() call threw',
      }),
      'utf-8',
    )
    const res = await req(app, `/api/tasks/${taskId}/node-runs/${nodeRunId}/inventory`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as InventorySnapshot
    expect(body.captured).toBe(false)
    if (!body.captured) {
      expect(body.reason).toBe('dump-plugin-internal-error')
      expect(body.message).toBe('agents() call threw')
    }
  })
})

describe('RFC-062 runRootFor helper', () => {
  test('honours AGENT_WORKFLOW_HOME override (test isolation)', () => {
    // The test suite-level beforeAll sets AGENT_WORKFLOW_HOME to a tmpdir;
    // runRootFor MUST honour that so plant/read in this same test file work.
    const p = runRootFor('task_abc', 'noderun_xyz')
    expect(p.startsWith(appHomeOverride)).toBe(true)
    expect(p.endsWith(join('runs', 'task_abc', 'noderun_xyz'))).toBe(true)
  })

  test('path layout matches runner — runs/{taskId}/{nodeRunId}', () => {
    const p = runRootFor('T', 'N')
    expect(p).toBe(join(appHomeOverride, 'runs', 'T', 'N'))
  })
})

describe('RFC-062 grep guard', () => {
  test("services/inventory.ts contains the 'in-flight' literal", async () => {
    const src = await Bun.file(
      resolve(import.meta.dir, '..', 'src', 'services', 'inventory.ts'),
    ).text()
    expect(src).toContain("'in-flight'")
    // Also lock the runRootFor call inside the in-flight branch — if someone
    // refactors the read-end away, this guard turns red with the right signal.
    expect(src).toContain('runRootFor(taskId, nodeRunId)')
  })
})
