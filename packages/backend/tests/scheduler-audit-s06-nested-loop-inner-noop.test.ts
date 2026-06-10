// CURRENT-BEHAVIOR LOCK — design/scheduler-audit-2026-06-10.md S-6 (WP-6a 短期
// validator 禁入 + 锁定现状；长期走 RFC 给 node_runs 加父作用域轴)
//
// 当前缺陷行为（本文件锁定的就是它）：
//   loop 嵌 loop 时，内层 wrapper-loop 以自身计数器 i（startIter=0）调
//   runScope({iteration: i})（scheduler.ts:2253-2263），而 node_runs 没有任何
//   父作用域/父迭代轴——外层迭代 0 与迭代 1 的内层 agent 行键完全相同
//   (taskId, nodeId, iteration)。外层第 2 轮重入时，deriveFrontier
//   （scheduler.ts:1064-1070）按 (nodeId, iteration) 命中第 1 轮的 done 行 →
//   completed → allSettled，内层 agent 一次都不重跑（整体静默 no-op），
//   exit condition / outputBindings 读到的也全是第 1 轮的旧内容。
//   注意不对称性：wrapper 自身行的迭代轴已修（findResumableWrapperRun 按
//   parentIteration 隔离，scheduler.ts:2101-2104 注释自证），所以内层 loop
//   的 wrapper 行确实每外层轮各铸一行——只有 inner agent 行漏掉了轴。
//
// 正确语义：每轮外层迭代内层都应完整执行——本拓扑（外层 2 轮 × 内层 2 轮）
// 下 inner agent 应被真实调起 4 次。
//
// 修复落点：WP-6a（短期 validator 把 loop 嵌 loop 标 error）/ 长期 RFC
// （scopePath / 复合 iteration 轴 + 同步 readPortAtIteration /
// wrapperHasFreshInnerWork）。修复落地时本文件应翻红，按各断言旁
// [FLIP-ON-FIX] 注释翻转期望值（若走 validator 禁入路线，则本文件改为断言
// 任务在调度前被 validator 拒绝，并把运行时断言整体删除——见各断言旁注释）。
//
// 运行时确实支持嵌套：runTask 不跑 workflow validator（直接 buildContainerMap
// → runScope），已在源码核实（scheduler.ts:308-325 仅做 containment + 拓扑环
// 检查）。计数手段：scenario-opencode.ts 每次被调起往 SCENARIO_STATE_DIR/
// trace.jsonl 追加一行（fixtures/scenario-opencode.ts:83-85），数行数即真实
// 调起次数——不依赖 node_runs 行数（行复用正是缺陷本体）。
//
// 确定性说明：单 agent 串行调度，无同毫秒多行排序问题；无 sleep/轮询、无
// 网络、无 stash；临时目录 afterEach 清理；withEnv 退出即还原。

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SCENARIO_OPENCODE = resolve(import.meta.dir, 'fixtures', 'scenario-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  stateDir: string
  planFile: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-audit-s06-'))
  const worktreePath = join(appHome, 'wt')
  const stateDir = join(appHome, 'scenario-state')
  mkdirSync(worktreePath, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  const planFile = join(appHome, 'plan.json')
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    stateDir,
    planFile,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgent(db: DbClient, name: string, outputs: string[]): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    readonly: true,
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
  })
}

async function seedWorkflowAndTask(
  h: Harness,
  definition: WorkflowDefinition,
): Promise<{ taskId: string }> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
  })
  await h.db.insert(tasks).values({
    name: 'audit-s06-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/repo',
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return { taskId }
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      const p = prev[k]
      if (p === undefined) delete process.env[k]
      else process.env[k] = p
    }
  })
}

function readTrace(h: Harness): Array<{ agent: string; callIndex: number }> {
  const tracePath = join(h.stateDir, 'trace.jsonl')
  if (!existsSync(tracePath)) return []
  return readFileSync(tracePath, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { agent: string; callIndex: number })
}

describe('AUDIT S-6 current-behavior lock: loop-in-loop — inner scope silently no-ops from outer round 2 on', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('outer loop(max 2) ∋ inner loop(max 2) ∋ agent: agent really runs only 2 times (correct semantics: 4)', async () => {
    await seedAgent(h.db, 'worker', ['findings'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'worker', kind: 'agent-single', agentName: 'worker' },
        {
          id: 'iloop',
          kind: 'wrapper-loop',
          nodeIds: ['worker'],
          maxIterations: 2,
          // worker plan alternates GO/STOP per call → inner exits exactly
          // at its iteration 1 each round (if it actually ran).
          exitCondition: {
            kind: 'port-equals',
            nodeId: 'worker',
            portName: 'findings',
            value: 'STOP',
          },
          outputBindings: [{ name: 'final', bind: { nodeId: 'worker', portName: 'findings' } }],
        },
        {
          id: 'oloop',
          kind: 'wrapper-loop',
          nodeIds: ['iloop'],
          maxIterations: 2,
          // Never satisfied → outer runs its full 2 rounds, then exhausts.
          // That forces a SECOND entry into the inner loop, which is where
          // the no-op replay manifests.
          exitCondition: {
            kind: 'port-equals',
            nodeId: 'iloop',
            portName: 'final',
            value: '__NEVER__',
          },
          outputBindings: [],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [],
    }
    const { taskId } = await seedWorkflowAndTask(h, def)

    // Per-call plan: GO, STOP, GO, STOP. If the fix lands and the inner
    // loop truly re-executes on outer round 2, calls 2/3 reproduce the
    // same GO→STOP cadence so the topology still terminates identically
    // (outer exhausts either way) — only the call COUNT flips 2 → 4.
    writeFileSync(
      h.planFile,
      JSON.stringify({
        worker: [
          { output: { findings: 'GO' } },
          { output: { findings: 'STOP' } },
          { output: { findings: 'GO' } },
          { output: { findings: 'STOP' } },
        ],
      }),
    )

    await withEnv(
      {
        SCENARIO_PLAN_FILE: h.planFile,
        SCENARIO_STATE_DIR: h.stateDir,
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', SCENARIO_OPENCODE],
        }),
    )

    // Outer loop legitimately exhausts (its exit condition is never
    // satisfied) — identical in buggy and fixed worlds. NOT the defect;
    // anchors that the nested topology was actually driven to completion
    // rather than rejected up front (runTask runs no validator).
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('failed')
    expect(t?.errorMessage).toContain('wrapper-loop-exhausted')
    const oloopRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'oloop')))
    expect(oloopRuns.length).toBe(1)
    expect(oloopRuns[0]?.status).toBe('exhausted')

    // The FIXED part of the iteration-axis story: the inner loop's own
    // wrapper row IS minted once per outer round (findResumableWrapperRun
    // filters by parentIteration). Both rows complete 'done'.
    const iloopRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'iloop')))
    expect(iloopRuns.length).toBe(2)
    expect(new Set(iloopRuns.map((r) => r.iteration))).toEqual(new Set([0, 1]))
    expect(iloopRuns.every((r) => r.status === 'done')).toBe(true)

    // ⟵ THE DEFECT, oracle #1 (real process spawns, counted by
    // scenario-opencode's trace.jsonl): the worker was truly invoked only
    // 2 times — both during OUTER ROUND 1 (inner iterations 0 and 1).
    // Outer round 2's inner loop re-entered runScope with iteration=0/1,
    // hit round 1's done rows, and dispatched NOTHING.
    // Correct semantics: 2 outer rounds × 2 inner iterations = 4 calls.
    // [FLIP-ON-FIX] change both to 4 (or, if WP-6a's validator-reject
    // route is taken instead, replace this whole runtime block with an
    // assertion that the task fails at validation before any dispatch).
    const workerTrace = readTrace(h).filter((l) => l.agent === 'worker')
    expect(workerTrace.length).toBe(2)

    // ⟵ THE DEFECT, oracle #2 (row axis): worker rows exist only for
    // iterations {0,1} keyed by the INNER counter — there is no axis that
    // distinguishes outer round 1 from outer round 2, so round 2 minted
    // zero new worker rows.
    // [FLIP-ON-FIX] with a parent-scope axis there must be 4 distinct
    // worker rows (one per outer×inner combination).
    const workerRuns = await h.db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'worker')))
    expect(workerRuns.length).toBe(2)
    expect(new Set(workerRuns.map((r) => r.iteration))).toEqual(new Set([0, 1]))
    expect(workerRuns.every((r) => r.status === 'done')).toBe(true)

    // ⟵ THE DEFECT, oracle #3 (stale read-through): outer round 2's inner
    // loop still evaluated its exit condition and outputBindings — against
    // ROUND 1's rows. Its iteration-1 wrapper row republishes final='STOP',
    // which is how the replay stays invisible downstream (the task "looks"
    // like both rounds worked).
    //
    // NOTE the value 'STOP' alone is deliberately NOT the lock: the plan
    // repeats GO→STOP for calls 2/3, so a FIXED world also ends round 2
    // with final='STOP' (that keeps termination identical across worlds).
    // What proves staleness is the time axis below: EVERY worker run
    // started strictly before the round-2 wrapper row was even minted,
    // i.e. the output round 2 republished was produced by a run that
    // predates round 2 entirely. Deterministic: between the last round-1
    // worker startedAt and the round-2 wrapper mint lie a full real
    // process execution + wrapper finalize (≫1ms Date.now() margin).
    const iloopRound2 = iloopRuns.find((r) => r.iteration === 1)!
    const round2Final = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(
        and(eq(nodeRunOutputs.nodeRunId, iloopRound2.id), eq(nodeRunOutputs.portName, 'final')),
      )
    expect(round2Final[0]?.content).toBe('STOP')
    const round2Start = iloopRound2.startedAt
    expect(round2Start).not.toBeNull()
    // Belt: every worker row carries startedAt, so none is exempt below.
    expect(workerRuns.every((r) => r.startedAt !== null)).toBe(true)
    // ⟵ THE DEFECT, time-axis form: zero worker activity inside outer
    // round 2 — no worker run started at/after the round-2 wrapper row.
    // [FLIP-ON-FIX] with a parent-scope axis, round 2 mints fresh worker
    // rows whose startedAt >= round2Start; change the expected count to 2
    // (one per inner iteration of outer round 2).
    expect(workerRuns.filter((r) => (r.startedAt ?? 0) >= round2Start!).length).toBe(0)
  }, 20000)
})
