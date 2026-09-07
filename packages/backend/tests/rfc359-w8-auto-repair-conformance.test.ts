// RFC-359 W8 —— `TaskLifecycleAutoRepairCommand` 的**双引擎对拍**。
//
// 这一对在账本里是 `sqlite 0/0, postgresql 0/0`——**两侧都没有任何行为覆盖**
// （`rfc359-w5-t19d-coverage-parity`）。RFC-108 的 `rfc108-auto-repair.test.ts` 只测了
// `runAutoRepairOnce` 这个**注入式循环**（resolveOptions / applyOption 全是 stub），
// 也就是说「循环之外那一半」——两个 provider 各自的选项解析与 apply——从来没被跑过。
//
// 判定：**真重复，且 PostgreSQL 侧还多养了第三份**。
// ----------------------------------------------------------------------------
// 薄壳求和（先把「谁在替谁干活」算清楚，行数比值本身没有意义）：
//   · SQLite 侧 `sqliteTaskLifecycleAutoRepairCommand.ts` 只有 65 行，是壳；它转发给
//     `platform/persistence/sqlite/taskLifecycleRepair.ts`（513 行的引擎）+
//     `taskLifecycleRepair/`（14 个 options-*.ts 共 2755 行）。**但求和不能就此打住**：
//     这个端口只会自动应用 `autoApplyEligible` 的选项，而全家 14 条规则里**只有
//     `options-S4.ts` 的 `S4.kick-task` 一个**带这个标（`rg autoApplyEligible` 全树唯一命中），
//     `selectAutoApplyOption` 又要求「恰好一个 eligible 且 available」。所以这个壳的
//     **有效**转发面是：引擎的两个入口（约 360 行）+ `options-S4.ts`（132 行）+
//     `helpers.ts` 的调度器活性门（约 17 行）≈ **510 行**；其余约 2600 行服务的是**人工**
//     修复路由（`POST /api/tasks/:id/alerts/:alertId/repair`），不属于这一对。
//   · PostgreSQL 侧 `postgresqlTaskLifecycleAutoRepairCommand.ts` 是 198 行的**自建** S4 实现。
//   于是这一对是 510 : 198 的真重复——不是「一侧缺整类能力」。
//
// 而且 PostgreSQL 上这 198 行是**第三份**：`postgresqlTaskRouteRepairOperations.ts`（1448 行）
// 已经是 PG 自己的完整修复引擎，里面同样声明了 `'S4.kick-task': { …, autoApplyEligible: true }`
// 与 `S4.cancel-task`，并且走的是同一个中立 `persistence.runtimeLifecycle.trySet`。也就是说
// PG 上「S4 踢一脚」有两份互不知情的实现，一份给人工路由、一份给自动循环；SQLite 上则是
// 同一个引擎同时服务两条路。**合一方向**（本刀未做，留给下一刀）：把这个端口做成一份中立壳，
// 吃 `RepairOperations`（`repairOptions` / `applyRepair`）这个两侧都已实现的端口，
// 装配处各自注入自己的修复引擎——这样 PG 的第三份直接消失，SQLite 的壳原样成立。
// 拦路的是装配：`composition/providerRuntime.ts` 要改依赖形状，那个文件本波正被别的刀占着。
//
// 判据落在**用户可见契约**：自动修复这一轮**选了哪个选项、把任务改成了什么、跳过时给的是
// 哪个理由**（`repaired[] / skipped[]` 就是运维在恢复时间线上看到的那两列），以及
// `lifecycle_repair_audit` 里留下什么、告警有没有被销掉。

import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { lifecycleAlerts, lifecycleRepairAudit, tasks } from '@/db/schema'
import type { ActiveTaskExecutionParticipant } from '@/modules/task-execution/application/ports/taskExecutionRuntimeParticipants'
import type {
  TaskLifecycleAutoRepairCommand,
  TaskLifecycleAutoRepairResult,
} from '@/modules/task-execution/application/ports/taskLifecycleAutoRepairCommand'
import {
  createPostgresqlTaskExecutionPersistence,
  createSqliteTaskExecutionPersistence,
} from '@/modules/task-execution/composition/taskExecutionPersistence'
// 两侧实现各值 import 一条：这一对的对拍见证判据就锁在这里
// （`tests/architecture/rfc359-w5-provider-pair-conformance.test.ts`）。
import { createPostgresqlTaskLifecycleAutoRepairCommand } from '@/modules/task-execution/infrastructure/postgresqlTaskLifecycleAutoRepairCommand'
import { createSqliteTaskLifecycleAutoRepairCommand } from '@/modules/task-execution/infrastructure/sqliteTaskLifecycleAutoRepairCommand'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { StartTaskDeps } from '@/services/task'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const NOW = 1_788_600_000_000
/** 宽到不会自己跳闸的断路器；测断路器的用例自己收窄。 */
const OPEN_POLICY = { enabledRules: ['S4', 'R1'], maxPerWindow: 10, windowMs: 60_000 } as const

interface CommandBuild {
  readonly command: TaskLifecycleAutoRepairCommand
  /** 这一轮里 resume 被叫了几次（两侧唯一可比的「复活确实发生了」信号）。 */
  resumeCalls(): number
}

interface CommandOptions {
  /** resume 抛错：踢一脚之后的复活失败，用户看到的是「改了但没跑起来」。 */
  readonly resumeThrows?: boolean
}

function commandFor(harness: ProviderHarness, options: CommandOptions = {}): CommandBuild {
  let resumeCalls = 0
  const resume = async (): Promise<void> => {
    resumeCalls += 1
    if (options.resumeThrows === true) throw new Error('scheduler refused the kick')
  }
  if (harness.capabilities.isolation === 'exclusive') {
    const db = harness.db as unknown as DbClient
    const persistence = createSqliteTaskExecutionPersistence(db)
    // SQLite 侧的复活是引擎里写死的 `resumeTask(db, taskId, deps)`，没有注入缝——
    // 唯一能观测/控制它的把手是 `deps.schedulerDriver.drive`（成功路径的最后一步）。
    const deps: StartTaskDeps = {
      db,
      appHome: mkdtempSync(join(tmpdir(), 'aw-rfc359-w8-repair-')),
      schedulerDriver: { drive: resume },
      taskRecoveryOperations: persistence.recoveryAdministration,
      awaitScheduler: true,
    }
    return {
      command: createSqliteTaskLifecycleAutoRepairCommand({
        db,
        appHome: deps.appHome ?? '',
        deps,
        operations: persistence.recoveryAdministration,
        now: () => NOW,
      }),
      resumeCalls: () => resumeCalls,
    }
  }
  const db = harness.db as unknown as PostgresqlDatabaseClient
  const persistence = createPostgresqlTaskExecutionPersistence(db)
  const activity: ActiveTaskExecutionParticipant = {
    isActive: () => false,
    awaitReleasedSettled: async () => {},
  }
  return {
    command: createPostgresqlTaskLifecycleAutoRepairCommand({
      db,
      operations: persistence.recoveryAdministration,
      lifecycle: persistence.runtimeLifecycle,
      activity,
      resume: { resume },
      now: () => NOW,
    }),
    resumeCalls: () => resumeCalls,
  }
}

interface SeedOverrides {
  readonly status?: 'pending' | 'running' | 'done'
  readonly rule?: string
  readonly workgroupId?: string | null
  readonly workgroupConfigJson?: string | null
  /** 工作树目录不存在 —— 复活的前置检查会拒（两侧都用它制造「踢了但没跑起来」）。 */
  readonly worktreeMissing?: boolean
  readonly detectedAt?: number
}

interface Seeded {
  readonly taskId: string
  readonly alertId: string
}

async function seed(db: ProviderNeutralDatabase, overrides: SeedOverrides = {}): Promise<Seeded> {
  const taskId = `task-${ulid()}`
  const alertId = `alert-${ulid()}`
  const worktreePath =
    overrides.worktreeMissing === true
      ? join(tmpdir(), `aw-rfc359-w8-missing-${taskId}`)
      : mkdtempSync(join(tmpdir(), 'aw-rfc359-w8-wt-'))
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: 'workflow-w8-auto-repair',
    workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: overrides.status ?? 'pending',
    inputs: '{}',
    startedAt: NOW - 600_000,
    runningMs: 0,
    workgroupId: overrides.workgroupId ?? null,
    workgroupConfigJson: overrides.workgroupConfigJson ?? null,
    executionLineageId: taskId,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
    ]),
  })
  await db.insert(lifecycleAlerts).values({
    id: alertId,
    taskId,
    rule: overrides.rule ?? 'S4',
    severity: 'warning',
    detail: JSON.stringify({ pendingMs: 600_000 }),
    detectedAt: overrides.detectedAt ?? NOW - 60_000,
    resolvedAt: null,
  })
  return { taskId, alertId }
}

async function statusOf(db: ProviderNeutralDatabase, taskId: string): Promise<string | undefined> {
  const rows = await db
    .select({ status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  return rows[0]?.status
}

async function alertResolvedAt(
  db: ProviderNeutralDatabase,
  alertId: string,
): Promise<number | null> {
  const rows = await db
    .select({ resolvedAt: lifecycleAlerts.resolvedAt })
    .from(lifecycleAlerts)
    .where(eq(lifecycleAlerts.id, alertId))
    .limit(1)
  return rows[0]?.resolvedAt ?? null
}

async function auditRows(db: ProviderNeutralDatabase, taskId: string) {
  return await db
    .select({
      optionId: lifecycleRepairAudit.optionId,
      actorUserId: lifecycleRepairAudit.actorUserId,
      outcome: lifecycleRepairAudit.outcome,
      alertRule: lifecycleRepairAudit.alertRule,
      alertDetailJson: lifecycleRepairAudit.alertDetailJson,
      beforeSnapshotJson: lifecycleRepairAudit.beforeSnapshotJson,
      afterSnapshotJson: lifecycleRepairAudit.afterSnapshotJson,
      outcomeMessage: lifecycleRepairAudit.outcomeMessage,
    })
    .from(lifecycleRepairAudit)
    .where(eq(lifecycleRepairAudit.taskId, taskId))
}

/** 只保留与本用例的任务相关的行——同一个库里可能还留着别的 seed。 */
function forTask(result: TaskLifecycleAutoRepairResult, taskId: string) {
  return {
    repaired: result.repaired.filter((entry) => entry.taskId === taskId),
    skipped: result.skipped.filter((entry) => entry.taskId === taskId),
  }
}

describeEachProvider('RFC-359 W8 —— 任务生命周期自动修复在两个引擎上同形', (harness) => {
  test('① S4 卡在 pending：自动踢一脚，任务转 interrupted 并触发复活', async () => {
    const { taskId, alertId } = await seed(harness.db)
    const build = commandFor(harness)

    const result = forTask(await build.command.run(OPEN_POLICY), taskId)

    expect(result.repaired).toEqual([
      { taskId, alertId, optionId: 'S4.kick-task', outcome: 'success' },
    ])
    expect(result.skipped).toEqual([])
    expect(build.resumeCalls()).toBe(1)
    // 刻意**不**断言这一轮结束时的 task.status——见文件末尾「两侧不该被硬拉齐的一处」：
    // 两个引擎的「复活」停在链路的不同深度，终局状态因此不同，而那不是这个端口的契约。
  })

  test('② 修完销告警：目标告警被标记 resolved（面板上的红条随之消失）', async () => {
    const { taskId, alertId } = await seed(harness.db)

    const result = forTask(await commandFor(harness).command.run(OPEN_POLICY), taskId)

    expect(result.repaired).toHaveLength(1)
    expect(await alertResolvedAt(harness.db, alertId)).not.toBeNull()
  })

  test('③ 审计留痕：一条 system actor（actor_user_id = NULL）的成功审计行', async () => {
    const { taskId } = await seed(harness.db)

    await commandFor(harness).command.run(OPEN_POLICY)

    // 这一行就是 Diagnose 面板「修复历史」里展开看到的内容：谁改的（system ⇒ NULL）、
    // 改的哪个选项、改前改后各是什么。
    expect(await auditRows(harness.db, taskId)).toEqual([
      {
        optionId: 'S4.kick-task',
        actorUserId: null,
        outcome: 'success',
        alertRule: 'S4',
        alertDetailJson: JSON.stringify({ pendingMs: 600_000 }),
        beforeSnapshotJson: JSON.stringify({ task: { status: 'pending' } }),
        afterSnapshotJson: JSON.stringify({ task: { status: 'interrupted' } }),
        outcomeMessage: null,
      },
    ])
  })

  test('④ 规则没开：跳过并给 rule-disabled，任务一个字不动', async () => {
    const { taskId, alertId } = await seed(harness.db)

    const result = forTask(
      await commandFor(harness).command.run({ ...OPEN_POLICY, enabledRules: [] }),
      taskId,
    )

    expect(result.repaired).toEqual([])
    expect(result.skipped).toEqual([{ taskId, alertId, reason: 'rule-disabled' }])
    expect(await statusOf(harness.db, taskId)).toBe('pending')
  })

  test('⑤ 任务已经不在 pending：选项不可用 ⇒ no-single-eligible，不乱改状态', async () => {
    const { taskId, alertId } = await seed(harness.db, { status: 'running' })

    const result = forTask(await commandFor(harness).command.run(OPEN_POLICY), taskId)

    expect(result.repaired).toEqual([])
    expect(result.skipped).toEqual([{ taskId, alertId, reason: 'no-single-eligible' }])
    expect(await statusOf(harness.db, taskId)).toBe('running')
  })

  test('⑥ 非 S4 的告警（R1）：没有任何可自动应用的选项 ⇒ no-single-eligible', async () => {
    const { taskId, alertId } = await seed(harness.db, { rule: 'R1' })

    const result = forTask(await commandFor(harness).command.run(OPEN_POLICY), taskId)

    expect(result.repaired).toEqual([])
    expect(result.skipped).toEqual([{ taskId, alertId, reason: 'no-single-eligible' }])
    expect(await statusOf(harness.db, taskId)).toBe('pending')
  })

  test('⑦ TURN-ENGINE 工作组宿主任务：复活类修复一律不自动应用', async () => {
    const { taskId, alertId } = await seed(harness.db, {
      workgroupId: 'wg-1',
      workgroupConfigJson: JSON.stringify({ engine: 'turn' }),
    })

    const result = forTask(await commandFor(harness).command.run(OPEN_POLICY), taskId)

    expect(result.repaired).toEqual([])
    expect(result.skipped).toEqual([{ taskId, alertId, reason: 'no-single-eligible' }])
    expect(await statusOf(harness.db, taskId)).toBe('pending')
  })

  test('⑧ 断路器跳闸：窗口内配额为 0 时不动手，理由是 breaker-tripped', async () => {
    const { taskId, alertId } = await seed(harness.db)

    const result = forTask(
      await commandFor(harness).command.run({ ...OPEN_POLICY, maxPerWindow: 0 }),
      taskId,
    )

    expect(result.repaired).toEqual([])
    expect(result.skipped).toEqual([{ taskId, alertId, reason: 'breaker-tripped' }])
    expect(await statusOf(harness.db, taskId)).toBe('pending')
  })

  test('⑨ 复活失败：状态改到 interrupted 就停在那里，这一轮汇报 apply-failed（不是 success）', async () => {
    // 两侧用同一个物理成因制造失败：工作树目录不在了。SQLite 侧被 `resumeTask` 的工作树
    // 前置检查拒，PG 侧被注入的 resume 拒——都是「状态已经改了、但复活没成」。
    const { taskId } = await seed(harness.db, { worktreeMissing: true })
    const build = commandFor(harness, { resumeThrows: true })

    const result = forTask(await build.command.run(OPEN_POLICY), taskId)

    expect(result.skipped).toEqual([])
    expect(result.repaired).toHaveLength(1)
    expect(result.repaired[0]?.optionId).toBe('S4.kick-task')
    // 运维在恢复时间线上读到的就是这个字符串（`recordRecoveryEvent` 的 reason 尾段），
    // 「改了但没跑起来」必须和「成功」长得不一样。
    expect(result.repaired[0]?.outcome.startsWith('apply-failed')).toBe(true)
    // 踢一脚的那次 CAS 已经提交，复活失败不回滚它——任务停在 interrupted 等下一次介入。
    expect(await statusOf(harness.db, taskId)).toBe('interrupted')
  })

  test('⑪ 一轮扫多个任务：按告警发现时间逐个处理，互不影响', async () => {
    const first = await seed(harness.db, { detectedAt: NOW - 30_000 })
    const second = await seed(harness.db, { detectedAt: NOW - 20_000 })
    // 第三个任务已经不在 pending：它被跳过，不能连累前两个。
    const third = await seed(harness.db, { detectedAt: NOW - 10_000, status: 'running' })
    const build = commandFor(harness)

    const result = await build.command.run(OPEN_POLICY)

    expect(result.repaired.map((entry) => entry.taskId)).toEqual([first.taskId, second.taskId])
    expect(result.skipped).toEqual([
      { taskId: third.taskId, alertId: third.alertId, reason: 'no-single-eligible' },
    ])
    expect(build.resumeCalls()).toBe(2)
  })

  test('⑩ 同一条告警不会被修第二次（第一轮已把它销掉）', async () => {
    const { taskId, alertId } = await seed(harness.db)
    const build = commandFor(harness)

    const first = forTask(await build.command.run(OPEN_POLICY), taskId)
    const second = forTask(await build.command.run(OPEN_POLICY), taskId)

    expect(first.repaired.map((entry) => entry.alertId)).toEqual([alertId])
    expect(second.repaired.map((entry) => entry.alertId)).not.toContain(alertId)
    expect(second.skipped.map((entry) => entry.alertId)).not.toContain(alertId)
  })
})

// ---------------------------------------------------------------------------
// 结论 + 两处**不该被硬拉齐**的不对称（记在这里，免得下一个人当成缺口去「抬齐」）
// ---------------------------------------------------------------------------
//
// 结论：上面 11 条在**两个引擎上一次就同时绿**——这一对是本波少见的「纸面判成真重复、
// 实测也确实没有行为差」。合一因此是纯粹的去重（省下 PG 那 198 行的第三份），
// 不带任何「抬齐强侧」的动作。
//
// 不对称①（**注入缝**，不是行为差）：PG 的复活是构造参数 `resume`，SQLite 的复活是引擎里
// 写死的 `resumeTask(db, taskId, deps)`。所以两侧的「复活」停在链路的不同深度：SQLite 会一路
// 走到 `deps.schedulerDriver.drive`（并把任务从 interrupted 再带回 pending），PG 只调到注入的
// 那一层。**终局 task.status 因此不可比**，本文件的成功路径只断言「修复被汇报成功 + 复活被叫了
// 一次 + 告警被销 + 审计留痕」，不断言这一轮结束时的状态。失败路径（用例 ⑨）反过来可比：
// 两侧都停在 interrupted，因为踢一脚的那次 CAS 已经提交、复活失败不回滚它。
//
// 不对称②（**活性来源**，两侧结论相同）：「调度器还占着这个任务时不许自动修复」这条门，
// SQLite 读的是 `services/task.ts` 的进程级 `isTaskActive`，PG 读的是注入的
// `activity.isActive`。两侧都拒，但只有 PG 的可注入。本文件不测它：SQLite 侧要让一个任务真的
// 进 `activeTasks` 需要起真调度器 + 一个 parked 子进程 + 轮询等待（见
// `rfc097-repair-liveness.test.ts`），那是墙钟依赖，本波已经因为墙钟在 CI 上假红过一次。
// 这条差异是**可组合性**差异，合一时它自然消失（中立壳只认注入的那个）。
