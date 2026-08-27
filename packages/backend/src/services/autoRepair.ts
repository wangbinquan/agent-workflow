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
import type { DbClient } from '@/db/client'
import { resolveLaunchRuntimeConfig } from '@/services/launchRuntimeConfig'
import { createLegacyTaskExecutionTopology } from '@/services/startTaskDeps'
import { recordRecoveryEvent } from '@/services/recovery'
import {
  type BreakerConfig,
  isAutoRecoverySuspended,
  recordAutoRecoveryAttempt,
} from '@/services/recoveryBreaker'
import { listAllOpenLifecycleAlerts, type OpenLifecycleAlert } from '@/services/taskAlerts'
import { createLogger } from '@/util/log'
import { DAEMON_CADENCE } from './daemonCadence'

const log = createLogger('auto-repair')

export interface AutoRepairDeps {
  db: DbClient
  breaker: BreakerConfig
  /** config.autoRepair[rule] === true. */
  isRuleEnabled: (rule: string) => boolean
  /** Resolve repair options for an alert (wraps listRepairOptionsForAlert). */
  resolveOptions: (alert: OpenLifecycleAlert) => Promise<RepairOption[]>
  /** Apply the chosen option as the system actor (wraps applyRepairOption). */
  applyOption: (alert: OpenLifecycleAlert, optionId: string) => Promise<{ outcome: string }>
  now?: () => number
}

export interface AutoRepairResult {
  repaired: Array<{ taskId: string; alertId: string; optionId: string; outcome: string }>
  skipped: Array<{ taskId: string; alertId: string; reason: string }>
}

export async function runAutoRepairOnce(deps: AutoRepairDeps): Promise<AutoRepairResult> {
  const { db, breaker, isRuleEnabled, resolveOptions, applyOption } = deps
  const now = deps.now ?? Date.now
  const out: AutoRepairResult = { repaired: [], skipped: [] }
  const skip = (a: OpenLifecycleAlert, reason: string): void => {
    out.skipped.push({ taskId: a.taskId, alertId: a.id, reason })
  }

  for (const alert of await listAllOpenLifecycleAlerts(db)) {
    if (!isRuleEnabled(alert.rule)) {
      skip(alert, 'rule-disabled')
      continue
    }
    if (await isAutoRecoverySuspended(db, alert.taskId)) {
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
    const { suspended } = await recordAutoRecoveryAttempt(db, alert.taskId, breaker, now())
    if (suspended) {
      skip(alert, 'breaker-tripped')
      continue
    }
    let result: { outcome: string } | null = null
    try {
      result = await applyOption(alert, chosen.id)
      await recordRecoveryEvent(db, {
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
  db: DbClient
  appHome: string
  configPath: string
  onAlert?: (
    row: { taskId: string; rule: string; severity: 'warning' | 'error' },
    transition: 'new' | 'promoted',
  ) => void
  onResolved?: (taskId: string) => void
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
      const deps = {
        db: opts.db,
        schedulerDriver: createLegacyTaskExecutionTopology(opts.db).schedulerDriver,
        configPath: opts.configPath,
        ...(cfg.subagentLiveCapture !== undefined
          ? { subagentLiveCapture: cfg.subagentLiveCapture }
          : {}),
        ...resolveLaunchRuntimeConfig(opts.configPath),
      }
      const { applyRepairOption, listRepairOptionsForAlert } =
        await import('@/services/lifecycleRepair')
      await runAutoRepairOnce({
        db: opts.db,
        breaker: {
          maxPerWindow: cfg.maxAutoRecoveriesPerWindow,
          windowMs: cfg.autoRecoveryWindowMs,
        },
        isRuleEnabled: (rule) => autoRepair[rule] === true,
        resolveOptions: (alert) =>
          listRepairOptionsForAlert({
            db: opts.db,
            taskId: alert.taskId,
            alertId: alert.id,
            actorUserId: null,
            appHome: opts.appHome,
            deps,
          }).then((r) => r.options as RepairOption[]),
        applyOption: (alert, optionId) =>
          applyRepairOption({
            db: opts.db,
            taskId: alert.taskId,
            alertId: alert.id,
            optionId,
            actorUserId: null,
            appHome: opts.appHome,
            deps,
            onAlert: opts.onAlert,
            onResolved: opts.onResolved,
          }).then((r) => ({ outcome: r.outcome })),
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
