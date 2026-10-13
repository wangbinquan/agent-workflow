import { sha256Hex } from '@/util/hash'
import type {
  CompleteObservationSection,
  HistoricalObservationExecution,
  ObservationAttemptFacts,
} from '@agent-workflow/shared'
import type { IncrementalObservationContributionFold } from './incrementalObservationFold'
interface QualifiedObservationContribution {
  key: string
  component: string
  fold: IncrementalObservationContributionFold
  aggregates: readonly string[]
  descriptors?: Readonly<Record<string, string>>
  detail: {
    section: CompleteObservationSection | 'cohort-fold'
    parent: string | null
    key: string
    taskId: string | null
    cohortAt: number | null
    document: unknown
    humanWaitingSince?: number | null
    nativeRecord?: boolean
    visibility?: readonly { taskId: string | null; ownerUserId: string | null }[]
    scopes?: readonly HistoricalObservationExecution[]
    bindings?: readonly { kind: string; identity: string }[]
    selectors?: {
      workflowId: string | null
      repositories: readonly string[]
      visibilityKey?: string
    }
    timingAttempts?: readonly ObservationAttemptFacts[]
  }
}
import { observationRowCountKey } from './observationRowCount'
import { observationWindowCellKey } from './observationWindowCell'
import type { CompleteObservationTimePartition } from '@agent-workflow/shared'
type ProjectionOccurrence = CompleteObservationTimePartition & {
  referenceIds: readonly string[]
  model: { provider: string | null; id: string } | null
}
/** Rebuild indexes from already qualified evidence, including an unreadable
 * source's retained old contribution. No native read or numerical allocation. */
export function qualifiedObservationIndexes(
  row: QualifiedObservationContribution,
): QualifiedObservationContribution {
  const detail = row.detail,
    document = detail.document as {
      invocationId?: string
      invocation?: { invocationId?: string }
      fact?: { invocationId?: string }
    } | null,
    scope = {
      section: detail.section,
      parent: detail.parent,
      key: detail.key,
      taskId: detail.taskId,
      cohortAt: detail.cohortAt,
      visibility: detail.visibility,
      scopes: detail.scopes,
      nativeRecord: detail.nativeRecord,
      document: {
        invocationId:
          document?.invocationId ??
          document?.invocation?.invocationId ??
          document?.fact?.invocationId,
      },
    },
    keys = [observationRowCountKey(row.component, scope)]
  if (detail.section === 'time-partitions' && detail.parent === null) {
    const key = observationWindowCellKey(row.component, detail.document as ProjectionOccurrence)
    if (key) keys.push(key)
  }
  if (
    detail.section === 'cohort-fold' ||
    ['agents', 'runtimes', 'models', 'purposes', 'sources'].includes(detail.section)
  ) {
    const {
      key: _key,
      bindings: _bindings,
      selectors: _selectors,
      timingAttempts: _attempts,
      ...group
    } = detail
    keys.push('qualified-group/' + JSON.stringify([row.component, group]))
  }
  const descriptors: Record<string, string> = {},
    compact = (key: string) => {
      if (/^(row-count|qualified-group|occurrence-cell)\/[a-f0-9]{64}$/.test(key)) {
        const existing = row.descriptors?.[key]
        if (!existing) throw new Error('Existing compact projection descriptor missing')
        descriptors[key] = existing
        return key
      }
      if (
        !['row-count/', 'qualified-group/', 'occurrence-cell/'].some((prefix) =>
          key.startsWith(prefix),
        )
      )
        return key
      const prefix = key.slice(0, key.indexOf('/') + 1),
        id = prefix + sha256Hex(key)
      descriptors[id] = key
      return id
    }
  return {
    ...row,
    descriptors,
    aggregates: [...new Set([...row.aggregates, ...keys].map(compact))],
  }
}
export function decodeQualifiedObservationGroup(key: string) {
  return JSON.parse(key.slice(16)) as [string, QualifiedObservationContribution['detail']]
}
