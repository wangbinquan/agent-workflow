// RFC-111 PR-B — Claude Code stream-json stdout parsing → NormalizedEvent.
//
// Event shapes verified hands-on against claude 2.1.193 (design §6.1, §0.3):
//   {type:'system', subtype:'init', session_id, model, apiKeySource, ...}
//   {type:'assistant', message:{content:[{type:'text'|'thinking'|'tool_use',...}],
//                               usage:{input_tokens,output_tokens,
//                                      cache_read_input_tokens,cache_creation_input_tokens}},
//          session_id}
//   {type:'user',   message:{content:[{type:'tool_result',...}]}, session_id}
//   {type:'result', subtype:'success', is_error, result, session_id,
//                   total_cost_usd, usage:{...}, num_turns}
//
// Unlike opencode (one event per part), claude emits one event per message TURN
// whose `message.content[]` mixes text / thinking / tool_use. We concat the text
// parts for the `<workflow-output>` envelope buffer, derive a single display
// kind, and take the token total from the (single, cumulative) `result` event so
// it is never double-counted across the per-turn `assistant` events.
//
// Leaf module: imports ONLY runtime types → no module-init cycle.

import type { NormalizedEvent, NormalizedEventKind, NormalizedTokenDelta } from '../types'

export function parseEvent(line: string): NormalizedEvent | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const evt = parsed as Record<string, unknown>
  // session_id appears on every event (init / assistant / user / result).
  const sessionId = typeof evt.session_id === 'string' ? evt.session_id : undefined
  const type = typeof evt.type === 'string' ? evt.type : ''

  const contentParts = extractContentParts(evt)
  const text = concatText(contentParts)

  return {
    kind: inferKind(type, contentParts),
    text,
    sessionId,
    // claude stream-json has no top-level event timestamp; pump falls back to now.
    timestamp: undefined,
    tokens: extractTokenDelta(type, evt) ?? undefined,
    rawLine: line,
  }
}

/** Pull `message.content[]` (array of `{type, text?, thinking?, ...}`). */
function extractContentParts(evt: Record<string, unknown>): Array<Record<string, unknown>> {
  const msg = evt.message
  if (!msg || typeof msg !== 'object') return []
  const content = (msg as Record<string, unknown>).content
  if (!Array.isArray(content)) return []
  return content.filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
}

/** Concatenate the visible text parts of one assistant turn (envelope source). */
function concatText(parts: Array<Record<string, unknown>>): string | null {
  const texts: string[] = []
  for (const p of parts) {
    if (p.type === 'text' && typeof p.text === 'string') texts.push(p.text)
  }
  return texts.length > 0 ? texts.join('') : null
}

/**
 * Derive one display kind for the turn. A turn that calls a tool reads as
 * `tool_use`; a pure-thinking turn as `reasoning`; otherwise `text`. The raw
 * line is persisted verbatim, so SessionTab can render finer detail later.
 */
function inferKind(type: string, parts: Array<Record<string, unknown>>): NormalizedEventKind {
  if (type === 'result') return 'step_finish'
  if (type === 'system') return 'step_start'
  if (type === 'user') return 'tool_use' // tool_result turn
  // assistant turn — pick by the parts it carries (tool_use > reasoning > text).
  if (parts.some((p) => p.type === 'tool_use')) return 'tool_use'
  if (parts.some((p) => p.type === 'thinking')) return 'reasoning'
  if (parts.some((p) => p.type === 'text')) return 'text'
  return 'text'
}

/**
 * Token delta. Taken from the single cumulative `result.usage` so the per-turn
 * `assistant.usage` events don't double-count. Maps claude's snake_case keys to
 * our normalized delta; cache_read/creation_input_tokens → cacheRead/cacheCreate.
 */
function extractTokenDelta(
  type: string,
  evt: Record<string, unknown>,
): NormalizedTokenDelta | null {
  if (type !== 'result') return null
  const usage = evt.usage
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>
  return {
    input: numOrZero(u.input_tokens),
    output: numOrZero(u.output_tokens),
    cacheRead: numOrZero(u.cache_read_input_tokens),
    cacheCreate: numOrZero(u.cache_creation_input_tokens),
  }
}

function numOrZero(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * Did the run report an application error in its terminal `result` event?
 * `is_error=true` covers auth failure ("Not logged in") / API errors. The
 * runner maps non-zero exit to failed; this lets a clean-exit-but-is_error run
 * also be caught.
 */
export function parseResultError(line: string): { isError: boolean; message: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const evt = parsed as Record<string, unknown>
  if (evt.type !== 'result') return null
  const isError = evt.is_error === true
  const message = typeof evt.result === 'string' ? evt.result : ''
  return { isError, message }
}
