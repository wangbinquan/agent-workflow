// RFC-031 — parse and classify node_run_event rows the runner writes when an
// opencode child process logs a plugin load failure.
//
// opencode's plugin loader catches throw-on-load failures and emits an
// `error.*` log line but does NOT kill the parent process (see
// opencode/packages/opencode/src/plugin/index.ts:170-209). Because the
// downstream task can still succeed, the failure is invisible to operators
// unless we surface it explicitly. The runner does that by appending a
// synthetic `text` event tagged `[rfc031/plugin-load-failed]` whose body is a
// small JSON payload `{ rfc, code, pluginName, message }`.
//
// This helper keeps the prefix in ONE place and returns a discriminated
// shape so the node-detail drawer can render a warning chip without
// re-string-matching across components.

export type Rfc031EventDecoded = {
  level: 'warning'
  code: 'plugin-load-failed'
  pluginName: string
  message: string
  raw: string
}

const TAG_PLUGIN_LOAD_FAILED = '[rfc031/plugin-load-failed]'

/** True when an event payload was written by RFC-031 runner bookkeeping. */
export function isRfc031EventPayload(payload: string): boolean {
  return payload.startsWith(TAG_PLUGIN_LOAD_FAILED)
}

/**
 * Parse the payload string. Returns null for non-RFC-031 events so callers
 * can fall through to default event rendering. Pure / side-effect free.
 */
export function parseRfc031Event(payload: string): Rfc031EventDecoded | null {
  if (!isRfc031EventPayload(payload)) return null
  // Slice from the first `{` to the last `}` so the loader can later add
  // nested objects without breaking this parser.
  const jsonStart = payload.indexOf('{')
  const jsonEnd = payload.lastIndexOf('}')
  if (jsonStart < 0 || jsonEnd < jsonStart) return null
  const body = payload.slice(jsonStart, jsonEnd + 1)
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(body) as Record<string, unknown>
  } catch {
    return null
  }
  if (parsed.code !== 'plugin-load-failed') return null
  const pluginName = typeof parsed.pluginName === 'string' ? parsed.pluginName : ''
  const message = typeof parsed.message === 'string' ? parsed.message : ''
  return {
    level: 'warning',
    code: 'plugin-load-failed',
    pluginName,
    message,
    raw: payload,
  }
}
