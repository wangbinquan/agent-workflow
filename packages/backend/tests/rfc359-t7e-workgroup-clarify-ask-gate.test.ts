// RFC-359 W1-T7e（P0-12）—— 工作组反问许可与协议块在两个引擎上是同一份。
//
// dual-provider-parity-audit-2026-09-04 P0-12：provider-中立的回合驱动（PostgreSQL 在用）里
// `protocolBlock` 是 4 行 stub、`clarifyEnabled` 简化成「有人类成员且预算 > 0」——agent 永远不知道
// 可以向人提问。现在协议块渲染器（纯函数）迁到 application 层两边共用，「能否反问」的判定
// （RFC-207 §3.7.2：预算 / 已问次数 / per-asker stop）归 collaboration 一份实现，legacy SQLite
// 路径只是转发。

import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import { wgClarifyAskerKey, type WorkgroupRuntimeConfig } from '@agent-workflow/shared'

import {
  agents,
  clarifyRounds,
  nodeRuns,
  tasks,
  workgroupAssignments,
  workgroupTaskState,
} from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { setNodeClarifyDirective } from '@/modules/collaboration/infrastructure/taskClarifyDirective'
import { createWorkgroupClarifyAskGate } from '@/modules/collaboration/public/participants'
import {
  renderWgProtocolBlock,
  wgHostRolePorts,
} from '@/modules/resource-catalog/application/workgroups/workgroupProtocol'
import {
  WORKGROUP_TURN_LEADER_NODE_ID,
  WORKGROUP_TURN_MEMBER_NODE_ID,
  type WorkgroupTurnHostRequest,
  type WorkgroupTurnHostResult,
  type WorkgroupTurnLogger,
} from '@/modules/task-execution/public/commands'
import { describeEachProvider } from './helpers/eachProvider'
import {
  CL,
  DESIGNER,
  freshTaskId,
  mkQ,
  seedRun,
  seedTask,
} from './helpers/questionDispatchFixture'
import { runWorkgroupTurns } from './helpers/workgroupTurns'

const ulid = monotonicFactory()
const HUMAN_AND_AGENT = [{ memberType: 'agent' as const }, { memberType: 'human' as const }]
const AGENTS_ONLY = [{ memberType: 'agent' as const }]
const turnLog: WorkgroupTurnLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => turnLog,
}

async function seedWorkgroupTurnTask(db: ProviderNeutralDatabase): Promise<string> {
  const taskId = freshTaskId()
  await seedTask(db, taskId)
  const leaderId = ulid()
  const workerId = ulid()
  const leaderName = `t7e-leader-${leaderId.toLowerCase()}`
  const workerName = `t7e-worker-${workerId.toLowerCase()}`
  await db.insert(agents).values([
    { id: leaderId, name: leaderName, description: '', bodyMd: 'Coordinate the work.' },
    { id: workerId, name: workerName, description: '', bodyMd: 'Complete the assignment.' },
  ])
  const config: WorkgroupRuntimeConfig = {
    workgroupId: `wg-${taskId}`,
    workgroupName: 't7e clarify driver',
    mode: 'leader_worker',
    leaderMemberId: 'm-leader',
    switches: { shareOutputs: true, directMessages: false, blackboard: true },
    maxRounds: 4,
    completionGate: false,
    clarifyBudget: 1,
    goal: 'Complete the assignment with the requested human input.',
    instructions: 'Report the result.',
    members: [
      {
        id: 'm-leader',
        memberType: 'agent',
        agentId: leaderId,
        agentName: leaderName,
        userId: null,
        displayName: 'lead',
        roleDesc: 'Coordinate',
      },
      {
        id: 'm-worker',
        memberType: 'agent',
        agentId: workerId,
        agentName: workerName,
        userId: null,
        displayName: 'worker',
        roleDesc: 'Implement',
      },
      {
        id: 'm-human',
        memberType: 'human',
        agentId: null,
        agentName: null,
        userId: 'u1',
        displayName: 'operator',
        roleDesc: 'Answer questions',
      },
    ],
  }
  await db
    .update(tasks)
    .set({
      status: 'running',
      workgroupId: config.workgroupId,
      workgroupConfigJson: JSON.stringify(config),
    })
    .where(eq(tasks.id, taskId))
  return taskId
}

async function expectPersistedHostNonce(
  db: ProviderNeutralDatabase,
  request: WorkgroupTurnHostRequest,
): Promise<typeof nodeRuns.$inferSelect> {
  const [run] = await db.select().from(nodeRuns).where(eq(nodeRuns.id, request.nodeRunId))
  expect(run).toBeDefined()
  if (run === undefined) throw new Error('turn driver did not persist its host run')
  const nonce = run.envelopeNonce
  expect(nonce).not.toBeNull()
  if (nonce === null) throw new Error('turn driver did not persist its envelope nonce')
  expect(nonce.length).toBeGreaterThan(0)
  expect(request.workgroupProtocolBlock).toContain(`nonce="${nonce}"`)
  return run
}

async function seedSelfAsk(
  db: ProviderNeutralDatabase,
  taskId: string,
  nodeId: string,
  shardKey: string | null,
): Promise<void> {
  const askingRunId = await seedRun(db, taskId, nodeId, { status: 'awaiting_human' })
  const intRunId = await seedRun(db, taskId, CL, { status: 'awaiting_human' })
  await db.insert(clarifyRounds).values({
    id: ulid(),
    taskId,
    kind: 'self',
    askingNodeId: nodeId,
    askingNodeRunId: askingRunId,
    askingShardKey: shardKey,
    intermediaryNodeId: CL,
    intermediaryNodeRunId: intRunId,
    targetConsumerNodeId: null,
    iteration: 0,
    questionsJson: '[]',
    answersJson: '[]',
    directive: 'continue',
    status: 'awaiting_human',
  })
}

describeEachProvider('RFC-359 T7e —— 工作组反问许可（clarify ask gate）', (harness) => {
  test('无人类成员 / 预算为 0 → 不允许；有人类 + 预算 > 已问次数 → 允许', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    await seedTask(db, taskId)
    const gate = createWorkgroupClarifyAskGate(db)
    const base = { taskId, nodeId: WORKGROUP_TURN_MEMBER_NODE_ID, shardKey: 'asg:1' }
    expect(await gate.allowed({ ...base, members: AGENTS_ONLY, clarifyBudget: 3 })).toBe(false)
    expect(await gate.allowed({ ...base, members: HUMAN_AND_AGENT, clarifyBudget: 0 })).toBe(false)
    expect(await gate.allowed({ ...base, members: HUMAN_AND_AGENT, clarifyBudget: 2 })).toBe(true)
  })

  test('已问次数按 asker（节点 + 分片）计：同分片问满预算即停，兄弟分片不受影响', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    await seedTask(db, taskId)
    await seedSelfAsk(db, taskId, WORKGROUP_TURN_MEMBER_NODE_ID, 'asg:1')
    await seedSelfAsk(db, taskId, WORKGROUP_TURN_MEMBER_NODE_ID, 'asg:1')
    const gate = createWorkgroupClarifyAskGate(db)
    const shard1 = { taskId, nodeId: WORKGROUP_TURN_MEMBER_NODE_ID, shardKey: 'asg:1' }
    const shard2 = { taskId, nodeId: WORKGROUP_TURN_MEMBER_NODE_ID, shardKey: 'asg:2' }
    expect(await gate.allowed({ ...shard1, members: HUMAN_AND_AGENT, clarifyBudget: 2 })).toBe(
      false,
    )
    expect(await gate.allowed({ ...shard1, members: HUMAN_AND_AGENT, clarifyBudget: 3 })).toBe(true)
    expect(await gate.allowed({ ...shard2, members: HUMAN_AND_AGENT, clarifyBudget: 2 })).toBe(true)
  })

  test('人类对该 asker 下了 stop → 预算再多也不允许；legacy SQLite 入口转发到同一份判定', async () => {
    const db = harness.db
    const taskId = freshTaskId()
    await seedTask(db, taskId)
    const askerKey = wgClarifyAskerKey(DESIGNER, null, '__wg_leader__')
    await setNodeClarifyDirective(db, taskId, DESIGNER, 'stop', 'u1', askerKey)
    const gate = createWorkgroupClarifyAskGate(db)
    const input = {
      taskId,
      nodeId: DESIGNER,
      shardKey: null,
      members: HUMAN_AND_AGENT,
      clarifyBudget: 9,
    }
    expect(await gate.allowed(input)).toBe(false)
    // RFC-359 W4-D19c-tail：legacy 的 `resolveWgClarifyAllowed` 本来就只是转发给这同一个 gate，
    // 转发层退役后直接问 gate 本身——判定只有一份，这一条锁的就是它。
    expect(
      await createWorkgroupClarifyAskGate(db as never).allowed({
        taskId,
        nodeId: DESIGNER,
        shardKey: null,
        members: HUMAN_AND_AGENT,
        clarifyBudget: 9,
      }),
    ).toBe(false)
  })

  // AC-7 / P0-12: the database gate and the protocol renderer must meet in the
  // production turn driver. Only the external host result is controlled here;
  // this does not claim a real child process asked or created a clarify round.
  test('P0-12 实际回合：worker 收到反问协议与持久化 nonce，awaiting 结果把 assignment 停在 awaiting_human', async () => {
    const db = harness.db
    const taskId = await seedWorkgroupTurnTask(db)
    const requests: WorkgroupTurnHostRequest[] = []
    const outcome = await runWorkgroupTurns({
      db,
      taskId,
      log: turnLog,
      hooks: {
        async runHostNode(request): Promise<WorkgroupTurnHostResult> {
          requests.push(request)
          if (request.nodeId === WORKGROUP_TURN_LEADER_NODE_ID) {
            return {
              status: 'done',
              outputs: {
                wg_assignments: JSON.stringify([
                  {
                    member: 'worker',
                    title: 'Choose the target',
                    brief: 'Ask which target to use.',
                  },
                ]),
                wg_decision: JSON.stringify({ action: 'continue' }),
              },
            }
          }
          return { status: 'awaiting', outputs: {}, clarifyQuestionCount: 1 }
        },
      },
    })
    expect(outcome.kind).toBe('awaiting_human')
    expect(requests.map((request) => request.nodeId)).toEqual([
      WORKGROUP_TURN_LEADER_NODE_ID,
      WORKGROUP_TURN_MEMBER_NODE_ID,
    ])
    const worker = requests[1]!
    expect(worker.clarifyEnabled).toBe(true)
    expect(worker.workgroupProtocolBlock).toContain('<workflow-clarify>')
    expect(worker.workgroupProtocolBlock).toContain('"questions"')
    const run = await expectPersistedHostNonce(db, worker)
    const assignments = await db
      .select()
      .from(workgroupAssignments)
      .where(eq(workgroupAssignments.taskId, taskId))
    expect(assignments).toHaveLength(1)
    expect(assignments[0]).toMatchObject({
      assigneeMemberId: 'm-worker',
      title: 'Choose the target',
      status: 'awaiting_human',
      nodeRunId: worker.nodeRunId,
    })
    expect(run.shardKey).toBe(assignments[0]!.id)
    expect(run.rerunCause).toBe('wg-assignment')
    const [state] = await db
      .select()
      .from(workgroupTaskState)
      .where(eq(workgroupTaskState.taskId, taskId))
    expect(state?.pauseReason).toBe('clarify-or-delivery')
    // The driver persists the waiting assignment, not the host's question.
    expect(await db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))).toEqual(
      [],
    )
  })

  test('P0-12 实际回合：同 assignment 已问满预算，worker 不再收到反问邀请且仍能交付', async () => {
    const db = harness.db
    const taskId = await seedWorkgroupTurnTask(db)
    const assignmentId = ulid()
    await db.insert(workgroupAssignments).values({
      id: assignmentId,
      taskId,
      round: 1,
      source: 'leader',
      assigneeMemberId: 'm-worker',
      title: 'Use the answered target',
      briefMd: 'Complete the work using the previous answer.',
      status: 'dispatched',
    })
    const askingRunId = await seedRun(db, taskId, WORKGROUP_TURN_MEMBER_NODE_ID)
    const originRunId = await seedRun(db, taskId, CL)
    await db.update(nodeRuns).set({ shardKey: assignmentId }).where(eq(nodeRuns.id, askingRunId))
    const roundId = ulid()
    const questionsJson = JSON.stringify([mkQ('previous-target')])
    const answersJson = JSON.stringify([
      {
        questionId: 'previous-target',
        selectedOptionIndices: [0],
        selectedOptionLabels: ['A'],
        customText: '',
      },
    ])
    await db.insert(clarifyRounds).values({
      id: roundId,
      taskId,
      kind: 'self',
      askingNodeId: WORKGROUP_TURN_MEMBER_NODE_ID,
      askingNodeRunId: askingRunId,
      askingShardKey: assignmentId,
      intermediaryNodeId: CL,
      intermediaryNodeRunId: originRunId,
      targetConsumerNodeId: null,
      iteration: 0,
      questionsJson,
      answersJson,
      directive: 'continue',
      status: 'answered',
      answeredAt: Date.now(),
    })
    const requests: WorkgroupTurnHostRequest[] = []
    const outcome = await runWorkgroupTurns({
      db,
      taskId,
      log: turnLog,
      hooks: {
        async runHostNode(request): Promise<WorkgroupTurnHostResult> {
          requests.push(request)
          return request.nodeId === WORKGROUP_TURN_MEMBER_NODE_ID
            ? {
                status: 'done',
                outputs: { wg_result: JSON.stringify({ summary: 'Target A used.' }) },
              }
            : {
                status: 'done',
                outputs: { wg_decision: JSON.stringify({ action: 'done', summary: 'Completed.' }) },
              }
        },
      },
    })
    expect(outcome.kind).toBe('ok')
    expect(requests.map((request) => request.nodeId)).toEqual([
      WORKGROUP_TURN_MEMBER_NODE_ID,
      WORKGROUP_TURN_LEADER_NODE_ID,
    ])
    const worker = requests[0]!
    expect(worker.clarifyEnabled).toBe(false)
    expect(worker.workgroupProtocolBlock).not.toContain('<workflow-clarify>')
    expect(worker.workgroupProtocolBlock).toContain('wg_result')
    const run = await expectPersistedHostNonce(db, worker)
    expect(run.shardKey).toBe(assignmentId)
    const [assignment] = await db
      .select()
      .from(workgroupAssignments)
      .where(eq(workgroupAssignments.id, assignmentId))
    expect(assignment?.status).toBe('done')
    expect(assignment?.resultMessageId).not.toBeNull()
    expect(assignment?.nodeRunId).toBe(worker.nodeRunId)
    const rounds = await db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
    expect(rounds).toHaveLength(1)
    expect(rounds[0]).toMatchObject({ id: roundId, status: 'answered', questionsJson, answersJson })
  })
})

const CONFIG = {
  mode: 'leader_worker',
  members: [
    { id: 'm1', displayName: 'writer', memberType: 'agent', agentId: 'a1' },
    { id: 'h1', displayName: 'ops', memberType: 'human' },
  ],
  leaderMemberId: 'm1',
  switches: { shareOutputs: true, directMessages: true, blackboard: true },
} as unknown as WorkgroupRuntimeConfig

test('协议块渲染器：反问邀请只在 clarifyAllowed 时出现，端口按角色与批任务模式给', () => {
  const invited = renderWgProtocolBlock('worker', CONFIG, 'nonce-1', true, null)
  const silent = renderWgProtocolBlock('worker', CONFIG, 'nonce-1', false, null)
  expect(invited).toContain('<workflow-clarify>')
  expect(invited).toContain('nonce="nonce-1"')
  expect(silent).not.toContain('<workflow-clarify>')
  expect(renderWgProtocolBlock('fc_member', CONFIG, '', false, { count: 3 })).toContain(
    'wg_task_results',
  )
  expect(wgHostRolePorts('fc_member', null)).toEqual(['wg_result', 'wg_messages', 'wg_tasks_add'])
  expect(wgHostRolePorts('fc_member', { count: 2 })).toEqual([
    'wg_task_results',
    'wg_messages',
    'wg_tasks_add',
  ])
  expect(wgHostRolePorts('leader', null)).toEqual(['wg_assignments', 'wg_messages', 'wg_decision'])
})

test('源锁：中立回合驱动用真协议块与唯一判定点，PG 适配器把判定接给 collaboration 的 gate', () => {
  const root = resolve(import.meta.dir, '..', 'src')
  const driver = readFileSync(
    resolve(root, 'modules/resource-catalog/application/workgroups/workgroupTurnsDriver.ts'),
    'utf8',
  )
  expect(driver).toContain("from './workgroupProtocol'")
  expect(driver).toContain('const clarifyAllowed = await persistence.clarifyAllowed({')
  expect(driver).toContain('clarifyEnabled: clarifyAllowed,')
  expect(driver).toContain('workgroupProtocolBlock: renderWgProtocolBlock(')
  expect(driver).toContain('hostOutputPorts: wgHostRolePorts(protocolRole, batch),')
  expect(driver).toContain('batchCount: cards.length,')
  expect(driver).not.toContain('## Workgroup output protocol')
  const adapter = readFileSync(
    resolve(root, 'modules/resource-catalog/infrastructure/workgroupTurnsOperations.ts'),
    'utf8',
  )
  expect(adapter).toContain('dependencies.clarifyAskGate.allowed(input)')
  const daemon = readFileSync(resolve(root, 'cli/postgresqlDaemonApplication.ts'), 'utf8')
  expect(daemon).toContain('createWorkgroupClarifyAskGate(input.db)')
  // RFC-359 W4-D19c-tail：转发这一份的 legacy 回合执行已随工作组引擎岛退役，判定只剩这一处。
  const server = readFileSync(resolve(root, 'server.ts'), 'utf8')
  expect(server).toContain('createWorkgroupClarifyAskGate(')
})
