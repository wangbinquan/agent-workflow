// CURRENT-BEHAVIOR LOCK — design/scheduler-audit-2026-06-10.md §⑥ 缺口5 (orphans 收割不看任务状态)
//
// 当前缺陷行为（已对照 src/services/orphans.ts:26-70 核实）：
//   `reapOrphanRuns` 的 node_runs 查询是全库 `status IN ('running','pending')`，
//   不 join / 不过滤所属任务的状态（orphans.ts:29-32）。因此 daemon 重启时：
//     1. 合法暂停中任务（task=awaiting_human / awaiting_review）名下的 `pending`
//        锚点行会被翻成 `interrupted`——这些行不是孤儿，它们是"用户答完 clarify /
//        review 后调度器要复用的幂等派发锚点"（runOneNode 的 pendingExisting 复用，
//        scheduler.ts:1438-1449）。
//     2. 尚未开跑任务（task=pending）名下的行同样被收割；且 task 本身保持
//        pending（任务级收割只扫 task.status='running'，orphans.ts:28），重启后
//        无人 re-kick——报告注明只有 stuckTaskDetector S4 的 5 分钟告警兜底。
//   注意 packages/shared/src/node-kind-behavior.ts:72-75 自述 leave-alone 仅靠
//   "查询只选 running/pending" 隐式保证——该保证只按【行状态】成立，按【任务状态】
//   完全不成立，本文件锁定的正是后者。
//
// 正确语义应是：boot 收割只处理"上一个 daemon 进程真正在跑"的任务（task=running，
// 或至少排除 awaiting_* / pending 这类用户可见的合法停泊态）名下的行；暂停中任务的
// pending 锚点行必须原样保留，否则 clarify/review 答复后的恢复路径会找不到锚点行。
//
// 修复归属：报告 ⑥-5 未划入既有 WP，但与 S-1 的修法强耦合（S-1 建议让 deriveFrontier
// 对 pending-latest 放行、依赖 pending 行做幂等锚点；若按该方案修 S-1，必须同步修本
// 缺口，否则 boot 收割会把锚点行翻 interrupted 使 S-1 修复失效）。预计随 WP-1/WP-2 处置。
//
// 修复时本文件应翻红，按各断言旁注释翻转期望值：
//   - awaiting_human 任务的 pending 行应保持 'pending'（现锁 'interrupted'）
//   - pending 任务的 pending 行应保持 'pending'（现锁 'interrupted'）
//   - ReapResult.runs 相应归零

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { reapOrphanRuns } from '../src/services/orphans'

// Same-ms inserts must keep a deterministic id order (freshness is pure ULID
// id-order elsewhere; here it just keeps row identification stable). See the
// precedent + rationale in scheduler-clarify-dispatch.test.ts:33-40.
const ulid = monotonicFactory()

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  tmp: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-gap5-orphans-'))
  const db = createInMemoryDb(MIGRATIONS)
  return { db, tmp, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

async function seedTask(db: DbClient, status: string): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(tasks).values({
    name: 'fixture-task',
    id: taskId,
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: status as typeof tasks.$inferInsert.status,
    inputs: '{}',
    startedAt: Date.now() - 60_000,
  })
  return taskId
}

async function seedRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  status: typeof nodeRuns.$inferInsert.status,
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status,
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 30_000,
  })
  return id
}

async function runStatus(db: DbClient, id: string): Promise<string | undefined> {
  return (await db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]?.status
}

describe('gap5 — reapOrphanRuns ignores task status (current-behavior lock)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('awaiting_human task: pending anchor row is reaped to interrupted while the task itself is untouched', async () => {
    const taskId = await seedTask(h.db, 'awaiting_human')
    // The parked clarify row itself (status awaiting_human) — NOT selected by
    // the reap query, stays put in both current and correct semantics.
    const clarifyRunId = await seedRun(h.db, taskId, 'clarify-1', 'awaiting_human')
    // The pending anchor row for the source agent (the row a clarify answer
    // submit would mint / the scheduler would reuse via pendingExisting).
    const anchorRunId = await seedRun(h.db, taskId, 'designer', 'pending')

    const r = await reapOrphanRuns(h.db)

    // Task-level reap only scans task.status='running' → 0 tasks flipped.
    expect(r.tasks).toBe(0)
    // DEFECT LOCK: the pending anchor row of a legally-paused task is counted
    // as an orphan and flipped. After fix: expect(r.runs).toBe(0).
    expect(r.runs).toBe(1)

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('awaiting_human') // task untouched (status filter is task-side only)
    expect(t?.errorSummary).toBeNull()

    // DEFECT LOCK: anchor row flipped pending → interrupted (mark-interrupted
    // allows any non-terminal source, shared/lifecycle.ts:111-113).
    // After fix this row must stay 'pending' — flip the expectation.
    expect(await runStatus(h.db, anchorRunId)).toBe('interrupted')

    // awaiting_human row is outside the query's status set — untouched today.
    // (node-kind-behavior.ts's 'leave-alone' only holds via this row-status
    // filter; it provides no task-status protection.)
    expect(await runStatus(h.db, clarifyRunId)).toBe('awaiting_human')
  })

  test('pending task (not yet started / resume window): its pending row is reaped and nobody re-kicks the task', async () => {
    const taskId = await seedTask(h.db, 'pending')
    const runId = await seedRun(h.db, taskId, 'a', 'pending')

    const r = await reapOrphanRuns(h.db)

    expect(r.tasks).toBe(0)
    // DEFECT LOCK: row of a not-yet-running task flipped to interrupted.
    // After fix: expect(r.runs).toBe(0) and the row stays 'pending'.
    expect(r.runs).toBe(1)
    expect(await runStatus(h.db, runId)).toBe('interrupted')

    // The task stays 'pending' forever after the boot pass — task-side reap
    // only flips running tasks, and no boot path re-kicks pending tasks
    // (stuckTaskDetector S4 alerts only; explicit non-goal to auto-resume).
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('pending')
  })

  // Contrast row of the (task-status × reap-outcome) matrix — running task +
  // running row both reaped to interrupted with daemon-restart — is the
  // intended P-4-07 behavior and is already locked verbatim by
  // orphans.test.ts ('flips running tasks + node_runs to interrupted with
  // daemon-restart message'). Not duplicated here per the no-duplication rule.
})
