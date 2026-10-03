import type { ObservationAttemptFacts } from '@agent-workflow/shared'
import type { UsageCaptureReceipt } from '../ports/usageLedger'
import {
  completeObservationGap,
  completeObservationMetrics,
  emptyCompleteObservationFold,
  mergeCompleteObservationFold,
  type CompleteObservationFold,
} from '../domain/completeObservationMetrics'
import type {
  CompleteObservationTaskInput,
  CompleteObservationTaskBuild,
  CompleteInvocationWorking,
} from '../ports/completeObservationTask'
import {
  completeObservationEvidenceContext,
  retainCompleteObservationAttempts,
  retainCompleteObservationInvocations,
  retainCompleteObservationCaptures,
  retainCompleteObservationUsage,
} from './completeObservationEvidence'
import {
  retainCompleteObservationPlatform,
  validateCompletePlatformTurns,
} from './completeObservationPlatform'
import { validateCompletePlatformRecords } from './completeObservationProofs'
import { allocateCompleteObservationUsage } from './completeObservationAllocation'
import { buildCompleteObservationTiming } from './completeObservationTiming'
import { completeWorkingCache } from './completeWorkingCache'
import { completeWorkingPages } from './completeWorkingTraversal'
import { projectCompleteObservationSpans } from './completeSpanProjection'
import { buildCompleteObservationSpanDetails } from './completeObservationSpanDetails'

/** Complete original Task population; no accepted invocation, attempt or numeric evidence is capped. */
export async function buildCompleteObservationTask(
  input: CompleteObservationTaskInput,
): Promise<CompleteObservationTaskBuild> {
  const context = completeObservationEvidenceContext(input),
    { space } = context
  const attempts = await retainCompleteObservationAttempts(context)
  const invocations = await retainCompleteObservationInvocations(context)
  const captures = await retainCompleteObservationCaptures(context)
  const local = await retainCompleteObservationUsage(context)
  await context.invocations.flush()
  const platform = await retainCompleteObservationPlatform(context)
  await validateCompletePlatformTurns(context)
  await validateCompletePlatformRecords(context)
  await allocateCompleteObservationUsage(
    context,
    String(BigInt(local.rows) + BigInt(platform.usageCount)),
  )
  await context.invocations.flush()
  const sourceGaps = [...context.fold.gaps]
  const attemptFolds = completeWorkingCache<CompleteObservationFold>(
    input.rows,
    space('attempt-folds'),
    input.signal,
  )
  for await (const page of completeWorkingPages<CompleteInvocationWorking>(
    input.rows,
    space('invocations'),
    input.signal,
  )) {
    const retained = []
    for (const row of page) {
      const entry = row.document
      if (entry.invocation.authority.kind === 'local') {
        const capture = await input.rows.get<UsageCaptureReceipt>(space('captures'), row.key)
        const proof = capture?.capture
        if (
          proof &&
          BigInt(proof.scannedSteps) - BigInt(proof.baselineSteps?.length ?? 0) !==
            BigInt(entry.rawRecords)
        )
          completeObservationGap(entry.fold, 'native-capture-records-missing')
      }
      if (!entry.nativeComplete || entry.nativeCaptureCount === '0')
        completeObservationGap(entry.fold, 'native-capture-unobserved')
      if (entry.rawRecords === '0' && !entry.knownZero)
        completeObservationGap(entry.fold, 'usage-unobserved')
      if (entry.rawRecords !== '0' || entry.knownZero) entry.fold.observedInvocations = '1'
      if (
        entry.rawRecords === '0' &&
        entry.invocation.authority.kind === 'crewstation' &&
        !entry.emptyCostVisible
      )
        entry.fold.priced = false
      mergeCompleteObservationFold(context.fold, entry.fold)
      const attempt = entry.invocation.nodeRunId
      if (attempt !== null) {
        const fold = (await attemptFolds.get(attempt)) ?? emptyCompleteObservationFold()
        mergeCompleteObservationFold(fold, entry.fold)
        await attemptFolds.put(attempt, fold)
      }
      retained.push({
        key: row.key,
        document: { ...entry.invocation, metrics: completeObservationMetrics(entry.fold) },
      })
    }
    await input.rows.insert(space('ready-invocations'), retained)
  }
  await attemptFolds.flush()
  for await (const page of completeWorkingPages<ObservationAttemptFacts>(
    input.rows,
    space('attempts'),
    input.signal,
  )) {
    const enriched = []
    for (const row of page) {
      const fold = (await attemptFolds.get(row.key)) ?? emptyCompleteObservationFold()
      if (
        fold.invocations === '0' &&
        (row.document.computeKind === undefined ||
          row.document.computeKind === 'unknown' ||
          (row.document.computeKind === 'agent' && row.document.startedAt !== null))
      ) {
        completeObservationGap(fold, 'invocation-unobserved')
        completeObservationGap(context.fold, 'invocation-unobserved')
        if (!sourceGaps.includes('invocation-unobserved')) sourceGaps.push('invocation-unobserved')
      }
      enriched.push({
        key: row.key,
        document: { ...row.document, metrics: completeObservationMetrics(fold) },
      })
    }
    await input.rows.upsert(space('attempts'), enriched)
  }
  const backlog = await input.sources.backlog(input.task.id)
  if (backlog.pendingRecords !== 0) {
    completeObservationGap(context.fold, 'source-projection-pending')
    sourceGaps.push('source-projection-pending')
  }
  const timing = await buildCompleteObservationTiming({
    task: input.task,
    asOf: input.asOf,
    rows: input.rows,
    attemptsNamespace: space('attempts'),
    namespace: space('timing'),
    signal: input.signal,
  })
  const projection = input.trace ? await projectCompleteObservationSpans(input) : null
  const trace = projection
    ? {
        ...(await buildCompleteObservationSpanDetails(input, projection)),
        receipt: projection.receipt,
        projection,
      }
    : undefined
  return {
    ...(trace ? { trace } : {}),
    sourceGaps,
    summary: {
      task: input.task,
      metrics: completeObservationMetrics(context.fold),
      attemptCount: attempts.rows,
      timing,
    },
    fold: context.fold,
    originalNumericRecords: String(BigInt(local.rows) + BigInt(platform.usageCount)),
    sourceReceipts: [attempts, invocations, captures, local, ...platform.receipts],
    attemptsNamespace: space('attempts'),
    invocationsNamespace: space('ready-invocations'),
    allocationsNamespace: space('allocations'),
    nativeCapturesNamespace: space('captures'),
    platformCapturesNamespace: space('platform-captures'),
  }
}
