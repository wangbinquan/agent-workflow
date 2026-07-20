// RFC-181 —— 工作组「全自动」硬化回归锁
// (design/RFC-181-workgroup-autonomous-hardening/{proposal,design}.md)
//
// Locks:
//   - D（设计门 P1）：create 缺省 autonomous=true 仅作用于 create 路径；
//     update/PUT 省略 autonomous ＝ 保留现值（双向：false 组不被翻 on、
//     true 组不被翻 off）。schema 共享字段层面**不得**挂默认（Create/Update
//     同源，schema 默认会让省略字段的老 PUT 静默翻转已有组）。
//   - 转移表 A2 requeue 新边：awaiting_human→dispatched / awaiting_human→open
//     合法；其余边不变。
//   - isTaskClarifySuppressed：C 的 envelope 时刻压制判据——重读任务当前
//     workgroupConfigJson（中途 PATCH 可翻转，快照布尔会漏掉在途竞态）。
//   - A2 遣散原语 dismissOpenClarifyParksForAutonomous：open session →
//     canceled + 中介 park run canceled + assignment 经新边 requeue
//     （lw→dispatched 保 assignee；fc→open 清 assignee）；msg:*/null shard
//     不碰卡；已终态 session no-op；幂等；广播 node.status{canceled} +
//     wg.assignment.updated。
//   - C 源级锁（与 RFC-182 的 note 派生互为契约）：scheduler 在
//     createClarifySession 前 `await isTaskClarifySuppressed(db, taskId)` 重读 +
//     autonomous 下 clarifyChannel 走 'stopped'（复用 RFC-123 runNode
//     clarify-forbidden 持久拒绝）；workgroupRunner 的 leader / worker 失败
//     分支带 CLARIFY_FORBIDDEN_PREFIX 重试。改任一侧即红。

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import type { TaskWsMessage } from '@agent-workflow/shared'
import {
  CreateWorkgroupSchema,
  UpdateWorkgroupSchema,
  WG_CLARIFY_BUDGET_DEFAULT,
} from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  clarifyRounds,
  clarifySessions,
  nodeRuns,
  tasks,
  workflows,
  workgroupAssignments,
} from '../src/db/schema'
import { mintNodeRun } from '../src/services/nodeRunMint'
import { createWorkgroup, getWorkgroup, updateWorkgroup } from '../src/services/workgroups'
import {
  canTransitionAssignment,
  dismissOpenClarifyParksForAutonomous,
  isTaskClarifySuppressed,
} from '../src/services/workgroupLifecycle'
import { TASK_CHANNEL, taskBroadcaster } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SRC = (p: string): string => readFileSync(resolve(import.meta.dir, '..', 'src', p), 'utf8')

function groupInput(
  overrides: Record<string, unknown> = {},
): ReturnType<typeof CreateWorkgroupSchema.parse> {
  return CreateWorkgroupSchema.parse({
    name: 'auto-squad',
    description: '',
    instructions: '',
    mode: 'leader_worker',
    leaderDisplayName: 'planner',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 12,
    completionGate: true,
    members: [
      { memberType: 'agent', agentName: 'planner-agent', displayName: 'planner', roleDesc: '' },
    ],
    ...overrides,
  })
}

describe('RFC-181 D — create 缺省全自动，update 省略保留现值', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('schema 层：Create/Update 共享字段均无默认（默认只住在 handler，设计门 P1）', () => {
    expect(groupInput().clarifyBudget).toBeUndefined()
    const upd = UpdateWorkgroupSchema.parse({
      description: '',
      instructions: '',
      mode: 'leader_worker',
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 12,
      completionGate: true,
      members: [],
    })
    expect(upd.clarifyBudget).toBeUndefined()
  })

  // RFC-207 — `autonomous` is gone; `clarifyBudget` inherits its optional-not-default
  // contract verbatim (the hazard is identical: a full-replace PUT that omits the
  // field must not silently rewrite the stored group).
  test('create 省略 → 默认预算；显式值尊重', async () => {
    const created = await createWorkgroup(db, groupInput())
    expect(created.clarifyBudget).toBe(WG_CLARIFY_BUDGET_DEFAULT)
    const explicit = await createWorkgroup(
      db,
      groupInput({ name: 'manual-squad', clarifyBudget: 0 }),
    )
    expect(explicit.clarifyBudget).toBe(0)
  })

  test('update 省略 clarifyBudget → 保留现值（不被默认值覆写）', async () => {
    await createWorkgroup(db, groupInput({ name: 'g-false', clarifyBudget: 0 }))
    await createWorkgroup(db, groupInput({ name: 'g-true', clarifyBudget: 9 }))
    const updBody = () =>
      UpdateWorkgroupSchema.parse({
        description: 'edited',
        instructions: '',
        mode: 'leader_worker',
        leaderDisplayName: 'planner',
        switches: { shareOutputs: true, directMessages: false, blackboard: false },
        maxRounds: 12,
        completionGate: true,
        members: [
          { memberType: 'agent', agentName: 'planner-agent', displayName: 'planner', roleDesc: '' },
        ],
      })
    await updateWorkgroup(db, 'g-false', updBody())
    await updateWorkgroup(db, 'g-true', updBody())
    expect((await getWorkgroup(db, 'g-false'))?.clarifyBudget).toBe(0)
    expect((await getWorkgroup(db, 'g-true'))?.clarifyBudget).toBe(9)
    // 显式值仍然生效。
    await updateWorkgroup(db, 'g-false', { ...updBody(), clarifyBudget: 5 })
    expect((await getWorkgroup(db, 'g-false'))?.clarifyBudget).toBe(5)
  })
})

describe('RFC-181 A2 — 转移表 requeue 新边', () => {
  test('awaiting_human→dispatched / open 合法；周边边不变', () => {
    expect(canTransitionAssignment('awaiting_human', 'dispatched')).toBe(true)
    expect(canTransitionAssignment('awaiting_human', 'open')).toBe(true)
    // 原有边保持
    expect(canTransitionAssignment('awaiting_human', 'running')).toBe(true)
    expect(canTransitionAssignment('awaiting_human', 'failed')).toBe(true)
    expect(canTransitionAssignment('awaiting_human', 'canceled')).toBe(true)
    // 终态仍封死（新边不得外溢）
    expect(canTransitionAssignment('done', 'dispatched')).toBe(false)
    expect(canTransitionAssignment('canceled', 'open')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// A2 遣散原语 + isTaskClarifySuppressed（真 DB）
// ---------------------------------------------------------------------------

describe('RFC-181 A2/C — isTaskClarifySuppressed + dismissOpenClarifyParksForAutonomous', () => {
  let db: DbClient
  let taskId: string

  async function seedTask(configJson: string | null): Promise<string> {
    const id = ulid()
    await db
      .insert(workflows)
      .values({ id: ulid(), name: `wf-${id}`, definition: '{}', builtin: true })
    const wf = (await db.select().from(workflows).limit(1))[0]
    await db.insert(tasks).values({
      id,
      name: 'rfc181-task',
      workflowId: wf?.id ?? ulid(),
      workflowSnapshot: '{}',
      repoPath: '/tmp/never-read',
      worktreePath: '/tmp/never-read-wt',
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      status: 'awaiting_human',
      inputs: '{}',
      startedAt: Date.now(),
      workgroupId: 'wg-rfc181',
      workgroupConfigJson: configJson,
    })
    return id
  }

  interface SeededPark {
    sessionId: string
    clarifyRunId: string
    assignmentId: string | null
  }

  async function seedClarifyPark(opts: {
    shard: string | null
    withAssignment?: boolean
  }): Promise<SeededPark> {
    let assignmentId: string | null = null
    if (opts.withAssignment === true && opts.shard !== null) {
      assignmentId = opts.shard
      await db.insert(workgroupAssignments).values({
        id: opts.shard,
        taskId,
        round: 1,
        source: 'leader',
        assigneeMemberId: 'm-coder',
        title: 'blocked-on-question',
        briefMd: 'ask first',
        status: 'awaiting_human',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    }
    const clarifyRunId = await mintNodeRun(db, {
      taskId,
      nodeId: '__wg_clarify__',
      status: 'awaiting_human',
      cause: 'clarify-park',
      overrides: { shardKey: opts.shard, startedAt: Date.now() },
    })
    const sessionId = ulid()
    await db.insert(clarifySessions).values({
      id: sessionId,
      taskId,
      sourceAgentNodeId: '__wg_member__',
      sourceAgentNodeRunId: ulid(),
      sourceShardKey: opts.shard,
      clarifyNodeId: '__wg_clarify__',
      clarifyNodeRunId: clarifyRunId,
      iterationIndex: 0,
      questionsJson: JSON.stringify([{ id: 'q1', question: '哪个口径？' }]),
      status: 'awaiting_human',
      createdAt: Date.now(),
    })
    // RFC-058 双写的权威轮行（实现门 P1-②：/api/clarify、草稿、seal 都读它——
    // 只取消 legacy session 行会让问题仍可答、陈旧答案仍可 seal+mint 续跑）。
    await db.insert(clarifyRounds).values({
      id: ulid(),
      taskId,
      kind: 'self',
      askingNodeId: '__wg_member__',
      // FK → node_runs.id：复用中介 run 行（asking run 的真实行对本锁无关紧要）。
      askingNodeRunId: clarifyRunId,
      askingShardKey: opts.shard,
      intermediaryNodeId: '__wg_clarify__',
      intermediaryNodeRunId: clarifyRunId,
      loopIter: 0,
      iteration: 0,
      questionsJson: JSON.stringify([{ id: 'q1', question: '哪个口径？' }]),
      status: 'awaiting_human',
      createdAt: Date.now(),
    })
    return { sessionId, clarifyRunId, assignmentId }
  }

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    taskId = await seedTask(JSON.stringify({ members: [{ memberType: 'agent' }] }))
  })

  // RFC-207 — the oracle now reads the frozen ROSTER instead of a switch. Every
  // unreadable case still resolves to "not suppressed": an anomaly should let a
  // question reach a human, not silently swallow it.
  test('isTaskClarifySuppressed：无人工 / 有人工 / 缺字段 / 坏 JSON / 无 config', async () => {
    expect(await isTaskClarifySuppressed(db, taskId)).toBe(true)
    const withHuman = await seedTask(
      JSON.stringify({ members: [{ memberType: 'agent' }, { memberType: 'human' }] }),
    )
    expect(await isTaskClarifySuppressed(db, withHuman)).toBe(false)
    const missing = await seedTask(JSON.stringify({}))
    expect(await isTaskClarifySuppressed(db, missing)).toBe(false)
    const broken = await seedTask('{not-json')
    expect(await isTaskClarifySuppressed(db, broken)).toBe(false)
    const none = await seedTask(null)
    expect(await isTaskClarifySuppressed(db, none)).toBe(false)
    expect(await isTaskClarifySuppressed(db, 'no-such-task')).toBe(false)
  })

  test('lw：session 双状态 canceled + 中介 run canceled + 卡 awaiting_human→dispatched（保 assignee、清 nodeRunId）+ 双帧广播', async () => {
    const park = await seedClarifyPark({ shard: ulid(), withAssignment: true })
    const frames: TaskWsMessage[] = []
    const unsub = taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => frames.push(m))
    const res = await dismissOpenClarifyParksForAutonomous(db, taskId, 'leader_worker')
    unsub()
    expect(res.dismissedSessions).toBe(1)
    expect(res.canceledParkRuns.map((r) => r.nodeRunId)).toEqual([park.clarifyRunId])
    expect(res.requeuedAssignments).toEqual([{ id: park.assignmentId ?? '', to: 'dispatched' }])

    const session = (
      await db.select().from(clarifySessions).where(eq(clarifySessions.id, park.sessionId))
    )[0]
    expect(session?.status).toBe('canceled')
    const run = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, park.clarifyRunId)))[0]
    expect(run?.status).toBe('canceled')
    expect(run?.errorMessage).toBe('wg-clarify-disabled')
    // 实现门 P1-②：权威轮行同事务 canceled（seal/答案路径读的是 rounds）。
    const round = (
      await db
        .select()
        .from(clarifyRounds)
        .where(eq(clarifyRounds.intermediaryNodeRunId, park.clarifyRunId))
    )[0]
    expect(round?.status).toBe('canceled')
    const card = (
      await db
        .select()
        .from(workgroupAssignments)
        .where(eq(workgroupAssignments.id, park.assignmentId ?? ''))
    )[0]
    expect(card?.status).toBe('dispatched')
    expect(card?.assigneeMemberId).toBe('m-coder')
    expect(card?.nodeRunId).toBeNull()
    expect(frames.some((f) => f.type === 'node.status' && f.status === 'canceled')).toBe(true)
    expect(
      frames.some((f) => f.type === 'wg.assignment.updated' && f.status === 'dispatched'),
    ).toBe(true)
  })

  test('fc：卡回收 awaiting_human→open 且清 assignee', async () => {
    const park = await seedClarifyPark({ shard: ulid(), withAssignment: true })
    const res = await dismissOpenClarifyParksForAutonomous(db, taskId, 'free_collab')
    expect(res.requeuedAssignments).toEqual([{ id: park.assignmentId ?? '', to: 'open' }])
    const card = (
      await db
        .select()
        .from(workgroupAssignments)
        .where(eq(workgroupAssignments.id, park.assignmentId ?? ''))
    )[0]
    expect(card?.status).toBe('open')
    expect(card?.assigneeMemberId).toBeNull()
  })

  test('msg:* / null shard：只遣散 session+run，不碰任何卡', async () => {
    await seedClarifyPark({ shard: `msg:m-coder:${ulid()}` })
    await seedClarifyPark({ shard: null })
    const res = await dismissOpenClarifyParksForAutonomous(db, taskId, 'leader_worker')
    expect(res.dismissedSessions).toBe(2)
    expect(res.requeuedAssignments).toEqual([])
  })

  test('已 answered / canceled 的 session no-op；重复调用幂等（陈旧答案回流的根被掐死）', async () => {
    const park = await seedClarifyPark({ shard: ulid(), withAssignment: true })
    await db
      .update(clarifySessions)
      .set({ status: 'answered' })
      .where(eq(clarifySessions.id, park.sessionId))
    const res = await dismissOpenClarifyParksForAutonomous(db, taskId, 'leader_worker')
    expect(res.dismissedSessions).toBe(0)
    expect(res.requeuedAssignments).toEqual([])
    // 再来一个真 park，遣散后二次调用幂等 no-op。
    await seedClarifyPark({ shard: ulid(), withAssignment: true })
    expect(
      (await dismissOpenClarifyParksForAutonomous(db, taskId, 'leader_worker')).dismissedSessions,
    ).toBe(1)
    expect(
      (await dismissOpenClarifyParksForAutonomous(db, taskId, 'leader_worker')).dismissedSessions,
    ).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// C 源级契约锁（与 RFC-182 note 派生互链——改前缀/撤重读/撤 stopped 即红）
// ---------------------------------------------------------------------------

describe('RFC-181 C — 源级契约锁', () => {
  test('runner：runNode 收尾期前的 envelope 时刻判定器拒绝（实现门 P1-①/P2 双向实时）', () => {
    const runner = SRC('services/runner.ts')
    // 判定器分支必须先于合法 clarify 的 clarifyResult 赋值（终态持久化之前分类）。
    expect(runner).toContain('await opts.clarifySuppressed?.()')
    const suppress = runner.indexOf('await opts.clarifySuppressed?.()')
    const accept = runner.indexOf('clarifyResult = {')
    expect(suppress).toBeGreaterThan(-1)
    expect(accept).toBeGreaterThan(suppress)
    // 结构化闭合列（RFC-182 note 派生依据）。
    expect(runner).toContain("failureCode = 'clarify-forbidden'")
  })

  test('scheduler：判定器注入 + 建 session 前后双重重读 + 事后补偿遣散（实现门 P1-③）', () => {
    const scheduler = SRC('services/scheduler.ts')
    // RFC-207 §3.4a — the callback must keep the dispatch-time floor in front of the
    // live read: a turn that carried no invite may not ask just because the roster
    // gained a human while it ran.
    expect(scheduler).toContain('req.clarifyEnabled === false')
    expect(scheduler).toContain('isTaskClarifySuppressed(db, taskId)')
    const preCheck = scheduler.indexOf('await isTaskClarifySuppressed(db, taskId)')
    const create = scheduler.indexOf('await createClarifySession(')
    const compensate = scheduler.indexOf('await dismissOpenClarifyParksForAutonomous(db, taskId)')
    expect(preCheck).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(preCheck)
    // 建 session 之后必须再查一次并以 A2 原语补偿（关死 check→insert TOCTOU）。
    expect(compensate).toBeGreaterThan(create)
    // 晚到压制修正必须持久化（allowTerminal 逃生门——行已 done）+ 结构化列。
    expect(scheduler).toContain('allowTerminal: true')
    expect(scheduler).toContain("reason: 'wg-clarify-suppressed-late'")
    // ≥2：DB 列（setNodeRunStatus extra）+ hook 返回体（引擎结构化路由的输入
    // ——缺后者曾迫使引擎按 errorMessage 前缀匹配，调度架构审视 2026-07-14）。
    expect(scheduler.split("failureCode: 'clarify-forbidden'").length - 1).toBeGreaterThanOrEqual(2)
  })

  test('workgroupRunner：leader/worker 均有 clarify-forbidden 重试分支（结构化路由）+ 三调用点传 clarifyEnabled', () => {
    const runner = SRC('services/workgroupRunner.ts')
    // 调度架构审视 2026-07-14：软拒分支改按结构化 failureCode 路由（leader +
    // worker 各一处）。RFC-145 棘轮：errorMessage 是人读面包屑，绝不再当机器键
    // —— startsWith(CLARIFY_FORBIDDEN_PREFIX) 回潮即红。
    const hits = runner.split("result.failureCode === 'clarify-forbidden'").length - 1
    expect(hits).toBeGreaterThanOrEqual(2) // leader 分支 + worker 分支
    expect(runner).not.toContain('startsWith(CLARIFY_FORBIDDEN_PREFIX)')
    expect(runner).toContain('Ask-back is OFF')
    // RFC-207 §3.7.2 — each of the three turns resolves the permission ONCE and
    // feeds it to BOTH the protocol renderer and `clarifyEnabled`. Counting the
    // `clarifyEnabled:` sites keeps that wiring from silently losing one.
    expect(runner.split('clarifyEnabled: ').length - 1).toBe(3)
  })

  test('route：A2 对 dynamic_workflow 免疫 + 遣散后新鲜状态复读 kick（实现门 P2）', () => {
    const route = SRC('routes/workgroupTasks.ts')
    expect(route).toContain("config.mode !== 'dynamic_workflow'")
    expect(route).toContain('const kickIfParked')
    expect(route).toContain('lateKick.unref?.()')
  })
})
