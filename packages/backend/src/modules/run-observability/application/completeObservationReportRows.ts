import { completeOrdinalKey } from '../domain/completeOrdinal'
import type { CompleteObservationSection } from '@agent-workflow/shared'
import type {
  CompleteObservationCohortInput,
  CompleteObservationReportCount,
  CompleteObservationReportRow,
} from '../ports/completeObservationReport'
import type { CompleteWorkingRow } from '../ports/completeWorkingRows'
import { completeWorkingCache } from './completeWorkingCache'

/** The only bounds are write batches; every output row gets an immutable ordinal. */
export function completeObservationReportRows(
  input: Pick<CompleteObservationCohortInput, 'rows' | 'namespace' | 'keyOf' | 'signal'>,
) {
  const namespace = input.namespace + '/report-rows',
    countsNamespace = input.namespace + '/report-counts'
  const counts = completeWorkingCache<CompleteObservationReportCount>(
    input.rows,
    countsNamespace,
    input.signal,
  )
  const pending: CompleteWorkingRow<CompleteObservationReportRow>[] = []
  let ordinal = 0n
  async function flush() {
    input.signal?.throwIfAborted()
    if (pending.length) {
      await input.rows.insert(namespace, pending)
      pending.length = 0
    }
    await counts.flush()
  }
  return {
    namespace,
    async count(section: CompleteObservationSection, parent: string | null) {
      const identity = input.keyOf(JSON.stringify([section, parent]))
      const value = await counts.get(identity)
      if (value && (value.section !== section || value.parent !== parent))
        throw new Error('Complete original output count identity changed')
      return value?.total ?? '0'
    },
    countsNamespace,
    flush,
    async append(
      section: CompleteObservationSection,
      parent: string | null,
      key: string,
      document: unknown,
    ) {
      const identity = input.keyOf(JSON.stringify([section, parent])),
        previous = await counts.get(identity)
      if (previous && (previous.section !== section || previous.parent !== parent))
        throw new Error('Complete report count identity changed')
      pending.push({
        key: completeOrdinalKey(ordinal++),
        document: { section, parent, key, document },
      })
      await counts.put(identity, {
        section,
        parent,
        total: String(BigInt(previous?.total ?? '0') + 1n),
      })
      if (pending.length === 500) await flush()
    },
  }
}
