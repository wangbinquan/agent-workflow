// RFC-359 W8 —— `SourceTerminationParticipant` 的**双引擎对拍**。
//
// 判定：**真重复**。两侧服务同一个 `TaskSourceTerminationParticipant` 端口、同一段算法
// （扫描绑定 → 每目标一次 `applyOne` → 围栏/状态/节点取消/intent 终态化/owner 撤销 → 收据），
// 连 `fenceFor` / `terminalCause` 两个私有函数都是逐字一样的两份。行数（485 / 473）在这一对
// 上不误导：SQLite 侧那 485 行里确实转发给了 `services/lifecycle.ts` 的 `setTaskStatus` 内核，
// 但 PG 侧把同一件事**手写内联**（第 302-348 行的条件 UPDATE + committed event），不是薄壳。
//
// 「用户看到什么」这一层的判据（不是「两边都调了同一个函数」）：
//   · MR/PR 关闭或合入后，任务以什么状态收场、错误摘要写的是哪句中文；
//   · 任务下面那些还开着的节点跑批有没有被一起取消、取消原因写的是哪个 code；
//   · 任务的工作区**有没有被认领回收**（RFC-300：webhook 来源的 remote/scratch 任务终态时
//     连带回收工作树；UI 上就是「工作区已回收」，磁盘上就是那棵 worktree 消失）；
//   · 重放同一条 delivery 会不会把任务再改一遍。
//
// 这份对拍在两个旧实现上第一次跑出来的差额（**只有一处**，但它是用户可见的整条 RFC-300 链路）：
//   · **PG 侧整条工作区回收从不发生**（用例 ④ / ④b）。SQLite 侧走 `setTaskStatus` 内核，终态
//     CAS 里连带 RFC-300 的 prune 决策——`workspace_pruning_at` / `workspace_prune_cause` 两列
//     一起写，且 `task.lifecycle-transitioned.v1` 事件带上 `workspacePruneClaim`。PG 侧是自己
//     手写的终态 UPDATE + 手写的事件 append，两处**都没有** prune 这一档。
//     后果：同一条 MR 关闭事件，SQLite 上这个 webhook 任务的 remote 工作树会被回收、磁盘还回来，
//     PostgreSQL 上那棵 worktree **永远留着**，UI 的「工作区回收中 / 已回收」也永远不出现。
//
// 一处**看起来像差异、实际不是**的（记在这里，免得下一个人又去「抬齐」它）：
//   · SQLite 侧在「没有活着的 owner」那支还额外调了 `finalizeCanceledTaskWithoutDriver`
//     （→ `finishClaimedWebhookWorkspacePrune`），把刚认领的回收**当场**做完；PG 侧没有这一句。
//     但真正在生产上把工作树删掉的**两个引擎都是同一条路**：`task-workspace-prune-nudge`
//     这个持久消费者（`application/taskLifecycleConsumers.ts`），它的触发条件只有事件 payload 里
//     的 `workspacePruneClaim !== null`，两个 bootstrap 都接了它（`cli/start.ts` 的 PG 分支接到
//     `workspaceMaintenance.finalizeClaimedWorkspace`，SQLite 分支接到
//     `finishClaimedWebhookWorkspacePrune`）。SQLite 那句内联调用是同一件事的**快路径**，不是
//     PG 缺的能力——所以判据落在「认领有没有进事件」（④b），而不是「`workspace_pruned_at`
//     在本次调用返回前有没有落章」：后者会把一条机制差异伪装成能力缺口。
//
// 处置：按强侧（SQLite）抬齐——PG 的 cancel 分支改调同一份中立
// `resolveTerminalWorkspacePruneDecision`，在同一个终态 CAS 里写 prune 认领（连三列墓碑条件
// 一起，形状对齐 `taskRuntimeLifecyclePersistence`），并把认领塞进 committed event。
// 下面每条断言在抬齐前后都成立。

import { afterEach, expect, test } from 'bun:test'
import { and, desc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { committedEvents, nodeRuns, taskExecutionIntents, tasks } from '@/db/schema'
import { createWebhookTerminalWorkspaceAttributionQueries } from '@/modules/integration/infrastructure/terminalWorkspaceAttribution'
import type {
  TaskSourceTerminationEffectInput,
  TaskSourceTerminationParticipant,
  TaskSourceTerminationReceipt,
} from '@/modules/task-execution/application/applySourceTerminationEffect'
import { mintSourceTerminationEffectCapability } from '@/modules/task-execution/application/sourceTerminationCapability'
// 两侧实现各值 import 一条：这一对的对拍见证判据就锁在这里
// （`tests/architecture/rfc359-w5-provider-pair-conformance.test.ts`）——走 composition 的
// 再导出会让这份对拍在账本里看不见。
import { createPostgresqlTaskSourceTerminationParticipant } from '@/modules/task-execution/infrastructure/postgresqlSourceTerminationParticipant'
import { createTaskSourceTerminationParticipant } from '@/modules/task-execution/infrastructure/sqliteSourceTerminationParticipant'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { registerTerminalWorkspacePrunePolicy } from '@/services/lifecycle'
import { createWebhookTerminalWorkspacePrunePolicy } from '@/services/webhook/terminalWorkspaceCleanup'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const BINDING = 'gitlab:group/proj!42'
const DELIVERY = 'dlv-rfc359-w8'

function participantFor(harness: ProviderHarness): TaskSourceTerminationParticipant {
  return harness.capabilities.isolation === 'exclusive'
    ? createTaskSourceTerminationParticipant(harness.db as unknown as DbClient)
    : createPostgresqlTaskSourceTerminationParticipant(
        harness.db as unknown as PostgresqlDatabaseClient,
      )
}

/**
 * RFC-300 的生产策略本体（provider 中立），两个引擎注册的是同一份。
 * 全局单例——每个用例后必须还原，否则会漏给同进程的其它测试。
 */
function registerProductionPrunePolicy(db: ProviderNeutralDatabase): void {
  registerTerminalWorkspacePrunePolicy(
    createWebhookTerminalWorkspacePrunePolicy({
      attribution: createWebhookTerminalWorkspaceAttributionQueries(db),
      enabled: () => true,
    }),
  )
}

afterEach(() => {
  registerTerminalWorkspacePrunePolicy(null)
})

interface SeedOverrides {
  readonly status?: 'pending' | 'running' | 'done' | 'canceled'
  readonly launchRevision?: number
  readonly fence?: 'closed' | 'merged' | null
  readonly effectRevision?: number | null
  readonly parentTaskId?: string | null
  readonly spaceKind?: 'remote' | 'scratch' | 'local' | 'inherited'
  readonly webhookTriggerId?: string | null
  readonly binding?: string | null
}

interface Seeded {
  readonly taskId: string
  readonly openRunId: string
  readonly doneRunId: string
  readonly intentId: string
}

async function seed(db: ProviderNeutralDatabase, overrides: SeedOverrides = {}): Promise<Seeded> {
  const taskId = `task-${ulid()}`
  const openRunId = `run-open-${ulid()}`
  const doneRunId = `run-done-${ulid()}`
  const intentId = `intent-${ulid()}`
  const status = overrides.status ?? 'running'
  const slotPath = JSON.stringify([
    { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
  ])
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: 'workflow-w8-source-termination',
    workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath: `/tmp/worktree/${taskId}`,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status,
    inputs: '{}',
    startedAt: 1,
    runningSince: status === 'running' ? 1 : null,
    runningMs: 0,
    finishedAt: null,
    parentTaskId: overrides.parentTaskId ?? null,
    spaceKind: overrides.spaceKind ?? 'remote',
    webhookTriggerId:
      overrides.webhookTriggerId === undefined ? 'trg-w8' : overrides.webhookTriggerId,
    sourceTerminationBinding: overrides.binding === undefined ? BINDING : overrides.binding,
    sourceTerminationLaunchRev: overrides.launchRevision ?? 1,
    sourceTerminationFence: overrides.fence ?? null,
    sourceTerminationEffectRev: overrides.effectRevision ?? null,
    executionLineageId: taskId,
    lineageSlotPathJson: slotPath,
  })
  await db.insert(nodeRuns).values([
    {
      id: openRunId,
      taskId,
      nodeId: 'node-open',
      status: 'running',
      retryIndex: 0,
      iteration: 0,
      startedAt: 1,
      continuationSlotKey: `${taskId}:node-open`,
      operationGeneration: 0,
    },
    {
      id: doneRunId,
      taskId,
      nodeId: 'node-done',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: 1,
      finishedAt: 2,
      continuationSlotKey: `${taskId}:node-done`,
      operationGeneration: 0,
    },
  ])
  await db.insert(taskExecutionIntents).values({
    id: intentId,
    taskId,
    kind: 'launch',
    state: 'pending',
    source: 'rest',
    requestHash: `hash-${intentId}`,
    payloadJson: '{}',
    executionLineageId: taskId,
    continuationSlotKey: `${taskId}:root`,
    slotPathJson: slotPath,
    operationGeneration: 0,
    expectedTaskRevision: 1,
    createdAt: 1,
    updatedAt: 1,
  })
  return { taskId, openRunId, doneRunId, intentId }
}

function effect(
  kind: TaskSourceTerminationEffectInput['kind'],
  streamRevision: number,
): TaskSourceTerminationEffectInput {
  return {
    effectId: `eff-${kind}-${String(streamRevision)}`,
    binding: BINDING,
    streamRevision,
    kind,
    deliveryId: DELIVERY,
  }
}

async function apply(
  harness: ProviderHarness,
  input: TaskSourceTerminationEffectInput,
): Promise<readonly TaskSourceTerminationReceipt[]> {
  return await participantFor(harness).apply(mintSourceTerminationEffectCapability(input), input)
}

async function taskRow(db: ProviderNeutralDatabase, taskId: string) {
  const rows = await db
    .select({
      status: tasks.status,
      errorSummary: tasks.errorSummary,
      errorMessage: tasks.errorMessage,
      finishedAt: tasks.finishedAt,
      fence: tasks.sourceTerminationFence,
      effectRevision: tasks.sourceTerminationEffectRev,
      workspacePruningAt: tasks.workspacePruningAt,
      workspacePruneCause: tasks.workspacePruneCause,
      runningSince: tasks.runningSince,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  return rows[0]
}

/** 这次转移落下的 `task.lifecycle-transitioned.v1` payload（没有就是 null）。 */
async function lifecycleEventPayload(
  db: ProviderNeutralDatabase,
  taskId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await db
    .select({ payloadJson: committedEvents.payloadJson })
    .from(committedEvents)
    .where(
      and(
        eq(committedEvents.aggregateId, taskId),
        eq(committedEvents.eventType, 'task.lifecycle-transitioned.v1'),
      ),
    )
    .orderBy(desc(committedEvents.aggregateSeq))
    .limit(1)
  const raw = rows[0]?.payloadJson
  if (raw === undefined) return null
  // `payload_json` 存的是整个信封，事件负载在它的 `payload` 里。
  const envelope = JSON.parse(raw) as { payload?: Record<string, unknown> }
  return envelope.payload ?? null
}

async function runRow(db: ProviderNeutralDatabase, id: string) {
  const rows = await db
    .select({ status: nodeRuns.status, errorMessage: nodeRuns.errorMessage })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, id))
    .limit(1)
  return rows[0]
}

async function intentRow(db: ProviderNeutralDatabase, id: string) {
  const rows = await db
    .select({ state: taskExecutionIntents.state, failureCode: taskExecutionIntents.failureCode })
    .from(taskExecutionIntents)
    .where(eq(taskExecutionIntents.id, id))
    .limit(1)
  return rows[0]
}

describeEachProvider('RFC-359 W8 —— 源终止参与者在两个引擎上同形', (harness) => {
  test('① MR 关闭：running 任务被取消，摘要 / 错误码 / 围栏 / 完成时刻两侧同形', async () => {
    const { taskId } = await seed(harness.db)

    const receipts = await apply(harness, effect('fence-closed', 5))

    expect(receipts).toEqual([
      {
        taskId,
        priorStatus: 'running',
        fenceOutcome: 'fenced-closed',
        cancelOutcome: 'canceled',
        releaseOutcome: 'no-active-owner',
        errorCode: null,
      },
    ])
    const row = await taskRow(harness.db, taskId)
    expect(row).toMatchObject({
      status: 'canceled',
      errorSummary: 'MR/PR 已关闭，任务已停止',
      errorMessage: `webhook-mr-closed: delivery=${DELIVERY} revision=5`,
      fence: 'closed',
      effectRevision: 5,
    })
    expect(row?.finishedAt).not.toBeNull()
    // running → 终态：跑时长结算掉，runningSince 清空（列表页的「已运行」列读它）。
    expect(row?.runningSince).toBeNull()
  })

  test('② 取消连带：开着的节点跑批一起取消并带原因，已完成的那条原样不动', async () => {
    const { openRunId, doneRunId } = await seed(harness.db)

    await apply(harness, effect('fence-closed', 5))

    expect(await runRow(harness.db, openRunId)).toEqual({
      status: 'canceled',
      errorMessage: 'webhook-mr-closed',
    })
    expect(await runRow(harness.db, doneRunId)).toMatchObject({ status: 'done' })
  })

  test('③ 取消连带：未消费的执行 intent 一并终态化', async () => {
    const { intentId } = await seed(harness.db)

    await apply(harness, effect('fence-closed', 5))

    expect(await intentRow(harness.db, intentId)).toEqual({
      state: 'canceled',
      failureCode: 'webhook-mr-closed',
    })
  })

  test('④ RFC-300 工作区回收：webhook 来源的 remote 任务被取消时认领回收', async () => {
    const { taskId } = await seed(harness.db)
    registerProductionPrunePolicy(harness.db)

    await apply(harness, effect('fence-closed', 5))

    const row = await taskRow(harness.db, taskId)
    expect(row?.workspacePruningAt).not.toBeNull()
    expect(row?.workspacePruneCause).toBe('webhook-terminal')
  })

  test('④b RFC-300 工作区回收：认领同时写进 lifecycle 事件（收尾靠它才会被叫醒）', async () => {
    const { taskId } = await seed(harness.db)
    registerProductionPrunePolicy(harness.db)

    await apply(harness, effect('fence-closed', 5))

    // 真正把工作树从盘上删掉的是 `task-workspace-prune-nudge` 那个持久消费者，而它的
    // 触发条件**只有**事件 payload 里的 `workspacePruneClaim !== null`
    // （`application/taskLifecycleConsumers.ts`，两个 bootstrap 都这么接）。
    // 认领只落到列上、没进事件 ⇒ 收尾永远不会被叫醒，工作树留在盘上、UI 停在「回收中」。
    const payload = await lifecycleEventPayload(harness.db, taskId)
    expect(payload?.['status']).toBe('canceled')
    expect(payload?.['workspacePruneClaim']).toMatchObject({ cause: 'webhook-terminal' })
  })

  test('⑤ RFC-300 归属规则：非 webhook 来源的任务不认领回收（策略同一份，两侧同判）', async () => {
    const { taskId } = await seed(harness.db, { webhookTriggerId: null })
    registerProductionPrunePolicy(harness.db)

    await apply(harness, effect('fence-closed', 5))

    const row = await taskRow(harness.db, taskId)
    expect(row?.status).toBe('canceled')
    expect(row?.workspacePruningAt).toBeNull()
    expect(row?.workspacePruneCause).toBeNull()
  })

  test('⑥ MR 合入：摘要 / 节点原因换成 merged 那一套，围栏记 merged', async () => {
    const { taskId, openRunId } = await seed(harness.db)

    const receipts = await apply(harness, effect('fence-merged', 7))

    expect(receipts[0]).toMatchObject({ fenceOutcome: 'fenced-merged', cancelOutcome: 'canceled' })
    expect(await taskRow(harness.db, taskId)).toMatchObject({
      status: 'canceled',
      errorSummary: 'MR/PR 已合入，任务已停止',
      fence: 'merged',
    })
    expect(await runRow(harness.db, openRunId)).toMatchObject({ errorMessage: 'webhook-mr-merged' })
  })

  test('⑦ 已终态的任务：状态不再改写，围栏照样落章，收据记 already-terminal', async () => {
    const { taskId } = await seed(harness.db, { status: 'done' })

    const receipts = await apply(harness, effect('fence-closed', 5))

    expect(receipts[0]).toMatchObject({
      priorStatus: 'done',
      fenceOutcome: 'fenced-closed',
      cancelOutcome: 'already-terminal',
    })
    expect(await taskRow(harness.db, taskId)).toMatchObject({
      status: 'done',
      fence: 'closed',
      effectRevision: 5,
    })
  })

  test('⑧ 子任务级联：错误码换成 parent-cascade（父任务在场时的用户可见原因）', async () => {
    // 父任务不带绑定，因此不会被本次扫描选中——收据里只该有子任务一条。
    const parent = await seed(harness.db, { binding: null })
    const { taskId, openRunId } = await seed(harness.db, { parentTaskId: parent.taskId })

    await apply(harness, effect('fence-closed', 5))

    expect(await taskRow(harness.db, taskId)).toMatchObject({
      errorSummary: 'canceled by parent task',
      errorMessage: `canceled-by-parent-cascade: delivery=${DELIVERY} revision=5`,
    })
    expect(await runRow(harness.db, openRunId)).toMatchObject({
      errorMessage: 'canceled-by-parent-cascade',
    })
  })

  test('⑨ 撤销围栏（MR 重开）：closed 围栏清空，任务状态一个字都不动', async () => {
    const { taskId } = await seed(harness.db, { fence: 'closed', effectRevision: 5 })

    const receipts = await apply(harness, effect('clear-closed', 9))

    expect(receipts).toEqual([
      {
        taskId,
        priorStatus: 'running',
        fenceOutcome: 'cleared-closed',
        cancelOutcome: 'not-applicable',
        releaseOutcome: 'not-required',
        errorCode: null,
      },
    ])
    expect(await taskRow(harness.db, taskId)).toMatchObject({
      status: 'running',
      fence: null,
      effectRevision: 9,
    })
  })

  test('⑩ merged 围栏不被 clear-closed 撤销（合入是终局，重开事件不该复活它）', async () => {
    const { taskId } = await seed(harness.db, { fence: 'merged', effectRevision: 5 })

    const receipts = await apply(harness, effect('clear-closed', 9))

    expect(receipts[0]).toMatchObject({ fenceOutcome: 'unchanged' })
    expect(await taskRow(harness.db, taskId)).toMatchObject({ fence: 'merged', effectRevision: 9 })
  })

  test('⑫ merged 之后再来一个 closed：围栏不降级（合入是终局，后续关闭不改写它）', async () => {
    const { taskId } = await seed(harness.db, { fence: 'merged', effectRevision: 3 })

    const receipts = await apply(harness, effect('fence-closed', 7))

    expect(receipts[0]).toMatchObject({ fenceOutcome: 'fenced-merged' })
    expect(await taskRow(harness.db, taskId)).toMatchObject({ fence: 'merged', effectRevision: 7 })
  })

  test('⑪ 同一条 delivery 重放：第二次记 unchanged，任务不再被改写第二遍', async () => {
    const { taskId } = await seed(harness.db)

    await apply(harness, effect('fence-closed', 5))
    const afterFirst = await taskRow(harness.db, taskId)
    const receipts = await apply(harness, effect('fence-closed', 5))

    expect(receipts[0]).toMatchObject({
      priorStatus: 'canceled',
      fenceOutcome: 'unchanged',
      cancelOutcome: 'already-terminal',
    })
    expect(await taskRow(harness.db, taskId)).toEqual(afterFirst!)
  })

  test('⑫ 事件之后才启动的任务不受影响（launchRev ≥ streamRevision 直接跳过，无收据）', async () => {
    const { taskId } = await seed(harness.db, { launchRevision: 9 })

    expect(await apply(harness, effect('fence-closed', 5))).toEqual([])
    expect(await taskRow(harness.db, taskId)).toMatchObject({ status: 'running', fence: null })
  })

  test('⑬ 绑定不匹配的任务一个都不碰（扫描面就是绑定本身）', async () => {
    const { taskId } = await seed(harness.db, { binding: 'gitlab:other/proj!1' })

    expect(await apply(harness, effect('fence-closed', 5))).toEqual([])
    expect(await taskRow(harness.db, taskId)).toMatchObject({ status: 'running' })
  })

  test('⑭ 伪造的能力凭据被拒（凭据与本次 effect 不匹配时不产生任何写）', async () => {
    const { taskId } = await seed(harness.db)
    const participant = participantFor(harness)
    const claimed = effect('fence-closed', 5)

    await expect(
      participant.apply(mintSourceTerminationEffectCapability(effect('fence-merged', 5)), claimed),
    ).rejects.toMatchObject({ code: 'source-termination-capability-invalid' })
    expect(await taskRow(harness.db, taskId)).toMatchObject({ status: 'running', fence: null })
  })
})
