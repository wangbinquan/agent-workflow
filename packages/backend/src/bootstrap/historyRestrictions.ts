// RFC-395 II-b: the daemon binds one system-operations provider into N/C.
import type { HistoryRestrictionPort } from '@/platform/contracts/historyRestriction'

export interface HistoryRestrictionBindings {
  readonly nodeRunHistoryRestrictions: HistoryRestrictionPort
  readonly gateHistoryRestrictions: HistoryRestrictionPort
}

/** No default provider or global registration. The daemon passes these dependencies
 * to the owner composition roots; importing this file does not start or bind anything.
 */
export function createHistoryRestrictionBindings(
  provider: HistoryRestrictionPort,
): HistoryRestrictionBindings {
  return Object.freeze({
    nodeRunHistoryRestrictions: provider,
    gateHistoryRestrictions: provider,
  })
}
