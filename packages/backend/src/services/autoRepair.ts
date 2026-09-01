// RFC-108 T19 (AR-04) — closed detect→classify→auto-repair loop (DEFAULT OFF).
//
// The detect half (lifecycle invariants + stuck-task detector) and the fix half
// (RFC-057 applyRepairOption) both exist but never close: every repair needs a
// human click. This loop closes it for the conservatively-classified options —
// for each OPEN alert whose rule the operator enabled (`config.autoRepair[rule]`),
// it resolves the repair options and, only when EXACTLY ONE is autoApplyEligible
// AND available (selectAutoApplyOption), applies it as the system actor. Every
// guard from the rest of RFC-108 gates it: quarantine, circuit-breaker, driver
// lease, recovery audit. Anything ambiguous (0 or ≥2 eligible) is left for a
// human — the loop never guesses.
//
// resolveOptions / applyOption are injected so the loop logic is unit-testable
// without the full repair engine; startAutoRepairLoop wires the real
// listRepairOptionsForAlert / applyRepairOption.

import { selectAutoApplyOption, type RepairOption } from '@agent-workflow/shared'

import { loadConfig } from '@/config'
import type { TaskRecoveryOperations } from '@/modules/task-execution/application/ports/taskRecoveryOperations'
import { recordRecoveryEvent } from '@/services/recovery'
import {
  type BreakerConfig,
  isAutoRecoverySuspended,
  recordAutoRecoveryAttempt,
} from '@/services/recoveryBreaker'
import { listAllOpenLifecycleAlerts, type OpenLifecycleAlert } from '@/services/taskAlerts'
import { createLogger } from '@/util/log'
import { DAEMON_CADENCE } from './daemonCadence'
import type {
  TaskLifecycleAutoRepairCommand,
  TaskLifecycleAutoRepairResult,
} from '@/modules/task-execution/application/ports/taskLifecycleAutoRepairCommand'

const log = createLogger('auto-repair')

export interface AutoRepairDeps {
  operations: TaskRecoveryOperations
  breaker: BreakerConfig
  /** config.autoRepair[rule] === true. */
  isRuleEnabled: (rule: string) => boolean
  /** Resolve repair options for an alert (wraps listRepairOptionsForAlert). */
  resolveOptions: (alert: OpenLifecycleAlert) => Promise<RepairOption[]>
  /** Apply the chosen option as the system actor (wraps applyRepairOption). */
  applyOption: (alert: OpenLifecycleAlert, optionId: string) => Promise<{ outcome: string }>
  now?: () => number
}

export type AutoRepairResult = TaskLifecycleAutoRepairResult

export async function runAutoRepairOnce(deps: AutoRepairDeps): Promise<AutoRepairResult> {
  const { operations, breaker, isRuleEnabled, resolveOptions, applyOption } = deps
  const now = deps.now ?? Date.now
  const out: AutoRepairResult = { repaired: [], skipped: [] }
  const skip = (a: OpenLifecycleAlert, reason: string): void => {
    out.skipped.push({ taskId: a.taskId, alertId: a.id, reason })
  }

  for (const alert of await listAllOpenLifecycleAlerts(operations)) {
    if (!isRuleEnabled(alert.rule)) {
      skip(alert, 'rule-disabled')
      continue
    }
    if (await isAutoRecoverySuspended(operations, alert.taskId)) {
      skip(alert, 'quarantined')
      continue
    }
    let options: RepairOption[]
    try {
      options = await resolveOptions(alert)
    } catch (err) {
      log.warn('resolveOptions threw', {
        alertId: alert.id,
        error: err instanceof Error ? err.message : String(err),
      })
      skip(alert, 'resolve-failed')
      continue
    }
    const chosen = selectAutoApplyOption(options)
    if (chosen === null) {
      skip(alert, 'no-single-eligible')
      continue
    }
    const { suspended } = await recordAutoRecoveryAttempt(operations, alert.taskId, breaker, now())
    if (suspended) {
      skip(alert, 'breaker-tripped')
      continue
    }
    let result: { outcome: string } | null = null
    try {
      result = await applyOption(alert, chosen.id)
      await recordRecoveryEvent(operations, {
        taskId: alert.taskId,
        nodeRunId: null,
        kind: 'auto-repair',
        reason: `${alert.rule}:${chosen.id}:${result.outcome}`,
        after: { optionId: chosen.id, outcome: result.outcome },
        now: now(),
      })
    } catch (err) {
      log.warn('applyOption threw', {
        alertId: alert.id,
        optionId: chosen.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    if (result !== null) {
      out.repaired.push({
        taskId: alert.taskId,
        alertId: alert.id,
        optionId: chosen.id,
        outcome: result.outcome,
      })
    } else {
      skip(alert, 'apply-failed-or-lease-held')
    }
  }
  return out
}

export interface AutoRepairLoopHandle {
  stop: () => void
}

/**
 * Periodic auto-repair ticker for the daemon. DEFAULT OFF: with `autoRepair`
 * empty (the default) every tick early-outs in O(1) before touching the DB, so
 * this is free until an operator enables a rule. The repair engine is loaded via
 * dynamic import to keep this module out of the lifecycleRepair→options→task
 * static cycle (binary-build safety).
 */
export function startAutoRepairLoop(opts: {
  command: TaskLifecycleAutoRepairCommand
  configPath: string
  intervalMs?: number
}): AutoRepairLoopHandle {
  const intervalMs = opts.intervalMs ?? DAEMON_CADENCE.autoRepair
  let inFlight = false
  const tick = async (): Promise<void> => {
    if (inFlight) return
    inFlight = true
    try {
      const cfg = loadConfig(opts.configPath)
      const autoRepair = cfg.autoRepair ?? {}
      if (!Object.values(autoRepair).some((v) => v === true)) return // default: nothing enabled
      await opts.command.run({
        enabledRules: Object.entries(autoRepair)
          .filter(([, enabled]) => enabled === true)
          .map(([rule]) => rule),
        maxPerWindow: cfg.maxAutoRecoveriesPerWindow,
        windowMs: cfg.autoRecoveryWindowMs,
      })
    } catch (err) {
      log.warn('auto-repair tick failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      inFlight = false
    }
  }
  const timer = setInterval(() => void tick(), intervalMs)
  ;(timer as { unref?: () => void }).unref?.()
  return { stop: () => clearInterval(timer) }
}
