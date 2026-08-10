// RFC-111 PR-A — opencode stdout event parsing, extracted from runner.ts
// WITHOUT behavior change. `extractTextFromEvent` / `inferEventKind` /
// `accumulateTokens` are moved here verbatim (runner.ts re-exports them so the
// existing import sites — tests, memoryDistiller — keep working). `parseEvent`
// is the new normalized entry the generic pump will consume; it reuses the
// exact same extraction so the pump's behavior is preserved.
//
// Leaf module: imports ONLY runtime types (no runner.ts / scheduler.ts), so it
// can't form a module-init cycle (see reference_binary_build_module_cycle).

import type {
  NormalizedEvent,
  NormalizedEventKind,
  NormalizedTokenDelta,
  RuntimeTokenUsage,
  SystemEventObservation,
} from '../types'

const SAFE_RUNTIME_EVENT_TYPE = /^[A-Za-z0-9._-]{1,64}$/

export function observeSystemEvent(line: string): SystemEventObservation {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { runtimeEventType: null, terminalResult: null }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { runtimeEventType: null, terminalResult: null }
  }
  const rawType = (parsed as Record<string, unknown>).type
  const runtimeEventType =
    typeof rawType === 'string' && SAFE_RUNTIME_EVENT_TYPE.test(rawType) ? rawType : null
  return {
    runtimeEventType,
    terminalResult: runtimeEventType === 'step_finish' ? 'success' : null,
  }
}

/**
 * Parse one opencode `--format json` stdout line into a normalized event.
 *
 * Mirrors the runner pump's original branch selection exactly: a line that
 * fails `JSON.parse` OR parses to a falsy value (`null`/`0`/`""`/`false`)
 * returns `null` (pump routes it through the raw-text fallback); any truthy
 * parse result is treated as a structured event, with the same
 * session-id / token / text / kind extraction the pump used inline.
 */
export function parseEvent(line: string): NormalizedEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  // Original pump used `if (evt) {...} else {...}` — falsy parse → raw-text path.
  if (!parsed) return null
  const evt = parsed as Record<string, unknown>
  const delta = computeTokenDelta(evt)
  return {
    kind: inferEventKind(evt),
    text: extractTextFromEvent(evt),
    sessionId: typeof evt.sessionID === 'string' ? evt.sessionID : undefined,
    timestamp: typeof evt.timestamp === 'number' ? evt.timestamp : undefined,
    tokens: delta ?? undefined,
    rawLine: line,
  }
}

/**
 * Pull out the agent's text contribution from one opencode event, if any.
 * Different opencode versions / part kinds put it in different shapes; we
 * tolerate the common ones.
 */
export function extractTextFromEvent(evt: Record<string, unknown>): string | null {
  const part = evt.part as Record<string, unknown> | undefined
  // shape: { type: 'text', part: { type: 'text', text: '...' } }
  if (part && typeof part === 'object') {
    const ptype = part.type
    const ptext = part.text
    if (ptype === 'text' && typeof ptext === 'string') return ptext
  }
  // shape: { type: 'text', text: '...' }  (older / synthetic)
  if (evt.type === 'text' && typeof evt.text === 'string') return evt.text
  return null
}

/** Map an opencode JSON event to one of our enum kinds. */
export function inferEventKind(evt: Record<string, unknown>): NormalizedEventKind {
  const t = evt.type
  if (typeof t === 'string') {
    if (t === 'tool_use') return 'tool_use'
    if (t === 'text') return 'text'
    if (t === 'reasoning') return 'reasoning'
    if (t === 'permission.asked' || t === 'permission_asked') return 'permission_asked'
    if (t === 'error') return 'error'
    if (t === 'step_start') return 'step_start'
    if (t === 'step_finish') return 'step_finish'
  }
  return 'text'
}

/**
 * P-4-05: token accumulation across opencode `--format json` events.
 *
 * opencode emits step-finish events with token usage at several possible
 * paths. We probe in priority order:
 *   evt.tokens              top-level (test fixtures, some old shapes)
 *   evt.part.tokens         inside a text/step event part
 *   evt.usage               inside a step-finish summary
 *   evt.step.tokens         inside a step event
 *   evt.message.usage       message-style assistant turn
 * and within each, accept both snake_case (`input/output/cache_creation/
 * cache_read`) and camelCase. The first event with token fields wins per
 * field — we don't double-count if multiple shapes appear in one event.
 *
 * Mutates `acc` in place (kept for the existing import sites that accumulate
 * directly). `parseEvent` uses the shared `computeTokenDelta` under the hood.
 */
export function accumulateTokens(evt: Record<string, unknown>, acc: RuntimeTokenUsage): void {
  const delta = computeTokenDelta(evt)
  if (!delta) return
  acc.input += delta.input
  acc.output += delta.output
  acc.cacheCreate += delta.cacheCreate
  acc.cacheRead += delta.cacheRead
  acc.total = acc.input + acc.output + acc.cacheCreate + acc.cacheRead
}

/**
 * Extract the per-event token delta from one opencode event, or `null` when the
 * event carries no token fields. Single source shared by `accumulateTokens`
 * (mutating) and `parseEvent` (normalized) so both stay byte-identical.
 */
export function computeTokenDelta(evt: Record<string, unknown>): NormalizedTokenDelta | null {
  const tokens = pickTokens([
    evt,
    evt.part as Record<string, unknown> | undefined,
    evt.usage as Record<string, unknown> | undefined,
    evt.step as Record<string, unknown> | undefined,
    evt.message as Record<string, unknown> | undefined,
  ])
  if (!tokens) return null
  const input = numOrZero(tokens.input ?? tokens.input_tokens ?? tokens.prompt_tokens)
  const output = numOrZero(tokens.output ?? tokens.output_tokens ?? tokens.completion_tokens)
  // RFC-103 T3 (06-OCI-06): real opencode (1.15.5+) nests cache counts under a
  // `cache: { read, write }` object; the older flat `cache_read/cache_creation`
  // keys are kept as fallbacks for backward compat. Reading only the flat keys
  // silently dropped cache tokens (~15× undercount on the recorded fixture →
  // max_total_tokens limits applied against a wrong small total).
  const cacheObj = tokens.cache as Record<string, unknown> | undefined
  const cacheCreate = numOrZero(tokens.cache_creation ?? tokens.cacheCreation ?? cacheObj?.write)
  const cacheRead = numOrZero(tokens.cache_read ?? tokens.cacheRead ?? cacheObj?.read)
  return { input, output, cacheCreate, cacheRead }
}

function pickTokens(
  candidates: Array<Record<string, unknown> | undefined>,
): Record<string, unknown> | null {
  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue
    // Direct token-bearing object.
    const t = c.tokens
    if (t && typeof t === 'object') return t as Record<string, unknown>
    // Some shapes inline input/output at the object level.
    if (
      typeof c.input_tokens === 'number' ||
      typeof c.output_tokens === 'number' ||
      typeof c.prompt_tokens === 'number' ||
      typeof c.completion_tokens === 'number'
    ) {
      return c
    }
    // Some shapes inline usage directly.
    const usage = c.usage
    if (usage && typeof usage === 'object') {
      const u = usage as Record<string, unknown>
      if (
        typeof u.input === 'number' ||
        typeof u.output === 'number' ||
        typeof u.input_tokens === 'number' ||
        typeof u.output_tokens === 'number'
      ) {
        return u
      }
    }
  }
  return null
}

function numOrZero(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}
