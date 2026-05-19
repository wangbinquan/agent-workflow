// RFC-049 — static OutputKindHandler registry.
//
// Adding a new kind = (1) add a handler file in this directory, (2) import +
// register it in HANDLERS below. The module-load-time assert at the bottom
// of this file refuses to boot if two handlers claim the same `subReason`
// short-code, so cross-kind namespace collisions are caught in CI rather
// than at runtime when an unrelated kind happens to emit a colliding code.
//
// Do NOT export a public `register(handler)` API; do NOT load handlers from
// `package.json` plugin fields; do NOT introduce dynamic registration. The
// handlers are baked into the build. Future "runtime plugin loader" — if
// ever needed — must come via a separate RFC; do not bolt it onto this
// registry as a convenience.

import type { AgentOutputKind } from '../schemas/review'
import stringHandler from './string'
import markdownHandler from './markdown'
import markdownFileHandler from './markdownFile'
import type { KindFailure, OutputKindHandler } from './types'

export const HANDLERS: Readonly<Record<AgentOutputKind, OutputKindHandler>> = Object.freeze({
  string: stringHandler,
  markdown: markdownHandler,
  markdown_file: markdownFileHandler,
})

export function getOutputKindHandler(kind: AgentOutputKind): OutputKindHandler {
  const h = HANDLERS[kind]
  if (!h) {
    // Defense-in-depth: AgentOutputKind is a string-literal union, so the
    // type system already prevents missing entries. This throw is the
    // runtime sibling for cases like dynamic JSON inputs where a kind value
    // bypasses TS narrowing.
    throw new Error(`outputKind handler not registered: ${String(kind)}`)
  }
  return h
}

export type DistinctKindGroup = {
  handler: OutputKindHandler
  /** Ports declared as the handler's kind (in declaration order). */
  ports: string[]
}

/**
 * Group `agentOutputKinds` into per-kind buckets in first-occurrence order,
 * pairing each kind with its registered handler. Ports whose `outputKinds`
 * entry is absent (legacy default) fall back to the `string` handler so
 * `buildPromptGuidance` etc still has a place to dispatch.
 *
 * Ports that appear in `agentOutputKinds` but are absent from
 * `declaredOutputs` are dropped — they have no first-turn slot to render
 * guidance for. Conversely, ports in `declaredOutputs` with no
 * `agentOutputKinds` entry land in the `string` bucket.
 */
export function groupPortsByKind(
  declaredOutputs: readonly string[],
  agentOutputKinds?: Record<string, AgentOutputKind>,
): DistinctKindGroup[] {
  const byKind = new Map<AgentOutputKind, string[]>()
  const orderedKinds: AgentOutputKind[] = []
  for (const port of declaredOutputs) {
    const k = (agentOutputKinds?.[port] ?? 'string') as AgentOutputKind
    if (!byKind.has(k)) {
      byKind.set(k, [])
      orderedKinds.push(k)
    }
    byKind.get(k)!.push(port)
  }
  return orderedKinds.map((k) => ({ handler: getOutputKindHandler(k), ports: byKind.get(k)! }))
}

/**
 * RFC-049: compose the per-kind repair text segments the scheduler's followup
 * attempt feeds into `renderEnvelopeFollowupPrompt.perKindRepairBlocks`. The
 * algorithm:
 *
 *   1. Bucket `failures` by `kind`, in first-occurrence order.
 *   2. For each bucket, look up the registered handler and call
 *      `handler.buildRepairBlock({ failures: <bucket>, ports: <kind ports
 *      on this agent> })`.
 *   3. Drop null segments (handlers that opt out, e.g. string / markdown).
 *   4. Drop failures whose `kind` has no registered handler (defensive — the
 *      scheduler reads from the JSON column written by an older runner; if
 *      somehow the kind isn't in HANDLERS, surfacing the failure as a
 *      generic "no handler" wouldn't help the agent). Callers can detect
 *      the degraded case via the returned array being empty / shorter than
 *      `failures.length`.
 *
 * The renderer joins the resulting strings with blank lines.
 */
export function composePerKindRepairBlocks(
  failures: readonly KindFailure[],
  agentOutputKinds?: Record<string, AgentOutputKind>,
): string[] {
  if (failures.length === 0) return []
  const orderedKinds: AgentOutputKind[] = []
  const byKind = new Map<AgentOutputKind, KindFailure[]>()
  for (const f of failures) {
    const k = f.kind as AgentOutputKind
    if (!HANDLERS[k]) continue
    if (!byKind.has(k)) {
      byKind.set(k, [])
      orderedKinds.push(k)
    }
    byKind.get(k)!.push(f)
  }
  const out: string[] = []
  for (const k of orderedKinds) {
    const handler = HANDLERS[k]!
    const ports = Object.entries(agentOutputKinds ?? {})
      .filter(([, kk]) => kk === k)
      .map(([port]) => port)
    const segment = handler.buildRepairBlock({ failures: byKind.get(k)!, ports })
    if (segment !== null) out.push(segment)
  }
  return out
}

// -----------------------------------------------------------------------------
// Module-load-time invariant: every subReason short-code is owned by exactly
// one handler. Cross-kind collisions break the `port-validation-<kind>-<sub>`
// reverse lookup and indicate a sloppy new-kind PR — fail loudly here so the
// PR can never land.
// -----------------------------------------------------------------------------
{
  const claimedBy = new Map<string, AgentOutputKind>()
  for (const h of Object.values(HANDLERS)) {
    for (const sub of h.subReasons) {
      const prev = claimedBy.get(sub)
      if (prev !== undefined && prev !== h.kind) {
        throw new Error(
          `RFC-049 outputKinds: subReason collision: '${sub}' claimed by both ${prev} and ${h.kind}`,
        )
      }
      claimedBy.set(sub, h.kind)
    }
  }
}

export { stringHandler, markdownHandler, markdownFileHandler }
export * from './types'
