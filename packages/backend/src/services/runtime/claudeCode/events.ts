// RFC-111 PR-B — Claude Code stream-json stdout parsing → NormalizedEvent.
//
// Event shapes verified hands-on against claude 2.1.193 (design §6.1, §0.3),
// re-verified against 2.1.202 (2026-07-07 probe):
//   {type:'system', subtype:'init'|'status'|'thinking_tokens'|'task_started'|
//                   'task_notification'|'hook_*', session_id, ...}
//   {type:'assistant', message:{id, content:[{type:'text'|'thinking'|'tool_use',...}],
//                               usage:{input_tokens,output_tokens,
//                                      cache_read_input_tokens,cache_creation_input_tokens}},
//          parent_tool_use_id, session_id}
//   {type:'user',   message:{content:[{type:'tool_result',...}]|string},
//                   tool_use_result?, timestamp?, session_id}
//   {type:'result', subtype:'success', is_error, result, session_id,
//                   total_cost_usd, usage:{...}, num_turns}
//
// On 2.1.193 claude emitted one event per message TURN with a mixed
// `message.content[]`; on 2.1.202 assistant events arrive one per content
// block (same message.id repeated). Both shapes flow through here: we concat
// whatever text parts an event carries into the `<workflow-output>` envelope
// buffer, derive a single display kind, and take the token total from the
// (cumulative) `result` event so it is never double-counted across the
// per-turn `assistant` events. Subagent transcript JSONL lines (read by
// sessionCapture.ts) reuse this parser too — they carry an ISO `timestamp`
// we surface so captured rows keep the real event time instead of the
// capture-walk time. The conversation-tree rendering itself re-parses the
// verbatim payload in @agent-workflow/shared parseSessionTree (which handles
// the claude dialect since the RFC-111 SessionTab-parity fix); the kind we
// emit here is only a coarse per-row display/filter hint.
//
// Leaf module: imports ONLY runtime types → no module-init cycle.

import type {
  NormalizedEvent,
  NormalizedEventKind,
  NormalizedTokenDelta,
  StartupInventory,
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
  const event = parsed as Record<string, unknown>
  const rawType = event.type
  const runtimeEventType =
    typeof rawType === 'string' && SAFE_RUNTIME_EVENT_TYPE.test(rawType) ? rawType : null
  return {
    runtimeEventType,
    terminalResult:
      runtimeEventType === 'result' ? (event.is_error === true ? 'error' : 'success') : null,
  }
}

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
    // Transcript JSONL lines (and stream user rows) carry an ISO `timestamp`;
    // assistant stream events don't — the pump falls back to now for those.
    timestamp: extractTimestamp(evt),
    tokens: extractTokenDelta(type, evt) ?? undefined,
    rawLine: line,
  }
}

/**
 * RFC-242 T5 — the `system/init` event's `mcp_servers` inventory, reduced to
 * the servers that will NOT be usable this turn.
 *
 * Measured against claude 2.1.220 (design §4.4): claude freezes MCP
 * availability at init. A server that failed to start reports
 * `status:'failed'`, and one whose `initialize` is still outstanding reports
 * `status:'pending'` — in BOTH cases its tools are absent from the model's tool
 * table for the entire turn, while the run itself completes `is_error:false`.
 * Anything that is not an established connection therefore counts as unusable;
 * the runner turns that into an explicit node failure for platform-fenced
 * servers instead of letting the node "succeed" without its declared tools.
 */
export function parseUnusableMcpServers(line: string): readonly string[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const evt = parsed as Record<string, unknown>
  if (evt.type !== 'system' || evt.subtype !== 'init') return null
  const servers = evt.mcp_servers
  if (!Array.isArray(servers)) return null
  const unusable: string[] = []
  for (const entry of servers) {
    if (!entry || typeof entry !== 'object') continue
    const row = entry as Record<string, unknown>
    if (typeof row.name !== 'string' || row.name.length === 0) continue
    if (row.status === 'connected') continue
    unusable.push(row.name)
  }
  return unusable
}

/**
 * 2026-08-09 — the `system/init` event's CAPABILITY inventory: what the runtime
 * actually loaded for this turn (its own built-ins included).
 *
 * Measured on claude 2.1.226, the init event carries all three lists the
 * platform injects into:
 *   · `tools`  — the loaded built-in set, i.e. exactly what `--tools` pruned to;
 *   · `agents` — every addressable subagent type, `--agents` entries + built-ins;
 *   · `skills` — canonical skill names, which are the DIRECTORY names under the
 *                skills dir (frontmatter `name:` only becomes `displayName`),
 *                so they compare literally against what `stageSkills` wrote.
 *
 * Returns null for any line carrying none of them (keep looking). A present but
 * empty array is a real answer — the runtime loaded nothing of that kind.
 */
export function parseStartupInventory(line: string): StartupInventory | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const evt = parsed as Record<string, unknown>
  if (evt.type !== 'system' || evt.subtype !== 'init') return null
  const names = (value: unknown): readonly string[] | undefined =>
    Array.isArray(value)
      ? value.filter((name): name is string => typeof name === 'string' && name.length > 0)
      : undefined
  const inventory: { tools?: readonly string[]; agents?: readonly string[] } & {
    skills?: readonly string[]
  } = {}
  const tools = names(evt.tools)
  const agents = names(evt.agents)
  const skills = names(evt.skills)
  if (tools !== undefined) inventory.tools = tools
  if (agents !== undefined) inventory.agents = agents
  if (skills !== undefined) inventory.skills = skills
  // An init event that enumerates none of the three tells us nothing.
  return tools === undefined && agents === undefined && skills === undefined ? null : inventory
}

/** ISO-8601 `timestamp` → ms epoch; undefined when absent/unparseable. */
function extractTimestamp(evt: Record<string, unknown>): number | undefined {
  const raw = evt.timestamp
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw !== 'string') return undefined
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : undefined
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
