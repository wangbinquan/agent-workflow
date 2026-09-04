// RFC-359 W1-T7e（P0-12）—— 工作组反问许可与协议块在两个引擎上是同一份。
//
// dual-provider-parity-audit-2026-09-04 P0-12：provider-中立的回合驱动（PostgreSQL 在用）里
// `protocolBlock` 是 4 行 stub、`clarifyEnabled` 简化成「有人类成员且预算 > 0」——agent 永远不知道
// 可以向人提问。现在协议块渲染器（纯函数）迁到 application 层两边共用，「能否反问」的判定
// （RFC-207 §3.7.2：预算 / 已问次数 / per-asker stop）归 collaboration 一份实现，legacy SQLite
// 路径只是转发。

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import { wgClarifyAskerKey, type WorkgroupRuntimeConfig } from '@agent-workflow/shared'

import { clarifyRounds } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { setNodeClarifyDirective } from '@/modules/collaboration/infrastructure/legacySqliteTaskClarifyDirective'
import { createWorkgroupClarifyAskGate } from '@/modules/collaboration/public/participants'
import {
  renderWgProtocolBlock,
  wgHostRolePorts,
} from '@/modules/resource-catalog/application/workgroups/workgroupProtocol'
import { resolveWgClarifyAllowed } from '@/modules/resource-catalog/infrastructure/legacy/workgroup/lifecycle'
import { WORKGROUP_TURN_MEMBER_NODE_ID } from '@/modules/task-execution/public/commands'
import { describeEachProvider } from './helpers/eachProvider'
import { CL, DESIGNER, freshTaskId, seedRun, seedTask } from './helpers/questionDispatchFixture'

const ulid = monotonicFactory()
const HUMAN_AND_AGENT = [{ memberType: 'agent' as const }, { memberType: 'human' as const }]
const AGENTS_ONLY = [{ memberType: 'agent' as const }]

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
    expect(
      await resolveWgClarifyAllowed(db as never, taskId, HUMAN_AND_AGENT, 9, DESIGNER, null),
    ).toBe(false)
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
    resolve(root, 'modules/resource-catalog/infrastructure/postgresqlWorkgroupTurnsOperations.ts'),
    'utf8',
  )
  expect(adapter).toContain('dependencies.clarifyAskGate.allowed(input)')
  const daemon = readFileSync(resolve(root, 'cli/postgresqlDaemonApplication.ts'), 'utf8')
  expect(daemon).toContain('createWorkgroupClarifyAskGate(input.db)')
  const legacy = readFileSync(
    resolve(root, 'modules/resource-catalog/infrastructure/legacy/workgroup/lifecycle.ts'),
    'utf8',
  )
  expect(legacy).toContain('return await createWorkgroupClarifyAskGate(db).allowed({')
  expect(legacy).toContain('return await countWorkgroupClarifyAsks(db, taskId, askerKey)')
})
