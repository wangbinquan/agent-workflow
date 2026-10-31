import { composeCollaborationTaskRolePolicy } from '@/modules/resource-catalog/composition'
import { epoch2RuntimeTestPorts } from './helpers/epoch2RuntimePorts'
import { legacyContentRef } from '@/platform/content/contentRef'
import { contentRowColumns } from '@/platform/content/infrastructure/contentStore'
import { o2Ports } from './helpers/o2Closure'
// RFC-359 W7 —— `CollaborationRuntimeMechanics` 的双引擎对拍。
//
// 为什么存在：合一前这一对是 `sqliteCollaborationRuntimeMechanics.ts`（81 行纯转发，逐方法打到
// `legacySqlite*` 的实现上）+ `postgresqlCollaborationRuntimeMechanics.ts`（1747 行把同一批语义
// 用原生 drizzle 重写了一遍）。9 个方法一一对应、没有能力缺口，但那份重写在真库上**从未被跑过**
// ——它唯一的用例（`rfc349-collaboration-runtime-mechanics.test.ts`）喂的是一个记录 SQL 文本的
// 假客户端。本文件把端口契约写成**同一段断言**，`describeEachProvider` 在两个引擎上各跑一遍。
//
// 判据来源：`application/ports/collaborationRuntimeMechanics.ts` 的端口契约，语义注释在
// `clarify/service.ts`（RFC-056 cross-clarify 短路 / 澄清轮开启）、
// `collaborationWorkgroupClarify.ts`（RFC-172/181 反问许可与自治遣散）、
// `clarify/queue.ts`（澄清队列上下文）与 `review.ts`（评审提示上下文）。

import {
  clarifyRoundFixture,
  nodeRunFixture,
  nodeRunOutputFixture,
  patchTaskFixture,
  readClarifyRoundFixtures,
  readNodeRunFixtures,
  readTaskFixtures,
  taskFixture,
  workflowFixture,
} from './helpers/model'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createCollaborationRuntimeMechanics } from '@/modules/collaboration/infrastructure/collaborationRuntimeMechanics'
import { encodeLineageSlotPath } from '@/modules/task-execution/domain/executionIntent'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { describeEachProvider } from './helpers/eachProvider'

const ulid = monotonicFactory()

const ASKER = 'asker'
const DESIGNER = 'designer'
const CROSS = 'cc'
const CLARIFY = 'cl'
const REVIEW = 'rv'
const WRITER = 'writer'
const WG_LEADER = '__wg_leader__'
const WG_CLARIFY = '__wg_clarify__'

let APP_HOME = ''

beforeAll(() => {
  APP_HOME = mkdtempSync(join(tmpdir(), 'aw-rfc359-w7-mech-'))
})

afterAll(() => {
  if (APP_HOME !== '') rmSync(APP_HOME, { recursive: true, force: true })
})

function definition(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: ASKER, kind: 'agent-single', agentName: 'agent-asker' } as WorkflowNode,
    { id: DESIGNER, kind: 'agent-single', agentName: 'agent-designer' } as WorkflowNode,
    { id: WRITER, kind: 'agent-single', agentName: 'agent-writer' } as WorkflowNode,
    { id: CROSS, kind: 'clarify-cross-agent', title: 'cc' } as WorkflowNode,
    { id: CLARIFY, kind: 'clarify', title: 'cl' } as WorkflowNode,
    { id: REVIEW, kind: 'review', title: 'Design Review' } as unknown as WorkflowNode,
  ]
  return {
    $schema_version: 6,
    inputs: [],
    nodes,
    edges: [
      {
        id: 'e_dataflow',
        source: { nodeId: DESIGNER, portName: 'out' },
        target: { nodeId: ASKER, portName: 'in' },
      },
      // cross-clarify 的提问者由 `asker.__clarify__ → cc.questions` 这条边确定
      // （`findQuestionerNodeForCrossClarify`）。
      {
        id: 'e_asker_cc',
        source: { nodeId: ASKER, portName: '__clarify__' },
        target: { nodeId: CROSS, portName: 'questions' },
      },
      {
        id: 'e_cc_questioner',
        source: { nodeId: CROSS, portName: 'to_questioner' },
        target: { nodeId: ASKER, portName: '__clarify_response__' },
      },
      {
        id: 'e_cc_designer',
        source: { nodeId: CROSS, portName: 'to_designer' },
        target: { nodeId: DESIGNER, portName: '__external_feedback__' },
      },
      // RFC-354 schema v6：被评审的来源就是 `__review_input__` 这条边。
      {
        id: 'e_writer_review',
        source: { nodeId: WRITER, portName: 'out' },
        target: { nodeId: REVIEW, portName: '__review_input__' },
      },
    ],
    outputs: [],
  } as unknown as WorkflowDefinition
}

async function seedTask(
  db: PersistenceDb,
  overrides: { status?: string; workgroupConfigJson?: string } = {},
): Promise<string> {
  const taskId = `t_${ulid()}`
  const snapshot = JSON.stringify(definition())
  await workflowFixture(db, {
    id: `wf_${taskId}`,
    name: 'rfc359-w7-mechanics',
    description: '',
    definition: snapshot,
    version: 1,
    schemaVersion: 6,
  })
  await taskFixture(db, {
    id: taskId,
    name: 'rfc359 w7 mechanics',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: snapshot,
    repoPath: '/tmp/aw-rfc359-w7-mech',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: (overrides.status ?? 'running') as 'running',
    inputs: '{}',
    startedAt: Date.now(),
    executionLineageId: taskId,
    lineageSlotPathJson: encodeLineageSlotPath([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
    ]),
    ...(overrides.workgroupConfigJson === undefined
      ? {}
      : { workgroupId: 'wg-rfc359-w7', workgroupConfigJson: overrides.workgroupConfigJson }),
  })
  return taskId
}

async function seedRun(
  db: PersistenceDb,
  taskId: string,
  nodeId: string,
  overrides: { status?: string; shardKey?: string | null } = {},
): Promise<string> {
  const id = `nr_${ulid()}`
  await nodeRunFixture(db, {
    id,
    taskId,
    nodeId,
    status: (overrides.status ?? 'done') as 'done',
    retryIndex: 0,
    iteration: 0,
    ...(overrides.shardKey === undefined ? {} : { shardKey: overrides.shardKey }),
  })
  return id
}

function question(id: string) {
  return {
    id,
    title: `${id}-title`,
    kind: 'single' as const,
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

describeEachProvider('RFC-359 W7 —— 协作运行期机制（CollaborationRuntimeMechanics）', (harness) => {
  // -------------------------------------------------------------------------
  // inspectCrossClarify —— RFC-056 的持久 stop 短路
  // -------------------------------------------------------------------------

  test('inspectCrossClarify —— 提问者无出边时返回 no-questioner，不动任何行', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runId = await seedRun(db, taskId, CROSS, { status: 'pending' })
    const mechanics = createCollaborationRuntimeMechanics(db, {
      taskRolePolicy: composeCollaborationTaskRolePolicy(),
      ...epoch2RuntimeTestPorts(db),
      taskLock: o2Ports(db).taskLock,
      ...{ upstreamAgents: o2Ports(db).upstreamAgents },
    })
    const orphanDefinition = JSON.parse(JSON.stringify(definition())) as WorkflowDefinition
    ;(orphanDefinition as unknown as { edges: unknown[] }).edges = []
    expect(
      await mechanics.inspectCrossClarify({
        taskId,
        crossClarifyNodeId: CROSS,
        nodeRunId: runId,
        definition: orphanDefinition,
      }),
    ).toEqual({ kind: 'no-questioner' })
    const rows = await readNodeRunFixtures(db, { id: runId }).then((rows) =>
      rows.map((row) => ({ status: row.status })),
    )
    expect(rows[0]?.status).toBe('pending')
  })

  test('inspectCrossClarify —— 提问者无 stop 指令时 awaiting，run 保持 pending', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runId = await seedRun(db, taskId, CROSS, { status: 'pending' })
    const mechanics = createCollaborationRuntimeMechanics(db, {
      taskRolePolicy: composeCollaborationTaskRolePolicy(),
      ...epoch2RuntimeTestPorts(db),
      taskLock: o2Ports(db).taskLock,
      ...{ upstreamAgents: o2Ports(db).upstreamAgents },
    })
    expect(
      await mechanics.inspectCrossClarify({
        taskId,
        crossClarifyNodeId: CROSS,
        nodeRunId: runId,
        definition: definition(),
      }),
    ).toEqual({ kind: 'awaiting' })
    const rows = await readNodeRunFixtures(db, { id: runId }).then((rows) =>
      rows.map((row) => ({ status: row.status })),
    )
    expect(rows[0]?.status).toBe('pending')
  })

  test('inspectCrossClarify —— 提问者 stop 时短路，node_run pending → done', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runId = await seedRun(db, taskId, CROSS, { status: 'pending' })
    const { taskNodeClarifyDirectives } = tablesOf(db)
    await insertOne(db, taskNodeClarifyDirectives, {
      taskId,
      nodeId: ASKER,
      shardKey: '',
      directive: 'stop',
      updatedAt: 1,
    })
    const mechanics = createCollaborationRuntimeMechanics(db, {
      taskRolePolicy: composeCollaborationTaskRolePolicy(),
      ...epoch2RuntimeTestPorts(db),
      taskLock: o2Ports(db).taskLock,
      ...{ upstreamAgents: o2Ports(db).upstreamAgents },
    })
    expect(
      await mechanics.inspectCrossClarify({
        taskId,
        crossClarifyNodeId: CROSS,
        nodeRunId: runId,
        definition: definition(),
      }),
    ).toEqual({ kind: 'short-circuit-stop' })
    const rows = await readNodeRunFixtures(db, { id: runId }).then((rows) =>
      rows.map((row) => ({ status: row.status, finishedAt: row.finishedAt })),
    )
    expect(rows[0]?.status).toBe('done')
    expect(rows[0]?.finishedAt).not.toBeNull()
  })

  test('inspectCrossClarify —— continue 指令不短路（RFC-123 节点级 last-write-wins）', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runId = await seedRun(db, taskId, CROSS, { status: 'pending' })
    const { taskNodeClarifyDirectives } = tablesOf(db)
    await insertOne(db, taskNodeClarifyDirectives, {
      taskId,
      nodeId: ASKER,
      shardKey: '',
      directive: 'continue',
      updatedAt: 1,
    })
    expect(
      await createCollaborationRuntimeMechanics(db, {
        taskRolePolicy: composeCollaborationTaskRolePolicy(),
        ...epoch2RuntimeTestPorts(db),
        taskLock: o2Ports(db).taskLock,
        ...{ upstreamAgents: o2Ports(db).upstreamAgents },
      }).inspectCrossClarify({
        taskId,
        crossClarifyNodeId: CROSS,
        nodeRunId: runId,
        definition: definition(),
      }),
    ).toEqual({ kind: 'awaiting' })
  })

  // -------------------------------------------------------------------------
  // getNodeClarifyDirective
  // -------------------------------------------------------------------------

  test('getNodeClarifyDirective —— 节点级与 per-asker 回退（RFC-207）', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const mechanics = createCollaborationRuntimeMechanics(db, {
      taskRolePolicy: composeCollaborationTaskRolePolicy(),
      ...epoch2RuntimeTestPorts(db),
      taskLock: o2Ports(db).taskLock,
      ...{ upstreamAgents: o2Ports(db).upstreamAgents },
    })
    expect(await mechanics.getNodeClarifyDirective({ taskId, nodeId: ASKER })).toBeUndefined()
    const { taskNodeClarifyDirectives } = tablesOf(db)
    await db.insert(taskNodeClarifyDirectives).values([
      { taskId, nodeId: ASKER, shardKey: '', directive: 'stop', updatedAt: 1 },
      { taskId, nodeId: ASKER, shardKey: 'a1', directive: 'continue', updatedAt: 2 },
    ])
    expect(await mechanics.getNodeClarifyDirective({ taskId, nodeId: ASKER })).toBe('stop')
    expect(await mechanics.getNodeClarifyDirective({ taskId, nodeId: ASKER, shardKey: 'a1' })).toBe(
      'continue',
    )
    expect(await mechanics.getNodeClarifyDirective({ taskId, nodeId: ASKER, shardKey: 'a2' })).toBe(
      'stop',
    )
  })

  // -------------------------------------------------------------------------
  // isTaskClarifySuppressed —— RFC-172/181 的反问许可
  // -------------------------------------------------------------------------

  test('isTaskClarifySuppressed —— 无工作组配置不抑制', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    expect(
      await createCollaborationRuntimeMechanics(db, {
        taskRolePolicy: composeCollaborationTaskRolePolicy(),
        ...epoch2RuntimeTestPorts(db),
        taskLock: o2Ports(db).taskLock,
        ...{ upstreamAgents: o2Ports(db).upstreamAgents },
      }).isTaskClarifySuppressed({ taskId }),
    ).toBe(false)
  })

  test('isTaskClarifySuppressed —— 全 agent 工作组恒抑制；有人类成员则看预算', async () => {
    const db = harness.db
    const agentsOnly = await seedTask(db, {
      workgroupConfigJson: JSON.stringify({ members: [{ memberType: 'agent' }] }),
    })
    const mechanics = createCollaborationRuntimeMechanics(db, {
      taskRolePolicy: composeCollaborationTaskRolePolicy(),
      ...epoch2RuntimeTestPorts(db),
      taskLock: o2Ports(db).taskLock,
      ...{ upstreamAgents: o2Ports(db).upstreamAgents },
    })
    expect(await mechanics.isTaskClarifySuppressed({ taskId: agentsOnly })).toBe(true)

    await patchTaskFixture(
      db,
      { id: agentsOnly },
      {
        workgroupConfigJson: JSON.stringify({
          members: [{ memberType: 'agent' }, { memberType: 'human' }],
          clarifyBudget: 2,
        }),
      },
    )
    // 不带 nodeId：只判「有没有人可问」
    expect(await mechanics.isTaskClarifySuppressed({ taskId: agentsOnly })).toBe(false)
    expect(
      await mechanics.isTaskClarifySuppressed({
        taskId: agentsOnly,
        nodeId: WG_LEADER,
        shardKey: null,
      }),
    ).toBe(false)
  })

  test('isTaskClarifySuppressed —— 预算耗尽 / stop 指令都抑制', async () => {
    const db = harness.db
    const taskId = await seedTask(db, {
      workgroupConfigJson: JSON.stringify({
        members: [{ memberType: 'agent' }, { memberType: 'human' }],
        clarifyBudget: 1,
      }),
    })
    const mechanics = createCollaborationRuntimeMechanics(db, {
      taskRolePolicy: composeCollaborationTaskRolePolicy(),
      ...epoch2RuntimeTestPorts(db),
      taskLock: o2Ports(db).taskLock,
      ...{ upstreamAgents: o2Ports(db).upstreamAgents },
    })
    const askingRun = await seedRun(db, taskId, WG_LEADER)
    const parkRun = await seedRun(db, taskId, WG_CLARIFY, { status: 'awaiting_human' })
    await clarifyRoundFixture(db, {
      id: `cr_${ulid()}`,
      taskId,
      kind: 'self',
      askingNodeId: WG_LEADER,
      askingNodeRunId: askingRun,
      askingShardKey: null,
      intermediaryNodeId: WG_CLARIFY,
      intermediaryNodeRunId: parkRun,
      iteration: 0,
      questions: '[]',
      status: 'awaiting_human',
      createdAt: Date.now(),
    })
    // 预算 1、已问 1 ⇒ 抑制
    expect(
      await mechanics.isTaskClarifySuppressed({ taskId, nodeId: WG_LEADER, shardKey: null }),
    ).toBe(true)

    // 预算 0 ⇒ 直接抑制（无需数已问次数）
    await patchTaskFixture(
      db,
      { id: taskId },
      {
        workgroupConfigJson: JSON.stringify({
          members: [{ memberType: 'agent' }, { memberType: 'human' }],
          clarifyBudget: 0,
        }),
      },
    )
    expect(
      await mechanics.isTaskClarifySuppressed({ taskId, nodeId: WG_LEADER, shardKey: null }),
    ).toBe(true)
  })

  test('isTaskClarifySuppressed —— per-asker stop 指令抑制该 asker', async () => {
    const db = harness.db
    const taskId = await seedTask(db, {
      workgroupConfigJson: JSON.stringify({
        members: [{ memberType: 'agent' }, { memberType: 'human' }],
        clarifyBudget: 5,
      }),
    })
    const mechanics = createCollaborationRuntimeMechanics(db, {
      taskRolePolicy: composeCollaborationTaskRolePolicy(),
      ...epoch2RuntimeTestPorts(db),
      taskLock: o2Ports(db).taskLock,
      ...{ upstreamAgents: o2Ports(db).upstreamAgents },
    })
    expect(
      await mechanics.isTaskClarifySuppressed({ taskId, nodeId: WG_LEADER, shardKey: null }),
    ).toBe(false)
    const { taskNodeClarifyDirectives } = tablesOf(db)
    // `wgClarifyAskerKey(leaderNodeId, …)` 恒为字面量 'leader'（工作组反问的单例 asker）。
    await insertOne(db, taskNodeClarifyDirectives, {
      taskId,
      nodeId: WG_LEADER,
      shardKey: 'leader',
      directive: 'stop',
      updatedAt: 1,
    })
    expect(
      await mechanics.isTaskClarifySuppressed({ taskId, nodeId: WG_LEADER, shardKey: null }),
    ).toBe(true)
  })

  // -------------------------------------------------------------------------
  // dismissOpenClarifyParksForAutonomous —— RFC-181 自治遣散
  // -------------------------------------------------------------------------

  test('dismissOpenClarifyParksForAutonomous —— 关闭未答轮、取消停靠 run、按模式回队', async () => {
    const db = harness.db
    const taskId = await seedTask(db, {
      workgroupConfigJson: JSON.stringify({ mode: 'leader_worker', members: [] }),
    })
    const askingRun = await seedRun(db, taskId, WG_LEADER)
    const parkRun = await seedRun(db, taskId, WG_CLARIFY, { status: 'awaiting_human' })
    const assignmentId = `wga_${ulid()}`
    const { workgroupAssignments } = tablesOf(db)
    await insertOne(db, workgroupAssignments, {
      id: assignmentId,
      taskId,
      round: 0,
      source: 'leader',
      title: 'item-1',
      status: 'awaiting_human',
      nodeRunId: parkRun,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const openRoundId = `cr_${ulid()}`
    await clarifyRoundFixture(db, {
      id: openRoundId,
      taskId,
      kind: 'self',
      askingNodeId: WG_LEADER,
      askingNodeRunId: askingRun,
      askingShardKey: assignmentId,
      intermediaryNodeId: WG_CLARIFY,
      intermediaryNodeRunId: parkRun,
      iteration: 0,
      questions: '[]',
      status: 'awaiting_human',
      createdAt: Date.now(),
    })
    // 已答轮不受影响
    const answeredRun = await seedRun(db, taskId, WG_CLARIFY)
    const answeredRoundId = `cr_${ulid()}`
    await clarifyRoundFixture(db, {
      id: answeredRoundId,
      taskId,
      kind: 'self',
      askingNodeId: WG_LEADER,
      askingNodeRunId: await seedRun(db, taskId, WG_LEADER),
      askingShardKey: null,
      intermediaryNodeId: WG_CLARIFY,
      intermediaryNodeRunId: answeredRun,
      iteration: 0,
      questions: '[]',
      answers: '[]',
      status: 'answered',
      createdAt: Date.now(),
      answeredAt: Date.now(),
    })

    const result = await createCollaborationRuntimeMechanics(db, {
      taskRolePolicy: composeCollaborationTaskRolePolicy(),
      ...epoch2RuntimeTestPorts(db),
      taskLock: o2Ports(db).taskLock,
      ...{ upstreamAgents: o2Ports(db).upstreamAgents },
    }).dismissOpenClarifyParksForAutonomous({ taskId })
    expect(result).toEqual({
      dismissedSessions: 1,
      canceledParkRuns: [{ nodeRunId: parkRun, nodeId: WG_CLARIFY }],
      requeuedAssignments: [{ id: assignmentId, to: 'dispatched' }],
    })
    const rounds = await readClarifyRoundFixtures(db, { taskId }).then((rows) =>
      rows.map((row) => ({ id: row.id, status: row.status })),
    )
    expect(Object.fromEntries(rounds.map((row) => [row.id, row.status]))).toEqual({
      [openRoundId]: 'canceled',
      [answeredRoundId]: 'answered',
    })
    const parked = await readNodeRunFixtures(db, { id: parkRun }).then((rows) =>
      rows.map((row) => ({ status: row.status })),
    )
    expect(parked[0]?.status).toBe('canceled')
    const assignment = await db
      .select({ status: workgroupAssignments.status, nodeRunId: workgroupAssignments.nodeRunId })
      .from(workgroupAssignments)
      .where(eq(workgroupAssignments.id, assignmentId))
    expect(assignment[0]).toEqual({ status: 'dispatched', nodeRunId: null })
  })

  test('dismissOpenClarifyParksForAutonomous —— free_collab 模式回到 open 并清空领取人', async () => {
    const db = harness.db
    const taskId = await seedTask(db, {
      workgroupConfigJson: JSON.stringify({ mode: 'free_collab', members: [] }),
    })
    const askingRun = await seedRun(db, taskId, WG_LEADER)
    const parkRun = await seedRun(db, taskId, WG_CLARIFY, { status: 'awaiting_human' })
    const assignmentId = `wga_${ulid()}`
    const { workgroupAssignments } = tablesOf(db)
    await insertOne(db, workgroupAssignments, {
      id: assignmentId,
      taskId,
      round: 0,
      source: 'self_claim',
      title: 'item-1',
      status: 'awaiting_human',
      assigneeMemberId: 'member-1',
      nodeRunId: parkRun,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await clarifyRoundFixture(db, {
      id: `cr_${ulid()}`,
      taskId,
      kind: 'self',
      askingNodeId: WG_LEADER,
      askingNodeRunId: askingRun,
      askingShardKey: assignmentId,
      intermediaryNodeId: WG_CLARIFY,
      intermediaryNodeRunId: parkRun,
      iteration: 0,
      questions: '[]',
      status: 'awaiting_human',
      createdAt: Date.now(),
    })
    const result = await createCollaborationRuntimeMechanics(db, {
      taskRolePolicy: composeCollaborationTaskRolePolicy(),
      ...epoch2RuntimeTestPorts(db),
      taskLock: o2Ports(db).taskLock,
      ...{ upstreamAgents: o2Ports(db).upstreamAgents },
    }).dismissOpenClarifyParksForAutonomous({ taskId })
    expect(result.requeuedAssignments).toEqual([{ id: assignmentId, to: 'open' }])
    const assignment = await db
      .select({
        status: workgroupAssignments.status,
        assigneeMemberId: workgroupAssignments.assigneeMemberId,
      })
      .from(workgroupAssignments)
      .where(eq(workgroupAssignments.id, assignmentId))
    expect(assignment[0]).toEqual({ status: 'open', assigneeMemberId: null })
  })

  test('dismissOpenClarifyParksForAutonomous —— 外层事务回滚必须带走它的写（重入语义）', async () => {
    const db = harness.db
    const taskId = await seedTask(db, {
      workgroupConfigJson: JSON.stringify({ mode: 'leader_worker', members: [] }),
    })
    const askingRun = await seedRun(db, taskId, WG_LEADER)
    const parkRun = await seedRun(db, taskId, WG_CLARIFY, { status: 'awaiting_human' })
    const roundId = `cr_${ulid()}`
    await clarifyRoundFixture(db, {
      id: roundId,
      taskId,
      kind: 'self',
      askingNodeId: WG_LEADER,
      askingNodeRunId: askingRun,
      askingShardKey: null,
      intermediaryNodeId: WG_CLARIFY,
      intermediaryNodeRunId: parkRun,
      iteration: 0,
      questions: '[]',
      status: 'awaiting_human',
      createdAt: Date.now(),
    })
    const mechanics = createCollaborationRuntimeMechanics(db, {
      taskRolePolicy: composeCollaborationTaskRolePolicy(),
      ...epoch2RuntimeTestPorts(db),
      taskLock: o2Ports(db).taskLock,
      ...{ upstreamAgents: o2Ports(db).upstreamAgents },
    })
    const { databaseSessionFor } = await import('@/platform/persistence/databaseTransaction')
    await expect(
      databaseSessionFor(db).transaction(async () => {
        await mechanics.dismissOpenClarifyParksForAutonomous({ taskId })
        throw new Error('rollback-probe')
      }),
    ).rejects.toThrow('rollback-probe')
    const rows = await readClarifyRoundFixtures(db, { id: roundId }).then((rows) =>
      rows.map((row) => ({ status: row.status })),
    )
    expect(rows[0]?.status).toBe('awaiting_human')
  })

  // -------------------------------------------------------------------------
  // openAgentClarify —— 开一轮反问（park 行 + clarify_rounds 投影）
  // -------------------------------------------------------------------------

  test('openAgentClarify —— self 轮落一行 awaiting_human 的 clarify_round 并停靠中介 run', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const askingRunId = await seedRun(db, taskId, ASKER, { status: 'running' })
    const receipt = await createCollaborationRuntimeMechanics(db, {
      taskRolePolicy: composeCollaborationTaskRolePolicy(),
      ...epoch2RuntimeTestPorts(db),
      taskLock: o2Ports(db).taskLock,
      ...{ upstreamAgents: o2Ports(db).upstreamAgents },
    }).openAgentClarify({
      kind: 'self',
      taskId,
      askingNodeId: ASKER,
      askingNodeRunId: askingRunId,
      askingShardKey: null,
      iteration: 0,
      intermediaryNodeId: CLARIFY,
      questions: [question('q1'), question('q2')],
    })
    expect(receipt.intermediaryNodeRunId.length).toBeGreaterThan(0)
    const rounds = await readClarifyRoundFixtures(db, { taskId })
    expect(rounds).toHaveLength(1)
    expect(rounds[0]).toMatchObject({
      kind: 'self',
      askingNodeId: ASKER,
      askingNodeRunId: askingRunId,
      intermediaryNodeId: CLARIFY,
      intermediaryNodeRunId: receipt.intermediaryNodeRunId,
      status: 'awaiting_human',
    })
    expect(JSON.parse(rounds[0]!.questions).map((q: { id: string }) => q.id)).toEqual(['q1', 'q2'])
    const park = await readNodeRunFixtures(db, { id: receipt.intermediaryNodeRunId }).then((rows) =>
      rows.map((row) => ({ status: row.status, nodeId: row.nodeId })),
    )
    expect(park[0]).toEqual({ status: 'awaiting_human', nodeId: CLARIFY })
    const task = await readTaskFixtures(db, { id: taskId }).then((rows) =>
      rows.map((row) => ({ status: row.status })),
    )
    expect(task[0]?.status).toBe('awaiting_human')
  })

  test('openAgentClarify —— cross 轮记录目标消费节点', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const askingRunId = await seedRun(db, taskId, ASKER, { status: 'running' })
    const receipt = await createCollaborationRuntimeMechanics(db, {
      taskRolePolicy: composeCollaborationTaskRolePolicy(),
      ...epoch2RuntimeTestPorts(db),
      taskLock: o2Ports(db).taskLock,
      ...{ upstreamAgents: o2Ports(db).upstreamAgents },
    }).openAgentClarify({
      kind: 'cross',
      taskId,
      askingNodeId: ASKER,
      askingNodeRunId: askingRunId,
      targetConsumerNodeId: DESIGNER,
      loopIter: 0,
      intermediaryNodeId: CROSS,
      questions: [question('q1')],
    })
    const rounds = await readClarifyRoundFixtures(db, {
      intermediaryNodeRunId: receipt.intermediaryNodeRunId,
    })
    expect(rounds[0]).toMatchObject({
      kind: 'cross',
      intermediaryNodeId: CROSS,
      targetConsumerNodeId: DESIGNER,
      status: 'awaiting_human',
    })
  })

  // -------------------------------------------------------------------------
  // resolveBorrowForNode —— RFC-127 借壳顶替
  // -------------------------------------------------------------------------

  test('resolveBorrowForNode —— 无改派条目时返回 null', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    expect(
      await createCollaborationRuntimeMechanics(db, {
        taskRolePolicy: composeCollaborationTaskRolePolicy(),
        ...epoch2RuntimeTestPorts(db),
        taskLock: o2Ports(db).taskLock,
        ...{ upstreamAgents: o2Ports(db).upstreamAgents },
      }).resolveBorrowForNode({
        taskId,
        nodeId: DESIGNER,
        iteration: 0,
        definition: definition(),
      }),
    ).toBeNull()
  })

  // RFC-131 T4 起两条台账都是 move 语义，`borrowAgentName` 结构上恒 null；这条用例锁的是
  // 「有已派发条目时两条台账都被扫过且不误报」——SQL 在两个引擎上都真的跑了一遍。
  test('resolveBorrowForNode —— 有已派发条目时扫两条台账，单台账开着仍返回 null（借壳已退役）', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const askingRun = await seedRun(db, taskId, ASKER)
    const parkRun = await seedRun(db, taskId, CLARIFY, { status: 'awaiting_human' })
    const roundId = `cr_${ulid()}`
    const { taskQuestions } = tablesOf(db)
    await clarifyRoundFixture(db, {
      id: roundId,
      taskId,
      kind: 'self',
      askingNodeId: ASKER,
      askingNodeRunId: askingRun,
      intermediaryNodeId: CLARIFY,
      intermediaryNodeRunId: parkRun,
      iteration: 0,
      questions: JSON.stringify([question('q1')]),
      answers: JSON.stringify([
        {
          questionId: 'q1',
          selectedOptionIndices: [0],
          selectedOptionLabels: ['A'],
          customText: '',
        },
      ]),
      status: 'answered',
      createdAt: Date.now(),
      answeredAt: Date.now(),
    })
    const now = Date.now()
    await insertOne(db, taskQuestions, {
      id: `tq_${ulid()}`,
      taskId,
      originNodeRunId: parkRun,
      questionId: 'q1',
      questionTitle: 'q1-title',
      sourceKind: 'self',
      roleKind: 'self',
      iteration: 0,
      loopIter: 0,
      defaultTargetNodeId: ASKER,
      overrideTargetNodeId: DESIGNER,
      sealedAt: now,
      sealedBy: 'u1',
      dispatchedAt: now,
      dispatchedBy: 'u1',
      createdAt: now,
      updatedAt: now,
    })
    expect(
      await createCollaborationRuntimeMechanics(db, {
        taskRolePolicy: composeCollaborationTaskRolePolicy(),
        ...epoch2RuntimeTestPorts(db),
        taskLock: o2Ports(db).taskLock,
        ...{ upstreamAgents: o2Ports(db).upstreamAgents },
      }).resolveBorrowForNode({
        taskId,
        nodeId: DESIGNER,
        iteration: 0,
        definition: definition(),
      }),
    ).toBeNull()
    // 提问者本人这一侧同样不报借壳。
    expect(
      await createCollaborationRuntimeMechanics(db, {
        taskRolePolicy: composeCollaborationTaskRolePolicy(),
        ...epoch2RuntimeTestPorts(db),
        taskLock: o2Ports(db).taskLock,
        ...{ upstreamAgents: o2Ports(db).upstreamAgents },
      }).resolveBorrowForNode({
        taskId,
        nodeId: ASKER,
        iteration: 0,
        definition: definition(),
      }),
    ).toBeNull()
  })

  // -------------------------------------------------------------------------
  // buildClarifyQueueContext —— 已派发条目的提示块
  // -------------------------------------------------------------------------

  test('buildClarifyQueueContext —— 无已派发条目时 undefined', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const dispatchedRunId = await seedRun(db, taskId, ASKER, { status: 'running' })
    expect(
      await createCollaborationRuntimeMechanics(db, {
        taskRolePolicy: composeCollaborationTaskRolePolicy(),
        ...epoch2RuntimeTestPorts(db),
        taskLock: o2Ports(db).taskLock,
        ...{ upstreamAgents: o2Ports(db).upstreamAgents },
      }).buildClarifyQueueContext({
        definition: definition(),
        taskId,
        consumerNodeId: ASKER,
        dispatchedRunId,
        iteration: 0,
      }),
    ).toBeUndefined()
  })

  test('buildClarifyQueueContext —— 已答已派发的条目渲染成队列块并带上来源 run', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const askingRun = await seedRun(db, taskId, ASKER)
    const parkRun = await seedRun(db, taskId, CLARIFY, { status: 'done' })
    const { taskQuestions } = tablesOf(db)
    await clarifyRoundFixture(db, {
      id: `cr_${ulid()}`,
      taskId,
      kind: 'self',
      askingNodeId: ASKER,
      askingNodeRunId: askingRun,
      intermediaryNodeId: CLARIFY,
      intermediaryNodeRunId: parkRun,
      iteration: 0,
      questions: JSON.stringify([question('q1')]),
      answers: JSON.stringify([
        {
          questionId: 'q1',
          selectedOptionIndices: [0],
          selectedOptionLabels: ['A'],
          customText: '',
        },
      ]),
      status: 'answered',
      createdAt: Date.now(),
      answeredAt: Date.now(),
    })
    const now = Date.now()
    const dispatchedRunId = await seedRun(db, taskId, ASKER, { status: 'running' })
    await insertOne(db, taskQuestions, {
      id: `tq_${ulid()}`,
      taskId,
      originNodeRunId: parkRun,
      questionId: 'q1',
      questionTitle: 'q1-title',
      sourceKind: 'self',
      roleKind: 'self',
      iteration: 0,
      loopIter: 0,
      defaultTargetNodeId: ASKER,
      overrideTargetNodeId: null,
      sealedAt: now,
      sealedBy: 'u1',
      dispatchedAt: now,
      dispatchedBy: 'u1',
      triggerRunId: dispatchedRunId,
      createdAt: now,
      updatedAt: now,
    })
    const context = await createCollaborationRuntimeMechanics(db, {
      taskRolePolicy: composeCollaborationTaskRolePolicy(),
      ...epoch2RuntimeTestPorts(db),
      taskLock: o2Ports(db).taskLock,
      ...{ upstreamAgents: o2Ports(db).upstreamAgents },
    }).buildClarifyQueueContext({
      definition: definition(),
      taskId,
      consumerNodeId: ASKER,
      dispatchedRunId,
      iteration: 0,
    })
    expect(context?.block).toContain('q1-title')
    expect(context?.sourceRunIds).toEqual([parkRun])
  })

  // -------------------------------------------------------------------------
  // dispatchReviewNode —— 评审门开启
  // -------------------------------------------------------------------------

  test('dispatchReviewNode —— 任务不存在 / 已取消 / 非可派发状态各自的收场', async () => {
    const db = harness.db
    const reviewNode = definition().nodes.find((node) => node.id === REVIEW)!
    const mechanics = createCollaborationRuntimeMechanics(db, {
      taskRolePolicy: composeCollaborationTaskRolePolicy(),
      ...epoch2RuntimeTestPorts(db),
      taskLock: o2Ports(db).taskLock,
      ...{ upstreamAgents: o2Ports(db).upstreamAgents },
    })
    const base = {
      appHome: APP_HOME,
      definition: definition(),
      node: reviewNode,
      iteration: 0,
      scopeRoot: APP_HOME,
    }
    expect(await mechanics.dispatchReviewNode({ ...base, taskId: 't_missing' })).toMatchObject({
      kind: 'failed',
      message: 'task-not-found',
    })

    const canceled = await seedTask(db, { status: 'canceled' })
    expect(await mechanics.dispatchReviewNode({ ...base, taskId: canceled })).toMatchObject({
      kind: 'canceled',
      message: 'task-canceled',
    })

    const parked = await seedTask(db, { status: 'awaiting_human' })
    expect(await mechanics.dispatchReviewNode({ ...base, taskId: parked })).toMatchObject({
      kind: 'failed',
      message: 'review-task-not-dispatchable',
    })
  })

  test('dispatchReviewNode —— 上游未 done 时失败，落定后停靠成 awaiting_review 并建 doc_version', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const reviewNode = definition().nodes.find((node) => node.id === REVIEW)!
    const mechanics = createCollaborationRuntimeMechanics(db, {
      taskRolePolicy: composeCollaborationTaskRolePolicy(),
      ...epoch2RuntimeTestPorts(db),
      taskLock: o2Ports(db).taskLock,
      ...{ upstreamAgents: o2Ports(db).upstreamAgents },
    })
    const request = {
      taskId,
      appHome: APP_HOME,
      definition: definition(),
      node: reviewNode,
      iteration: 0,
      scopeRoot: APP_HOME,
    }
    const missingUpstream = await mechanics.dispatchReviewNode(request)
    expect(missingUpstream.kind).toBe('failed')

    const writerRun = await seedRun(db, taskId, WRITER, { status: 'done' })
    const { docVersions } = tablesOf(db)
    await nodeRunOutputFixture(db, {
      nodeRunId: writerRun,
      portName: 'out',
      content: '# Draft\n\nreview me\n',
    })

    const dispatched = await mechanics.dispatchReviewNode(request)
    expect(dispatched).toMatchObject({ kind: 'awaiting_review', message: 'awaiting_review' })
    const versions = await db.select().from(docVersions).where(eq(docVersions.taskId, taskId))
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({
      reviewNodeId: REVIEW,
      sourceNodeId: WRITER,
      sourcePortName: 'out',
      versionIndex: 1,
      decision: 'pending',
    })
    const reviewRuns = await readNodeRunFixtures(db, { nodeId: REVIEW }).then((rows) =>
      rows.map((row) => ({ id: row.id, status: row.status })),
    )
    expect(reviewRuns).toHaveLength(1)
    expect(reviewRuns[0]?.status).toBe('awaiting_review')
    expect(versions[0]?.reviewNodeRunId).toBe(reviewRuns[0]!.id)
    const task = await readTaskFixtures(db, { id: taskId }).then((rows) =>
      rows.map((row) => ({ status: row.status })),
    )
    expect(task[0]?.status).toBe('awaiting_review')

    // 幂等：同一轮再派发一次不产生第二个版本
    const again = await mechanics.dispatchReviewNode(request)
    expect(again.kind).toBe('awaiting_review')
    expect((await db.select().from(docVersions).where(eq(docVersions.taskId, taskId))).length).toBe(
      1,
    )
  })

  // -------------------------------------------------------------------------
  // buildReviewPromptContext —— 迭代重跑时把上一轮评论带进提示
  // -------------------------------------------------------------------------

  test('buildReviewPromptContext —— 没有已决定版本时 undefined', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    expect(
      await createCollaborationRuntimeMechanics(db, {
        taskRolePolicy: composeCollaborationTaskRolePolicy(),
        ...epoch2RuntimeTestPorts(db),
        taskLock: o2Ports(db).taskLock,
        ...{ upstreamAgents: o2Ports(db).upstreamAgents },
      }).buildReviewPromptContext({
        appHome: APP_HOME,
        upstreamNodeId: WRITER,
        taskId,
        iteration: 0,
      }),
    ).toBeUndefined()
  })

  test('buildReviewPromptContext —— 取最近一次 iterated 版本的正文与决定理由', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const reviewRunId = await seedRun(db, taskId, REVIEW, { status: 'done' })
    const bodyPath = `reviews/${taskId}/v1.md`
    const absolute = join(APP_HOME, bodyPath)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, '# Draft\n\nfirst pass\n', 'utf8')
    const { docVersions } = tablesOf(db)
    await insertOne(db, docVersions, {
      id: `dv_${ulid()}`,
      taskId,
      reviewNodeId: REVIEW,
      reviewNodeRunId: reviewRunId,
      sourceNodeId: WRITER,
      sourcePortName: 'out',
      versionIndex: 1,
      reviewIteration: 0,
      ...contentRowColumns(legacyContentRef('review-body-path', 'local-file', bodyPath)),
      commentsJson: '[]',
      decision: 'iterated',
      decisionReason: 'needs another pass',
      createdAt: 1_000,
      decidedAt: 2_000,
      decidedBy: 'u1',
    })
    const context = await createCollaborationRuntimeMechanics(db, {
      taskRolePolicy: composeCollaborationTaskRolePolicy(),
      ...epoch2RuntimeTestPorts(db),
      taskLock: o2Ports(db).taskLock,
      ...{ upstreamAgents: o2Ports(db).upstreamAgents },
    }).buildReviewPromptContext({
      appHome: APP_HOME,
      upstreamNodeId: WRITER,
      taskId,
      iteration: 0,
    })
    expect(context).toEqual({ comments: 'needs another pass', iterateTargetPort: 'out' })

    // rejected 轮走另一条构造分支（只带 rejection）
    await db
      .update(docVersions)
      .set({ decision: 'rejected', decisionReason: 'not acceptable' })
      .where(eq(docVersions.taskId, taskId))
    expect(
      await createCollaborationRuntimeMechanics(db, {
        taskRolePolicy: composeCollaborationTaskRolePolicy(),
        ...epoch2RuntimeTestPorts(db),
        taskLock: o2Ports(db).taskLock,
        ...{ upstreamAgents: o2Ports(db).upstreamAgents },
      }).buildReviewPromptContext({
        appHome: APP_HOME,
        upstreamNodeId: WRITER,
        taskId,
        iteration: 0,
      }),
    ).toEqual({ rejection: 'not acceptable' })

    // approved / superseded / pending 都不产生上下文
    await db.update(docVersions).set({ decision: 'approved' }).where(eq(docVersions.taskId, taskId))
    expect(
      await createCollaborationRuntimeMechanics(db, {
        taskRolePolicy: composeCollaborationTaskRolePolicy(),
        ...epoch2RuntimeTestPorts(db),
        taskLock: o2Ports(db).taskLock,
        ...{ upstreamAgents: o2Ports(db).upstreamAgents },
      }).buildReviewPromptContext({
        appHome: APP_HOME,
        upstreamNodeId: WRITER,
        taskId,
        iteration: 0,
      }),
    ).toBeUndefined()
  })
})
