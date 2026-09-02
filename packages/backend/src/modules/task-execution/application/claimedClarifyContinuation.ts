import type { ClaimedClarifyContinuation } from './ports/gateContinuationPreDrivePersistence'
import { TaskExecutionError } from './taskExecutionError'

/** Decode the collaboration-owned clarify fragment without importing its DB
 * model. Non-clarify gate payloads return null; malformed clarify payloads fail
 * closed at the same continuation boundary. */
export function decodeClaimedClarifyContinuation(raw: string): ClaimedClarifyContinuation | null {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    throw new TaskExecutionError(
      'task-continuation-conflict',
      'clarify gate continuation payload is not valid JSON',
    )
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new TaskExecutionError(
      'task-continuation-conflict',
      'clarify gate continuation payload is not an object',
    )
  }
  const value = decoded as Record<string, unknown>
  const gate = value.gate
  if (gate === null || typeof gate !== 'object' || Array.isArray(gate)) return null
  const gateValue = gate as Record<string, unknown>
  if (gateValue.kind !== 'clarify') return null
  const lineage = value.continuationLineage
  const lineageValue =
    lineage !== null && typeof lineage === 'object' && !Array.isArray(lineage)
      ? (lineage as Record<string, unknown>)
      : null
  const sourceNodeRunIds = lineageValue?.sourceNodeRunIds
  const rerunNodeRunIds = lineageValue?.rerunNodeRunIds
  if (
    value.v !== 1 ||
    typeof value.operationId !== 'string' ||
    value.operationId.length === 0 ||
    typeof gateValue.ref !== 'string' ||
    gateValue.ref.length === 0 ||
    !Array.isArray(sourceNodeRunIds) ||
    !Array.isArray(rerunNodeRunIds)
  ) {
    throw new TaskExecutionError(
      'task-continuation-conflict',
      'clarify gate continuation payload does not match its durable decision',
    )
  }
  // Question dispatch releases the SAME clarify park, and collaboration writes
  // it with `{ sourceNodeRunIds: [], rerunNodeRunIds }` — it has no single
  // origin run, and the questions it just dispatched are by definition not
  // undispatched work. There is therefore no clarify convergence to run: the
  // continuation is ready. Demanding the answer shape here made every
  // question-dispatch continuation unrecoverable after a restart (the review
  // gate never reappeared), because the decode threw before the drive began.
  if (sourceNodeRunIds.length === 0) return null
  if (
    sourceNodeRunIds.length !== 1 ||
    typeof sourceNodeRunIds[0] !== 'string' ||
    sourceNodeRunIds[0].length === 0 ||
    rerunNodeRunIds.length !== 0
  ) {
    throw new TaskExecutionError(
      'task-continuation-conflict',
      'clarify gate continuation payload does not match its durable decision',
    )
  }
  return {
    operationId: value.operationId,
    gateRef: gateValue.ref,
    originNodeRunId: sourceNodeRunIds[0],
  }
}
