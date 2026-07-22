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
import { WorkgroupModeSchema, type WorkgroupMode } from './schemas/workgroup'

/**
 * The lifecycle phases of a dynamic_workflow workgroup task (stored in the
 * task's workgroup_config_json under `dw.phase`, beside the lw `gate` blob):
 *   - generating:      the orchestrator run is producing / being validated.
 *   - awaiting_confirm: a valid workflow was generated; parked for human review.
 *   - executing:        confirmed; the generated DAG was swapped in and runs.
 *   - rejected:         a human rejected; regenerate with feedback.
 * The task-level status still moves through the ordinary running /
 * awaiting_review / done states; dw.phase is the finer dynamic-mode sub-state
 * (design §8). Lives in shared so the frontend maps phases to copy and the
 * backend dispatches on them from ONE source.
 */
export const DW_PHASES = ['generating', 'awaiting_confirm', 'executing', 'rejected'] as const
export type DynamicWorkflowPhase = (typeof DW_PHASES)[number]

/**
 * RFC-167 — the durable per-task dynamic-workflow state, persisted as the `dw`
 * key of `tasks.workgroup_config_json` (same free-slot pattern as the lw
 * completion-gate `gate` blob; WorkgroupRuntimeConfigSchema strips unknown
 * keys so the runtime config parse is unaffected). `(phase, generateAttempts,
 * generatedDef?)` is the complete idempotent-recovery checkpoint (design §8).
 */
export const DwStateSchema = z.object({
  phase: z.enum(DW_PHASES),
  /** Failed generation attempts THIS pass (bad JSON / schema / validation). */
  generateAttempts: z.number().int().min(0).default(0),
  /** Completed human reject rounds (bounded by DW_MAX_REJECT_ROUNDS). */
  rejectRounds: z.number().int().min(0).default(0),
  /** Human feedback from the last rejection — injected into the regen prompt. */
  rejectionComment: z.string().optional(),
  /** The validated generated WorkflowDefinition (present from awaiting_confirm on).
   *  Kept `unknown` here — readers re-parse with WorkflowDefinitionSchema. */
  generatedDef: z.unknown().optional(),
})
export type DwState = z.infer<typeof DwStateSchema>

/** The launch-time initial dw state for a dynamic_workflow workgroup task. */
export function initialDwState(): DwState {
  return { phase: 'generating', generateAttempts: 0, rejectRounds: 0 }
}

/**
 * Parse the `dw` slot of a task's workgroup_config_json. Returns null when the
 * slot is missing or malformed — callers decide whether that is a hard error
 * (engine) or a fall-back-to-default (defensive dispatch).
 */
export function parseDwState(raw: unknown): DwState | null {
  const parsed = DwStateSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** Which engine drives a workgroup task (RFC-167 §3 three-way dispatch). */
export type WorkgroupDispatch = 'turn-engine' | 'dw-generate' | 'dw-execute'

/**
 * Single dispatch oracle for workgroup tasks: leader_worker / free_collab run
 * the round engine; a dynamic_workflow task runs the GENERATE engine until its
 * confirmed DAG is swapped in (phase 'executing'), after which the ordinary
 * runScope DAG engine executes the (now real) snapshot. `awaiting_confirm` /
 * `rejected` / a missing phase all route to dw-generate — the generate engine
 * re-parks or regenerates idempotently; only an explicit 'executing' unlocks
 * runScope (fail-closed toward the engine that cannot corrupt a worktree).
 */
export function deriveWorkgroupDispatch(
  mode: WorkgroupMode,
  dwPhase: DynamicWorkflowPhase | null | undefined,
): WorkgroupDispatch {
  if (mode !== 'dynamic_workflow') return 'turn-engine'
  return dwPhase === 'executing' ? 'dw-execute' : 'dw-generate'
}

/**
 * Extract the workgroup mode from a task's raw `workgroup_config_json`.
 * Returns null for a missing / unparsable config or an unknown mode — callers
 * treat that as "not a recognizable workgroup config" and fall back to their
 * conservative default. Pure, zod-validated, never throws.
 */
export function workgroupModeOf(configJson: string | null | undefined): WorkgroupMode | null {
  if (configJson == null) return null
  let raw: unknown
  try {
    raw = JSON.parse(configJson)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const mode = WorkgroupModeSchema.safeParse((raw as Record<string, unknown>).mode)
  return mode.success ? mode.data : null
}

/**
 * True when a task row belongs to a TURN-ENGINE workgroup (leader_worker /
 * free_collab) — the modes whose recovery is RFC-164 engine re-entry, not
 * generic resume/retry/repair (those guards refuse them). dynamic_workflow
 * tasks are runScope-backed state machines and ARE generically recoverable
 * (RFC-167: generating re-enters the generate pass idempotently,
 * awaiting_confirm re-parks, executing resumes the real DAG). A corrupt or
 * unknown config counts as turn-engine — fail-closed toward refusing generic
 * recovery.
 */
export function isTurnEngineWorkgroupTask(row: {
  workgroupId?: string | null
  workgroupConfigJson?: string | null
}): boolean {
  if (row.workgroupId == null || row.workgroupId === '') return false
  return workgroupModeOf(row.workgroupConfigJson ?? null) !== 'dynamic_workflow'
}

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
