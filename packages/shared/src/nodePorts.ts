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
import {
  CLARIFY_RESPONSE_TARGET_PORT_NAME,
  CLARIFY_SOURCE_PORT_NAME,
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,
  CROSS_CLARIFY_OUT_TO_DESIGNER_PORT,
  CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT,
  NODE_KIND,
  type NodeKind,
} from './schemas/workflow'
import { declaredScriptOutputs } from './scriptNode'
import { deriveWrapperFanoutOutputs, resolveNodeAgent, type AgentLookup } from './wrapperFanout'
import { REVIEW_APPROVAL_META_PORT, reviewApprovedPortName } from './reviewMultiDoc'

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
  /** RFC-306 — subset of `outputs` that may be deactivated at runtime. */
  branchPorts?: readonly string[]
}

export type PortAgentLookup =
  | ReadonlyMap<string, PortLookupAgent>
  | Readonly<Record<string, PortLookupAgent | undefined>>

export interface DeclaredPort {
  name: string
  /**
   * RFC-306 — this OUTPUT port may be marked inactive at runtime
   * (`<port name="…" active="false">`), deactivating every edge that leaves it.
   * Sources: `agent.branchPorts` for agent nodes, `outputs[].branch` for script
   * nodes. Undefined everywhere else — and undefined means "may not be
   * deactivated", so a kind that grows branch support must opt in HERE, not by
   * accident. Consumed by the canvas (branch-port styling), the validator
   * (`port-inactive` exit conditions) and the runner (declaration check that
   * turns an undeclared marker into `branch-port-not-declared`).
   */
  branch?: boolean
  /** Output-port kind (e.g. 'signal', 'list<path<md>>') where the source
   *  declares one — agent outputs via `agent.outputKinds`, fanout outlets
   *  via `deriveWrapperFanoutOutputs`, fanout inputs via their declared
   *  `kind` field, and wrapper-git's `git_diff` path list. Undefined
   *  elsewhere (review/loop/input), matching
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

/**
 * The call-workflow selector as authored. RFC-271 T6e（决策 28）—— 解析规则
 * （id hint 优先、且仅当该行**仍带这个名字**时才采信，否则回退名字规则）归
 * **resolver 自己**所有，调用点只负责把选择器原样递过去。
 *
 * 此前是 `(nameOrId: string)`，于是每个调用点各自决定先试哪个：deriver 与前端
 * 解析器都写死 name 优先，而启动冻结（`closure.ts`）是 id 优先 ⇒ 同名双 id 时
 * **编辑器按 W1 推端口、启动按 W2 执行**（design §1.1c''' 可复现例）。
 */
export interface WorkflowRefSelector {
  /** Authoritative selector. */
  name?: string
  /** Resolution cache (the row the author actually picked). */
  id?: string
}

/**
 * RFC-243 §5.2 — resolver for call-workflow port derivation. Returns the
 * referenced workflow's definition, `'forbidden'` when the caller may not see
 * it (grandfathered reference without a use-grant — Inspector shows an
 * opaque placeholder), or `null` when unknown/still loading. Optional: every
 * pre-RFC-243 call site keeps its 3-arg shape and call-workflow simply
 * declares no ports there.
 */
export type WorkflowByRef = (ref: WorkflowRefSelector) => WorkflowDefinition | 'forbidden' | null

interface DeriverCtx {
  node: WorkflowNode
  defn: WorkflowDefinition
  agents: PortAgentLookup
  workflowByRef?: WorkflowByRef
}

function readString(node: WorkflowNode, key: string): string | undefined {
  const v = (node as unknown as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : undefined
}

/** The selector a call-workflow node authored, as-is. Empty strings drop out so
 *  a resolver never has to distinguish `''` from absent. */
export function callWorkflowSelector(node: WorkflowNode): WorkflowRefSelector {
  const name = readString(node, 'workflowName')
  const id = readString(node, 'workflowId')
  return {
    ...(name !== undefined && name.length > 0 ? { name } : {}),
    ...(id !== undefined && id.length > 0 ? { id } : {}),
  }
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
  // RFC-223 (PR-3a): resolve the upstream agent id-first (rename/ABA-safe).
  return resolveNodeAgent(sourceNode, agents)?.outputKinds?.[src.portName]
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
    // RFC-223 (PR-3a): resolve id-first (rename/ABA-safe) via the shared resolver.
    const agent = resolveNodeAgent(node, agents)
    return {
      dataInputs: [], // agent inputs are edge-derived prompt vars, never declared
      dataOutputs: [...(agent?.outputs ?? [])].map((name) => {
        const kind = agent?.outputKinds?.[name]
        // RFC-306: `branch` is only ever stamped TRUE (never `branch: false`) so
        // a non-branch port's declaration stays byte-identical to pre-RFC-306 —
        // several equality-shaped tests compare these objects wholesale.
        const branch = agent?.branchPorts?.includes(name) === true
        return {
          name,
          ...(kind !== undefined ? { kind } : {}),
          ...(branch ? { branch: true } : {}),
        }
      }),
      // RFC-023/RFC-056 framework channels: __clarify__ outbound is accepted
      // on every agent; __clarify_response__ / __external_feedback__ inbound
      // likewise (canvas hides these Handles until an edge exists).
      // RFC-147: names via the shared constants — the registry↔declaredPorts
      // drift test (rfc147-system-channel-ports.test.ts) cross-locks that
      // every registry port is declared on its owner kind here.
      systemInputs: [
        { name: CLARIFY_RESPONSE_TARGET_PORT_NAME },
        { name: CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT },
      ],
      systemOutputs: [{ name: CLARIFY_SOURCE_PORT_NAME }],
    }
  },
  // RFC-354 — wrapper-git / wrapper-loop PARAMETERS are edge-derived exactly
  // like agent-single inputs (an inbound edge's target portName IS the
  // parameter name), so `dataInputs` stays empty here: this table is pure
  // declaration and never consults edges (header). The body reads a parameter
  // through a `wrapper-input` boundary edge whose source port must be one of
  // those edge-derived names (validator `wrapper-input-port-missing`).
  'wrapper-git': (): DeclaredPorts => ({
    ...NO_PORTS,
    dataOutputs: [{ name: 'git_diff', kind: 'list<path<*>>' }],
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
      { name: REVIEW_APPROVAL_META_PORT },
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
    systemOutputs: [
      { name: CROSS_CLARIFY_OUT_TO_DESIGNER_PORT },
      { name: CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT },
    ],
  }),
  // RFC-243 §5.2 — call-workflow: inputs mirror the CHILD definition's
  // declared workflow inputs; outputs are the union of its output nodes'
  // bound port names (deduped — a collision is a validator error, the
  // declaration keeps first-wins for rendering stability). Without a
  // resolver (or an unresolvable/forbidden child) the node declares no
  // ports — callers render edge-derived fallbacks and the validator
  // degrades per design §5.2.
  'call-workflow': ({ node, workflowByRef }: DeriverCtx): DeclaredPorts => {
    const child = workflowByRef?.(callWorkflowSelector(node)) ?? null
    if (child === null || child === 'forbidden') return NO_PORTS
    const dataInputs: DeclaredPort[] = []
    for (const input of child.inputs) {
      const rec = input as { key?: unknown; kind?: unknown }
      if (typeof rec.key !== 'string') continue
      dataInputs.push(
        typeof rec.kind === 'string' ? { name: rec.key, kind: rec.kind } : { name: rec.key },
      )
    }
    const dataOutputs: DeclaredPort[] = []
    for (const n of child.nodes) {
      if (n.kind !== 'output') continue
      for (const p of readNamedList(n, 'ports')) {
        if (!dataOutputs.some((d) => d.name === p.name)) dataOutputs.push({ name: p.name })
      }
    }
    return { ...NO_PORTS, dataInputs, dataOutputs }
  },
  // RFC-243 §5.2 — call-workgroup: inputs are edge-derived prompt vars for the
  // goalTemplate (agent-single precedent, never declared); the single output
  // is the workgroup task's minimal `result` projection (§6.4).
  'call-workgroup': (): DeclaredPorts => ({
    ...NO_PORTS,
    dataOutputs: [{ name: 'result', kind: 'text' }],
  }),
  // RFC-253 §2 — script inputs are edge-derived (agent precedent: the incoming
  // edge's target portName IS the variable name, so nothing is declared);
  // outputs are the node's declared ports, or the single implicit `stdout`
  // outlet when none are declared (D3/D22).
  script: ({ node }: DeriverCtx): DeclaredPorts => ({
    ...NO_PORTS,
    dataOutputs: declaredScriptOutputs(node),
  }),
  // RFC-269 D22 — a code-host call declares NO inputs (its parameters are
  // templates resolved by name, the agent-single/script precedent) and exactly
  // two outputs, the same pair for every action and both optional to wire:
  // `response` is the response body verbatim, `status` the HTTP status code.
  'code-host-call': (): DeclaredPorts => ({
    ...NO_PORTS,
    dataOutputs: [
      { name: 'response', kind: 'text' },
      { name: 'status', kind: 'text' },
    ],
  }),
  // RFC-304 — the synthesized code-round node has NO user-connectable ports:
  // it is not authorable on the canvas and nothing wires into or out of it.
  // Its stage sequence consumes/produces values through the code-capability
  // round record, not through workflow ports.
  'code-round': (): DeclaredPorts => ({ ...NO_PORTS }),
} as const satisfies Record<NodeKind, (ctx: DeriverCtx) => DeclaredPorts>

/**
 * THE port declaration for one node. Pure over (node fields, agent set,
 * neighbor nodes) — no edges consulted; edge tolerance stays at call sites.
 */
export function declaredPorts(
  node: WorkflowNode,
  defn: WorkflowDefinition,
  agents: PortAgentLookup,
  extras?: { workflowByRef?: WorkflowByRef },
): DeclaredPorts {
  // Object.hasOwn (not a bare index): an inherited key like 'constructor'
  // would otherwise resolve to a Function and be invoked as a deriver.
  // Unknown kind (corrupt/stale snapshot) ⇒ no declared ports; the caller's
  // edge-derived fallbacks still render/route whatever edges exist.
  if (!Object.hasOwn(PORT_DERIVERS, node.kind)) return NO_PORTS
  const derive = PORT_DERIVERS[node.kind as NodeKind] as (ctx: DeriverCtx) => DeclaredPorts
  return derive({
    node,
    defn,
    agents,
    ...(extras?.workflowByRef ? { workflowByRef: extras.workflowByRef } : {}),
  })
}

/** All NodeKind values whose declaration derives from PORT_DERIVERS —
 *  re-exported for table-shape tests. */
export const PORT_DECLARED_KINDS: readonly NodeKind[] = NODE_KIND
