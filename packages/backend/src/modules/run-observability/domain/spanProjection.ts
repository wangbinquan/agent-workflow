import type {
  AcceptedObservationInvocation,
  ObservationSpanCapture,
  ObservationSpanFact,
  ObservationSpanSourceRecord,
  ObservationSpanState,
} from '@agent-workflow/shared'

export const sameSpanEvidence = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right)
const same = sameSpanEvidence
const terminal = (value: ObservationSpanState['status']) =>
  ['success', 'error', 'cancelled'].includes(value)
export const unknownSpanState = (): ObservationSpanState => ({
  startedAt: null,
  endedAt: null,
  nativeObservedAt: null,
  status: 'unknown',
})
const unknownState = unknownSpanState
export const immutableSpanEvidence = ({
  state: _state,
  capturedAt: _at,
  issues: _issues,
  ...value
}: ObservationSpanFact) => value
const immutable = immutableSpanEvidence
export function mergeSpanState(
  left: ObservationSpanState,
  right: ObservationSpanState,
): ObservationSpanState | null {
  if (
    (left.startedAt !== null && right.startedAt !== null && left.startedAt !== right.startedAt) ||
    (left.endedAt !== null && right.endedAt !== null && left.endedAt !== right.endedAt) ||
    (terminal(left.status) && terminal(right.status) && left.status !== right.status)
  )
    return null
  const startedAt = left.startedAt ?? right.startedAt,
    endedAt = left.endedAt ?? right.endedAt
  if (startedAt !== null && endedAt !== null && endedAt < startedAt) return null
  const observations = [left.nativeObservedAt, right.nativeObservedAt].filter(
    (value): value is number => value !== null,
  )
  return {
    startedAt,
    endedAt,
    nativeObservedAt: observations.length ? Math.max(...observations) : null,
    status: terminal(left.status)
      ? left.status
      : terminal(right.status)
        ? right.status
        : left.status === 'open' || right.status === 'open'
          ? 'open'
          : 'unknown',
  }
}
const merge = mergeSpanState
export interface ProjectedSpan {
  readonly creation: ObservationSpanFact
  fact: ObservationSpanFact
  readonly sourceRowId: number
  readonly itemIndex: number
  readonly nodeRunId: string
  readonly issues: Set<string>
}

/** Commutative refinement of original native facts. Delivery order is never a call boundary. */
export function projectObservationSpans(input: {
  readonly taskId: string
  readonly accepted: readonly AcceptedObservationInvocation[]
  readonly records: readonly ObservationSpanSourceRecord[]
}) {
  const accepted = new Map(input.accepted.map((value) => [value.invocationId, value]))
  const spans = new Map<string, ProjectedSpan>(),
    issues = new Set<string>()
  const captures: { invocationId: string; capture: ObservationSpanCapture }[] = []
  const repairs = new Map<string, Set<string>>()
  const belongs = (invocationId: string, nodeRunId: string, source: string) => {
    const owner = accepted.get(invocationId)
    return (
      owner?.taskId === input.taskId &&
      owner.nodeRunId === nodeRunId &&
      owner.authority.kind === 'local' &&
      owner.spanCaptureContract === 'runtime-span-facts-v1' &&
      owner.spanCaptureSource === source
    )
  }
  const poison = (span: ProjectedSpan, code: string) => {
    span.issues.add(code)
    span.fact = { ...span.fact, state: unknownState() }
  }
  // First creation position is an immutable source pointer, not a revision clock.
  const facts = input.records
    .filter((record) => record.type === 'fact')
    .sort((a, b) => a.sourceRowId - b.sourceRowId || a.itemIndex - b.itemIndex)
  for (const record of facts) {
    if (record.type !== 'fact') continue
    const fact = record.fact
    if (!belongs(fact.invocationId, record.nodeRunId, fact.scope.sourceNamespace)) {
      issues.add('span-owner-scope-conflict')
      continue
    }
    const key = JSON.stringify([fact.invocationId, fact.spanKey]),
      original = spans.get(key)
    if (!original) {
      spans.set(key, {
        creation: fact,
        fact,
        sourceRowId: record.sourceRowId,
        itemIndex: record.itemIndex,
        nodeRunId: record.nodeRunId,
        issues: new Set(fact.issues ?? []),
      })
      continue
    }
    if (!same(immutable(original.creation), immutable(fact))) {
      poison(original, 'span-immutable-conflict')
      continue
    }
    for (const issue of fact.issues ?? []) original.issues.add(issue)
    if (original.issues.size) {
      poison(original, 'span-native-evidence-partial')
      continue
    }
    const state = merge(original.fact.state, fact.state)
    if (state) original.fact = { ...original.fact, state }
    else poison(original, 'span-boundary-conflict')
  }
  for (const record of input.records) {
    if (record.type === 'capture') {
      if (belongs(record.invocationId, record.nodeRunId, record.capture.sourceNamespace))
        captures.push({ invocationId: record.invocationId, capture: record.capture })
      else issues.add('span-capture-scope-conflict')
      continue
    }
    if (record.type === 'diagnostic') {
      issues.add(record.code)
      continue
    }
    if (record.type !== 'revision') continue
    const revision = record.revision,
      proof = revision.originalOwnerProof
    const target = spans.get(
      JSON.stringify([revision.targetOwnerInvocationId, revision.targetSpanKey]),
    )
    const owner = accepted.get(revision.targetOwnerInvocationId)
    if (
      !target ||
      !owner ||
      !belongs(revision.carrierInvocationId, record.nodeRunId, proof.scope.sourceNamespace) ||
      revision.carrierInvocationId === revision.targetOwnerInvocationId ||
      !same(owner, proof.accepted) ||
      proof.sourceRowId !== target.sourceRowId ||
      proof.itemIndex !== target.itemIndex ||
      proof.sourceNodeRunId !== target.nodeRunId ||
      !same(proof.creation, target.creation) ||
      !same(proof.scope, target.creation.scope)
    ) {
      issues.add('span-prior-proof-invalid')
      if (target) poison(target, 'span-prior-proof-invalid')
      continue
    }
    if (target.issues.size) continue
    // The saved baseline may refine unknown fields, but cannot contradict the original owner.
    const before = merge(target.creation.state, revision.before)
    const state = before && merge(target.fact.state, revision.after)
    if (!state) {
      poison(target, 'span-prior-boundary-conflict')
      continue
    }
    target.fact = { ...target.fact, state }
    const set = repairs.get(revision.carrierInvocationId) ?? new Set<string>()
    set.add(JSON.stringify([revision.targetOwnerInvocationId, revision.targetSpanKey]))
    repairs.set(revision.carrierInvocationId, set)
  }
  for (const span of spans.values()) if (span.issues.size) poison(span, 'span-evidence-conflict')
  return { spans: [...spans.values()], captures, issues: [...issues], repairs }
}
