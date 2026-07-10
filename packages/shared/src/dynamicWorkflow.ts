// RFC-167 — dynamic workflow generation protocol: the orchestrator agent's
// `workflow` output-port payload (`DwGeneratedWorkflow`) and the pure
// conversion into a standard `WorkflowDefinition` that the ordinary validator
// + runScope engine execute.
//
// The orchestrator (a built-in agent, PR-2) reads the pool's capability cards
// (RFC-166) + the goal and emits a compact DAG description: a list of
// agent-single nodes, each with a `promptTemplate` and the upstream ports it
// consumes. v1 is deliberately narrow — ONLY agent-single nodes (no wrapper /
// review / clarify / io), every pool agent usable any number of times.
//
// Conversion decisions (v1, locked by tests):
//  - Each generated node → an `agent-single` WorkflowNode {id, kind, agentName,
//    promptTemplate}. NO synthetic input/output IO nodes: the orchestrator
//    bakes the goal into the source nodes' promptTemplates (it SAW the goal at
//    generation), and downstream nodes read upstream outputs via `{{portName}}`
//    templating over edges — so a self-contained agent-single chain validates
//    and runs without launcher inputs.
//  - Edges are derived from BOTH a node's declared `inputs` (each {port, from}
//    → an edge from the upstream port into this node's port) AND any top-level
//    `edges`, de-duped by (source, target). Node `inputs` is the ergonomic form
//    for an LLM ("this node consumes X from upstream Y", aligns with RFC-166
//    agent inputs); top-level `edges` is the explicit form. Both are honored.

import { z } from 'zod'
import { PortRefSchema, type WorkflowDefinition, type WorkflowEdge } from './schemas/workflow'

/** One declared input on a generated node: local `port` fed by an upstream port. */
export const DwGeneratedNodeInputSchema = z.object({
  port: z.string().min(1),
  from: PortRefSchema,
})
export type DwGeneratedNodeInput = z.infer<typeof DwGeneratedNodeInputSchema>

/** One generated node — always an agent-single in v1. */
export const DwGeneratedNodeSchema = z.object({
  id: z.string().min(1),
  agentName: z.string().min(1),
  promptTemplate: z.string(),
  inputs: z.array(DwGeneratedNodeInputSchema).default([]),
})
export type DwGeneratedNode = z.infer<typeof DwGeneratedNodeSchema>

/** The orchestrator's `workflow` output-port payload (parsed from JSON). */
export const DwGeneratedWorkflowSchema = z.object({
  nodes: z.array(DwGeneratedNodeSchema),
  edges: z.array(z.object({ source: PortRefSchema, target: PortRefSchema })).default([]),
})
export type DwGeneratedWorkflow = z.infer<typeof DwGeneratedWorkflowSchema>

/**
 * RFC-167 §4 layer-two validation error codes — the v1-constraint checks that
 * `validateDynamicWorkflowDef` (PR-2) emits ON TOP of the generic
 * `validateWorkflowDef`. Kept here in shared so the frontend can map them to
 * friendly copy. Values are stable kebab-case identifiers.
 */
export const DW_VALIDATION_CODES = {
  /** A node's kind is not 'agent-single' (wrapper/review/clarify/io forbidden in v1). */
  nodeKindForbidden: 'dw-node-kind-forbidden',
  /** A node's agentName is not in the space's agent pool. */
  agentOutsidePool: 'dw-agent-outside-pool',
  /** Zero agent-single nodes. */
  empty: 'dw-empty',
  /** A node is disconnected / orphaned (topology cycles are caught by layer one). */
  orphanNode: 'dw-orphan-node',
} as const
export type DwValidationCode = (typeof DW_VALIDATION_CODES)[keyof typeof DW_VALIDATION_CODES]

/** Deterministic, collision-free edge id for a (source → target) connection. */
function edgeId(e: WorkflowEdge): string {
  const s = e.source
  const t = e.target
  return `dwe_${s.nodeId}.${s.portName}__${t.nodeId}.${t.portName}`
}

/**
 * Convert a generated DAG into a standard `WorkflowDefinition` (schema v4).
 * Pure — no IO, deterministic edge ids, stable ordering. The result still has
 * to pass `validateWorkflowDef` + `validateDynamicWorkflowDef` before it is
 * ever executed; this function only reshapes, it does not validate.
 */
export function dwGeneratedToWorkflowDef(gen: DwGeneratedWorkflow): WorkflowDefinition {
  const nodes = gen.nodes.map((n) => ({
    id: n.id,
    kind: 'agent-single' as const,
    agentName: n.agentName,
    promptTemplate: n.promptTemplate,
  }))

  // Collect edges from node.inputs (ergonomic form) + top-level edges (explicit
  // form), de-duped by the (source, target) tuple so the two forms can overlap
  // without producing parallel duplicate edges.
  const seen = new Set<string>()
  const edges: WorkflowEdge[] = []
  const push = (source: WorkflowEdge['source'], target: WorkflowEdge['target']) => {
    const candidate: WorkflowEdge = { id: '', source, target }
    const id = edgeId(candidate)
    if (seen.has(id)) return
    seen.add(id)
    edges.push({ id, source, target })
  }
  for (const n of gen.nodes) {
    for (const input of n.inputs) {
      push(input.from, { nodeId: n.id, portName: input.port })
    }
  }
  for (const e of gen.edges) {
    push(e.source, e.target)
  }

  return { $schema_version: 4, inputs: [], nodes, edges }
}
