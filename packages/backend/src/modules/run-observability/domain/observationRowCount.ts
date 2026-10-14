import type {
  CompleteObservationSection,
  HistoricalObservationExecution,
} from '@agent-workflow/shared'
import { emptyCompleteObservationFold } from './completeObservationMetrics'
export interface ObservationRowCountScope {
  section: CompleteObservationSection | 'cohort-fold'
  parent: string | null
  key: string
  taskId: string | null
  cohortAt: number | null
  visibility?: readonly { taskId: string | null; ownerUserId: string | null }[]
  scopes?: readonly HistoricalObservationExecution[]
  historicalRecordScopes?: readonly string[]
  nativeRecord?: boolean
  document?: { invocationId?: string }
}
export function observationRowCountKey(owner: string, detail: ObservationRowCountScope) {
  const { key: _key, ...scope } = detail
  return 'row-count/' + JSON.stringify([owner, scope])
}
export function decodeObservationRowCount(key: string): {
  owner: string
  detail: ObservationRowCountScope
} {
  const parsed = JSON.parse(key.slice(10)) as [string, ObservationRowCountScope]
  return { owner: parsed[0], detail: parsed[1] }
}
export function observationRowCountFold() {
  return {
    ...emptyCompleteObservationFold(),
    inventory: { tasks: '0', attempts: '0', numericRecords: '1', nativeCaptures: '0' },
  }
}
