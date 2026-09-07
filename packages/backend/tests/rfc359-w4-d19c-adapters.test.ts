// RFC-359 W4-D19c —— 工作组回合引擎合一：SQLite 不再走 legacy engine，两个 provider 用同一条中立驱动
// （`application/workgroups/workgroupTurnsDriver.ts` + 一份持久化适配器 `workgroupTurnsOperations.ts`）。
//
// 这一刀之前 PostgreSQL 跑的就是这条中立驱动，但它几乎没有行为覆盖（SQLite 侧 13 个行为套件全都直接调
// legacy 的 `runWorkgroupEngine`，压根不经过这条路）。那些套件已经改接中立驱动，本文件再给**两个引擎**
// 补一条端到端的回合断言：领队一轮派单 → 成员执行 → 领队收敛 done，沿途的房间消息、卡片状态与任务收场
// 在两边逐字一致。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { DEFAULT_PROTOCOL_RETRY_BUDGET } from '@agent-workflow/shared'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  agents,
  nodeRuns,
  tasks,
  workflows,
  workgroupAssignments,
  workgroupMessages,
} from '@/db/schema'
import type {
  WorkgroupTurnHostRequest,
  WorkgroupTurnHostResult,
  WorkgroupTurnLogger,
} from '@/modules/task-execution/public/commands'
import {
  WORKGROUP_TURN_LEADER_NODE_ID,
  WORKGROUP_TURN_MEMBER_NODE_ID,
} from '@/modules/task-execution/public/commands'
import { describeEachProvider } from './helpers/eachProvider'
import { runWorkgroupTurns } from './helpers/workgroupTurns'

const T0 = 1_700_000_000_000
const log: WorkgroupTurnLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => log,
}

/** 领队 + 一个执行成员的最小 leader_worker 小队。 */
function squadConfig(leaderAgentId: string, workerAgentId: string): Record<string, unknown> {
  return {
    workgroupId: 'wg-rfc359-d19c',
    workgroupName: 'rfc359 d19c squad',
    mode: 'leader_worker',
    leaderMemberId: 'm-leader',
    switches: { shareOutputs: true, directMessages: true, blackboard: true },
    maxRounds: 4,
    completionGate: false,
    goal: 'unify the turn engine',
    instructions: 'be precise',
    members: [
      {
        id: 'm-leader',
        memberType: 'agent',
        agentName: 'd19c-leader',
        agentId: leaderAgentId,
        userId: null,
        displayName: 'lead',
        roleDesc: '协调',
      },
      {
        id: 'm-worker',
        memberType: 'agent',
        agentName: 'd19c-worker',
        agentId: workerAgentId,
        userId: null,
        displayName: 'worker',
        roleDesc: '实现',
      },
    ],
  }
}

async function seedAgent(db: ProviderNeutralDatabase, name: string): Promise<string> {
  const id = ulid()
  await db.insert(agents).values({
    id,
    name,
    description: '',
    bodyMd: name,
    createdAt: T0,
    updatedAt: T0,
  })
  return id
}

async function seedTask(db: ProviderNeutralDatabase): Promise<string> {
  const leaderAgentId = await seedAgent(db, `d19c-leader-${ulid().slice(-6).toLowerCase()}`)
  const workerAgentId = await seedAgent(db, `d19c-worker-${ulid().slice(-6).toLowerCase()}`)
  const config = squadConfig(leaderAgentId, workerAgentId)
  // 名册按 agentName 解析，所以配置里的名字要与刚落库的行一致。
  const members = config.members as Array<Record<string, unknown>>
  const leaderRow = (await db.select().from(agents).where(eq(agents.id, leaderAgentId)).limit(1))[0]
  const workerRow = (await db.select().from(agents).where(eq(agents.id, workerAgentId)).limit(1))[0]
  members[0]!.agentName = leaderRow?.name ?? ''
  members[1]!.agentName = workerRow?.name ?? ''

  const workflowId = ulid()
  await db.insert(workflows).values({ id: workflowId, name: `wf-${workflowId}`, definition: '{}' })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 'd19c turn task',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read-wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: T0,
    workgroupId: config.workgroupId as string,
    workgroupConfigJson: JSON.stringify(config),
  })
  return taskId
}

/** 按 nodeId 排队回放的假宿主；同时记录每次收到的请求（用来看提示词）。 */
function scriptedHost(script: {
  leader: WorkgroupTurnHostResult[]
  member: WorkgroupTurnHostResult[]
}): {
  hooks: { runHostNode: (request: WorkgroupTurnHostRequest) => Promise<WorkgroupTurnHostResult> }
  requests: WorkgroupTurnHostRequest[]
} {
  const requests: WorkgroupTurnHostRequest[] = []
  return {
    requests,
    hooks: {
      runHostNode: (request) => {
        requests.push(request)
        const queue =
          request.nodeId === WORKGROUP_TURN_LEADER_NODE_ID ? script.leader : script.member
        const next = queue.shift()
        return Promise.resolve(
          next ?? {
            status: 'failed',
            outputs: {},
            errorMessage: `no scripted result for ${request.nodeId}`,
          },
        )
      },
    },
  }
}

describeEachProvider('RFC-359 W4-D19c —— 工作组回合引擎', (harness) => {
  test('领队派单 → 成员交付 → 领队收敛 done：两个引擎同一套回合', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const taskId = await seedTask(db)
    const { hooks, requests } = scriptedHost({
      leader: [
        {
          status: 'done',
          outputs: {
            wg_decision: JSON.stringify({ action: 'continue' }),
            wg_assignments: JSON.stringify([
              { member: 'worker', title: 'do the thing', brief: 'details here' },
            ]),
          },
        },
        {
          status: 'done',
          outputs: {
            wg_decision: JSON.stringify({ action: 'done', summary: 'all set' }),
          },
        },
      ],
      member: [{ status: 'done', outputs: { wg_result: JSON.stringify({ summary: 'done it' }) } }],
    })

    const outcome = await runWorkgroupTurns({ db, taskId, log, hooks })

    expect(outcome.kind).toBe('ok')
    // 领队两轮 + 成员一轮
    expect(requests.map((request) => request.nodeId)).toEqual([
      WORKGROUP_TURN_LEADER_NODE_ID,
      WORKGROUP_TURN_MEMBER_NODE_ID,
      WORKGROUP_TURN_LEADER_NODE_ID,
    ])
    // 提示词是合一后的正典形态：charter / goal / 名册 / 派单卡都在（合一前中立驱动是另一套更简单的）。
    expect(requests[0]?.promptTemplate).toContain('## Workgroup')
    expect(requests[0]?.promptTemplate).toContain('## Group goal')
    expect(requests[0]?.promptTemplate).toContain('## Workgroup roster')
    expect(requests[1]?.promptTemplate).toContain('## Your assignment')

    const cards = await db
      .select()
      .from(workgroupAssignments)
      .where(eq(workgroupAssignments.taskId, taskId))
    expect(cards).toHaveLength(1)
    expect(cards[0]?.status).toBe('done')
    expect(cards[0]?.title).toBe('do the thing')

    const messages = await db
      .select()
      .from(workgroupMessages)
      .where(eq(workgroupMessages.taskId, taskId))
    expect(messages.some((message) => message.kind === 'dispatch')).toBe(true)
    expect(messages.some((message) => message.kind === 'decision')).toBe(true)
    // 结果消息必须署上执行者。卡片是在**同一笔提交**里被认领的，照快照里的 `assigneeMemberId` 取会拿到
    // 认领前的 null，房间里就出现一条没有作者的结果（e2e 业务场景实撞，2026-09-06）。
    const result = messages.find((message) => message.kind === 'result')
    expect(result?.authorMemberId).toBe('m-worker')
    expect(result?.assignmentId).toBe(cards[0]?.id ?? null)
  })

  test('领队协议出错：按正典文案重提示一次后收敛（两个引擎同一条重试路径）', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const taskId = await seedTask(db)
    const { hooks, requests } = scriptedHost({
      leader: [
        { status: 'done', outputs: { wg_decision: 'not json at all' } },
        {
          status: 'done',
          outputs: { wg_decision: JSON.stringify({ action: 'done', summary: 'recovered' }) },
        },
      ],
      member: [],
    })

    const outcome = await runWorkgroupTurns({ db, taskId, log, hooks })

    expect(outcome.kind).toBe('ok')
    expect(requests).toHaveLength(2)
    // 重提示块的标题与围栏形态是用户可见的提示词——合一后两个引擎都取这一份。
    expect(requests[1]?.promptTemplate).toContain('## Protocol errors in your previous reply')
    expect(requests[1]?.promptTemplate).toContain('Re-emit a CORRECT envelope.')
  })

  test('重启杀掉的「已回答澄清」续跑在进门时按原样血缘复活（两个引擎同一条恢复）', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const taskId = await seedTask(db)
    // 人回答后铸出的那条 pending 续跑，被重启的 reaper 翻成了 interrupted。
    const killedId = ulid()
    await db.insert(nodeRuns).values({
      id: killedId,
      taskId,
      nodeId: WORKGROUP_TURN_LEADER_NODE_ID,
      status: 'interrupted',
      iteration: 0,
      retryIndex: 0,
      rerunCause: 'clarify-answer',
      startedAt: T0,
    })

    const { hooks } = scriptedHost({
      leader: [
        {
          status: 'done',
          outputs: { wg_decision: JSON.stringify({ action: 'done', summary: 'answered' }) },
        },
      ],
      member: [],
    })
    await runWorkgroupTurns({ db, taskId, log, hooks })

    // 复活出来的那条必须**保住澄清血缘**——Q&A 的注入只发生在这种 rerun 上（nodeMechanics 的
    // buildClarifyQueueContext：非 answer 轮拿到空队列）。铸成普通 wg-leader-round 就等于把人的
    // 回答丢了，正是 RFC-187 T13 当初修掉的故障；合一时这条恢复没被带过来，本次补回。
    const revived = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (run) => run.id !== killedId && run.rerunCause === 'clarify-answer',
    )
    expect(revived).toHaveLength(1)
    expect(revived[0]?.nodeId).toBe(WORKGROUP_TURN_LEADER_NODE_ID)
    expect(revived[0]?.retryIndex).toBe(1)
  })

  test.each(['runtime-stream-interrupted', 'runtime-session-identity-invalid'] as const)(
    '成员瞬态故障 %s 后重跑：卡片改指新 run 并交付，领队继续收敛',
    async (failureCode) => {
      const db = harness.db as unknown as ProviderNeutralDatabase
      const taskId = await seedTask(db)
      const { hooks, requests } = scriptedHost({
        leader: [
          {
            status: 'done',
            outputs: {
              wg_decision: JSON.stringify({ action: 'continue' }),
              wg_assignments: JSON.stringify([
                { member: 'worker', title: 'recover the assignment', brief: 'finish after retry' },
              ]),
            },
          },
          {
            status: 'done',
            outputs: { wg_decision: JSON.stringify({ action: 'done', summary: 'recovered' }) },
          },
        ],
        member: [
          { status: 'failed', outputs: {}, failureCode, errorMessage: 'transient member failure' },
          {
            status: 'done',
            outputs: { wg_result: JSON.stringify({ summary: 'member recovered' }) },
          },
        ],
      })

      const outcome = await runWorkgroupTurns({ db, taskId, log, hooks })

      const memberRequests = requests.filter(
        (request) => request.nodeId === WORKGROUP_TURN_MEMBER_NODE_ID,
      )
      expect(memberRequests).toHaveLength(2)
      expect(outcome.kind).toBe('ok')
      expect(memberRequests[1]?.promptTemplate).not.toContain(
        '## Protocol errors in your previous reply',
      )
      const cards = await db
        .select()
        .from(workgroupAssignments)
        .where(eq(workgroupAssignments.taskId, taskId))
      expect(cards).toHaveLength(1)
      expect(cards[0]).toMatchObject({
        status: 'done',
        nodeRunId: memberRequests[1]?.nodeRunId,
      })
      const memberRuns = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId)))
        .filter((run) => run.nodeId === WORKGROUP_TURN_MEMBER_NODE_ID)
        .sort((a, b) => a.retryIndex - b.retryIndex)
      expect(memberRuns.map((run) => [run.retryIndex, run.rerunCause])).toEqual([
        [0, 'wg-assignment'],
        [1, 'wg-protocol-retry'],
      ])
      const messages = await db
        .select()
        .from(workgroupMessages)
        .where(eq(workgroupMessages.taskId, taskId))
      expect(messages.find((message) => message.id === cards[0]?.resultMessageId)).toMatchObject({
        kind: 'result',
        authorMemberId: 'm-worker',
        bodyMd: 'member recovered',
      })
      expect(messages.some((message) => message.templateKey === 'leaderNudge')).toBe(false)
    },
  )

  test('成员瞬态故障重试耗尽：卡片落为 failed 并通知领队，不遗留 running 卡片', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const taskId = await seedTask(db)
    const { hooks, requests } = scriptedHost({
      leader: [
        {
          status: 'done',
          outputs: {
            wg_decision: JSON.stringify({ action: 'continue' }),
            wg_assignments: JSON.stringify([
              {
                member: 'worker',
                title: 'exhausted assignment',
                brief: 'report permanent failure',
              },
            ]),
          },
        },
        {
          status: 'done',
          outputs: { wg_decision: JSON.stringify({ action: 'done', summary: 'failure reviewed' }) },
        },
      ],
      member: [
        ...Array.from({ length: DEFAULT_PROTOCOL_RETRY_BUDGET + 1 }, () => ({
          status: 'failed' as const,
          outputs: {},
          failureCode: 'runtime-stream-interrupted' as const,
          errorMessage: 'member stream kept failing',
        })),
        { status: 'done', outputs: { wg_messages: '[]' } },
      ],
    })

    const outcome = await runWorkgroupTurns({ db, taskId, log, hooks })

    expect(outcome.kind).toBe('ok')
    const cards = await db
      .select()
      .from(workgroupAssignments)
      .where(eq(workgroupAssignments.taskId, taskId))
    expect(cards).toHaveLength(1)
    // 卡片失败之后成员还可能响应未读消息；按卡片血缘只数这次派单的重跑。
    const assignmentRuns = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId)))
      .filter((run) => run.shardKey === cards[0]?.id)
      .sort((a, b) => a.retryIndex - b.retryIndex)
    const assignmentRunIds = new Set(assignmentRuns.map((run) => run.id))
    expect(requests.filter((request) => assignmentRunIds.has(request.nodeRunId))).toHaveLength(
      DEFAULT_PROTOCOL_RETRY_BUDGET + 1,
    )
    expect(cards[0]).toMatchObject({
      status: 'failed',
      nodeRunId: assignmentRuns.at(-1)?.id,
      resultMessageId: null,
    })
    const messages = await db
      .select()
      .from(workgroupMessages)
      .where(eq(workgroupMessages.taskId, taskId))
    const failures = messages.filter((message) => message.templateKey === 'assignmentFailed')
    expect(failures).toHaveLength(1)
    expect(failures[0]?.bodyMd).toContain('member stream kept failing')
    expect(messages.some((message) => message.templateKey === 'leaderNudge')).toBe(false)
  })

  test('运行时流中断的重跑不吃协议预算，但必须自己进账本（两个引擎同一条转轨）', async () => {
    const db = harness.db as unknown as ProviderNeutralDatabase
    const taskId = await seedTask(db)
    const { hooks, requests } = scriptedHost({
      leader: [
        // 流被打断不是模型的协议错误：整轮换个新进程重来，不贴重提示、不消耗协议预算。
        {
          status: 'failed',
          outputs: {},
          errorMessage: 'runtime stream persistence failed',
          failureCode: 'runtime-stream-interrupted',
        },
        {
          status: 'done',
          outputs: { wg_decision: JSON.stringify({ action: 'done', summary: 'recovered' }) },
        },
      ],
      member: [],
    })

    const outcome = await runWorkgroupTurns({ db, taskId, log, hooks })

    expect(outcome.kind).toBe('ok')
    expect(requests).toHaveLength(2)
    // 换进程重来，不是「你上一轮答错了」——不能贴协议重提示。
    expect(requests[1]?.promptTemplate).not.toContain('## Protocol errors in your previous reply')

    // 重跑要**自己占一格 retryIndex**、并按 `wg-protocol-retry` 记账。两件事都是用户可见的：
    // 前者是 node_run 的身份（design.md：重试产生按 retry_index 区分的独立 node_runs），撞号会让
    // 血缘/采纳挑错行；后者是**轮次记账的豁免**——free_collab 的 roundBudget 逐条数成员 run、只跳过
    // `wg-protocol-retry`，铸成主 cause 就等于一次流中断白吃掉一整轮，小队会莫名撞上 max_rounds。
    // 按 retryIndex 排——同毫秒铸出的两条 ULID 之间没有稳定序，按 id 排会间歇性翻转。
    const runs = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).sort(
      (a, b) => a.retryIndex - b.retryIndex,
    )
    expect(runs.map((run) => [run.retryIndex, run.rerunCause])).toEqual([
      [0, 'wg-leader-round'],
      [1, 'wg-protocol-retry'],
    ])
  })
})

test('源码锁：回合只有一份实现与一份装配，legacy 薄壳与 provider 命名文件都已退役', async () => {
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const root = resolve(import.meta.dir, '..', 'src')
  const read = (path: string): string => readFileSync(resolve(root, path), 'utf8')

  const composition = read('modules/resource-catalog/composition/workgroupTurns.ts')
  expect(composition).toContain('export function composeWorkgroupTurnsOperations(')
  expect(composition).not.toContain('composePostgresqlWorkgroupTurnsOperations')

  for (const retired of [
    'modules/task-execution/infrastructure/sqliteWorkgroupTurnsOperations.ts',
    'modules/resource-catalog/infrastructure/postgresqlWorkgroupTurnsOperations.ts',
    'modules/task-execution/infrastructure/postgresqlWorkgroupHostLedgerParticipant.ts',
    'services/workgroup/engine.ts',
  ]) {
    expect(() => read(retired)).toThrow()
  }

  // 两个 bootstrap 装的是同一条；SQLite 侧不再经 legacy engine。
  for (const bootstrap of ['server.ts', 'cli/start.ts', 'cli/postgresqlDaemonApplication.ts']) {
    expect(read(bootstrap)).toContain('composeWorkgroupTurnsOperations(')
  }
  expect(
    read('modules/task-execution/infrastructure/sqliteTaskExecutionRuntimeParticipants.ts'),
  ).not.toContain('runWorkgroupEngine')
})
