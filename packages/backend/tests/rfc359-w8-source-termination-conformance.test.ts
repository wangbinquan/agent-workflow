// RFC-359 W8 —— `SourceTerminationParticipant` 的**双引擎对拍**。
//
// W12 已将扫描、固定点重扫与收据投影合到 `sourceTerminationExecution` / `sourceTerminationTargets`，
// 并将原两份每目标 `applyOne`（合计 641 行）合到 `sourceTerminationTarget` 的一份中立事务。
// 任务 CAS / 运行计时 / 回收认领 / 事件 collector 复用 `taskRuntimeLifecyclePersistence`，
// 两个 provider 文件仅保留原提交后时点与 SQLite 无 driver finalize 快路径的机制差异。
// 下文记录 W8 / W9 对旧实现发现的漂移及当时的修复；这些用户可见行为继续由同一批断言锁定。
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
//
// # RFC-359 W9 追加的两条（清 `rfc359-w5-dual-engine-predicate-gaps.test.ts` 的存量缺口）
//
//   **⑮** 把上面那条「看起来像差异、实际不是」从**议论**变成**判据**：拿本次落下的
//   lifecycle 事件去喂 `createTaskLifecycleDurableConsumerDefinitions` 真造出来的
//   `task-workspace-prune-nudge`，断言两个引擎都会叫醒回收。缺口账本 `06` 记的
//   「PG 上任务停在半终态」据此销账——PG 的终态 / 完成时刻 / 回收认领三件都在，
//   SQLite 那句 `finalizeCanceledTaskWithoutDriver` 只是同一条路上的快路径。
//
//   **⑯** 并发终态写抢在源终止的终态落笔之前。缺口账本 `07` 记的「PG 直接抛 409」
//   **不成立**：PG 整笔跑在 SERIALIZABLE 里，那条 UPDATE 撞 40001、中立会话重放整笔，
//   第二遍读到赢家状态走 already-terminal 收场，投递方收不到 409。真正的差额在收据，
//   而且弱侧是 SQLite——它按开工前那次读报 `priorStatus='running'` / `cancelOutcome='canceled'`，
//   于是投递详情说「这次取消了它」，而任务实际是别人写成的 `done`。已按强侧（PostgreSQL）
//   抬齐：SQLite 的 catch 分支复读赢家状态后，收据按赢家出。⑯ 在抬齐前只在 SQLite 上红。
//   交错窗口靠 RFC-300 的回收策略回调撑开——两个引擎都在「读到 priorStatus 之后、终态写之前」
//   await 它一次，是唯一一个对两侧都成立的确定性交错点，不用 sleep、不用墙钟。

import { afterEach, expect, test } from 'bun:test'
import { and, desc, eq, sql as sqlExpr } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { committedEvents, nodeRuns, taskExecutionIntents, tasks } from '@/db/schema'
import type { EventObservationParticipant } from '@/modules/event-center/public/participants'
import { createWebhookTerminalWorkspaceAttributionQueries } from '@/modules/integration/infrastructure/terminalWorkspaceAttribution'
import type {
  TaskSourceTerminationEffectInput,
  TaskSourceTerminationParticipant,
  TaskSourceTerminationReceipt,
} from '@/modules/task-execution/application/applySourceTerminationEffect'
import { mintSourceTerminationEffectCapability } from '@/modules/task-execution/application/sourceTerminationCapability'
import { createTaskLifecycleDurableConsumerDefinitions } from '@/modules/task-execution/application/taskLifecycleConsumers'
// 两侧实现各值 import 一条：这一对的对拍见证判据就锁在这里
// （`tests/architecture/rfc359-w5-provider-pair-conformance.test.ts`）——走 composition 的
// 再导出会让这份对拍在账本里看不见。
import { createPostgresqlTaskSourceTerminationParticipant } from '@/modules/task-execution/infrastructure/postgresqlSourceTerminationParticipant'
import { createTaskSourceTerminationParticipant } from '@/modules/task-execution/infrastructure/sqliteSourceTerminationParticipant'
import type { CommittedEventEnvelopeV1 } from '@/platform/events/committed/types'
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
  readonly taskId?: string
  readonly invocationDepth?: number
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
  const taskId = overrides.taskId ?? `task-${ulid()}`
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
    invocationDepth: overrides.invocationDepth ?? 0,
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

/** 这次转移落下的 `task.lifecycle-transitioned.v1` **整个信封**（消费者吃的就是它）。 */
async function lifecycleEventEnvelope(
  db: ProviderNeutralDatabase,
  taskId: string,
): Promise<CommittedEventEnvelopeV1> {
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
  if (raw === undefined) throw new Error(`task ${taskId} 没有落下 lifecycle 事件`)
  return JSON.parse(raw) as CommittedEventEnvelopeV1
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

  test('⑮ 没有 driver 的取消：收尾靠同一个持久消费者，两侧都会叫醒工作区回收', async () => {
    const { taskId } = await seed(harness.db)
    registerProductionPrunePolicy(harness.db)

    const receipts = await apply(harness, effect('fence-closed', 5))

    // 任务确实收完尾了（不是「只改了 receipt」）：终态 + 完成时刻 + 认领三件都在。
    expect(receipts[0]).toMatchObject({
      cancelOutcome: 'canceled',
      releaseOutcome: 'no-active-owner',
    })
    const row = await taskRow(harness.db, taskId)
    expect(row?.status).toBe('canceled')
    expect(row?.finishedAt).not.toBeNull()
    expect(row?.workspacePruneCause).toBe('webhook-terminal')

    // SQLite 侧在这条「没有活着的 owner」的分支上还会**当场**调一次
    // `finalizeCanceledTaskWithoutDriver`，PG 侧没有那一句。它只是快路径：真正把工作树从盘上
    // 删掉的是下面这个持久消费者，两个 bootstrap 都接了它（`cli/start.ts` 的两个
    // `nudgeWorkspacePrune`）。判据因此落在「认领进没进事件、消费者认不认它」，而不是
    // 「本次调用返回前 `workspace_pruned_at` 有没有落章」——后者会把机制差异读成能力缺口。
    const nudged: string[] = []
    const consumers = createTaskLifecycleDurableConsumerDefinitions({
      events: { observe: async () => ({}) } as unknown as EventObservationParticipant,
      closeTerminalGates: async () => {},
      notifyChildBudget: async () => {},
      notifyExecutionWatch: async () => {},
      nudgeWorkspacePrune: async (id) => {
        nudged.push(id)
      },
    })
    const nudge = consumers.find((consumer) => consumer.id === 'task-workspace-prune-nudge')
    expect(nudge).toBeDefined()
    await nudge!.handle(await lifecycleEventEnvelope(harness.db, taskId))
    expect(nudged).toEqual([taskId])
  })

  test('⑯ 终态写抢在源终止的终态落笔之前：两侧都不把 409 抛给投递方，收据按赢家出', async () => {
    const { taskId, openRunId, intentId } = await seed(harness.db)
    // 唯一一个对两个引擎都成立的确定性交错点：RFC-300 的工作区回收策略。两侧都在
    // 「读到 priorStatus 之后、终态写之前」await 它一次，所以在这里落一次并发终态写，
    // 就必然让本次的终态 CAS 输掉——不靠 sleep、不靠墙钟。
    let raced = false
    registerTerminalWorkspacePrunePolicy(async () => {
      if (!raced) {
        raced = true
        await harness.db
          .update(tasks)
          .set({
            status: 'done',
            finishedAt: 99,
            runningSince: null,
            lifecycleEventRevision: sqlExpr`${tasks.lifecycleEventRevision} + 1`,
          })
          .where(eq(tasks.id, taskId))
      }
      return { prune: false }
    })

    // 两侧的复原机制不同（SQLite 手写 catch + 复读赢家；PostgreSQL 由 SERIALIZABLE 的
    // 40001 重放整笔），但用户看到的必须逐字一样：投递不报错，围栏照样落章，收据按**赢家**
    // 的状态出。SQLite 曾按开工前那次读报 `priorStatus='running' / cancelOutcome='canceled'`
    // ——投递详情于是说「这次取消了它」，而任务实际是 `done`。
    const receipts = await apply(harness, effect('fence-closed', 5))
    expect(raced).toBe(true)
    expect(receipts).toEqual([
      {
        taskId,
        priorStatus: 'done',
        fenceOutcome: 'fenced-closed',
        cancelOutcome: 'already-terminal',
        releaseOutcome: 'no-active-owner',
        errorCode: null,
      },
    ])
    // 赢家的终态一个字都不被改写，围栏与消费位仍然落章。
    expect(await taskRow(harness.db, taskId)).toMatchObject({
      status: 'done',
      finishedAt: 99,
      fence: 'closed',
      effectRevision: 5,
    })
    // 连带收尾照做：开着的节点跑批被取消，未消费的执行 intent 被终态化。
    expect(await runRow(harness.db, openRunId)).toEqual({
      status: 'canceled',
      errorMessage: 'webhook-mr-closed',
    })
    expect(await intentRow(harness.db, intentId)).toEqual({
      state: 'canceled',
      failureCode: 'webhook-mr-closed',
    })
  })

  test('⑰ 多目标收据按 invocationDepth 再按 id 排序，父层先于子层', async () => {
    const parent = await seed(harness.db, { taskId: 'task-z-parent', status: 'done' })
    const child = await seed(harness.db, {
      taskId: 'task-a-child',
      parentTaskId: parent.taskId,
      invocationDepth: 1,
      status: 'done',
    })
    const peer = await seed(harness.db, { taskId: 'task-b-peer', status: 'done' })

    const receipts = await apply(harness, effect('fence-closed', 5))

    expect(receipts.map((receipt) => receipt.taskId)).toEqual([
      peer.taskId,
      parent.taskId,
      child.taskId,
    ])
  })

  test('⑱ 处理首目标期间出现的子任务在固定点重扫中取消，每个目标仅有一条收据和终态事件', async () => {
    const parent = await seed(harness.db, { taskId: 'task-fixed-point-parent' })
    let inserted: Seeded | null = null
    registerTerminalWorkspacePrunePolicy(async () => {
      if (inserted === null) {
        inserted = await seed(harness.db, {
          taskId: 'task-fixed-point-child',
          parentTaskId: parent.taskId,
          invocationDepth: 1,
        })
      }
      return { prune: false }
    })

    const receipts = await apply(harness, effect('fence-closed', 5))

    expect(inserted).not.toBeNull()
    expect(receipts.map((receipt) => receipt.taskId)).toEqual([
      parent.taskId,
      'task-fixed-point-child',
    ])
    for (const receipt of receipts) {
      expect(receipt).toMatchObject({
        cancelOutcome: 'canceled',
        releaseOutcome: 'no-active-owner',
      })
      expect(await taskRow(harness.db, receipt.taskId)).toMatchObject({
        status: 'canceled',
        fence: 'closed',
        effectRevision: 5,
      })
      const events = await harness.db
        .select({ id: committedEvents.id })
        .from(committedEvents)
        .where(
          and(
            eq(committedEvents.aggregateId, receipt.taskId),
            eq(committedEvents.eventType, 'task.lifecycle-transitioned.v1'),
          ),
        )
      expect(events).toHaveLength(1)
    }
  })
})
