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
//   - isTaskAutonomous：C 的 envelope 时刻压制判据——重读任务当前
//     workgroupConfigJson（中途 PATCH 可翻转，快照布尔会漏掉在途竞态）。
//   - A2 遣散原语 dismissOpenClarifyParksForAutonomous：open session →
//     canceled + 中介 park run canceled + assignment 经新边 requeue
//     （lw→dispatched 保 assignee；fc→open 清 assignee）；msg:*/null shard
//     不碰卡；已终态 session no-op；幂等；广播 node.status{canceled} +
//     wg.assignment.updated。
//   - C 源级锁（与 RFC-182 的 note 派生互为契约）：scheduler 在
//     createClarifySession 前 `await isTaskAutonomous(db, taskId)` 重读 +
//     autonomous 下 clarifyChannel 走 'stopped'（复用 RFC-123 runNode
//     clarify-forbidden 持久拒绝）；workgroupRunner 的 leader / worker 失败
//     分支带 CLARIFY_FORBIDDEN_PREFIX 重试。改任一侧即红。

import { beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import type { TaskWsMessage } from '@agent-workflow/shared'
import { CreateWorkgroupSchema, UpdateWorkgroupSchema } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifySessions, nodeRuns, tasks, workflows, workgroupAssignments } from '../src/db/schema'
import { mintNodeRun } from '../src/services/nodeRunMint'
import { createWorkgroup, getWorkgroup, updateWorkgroup } from '../src/services/workgroups'
import {
  canTransitionAssignment,
  dismissOpenClarifyParksForAutonomous,
  isTaskAutonomous,
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
    expect(groupInput().autonomous).toBeUndefined()
    const upd = UpdateWorkgroupSchema.parse({
      description: '',
      instructions: '',
      mode: 'leader_worker',
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 12,
      completionGate: true,
      members: [],
    })
    expect(upd.autonomous).toBeUndefined()
  })

  test('create 省略 → autonomous=true；显式 false 尊重', async () => {
    const created = await createWorkgroup(db, groupInput())
    expect(created.autonomous).toBe(true)
    const explicit = await createWorkgroup(
      db,
      groupInput({ name: 'manual-squad', autonomous: false }),
    )
    expect(explicit.autonomous).toBe(false)
  })

  test('update 省略 autonomous → 保留现值（false 不被翻 on / true 不被翻 off）', async () => {
    await createWorkgroup(db, groupInput({ name: 'g-false', autonomous: false }))
    await createWorkgroup(db, groupInput({ name: 'g-true', autonomous: true }))
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
    expect((await getWorkgroup(db, 'g-false'))?.autonomous).toBe(false)
    expect((await getWorkgroup(db, 'g-true'))?.autonomous).toBe(true)
    // 显式值仍然生效（对称 on/off）。
    await updateWorkgroup(db, 'g-false', { ...updBody(), autonomous: true })
    expect((await getWorkgroup(db, 'g-false'))?.autonomous).toBe(true)
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
// A2 遣散原语 + isTaskAutonomous（真 DB）
// ---------------------------------------------------------------------------

describe('RFC-181 A2/C — isTaskAutonomous + dismissOpenClarifyParksForAutonomous', () => {
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
    return { sessionId, clarifyRunId, assignmentId }
  }

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    taskId = await seedTask(JSON.stringify({ autonomous: true }))
  })

  test('isTaskAutonomous：true / false / 缺字段 / 坏 JSON / 无 config', async () => {
    expect(await isTaskAutonomous(db, taskId)).toBe(true)
    const off = await seedTask(JSON.stringify({ autonomous: false }))
    expect(await isTaskAutonomous(db, off)).toBe(false)
    const missing = await seedTask(JSON.stringify({}))
    expect(await isTaskAutonomous(db, missing)).toBe(false)
    const broken = await seedTask('{not-json')
    expect(await isTaskAutonomous(db, broken)).toBe(false)
    const none = await seedTask(null)
    expect(await isTaskAutonomous(db, none)).toBe(false)
    expect(await isTaskAutonomous(db, 'no-such-task')).toBe(false)
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
    expect(run?.errorMessage).toBe('wg-autonomous-dismissed')
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
  test('scheduler：createClarifySession 前重读 isTaskAutonomous；autonomous 下 channel=stopped', () => {
    const scheduler = SRC('services/scheduler.ts')
    expect(scheduler).toContain('await isTaskAutonomous(db, taskId)')
    expect(scheduler).toContain("directive: 'stopped'")
    // 重读必须发生在 createClarifySession 之前（同一 clarify 分支内）。
    const branch = scheduler.indexOf('await isTaskAutonomous(db, taskId)')
    const create = scheduler.indexOf('await createClarifySession(')
    expect(branch).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(branch)
    // 晚到压制修正必须持久化 + 广播（DB 行是 RFC-182 note 的派生依据）。
    expect(scheduler).toContain("reason: 'wg-clarify-suppressed-late'")
    expect(scheduler).toContain("failureCode: 'clarify-forbidden'")
  })

  test('workgroupRunner：leader/worker 均有 CLARIFY_FORBIDDEN_PREFIX 重试分支 + 三调用点传 clarifyEnabled', () => {
    const runner = SRC('services/workgroupRunner.ts')
    const hits = runner.split('CLARIFY_FORBIDDEN_PREFIX').length - 1
    expect(hits).toBeGreaterThanOrEqual(3) // import + leader 分支 + worker 分支
    expect(runner).toContain('Ask-back is OFF in this autonomous group')
    expect(
      runner.split('clarifyEnabled: resolveClarifyEnabled(config.autonomous ?? false)').length - 1,
    ).toBe(3) // leader / assignment / message-turn 三处调用点
  })
})
