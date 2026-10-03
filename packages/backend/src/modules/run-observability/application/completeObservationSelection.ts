import type {
  AcceptedObservationInvocation,
  CompleteObservationAllocation,
  CompleteObservationAttempt,
  CompleteObservationMetrics,
  ObservationDimensionSelection,
} from '@agent-workflow/shared'
import { invocationDimensionMatch, modelDimensionMatch } from '../domain/analysisDimensions'
import { completeMetricsFold } from '../domain/completeMetricsFold'
import {
  addCompleteObservationAllocation,
  completeObservationGap,
  completeObservationMetrics,
  emptyCompleteObservationFold,
  mergeCompleteObservationFold,
  type CompleteObservationFold,
} from '../domain/completeObservationMetrics'
import type {
  CompleteObservationTaskBuild,
  CompleteObservationTaskInput,
} from '../ports/completeObservationTask'
import { completeWorkingCache } from './completeWorkingCache'
import { completeWorkingTraversal } from './completeWorkingTraversal'
import { buildCompleteObservationTiming } from './completeObservationTiming'
import { buildCompleteObservationSpanDetails } from './completeObservationSpanDetails'

type Invocation = AcceptedObservationInvocation & { readonly metrics: CompleteObservationMetrics }
interface Candidate {
  invocation: Invocation
  match: ReturnType<typeof invocationDimensionMatch>
  fold: CompleteObservationFold
  records: string
  unresolved: boolean
  keep: boolean
}

/** Select original allocated contributions after every source has reached EOF; never revalue a page. */
export async function selectCompleteObservationTask(
  input: CompleteObservationTaskInput,
  original: CompleteObservationTaskBuild,
  selection: ObservationDimensionSelection | null,
): Promise<CompleteObservationTaskBuild | null> {
  if (selection === null) return original
  const space = (name: string) => input.namespace + '/selected/' + name
  const states = completeWorkingCache<Candidate>(input.rows, space('candidates'), input.signal)
  const attempts = completeWorkingCache<CompleteObservationFold>(
    input.rows,
    space('attempt-folds'),
    input.signal,
  )
  const fold = emptyCompleteObservationFold()
  for (const gap of original.sourceGaps) completeObservationGap(fold, gap)
  let invocationPopulation = 0n,
    allocationPopulation = 0n,
    numericRecords = 0n
  for await (const row of completeWorkingTraversal<Invocation>(
    input.rows,
    original.invocationsNamespace,
    input.signal,
  )) {
    const invocation = row.document,
      match = invocationDimensionMatch(selection, invocation),
      next = selection.model
        ? emptyCompleteObservationFold('1')
        : completeMetricsFold(invocation.metrics)
    if (match !== 'excluded') next.invocations = '1'
    if (match === 'unresolved') completeObservationGap(next, 'dimension-unresolved')
    if (invocation.metrics.state === 'not-ready')
      for (const gap of invocation.metrics.gaps) completeObservationGap(next, gap)
    await states.put(input.keyOf(invocation.invocationId), {
      invocation,
      match,
      fold: next,
      records: '0',
      unresolved: match === 'unresolved',
      keep: match !== 'excluded',
    })
    invocationPopulation++
  }
  for await (const row of completeWorkingTraversal<CompleteObservationAllocation>(
    input.rows,
    original.allocationsNamespace,
    input.signal,
  )) {
    allocationPopulation++
    const allocation = row.document,
      key = input.keyOf(allocation.invocation.invocationId),
      candidate = await states.get(key)
    if (!candidate) throw new Error('Original selected allocation invocation missing')
    if (!candidate.keep) continue
    const authority = allocation.invocation.authority,
      match = modelDimensionMatch(selection, {
        authority: authority.kind,
        sourceId: authority.kind === 'local' ? null : authority.sourceId,
        provider: allocation.model?.provider ?? null,
        model: allocation.model?.id ?? null,
      })
    if (match === 'unresolved') {
      candidate.unresolved = true
      completeObservationGap(candidate.fold, 'dimension-unresolved')
    }
    if (match !== 'excluded') {
      await input.rows.insert(space('allocations'), [row])
      candidate.records = String(BigInt(candidate.records) + 1n)
      numericRecords++
      if (selection.model)
        addCompleteObservationAllocation(candidate.fold, allocation.contribution, allocation.cost)
    }
    await states.put(key, candidate)
  }
  if (allocationPopulation !== BigInt(original.originalNumericRecords))
    throw new Error('Original selected usage population changed')
  if (invocationPopulation === 0n) completeObservationGap(fold, 'dimension-unresolved')
  await states.flush()
  for await (const row of completeWorkingTraversal<Candidate>(
    input.rows,
    space('candidates'),
    input.signal,
  )) {
    const candidate = row.document
    if (!candidate.keep) continue
    if (selection.model) {
      const incomplete = candidate.invocation.metrics.state !== 'ready'
      // Invocation-wide zero does not establish a model-specific zero.
      if (
        candidate.records === '0' &&
        (incomplete ||
          (candidate.invocation.metrics.state === 'ready' &&
            candidate.invocation.metrics.records === '0'))
      ) {
        candidate.unresolved = true
        completeObservationGap(candidate.fold, 'dimension-unresolved')
      }
      if (candidate.records === '0' && !candidate.unresolved && !incomplete) continue
      candidate.fold.observedInvocations = candidate.records === '0' ? '0' : '1'
    }
    mergeCompleteObservationFold(fold, candidate.fold)
    await input.rows.insert(space('invocations'), [
      {
        key: row.key,
        document: { ...candidate.invocation, metrics: completeObservationMetrics(candidate.fold) },
      },
    ])
    const attemptId = candidate.invocation.nodeRunId
    if (attemptId !== null) {
      const value = (await attempts.get(attemptId)) ?? emptyCompleteObservationFold()
      mergeCompleteObservationFold(value, candidate.fold)
      await attempts.put(attemptId, value)
    }
  }
  await attempts.flush()
  if (fold.invocations === '0' && fold.gaps.length === 0) return null
  let attemptCount = 0n
  for await (const row of completeWorkingTraversal<CompleteObservationAttempt>(
    input.rows,
    original.attemptsNamespace,
    input.signal,
  )) {
    const value = await input.rows.get<CompleteObservationFold>(
      space('attempt-folds'),
      row.document.id,
    )
    if (!value) continue
    await input.rows.insert(space('attempts'), [
      { key: row.key, document: { ...row.document, metrics: completeObservationMetrics(value) } },
    ])
    attemptCount++
  }
  for (const [source, target] of [
    [original.nativeCapturesNamespace, space('captures')],
    [original.platformCapturesNamespace, space('platform-captures')],
  ] as const)
    for await (const row of completeWorkingTraversal<{ readonly invocationId: string }>(
      input.rows,
      source,
      input.signal,
    ))
      if (await input.rows.get(space('invocations'), input.keyOf(row.document.invocationId)))
        await input.rows.insert(target, [row])
  const trace = original.trace
    ? {
        ...(await buildCompleteObservationSpanDetails(input, original.trace.projection, {
          namespace: space('trace'),
          invocationsNamespace: space('invocations'),
          allocationsNamespace: space('allocations'),
          attemptsNamespace: space('attempts'),
        })),
        projection: original.trace.projection,
        receipt: original.trace.receipt,
      }
    : undefined
  return {
    ...(trace ? { trace } : {}),
    sourceGaps: original.sourceGaps,
    fold,
    originalNumericRecords: String(numericRecords),
    sourceReceipts: original.sourceReceipts,
    attemptsNamespace: space('attempts'),
    invocationsNamespace: space('invocations'),
    allocationsNamespace: space('allocations'),
    nativeCapturesNamespace: space('captures'),
    platformCapturesNamespace: space('platform-captures'),
    summary: {
      task: input.task,
      metrics: completeObservationMetrics(fold),
      attemptCount: String(attemptCount),
      timing: await buildCompleteObservationTiming({
        ...input,
        attemptsNamespace: space('attempts'),
        namespace: space('timing'),
      }),
    },
  }
}
