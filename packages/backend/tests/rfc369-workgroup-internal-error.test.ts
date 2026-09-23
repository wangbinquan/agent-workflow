// RFC-369 G3 / AC-5 —— 工作组一轮在 host 执行中遇到**内部错误**时按这一轮失败收场（design §4.4）。
//
// 为什么这条测试存在：内部错误（铸 run / 开跑提交 / 反问判定读 / runHost 在 assembly 前抛错）此前被
// 驱动 catch 成 lost，这一轮作废；已铸 / 已采纳却没执行完的 run 留在 pending，下一圈被当作崩溃恢复重新
// 采纳，内存里的协议 / 瞬态预算重新给一份——内部错误反复出现时重试次数没有上限（CI 上一次成员调用了 6 次，
// 上限 4 次）。本文件在四个注入点 + 采纳变体 + 领队上锁住：
//   - 这一轮按失败收场：出现与 host 失败同形的系统消息，卡片按**实际**状态落 failed；
//   - 孤儿 run（仍 pending）被终结为 failed，且不再被执行；
//   - free_collab 下认领中的 open 卡落 failed 前 bump 尝试次数：稳定的内部错误按卡预算收敛，不无界循环；
//   - 领队内部错误：房间补一条内部错误消息、任务失败。
// 注入手段：包一层 `createWorkgroupTurnsPersistence`（与 rfc185-leader-fanout 同一接缝）。

import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  buildBatchShardKey,
  DEFAULT_PROTOCOL_RETRY_BUDGET,
  type WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nodeRuns,
  tasks,
  workflows,
  workgroupAssignments,
  workgroupMemberCursors,
  workgroupMessages,
} from '@/db/schema'
import { composeWorkgroupTaskRoomClarifyParticipantFactory } from '@/modules/collaboration/composition/workgroupTaskRoomClarify'
import { createWorkgroupClarifyAskGate } from '@/modules/collaboration/public/participants'
import {
  createWorkgroupTurnsOperations,
  type WorkgroupTurnLedgerOperation,
  type WorkgroupTurnsPersistencePort,
} from '@/modules/resource-catalog/application/workgroups/workgroupTurnsDriver'
import { createWorkgroupTurnsPersistence } from '@/modules/resource-catalog/infrastructure/workgroupTurnsOperations'
import { composeWorkgroupHostLedgerParticipantFactory } from '@/modules/task-execution/composition/workgroupHostLedger'
import {
  WORKGROUP_TURN_LEADER_NODE_ID,
  WORKGROUP_TURN_MEMBER_NODE_ID,
  type WorkgroupTurnHostRequest,
  type WorkgroupTurnHostResult,
  type WorkgroupTurnLogger,
  type WorkgroupTurnsOutcome,
} from '@/modules/task-execution/public/commands'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { createAgent } from '@/services/agent'
import { describeEachProvider } from './helpers/eachProvider'

const log: WorkgroupTurnLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => log,
}

interface Injection {
  /** 返回 true 即在这笔提交**之前**抛出（整笔回滚，与生产里 40001 重放耗尽同一形态）。 */
  commit?: (operations: readonly WorkgroupTurnLedgerOperation[]) => boolean
  clarifyAllowed?: () => boolean
}

function injectedDrive(input: {
  db: ProviderNeutralDatabase
  taskId: string
  injection: Injection
  runHost: (request: WorkgroupTurnHostRequest) => Promise<WorkgroupTurnHostResult>
  broadcasts?: Array<[string, string]>
}): Promise<WorkgroupTurnsOutcome> {
  const actual = createWorkgroupTurnsPersistence({
    db: input.db,
    hostLedgerFactory: composeWorkgroupHostLedgerParticipantFactory({
      collaboration: composeWorkgroupTaskRoomClarifyParticipantFactory(),
    }),
    clarifyAskGate: createWorkgroupClarifyAskGate(input.db),
  })
  const persistence: WorkgroupTurnsPersistencePort = {
    ...actual,
    async commit(commitInput) {
      if (input.injection.commit?.(commitInput.operations) === true) {
        throw new Error('injected ledger failure')
      }
      return await actual.commit(commitInput)
    },
    async clarifyAllowed(clarifyInput) {
      if (input.injection.clarifyAllowed?.() === true) {
        throw new Error('injected clarify read failure')
      }
      return await actual.clarifyAllowed(clarifyInput)
    },
  }
  return createWorkgroupTurnsOperations(persistence).drive({
    taskId: input.taskId,
    log,
    host: {
      runHost: input.runHost,
      broadcastNodeStatus: (runId, _nodeId, status) => input.broadcasts?.push([runId, status]),
    },
  })
}

const mintsMember = (
  operations: readonly WorkgroupTurnLedgerOperation[],
  cause?: string,
): boolean =>
  operations.some(
    (operation) =>
      operation.kind === 'mint-host-run' &&
      operation.nodeId === WORKGROUP_TURN_MEMBER_NODE_ID &&
      (cause === undefined || operation.cause === cause),
  )

async function rowsOf(db: ProviderNeutralDatabase, taskId: string) {
  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  const cards = await db
    .select()
    .from(workgroupAssignments)
    .where(eq(workgroupAssignments.taskId, taskId))
  const messages = await db
    .select()
    .from(workgroupMessages)
    .where(eq(workgroupMessages.taskId, taskId))
  const memberRuns = runs.filter((run) => run.nodeId === WORKGROUP_TURN_MEMBER_NODE_ID)
  return {
    memberRuns,
    /** 这张卡血缘上的 run（单卡 shardKey = 卡 id）；卡失败后成员回应未读消息的消息轮不在内。 */
    cardRuns: memberRuns.filter((run) => cards.length === 1 && run.shardKey === cards[0]!.id),
    leaderRuns: runs.filter((run) => run.nodeId === WORKGROUP_TURN_LEADER_NODE_ID),
    cards,
    messages,
  }
}

function why(outcome: WorkgroupTurnsOutcome): string {
  return `${outcome.kind} ${outcome.detail?.summary ?? ''} ${outcome.detail?.message ?? ''}`
}

// ---- leader_worker：领队派一张卡给成员 -------------------------------------------------------

async function seedAgentRow(db: ProviderNeutralDatabase, name: string): Promise<string> {
  const agent = await createAgent(db, {
    name,
    description: '',
    outputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: name,
  })
  return agent.id
}

async function seedTaskRow(
  db: ProviderNeutralDatabase,
  config: WorkgroupRuntimeConfig,
): Promise<string> {
  const workflowId = ulid()
  await db.insert(workflows).values({ id: workflowId, name: `wf-${workflowId}`, definition: '{}' })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc369 internal error',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read-wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
    workgroupId: config.workgroupId,
    workgroupConfigJson: JSON.stringify(config),
  })
  return taskId
}

async function seedLeaderWorkerTask(db: ProviderNeutralDatabase): Promise<string> {
  const suffix = ulid().slice(-6).toLowerCase()
  const leaderName = `rfc369-lead-${suffix}`
  const workerName = `rfc369-work-${suffix}`
  const leaderAgentId = await seedAgentRow(db, leaderName)
  const workerAgentId = await seedAgentRow(db, workerName)
  return await seedTaskRow(db, {
    workgroupId: 'wg-rfc369',
    workgroupName: 'rfc369 squad',
    mode: 'leader_worker',
    leaderMemberId: 'm-leader',
    switches: { shareOutputs: true, directMessages: true, blackboard: true },
    maxRounds: 4,
    completionGate: false,
    goal: 'finish',
    instructions: 'x',
    members: [
      {
        id: 'm-leader',
        memberType: 'agent',
        agentName: leaderName,
        agentId: leaderAgentId,
        userId: null,
        displayName: 'lead',
        roleDesc: '',
      },
      {
        id: 'm-worker',
        memberType: 'agent',
        agentName: workerName,
        agentId: workerAgentId,
        userId: null,
        displayName: 'worker',
        roleDesc: '',
      },
    ],
  })
}

const leaderAssigns: WorkgroupTurnHostResult = {
  status: 'done',
  outputs: {
    wg_decision: JSON.stringify({ action: 'continue' }),
    wg_assignments: JSON.stringify([{ member: 'worker', title: 'the card', brief: 'b' }]),
  },
}
const leaderDone: WorkgroupTurnHostResult = {
  status: 'done',
  outputs: { wg_decision: JSON.stringify({ action: 'done', summary: 'reviewed' }) },
}
const memberDone: WorkgroupTurnHostResult = {
  status: 'done',
  outputs: { wg_result: JSON.stringify({ summary: 'did it' }) },
}

/** 领队按顺序回放；成员由各用例自己决定。 */
function leaderScript(): (request: WorkgroupTurnHostRequest) => WorkgroupTurnHostResult | null {
  const queue = [leaderAssigns, leaderDone, leaderDone]
  return (request) =>
    request.nodeId === WORKGROUP_TURN_LEADER_NODE_ID ? (queue.shift() ?? leaderDone) : null
}

/** 这张卡血缘上的 run 被执行了几次。 */
function cardCalls(rows: Awaited<ReturnType<typeof rowsOf>>, requests: readonly string[]): number {
  return requests.filter((id) => rows.cardRuns.some((run) => run.id === id)).length
}

function expectRoundFailed(
  rows: Awaited<ReturnType<typeof rowsOf>>,
  injected: string,
  from: 'dispatched' | 'running',
) {
  expect(rows.cards).toHaveLength(1)
  expect(rows.cards[0]?.status, `card should fail from ${from}`).toBe('failed')
  const failures = rows.messages.filter((message) => message.templateKey === 'assignmentFailed')
  expect(failures).toHaveLength(1)
  expect(failures[0]?.bodyMd).toContain(`internal error: ${injected}`)
  // 孤儿 run 不得仍是 pending（下一圈会被当崩溃恢复重新采纳）。假宿主不落终态，所以只看这张卡的血缘。
  expect(rows.cardRuns.filter((run) => run.status === 'pending')).toEqual([])
}

describeEachProvider('RFC-369 AC-5 —— leader_worker 成员一轮内部错误即判失败', (harness) => {
  let db: ProviderNeutralDatabase
  beforeEach(() => {
    db = harness.db
  })

  test('注入点 1：首次开跑提交失败（卡为 dispatched）⇒ 卡按实际状态落 failed，成员零调用', async () => {
    const taskId = await seedLeaderWorkerTask(db)
    const leader = leaderScript()
    const memberRequests: string[] = []
    let injected = false
    const outcome = await injectedDrive({
      db,
      taskId,
      injection: {
        commit: (operations) => {
          if (injected || !mintsMember(operations, 'wg-assignment')) return false
          injected = true
          return true
        },
      },
      runHost: async (request) => {
        const scripted = leader(request)
        if (scripted !== null) return scripted
        memberRequests.push(request.nodeRunId)
        return memberDone
      },
    })
    expect(outcome.kind, why(outcome)).toBe('ok')
    expect(injected).toBe(true)
    const rows = await rowsOf(db, taskId)
    expectRoundFailed(rows, 'injected ledger failure', 'dispatched')
    expect(cardCalls(rows, memberRequests)).toBe(0)
    // 那笔铸造整笔回滚：成员一条 run 都没有。
    expect(rows.cardRuns).toEqual([])
  })

  test('注入点 2：重试铸 run 的事务失败 ⇒ 已跑过的那条 run 被终结，不再重来', async () => {
    const taskId = await seedLeaderWorkerTask(db)
    const leader = leaderScript()
    const broadcasts: Array<[string, string]> = []
    const memberRequests: string[] = []
    const outcome = await injectedDrive({
      db,
      taskId,
      broadcasts,
      injection: { commit: (operations) => mintsMember(operations, 'wg-protocol-retry') },
      runHost: async (request) => {
        const scripted = leader(request)
        if (scripted !== null) return scripted
        memberRequests.push(request.nodeRunId)
        return {
          status: 'failed',
          outputs: {},
          failureCode: 'runtime-stream-interrupted',
          errorMessage: 'transient',
        }
      },
    })
    expect(outcome.kind, why(outcome)).toBe('ok')
    const rows = await rowsOf(db, taskId)
    expectRoundFailed(rows, 'injected ledger failure', 'running')
    expect(cardCalls(rows, memberRequests)).toBe(1)
    expect(rows.cardRuns).toHaveLength(1)
    expect(rows.cardRuns[0]).toMatchObject({
      status: 'failed',
      failureCode: null,
      errorMessage: 'internal error: injected ledger failure',
    })
    expect(broadcasts).toContainEqual([rows.cardRuns[0]!.id, 'failed'])
  })

  test('注入点 3：铸造成功后、执行前抛错（反问判定读失败）⇒ 孤儿 run 终结，成员零调用', async () => {
    const taskId = await seedLeaderWorkerTask(db)
    const leader = leaderScript()
    const memberRequests: string[] = []
    let clarifyReads = 0
    const outcome = await injectedDrive({
      db,
      taskId,
      injection: {
        // 第一次是领队，第二次是成员那一轮。
        clarifyAllowed: () => (clarifyReads += 1) === 2,
      },
      runHost: async (request) => {
        const scripted = leader(request)
        if (scripted !== null) return scripted
        memberRequests.push(request.nodeRunId)
        return memberDone
      },
    })
    expect(outcome.kind, why(outcome)).toBe('ok')
    const rows = await rowsOf(db, taskId)
    expectRoundFailed(rows, 'injected clarify read failure', 'running')
    expect(rows.cardRuns.map((run) => run.status)).toEqual(['failed'])
    expect(cardCalls(rows, memberRequests)).toBe(0)
  })

  test('注入点 4：runHost 在 assembly 前抛错 ⇒ 这条 run 终结，不再重来', async () => {
    const taskId = await seedLeaderWorkerTask(db)
    const leader = leaderScript()
    const memberRequests: string[] = []
    const outcome = await injectedDrive({
      db,
      taskId,
      injection: {},
      runHost: async (request) => {
        const scripted = leader(request)
        if (scripted !== null) return scripted
        memberRequests.push(request.nodeRunId)
        if (memberRequests.length > 1) return memberDone
        throw new Error('host blew up before assembly')
      },
    })
    expect(outcome.kind, why(outcome)).toBe('ok')
    const rows = await rowsOf(db, taskId)
    expectRoundFailed(rows, 'host blew up before assembly', 'running')
    expect(rows.cardRuns.map((run) => run.status)).toEqual(['failed'])
    expect(cardCalls(rows, memberRequests)).toBe(1)
  })

  test('领队内部错误：房间补一条内部错误消息（item=leader），任务失败', async () => {
    const taskId = await seedLeaderWorkerTask(db)
    let leaderCalls = 0
    const outcome = await injectedDrive({
      db,
      taskId,
      injection: {},
      runHost: async () => {
        leaderCalls += 1
        throw new Error('leader host exploded')
      },
    })
    expect(outcome.kind).toBe('failed')
    expect(outcome.detail?.message).toBe('internal error: leader host exploded')
    expect(leaderCalls).toBe(1)
    const rows = await rowsOf(db, taskId)
    const internal = rows.messages.filter((message) => message.templateKey === 'internalDriveError')
    expect(internal).toHaveLength(1)
    expect(JSON.parse(internal[0]!.templateParamsJson ?? '{}')).toMatchObject({ item: 'leader' })
    expect(rows.leaderRuns.map((run) => run.status)).toEqual(['failed'])
  })
})

// ---- free_collab：批量认领 open 卡 / 采纳 pending run ------------------------------------------

async function seedFreeCollabTask(db: ProviderNeutralDatabase): Promise<string> {
  const name = `rfc369-fc-${ulid().slice(-6).toLowerCase()}`
  const agentId = await seedAgentRow(db, name)
  const taskId = await seedTaskRow(db, {
    workgroupId: 'wg-rfc369-fc',
    workgroupName: 'rfc369 fc',
    mode: 'free_collab',
    leaderMemberId: null,
    switches: { shareOutputs: true, directMessages: true, blackboard: true },
    maxRounds: 30,
    completionGate: false,
    instructions: 'x',
    goal: 'ship',
    members: [
      {
        id: 'm-a',
        memberType: 'agent',
        agentName: name,
        agentId,
        userId: null,
        displayName: 'alpha',
        roleDesc: '',
      },
    ],
  })
  // 预置一条 done 的成员行，跳过 fc 初始规划轮（与 rfc215-batch-engine 同形）。
  await db.insert(nodeRuns).values({
    id: ulid(),
    taskId,
    nodeId: WORKGROUP_TURN_MEMBER_NODE_ID,
    status: 'done',
    rerunCause: 'wg-message-turn',
    shardKey: 'msg:m-a:0',
    startedAt: Date.now(),
  })
  return taskId
}

async function seedCard(
  db: ProviderNeutralDatabase,
  taskId: string,
  status: 'open' | 'dispatched' | 'awaiting_human',
  attemptCount: number,
): Promise<string> {
  const id = ulid()
  await db.insert(workgroupAssignments).values({
    id,
    taskId,
    round: 0,
    source: 'self_claim',
    assigneeMemberId: status === 'open' ? null : 'm-a',
    title: `card ${status}`,
    briefMd: 'b',
    status,
    attemptCount,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}

const batchDone: WorkgroupTurnHostResult = {
  status: 'done',
  outputs: { wg_task_results: JSON.stringify([{ task: 1, summary: 'ok' }]) },
}

describeEachProvider('RFC-369 AC-5 —— free_collab 批量认领 / 采纳变体', (harness) => {
  let db: ProviderNeutralDatabase
  beforeEach(() => {
    db = harness.db
  })

  test('认领中的 open 卡：稳定的内部错误按卡预算收敛（bump 尝试次数），成员零调用、不无界循环', async () => {
    const taskId = await seedFreeCollabTask(db)
    const cardId = await seedCard(db, taskId, 'open', 0)
    let memberCalls = 0
    let injections = 0
    for (let pass = 0; pass < DEFAULT_PROTOCOL_RETRY_BUDGET + 2; pass += 1) {
      const outcome = await injectedDrive({
        db,
        taskId,
        injection: {
          commit: (operations) => {
            if (!mintsMember(operations, 'wg-assignment')) return false
            injections += 1
            return true
          },
        },
        runHost: async () => {
          memberCalls += 1
          return batchDone
        },
      })
      expect(outcome.kind, why(outcome)).toBe('ok')
    }
    expect(memberCalls).toBe(0)
    expect(injections).toBe(DEFAULT_PROTOCOL_RETRY_BUDGET)
    const rows = await rowsOf(db, taskId)
    const card = rows.cards.find((candidate) => candidate.id === cardId)
    expect(card).toMatchObject({ status: 'failed', attemptCount: DEFAULT_PROTOCOL_RETRY_BUDGET })
    const failures = rows.messages.filter((message) => message.templateKey === 'batchFailed')
    expect(failures).toHaveLength(DEFAULT_PROTOCOL_RETRY_BUDGET)
    expect(failures[0]?.bodyMd).toContain('internal error: injected ledger failure')
  })

  test.each(['dispatched', 'awaiting_human'] as const)(
    '采纳变体：%s 卡上的 pending run，开跑提交失败 ⇒ 卡按实际状态落 failed、被采纳的 run 终结且永不执行',
    async (status) => {
      const taskId = await seedFreeCollabTask(db)
      const cardId = await seedCard(db, taskId, status, 1)
      const adoptedId = ulid()
      await db.insert(nodeRuns).values({
        id: adoptedId,
        taskId,
        nodeId: WORKGROUP_TURN_MEMBER_NODE_ID,
        status: 'pending',
        rerunCause: 'wg-assignment',
        shardKey: buildBatchShardKey('m-a', [cardId]),
        startedAt: Date.now(),
      })
      const requests: WorkgroupTurnHostRequest[] = []
      let injected = false
      const outcome = await injectedDrive({
        db,
        taskId,
        injection: {
          // 采纳路径的开跑提交：只有卡片 → running 的迁移，没有铸造。
          commit: (operations) => {
            if (injected || mintsMember(operations)) return false
            const starts = operations.some(
              (operation) =>
                operation.kind === 'transition-assignment' &&
                operation.assignmentId === cardId &&
                operation.to === 'running',
            )
            if (!starts) return false
            injected = true
            return true
          },
        },
        runHost: async (request) => {
          requests.push(request)
          return batchDone
        },
      })
      expect(outcome.kind, why(outcome)).toBe('ok')
      expect(injected).toBe(true)
      const rows = await rowsOf(db, taskId)
      const adopted = rows.memberRuns.find((run) => run.id === adoptedId)
      expect(adopted).toMatchObject({
        status: 'failed',
        errorMessage: 'internal error: injected ledger failure',
      })
      // 被采纳的那条永不执行；卡片按实际状态落 failed 后在卡预算内被重开、由新 run 完成。
      expect(requests.map((request) => request.nodeRunId)).not.toContain(adoptedId)
      const failures = rows.messages.filter((message) => message.templateKey === 'batchFailed')
      expect(failures).toHaveLength(1)
      const card = rows.cards.find((candidate) => candidate.id === cardId)
      expect(card).toMatchObject({ status: 'done', attemptCount: 2 })
    },
  )
})

describeEachProvider('RFC-369 AC-5 补格（实现门 P2-1）', (harness) => {
  let db: ProviderNeutralDatabase
  beforeEach(() => {
    db = harness.db
  })

  test('卡片那笔 CAS 不中（执行中卡被取消）⇒ 孤儿 run 照样被终结（两笔分开提交的理由）', async () => {
    const taskId = await seedLeaderWorkerTask(db)
    const leader = leaderScript()
    const outcome = await injectedDrive({
      db,
      taskId,
      injection: {},
      runHost: async (request) => {
        const scripted = leader(request)
        if (scripted !== null) return scripted
        if (!request.promptTemplate.includes('## Your assignment')) return memberDone
        // 用户中途取消了这张卡，随后宿主内部出错：落卡片 failed 的那笔会 CAS 不中。
        await db
          .update(workgroupAssignments)
          .set({ status: 'canceled' })
          .where(eq(workgroupAssignments.taskId, taskId))
        throw new Error('host blew up after cancel')
      },
    })
    expect(outcome.kind, why(outcome)).toBe('ok')
    const rows = await rowsOf(db, taskId)
    expect(rows.cards[0]?.status).toBe('canceled')
    expect(rows.cardRuns).toHaveLength(1)
    expect(rows.cardRuns[0]).toMatchObject({
      status: 'failed',
      errorMessage: 'internal error: host blew up after cancel',
    })
  })

  test('消息轮内部错误 ⇒ 推进游标 + messageTurnFailed，这批消息不再重来', async () => {
    const taskId = await seedLeaderWorkerTask(db)
    const leaderQueue: WorkgroupTurnHostResult[] = [
      {
        status: 'done',
        outputs: {
          wg_decision: JSON.stringify({ action: 'continue' }),
          wg_messages: JSON.stringify([{ to: 'worker', body: 'please look at this' }]),
        },
      },
    ]
    const messageTurns: string[] = []
    const outcome = await injectedDrive({
      db,
      taskId,
      injection: {},
      runHost: async (request) => {
        if (request.nodeId === WORKGROUP_TURN_LEADER_NODE_ID)
          return leaderQueue.shift() ?? leaderDone
        messageTurns.push(request.nodeRunId)
        throw new Error('message host exploded')
      },
    })
    expect(outcome.kind, why(outcome)).toBe('ok')
    expect(messageTurns).toHaveLength(1)
    const rows = await rowsOf(db, taskId)
    const failures = rows.messages.filter((message) => message.templateKey === 'messageTurnFailed')
    expect(failures).toHaveLength(1)
    expect(failures[0]?.bodyMd).toContain('internal error: message host exploded')
    expect(rows.memberRuns.find((run) => run.id === messageTurns[0])?.status).toBe('failed')
    const cursor = (
      await db
        .select()
        .from(workgroupMemberCursors)
        .where(eq(workgroupMemberCursors.taskId, taskId))
    ).find((row) => row.memberId === 'm-worker')
    expect(cursor?.lastConsumedMessageId ?? '').not.toBe('')
  })
})

describeEachProvider('RFC-369 §4.4 —— fail-host-run 宿主账本操作', (harness) => {
  test('只有仍是 pending 的 run 落 failed（failureCode 为 NULL）；其余状态空操作、整笔照常提交', async () => {
    const db = harness.db
    const taskId = await seedLeaderWorkerTask(db)
    const pendingId = ulid()
    const doneId = ulid()
    const missingId = ulid()
    for (const [id, status] of [
      [pendingId, 'pending'],
      [doneId, 'done'],
    ] as const) {
      await db.insert(nodeRuns).values({
        id,
        taskId,
        nodeId: WORKGROUP_TURN_MEMBER_NODE_ID,
        status,
        rerunCause: 'wg-assignment',
        startedAt: Date.now(),
      })
    }
    const factory = composeWorkgroupHostLedgerParticipantFactory({
      collaboration: composeWorkgroupTaskRoomClarifyParticipantFactory(),
    })
    const receipt = await databaseSessionFor(db).transaction(
      async (tx) =>
        await factory.inTransaction(tx).apply({
          taskId,
          operations: [pendingId, doneId, missingId].map((runId) => ({
            kind: 'fail-host-run' as const,
            operationKey: `fail-host-run:${runId}`,
            runId,
            message: 'internal error: boom',
          })),
        }),
    )
    expect(receipt).toEqual({ committed: true, mintedRuns: [], failedRunIds: [pendingId] })
    const byId = new Map(
      (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).map((run) => [
        run.id,
        run,
      ]),
    )
    expect(byId.get(pendingId)).toMatchObject({
      status: 'failed',
      failureCode: null,
      errorMessage: 'internal error: boom',
    })
    expect(byId.get(pendingId)?.finishedAt).not.toBeNull()
    expect(byId.get(doneId)).toMatchObject({ status: 'done', errorMessage: null })
  })
})

describe('RFC-369 AC-5 —— 源码锁：内部错误转换住在 executeHostTurn 的外层', () => {
  test('驱动 catch 不再是 host 执行中内部错误的出口（转换发生在 executeHostTurn 内）', async () => {
    const source = await Bun.file(
      new URL(
        '../src/modules/resource-catalog/application/workgroups/workgroupTurnsDriver.ts',
        import.meta.url,
      ),
    ).text()
    const wrapperAt = source.indexOf('async function executeHostTurn<T>(')
    const attemptsAt = source.indexOf('async function runHostTurnAttempts<T>(')
    expect(wrapperAt).toBeGreaterThan(-1)
    expect(attemptsAt).toBeGreaterThan(wrapperAt)
    const wrapper = source.slice(wrapperAt, attemptsAt)
    expect(wrapper).toContain("kind: 'fail-host-run'")
    expect(wrapper).toContain('internal: { started: trace.started }')
  })
})
