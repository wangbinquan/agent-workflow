import { rimrafDir } from './helpers/cleanup'
// design/scheduler-audit-2026-06-10.md §⑥ 缺口5 (orphans 收割与任务状态) — 半锁半修。
//
// RFC-097 之后本缺口拆成两半，本文件相应一半锁缺陷、一半锁新语义：
//
//   1.【仍是 CURRENT-BEHAVIOR LOCK】`reapOrphanRuns` 的 node_runs 查询是全库
//      `status IN ('running','pending')`，不 join / 不过滤所属任务的状态
//      （orphans.ts）。合法暂停中任务（task=awaiting_human / awaiting_review）
//      名下的 `pending` 锚点行仍会被翻成 `interrupted`——这些行不是孤儿，它们是
//      "用户答完 clarify / review 后调度器要复用的幂等派发锚点"（runOneNode 的
//      pendingExisting 复用）。packages/shared/src/node-kind-behavior.ts:72-75
//      自述 leave-alone 仅靠"查询只选 running/pending"隐式保证——该保证只按
//      【行状态】成立，按【任务状态】不成立。该半边与 S-1 的修法强耦合，留待
//      WP-1/WP-2；修复时按断言旁 FLIP 注释翻转（pending 锚点行保持 'pending'、
//      ReapResult.runs 归零）。
//
//   2.【RFC-097 已修，锁新语义】task=pending 的任务侧不对称已关闭
//      （design/RFC-097-task-status-cas/design.md §3 崩溃窗口补偿）：boot 收割
//      现在把 pending 任务一并翻 interrupted（errorSummary='daemon-restart'）。
//      论证：boot 收割在 HTTP listen 之前运行（src/cli/start.ts 步骤 5b），彼刻
//      一切 pending 任务必为孤儿——startTask 是 insert 后同进程立即 kick，而
//      resume/retry 的 pending CAS 前移后「回滚中途崩溃」恰好留下这种无人认领的
//      pending 残留。收割后 resumeTask 可从 interrupted 恢复（完整恢复闭环见
//      rfc097-pending-orphan-reap.test.ts）。

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
  return { db, tmp, cleanup: () => rimrafDir(tmp) }
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

describe('gap5 — reapOrphanRuns vs task status（锚点行缺陷锁 + RFC-097 pending 任务收割新语义）', () => {
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

    // Task-level reap scans task.status ∈ {'running','pending'} (RFC-097) →
    // awaiting_human is outside the set, 0 tasks flipped.
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

  test('pending task (crashed resume residue): RFC-097 reaps the task itself to interrupted(daemon-restart) so resume can recover', async () => {
    const taskId = await seedTask(h.db, 'pending')
    const runId = await seedRun(h.db, taskId, 'a', 'pending')

    const r = await reapOrphanRuns(h.db)

    // RFC-097 (design §3): a pending task at boot time is by construction an
    // orphan (boot reap runs before HTTP listen; startTask kicks in-process)
    // — the old "stays pending forever, S4 alerts only" asymmetry is closed.
    expect(r.tasks).toBe(1)
    expect(r.runs).toBe(1)
    expect(await runStatus(h.db, runId)).toBe('interrupted')

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('interrupted')
    expect(t?.errorSummary).toBe('daemon-restart')
    // interrupted ∈ resumeTask's recoverable set — the user-visible escape
    // hatch the pending wedge never had. Full recovery loop is exercised in
    // rfc097-pending-orphan-reap.test.ts (no duplication here).
  })

  // Contrast row of the (task-status × reap-outcome) matrix — running task +
  // running row both reaped to interrupted with daemon-restart — is the
  // intended P-4-07 behavior and is already locked verbatim by
  // orphans.test.ts ('flips running tasks + node_runs to interrupted with
  // daemon-restart message'). Not duplicated here per the no-duplication rule.
})
