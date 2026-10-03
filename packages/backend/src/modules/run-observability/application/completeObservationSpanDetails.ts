import type {
  CompleteObservationAllocation,
  CompleteObservationInvocation,
  CompleteObservationTraceStatus,
  ObservationAttemptFacts,
  ObservationSpanCapture,
  ObservationSpanDetail,
} from '@agent-workflow/shared'
import type {
  CompleteProjectedSpan,
  CompleteSpanProjection,
} from '../ports/completeObservationSpans'
import type { CompleteObservationTaskInput } from '../ports/completeObservationTask'
import { completeOrdinalKey } from '../domain/completeOrdinal'
import { completeExternalSort } from './completeExternalSort'
import { completeWorkingCache } from './completeWorkingCache'
import { completeWorkingTraversal } from './completeWorkingTraversal'

interface TraceFold {
  invocations: string
  spans: string
  captures: string
  repairs: string
  reasons: string[]
  range: { from: number; to: number } | null
}
interface CaptureRow {
  readonly invocationId: string
  readonly nodeRunId: string
  readonly capture: ObservationSpanCapture
}

/** Full trace counts and token association come from original evidence, never a visible-page fold. */
export async function buildCompleteObservationSpanDetails(
  input: CompleteObservationTaskInput,
  projection: CompleteSpanProjection,
  scope?: {
    readonly namespace: string
    readonly invocationsNamespace: string
    readonly allocationsNamespace: string
    readonly attemptsNamespace: string
  },
) {
  const space = (name: string) => (scope?.namespace ?? input.namespace) + '/' + name,
    spansNamespace = space('ready-spans'),
    capturesNamespace = space('ready-span-captures'),
    statusesNamespace = space('span-statuses')
  const readyOwners = completeWorkingCache<CompleteObservationInvocation>(
      input.rows,
      scope?.invocationsNamespace ?? input.namespace + '/ready-invocations',
      input.signal,
    ),
    folds = completeWorkingCache<TraceFold>(input.rows, space('span-folds'), input.signal),
    captureCounts = completeWorkingCache<string>(
      input.rows,
      space('span-capture-counts'),
      input.signal,
    )
  async function fold(id: string) {
    return (
      (await folds.get(id)) ?? {
        invocations: '0',
        spans: '0',
        captures: '0',
        repairs: '0',
        reasons: [...projection.issues],
        range: null,
      }
    )
  }
  const reason = (value: TraceFold, code: string) => {
    if (!value.reasons.includes(code)) value.reasons.push(code)
  }
  for await (const row of completeWorkingTraversal<CaptureRow>(
    input.rows,
    projection.capturesNamespace,
    input.signal,
  )) {
    const capture = row.document,
      selected = await readyOwners.get(input.keyOf(capture.invocationId))
    if (!selected) continue
    await input.rows.insert(capturesNamespace, [row])
    const value = await fold(capture.nodeRunId),
      key = input.keyOf(capture.invocationId)
    value.captures = String(BigInt(value.captures) + 1n)
    await captureCounts.put(key, String(BigInt((await captureCounts.get(key)) ?? '0') + 1n))
    if (capture.capture.state !== 'complete') {
      reason(value, 'span-capture-partial')
      for (const code of capture.capture.issues) reason(value, code)
    }
    await folds.put(capture.nodeRunId, value)
  }
  for await (const row of completeWorkingTraversal<CompleteObservationInvocation>(
    input.rows,
    scope?.invocationsNamespace ?? input.namespace + '/ready-invocations',
    input.signal,
  )) {
    const accepted = row.document
    if (accepted.nodeRunId === null) continue
    const value = await fold(accepted.nodeRunId)
    value.invocations = String(BigInt(value.invocations) + 1n)
    if (
      accepted.authority.kind !== 'local' ||
      accepted.spanCaptureContract !== 'runtime-span-facts-v1'
    )
      reason(value, 'span-capture-unsupported')
    else if (((await captureCounts.get(input.keyOf(accepted.invocationId))) ?? '0') === '0')
      reason(value, 'span-capture-pending')
    await folds.put(accepted.nodeRunId, value)
  }
  for await (const row of completeWorkingTraversal<{
    readonly carrierInvocationId: string
    readonly targetInvocationId: string
    readonly targetSpanKey: string
  }>(input.rows, projection.repairsNamespace, input.signal)) {
    const repair = row.document,
      carrier = await readyOwners.get(input.keyOf(repair.carrierInvocationId)),
      target = await readyOwners.get(input.keyOf(repair.targetInvocationId))
    for (const attempt of new Set([carrier?.nodeRunId, target?.nodeRunId]))
      if (attempt != null)
        await input.rows.put(space('span-repair-members'), {
          key: input.keyOf(
            JSON.stringify([attempt, repair.targetInvocationId, repair.targetSpanKey]),
          ),
          document: { attempt },
        })
  }
  for await (const row of completeWorkingTraversal<{ readonly attempt: string }>(
    input.rows,
    space('span-repair-members'),
    input.signal,
  )) {
    const value = await fold(row.document.attempt)
    value.repairs = String(BigInt(value.repairs) + 1n)
    await folds.put(row.document.attempt, value)
  }
  const links = completeWorkingCache<CompleteObservationAllocation>(
    input.rows,
    space('span-numeric-links'),
    input.signal,
  )
  for await (const row of completeWorkingTraversal<CompleteObservationAllocation>(
    input.rows,
    scope?.allocationsNamespace ?? input.namespace + '/allocations',
    input.signal,
  ))
    await links.put(
      input.keyOf(JSON.stringify([row.document.invocation.invocationId, row.document.recordId])),
      row.document,
    )
  await links.flush()
  const ordered = await completeExternalSort({
    workspace: input.rows,
    namespace: space('span-display-order'),
    signal: input.signal,
    records: (async function* () {
      for await (const row of completeWorkingTraversal<CompleteProjectedSpan>(
        input.rows,
        projection.spansNamespace,
        input.signal,
      ))
        yield row.document
    })(),
    compare: (a, b) => a.sourceRowId - b.sourceRowId || a.itemIndex - b.itemIndex,
  })
  let ordinal = 0n
  for await (const span of ordered.records()) {
    const invocation = await readyOwners.get(input.keyOf(span.fact.invocationId))
    if (!invocation) continue
    const fact = span.fact,
      state = fact.state,
      reasons = new Set(span.issues)
    if (state.startedAt === null || state.endedAt === null) reasons.add('span-time-unknown')
    if (state.status === 'open' || state.status === 'unknown') reasons.add('span-result-incomplete')
    const value = await fold(span.nodeRunId)
    value.spans = String(BigInt(value.spans) + 1n)
    for (const code of reasons) reason(value, code)
    for (const time of [state.startedAt, state.endedAt])
      if (time !== null)
        value.range = value.range
          ? { from: Math.min(value.range.from, time), to: Math.max(value.range.to, time) }
          : { from: time, to: time }
    await folds.put(span.nodeRunId, value)
    const record =
      invocation?.metrics.state === 'ready' && fact.measurementRecordId
        ? await links.get(
            input.keyOf(JSON.stringify([fact.invocationId, fact.measurementRecordId])),
          )
        : undefined
    const detail: ObservationSpanDetail = {
      fact,
      durationMs:
        reasons.size || state.startedAt === null || state.endedAt === null
          ? null
          : state.endedAt - state.startedAt,
      quality: reasons.size ? 'partial' : 'complete',
      reasons: [...reasons],
      usage: record?.contribution ?? null,
      cost: record
        ? {
            currency: 'CNY',
            amountDecimal: record.cost.complete && !record.cost.hidden ? record.cost.amount : null,
            completeness: record.cost.complete && !record.cost.hidden ? 'complete' : 'unpriced',
          }
        : null,
    }
    await input.rows.insert(spansNamespace, [
      { key: completeOrdinalKey(ordinal++), document: { nodeRunId: span.nodeRunId, detail } },
    ])
  }
  for await (const row of completeWorkingTraversal<ObservationAttemptFacts>(
    input.rows,
    scope?.attemptsNamespace ?? input.namespace + '/attempts',
    input.signal,
  )) {
    const value = await fold(row.key)
    const identity = { taskId: input.task.id, nodeRunId: row.key }
    if (value.invocations === '0') reason(value, 'span-invocation-unobserved')
    const status: CompleteObservationTraceStatus =
      value.invocations === '0' && row.document.computeKind === 'non-agent'
        ? { ...identity, state: 'not-applicable' }
        : value.reasons.length
          ? { ...identity, state: 'not-ready', reasons: value.reasons, knownRange: value.range }
          : {
              ...identity,
              state: 'complete',
              spanCount: value.spans,
              captureCount: value.captures,
              priorRepairCount: value.repairs,
              range: value.range,
            }
    await input.rows.insert(statusesNamespace, [{ key: row.key, document: status }])
  }
  return { spansNamespace, statusesNamespace, capturesNamespace }
}
