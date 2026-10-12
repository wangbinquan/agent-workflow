import type { CompleteWorkingRows } from '../ports/completeWorkingRows'
import type { HistoricalWorkingNativeRecord } from '../ports/historicalObservationWorking'
import type { HistoricalObservationStage } from '../ports/historicalObservationPreparation'
import { completeWorkingTraversal } from './completeWorkingTraversal'

type IndexInput = {
  readonly rows: CompleteWorkingRows
  readonly stage: HistoricalObservationStage
  readonly keyOf: (value: string) => string
  readonly signal?: AbortSignal
}

/** A retried root can add references to an existing record; recalculate all of its candidates. */
export async function indexHistoricalObservationCandidate(
  input: IndexInput,
  record: { readonly key: string; readonly document: HistoricalWorkingNativeRecord },
) {
  const space = (name: string) => input.stage.namespace + '/' + name
  const target = space('record-candidates/' + record.key)
  await input.rows.clear(target)
  let exact = false
  for await (const event of completeWorkingTraversal<{ referenceId: string; sessionId: string }>(
    input.rows,
    space('event-refs/' + input.keyOf(record.document.step.stepId)),
    input.signal,
  )) {
    if (event.document.sessionId !== record.document.step.id) continue
    exact = true
    await input.rows.put(target, {
      key: input.keyOf(event.document.referenceId),
      document: event.document.referenceId,
    })
  }
  if (exact) return
  for await (const root of completeWorkingTraversal<{ rootKey: string }>(
    input.rows,
    space('record-roots/' + record.key),
    input.signal,
  ))
    for await (const reference of completeWorkingTraversal<{ referenceId: string }>(
      input.rows,
      space('root-refs/' + root.document.rootKey),
      input.signal,
    ))
      await input.rows.put(target, {
        key: input.keyOf(reference.document.referenceId),
        document: reference.document.referenceId,
      })
}

/** Preserve every exact event candidate; use every retained root only when none is exact. */
export async function indexHistoricalObservationCandidates(input: IndexInput) {
  for await (const record of completeWorkingTraversal<HistoricalWorkingNativeRecord>(
    input.rows,
    input.stage.nativeRecordsNamespace,
    input.signal,
  ))
    await indexHistoricalObservationCandidate(input, record)
}
