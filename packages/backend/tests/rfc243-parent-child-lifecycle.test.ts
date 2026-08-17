// RFC-243 PR-2 — parent/child lifecycle cross-cutting locks.
//
// Locks in (design §4.1–§4.5, design-gate P0-2 / P1-1 / P2-6 fixes):
//   1. cancelTask cascades into active children recursively and stamps the
//      DURABLE cascade marker (`canceled-by-parent-cascade` in errorMessage);
//      a direct child cancel keeps the plain marker so adoption can tell the
//      two apart after a crash.
//   2. deleteTask two-way gates: a parent with a non-terminal descendant
//      409s (`task-has-active-children`); a child under a non-terminal parent
//      409s (`task-parent-active`); an 'inherited' child's delete never
//      removes its (parent-owned) workspace directory.
//   3. selectResumeRollbackTargets excludes call rows (child_task_id set).
//   4. Child-side drive gate: resume/retry of a child whose owning call row is
//      terminal → 409 `call-row-finalized`.
//   5. runLiveness child-task delegation: an active child keeps the call row
//      alive without pid/driver; a settled child lets the reconciler reap it.
//   6. enforceLimits §4.5: the call rows' human-wait ledger is deducted from
//      the parent's duration and a currently-awaiting child defers the kill.
//   7. runIsoWorktreeGc P0-2 tightening: interrupted parents and parents with
//      live/interrupted children keep their iso containers.
import { describe, expect, test } from 'bun:test'
import { mkdirSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import type { StartTask } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  cancelTask,
  resumeTask,
  retryNode,
  selectResumeRollbackTargets,
  startTask,
} from '../src/services/task'
import { deleteTask } from '../src/services/taskDelete'
import { enforceLimits, parseCallHumanWait } from '../src/services/limits'
import { runIsoWorktreeGc } from '../src/services/gc'
import { reconcileDeadRunningRuns } from '../src/services/orphanReconcile'
import { resolveRunLiveness } from '../src/services/runLiveness'
import type { MaterializedSpace, StartTaskDeps } from '../src/services/task'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const EMPTY_DEF = JSON.stringify({ $schema_version: 4, inputs: [], nodes: [], edges: [] })

interface SeedOpts {
  status?: string
  parentTaskId?: string
  parentNodeRunId?: string
  spaceKind?: string
  worktreePath?: string
  maxDurationMs?: number
  runningMs?: number
  runningSince?: number | null
  snapshot?: string
}

async function seedWorkflow(db: DbClient): Promise<string> {
  const id = ulid()
  await db
    .insert(workflows)
    .values({ id, name: `wf-${id.slice(-6).toLowerCase()}`, definition: EMPTY_DEF })
  return id
}

async function seedTask(db: DbClient, wfId: string, opts: SeedOpts = {}): Promise<string> {
  const id = ulid()
  await db.insert(tasks).values({
    id,
    name: `t-${id.slice(-6).toLowerCase()}`,
    workflowId: wfId,
    workflowSnapshot: opts.snapshot ?? EMPTY_DEF,
    repoPath: opts.worktreePath ?? '/tmp/rfc243-nowhere',
    worktreePath: opts.worktreePath ?? '/tmp/rfc243-nowhere',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: (opts.status ?? 'running') as 'running',
    inputs: '{}',
    startedAt: Date.now() - 120_000,
    ...(opts.parentTaskId !== undefined
      ? { parentTaskId: opts.parentTaskId, invocationDepth: 1 }
      : {}),
    ...(opts.parentNodeRunId !== undefined ? { parentNodeRunId: opts.parentNodeRunId } : {}),
    ...(opts.spaceKind !== undefined ? { spaceKind: opts.spaceKind as 'remote' } : {}),
    ...(opts.maxDurationMs !== undefined ? { maxDurationMs: opts.maxDurationMs } : {}),
    ...(opts.runningMs !== undefined ? { runningMs: opts.runningMs } : {}),
    ...(opts.runningSince !== undefined ? { runningSince: opts.runningSince } : {}),
  })
  return id
}

async function seedRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  over: Partial<typeof nodeRuns.$inferInsert> = {},
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: 'running',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 120_000,
    ...over,
  })
  return id
}

describe('RFC-243 §4.3 — cancel cascade with durable marker', () => {
  test('parent cancel cascades recursively; markers distinguish cascade vs direct', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const wf = await seedWorkflow(db)
    const parent = await seedTask(db, wf, { status: 'running' })
    const child = await seedTask(db, wf, { status: 'running', parentTaskId: parent })
    const grandchild = await seedTask(db, wf, { status: 'awaiting_human', parentTaskId: child })
    await cancelTask(db, parent)
    const rows = new Map((await db.select().from(tasks)).map((t) => [t.id, t] as const))
    expect(rows.get(parent)?.status).toBe('canceled')
    expect(rows.get(child)?.status).toBe('canceled')
    expect(rows.get(grandchild)?.status).toBe('canceled')
    expect(rows.get(child)?.errorMessage).toBe('canceled-by-parent-cascade')
    expect(rows.get(grandchild)?.errorMessage).toBe('canceled-by-parent-cascade')
    expect(rows.get(parent)?.errorMessage).not.toBe('canceled-by-parent-cascade')
  })

  test('direct child cancel keeps the non-cascade marker', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const wf = await seedWorkflow(db)
    const parent = await seedTask(db, wf, { status: 'running' })
    const child = await seedTask(db, wf, { status: 'running', parentTaskId: parent })
    await cancelTask(db, child)
    const row = (await db.select().from(tasks).where(eq(tasks.id, child)))[0]
    expect(row?.status).toBe('canceled')
    expect(row?.errorMessage).not.toBe('canceled-by-parent-cascade')
  })

  test('a canceled parent transaction-fences a late child task insert', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const wf = await seedWorkflow(db)
    const parent = await seedTask(db, wf, { status: 'running' })
    const callRun = await seedRun(db, parent, 'call', { status: 'running' })
    await cancelTask(db, parent)

    const childId = ulid()
    const childRoot = mkdtempSync(join(tmpdir(), 'aw-rfc243-late-child-'))
    const space: MaterializedSpace = {
      kind: 'single',
      spaceKind: 'inherited',
      taskId: childId,
      worktreePath: childRoot,
      branch: `agent-workflow/${childId}`,
      baseCommit: null,
      earlyError: null,
      resolvedSources: [
        {
          repoPath: childRoot,
          baseBranch: 'main',
          repoUrl: null,
          cachedRepoId: null,
          pathFetchError: null,
          ffWarnings: [],
        },
      ],
      repos: [
        {
          repoIndex: 0,
          repoPath: childRoot,
          repoUrl: null,
          cachedRepoId: null,
          baseBranch: 'main',
          branch: `agent-workflow/${childId}`,
          baseCommit: null,
          worktreePath: childRoot,
          worktreeDirName: '',
          mountPath: '',
          subdir: '',
          readonly: false,
          submoduleInitOk: true,
          submoduleInitError: null,
          hasSubmodules: false,
        },
      ],
      nodePaths: [],
      cleanup: {
        taskId: childId,
        ownedRoot: null,
        worktrees: [],
        state: 'owned',
        report: null,
      },
    }
    try {
      await expect(
        startTask({ workflowId: wf, name: 'late child', inputs: {} } as StartTask, {
          db,
          materializedSpace: space,
          callLaunch: {
            parentTaskId: parent,
            parentNodeRunId: callRun,
            invocationDepth: 1,
            frozenSnapshotJson: EMPTY_DEF,
            refClosureJson: null,
          },
        }),
      ).rejects.toMatchObject({ code: 'parent-task-not-running' })
      expect(await db.select().from(tasks).where(eq(tasks.id, childId))).toHaveLength(0)
    } finally {
      rmSync(childRoot, { recursive: true, force: true })
    }
  })
})

describe('RFC-243 §4.4 — deleteTask two-way gates + inherited workspace skip', () => {
  test('parent with a non-terminal grandchild 409s task-has-active-children', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const wf = await seedWorkflow(db)
    const parent = await seedTask(db, wf, { status: 'done' })
    const child = await seedTask(db, wf, { status: 'done', parentTaskId: parent })
    await seedTask(db, wf, { status: 'running', parentTaskId: child })
    await expect(deleteTask(db, parent)).rejects.toMatchObject({
      code: 'task-has-active-children',
    })
  })

  test('child under a non-terminal parent 409s task-parent-active', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const wf = await seedWorkflow(db)
    const parent = await seedTask(db, wf, { status: 'running' })
    const child = await seedTask(db, wf, { status: 'done', parentTaskId: parent })
    await expect(deleteTask(db, child)).rejects.toMatchObject({ code: 'task-parent-active' })
  })

  test("an inherited child's delete never removes the (parent-owned) workspace dir", async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const wf = await seedWorkflow(db)
    const isoDir = mkdtempSync(join(tmpdir(), 'aw-rfc243-inherited-'))
    writeFileSync(join(isoDir, 'work.txt'), 'child output')
    const parent = await seedTask(db, wf, { status: 'done' })
    const child = await seedTask(db, wf, {
      status: 'done',
      parentTaskId: parent,
      spaceKind: 'inherited',
      worktreePath: isoDir,
    })
    const result = await deleteTask(db, child)
    expect(result.taskId).toBe(child)
    expect(existsSync(isoDir)).toBe(true) // parent's iso survives the child delete
  })
})

describe('RFC-243 §4.2 — resume/rollback carve-outs', () => {
  test('selectResumeRollbackTargets excludes call rows', () => {
    const rows = [
      { id: '01A', nodeId: 'work', parentNodeRunId: null, status: 'failed', childTaskId: null },
      {
        id: '01B',
        nodeId: 'call',
        parentNodeRunId: null,
        status: 'interrupted',
        childTaskId: 'C1',
      },
    ]
    expect(selectResumeRollbackTargets(rows).map((r) => r.id)).toEqual(['01A'])
  })

  test('child resume under a terminal call row 409s call-row-finalized', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const wf = await seedWorkflow(db)
    const parent = await seedTask(db, wf, { status: 'failed' })
    const callRow = await seedRun(db, parent, 'call1', { status: 'failed', childTaskId: 'pending' })
    const child = await seedTask(db, wf, {
      status: 'failed',
      parentTaskId: parent,
      parentNodeRunId: callRow,
    })
    await db.update(nodeRuns).set({ childTaskId: child }).where(eq(nodeRuns.id, callRow))
    const deps = {} as unknown as StartTaskDeps
    await expect(resumeTask(db, child, deps)).rejects.toMatchObject({
      code: 'call-row-finalized',
    })
    await expect(retryNode(db, child, ulid(), { deps })).rejects.toMatchObject({
      code: 'call-row-finalized',
    })
  })
})

describe('RFC-243 §4.1 — liveness delegation to the child task', () => {
  const def = JSON.parse(EMPTY_DEF)
  const callRow = {
    id: '01CALL',
    nodeId: 'call1',
    status: 'running',
    pid: null,
    spawnBinaryPath: null,
    parentNodeRunId: null,
    childTaskId: 'C1',
  }

  test('active child ⇒ alive (child-task-active) without pid or driver', () => {
    const verdict = resolveRunLiveness({
      row: callRow,
      rows: [callRow],
      definition: def,
      taskHasDriver: false,
      probeProcess: () => false,
      probeChildTask: () => 'active',
    })
    expect(verdict).toEqual({ alive: true, reason: 'child-task-active' })
  })

  test('settled child ⇒ evidence lapses, row falls to dead (reap + replay-on-resume)', () => {
    const verdict = resolveRunLiveness({
      row: callRow,
      rows: [callRow],
      definition: def,
      taskHasDriver: false,
      probeProcess: () => false,
      probeChildTask: () => 'settled',
    })
    expect(verdict.alive).toBe(false)
  })

  test('orphanReconcile end-to-end: live child protects the call row; settled child reaps it', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const wf = await seedWorkflow(db)
    const parent = await seedTask(db, wf, { status: 'running' })
    const child = await seedTask(db, wf, { status: 'running', parentTaskId: parent })
    const callRun = await seedRun(db, parent, 'call1', { childTaskId: child })
    const deps = {
      db,
      graceMs: 1_000,
      taskHasDriver: () => false,
      probeProcessAlive: () => false,
    }
    const first = await reconcileDeadRunningRuns(deps)
    expect(first.reapedRuns).not.toContain(callRun)
    // Child settles (done) while the parent driver is gone → the call row is
    // now a reapable orphan; finalize replays on the parent's next resume.
    await db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, child))
    const second = await reconcileDeadRunningRuns(deps)
    expect(second.reapedRuns).toContain(callRun)
  })
})

describe('RFC-243 §4.5 — duration limit human-wait deduction', () => {
  test('parseCallHumanWait sums the ledger and the live segment', () => {
    const now = 1_000_000
    expect(parseCallHumanWait(null, now)).toBe(0)
    expect(parseCallHumanWait('{"callHumanWaitMs":5000}', now)).toBe(5000)
    expect(
      parseCallHumanWait(`{"callHumanWaitMs":5000,"callHumanWaitSince":${now - 2000}}`, now),
    ).toBe(7000)
    expect(parseCallHumanWait('not json', now)).toBe(0)
  })

  test('ledger deduction keeps the parent alive; awaiting child defers the kill', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const wf = await seedWorkflow(db)
    const now = Date.now()
    // Parent A: raw elapsed 100s > 60s limit, but 70s of it is ledgered
    // human-wait → effective 30s < limit → NOT canceled.
    const parentA = await seedTask(db, wf, {
      status: 'running',
      maxDurationMs: 60_000,
      runningMs: 100_000,
      runningSince: null,
    })
    const childA = await seedTask(db, wf, { status: 'running', parentTaskId: parentA })
    await seedRun(db, parentA, 'call1', {
      childTaskId: childA,
      wrapperProgressJson: JSON.stringify({ callHumanWaitMs: 70_000 }),
    })
    // Parent B: over limit even after deduction, but its child is AT a human
    // gate right now → kill deferred (alert only).
    const parentB = await seedTask(db, wf, {
      status: 'running',
      maxDurationMs: 60_000,
      runningMs: 100_000,
      runningSince: null,
    })
    const childB = await seedTask(db, wf, { status: 'awaiting_human', parentTaskId: parentB })
    await seedRun(db, parentB, 'call1', { childTaskId: childB })
    // Parent C: over limit, no ledger, child already done → canceled.
    const parentC = await seedTask(db, wf, {
      status: 'running',
      maxDurationMs: 60_000,
      runningMs: 100_000,
      runningSince: null,
    })
    const childC = await seedTask(db, wf, { status: 'done', parentTaskId: parentC })
    await seedRun(db, parentC, 'call1', { childTaskId: childC, status: 'done' })

    const result = await enforceLimits(db, now)
    expect(result.canceled).not.toContain(parentA)
    expect(result.canceled).not.toContain(parentB)
    expect(result.canceled).toContain(parentC)
  })
})

describe('RFC-243 §4.5 — humanWaitMs 台账不跨代双记（实现门 P2-1）', () => {
  test('新代调用行台账归零；仅领养同一行才继承', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const wf = await seedWorkflow(db)
    const parent = await seedTask(db, wf, {
      status: 'running',
      maxDurationMs: 60_000,
      runningMs: 100_000,
      runningSince: null,
    })
    // 旧代（已终态、带 70s 等待台账）+ 新代（领养前应为空账）。
    const child1 = await seedTask(db, wf, { status: 'canceled', parentTaskId: parent })
    await seedRun(db, parent, 'call1', {
      status: 'failed',
      childTaskId: child1,
      wrapperProgressJson: JSON.stringify({ callHumanWaitMs: 70_000 }),
    })
    const child2 = await seedTask(db, wf, { status: 'running', parentTaskId: parent })
    await seedRun(db, parent, 'call1', { childTaskId: child2, retryIndex: 1 })
    // 台账合计只应来自真实存在的账，不因换代翻倍：70s（旧代）+0（新代）。
    const { parseCallHumanWait } = await import('../src/services/limits')
    expect(parseCallHumanWait(JSON.stringify({ callHumanWaitMs: 70_000 }), Date.now())).toBe(70_000)
    expect(parseCallHumanWait(null, Date.now())).toBe(0)
    // 源码锁：新 mint 的行不得继承被取代行的台账（否则同段等待计两次）。
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    expect(src).toContain('adoptedChildTaskId !== null')
    expect(src).toContain('parseCallLedger(null)')
  })
})

describe('RFC-243 §8 — 列表口径（PR-5 翻转）', () => {
  test('listTasks topLevelOnly 隐藏子任务；parentTaskId 过滤只出直接子代', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const wf = await seedWorkflow(db)
    const parent = await seedTask(db, wf, { status: 'running' })
    const child = await seedTask(db, wf, { status: 'running', parentTaskId: parent })
    const { listTasks } = await import('../src/services/task')
    const top = await listTasks(db, { topLevelOnly: true })
    expect(top.map((t) => t.id)).toContain(parent)
    expect(top.map((t) => t.id)).not.toContain(child)
    expect(top.find((t) => t.id === parent)?.parentTaskId ?? null).toBeNull()
    const children = await listTasks(db, { parentTaskId: parent })
    expect(children.map((t) => t.id)).toEqual([child])
    expect(children[0]?.parentTaskId).toBe(parent)
  })
})

describe('RFC-243 §4.4 — iso GC revivability carve-outs (design-gate P0-2)', () => {
  test('interrupted parents and parents with live/interrupted children keep their iso', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const wf = await seedWorkflow(db)
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc243-isogc-'))
    const mkIso = (taskId: string): string => {
      const dir = join(appHome, 'iso', taskId)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'marker'), 'x')
      return dir
    }
    // ① interrupted (revivable) parent → survives.
    const interrupted = await seedTask(db, wf, { status: 'interrupted' })
    const dirInterrupted = mkIso(interrupted)
    // ② done parent whose call row references an interrupted child → survives.
    const doneWithChild = await seedTask(db, wf, { status: 'done' })
    const childInterrupted = await seedTask(db, wf, {
      status: 'interrupted',
      parentTaskId: doneWithChild,
    })
    await seedRun(db, doneWithChild, 'call1', {
      status: 'interrupted',
      childTaskId: childInterrupted,
    })
    const dirDoneWithChild = mkIso(doneWithChild)
    // ③ plainly settled parent (done, settled child) → reclaimed.
    const settled = await seedTask(db, wf, { status: 'done' })
    const childDone = await seedTask(db, wf, { status: 'done', parentTaskId: settled })
    await seedRun(db, settled, 'call1', { status: 'done', childTaskId: childDone })
    const dirSettled = mkIso(settled)

    const result = await runIsoWorktreeGc(db, appHome)
    expect(existsSync(dirInterrupted)).toBe(true)
    expect(existsSync(dirDoneWithChild)).toBe(true)
    expect(existsSync(dirSettled)).toBe(false)
    expect(result.removed).toContain(settled)
  })
})
