import type {
  CompleteObservationAllocation,
  ObservationPlatformNativeCapture,
} from '@agent-workflow/shared'
import type { PlatformObservation } from '../domain/platformObservation'
import { platformObservationKey } from '../domain/platformSync'
import { TOKEN_BUCKETS } from '../domain/tokenUsage'
import {
  addCompleteObservationAllocation,
  completeObservationGap,
} from '../domain/completeObservationMetrics'
import type { CompleteObservationContribution } from '../ports/completeObservationTask'
import type { CompleteObservationEvidenceContext } from './completeObservationEvidence'
import { completePlatformCaptureKey } from './completeObservationPlatform'
import { completeWorkingPages } from './completeWorkingTraversal'
import { selectCompleteUsage } from './completeUsageSelection'

interface Allocation {
  readonly record: CompleteObservationContribution
  readonly contribution: CompleteObservationContribution['contribution']
  readonly quality: { readonly ambiguous: boolean; readonly unavailable: boolean }
}
export async function allocateCompleteObservationUsage(
  context: CompleteObservationEvidenceContext,
  count: string,
) {
  const { input, space } = context
  context.usage.seal(count)
  const selection = await selectCompleteUsage(context.usage.workspace, input.signal)
  await context.usage.flush()
  if (selection.ambiguousOverlaps !== '0' || selection.unavailableSummaries !== '0')
    completeObservationGap(context.fold, 'coverage-incomplete')
  for await (const page of completeWorkingPages<Allocation>(
    input.rows,
    context.usage.allocationsNamespace,
    input.signal,
  )) {
    const allocations = []
    for (const row of page) {
      const { record, contribution, quality } = row.document,
        { key, entry } = await context.invocationFor(record.invocationId)
      if (quality.ambiguous || quality.unavailable || !record.complete)
        completeObservationGap(entry.fold, 'coverage-incomplete')
      let cost: CompleteObservationAllocation['cost']
      if (entry.invocation.authority.kind === 'local') {
        const value = await input.value({
          invocationId: record.invocationId,
          model: record.localModel,
          condition: null,
          usage: contribution,
        })
        cost = {
          amount:
            value.availability === 'priced' && value.completeness === 'complete'
              ? value.amountDecimal
              : null,
          complete: value.availability === 'priced' && value.completeness === 'complete',
          hidden: false,
        }
      } else {
        const original = record.platformUsage
        if (!original) throw new Error('Original platform allocation missing')
        const scope = original.scope
        const capture =
          scope === null
            ? undefined
            : await input.rows.get<ObservationPlatformNativeCapture>(
                space('platform-capture-turns'),
                input.keyOf(
                  completePlatformCaptureKey(
                    record.invocationId,
                    original.sourceId,
                    scope.root,
                    scope.turn,
                    scope.turnIndex,
                  ),
                ),
              )
        if (!capture || capture.state !== 'complete')
          completeObservationGap(entry.fold, 'native-capture-unobserved')
        const value = await input.rows.get<Extract<PlatformObservation, { kind: 'valuation' }>>(
          space('platform-valuations'),
          input.keyOf(JSON.stringify([record.invocationId, platformObservationKey(original)])),
        )
        const whole = TOKEN_BUCKETS.every(
          (bucket) => contribution[bucket] === original.projection.contribution[bucket],
        )
        const complete =
          whole &&
          value?.availability === 'priced' &&
          value.completeness === 'complete' &&
          value.usageRevision === original.projection.projectionRevision
        cost = {
          amount: complete ? value.amountDecimal : null,
          complete,
          hidden: !entry.fold.visible || value?.availability === 'not-authorized',
        }
      }
      addCompleteObservationAllocation(entry.fold, contribution, cost)
      allocations.push({
        key: row.key,
        document: {
          invocation: entry.invocation,
          recordId: record.measurement.recordId,
          sourceId: record.sourceId,
          model: record.localModel ?? record.measurement.model,
          observedAt: record.observedAt,
          contribution,
          cost,
        } satisfies CompleteObservationAllocation,
      })
      await context.invocations.put(key, entry)
    }
    await input.rows.insert(space('allocations'), allocations)
  }
  return selection
}
