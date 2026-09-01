// RFC-108 T11 (AR-09) — auto-recovery circuit-breaker / quarantine.
//
// A task that deterministically crashes on every auto-resume / auto-repair would,
// the moment those loops turn on, be re-driven forever — burning real LLM cost +
// process handles each cycle. This bounds that: per-task rolling-window attempt
// accounting; after `maxPerWindow` attempts the task is QUARANTINED
// (`auto_recovery_suspended = 1`), excluding it from BOTH auto loops until a
// human clears it with one action. The quarantine flag is a SOFT flag (never a
// terminal status); the persistent recovery_events row makes the trip auditable.

import type { TaskRecoveryOperations } from '@/modules/task-execution/application/ports/taskRecoveryOperations'
import { recordRecoveryEvent } from '@/services/recovery'

export interface BreakerConfig {
  maxPerWindow: number
  windowMs: number
}

/** Is the task currently quarantined (excluded from the auto loops)? */
export async function isAutoRecoverySuspended(
  operations: TaskRecoveryOperations,
  taskId: string,
): Promise<boolean> {
  return operations.isAutoRecoverySuspended(taskId)
}

/**
 * Record an auto-recovery attempt against the rolling window and, if it pushes
 * the count OVER `maxPerWindow`, quarantine the task. Callers (the auto loops)
 * call this BEFORE acting and must NOT act when `suspended` is returned true.
 * Returns the post-update {suspended, attempts}.
 */
export async function recordAutoRecoveryAttempt(
  operations: TaskRecoveryOperations,
  taskId: string,
  cfg: BreakerConfig,
  now: number = Date.now(),
): Promise<{ suspended: boolean; attempts: number }> {
  const { suspended, attempts } = await operations.recordAutoRecoveryAttempt({
    taskId,
    config: cfg,
    now,
  })
  if (suspended) {
    await recordRecoveryEvent(operations, {
      taskId,
      kind: 'quarantine',
      reason: `auto-recovery attempts ${attempts} exceeded ${cfg.maxPerWindow} per ${cfg.windowMs}ms window`,
      after: { autoRecoverySuspended: true, attempts },
      now,
    })
  }
  return { suspended, attempts }
}

/** Human one-click clear — resets the breaker so the auto loops may retry. */
export async function clearAutoRecoverySuspension(
  operations: TaskRecoveryOperations,
  taskId: string,
): Promise<void> {
  await operations.clearAutoRecoverySuspension(taskId)
}
