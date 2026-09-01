import { and, asc, eq, isNull } from 'drizzle-orm'
import { ulid } from 'ulid'

import { isTurnEngineWorkgroupTask, type RepairOption } from '@agent-workflow/shared'
import { lifecycleAlerts, lifecycleRepairAudit, tasks } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { runAutoRepairOnce } from '@/services/autoRepair'
import { runLifecycleInvariants, type LifecycleAlertRow } from '@/services/lifecycleInvariants'
import { runStuckTaskDetector } from '@/services/stuckTaskDetector'
import type { OpenLifecycleAlert } from '@/services/taskAlerts'
import type { ActiveTaskExecutionParticipant } from '../application/ports/taskExecutionRuntimeParticipants'
import type {
  TaskLifecycleAutoRepairCommand,
  TaskLifecycleAutoRepairPolicy,
} from '../application/ports/taskLifecycleAutoRepairCommand'
import type { TaskRecoveryOperations } from '../application/ports/taskRecoveryOperations'
import type { TaskRuntimeLifecyclePersistence } from '../application/ports/taskRuntimeLifecyclePersistence'

const S4_KICK_OPTION: RepairOption = Object.freeze({
  id: 'S4.kick-task',
  rule: 'S4',
  labelKey: 'diagnose.repair.S4.kickTask.label',
  descriptionKey: 'diagnose.repair.S4.kickTask.desc',
  risk: 'low',
  destructive: false,
  available: true,
  previewSteps: [],
  autoApplyEligible: true,
  revivesExecution: true,
})

async function writeAudit(
  db: PostgresqlDatabaseClient,
  input: {
    readonly alert: OpenLifecycleAlert
    readonly outcome: 'success' | 'preflight-stale' | 'apply-failed'
    readonly outcomeMessage?: string
    readonly before: Readonly<Record<string, unknown>>
    readonly after: Readonly<Record<string, unknown>>
    readonly appliedAt: number
  },
): Promise<string> {
  const id = ulid()
  await db
    .insert(lifecycleRepairAudit)
    .values({
      id,
      taskId: input.alert.taskId,
      alertId: input.alert.id,
      alertRule: input.alert.rule,
      alertDetailJson: JSON.stringify(input.alert.detail),
      optionId: S4_KICK_OPTION.id,
      actorUserId: null,
      beforeSnapshotJson: JSON.stringify(input.before),
      afterSnapshotJson: JSON.stringify(input.after),
      outcome: input.outcome,
      outcomeMessage: input.outcomeMessage ?? null,
      appliedAt: input.appliedAt,
    })
    .run()
  return id
}

/** PostgreSQL implementation of the only auto-apply-eligible v1 repair, S4.kick-task. */
export function createPostgresqlTaskLifecycleAutoRepairCommand(input: {
  readonly db: PostgresqlDatabaseClient
  readonly operations: TaskRecoveryOperations
  readonly lifecycle: TaskRuntimeLifecyclePersistence
  readonly activity: ActiveTaskExecutionParticipant
  readonly resume: Readonly<{ resume(taskId: string): Promise<void> }>
  readonly onAlert?: (row: LifecycleAlertRow, transition: 'new' | 'promoted') => void
  readonly onResolved?: (taskId: string) => void
  readonly now?: () => number
}): TaskLifecycleAutoRepairCommand {
  const now = input.now ?? Date.now

  const resolveOptions = async (alert: OpenLifecycleAlert): Promise<RepairOption[]> => {
    if (alert.rule !== 'S4') return []
    const rows = await input.db
      .select({
        id: tasks.id,
        status: tasks.status,
        workgroupId: tasks.workgroupId,
        workgroupConfigJson: tasks.workgroupConfigJson,
      })
      .from(tasks)
      .where(eq(tasks.id, alert.taskId))
      .limit(1)
    const task = rows[0]
    if (
      task === undefined ||
      task.status !== 'pending' ||
      input.activity.isActive(alert.taskId) ||
      isTurnEngineWorkgroupTask(task)
    ) {
      return [{ ...S4_KICK_OPTION, available: false }]
    }
    return [S4_KICK_OPTION]
  }

  const applyOption = async (
    alert: OpenLifecycleAlert,
    optionId: string,
  ): Promise<{ outcome: string }> => {
    if (alert.rule !== 'S4' || optionId !== S4_KICK_OPTION.id) {
      throw new Error(`postgresql-auto-repair-option-not-supported:${alert.rule}:${optionId}`)
    }
    const appliedAt = now()
    const won = await input.lifecycle.trySet({
      taskId: alert.taskId,
      to: 'interrupted',
      allowedFrom: ['pending'],
      extra: {
        finishedAt: appliedAt,
        errorSummary: 'manual-repair-S4',
        errorMessage: `RFC-057 repair S4.kick-task via alert ${alert.id}`,
        failedNodeId: null,
      },
      now: appliedAt,
      reason: 'S4.kick-task',
    })
    if (!won) {
      await writeAudit(input.db, {
        alert,
        outcome: 'preflight-stale',
        outcomeMessage: 'task is no longer pending',
        before: { task: { status: 'pending' } },
        after: {},
        appliedAt,
      })
      throw new Error('repair-preflight-stale:task-is-no-longer-pending')
    }
    await writeAudit(input.db, {
      alert,
      outcome: 'success',
      before: { task: { status: 'pending' } },
      after: { task: { status: 'interrupted' } },
      appliedAt,
    })
    try {
      await input.resume.resume(alert.taskId)
    } catch (error) {
      return {
        outcome: `apply-failed: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    const beforeRows = await input.db
      .select({ id: lifecycleAlerts.id })
      .from(lifecycleAlerts)
      .where(and(eq(lifecycleAlerts.taskId, alert.taskId), isNull(lifecycleAlerts.resolvedAt)))
      .orderBy(asc(lifecycleAlerts.detectedAt))
    await input.db
      .update(lifecycleAlerts)
      .set({ resolvedAt: now() })
      .where(and(eq(lifecycleAlerts.id, alert.id), isNull(lifecycleAlerts.resolvedAt)))
      .run()
    input.onResolved?.(alert.taskId)
    await runLifecycleInvariants({
      operations: input.operations,
      scope: { taskId: alert.taskId },
      now,
      ...(input.onAlert === undefined ? {} : { onAlert: input.onAlert }),
      ...(input.onResolved === undefined ? {} : { onResolved: input.onResolved }),
    })
    await runStuckTaskDetector({
      operations: input.operations,
      now,
      taskIdFilter: [alert.taskId],
      ...(input.onAlert === undefined ? {} : { onAlert: input.onAlert }),
      ...(input.onResolved === undefined ? {} : { onResolved: input.onResolved }),
    })
    // Force both scans before returning; the read also proves the repaired row
    // is no longer the same open alert under PostgreSQL's async adapter.
    if (beforeRows.some((row) => row.id === alert.id)) {
      await input.db
        .select({ id: lifecycleAlerts.id })
        .from(lifecycleAlerts)
        .where(and(eq(lifecycleAlerts.id, alert.id), isNull(lifecycleAlerts.resolvedAt)))
        .limit(1)
    }
    return { outcome: 'success' }
  }

  return Object.freeze({
    async run(policy: TaskLifecycleAutoRepairPolicy) {
      const enabledRules = new Set(policy.enabledRules)
      return await runAutoRepairOnce({
        operations: input.operations,
        breaker: { maxPerWindow: policy.maxPerWindow, windowMs: policy.windowMs },
        isRuleEnabled: (rule) => enabledRules.has(rule),
        resolveOptions,
        applyOption,
        now,
      })
    },
  })
}
