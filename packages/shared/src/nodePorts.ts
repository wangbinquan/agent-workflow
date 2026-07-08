// RFC-146 — declared-port single source: what ports does a node of kind K
// expose, given its own fields + its agent + its neighbors?
//
// This knowledge used to live in FIVE independent forks that drifted apart:
//   1. canvas `computePorts` (WorkflowCanvas.tsx) — data-port authority,
//      plus edge-tolerance rendering fallbacks;
//   2. backend `workflow.validator.ts` port switch — system-port authority,
//      but blind to wrapper-fanout (a fanout outlet wired to a plain
//      downstream edge false-errored `edge-source-port-missing` and BLOCKED
//      task launch — fixed by this consolidation);
//   3. loop candidates `deriveOutputPorts` (wrapperCandidates.ts) — knew
//      agent/review only;
//   4. control flow `sourcePortKind` (controlFlowEdge.ts) — knew
//      agent/fanout only;
//   5. drag-drop `existingInputPorts` (dropTarget.ts) — knew output only.
//
// Now each surface takes a projection of this one table. Grouping (D3):
//   - data* — ports that carry workflow data; the canvas renders them as
//     Handles and the scheduler moves bytes through them.
//   - system* — framework channel ports (clarify family, agent system
//     inbounds). The validator accepts edges on them; the canvas keeps its
//     existing "render only when an edge exists" behavior by NOT reading
//     these groups (edge-derived fallback covers them), so classifying a
//     port as system is exactly the old "canvas 靠边补 / validator 硬编码"
//     split made explicit.
//
// Edge-derived tolerance (stale snapshot vs edited agent, boundary-edge
// skips, ordering) intentionally stays at the call sites — this module is
// pure declaration, no edges consulted.

import type { WorkflowDefinition, WorkflowNode } from './schemas/workflow'
import { NODE_KIND, type NodeKind } from './schemas/workflow'
import { deriveWrapperFanoutOutputs, lookupAgent, type AgentLookup } from './wrapperFanout'
import { reviewApprovedPortName } from './reviewMultiDoc'

/**
 * The structural slice of `Agent` that port declaration actually reads.
 * Full `Agent` objects satisfy this (ReadonlyMap value covariance), and
 * lighter summaries (e.g. the canvas Inspector's AgentSummary fixtures)
 * do too — port declaration must not force callers to materialize fields
 * it never consults.
 */
export interface PortLookupAgent {
  outputs?: readonly string[]
  outputKinds?: Record<string, string>
  outputWrapperPortNames?: Record<string, string>
  role?: string
}

export type PortAgentLookup =
  | ReadonlyMap<string, PortLookupAgent>
  | Readonly<Record<string, PortLookupAgent | undefined>>

export interface DeclaredPort {
  name: string
  /** Output-port kind (e.g. 'signal', 'list<path<md>>') where the source
   *  declares one — agent outputs via `agent.outputKinds`, fanout outlets
   *  via `deriveWrapperFanoutOutputs`, fanout inputs via their declared
   *  `kind` field. Undefined elsewhere (review/git/loop/input), matching
   *  what `sourcePortKind` historically derived — do NOT add kinds to
   *  those without auditing control-flow-edge classification. */
  kind?: string
}

export interface DeclaredPorts {
  dataInputs: DeclaredPort[]
  dataOutputs: DeclaredPort[]
  systemInputs: DeclaredPort[]
  systemOutputs: DeclaredPort[]
}

const NO_PORTS: DeclaredPorts = Object.freeze({
  dataInputs: [],
  dataOutputs: [],
  systemInputs: [],
  systemOutputs: [],
})

interface DeriverCtx {
  node: WorkflowNode
  defn: WorkflowDefinition
  agents: PortAgentLookup
}

function readString(node: WorkflowNode, key: string): string | undefined {
  const v = (node as unknown as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : undefined
}

/** `{ name: string }[]`-ish field reader (output.ports / loop.outputBindings /
 *  fanout.inputs) — tolerant of malformed rows, keeps declaration order. */
function readNamedList(node: WorkflowNode, key: string): Array<{ name: string; kind?: string }> {
  const v = (node as unknown as Record<string, unknown>)[key]
  if (!Array.isArray(v)) return []
  const out: Array<{ name: string; kind?: string }> = []
  for (const item of v) {
    const rec = item as { name?: unknown; kind?: unknown } | null
    if (typeof rec?.name !== 'string') continue
    out.push(typeof rec.kind === 'string' ? { name: rec.name, kind: rec.kind } : { name: rec.name })
  }
  return out
}

/**
 * Resolve a review node's input kind (multi-doc vs single-doc decision
 * feed for `reviewApprovedPortName`). This derivation itself existed as
 * three drifting copies (canvas / validator / wrapperCandidates) — now one.
 * Only agent upstreams carry `outputKinds`; anything else ⇒ undefined
 * (single-document `approved_doc`).
 */
export function resolveReviewInputKind(
  node: WorkflowNode,
  defn: WorkflowDefinition,
  agents: PortAgentLookup,
): string | undefined {
  const src = (node as unknown as Record<string, unknown>).inputSource as
    | { nodeId?: unknown; portName?: unknown }
    | null
    | undefined
  if (typeof src?.nodeId !== 'string' || typeof src.portName !== 'string') return undefined
  const sourceNode = defn.nodes.find((n) => n.id === src.nodeId)
  if (sourceNode === undefined || sourceNode.kind !== 'agent-single') return undefined
  const agentName = readString(sourceNode, 'agentName')
  if (agentName === undefined) return undefined
  return lookupAgent(agents, agentName)?.outputKinds?.[src.portName]
}

/**
 * Per-kind port declaration matrix. `satisfies Record<NodeKind, …>` makes
 * adding a NodeKind without declaring its port shape a compile error.
 */
const PORT_DERIVERS = {
  input: ({ node }: DeriverCtx): DeclaredPorts => ({
    ...NO_PORTS,
    // canvas historically fell back to 'out' when inputKey is missing
    // (malformed node); the validator was stricter (no port at all). The
    // single source keeps the tolerant form — a malformed input node fails
    // loudly at runtime input resolution, not with a phantom edge error.
    dataOutputs: [{ name: readString(node, 'inputKey') ?? 'out' }],
  }),
  output: ({ node }: DeriverCtx): DeclaredPorts => ({
    ...NO_PORTS,
    dataInputs: readNamedList(node, 'ports').map((p) => ({ name: p.name })),
  }),
  'agent-single': ({ node, agents }: DeriverCtx): DeclaredPorts => {
    const agent = lookupAgent(agents, readString(node, 'agentName') ?? '')
    return {
      dataInputs: [], // agent inputs are edge-derived prompt vars, never declared
      dataOutputs: [...(agent?.outputs ?? [])].map((name) => {
        const kind = agent?.outputKinds?.[name]
        return kind !== undefined ? { name, kind } : { name }
      }),
      // RFC-023/RFC-056 framework channels: __clarify__ outbound is accepted
      // on every agent; __clarify_response__ / __external_feedback__ inbound
      // likewise (canvas hides these Handles until an edge exists).
      systemInputs: [{ name: '__clarify_response__' }, { name: '__external_feedback__' }],
      systemOutputs: [{ name: '__clarify__' }],
    }
  },
  'wrapper-git': (): DeclaredPorts => ({
    ...NO_PORTS,
    dataOutputs: [{ name: 'git_diff' }],
  }),
  'wrapper-loop': ({ node }: DeriverCtx): DeclaredPorts => ({
    ...NO_PORTS,
    dataOutputs: readNamedList(node, 'outputBindings').map((p) => ({ name: p.name })),
  }),
  'wrapper-fanout': ({ node, defn, agents }: DeriverCtx): DeclaredPorts => {
    // Outlets derived from the inner aggregator (or the implicit __done__
    // signal). Dedup by name — rename collisions used to be deduped at the
    // canvas call site; now every projection sees the deduped list.
    const dataOutputs: DeclaredPort[] = []
    // The fanout oracle is typed over full Agent lookups, but it only reads
    // role / outputs / outputWrapperPortNames / outputKinds — exactly the
    // PortLookupAgent slice — so this cast is structurally sound. Kept HERE
    // (one documented spot inside the table) instead of forcing every
    // caller to materialize full Agents.
    for (const p of deriveWrapperFanoutOutputs(defn, node.id, agents as AgentLookup)) {
      if (!dataOutputs.some((d) => d.name === p.name)) dataOutputs.push({ ...p })
    }
    return {
      ...NO_PORTS,
      dataInputs: readNamedList(node, 'inputs'),
      dataOutputs,
    }
  },
  review: ({ node, defn, agents }: DeriverCtx): DeclaredPorts => ({
    ...NO_PORTS,
    // RFC-005/079/081: approved outlet name depends on the input kind
    // (multi-doc list<markdownish> ⇒ 'accepted', else 'approved_doc').
    dataOutputs: [
      { name: reviewApprovedPortName(resolveReviewInputKind(node, defn, agents)) },
      { name: 'approval_meta' },
    ],
  }),
  clarify: (): DeclaredPorts => ({
    ...NO_PORTS,
    // RFC-023 fixed 1-in/1-out shape. System group: the validator accepts
    // the edges; the canvas renders these ports edge-derived only.
    systemInputs: [{ name: 'questions' }],
    systemOutputs: [{ name: 'answers' }],
  }),
  'clarify-cross-agent': (): DeclaredPorts => ({
    ...NO_PORTS,
    // RFC-056 fixed 1-in/2-out shape.
    systemInputs: [{ name: 'questions' }],
    systemOutputs: [{ name: 'to_designer' }, { name: 'to_questioner' }],
  }),
} as const satisfies Record<NodeKind, (ctx: DeriverCtx) => DeclaredPorts>

/**
 * THE port declaration for one node. Pure over (node fields, agent set,
 * neighbor nodes) — no edges consulted; edge tolerance stays at call sites.
 */
export function declaredPorts(
  node: WorkflowNode,
  defn: WorkflowDefinition,
  agents: PortAgentLookup,
): DeclaredPorts {
  const derive = PORT_DERIVERS[node.kind as NodeKind] as
    | ((ctx: DeriverCtx) => DeclaredPorts)
    | undefined
  // Unknown kind (corrupt/stale snapshot) ⇒ no declared ports; the caller's
  // edge-derived fallbacks still render/route whatever edges exist.
  if (derive === undefined) return NO_PORTS
  return derive({ node, defn, agents })
}

/** All NodeKind values whose declaration derives from PORT_DERIVERS —
 *  re-exported for table-shape tests. */
export const PORT_DECLARED_KINDS: readonly NodeKind[] = NODE_KIND
