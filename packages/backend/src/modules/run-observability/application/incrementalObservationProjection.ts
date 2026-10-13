import type { QualifiedObservationContribution } from '../ports/incrementalObservationQualified'
import { qualifiedObservationIndexes } from '../domain/qualifiedObservationIndexes'
import { observationRowCountFold } from '../domain/observationRowCount'
import type {
  IncrementalObservationComponentSource,
  IncrementalObservationContribution,
  IncrementalObservationProjectionStore,
  IncrementalObservationProjectionTransaction,
  IncrementalObservationVersion,
  IncrementalObservationWork,
} from '../ports/incrementalObservationProjection'
import {
  emptyIncrementalObservationFold,
  replaceIncrementalObservationContribution,
} from '../domain/incrementalObservationFold'

export class IncrementalObservationSourceChanged extends Error {}

async function* ordered(
  rows: AsyncIterable<IncrementalObservationContribution>,
  components: ReadonlySet<string>,
  index = false,
) {
  let last: string | undefined
  for await (const row of rows) {
    if (!row.key || !components.has(row.component) || (last !== undefined && row.key <= last))
      throw new Error('Incremental observation component identity or order changed')
    if (
      row.aggregates.some((key) => !key) ||
      new Set(row.aggregates).size !== row.aggregates.length
    )
      throw new Error('Incremental observation aggregate membership is invalid')
    last = row.key
    yield index ? qualifiedObservationIndexes(row as QualifiedObservationContribution) : row
  }
}

async function replace(
  tx: IncrementalObservationProjectionTransaction,
  previous: IncrementalObservationContribution | null,
  next: IncrementalObservationContribution | null,
  version: IncrementalObservationVersion,
) {
  if (previous && next && JSON.stringify(previous) === JSON.stringify(next)) return false
  if (!previous && !next) return false
  if (next?.descriptors) await tx.retainDescriptors?.(next.descriptors)
  for (const key of new Set([...(previous?.aggregates ?? []), ...(next?.aggregates ?? [])])) {
    const current = (await tx.aggregate(key)) ?? emptyIncrementalObservationFold()
    const updated = replaceIncrementalObservationContribution(
      current,
      previous?.aggregates.includes(key)
        ? key.startsWith('row-count/')
          ? observationRowCountFold()
          : previous.fold
        : null,
      next?.aggregates.includes(key)
        ? key.startsWith('row-count/')
          ? observationRowCountFold()
          : next.fold
        : null,
    )
    if (updated !== current) await tx.putAggregate(key, updated, version)
  }
  await tx.putContribution((next ?? previous)!.key, next, version)
  return true
}

/** Consumer transaction atomically replaces contributions, versioned buckets and
 * completed work. The source has already converged upstream revisions; neither
 * a GET nor a period selection invokes this consumer. */
export function createIncrementalObservationProjection(input: {
  readonly store: IncrementalObservationProjectionStore
  readonly source: IncrementalObservationComponentSource
  readonly now: () => number
  readonly committed?: (version: IncrementalObservationVersion) => void
}) {
  return {
    async apply(work: IncrementalObservationWork) {
      if (
        !work.components.length ||
        work.components.some((key) => !key) ||
        new Set(work.components).size !== work.components.length
      )
        throw new Error('Incremental observation affected components are invalid')
      const components = new Set(work.components)
      const result = await input.store.change(async (tx) => {
        const head = await tx.head()
        if (!(await tx.sourceUnchanged(work))) throw new IncrementalObservationSourceChanged()
        const version = {
          revision: String(BigInt(head.revision) + 1n),
          asOf: Math.max(head.asOf, work.asOf ?? input.now()),
        }
        const old = ordered(tx.previous(work), components)[Symbol.asyncIterator]()
        const next = ordered(input.source.contributions(tx, work), components, true)[
          Symbol.asyncIterator
        ]()
        let changed = false
        try {
          let before = await old.next(),
            after = await next.next()
          while (!before.done || !after.done) {
            if (!before.done && (after.done || before.value.key < after.value.key)) {
              changed = (await replace(tx, before.value, null, version)) || changed
              before = await old.next()
            } else if (!after.done && (before.done || after.value.key < before.value.key)) {
              changed = (await replace(tx, null, after.value, version)) || changed
              after = await next.next()
            } else if (!before.done && !after.done) {
              changed = (await replace(tx, before.value, after.value, version)) || changed
              before = await old.next()
              after = await next.next()
            }
          }
        } finally {
          await old.return?.(undefined)
          await next.return?.(undefined)
        }
        if (!(await tx.sourceUnchanged(work))) throw new IncrementalObservationSourceChanged()
        changed = (await tx.coverageChanged?.(work)) || changed
        if (changed) await tx.publish(version)
        await tx.complete(work)
        return { changed, version: changed ? version : head }
      })
      // This is only a wake-up. A lost notification is recovered by reading the
      // committed version; it cannot lose or reapply a source contribution.
      if (result.changed) input.committed?.(result.version)
      return result
    },
  }
}
