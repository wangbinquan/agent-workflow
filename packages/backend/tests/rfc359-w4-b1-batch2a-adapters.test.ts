// RFC-359 W4-B1 批 2a —— 五对只差客户端类型 / 同步异步形态的适配器合成一份实现，两个引擎各跑一遍：
// 节点激活快照读取、任务工件路径查询、动态工作流状态持久化、RFC-354 frame 回填存储、
// 人工门 continuation 的 effect 检视（ready / 无 claimed intent 两条路径）。

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { PLATFORM_INPUTS_DIR } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { OwnershipToken } from '@/modules/task-execution/domain/ownership'
import {
  agents,
  clarifyRounds,
  maintenanceState,
  nodeRunOutputs,
  nodeRuns,
  taskExecutionIntents,
  tasks,
  workflows,
  workgroupTaskState,
} from '@/db/schema'
import { FRAME_BACKFILL_MARKER_KEY } from '@/modules/task-execution/application/frameBackfillJob'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { DrizzleDynamicWorkflowPersistence } from '@/modules/task-execution/infrastructure/dynamicWorkflowPersistence'
import { createFrameBackfillStore } from '@/modules/task-execution/infrastructure/frameBackfillStore'
import { DrizzleGateContinuationEffectPersistence } from '@/modules/task-execution/infrastructure/gateContinuationEffectPersistence'
import { DrizzleNodeActivationSnapshotReader } from '@/modules/task-execution/infrastructure/nodeActivationSnapshotReader'
import { DrizzleTaskArtifactPathQueries } from '@/modules/task-execution/infrastructure/taskArtifactPathQueries'
import { describeEachProvider } from './helpers/eachProvider'

const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'

async function seedTask(
  db: ProviderNeutralDatabase,
  over: Partial<typeof tasks.$inferInsert> = {},
): Promise<string> {
  const id = `t_${ulid()}`
  const workflowId = `wf_${ulid()}`
  await db.insert(workflows).values({
    id: workflowId,
    name: workflowId,
    description: '',
    definition: SNAPSHOT,
    version: 1,
    schemaVersion: 2,
  })
  await db.insert(tasks).values({
    id,
    name: id,
    workflowId,
    workflowSnapshot: SNAPSHOT,
    repoPath: '/tmp/repo',
    worktreePath: `/tmp/worktree/${id}`,
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'running',
    inputs: '{}',
    startedAt: 1,
    ...over,
  })
  return id
}

describeEachProvider('RFC-359 W4-B1 批 2a —— 节点激活快照读取', (harness) => {
  test('按节点列 run、按 id 取单个 run、输出端口的激活位图', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runA = ulid()
    const runB = ulid()
    await db.insert(nodeRuns).values([
      { id: runA, taskId, nodeId: 'n', status: 'done', retryIndex: 0, iteration: 0 },
      {
        id: runB,
        taskId,
        nodeId: 'n',
        status: 'running',
        retryIndex: 1,
        iteration: 0,
        parentNodeRunId: runA,
      },
      { id: ulid(), taskId, nodeId: 'other', status: 'done', retryIndex: 0, iteration: 0 },
    ])
    await db.insert(nodeRunOutputs).values([
      { nodeRunId: runA, portName: 'out', content: 'x', active: true },
      { nodeRunId: runA, portName: 'aux', content: 'y', active: false },
    ])
    const reader = new DrizzleNodeActivationSnapshotReader(db)
    const runs = await reader.findRuns(taskId, 'n')
    expect(runs.map((run) => run.id).sort()).toEqual([runA, runB].sort())
    expect(await reader.findRun(runB)).toMatchObject({ id: runB, parentNodeRunId: runA })
    expect(await reader.findRun('missing')).toBeNull()
    expect([...(await reader.findOutputActivation(runA)).entries()].sort()).toEqual([
      ['aux', false],
      ['out', true],
    ])
  })
})

describeEachProvider('RFC-359 W4-B1 批 2a —— 任务工件路径查询', (harness) => {
  test('归档过的输出路径与平台输入路径合并；没有归档输出时只剩平台输入', async () => {
    const db = harness.db
    // 平台输入路径只允许出现在内部目录任务上（域层校验）。
    const taskId = await seedTask(db, {
      spaceKind: 'internal',
      platformInputPathsJson: JSON.stringify([`${PLATFORM_INPUTS_DIR}/spec.md`]),
    })
    const runId = ulid()
    await db
      .insert(nodeRuns)
      .values({ id: runId, taskId, nodeId: 'n', status: 'done', retryIndex: 0, iteration: 0 })
    await db.insert(nodeRunOutputs).values([
      {
        nodeRunId: runId,
        portName: 'doc',
        content: 'a',
        active: true,
        archiveJson: JSON.stringify({ paths: ['/tmp/worktree/artifact.md'] }),
      },
      { nodeRunId: runId, portName: 'plain', content: 'b', active: true },
    ])
    const queries = new DrizzleTaskArtifactPathQueries(db)
    const forced = await queries.forcedPaths(taskId)
    expect(forced).toContain(`${PLATFORM_INPUTS_DIR}/spec.md`)
    const bare = await seedTask(db)
    expect(await queries.forcedPaths(bare)).toEqual([])
  })
})

describeEachProvider('RFC-359 W4-B1 批 2a —— 动态工作流状态持久化', (harness) => {
  test('loadTask / loadAgent / 等待确认 run / 计数 / saveState 在两个引擎上同形', async () => {
    const db = harness.db
    const taskId = await seedTask(db, { workgroupConfigJson: '{"k":1}' })
    await db.insert(workgroupTaskState).values({ taskId, dwStateJson: null, updatedAt: 1 })
    const agentId = `agent_${ulid()}`
    await db.insert(agents).values({
      id: agentId,
      name: `dw-${agentId.slice(-6)}`,
      description: '',
      outputs: '[]',
    })
    await db.insert(nodeRuns).values([
      {
        id: ulid(),
        taskId,
        nodeId: 'dw',
        status: 'awaiting_review',
        retryIndex: 0,
        iteration: 0,
        rerunCause: 'dw-confirm',
      },
      { id: ulid(), taskId, nodeId: 'dw', status: 'done', retryIndex: 1, iteration: 0 },
    ])
    const persistence = new DrizzleDynamicWorkflowPersistence(db)
    expect(await persistence.loadTask(taskId)).toMatchObject({
      workgroupConfigJson: '{"k":1}',
      dwStateJson: null,
    })
    expect(await persistence.loadTask('missing')).toBeNull()
    expect((await persistence.loadAgent(agentId))?.id).toBe(agentId)
    expect(await persistence.loadAgent('missing')).toBeNull()
    expect(await persistence.hasAwaitingConfirmationRun(taskId, 'dw-confirm')).toBe(true)
    expect(await persistence.hasAwaitingConfirmationRun(taskId, 'other')).toBe(false)
    expect(await persistence.countNodeRuns(taskId, 'dw')).toBe(2)
    expect(await persistence.countNodeRuns(taskId, 'nope')).toBe(0)
    await persistence.saveState(taskId, { phase: 'generating', round: 1 } as never, 42)
    const row = (
      await db.select().from(workgroupTaskState).where(eq(workgroupTaskState.taskId, taskId))
    )[0]
    expect(row?.updatedAt).toBe(42)
    expect(JSON.parse(row?.dwStateJson ?? '{}')).toMatchObject({ phase: 'generating' })
  })
})

describeEachProvider('RFC-359 W4-B1 批 2a —— frame 回填存储', (harness) => {
  test('标记读写、任务枚举、run 帧回填（原子）与 clarify 轮次对齐', async () => {
    const db = harness.db
    const store = createFrameBackfillStore(db)
    expect(await store.readMarker()).toBeNull()
    await store.writeMarker('v1')
    await store.writeMarker('v2')
    expect(await store.readMarker()).toBe('v2')
    expect(
      (
        await db
          .select()
          .from(maintenanceState)
          .where(eq(maintenanceState.key, FRAME_BACKFILL_MARKER_KEY))
      ).length,
    ).toBe(1)

    const taskId = await seedTask(db)
    const container = ulid()
    const inner = ulid()
    await db.insert(nodeRuns).values([
      { id: container, taskId, nodeId: 'loop', status: 'running', retryIndex: 0, iteration: 0 },
      { id: inner, taskId, nodeId: 'inner', status: 'done', retryIndex: 0, iteration: 0 },
    ])
    expect(await store.listTaskIds()).toContain(taskId)
    const loaded = await store.loadTask(taskId)
    expect(loaded?.runs.map((run) => run.id).sort()).toEqual([container, inner].sort())
    expect(await store.loadTask('missing')).toBeNull()

    await store.applyRunFrames([{ id: inner, containerRunId: container, scopePath: 'loop/0' }])
    const framed = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, inner)))[0]
    expect(framed).toMatchObject({ containerRunId: container, scopePath: 'loop/0' })

    // clarify 轮次：中介 run 已有帧、轮次还没有 ⇒ 对齐；已对齐的不再计数。
    await db.insert(clarifyRounds).values({
      id: ulid(),
      taskId,
      kind: 'self',
      askingNodeId: 'inner',
      askingNodeRunId: inner,
      intermediaryNodeId: 'clarify',
      intermediaryNodeRunId: inner,
      status: 'answered',
      questionsJson: '[]',
      createdAt: 1,
    })
    expect(await store.alignClarifyRounds(taskId)).toBe(1)
    expect(await store.alignClarifyRounds(taskId)).toBe(0)
  })
})

describeEachProvider('RFC-359 W4-B1 批 2a —— 人工门 continuation 的 effect 检视', (harness) => {
  test('非 gate-continuation 的 claimed intent ⇒ ready；intent 缺席 / 未 claimed ⇒ task-execution-stale-owner', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const persistence = createTaskExecutionPersistence(db)
    const gate = new DrizzleGateContinuationEffectPersistence(db, persistence.effects)
    const intentId = `intent_${ulid()}`
    await db.insert(taskExecutionIntents).values({
      id: intentId,
      taskId,
      kind: 'launch',
      state: 'claimed',
      source: 'rest',
      requestHash: 'h',
      payloadJson: '{}',
      executionLineageId: taskId,
      continuationSlotKey: `${taskId}:root`,
      slotPathJson: '[]',
      expectedTaskRevision: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    // inspect 只按 taskId / intentId 读 intent，不消费 token（prepare / settle 才用）。
    const token = {} as OwnershipToken
    expect(await gate.inspect({ taskId, intentId, token })).toEqual({ kind: 'ready' })
    await expect(gate.inspect({ taskId, intentId: 'missing', token })).rejects.toMatchObject({
      code: 'task-execution-stale-owner',
    })
  })
})

test('源码锁：五份实现里不再出现 provider 名，孪生已删除', () => {
  const root = resolve(import.meta.dir, '..', 'src', 'modules', 'task-execution', 'infrastructure')
  for (const file of [
    'gateContinuationEffectPersistence.ts',
    'nodeActivationSnapshotReader.ts',
    'taskArtifactPathQueries.ts',
    'dynamicWorkflowPersistence.ts',
    'frameBackfillStore.ts',
  ]) {
    const source = readFileSync(resolve(root, file), 'utf8')
    expect(source).toContain("from '@/db/query'")
    expect(source).not.toMatch(/DbClient|PostgresqlDatabaseClient|dbTxSync\(|db\.transaction\(/u)
  }
  for (const stem of [
    'GateContinuationEffectPersistence',
    'NodeActivationSnapshotReader',
    'TaskArtifactPathQueries',
    'DynamicWorkflowPersistence',
    'FrameBackfillStore',
  ]) {
    expect(() => readFileSync(resolve(root, `sqlite${stem}.ts`))).toThrow()
    expect(() => readFileSync(resolve(root, `postgresql${stem}.ts`))).toThrow()
  }
})
