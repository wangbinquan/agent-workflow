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
//     createClarifyRound 前 `await isTaskClarifySuppressed(db, taskId)` 重读 +
//     autonomous 下 clarifyChannel 走 'stopped'（复用 RFC-123 runNode
//     clarify-forbidden 持久拒绝）；workgroupRunner 的 leader / worker 失败
//     分支带 CLARIFY_FORBIDDEN_PREFIX 重试。改任一侧即红。

import { beforeEach, describe, expect, test } from 'bun:test'
import { insertLegacySelfClarify, insertClarifyRoundRaw } from './clarify-fixtures'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import type { TaskWsMessage } from '@agent-workflow/shared'
import { buildBatchShardKey } from '@agent-workflow/shared'
import {
  CreateWorkgroupSchema,
  WG_CLARIFY_BUDGET_DEFAULT,
  WorkgroupDraftSnapshotSchema,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import {
  agents,
  clarifyRounds,
  nodeRuns,
  tasks,
  workflows,
  workgroupAssignments,
} from '../src/db/schema'
import { mintNodeRun } from '../src/services/nodeRunMint'
import {
  createWorkgroup,
  getWorkgroupById,
  listWorkgroups,
  saveWorkgroup,
  workgroupDraftSnapshotOf,
} from '../src/services/workgroups'
import type { WorkgroupAssignmentStatus } from '@agent-workflow/shared'
import { WORKGROUP_TURN_ASSIGNMENT_TRANSITIONS } from '@/modules/resource-catalog/application/workgroups/workgroupTurnsDriver'

// RFC-359 W4-D19c-tail：转移表改指生产那份（与合一前逐字相同）。
function canTransitionAssignment(
  from: WorkgroupAssignmentStatus,
  to: WorkgroupAssignmentStatus,
): boolean {
  return WORKGROUP_TURN_ASSIGNMENT_TRANSITIONS[from].includes(to)
}

// RFC-359 W4-D19c-tail：这两条判据改指两个 provider 共用的端口
// （`CollaborationRuntimeMechanics`）的 SQLite 实现——合一前 legacy workgroup 里另有一份同名副本，
// 本文件是它最后的引用方。下面两个薄壳只把端口的入参对象翻回旧的位置参数形状，断言逐条原样保留。
import { createCollaborationRuntimeMechanics } from '../src/modules/collaboration/infrastructure/collaborationRuntimeMechanics'

const isTaskClarifySuppressed = (
  db: ProviderNeutralDatabase,
  taskId: string,
  nodeId?: string,
  shardKey?: string | null,
): Promise<boolean> =>
  createCollaborationRuntimeMechanics(db).isTaskClarifySuppressed({
    taskId,
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(shardKey === undefined ? {} : { shardKey }),
  })

const dismissOpenClarifyParksForAutonomous = (
  db: ProviderNeutralDatabase,
  taskId: string,
  mode: string,
): ReturnType<
  ReturnType<typeof createCollaborationRuntimeMechanics>['dismissOpenClarifyParksForAutonomous']
> =>
  createCollaborationRuntimeMechanics(db).dismissOpenClarifyParksForAutonomous({
    taskId,
    mode,
  })
import { TASK_CHANNEL, taskBroadcaster } from '../src/ws/broadcaster'

const SRC = (p: string): string => readFileSync(resolve(import.meta.dir, '..', 'src', p), 'utf8')
const PLANNER_AGENT_ID = '01HPLANNERAGENT000000000000'

async function getWorkgroupForTest(db: ProviderNeutralDatabase, name: string) {
  const row = (await listWorkgroups(db)).find((candidate) => candidate.name === name)
  return row === undefined ? null : getWorkgroupById(db, row.id)
}

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
      {
        memberType: 'agent',
        agentId: PLANNER_AGENT_ID,
        displayName: 'planner',
        roleDesc: '',
      },
    ],
    ...overrides,
  })
}

describeEachProvider(
  'RFC-181 D + RFC-225 — create defaults and complete save snapshots',
  (harness) => {
    let db: ProviderNeutralDatabase
    beforeEach(async () => {
      db = harness.db
      await db.insert(agents).values({
        id: PLANNER_AGENT_ID,
        name: 'planner-agent',
        description: '',
        outputs: '[]',
      })
    })

    test('create may omit the budget, while a versioned editable snapshot is complete', () => {
      expect(groupInput().clarifyBudget).toBeUndefined()
      const incomplete = WorkgroupDraftSnapshotSchema.safeParse({
        name: 'g',
        description: '',
        instructions: '',
        mode: 'leader_worker',
        switches: { shareOutputs: true, directMessages: false, blackboard: false },
        maxRounds: 12,
        completionGate: true,
        members: [],
      })
      expect(incomplete.success).toBe(false)
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

    test('autosave derives the complete snapshot from the current row, so unrelated edits preserve budget', async () => {
      await createWorkgroup(db, groupInput({ name: 'g-false', clarifyBudget: 0 }))
      await createWorkgroup(db, groupInput({ name: 'g-true', clarifyBudget: 9 }))
      const saveDescription = async (name: string, description: string, clarifyBudget?: number) => {
        const current = await getWorkgroupForTest(db, name)
        if (current === null) throw new Error(`missing ${name}`)
        await saveWorkgroup(
          db,
          current.id,
          {
            expectedVersion: current.version,
            clientMutationId: ulid(),
            snapshot: {
              ...workgroupDraftSnapshotOf(current),
              description,
              ...(clarifyBudget === undefined ? {} : { clarifyBudget }),
            },
          },
          { kind: 'system', reason: 'rfc181 test' },
        )
      }
      await saveDescription('g-false', 'edited')
      await saveDescription('g-true', 'edited')
      expect((await getWorkgroupForTest(db, 'g-false'))?.clarifyBudget).toBe(0)
      expect((await getWorkgroupForTest(db, 'g-true'))?.clarifyBudget).toBe(9)
      // 显式值仍然生效。
      await saveDescription('g-false', 'edited again', 5)
      expect((await getWorkgroupForTest(db, 'g-false'))?.clarifyBudget).toBe(5)
    })
  },
)

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

describeEachProvider(
  'RFC-181 A2/C — isTaskClarifySuppressed + dismissOpenClarifyParksForAutonomous',
  (harness) => {
    let db: ProviderNeutralDatabase
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
      // RFC-058 双写的权威轮行（实现门 P1-②：/api/clarify、草稿、seal 都读它——
      // 只取消 legacy session 行会让问题仍可答、陈旧答案仍可 seal+mint 续跑）。
      await insertClarifyRoundRaw(db, {
        id: sessionId,
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
      db = harness.db
      taskId = await seedTask(JSON.stringify({ members: [{ memberType: 'agent' }] }))
    })

    // RFC-207 — the oracle now reads the frozen ROSTER instead of a switch. Every
    // unreadable case still resolves to "not suppressed": an anomaly should let a
    // question reach a human, not silently swallow it.
    // RFC-207 §3.6 — the ask-back BUDGET, i.e. the answer to "you added a human, so
    // what stops it asking forever?". Counted per asker from clarify_sessions.
    describe('反问预算', () => {
      const HUMAN = JSON.stringify({
        members: [{ memberType: 'agent' }, { memberType: 'human' }],
        clarifyBudget: 2,
      })
      async function ask(taskId: string, nodeId: string, shard: string | null): Promise<void> {
        await insertLegacySelfClarify(db, {
          id: ulid(),
          taskId,
          sourceAgentNodeId: nodeId,
          sourceAgentNodeRunId: ulid(),
          sourceShardKey: shard,
          clarifyNodeId: '__wg_clarify__',
          clarifyNodeRunId: ulid(),
          iterationIndex: 0,
          questionsJson: '[]',
          status: 'awaiting_human',
          createdAt: Date.now(),
        })
      }

      test('用满即压制；leader 与每张派单各自独立计数', async () => {
        const t = await seedTask(HUMAN)
        const leader = { nodeId: '__wg_leader__', shard: null }
        expect(await isTaskClarifySuppressed(db, t, leader.nodeId, leader.shard)).toBe(false)
        await ask(t, leader.nodeId, leader.shard)
        await ask(t, leader.nodeId, leader.shard)
        expect(await isTaskClarifySuppressed(db, t, leader.nodeId, leader.shard)).toBe(true)
        // A separate assignment has its own budget — finishing one card and starting
        // the next must not inherit the previous card's spend.
        expect(await isTaskClarifySuppressed(db, t, '__wg_member__', 'asg-1')).toBe(false)
      })

      test('消息轮按成员归一化：换一条消息不重置预算', async () => {
        const t = await seedTask(HUMAN)
        await ask(t, '__wg_member__', 'msg:m-coder:01AAA')
        await ask(t, '__wg_member__', 'msg:m-coder:01BBB')
        // Keying on the raw shard would mint a fresh asker per message and let a
        // member ask forever; `mem:<memberId>` is what closes that bypass.
        expect(await isTaskClarifySuppressed(db, t, '__wg_member__', 'msg:m-coder:01CCC')).toBe(
          true,
        )
        expect(await isTaskClarifySuppressed(db, t, '__wg_member__', 'msg:m-other:01AAA')).toBe(
          false,
        )
      })

      test('预算 0 = 首问即压制；无人工成员时预算无关', async () => {
        const zero = await seedTask(
          JSON.stringify({ members: [{ memberType: 'human' }], clarifyBudget: 0 }),
        )
        expect(await isTaskClarifySuppressed(db, zero, '__wg_leader__', null)).toBe(true)
        const noHuman = await seedTask(JSON.stringify({ members: [{ memberType: 'agent' }] }))
        expect(await isTaskClarifySuppressed(db, noHuman, '__wg_leader__', null)).toBe(true)
      })

      test('旧快照缺 clarifyBudget → 回退默认值而非解析失败', async () => {
        const legacy = await seedTask(JSON.stringify({ members: [{ memberType: 'human' }] }))
        for (let i = 0; i < WG_CLARIFY_BUDGET_DEFAULT; i++) await ask(legacy, '__wg_leader__', null)
        expect(await isTaskClarifySuppressed(db, legacy, '__wg_leader__', null)).toBe(true)
      })
    })

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

    test('fc 批 run 的 park：batch: shardKey 遣散时整组卡 awaiting_human→open（清 assignee/nodeRunId）', async () => {
      // RFC-215 §9 / 设计门 ①P1-3=②F2 的修复点直接回归（实现门 C-3(b) 补交——
      // design §10-14 承诺）：v1 的单卡等值匹配对 `batch:` 键恒 0 行 ⇒ 遣散只取消
      // park run、整批卡永滞留 awaiting_human。parseBatchShardKey 解出整组卡 id
      // 后 fc 回 open（清 assignee 让其他成员可接手）。
      const cardA = `A${ulid()}`
      const cardB = `B${ulid()}`
      for (const id of [cardA, cardB]) {
        await db.insert(workgroupAssignments).values({
          id,
          taskId,
          round: 1,
          source: 'self_claim',
          assigneeMemberId: 'm-coder',
          title: `batched-${id}`,
          briefMd: 'ask first',
          status: 'awaiting_human',
          createdAt: Date.now(),
        })
      }
      const park = await seedClarifyPark({ shard: buildBatchShardKey('m-coder', [cardA, cardB]) })
      const res = await dismissOpenClarifyParksForAutonomous(db, taskId, 'free_collab')
      expect(res.dismissedSessions).toBe(1)
      expect(res.canceledParkRuns.map((r) => r.nodeRunId)).toEqual([park.clarifyRunId])
      expect(new Set(res.requeuedAssignments.map((r) => `${r.id}:${r.to}`))).toEqual(
        new Set([`${cardA}:open`, `${cardB}:open`]),
      )
      for (const id of [cardA, cardB]) {
        const card = (
          await db.select().from(workgroupAssignments).where(eq(workgroupAssignments.id, id))
        )[0]
        expect(card?.status).toBe('open')
        expect(card?.assigneeMemberId).toBeNull()
        expect(card?.nodeRunId).toBeNull()
      }
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
        await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, park.sessionId))
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
        .update(clarifyRounds)
        .set({ status: 'answered' })
        .where(eq(clarifyRounds.id, park.sessionId))
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
  },
)

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
    const scheduler = SRC('modules/task-execution/composition/nodeMechanics.ts')
    // RFC-207 §3.4a — the callback must keep the dispatch-time floor in front of the
    // live read: a turn that carried no invite may not ask just because the roster
    // gained a human while it ran.
    expect(scheduler).toContain('req.clarifyEnabled === false')
    expect(scheduler).toContain('collaboration.isTaskClarifySuppressed({')
    const preCheck = scheduler.indexOf('await collaboration.isTaskClarifySuppressed({')
    const create = scheduler.indexOf('await collaboration.openAgentClarify(')
    const compensate = scheduler.indexOf(
      'await collaboration.dismissOpenClarifyParksForAutonomous({',
    )
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

  test('回合驱动：clarify-forbidden 唯一一处结构化路由 + 三份角色文案 + clarifyEnabled 解析一次', () => {
    // 调度架构审视 2026-07-14：软拒分支改按结构化 failureCode 路由。RFC-145 棘轮：
    // errorMessage 是人读面包屑，绝不再当机器键 —— startsWith(CLARIFY_FORBIDDEN_PREFIX) 回潮即红。
    // RFC-217 T3 —— 软拒分支收编进回合骨架（唯一一处结构化路由），各角色只提供文案。
    // RFC-359 W4-D19c：骨架与三份文案合一进中立驱动，两个 provider 同一条；锚点随之全部指它。
    const driver = SRC('modules/resource-catalog/application/workgroups/workgroupTurnsDriver.ts')
    expect(driver.split("result.failureCode === 'clarify-forbidden'").length - 1).toBe(1)
    expect(driver).not.toContain('startsWith(CLARIFY_FORBIDDEN_PREFIX)')
    // 三份角色化 notice（领队 / 派单 / 批量）都在，且都由骨架的同一个 spec 槽位喂进去。
    expect(driver).toContain('CLARIFY_SUPPRESSED_LEADER')
    expect(driver).toContain('CLARIFY_SUPPRESSED_ASSIGNMENT')
    expect(driver).toContain('CLARIFY_SUPPRESSED_BATCH')
    expect(driver.split('Ask-back is OFF').length - 1).toBe(1)
    // RFC-207 §3.7.2 resolve-once：clarifyEnabled 布线唯一存在于骨架（解析一次、
    // 双喂 renderer + clarifyEnabled）；宿主调用点也只有骨架那一处。
    expect(driver.split('clarifyEnabled: ').length - 1).toBe(1)
    expect(driver.split('spec.host.runHost(').length - 1).toBe(1)
  })

  test('route：A2 对 dynamic_workflow 免疫 + 遣散后新鲜状态复读 kick（实现门 P2）', () => {
    // RFC-217 T4：业务体不在 routes（routes 纯 transport）。RFC-359 W4-D19b 起两个 provider
    // 共用同一份任务房，这段就住在中立房间的命令面里。
    const route = SRC('modules/resource-catalog/infrastructure/workgroupTaskRoomCommands.ts')
    expect(route).toContain("loaded.config.mode !== 'dynamic_workflow'")
    // 遣散最后一个人类成员后的补跑：立刻一次 + 2.5s 后一次，接住慢一拍才提交的 park。
    expect(route).toContain('const continueIfStillParked')
    expect(route).toContain('late.unref?.()')
  })
})
