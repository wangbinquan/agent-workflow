// RFC-359: both providers use one automatic loop and their existing repair engine.
// PostgreSQL manual and automatic repair share preflight, apply, audit and alert
// reconciliation. The automatic binding retains null actor attribution and the
// existing S4 audit snapshots and failure outcome.

import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  committedEventFamilyCutovers,
  committedEvents,
  lifecycleAlerts,
  lifecycleRepairAudit,
  nodeRuns,
  tasks,
  users,
} from '@/db/schema'
import { buildActor, type Actor } from '@/auth/actor'
import type { LifecycleAlertRow } from '@/services/lifecycleInvariants'
import type { TaskRouteLifecycleAlertNotice } from '@/modules/task-execution/public/taskRoutes'
import type { ActiveTaskExecutionParticipant } from '@/modules/task-execution/application/ports/taskExecutionRuntimeParticipants'
import type {
  TaskLifecycleAutoRepairCommand,
  TaskLifecycleAutoRepairResult,
} from '@/modules/task-execution/application/ports/taskLifecycleAutoRepairCommand'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { createDaemonLockProof } from '@/modules/task-execution/composition/bootRecovery'
import {
  createTaskExecutionPersistence,
  createSqliteTaskExecutionPersistence,
} from '@/modules/task-execution/composition/taskExecutionPersistence'
import {
  bindTaskLifecycleRepair,
  createTaskLifecycleAutoRepairCommand,
} from '@/modules/task-execution/composition/taskLifecycleRepair'
import { createPostgresqlTaskRouteRepairOperations } from '@/modules/task-execution/infrastructure/postgresqlTaskRouteRepairOperations'
import { canonicalJson } from '@/modules/task-execution/domain/executionIntent'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { StartTaskDeps } from '@/services/task'
import { listOpenLifecycleAlertsForTask } from '@/services/taskAlerts'
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
      command: createTaskLifecycleAutoRepairCommand({
        ...bindTaskLifecycleRepair({
          db,
          appHome: deps.appHome ?? '',
          deps,
          operations: persistence.recoveryAdministration,
          now: () => NOW,
        }),
        operations: persistence.recoveryAdministration,
        now: () => NOW,
      }),
      resumeCalls: () => resumeCalls,
    }
  }
  const { persistence, repairs } = repairEngineFor(harness, { resume })
  return {
    command: createTaskLifecycleAutoRepairCommand({
      ...repairs.automaticRepair({ resume: { resume }, now: () => NOW }),
      operations: persistence.recoveryAdministration,
      now: () => NOW,
    }),
    resumeCalls: () => resumeCalls,
  }
}

function unused<T extends object>(methods: Partial<T> = {}): T {
  return new Proxy(methods, {
    get(target, key) {
      if (Reflect.has(target, key)) return Reflect.get(target, key)
      throw new Error(`unexpected repair dependency: ${String(key)}`)
    },
  }) as T
}

function repairEngineFor(
  harness: ProviderHarness,
  options: {
    resume?: (taskId: string) => Promise<void>
    isActive?: (taskId: string) => boolean
    onManualActor?: (actor: Actor, taskId: string) => void
    beforeTransition?: (taskId: string) => Promise<void>
  } = {},
) {
  type Dependencies = Parameters<typeof createPostgresqlTaskRouteRepairOperations>[0]
  const persistence = createTaskExecutionPersistence(harness.db)
  if (options.beforeTransition !== undefined) {
    const trySet = persistence.runtimeLifecycle.trySet.bind(persistence.runtimeLifecycle)
    persistence.runtimeLifecycle.trySet = async (input) => {
      await options.beforeTransition?.(input.taskId)
      return await trySet(input)
    }
  }
  const activity: ActiveTaskExecutionParticipant = {
    isActive: options.isActive ?? (() => false),
    awaitReleasedSettled: async () => {},
  }
  const repairs = createPostgresqlTaskRouteRepairOperations({
    db: harness.db as unknown as PostgresqlDatabaseClient,
    persistence,
    activity,
    children: unused<Dependencies['children']>({
      resume: async ({ taskId }) => {
        await options.resume?.(taskId)
      },
    }),
    topology: unused(),
    resumeRuntimeFor: (actor, taskId) => {
      options.onManualActor?.(actor, taskId)
      return unused()
    },
    collaborationRuntime: unused(),
    clarify: unused(),
    review: unused(),
    appHome: tmpdir(),
    now: () => NOW,
  })
  return { persistence, repairs }
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

async function manualActor(db: ProviderNeutralDatabase): Promise<Actor> {
  const user = {
    id: ulid(),
    username: `repair-${ulid()}`,
    displayName: 'Repair operator',
    role: 'admin' as const,
    status: 'active' as const,
  }
  await db.insert(users).values({ ...user, createdAt: NOW, updatedAt: NOW })
  return buildActor({ user, source: 'session' })
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

// The existing PG repair engine already uses neutral task persistence for S4.
// Exercise both callers on each real database, alongside the selected-provider
// baseline above, so a local SQLite run also covers this shared implementation.
describeEachProvider('RFC-359 manual and automatic repair share the same engine', (harness) => {
  test('P0-4 S4：前代 owner 已真实撤销时，自动修复仍落库并发出一次 resume', async () => {
    const db = harness.db
    const { taskId, alertId } = await seed(db)
    const nodeRunId = `run-${ulid()}`
    await db.insert(nodeRuns).values({
      id: nodeRunId,
      taskId,
      nodeId: 'worker',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
    })
    await db
      .update(committedEventFamilyCutovers)
      .set({ mode: 'dispatchable', epoch: 1, changedAt: NOW, changeRef: 'rfc359-p04-s4' })
      .where(eq(committedEventFamilyCutovers.family, 'task-lifecycle'))
    const before = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
    if (before === undefined) throw new Error(`missing fixture task ${taskId}`)
    const { persistence, repairs } = repairEngineFor(harness)
    const previous = createProviderTaskExecutionModule({
      daemonGeneration: `s4-old-${ulid()}`,
      persistence,
    })
    const intentId = `intent-${ulid()}`
    await persistence.intents.submit({
      intentId,
      now: NOW - 1_000,
      request: {
        taskId,
        kind: 'launch',
        source: 'internal',
        actorUserId: null,
        expectedTaskRevision: before.lifecycleEventRevision,
        scope: {
          executionLineageId: taskId,
          continuationSlotKey: `${taskId}:root`,
          slotPath: [
            { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
          ],
          operationGeneration: 0,
        },
        payload: { v: 1 },
      },
    })
    const claimed = await previous.claimPersisted({ intentId, now: NOW - 1_000 })
    previous.claimGate.leave(claimed.permit)
    expect((await persistence.ownership.read(taskId))?.state).toBe('claimed')

    // Stop after the real prepare: finalizing boot would release this owner
    // and hide the historical S4 refusal of an already-revoked predecessor.
    expect(
      await persistence.recovery.prepare({
        lockProof: createDaemonLockProof({
          lockPath: '/tmp/aw-s4.lock',
          lockPid: process.pid,
          daemonGeneration: `s4-new-${ulid()}`,
          now: NOW,
        }),
        now: NOW,
      }),
    ).toEqual({ revokedTaskIds: [taskId] })
    expect((await persistence.ownership.read(taskId))?.state).toBe('revoked')
    expect(await statusOf(db, taskId)).toBe('pending')

    const resumed: string[] = []
    const command = createTaskLifecycleAutoRepairCommand({
      ...repairs.automaticRepair({
        resume: {
          resume: async (id) => {
            resumed.push(id)
          },
        },
        now: () => NOW,
      }),
      operations: persistence.recoveryAdministration,
      now: () => NOW,
    })
    const result = forTask(await command.run(OPEN_POLICY), taskId)
    const after = await db.select().from(tasks).where(eq(tasks.id, taskId)).get()
    const run = await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).get()
    const audit = await auditRows(db, taskId)
    const events = await db
      .select()
      .from(committedEvents)
      .where(eq(committedEvents.aggregateId, taskId))
    const state = {
      taskId,
      taskStatus: after?.status,
      lifecycleRevision: after?.lifecycleEventRevision,
      nodeRunStatus: run?.status,
      ownerState: (await persistence.ownership.read(taskId))?.state,
      ...result,
      resumed,
      auditOutcome: audit[0]?.outcome,
      auditOutcomeMessage: audit[0]?.outcomeMessage,
      resolvedAt: await alertResolvedAt(db, alertId),
      eventTypes: events.map((event) => event.eventType),
    }
    expect(state).toEqual({
      taskId,
      taskStatus: 'interrupted',
      lifecycleRevision: before.lifecycleEventRevision + 1,
      // S4 only kicks the task. The controlled resume callback proves the
      // actual production invocation, not a subsequent node/child execution.
      nodeRunStatus: 'pending',
      ownerState: 'revoked',
      repaired: [{ taskId, alertId, optionId: 'S4.kick-task', outcome: 'success' }],
      skipped: [],
      resumed: [taskId],
      auditOutcome: 'success',
      auditOutcomeMessage: null,
      resolvedAt: NOW,
      eventTypes: ['task.lifecycle-transitioned.v1'],
    })
    expect(audit).toEqual([
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
    expect(after).toMatchObject({
      finishedAt: NOW,
      errorSummary: 'manual-repair-S4',
      errorMessage: `RFC-057 repair S4.kick-task via alert ${alertId}`,
      failedNodeId: null,
    })
    expect(events[0]?.payloadJson).toBe(
      canonicalJson({
        eventId: `task-lifecycle:${taskId}:2`,
        eventGroupId: `committed-event-group:task-execution:task-lifecycle:${taskId}:2`,
        eventGroupOrdinal: 0,
        type: 'task.lifecycle-transitioned.v1',
        schemaVersion: 1,
        producer: 'task-execution',
        family: 'task-lifecycle',
        aggregate: { kind: 'task', id: taskId, seq: 1 },
        operationRef: `task-lifecycle:${taskId}:2`,
        correlationRef: null,
        causationRef: null,
        occurredAt: new Date(NOW).toISOString(),
        payload: {
          taskId,
          lifecycleRevision: 2,
          previousStatus: 'pending',
          status: 'interrupted',
          updatedAt: new Date(NOW).toISOString(),
          errorSummary: 'manual-repair-S4',
          nodeChanges: [],
          workspacePruneClaim: null,
          sourceTerminationEffectRef: null,
          continuationHandoff: false,
        },
      }),
    )
  })

  test('options and execution are shared; manual audit keeps its actor and automatic audit stays null', async () => {
    const actor = await manualActor(harness.db)
    const manual = await seed(harness.db)
    const automatic = await seed(harness.db)
    const actors: Array<{ actor: Actor; taskId: string }> = []
    const { persistence, repairs } = repairEngineFor(harness, {
      onManualActor: (actor, taskId) => actors.push({ actor, taskId }),
    })
    const resumed: string[] = []
    const binding = repairs.automaticRepair({
      resume: {
        resume: async (taskId) => {
          resumed.push(taskId)
        },
      },
      now: () => NOW,
    })
    const [alert] = await listOpenLifecycleAlertsForTask(
      persistence.recoveryAdministration,
      automatic.taskId,
    )
    expect(await binding.resolveOptions(alert!)).toEqual([
      ...(
        await repairs.repairOptions({ actor, taskId: automatic.taskId, alertId: automatic.alertId })
      ).options,
    ])
    const result = await repairs.applyRepair({
      actor,
      ...manual,
      optionId: 'S4.kick-task',
      onAlert: () => {},
      onResolved: () => {},
    })
    expect(result).toEqual({
      ok: true,
      auditId: expect.any(String),
      outcome: 'success',
      resolvedAlertIds: [manual.alertId],
      newAlerts: [],
    })
    expect(await binding.applyOption(alert!, 'S4.kick-task')).toEqual({ outcome: 'success' })
    expect(actors).toEqual([{ actor, taskId: manual.taskId }])
    expect(resumed).toEqual([automatic.taskId])
    expect((await auditRows(harness.db, manual.taskId))[0]).toMatchObject({
      actorUserId: actor.user.id,
      beforeSnapshotJson: JSON.stringify({ task: { id: manual.taskId, status: 'pending' } }),
      afterSnapshotJson: JSON.stringify({ task: { id: manual.taskId, status: 'interrupted' } }),
    })
    expect((await auditRows(harness.db, automatic.taskId))[0]).toMatchObject({
      actorUserId: null,
      beforeSnapshotJson: JSON.stringify({ task: { status: 'pending' } }),
      afterSnapshotJson: JSON.stringify({ task: { status: 'interrupted' } }),
    })
  })

  test("resume failure preserves each caller's response and task diagnostics without resolving alerts", async () => {
    const actor = await manualActor(harness.db)
    const manual = await seed(harness.db)
    const automatic = await seed(harness.db)
    const resume = async () => {
      throw new Error('scheduler refused the kick')
    }
    const { persistence, repairs } = repairEngineFor(harness, { resume })
    expect(
      await repairs.applyRepair({
        actor,
        ...manual,
        optionId: 'S4.kick-task',
        onAlert: () => {},
        onResolved: () => {},
      }),
    ).toEqual({
      ok: false,
      auditId: expect.any(String),
      outcome: 'apply-failed',
      outcomeMessage: 'mutations applied but resume failed: scheduler refused the kick',
      resolvedAlertIds: [],
      newAlerts: [],
    })
    const command = createTaskLifecycleAutoRepairCommand({
      ...repairs.automaticRepair({ resume: { resume }, now: () => NOW }),
      operations: persistence.recoveryAdministration,
      now: () => NOW,
    })
    expect(forTask(await command.run(OPEN_POLICY), automatic.taskId)).toEqual({
      repaired: [
        {
          ...automatic,
          optionId: 'S4.kick-task',
          outcome: 'apply-failed: scheduler refused the kick',
        },
      ],
      skipped: [],
    })
    for (const entry of [manual, automatic]) {
      expect(await statusOf(harness.db, entry.taskId)).toBe('interrupted')
      expect(await alertResolvedAt(harness.db, entry.alertId)).toBeNull()
      // The committed kick survives a failed resume. Preserve its original
      // diagnostic fields, including the automatic caller's alert reference.
      expect(
        await harness.db
          .select({
            finishedAt: tasks.finishedAt,
            errorSummary: tasks.errorSummary,
            errorMessage: tasks.errorMessage,
            failedNodeId: tasks.failedNodeId,
          })
          .from(tasks)
          .where(eq(tasks.id, entry.taskId))
          .get(),
      ).toEqual({
        finishedAt: NOW,
        errorSummary: 'manual-repair-S4',
        errorMessage:
          entry === manual
            ? 'RFC-057 repair S4.kick-task'
            : `RFC-057 repair S4.kick-task via alert ${entry.alertId}`,
        failedNodeId: null,
      })
    }
    expect((await auditRows(harness.db, manual.taskId))[0]?.actorUserId).toBe(actor.user.id)
    expect((await auditRows(harness.db, automatic.taskId))[0]?.actorUserId).toBeNull()
  })

  test('a stale automatic preflight uses the shared audit and reports apply-failed-or-lease-held', async () => {
    const { taskId, alertId } = await seed(harness.db)
    let resumes = 0
    const { persistence, repairs } = repairEngineFor(harness)
    const binding = repairs.automaticRepair({
      resume: {
        resume: async () => {
          resumes += 1
        },
      },
      now: () => NOW,
    })
    const command = createTaskLifecycleAutoRepairCommand({
      ...binding,
      resolveOptions: async (alert) => {
        const options = await binding.resolveOptions(alert)
        await harness.db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, taskId))
        return options
      },
      operations: persistence.recoveryAdministration,
      now: () => NOW,
    })
    expect(forTask(await command.run(OPEN_POLICY), taskId)).toEqual({
      repaired: [],
      skipped: [{ taskId, alertId, reason: 'apply-failed-or-lease-held' }],
    })
    expect(resumes).toBe(0)
    expect(await alertResolvedAt(harness.db, alertId)).toBeNull()
    expect((await auditRows(harness.db, taskId))[0]).toMatchObject({
      actorUserId: null,
      outcome: 'preflight-stale',
      beforeSnapshotJson: JSON.stringify({ task: { status: 'pending' } }),
      afterSnapshotJson: '{}',
      outcomeMessage: 'task is no longer pending',
    })
  })

  test('automatic callbacks receive complete alert rows while the manual route keeps its notice projection', async () => {
    const actor = await manualActor(harness.db)
    const manual = await seed(harness.db)
    const automatic = await seed(harness.db)
    const resume = async (taskId: string) => {
      await harness.db.update(tasks).set({ status: 'pending' }).where(eq(tasks.id, taskId))
    }
    const { persistence, repairs } = repairEngineFor(harness, { resume })
    const notices: TaskRouteLifecycleAlertNotice[] = []
    const rows: LifecycleAlertRow[] = []
    const resolved: string[] = []
    await repairs.applyRepair({
      actor,
      ...manual,
      optionId: 'S4.kick-task',
      onAlert: (row) => notices.push(row),
      onResolved: (taskId) => resolved.push(taskId),
    })
    const [alert] = await listOpenLifecycleAlertsForTask(
      persistence.recoveryAdministration,
      automatic.taskId,
    )
    await repairs
      .automaticRepair({
        resume: { resume },
        onAlert: (row) => rows.push(row),
        onResolved: (taskId) => resolved.push(taskId),
        now: () => NOW + 123,
      })
      .applyOption(alert!, 'S4.kick-task')
    expect(notices).toEqual([{ taskId: manual.taskId, rule: 'S4', severity: 'warning' }])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: expect.any(String),
      taskId: automatic.taskId,
      rule: 'S4',
      severity: 'warning',
      detail: expect.any(Object),
      detectedAt: NOW + 123,
      resolvedAt: null,
    })
    expect(rows[0]?.id).not.toBe(automatic.alertId)
    expect(resolved).toContain(manual.taskId)
    expect(resolved).toContain(automatic.taskId)
    expect(await alertResolvedAt(harness.db, automatic.alertId)).toBe(NOW + 123)
  })

  test.each(['manual', 'automatic'] as const)(
    '%s apply loses the task-status race: shared failure audit retains the caller and no resume runs',
    async (caller) => {
      const actor = await manualActor(harness.db)
      const entry = await seed(harness.db)
      let resumes = 0
      const resume = async () => {
        resumes += 1
      }
      const { persistence, repairs } = repairEngineFor(harness, {
        resume,
        beforeTransition: async (taskId) => {
          // The real lifecycle CAS observes a row changed after the engine's preflight.
          await harness.db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, taskId))
        },
      })
      if (caller === 'manual') {
        await expect(
          repairs.applyRepair({
            actor,
            ...entry,
            optionId: 'S4.kick-task',
            onAlert: () => {},
            onResolved: () => {},
          }),
        ).rejects.toMatchObject({ code: 'repair-preflight-stale' })
      } else {
        const command = createTaskLifecycleAutoRepairCommand({
          ...repairs.automaticRepair({ resume: { resume }, now: () => NOW }),
          operations: persistence.recoveryAdministration,
          now: () => NOW,
        })
        expect(forTask(await command.run(OPEN_POLICY), entry.taskId)).toEqual({
          repaired: [],
          skipped: [{ ...entry, reason: 'apply-failed-or-lease-held' }],
        })
      }
      expect((await auditRows(harness.db, entry.taskId))[0]).toMatchObject({
        actorUserId: caller === 'manual' ? actor.user.id : null,
        outcome: caller === 'manual' ? 'apply-failed' : 'preflight-stale',
        beforeSnapshotJson: JSON.stringify({
          task:
            caller === 'manual' ? { id: entry.taskId, status: 'pending' } : { status: 'pending' },
        }),
        afterSnapshotJson: '{}',
        outcomeMessage:
          caller === 'manual'
            ? `task ${entry.taskId} changed before S4.kick-task could apply`
            : 'task is no longer pending',
      })
      expect(resumes).toBe(0)
      expect(await statusOf(harness.db, entry.taskId)).toBe('running')
      expect(await alertResolvedAt(harness.db, entry.alertId)).toBeNull()
    },
  )
})

// ---------------------------------------------------------------------------
// 两侧既有修复引擎的注入缝仍不同：
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
// 自动循环通过绑定使用各引擎的既有活性来源。
