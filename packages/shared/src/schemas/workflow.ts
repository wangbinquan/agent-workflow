// Workflow schemas. Mirrors design/design.md §5 + design/RFC-005-human-review/.
//
// M1 (P-1-11): permissive shape — minimum needed for CRUD round-trip.
// Strict topology / port-connection validation lands in P-2-01.
//
// RFC-005: $schema_version bumped from 1 to 2 to mark the addition of the
// 'review' node kind. v1 documents stay readable; the transparent v1→v2
// upgrade lives in the workflow GET path (see backend service.workflow).
//
// RFC-023: $schema_version bumped from 2 to 3 for the new 'clarify' node
// kind (agent-initiated clarification questions). v1 / v2 documents stay
// readable; both upgrade transparently — no clarify node ever appeared in
// older versions, so the upgrade is purely a metadata bump.

import { z } from 'zod'

/** Currently-written schema version. New writes always set this value. */
export const WORKFLOW_SCHEMA_VERSION = 3
/** Set of versions GET can return; v1/v2 are read-only and auto-upgraded on access. */
export const WORKFLOW_SCHEMA_VERSIONS = [1, 2, 3] as const

// --- enums shared across multiple shapes ---

export const NODE_KIND = [
  'agent-single',
  'agent-multi',
  'input',
  'output',
  'wrapper-git',
  'wrapper-loop',
  'review', // RFC-005: human-in-the-loop review gate
  'clarify', // RFC-023: agent-initiated clarification questions
] as const
export const NodeKindSchema = z.enum(NODE_KIND)
export type NodeKind = z.infer<typeof NodeKindSchema>

// RFC-020: 'upload' joins as a sibling of 'files'. `files` picks paths
// already inside the worktree; `upload` writes user-selected local files
// into the worktree at a per-input `targetDir`. Packed value is identical
// to `files` (newline-joined repo-relative paths), so downstream nodes
// (agent prompt templates, wrapper-git, multi-process) need zero changes.
export const WORKFLOW_INPUT_KIND = ['text', 'files', 'enum', 'git', 'upload'] as const
export const WorkflowInputKindSchema = z.enum(WORKFLOW_INPUT_KIND)

// --- pieces of a workflow definition (kept permissive in M1) ---

export const XYSchema = z.object({ x: z.number(), y: z.number() })

/**
 * Node base. Each `kind` carries its own additional fields per design.md §5.
 * M1 keeps it permissive via `passthrough()`; the strict discriminated union
 * is built out in P-2-01 alongside the workflow validator.
 */
export const WorkflowNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: NodeKindSchema,
    position: XYSchema.optional(),
  })
  .passthrough()
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>

export const PortRefSchema = z.object({
  nodeId: z.string().min(1),
  portName: z.string().min(1),
})

export const WorkflowEdgeSchema = z.object({
  id: z.string().min(1),
  source: PortRefSchema,
  target: PortRefSchema,
})
export type WorkflowEdge = z.infer<typeof WorkflowEdgeSchema>

/** Launcher form field declaration. Per-kind fields are loose in M1. */
export const WorkflowInputSchema = z
  .object({
    kind: WorkflowInputKindSchema,
    key: z.string().min(1),
    label: z.string().min(1),
    required: z.boolean().optional(),
    description: z.string().optional(),
  })
  .passthrough()
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>

/**
 * RFC-020: strict narrow schema applied to `kind: 'upload'` inputs at write
 * time (services/workflow.ts runs this against each upload entry in addition
 * to the permissive WorkflowInputSchema). Read paths stay permissive so old
 * docs round-trip; new writes must satisfy this.
 *
 * `targetDir` is a repo-relative directory under the task worktree where
 * uploaded files land. `accept` is a list of extension (`.pdf`) or MIME
 * (`image/*`) tokens; matching either passes (server still sniffs MIME via
 * file-type and does not trust client-declared mime).
 */
export const UploadInputSchema = WorkflowInputSchema.extend({
  kind: z.literal('upload'),
  targetDir: z
    .string()
    .min(1)
    .max(256)
    .refine((s) => !s.includes('..') && !s.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(s), {
      message: 'targetDir must be a repo-relative path without ".." or drive prefixes',
    }),
  accept: z.array(z.string().min(1)).optional(),
  maxFileSize: z.number().int().positive().optional(),
  minCount: z.number().int().min(0).optional(),
  maxCount: z.number().int().min(1).optional(),
})
export type UploadInput = z.infer<typeof UploadInputSchema>

export const WorkflowOutputBindingSchema = z.object({
  name: z.string().min(1),
  bind: PortRefSchema,
})
export type WorkflowOutputBinding = z.infer<typeof WorkflowOutputBindingSchema>

// --- the definition object stored as JSON in workflows.definition ---

export const WorkflowDefinitionSchema = z.object({
  /**
   * v1 (pre-RFC-005), v2 (RFC-005+), and v3 (RFC-023+) are all accepted on
   * read. New writes always set the latest version — the GET path transparently
   * upgrades older docs (see backend services/workflow.ts).
   */
  $schema_version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  inputs: z.array(WorkflowInputSchema).default([]),
  nodes: z.array(WorkflowNodeSchema).default([]),
  edges: z.array(WorkflowEdgeSchema).default([]),
  outputs: z.array(WorkflowOutputBindingSchema).optional(),
})
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>

// --- top-level resource (response shape) ---

export const WorkflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  definition: WorkflowDefinitionSchema,
  version: z.number().int(),
  schemaVersion: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type Workflow = z.infer<typeof WorkflowSchema>

// --- request payloads ---

export const CreateWorkflowSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().default(''),
  definition: WorkflowDefinitionSchema,
})
export type CreateWorkflow = z.infer<typeof CreateWorkflowSchema>

export const UpdateWorkflowSchema = z
  .object({
    name: z.string().min(1).max(256).optional(),
    description: z.string().optional(),
    definition: WorkflowDefinitionSchema.optional(),
  })
  .strict()
export type UpdateWorkflow = z.infer<typeof UpdateWorkflowSchema>

// --- /validate response (P-2-01 will fill in real checks) ---

export const WorkflowValidationIssueSchema = z.object({
  /** Stable kebab-case identifier; one per static-check rule. */
  code: z.string(),
  message: z.string(),
  /** Optional pointer into the definition (e.g. node id, edge id). */
  pointer: z.string().optional(),
  /**
   * Severity. Absence is treated as 'error' for backwards compatibility — only
   * issues that explicitly set 'warning' are non-blocking. `result.ok` is true
   * iff no issue carries 'error' severity.
   */
  severity: z.enum(['error', 'warning']).optional(),
})
export type WorkflowValidationIssue = z.infer<typeof WorkflowValidationIssueSchema>

export const WorkflowValidationResultSchema = z.object({
  ok: z.boolean(),
  issues: z.array(WorkflowValidationIssueSchema),
})
export type WorkflowValidationResult = z.infer<typeof WorkflowValidationResultSchema>

// --- RFC-023 Clarify node ----------------------------------------------------
//
// Leaf node, exactly 1 input port ('questions') + 1 output port ('answers'),
// both hard-coded — not user-configurable. The clarify node is wired to its
// asking agent by a reverse-drag interaction in the canvas: dragging from the
// clarify input handle onto an agent-{single,multi} node mints two edges, one
// each direction, using the agent's system-level `__clarify__` / `__clarify_response__`
// ports (those ports exist only in workflow.definition.edges; never in
// agent.outputs / DB).

/** Hard-coded port name on the clarify node. Do not rename without coordinating
 *  with packages/shared/src/clarify.ts + the canvas drag helper. */
export const CLARIFY_INPUT_PORT_NAME = 'questions' as const
export const CLARIFY_OUTPUT_PORT_NAME = 'answers' as const

/** Agent-side system ports synthesised by the reverse-drag interaction. */
export const CLARIFY_SOURCE_PORT_NAME = '__clarify__' as const
export const CLARIFY_RESPONSE_TARGET_PORT_NAME = '__clarify_response__' as const

/**
 * RFC-026: clarify session mode.
 *
 * - `isolated` (default, current RFC-023 behavior): every clarify-driven rerun
 *   spawns a fresh opencode process; the prompt carries the full Q&A history
 *   accumulated across prior rounds.
 * - `inline`: rerun spawns opencode with `--session <previous-session-id>` so
 *   opencode loads the full prior session (messages, thinking, tool calls).
 *   The prompt becomes a small incremental message (just this round's user
 *   answers + a short reminder). Tokens / latency drop on multi-round asks.
 *   Falls back to isolated automatically when the session id is unavailable
 *   or opencode rejects it.
 *
 * Stored as an optional string in workflow JSON; undefined is treated as
 * `'isolated'` everywhere via `resolveClarifySessionMode` in shared/clarify.ts.
 * Pure additive field — no schema_version bump.
 */
export const ClarifySessionModeSchema = z.enum(['isolated', 'inline'])
export type ClarifySessionMode = z.infer<typeof ClarifySessionModeSchema>

export const ClarifyNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('clarify'),
    position: XYSchema.optional(),
    /** Display title in the canvas / inspector. */
    title: z.string().default(''),
    /** Free-form description for canvas authors; not used at runtime. */
    description: z.string().default(''),
    /** Reserved for future per-user assignment; UI does not expose it in v1. */
    assignee: z.string().optional(),
    /**
     * RFC-026: opencode session reuse mode for clarify-driven reruns. See
     * `ClarifySessionModeSchema` for semantics. Optional; missing field is
     * resolved to `'isolated'` (preserves RFC-023 behavior byte-for-byte).
     */
    sessionMode: ClarifySessionModeSchema.optional(),
  })
  .passthrough()
export type ClarifyNode = z.infer<typeof ClarifyNodeSchema>
