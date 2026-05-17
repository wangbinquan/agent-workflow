// RFC-026 — parse and classify node_run_event rows recorded by the scheduler
// when clarify inline-mode resume runs or falls back.
//
// Scheduler writes these as `kind: 'text'` (no schema bump) with a structured
// payload prefixed by `[rfc026/inline-session-resumed]` (info) or
// `[rfc026/inline-fallback]` (warning). The body after the tag is a JSON
// blob with `{ rfc, code, ... }`.
//
// This helper:
//   - keeps the prefix in ONE place (so frontend and backend can co-evolve
//     the tag without ad-hoc string matching scattered across components).
//   - returns a discriminated union so call sites can statically branch on
//     level / reason.
//   - degrades to `null` for non-RFC-026 payloads — call sites then render
//     the event with the default styling.

export type Rfc026EventLevel = 'info' | 'warning'

export type Rfc026EventDecoded =
  | {
      level: 'info'
      code: 'clarify-session-resumed'
      sessionIdPrefix: string
      clarifyIteration?: number
      raw: string
    }
  | {
      level: 'warning'
      code: 'inline-clarify-fallback-to-isolated'
      reason: 'missing-session-id' | 'session-not-found' | 'unsupported-opencode-version'
      clarifyIteration?: number
      raw: string
    }

const TAG_INFO = '[rfc026/inline-session-resumed]'
const TAG_WARN = '[rfc026/inline-fallback]'

/** True when an event payload was written by RFC-026 scheduler bookkeeping. */
export function isRfc026EventPayload(payload: string): boolean {
  return payload.startsWith(TAG_INFO) || payload.startsWith(TAG_WARN)
}

/**
 * Parse the payload string. Returns null for non-RFC-026 events (caller
 * should fall through to default event rendering).
 *
 * Pure / side-effect free; safe to call from render paths.
 */
export function parseRfc026Event(payload: string): Rfc026EventDecoded | null {
  if (!isRfc026EventPayload(payload)) return null
  // Slice from the first `{` to the last `}` so a hypothetical future
  // payload with nested objects still round-trips through JSON.parse.
  const jsonStart = payload.indexOf('{')
  const tagEnd = payload.lastIndexOf('}')
  if (jsonStart < 0 || tagEnd < jsonStart) return null
  const body = payload.slice(jsonStart, tagEnd + 1)
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(body) as Record<string, unknown>
  } catch {
    return null
  }
  const code = typeof parsed.code === 'string' ? parsed.code : ''
  const clarifyIteration =
    typeof parsed.clarifyIteration === 'number' ? parsed.clarifyIteration : undefined

  if (payload.startsWith(TAG_INFO)) {
    if (code !== 'clarify-session-resumed') return null
    const sessionIdPrefix = typeof parsed.sessionIdPrefix === 'string' ? parsed.sessionIdPrefix : ''
    return {
      level: 'info',
      code: 'clarify-session-resumed',
      sessionIdPrefix,
      ...(clarifyIteration !== undefined ? { clarifyIteration } : {}),
      raw: payload,
    }
  }
  // warning path
  if (code !== 'inline-clarify-fallback-to-isolated') return null
  const reasonRaw = typeof parsed.reason === 'string' ? parsed.reason : ''
  if (
    reasonRaw !== 'missing-session-id' &&
    reasonRaw !== 'session-not-found' &&
    reasonRaw !== 'unsupported-opencode-version'
  ) {
    return null
  }
  return {
    level: 'warning',
    code: 'inline-clarify-fallback-to-isolated',
    reason: reasonRaw,
    ...(clarifyIteration !== undefined ? { clarifyIteration } : {}),
    raw: payload,
  }
}
