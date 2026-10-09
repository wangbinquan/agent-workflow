import { isDeepStrictEqual } from 'node:util'
import type { CompleteObservationOccurrence } from '@agent-workflow/shared'
import type {
  CompleteObservationContribution,
  CompleteObservationTaskInput,
} from '../ports/completeObservationTask'

const clock = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0
const missing = (
  reason: NonNullable<CompleteObservationOccurrence['reason']>,
): CompleteObservationOccurrence => ({ occurredAt: null, basis: null, reason })

/** A receipt clock or the final timestamp of a cumulative summary is never a consumption instant. */
export async function completeObservationOccurrence(
  input: Pick<CompleteObservationTaskInput, 'occurrenceVersions'>,
  record: CompleteObservationContribution,
  nativeSource: string | null,
): Promise<CompleteObservationOccurrence> {
  const m = record.measurement,
    platform = record.platformUsage
  const reporting = platform?.reporting ?? m.reporting,
    inclusion = platform?.inclusion ?? m.inclusion,
    scope = platform ? platform.scope : m.scope
  const native = !platform && m.recordId.startsWith('opencode:step:')
  if (
    reporting !== 'delta' ||
    inclusion !== 'self' ||
    (scope?.level !== 'request' && !(native && scope === undefined)) ||
    (!platform && m.basis?.kind === 'native-session')
  )
    return missing('time-nondiscrete')
  const at = platform
    ? platform.occurredAt === null
      ? null
      : Date.parse(platform.occurredAt)
    : m.occurredAt
  if (clock(at)) return { occurredAt: at, basis: native ? 'native-step' : 'request' }
  if (platform || !native) return missing('time-unobserved')
  if (input.occurrenceVersions === undefined || nativeSource === null || m.usage === undefined)
    return missing('time-evidence-missing')
  let matched = false,
    occurredAt: number | null | undefined
  for await (const original of input.occurrenceVersions(
    nativeSource,
    m.recordId.slice('opencode:step:'.length),
  )) {
    if (
      original.source !== nativeSource ||
      original.stepId !== m.recordId.slice('opencode:step:'.length) ||
      !isDeepStrictEqual(original.usage, m.usage)
    )
      continue
    const a = m.model,
      b = original.model
    if (
      a !== null &&
      b !== null &&
      (a.id !== b.id || (a.provider !== null && b.provider !== null && a.provider !== b.provider))
    )
      continue
    if (!matched) occurredAt = original.occurredAt
    else if (occurredAt !== original.occurredAt) return missing('time-conflicting')
    matched = true
  }
  return !matched
    ? missing('time-evidence-missing')
    : clock(occurredAt)
      ? { occurredAt, basis: 'native-step' }
      : missing('time-unobserved')
}
