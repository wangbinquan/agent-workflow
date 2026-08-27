import {
  startMaintenanceTicker,
  type MaintenanceTickerHandle,
  type TimerApi,
} from '@/services/maintenanceTicker'
import type { HumanGateOperationRecovery } from '../application/recoverHumanGateOperations'

export interface HumanGateRecoveryTickerOptions {
  readonly recovery: Pick<HumanGateOperationRecovery, 'runOnce'>
  readonly intervalMs: number
  readonly phaseOffsetMs: number
  readonly bootDelayMs?: number
  readonly timers?: TimerApi
  readonly now?: () => number
}

export function startHumanGateRecoveryTicker(
  options: HumanGateRecoveryTickerOptions,
): MaintenanceTickerHandle {
  return startMaintenanceTicker({
    job: 'human-gate-artifact-recovery',
    intervalMs: options.intervalMs,
    phaseOffsetMs: options.phaseOffsetMs,
    ...(options.bootDelayMs === undefined ? {} : { bootDelayMs: options.bootDelayMs }),
    ...(options.timers === undefined ? {} : { timers: options.timers }),
    ...(options.now === undefined ? {} : { now: options.now }),
    onTick: () => options.recovery.runOnce(),
  })
}
