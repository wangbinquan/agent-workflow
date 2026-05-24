// RFC-061 PR-B T9-extra — runner-v2 stdout aggregator (pure function).
//
// Step 2 of the cutover playbook ("subprocess spawn + envelope parser")
// breaks into two halves: the spawn-and-pump loop (still TBD) and the
// pure aggregation logic that turns a STREAM of opencode JSON event
// objects into a settled assistant message + token usage + subagent
// telemetry observations.
//
// This file lands the pure half: given an array of decoded JSON events,
// produce an `AggregatedStdout` with all the things the subprocess
// loop's exit handler needs. Pure → no DB, no subprocess, no IO; the
// caller decides what events to write.
//
// The subprocess spawn loop (to be added next) will call this function
// AFTER pumpLines has finished accumulating lines (on process exit).

import { extractTextFromEvent, inferEventKind, accumulateTokens } from '../services/runner'
import {
  detectEnvelopeKind,
  extractClarifyEnvelopeBody,
  extractLastEnvelope,
  parseEnvelope,
} from '../services/envelope'
import type { RunResult } from '../services/runner'

export interface AggregatedStdout {
  /** Full concatenated assistant text from all `text.*` events. */
  assistantText: string
  /** First opencode session id seen in any event (for resume). */
  sessionId: string | undefined
  /** Token usage accumulated across all model.* / message.* events. */
  tokenUsage: RunResult['tokenUsage']
  /**
   * Observed subagent tool-use events (for emitting attempt-subagent-tool-use
   * RFC-061 events). One entry per subagent.tool.* event encountered.
   */
  subagentToolUses: Array<{
    sessionId: string
    toolName: string
    detail: unknown
  }>
  /**
   * Observed subagent text outputs (for emitting attempt-subagent-output
   * events). One entry per subagent text accumulation.
   */
  subagentOutputs: Array<{ sessionId: string; content: string }>
  /**
   * Envelope detection result on the FINAL assistant text. Drives the
   * subprocess loop's branching between success / envelope-fail / clarify.
   */
  envelopeKind: 'output' | 'clarify' | 'both' | 'none'
  /**
   * Parsed port outputs when envelopeKind === 'output' AND the envelope
   * parses cleanly against `declaredOutputs`. Empty when none of the
   * conditions hold.
   */
  parsedOutputs: Record<string, string>
  /** Raw clarify envelope body when envelopeKind === 'clarify'. */
  clarifyBody: string | null
  /** Any port-validation error encountered while parsing the output envelope. */
  outputParseError: string | null
}

export interface AggregateStdoutOptions {
  /** Pre-decoded JSON event objects (one per opencode stdout line). */
  events: ReadonlyArray<Record<string, unknown>>
  /** Output port names declared on the agent (frontmatter `outputs: [...]`). */
  declaredOutputs: ReadonlyArray<string>
}

/**
 * Aggregate one attempt's full event stream into the post-exit state.
 * Pure: no IO, no exceptions on malformed events (skipped silently).
 */
export function aggregateStdout(opts: AggregateStdoutOptions): AggregatedStdout {
  let assistantText = ''
  let sessionId: string | undefined
  const tokenUsage: RunResult['tokenUsage'] = {
    input: 0,
    output: 0,
    cacheCreate: 0,
    cacheRead: 0,
    total: 0,
  }
  const subagentToolUses: AggregatedStdout['subagentToolUses'] = []
  const subagentOutputs: AggregatedStdout['subagentOutputs'] = []
  // Track subagent text buffers per sessionId so we can emit a single
  // attempt-subagent-output event per subagent invocation.
  const subagentTextBuf = new Map<string, string>()

  for (const evt of opts.events) {
    if (typeof evt !== 'object' || evt === null) continue
    // sessionId: take the first non-empty one seen.
    if (sessionId === undefined && typeof evt.sessionID === 'string') {
      sessionId = evt.sessionID
    }
    // Token accumulation (per opencode model.* / message.* events).
    accumulateTokens(evt, tokenUsage)

    const kind = inferEventKind(evt)
    const subId = pickSubSessionId(evt)

    if (kind === 'text') {
      const t = extractTextFromEvent(evt)
      if (t === null) continue
      if (subId !== undefined) {
        // Subagent text — buffer per subSessionID.
        subagentTextBuf.set(subId, (subagentTextBuf.get(subId) ?? '') + t)
      } else {
        // Primary agent text.
        assistantText += t
      }
    } else if (kind === 'tool_use') {
      const sub = subId ?? sessionId ?? 'unknown'
      const toolName = pickToolName(evt) ?? 'unknown'
      subagentToolUses.push({ sessionId: sub, toolName, detail: evt })
    }
    // Other kinds (reasoning, permission_asked, error, step_*) are
    // informational only for v1; not emitted as RFC-061 events.
  }

  // Flush subagent text buffers into output entries.
  for (const [sub, content] of subagentTextBuf) {
    if (content.length > 0) {
      subagentOutputs.push({ sessionId: sub, content })
    }
  }

  // Envelope detection + parsing on the final assistant text.
  const envelopeKind = detectEnvelopeKind(assistantText)
  let parsedOutputs: Record<string, string> = {}
  let outputParseError: string | null = null
  if (envelopeKind === 'output' || envelopeKind === 'both') {
    const last = extractLastEnvelope(assistantText)
    if (last !== null) {
      try {
        const r = parseEnvelope(last, [...opts.declaredOutputs])
        // EnvelopeParseResult shape: ports Map + missingDeclared + undeclared.
        const out: Record<string, string> = {}
        for (const [k, v] of r.ports) out[k] = v
        parsedOutputs = out
        if (r.missingDeclared.length > 0) {
          outputParseError = `missing declared ports: ${r.missingDeclared.join(', ')}`
        }
      } catch (err) {
        outputParseError = err instanceof Error ? err.message : String(err)
      }
    } else {
      outputParseError = 'no <workflow-output> envelope found'
    }
  }
  const clarifyBody =
    envelopeKind === 'clarify' || envelopeKind === 'both'
      ? extractClarifyEnvelopeBody(assistantText)
      : null

  return {
    assistantText,
    sessionId,
    tokenUsage,
    subagentToolUses,
    subagentOutputs,
    envelopeKind,
    parsedOutputs,
    clarifyBody,
    outputParseError,
  }
}

function pickSubSessionId(evt: Record<string, unknown>): string | undefined {
  const sub = (evt as { subSessionID?: unknown }).subSessionID
  if (typeof sub === 'string' && sub.length > 0) return sub
  return undefined
}

function pickToolName(evt: Record<string, unknown>): string | undefined {
  const part = evt.part as { name?: unknown } | undefined
  if (part && typeof part.name === 'string') return part.name
  const direct = (evt as { name?: unknown }).name
  if (typeof direct === 'string') return direct
  return undefined
}
