// RFC-243 PR-1 — unified executor facade locks.
//
// Locks in (design.md §1.1/§1.2/§1.4):
//   1. Source-text: the four launch call faces (routes/tasks.ts incl. the
//      multipart handoff, routes/agents.ts, routes/workgroups.ts,
//      services/scheduleLaunch.ts) go through `startExecution` and never call
//      startTask / startAgentTask / startWorkgroupTask directly again.
//   2. resolveTaskEngine — the engine fork extracted from scheduler.ts is
//      byte-equal to the pre-RFC-243 inline decision (RFC-164/167/217
//      semantics).
//   3. startExecution guards: workflow ref/payload id mismatch fails loudly;
//      the `node` invoker is fail-closed until RFC-243 PR-3/4.
//   4. executionWatch: immediate resolve for already-terminal rows; multicast
//      resolve from the lifecycle write path for ALL FOUR terminal statuses
//      (failed/interrupted included — the single-slot RFC-202 hook only fires
//      for done|canceled); missing-row resolve; poll fallback catches a row
//      deleted after registration; abort resolves 'aborted'.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { setTaskStatus, trySetTaskStatus } from '../src/services/lifecycle'
import { resolveTaskEngine } from '../src/services/execution/engines'
import { startExecution } from '../src/services/execution/executor'
import {
  resetTaskTerminalWatchersForTests,
  watchTaskTerminal,
} from '../src/services/execution/executionWatch'
import { ValidationError } from '../src/util/errors'
import type { Actor } from '../src/auth/actor'
import type { TaskStatus } from '@agent-workflow/shared'
import type { StartTaskDeps } from '../src/services/task'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SRC = resolve(import.meta.dir, '..', 'src')

function srcText(rel: string): string {
  return readFileSync(resolve(SRC, rel), 'utf8')
}

describe('RFC-243 T2 — launch call faces route through the executor (source lock)', () => {
  const CALL_FACES = [
    'routes/tasks.ts',
    'routes/agents.ts',
    'routes/workgroups.ts',
    'services/scheduleLaunch.ts',
  ]
  for (const rel of CALL_FACES) {
    test(`${rel} has no direct start* launch call`, () => {
      const text = srcText(rel)
      // direct launch-service invocations (`await startTask(`, `startAgentTask(`,
      // `startWorkgroupTask(`) are banned; the executor facade is the only path.
      expect(/\bstartTask\(/.test(text)).toBe(false)
      expect(/\bstartAgentTask\(/.test(text)).toBe(false)
      expect(/\bstartWorkgroupTask\(/.test(text)).toBe(false)
      expect(text).toContain(`startExecution`)
    })
  }

  test('executor.ts is the only module allowed to call all three launch services', () => {
    const text = srcText('services/execution/executor.ts')
    expect(text).toContain('startTask(')
    expect(text).toContain('startAgentTask(')
    expect(text).toContain('startWorkgroupTask(')
  })

  test('call 分支纪律：不持 globalSem；adoption 区零 mint（实现门 P2-4 源锁）', () => {
    const text = srcText('services/scheduler.ts')
    const fnStart = text.indexOf('async function runCallWorkflowNode')
    const fnEnd = text.indexOf('async function failCallRow')
    expect(fnStart).toBeGreaterThan(0)
    expect(fnEnd).toBeGreaterThan(fnStart)
    const body = text.slice(fnStart, fnEnd)
    expect(body).not.toContain('globalSem.acquire')
    const aStart = body.indexOf('RFC-243-LOCK:adoption-no-mint-begin')
    const aEnd = body.indexOf('RFC-243-LOCK:adoption-no-mint-end')
    expect(aStart).toBeGreaterThan(0)
    expect(aEnd).toBeGreaterThan(aStart)
    expect(body.slice(aStart, aEnd)).not.toContain('mintNodeRun(')
  })

  test('scheduler consumes the engine registry (no inline dispatch left)', () => {
    const text = srcText('services/scheduler.ts')
    expect(text).toContain('resolveTaskEngine')
    expect(/\bderiveWorkgroupDispatch\(/.test(text)).toBe(false)
  })
})

describe('RFC-243 T3 — resolveTaskEngine (extracted fork, byte-equal semantics)', () => {
  const lwConfig = JSON.stringify({ mode: 'leader_worker' })
  const dwConfig = JSON.stringify({ mode: 'dynamic_workflow' })

  test('non-workgroup task → dag, no wg dispatch', () => {
    expect(resolveTaskEngine({ workgroupId: null }, null)).toEqual({
      engine: 'dag',
      wgDispatch: null,
    })
  })

  test('leader_worker → workgroup-turns (dw phase irrelevant)', () => {
    expect(resolveTaskEngine({ workgroupId: ulid(), workgroupConfigJson: lwConfig }, null)).toEqual(
      { engine: 'workgroup-turns', wgDispatch: 'turn-engine' },
    )
  })

  test('unparsable config falls back to leader_worker → turn engine (RFC-217 T2)', () => {
    expect(
      resolveTaskEngine({ workgroupId: ulid(), workgroupConfigJson: 'not json' }, null),
    ).toEqual({ engine: 'workgroup-turns', wgDispatch: 'turn-engine' })
  })

  test('dynamic_workflow without executing phase → dw-generate', () => {
    expect(resolveTaskEngine({ workgroupId: ulid(), workgroupConfigJson: dwConfig }, null)).toEqual(
      { engine: 'dw-generate', wgDispatch: 'dw-generate' },
    )
    expect(
      resolveTaskEngine({ workgroupId: ulid(), workgroupConfigJson: dwConfig }, 'awaiting_confirm'),
    ).toEqual({ engine: 'dw-generate', wgDispatch: 'dw-generate' })
  })

  test('dynamic_workflow executing → dag with dw-execute marker', () => {
    expect(
      resolveTaskEngine({ workgroupId: ulid(), workgroupConfigJson: dwConfig }, 'executing'),
    ).toEqual({ engine: 'dag', wgDispatch: 'dw-execute' })
  })
})

describe('RFC-243 T1 — startExecution guards', () => {
  // guard paths throw before any db/actor/deps use — safe minimal stubs.
  const stubDb = null as unknown as DbClient
  const stubActor = { user: { id: 'u1' } } as unknown as Actor
  const stubDeps = {} as unknown as StartTaskDeps

  test('workflow ref/payload mismatch → execution-ref-mismatch', async () => {
    await expect(
      startExecution(
        stubDb,
        stubActor,
        {
          kind: 'workflow',
          refId: 'wf-a',
          invoker: { type: 'user' },
          payload: { workflowId: 'wf-b', name: 't', inputs: {} },
        },
        stubDeps,
      ),
    ).rejects.toMatchObject({ code: 'execution-ref-mismatch' })
  })

  test('node invoker is fail-closed until PR-3/4', async () => {
    await expect(
      startExecution(
        stubDb,
        stubActor,
        {
          kind: 'workflow',
          refId: 'wf-a',
          invoker: {
            type: 'node',
            parentTaskId: 't1',
            parentNodeRunId: 'r1',
            invocationDepth: 1,
          },
          payload: { workflowId: 'wf-a', name: 't', inputs: {} },
        },
        stubDeps,
      ),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})

// ---------------------------------------------------------------------------
// executionWatch
// ---------------------------------------------------------------------------

async function seedTask(db: DbClient, status: TaskStatus): Promise<string> {
  const definition = { $schema_version: 4, inputs: [], nodes: [], edges: [] }
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: `wf-${workflowId.slice(-6).toLowerCase()}`,
    definition: JSON.stringify(definition),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc243-watch',
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/rfc243-nowhere',
    worktreePath: '/tmp/rfc243-nowhere',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status,
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

describe('RFC-243 T5 — executionWatch', () => {
  test('already-terminal task resolves on the immediate read', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db, 'done')
    expect(await watchTaskTerminal(db, taskId)).toEqual({ kind: 'terminal', status: 'done' })
  })

  test('missing row resolves `missing` (never hangs)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    expect(await watchTaskTerminal(db, ulid())).toEqual({ kind: 'missing' })
  })

  test('lifecycle write resolves watchers for failed (a status the RFC-202 hook ignores)', async () => {
    resetTaskTerminalWatchersForTests()
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db, 'running')
    const watching = watchTaskTerminal(db, taskId, { pollMs: 60_000 })
    await Bun.sleep(10)
    await setTaskStatus({
      db,
      taskId,
      to: 'failed',
      allowedFrom: ['running'],
      reason: 'rfc243-test',
    })
    expect(await watching).toEqual({ kind: 'terminal', status: 'failed' })
  })

  test('multicast: two watchers both resolve; interrupted counts as terminal', async () => {
    resetTaskTerminalWatchersForTests()
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db, 'running')
    const a = watchTaskTerminal(db, taskId, { pollMs: 60_000 })
    const b = watchTaskTerminal(db, taskId, { pollMs: 60_000 })
    await Bun.sleep(10)
    const won = await trySetTaskStatus({
      db,
      taskId,
      to: 'interrupted',
      allowedFrom: ['running'],
      reason: 'rfc243-test',
    })
    expect(won).toBe(true)
    expect(await a).toEqual({ kind: 'terminal', status: 'interrupted' })
    expect(await b).toEqual({ kind: 'terminal', status: 'interrupted' })
  })

  test('poll fallback: a row deleted after registration resolves `missing`', async () => {
    resetTaskTerminalWatchersForTests()
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db, 'running')
    const watching = watchTaskTerminal(db, taskId, { pollMs: 25 })
    await Bun.sleep(10)
    await db.delete(tasks).where(eq(tasks.id, taskId))
    expect(await watching).toEqual({ kind: 'missing' })
  })

  test('abort signal resolves `aborted` and deregisters', async () => {
    resetTaskTerminalWatchersForTests()
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db, 'running')
    const ctrl = new AbortController()
    const watching = watchTaskTerminal(db, taskId, { signal: ctrl.signal, pollMs: 60_000 })
    await Bun.sleep(10)
    ctrl.abort()
    expect(await watching).toEqual({ kind: 'aborted' })
  })
})
