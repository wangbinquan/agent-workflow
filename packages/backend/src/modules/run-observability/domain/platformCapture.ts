import type { PlatformObservation } from './platformObservation'
import type { PlatformSyncState } from './platformSync'

/** The caller already matched the complete, frozen platform execution identity. */
export function platformCaptureEvidence(
  items: readonly PlatformObservation[],
  state?: PlatformSyncState,
) {
  const captures = items.filter((item) => item.kind === 'capture').map((item) => item.capture)
  const usage = items.filter((item) => item.kind === 'usage')
  const reasons: string[] = []
  const turns = new Map<string, number[]>()
  for (const capture of captures) {
    const key = JSON.stringify([capture.sourceId, capture.proof.lineageKey])
    const indices = turns.get(key) ?? []
    indices.push(capture.proof.turnIndex)
    turns.set(key, indices)
  }
  if (
    [...turns.values()].some((indices) =>
      indices.sort((a, b) => a - b).some((value, index) => value !== index),
    )
  )
    reasons.push('native-turn-gap')
  if (!state || state.status !== 'ready') reasons.push(state?.status ?? 'initial')
  if (state?.gaps.length) reasons.push('capture-gap')
  if (
    state?.schemaVersion !== 2 ||
    !captures.length ||
    usage.some(
      (row) =>
        !captures.some(
          (capture) =>
            capture.sourceId === row.sourceId &&
            capture.proof.turn === row.scope?.turn &&
            capture.proof.turnIndex === row.scope.turnIndex &&
            capture.proof.root === row.scope.root,
        ),
    )
  )
    reasons.push('native-capture-unobserved')
  for (const capture of captures) {
    const capturedUsage = usage.filter(
      (row) => row.sourceId === capture.sourceId && row.scope?.turn === capture.proof.turn,
    )
    if (
      capture.state === 'complete' &&
      (capture.receivedSteps !== capture.proof.emitted ||
        capture.receivedBaselineSteps !== capture.proof.baselineSteps ||
        capturedUsage.length > capture.receivedSteps)
    )
      reasons.push('native-capture-partial')
    if (capture.state !== 'complete') reasons.push('native-capture-' + capture.state)
    if (capture.historicalRevisionGap || capture.revisedBaselineSteps)
      reasons.push('native-prior-revision-gap')
    if (capture.unresolvedBaselineSteps) reasons.push('native-owner-unresolved')
    reasons.push(...capture.issues)
  }
  const knownZero =
    reasons.length === 0 &&
    usage.length === 0 &&
    captures.every(
      (capture) =>
        capture.receivedSteps === 0 &&
        capture.proof.emitted === 0 &&
        capture.proof.steps === capture.proof.baselineSteps,
    )
  return {
    captures,
    reasons: [...new Set(reasons)],
    knownZero,
    emptyCostVisible: knownZero && state?.costVisibility !== 'hidden' && state?.costsReady === true,
  }
}
