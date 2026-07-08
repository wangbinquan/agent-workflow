// RFC-147 — system-channel-port descriptor registry: the single source for
// "which port names are framework channel ports, and how does each behave"
// across the clarify (RFC-023) + cross-clarify (RFC-056) families.
//
// This knowledge used to exist as SIX copies in THREE semantic families,
// with member sets that had already drifted:
//   1. shared/clarify.ts `isClarifyChannelEdge` — 5 ports, side-respecting
//      (edge classification: canvas cascade delete, validator dangling-edge
//      exemption, scheduler topologicalOrder cycle-break);
//   2. shared/workflow-sync-diff.ts private CHANNEL_PORTS — same 5 ports but
//      EITHER-side match (deliberately wider, display-defensive);
//   3. shared/prompt.ts private SYSTEM_PORT_NAMES — 2 target-side ports
//      (auto-append must skip empty `## __port__` headers; content arrives
//      via dedicated prompt blocks);
//   4. scheduler.ts buildScopeUpstreams — the nuanced dataflow semantics:
//      `__clarify__` is skipped ONLY when the target is an RFC-023 clarify
//      node; a cross-clarify target KEEPS the edge as a real dependency
//      (2026-05-22 bug: skipping it made cross-clarify a no-upstream leaf
//      that re-fired every tick);
//   5. dispatchFrontier.ts wrapperExternalUpstreamSources — a verbatim hand
//      copy of #4 whose comment demanded "keep the two in lockstep";
//   6. taskQuestionDispatch.ts private isChannelEdge — byte-equivalent to #1
//      (its "uniform skip" wording is an argument about agent-ancestry
//      equivalence, not a different shape).
//
// Now each family is a projection of this one table. Adding a channel port
// = one registry row.
//
// NOTE the deliberate semantic split that stays: topologicalOrder uses the
// uniform side-respecting classifier (cycle-break wants conservative
// uniformity), while dependency gating uses `channelEdgeDataflowSkip`
// (nuanced). The registry expresses both; it does not flatten them.

import {
  CLARIFY_RESPONSE_TARGET_PORT_NAME,
  CLARIFY_SOURCE_PORT_NAME,
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
  CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
  CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
} from './schemas/workflow'

export interface SystemChannelPortSpec {
  /** Which side of a well-formed channel edge this port name appears on.
   *  Side-respecting classification prevents nonsense matches (an edge
   *  whose SOURCE portName is `__clarify_response__` is not a channel
   *  edge — that name is a target-side inbound). */
  side: 'source' | 'target'
  /** Content is injected via a dedicated prompt block (`## Clarify Q&A`,
   *  `## External Feedback`), so prompt auto-append must skip the empty
   *  `## <port>` header it would otherwise emit for the wired port. */
  promptInjected: boolean
  /** Dataflow-dependency semantics for graph walks that gate dispatch:
   *  - 'never' — the edge is never a dataflow dependency (skip);
   *  - 'unless-target-clarify' — skip only when the TARGET node is an
   *    RFC-023 `clarify` node (dispatched out-of-band by the runner); any
   *    other target (notably RFC-056 `clarify-cross-agent`) KEEPS the edge
   *    as a real dependency. */
  dataflow: 'never' | 'unless-target-clarify'
}

export const SYSTEM_CHANNEL_PORTS = {
  [CLARIFY_SOURCE_PORT_NAME]: {
    side: 'source',
    promptInjected: false,
    dataflow: 'unless-target-clarify',
  },
  [CLARIFY_RESPONSE_TARGET_PORT_NAME]: {
    side: 'target',
    promptInjected: true,
    dataflow: 'never',
  },
  [CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT]: {
    side: 'target',
    promptInjected: true,
    dataflow: 'never',
  },
  [CROSS_CLARIFY_OUT_TO_DESIGNER_PORT]: {
    side: 'source',
    promptInjected: false,
    dataflow: 'never',
  },
  [CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT]: {
    side: 'source',
    promptInjected: false,
    dataflow: 'never',
  },
} as const satisfies Record<string, SystemChannelPortSpec>

type EdgeEnds = {
  source: { nodeId: string; portName: string }
  target: { nodeId: string; portName: string }
}

function specFor(portName: string): SystemChannelPortSpec | undefined {
  // Object.hasOwn (not `in`): port names come from user-authored edges —
  // inherited keys ('constructor', …) must not index the table.
  return Object.hasOwn(SYSTEM_CHANNEL_PORTS, portName)
    ? SYSTEM_CHANNEL_PORTS[portName as keyof typeof SYSTEM_CHANNEL_PORTS]
    : undefined
}

/**
 * Family A — side-respecting membership: is this edge one of the clarify /
 * cross-clarify channel edges? (`isClarifyChannelEdge` is a thin alias kept
 * at its historical home in clarify.ts.)
 */
export function isSystemChannelEdge(e: EdgeEnds): boolean {
  return (
    specFor(e.source.portName)?.side === 'source' || specFor(e.target.portName)?.side === 'target'
  )
}

/**
 * Family B — either-side wide match. Deliberately WIDER than
 * `isSystemChannelEdge`: a channel port name appearing on the wrong side
 * (corrupt / hand-edited definition) still counts. Display-defensive —
 * workflow-sync-diff uses this so a malformed channel edge never shows up
 * as a "data edge changed" diff row.
 */
export function touchesSystemChannelPort(e: EdgeEnds): boolean {
  return specFor(e.source.portName) !== undefined || specFor(e.target.portName) !== undefined
}

/**
 * Family C — prompt-injected target ports (auto-append skip set).
 */
export const PROMPT_INJECTED_PORT_NAMES: ReadonlySet<string> = new Set(
  Object.entries(SYSTEM_CHANNEL_PORTS)
    .filter(([, spec]) => spec.promptInjected)
    .map(([name]) => name),
)

/**
 * Family D — dataflow-dependency skip for dispatch-gating graph walks
 * (buildScopeUpstreams / wrapperExternalUpstreamSources — historically two
 * hand-synced copies of this exact logic).
 *
 * Returns true when the edge must be SKIPPED (it is not a dataflow
 * dependency). `kindOfTarget` resolves the target node's kind — scope-local
 * or whole-definition lookup, per caller.
 */
export function channelEdgeDataflowSkip(
  e: EdgeEnds,
  kindOfTarget: (nodeId: string) => string | undefined,
): boolean {
  const src = specFor(e.source.portName)
  if (src !== undefined && src.side === 'source') {
    if (src.dataflow === 'never') return true
    // 'unless-target-clarify': RFC-023 clarify targets are dispatched
    // out-of-band (skip to prevent agent→clarify→agent cycles); RFC-056
    // cross-clarify targets legitimately wait for the questioner (keep).
    if (src.dataflow === 'unless-target-clarify') {
      return kindOfTarget(e.target.nodeId) === 'clarify'
    }
  }
  const tgt = specFor(e.target.portName)
  if (tgt !== undefined && tgt.side === 'target' && tgt.dataflow === 'never') {
    return true
  }
  return false
}
