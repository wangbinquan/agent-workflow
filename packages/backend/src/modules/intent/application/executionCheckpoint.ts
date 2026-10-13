import type { IntentExecutionCheckpoint } from './ports/intentExecution'

/** Bad selected primary facts remain an explicit error, never a legacy turn. */
export function intentExecutionCheckpointOf(
  runMetaJson: string | null,
): IntentExecutionCheckpoint | null {
  if (runMetaJson === null) return null
  const meta = JSON.parse(runMetaJson) as { execution?: IntentExecutionCheckpoint }
  if (meta.execution === undefined) return null
  const value = meta.execution
  if (
    value.version !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 0 ||
    typeof value.sessionId !== 'string' ||
    typeof value.reservation?.turnId !== 'string' ||
    typeof value.reservation?.envelopeNonce !== 'string' ||
    value.reservation.launchSession?.id !== value.sessionId ||
    !['reserved', 'prepared', 'started', 'terminal', 'reaped', 'closed'].includes(value.phase) ||
    value.configSnapshot === null ||
    typeof value.configSnapshot !== 'object' ||
    (value.phase !== 'reserved' && value.phase !== 'closed' && (!value.snapshot || !value.receipt))
  ) {
    throw new Error('intent-original-execution-checkpoint-invalid')
  }
  return value
}
