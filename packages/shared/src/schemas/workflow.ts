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
//
// RFC-056: $schema_version bumped from 3 to 4 for the new 'clarify-cross-agent'
// node kind (downstream questioner agent reverse-feeds an upstream designer
// agent via human-gated submit/reject). v1 / v2 / v3 documents stay readable;
// the transparent v3 → v4 upgrade lives in the workflow GET path. Old docs
// never carry the new node kind, so the upgrade is a metadata bump.

import { z } from 'zod'
import { ImportRefSelectionSchema } from './importRef'
import { ResourceVisibilitySchema } from './resourceAcl'
import { WORKGROUP_NAME_RE } from './workgroup'

/** Currently-written schema version. New writes always set this value. */
export const WORKFLOW_SCHEMA_VERSION = 4
/** Set of versions GET can return; v1/v2/v3 are read-only and auto-upgraded on access. */
export const WORKFLOW_SCHEMA_VERSIONS = [1, 2, 3, 4] as const

// --- enums shared across multiple shapes ---

export const NODE_KIND = [
  'agent-single',
  'input',
  'output',
  'wrapper-git',
  'wrapper-loop',
  'wrapper-fanout', // RFC-060: fan-out wrapper with arbitrary inner subgraph + list<T> shardSource
  'review', // RFC-005: human-in-the-loop review gate
  'clarify', // RFC-023: agent-initiated clarification questions
  'clarify-cross-agent', // RFC-056: downstream questioner reverse-feeds upstream designer via human gate
] as const
// RFC-060 PR-E: 'agent-multi' was the M3 fan-out kind; superseded by
// wrapper-fanout (RFC-060). Its node_runs / row shape are no longer minted by
// any code path. Historical fixtures containing the kind fail validator with
// `unknown-node-kind`.
export const NodeKindSchema = z.enum(NODE_KIND)
export type NodeKind = z.infer<typeof NodeKindSchema>

// flag-audit W0 (§4.2) — the container ("wrapper") kind set, SINGLE SOURCE.
// This membership was previously hand-copied as or-chains / private Sets in
// ~20 sites across all three packages; the RFC-060 fanout rollout missed one
// of them (canvas coordProjection) and shipped a wrapper-sizing bug — exactly
// the drift this constant exists to prevent. New wrapper kinds join NODE_KIND
// and this list together; every "is this node a container?" check must go
// through `isWrapperKind` / `WRAPPER_NODE_KINDS` instead of enumerating kinds.
export const WRAPPER_NODE_KINDS = [
  'wrapper-git',
  'wrapper-loop',
  'wrapper-fanout',
] as const satisfies readonly NodeKind[]

/** Accepts plain strings too (xyflow `node.type` is `string | undefined`). */
export function isWrapperKind(kind: NodeKind | string | null | undefined): boolean {
  return (WRAPPER_NODE_KINDS as readonly string[]).includes(kind ?? '')
}

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
 * RFC-223 (PR-3a, R4-1) — the sentinel `agentId` migration 0113 stamps onto an
 * agent-single node (or a frozen workgroup config member) whose historical
 * identity CANNOT be safely recovered: an old task snapshot froze the agent by
 * NAME only, and global uniqueness proves only the CURRENT single candidate, not
 * that the name was never rename+recreate (ABA) reassigned since launch. Rather
 * than guess by the current name (which could bind a DIFFERENT tenant's agent),
 * the migration quarantines the reference with this value. It never resolves to
 * a row (`getAgentById` returns null), so resume/retry fails closed with
 * agent-not-found instead of silently re-binding. `agentName` is preserved
 * beside it for display/audit. Underscores make it un-representable as a ULID
 * (Crockford base32), so it can never collide with a real agent id.
 */
export const QUARANTINED_SNAPSHOT_AGENT_ID = '__rfc223_snapshot_quarantined__'

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
    /**
     * Optional user-visible display name shown on the canvas card and used
     * by `nodeTitle()` ahead of any kind-specific derivation (agentName /
     * inputKey / etc). Free-form, no uniqueness constraint — the node's
     * `id` remains the stable identifier referenced by edges / port refs.
     * `review` and `clarify` nodes' existing `title` field reuses the same
     * key, so old definitions roundtrip unchanged.
     */
    title: z.string().optional(),
    /**
     * RFC-223 (PR-2) — the CANONICAL agent reference for an `agent-single`
     * node: a stable agent `id` (ULID) that survives a rename (D4/D7). The
     * legacy `agentName` field (carried via `.passthrough()`) is retained for
     * DISPLAY and back-compat; runtime dispatch resolves by `agentId` first,
     * falling back to `agentName` only for definitions not yet migrated /
     * dynamically generated (name↔id stays 1:1 until PR-8, so the fallback is
     * deterministic). Absent for non-agent kinds. The frontend stamps this
     * alongside `agentName` when an agent is picked; migration 0112 backfills
     * it into stored definitions; YAML export strips it (portable name form).
     */
    agentId: z.string().min(1).optional(),
  })
  .passthrough()
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>

export const PortRefSchema = z.object({
  nodeId: z.string().min(1),
  portName: z.string().min(1),
})

/**
 * RFC-060: when an edge crosses the boundary between a wrapper-fanout
 * and its inner subgraph, the `boundary` field marks which side of the
 * crossing it represents:
 *
 *   - `'wrapper-input'`: edge.source = (wrapperId, wrapperInputPortName),
 *     edge.target = (innerNodeId, innerInputPortName). The wrapper input
 *     value flows into the inner node. For the shardSource port the
 *     scheduler injects ONE list item per shard; for broadcast inputs
 *     it injects the raw value into every shard's instance of the inner
 *     node.
 *   - `'wrapper-output'`: edge.source = (innerNodeId, innerOutputPortName),
 *     edge.target = (wrapperId, wrapperOutputPortName). The inner node's
 *     output is promoted to a wrapper outlet — only the aggregator agent
 *     may be the source (validator enforces).
 *
 * Edges without `boundary` are ordinary inner-to-inner or outer-to-outer
 * connections.
 */
export const EdgeBoundarySchema = z.enum(['wrapper-input', 'wrapper-output'])
export type EdgeBoundary = z.infer<typeof EdgeBoundarySchema>

export const WorkflowEdgeSchema = z.object({
  id: z.string().min(1),
  source: PortRefSchema,
  target: PortRefSchema,
  /** RFC-060 — wrapper boundary marker; absent for ordinary edges. */
  boundary: EdgeBoundarySchema.optional(),
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
  $schema_version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  inputs: z.array(WorkflowInputSchema).default([]),
  nodes: z.array(WorkflowNodeSchema).default([]),
  edges: z.array(WorkflowEdgeSchema).default([]),
  outputs: z.array(WorkflowOutputBindingSchema).optional(),
})
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>

/**
 * RFC-223 portable workflow-YAML shape.
 *
 * Persisted workflow nodes reference agents by canonical `agentId`. YAML must
 * not serialize that installation-local id, so agent nodes instead carry a
 * name selector plus an optional portable owner username. The owner hint keeps
 * an export deterministic when two visible tenants use the same agent name;
 * older name-only YAML remains an intentionally ambiguous selector and is
 * resolved by the import preview/mapping flow.
 */
export const WorkflowSelectorNodeSchema = WorkflowNodeSchema.extend({
  agentId: z.never().optional(),
  agentName: z.string().min(1).max(128).optional(),
  agentOwnerUsername: z.string().min(1).max(64).optional(),
}).superRefine((node, ctx) => {
  if (node.kind === 'agent-single' && node.agentName === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['agentName'],
      message: 'portable agent nodes require an agentName selector',
    })
  }
  if (node.kind !== 'agent-single' && node.agentOwnerUsername !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['agentOwnerUsername'],
      message: 'agentOwnerUsername is only valid on agent-single nodes',
    })
  }
})
export type WorkflowSelectorNode = z.infer<typeof WorkflowSelectorNodeSchema>

export const WorkflowDefinitionSelectorSchema = WorkflowDefinitionSchema.extend({
  nodes: z.array(WorkflowSelectorNodeSchema).default([]),
})
export type WorkflowDefinitionSelector = z.infer<typeof WorkflowDefinitionSelectorSchema>

// --- top-level resource (response shape) ---

export const WorkflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** RFC-099 ACL — owner (users.id or '__system__'); null until first owner write. */
  ownerUserId: z.string().nullable().optional(),
  /** RFC-099 ACL — 'public' = every user; 'private' = owner + grants. Absent ⇒ 'public'. */
  visibility: ResourceVisibilitySchema.optional(),
  /** RFC-104 — read-only built-in marker (response-only; see AgentSchema). */
  builtin: z.boolean().optional(),
  definition: WorkflowDefinitionSchema,
  version: z.number().int(),
  schemaVersion: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type Workflow = z.infer<typeof WorkflowSchema>

// --- request payloads ---

/** RFC-199: canonical 128-bit ULID used to correlate one submitted intent. */
export const WorkflowMutationIdSchema = z
  .string()
  .length(26)
  .regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/)
export type WorkflowMutationId = z.infer<typeof WorkflowMutationIdSchema>

/** Lowercase SHA-256 of the domain-separated editable snapshot serialization. */
export const WorkflowSnapshotHashSchema = z.string().regex(/^[0-9a-f]{64}$/)
export type WorkflowSnapshotHash = z.infer<typeof WorkflowSnapshotHashSchema>

/** The complete user-editable unit. Saves never accept partial patches. */
export const WorkflowDraftSnapshotSchema = z
  .object({
    // Preserve grandfathered names during autosave. A changed/new name is
    // still gated by WorkflowNameSchema in the service layer.
    name: z.string().min(1).max(256),
    description: z.string(),
    definition: WorkflowDefinitionSchema,
  })
  .strict()
export type WorkflowDraftSnapshot = z.infer<typeof WorkflowDraftSnapshotSchema>

/** Server-owned identity of one exact persisted workflow revision. */
export const WorkflowRevisionSchema = z
  .object({
    workflowId: z.string().min(1),
    version: z.number().int().positive(),
    snapshotHash: WorkflowSnapshotHashSchema,
    updatedAt: z.number().int(),
  })
  .strict()
export type WorkflowRevision = z.infer<typeof WorkflowRevisionSchema>

/** Detail/create response. List rows deliberately remain plain Workflow. */
export const WorkflowDetailSchema = WorkflowSchema.extend({
  snapshotHash: WorkflowSnapshotHashSchema,
})
export type WorkflowDetail = z.infer<typeof WorkflowDetailSchema>

/**
 * 2026-07-10 naming unification: workflow names follow the SAME rules as
 * workgroup names (slug charset, ≤128) — one regex, aliased so the two can
 * never drift. Unlike workgroups the name is still NOT the identity (the ULID
 * id is; duplicates stay legal and systemResources' builtin discrimination
 * relies on that), so the rules only apply where a NEW name enters the
 * system: create, an actual rename, and YAML import. Stored legacy free-form
 * names are grandfathered — UpdateWorkflowSchema stays permissive and the
 * route/service layers validate only CHANGED names against WorkflowNameSchema.
 */
export const WORKFLOW_NAME_RE = WORKGROUP_NAME_RE
export const WorkflowNameSchema = z
  .string()
  .min(1, 'name is required')
  .max(128, 'name too long')
  .regex(WORKFLOW_NAME_RE, 'name must start with [a-z0-9] and contain only [a-z0-9_-]')

export const CreateWorkflowSchema = z.object({
  name: WorkflowNameSchema,
  description: z.string().default(''),
  definition: WorkflowDefinitionSchema,
})
export type CreateWorkflow = z.infer<typeof CreateWorkflowSchema>

export const UpdateWorkflowSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    clientMutationId: WorkflowMutationIdSchema,
    snapshot: WorkflowDraftSnapshotSchema,
  })
  .strict()
export type UpdateWorkflow = z.infer<typeof UpdateWorkflowSchema>

export const SaveWorkflowReceiptSchema = z
  .object({
    clientMutationId: WorkflowMutationIdSchema,
    requestedBaseVersion: z.number().int().positive(),
    revision: WorkflowRevisionSchema,
    snapshot: WorkflowDraftSnapshotSchema,
    outcome: z.enum(['committed', 'already-current']),
  })
  .strict()
export type SaveWorkflowReceipt = z.infer<typeof SaveWorkflowReceiptSchema>

export const DeleteWorkflowSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    clientMutationId: WorkflowMutationIdSchema,
    // RFC-222 (D5, N-1): type-to-confirm rides the existing OCC schema. Kept
    // OPTIONAL here so the route's assertDeleteConfirm owns BOTH the presence
    // check (→ delete-confirm-required) and the match check (→
    // delete-confirm-mismatch) — the same unified error codes the other six
    // DELETE endpoints emit. The HTTP contract still requires it (a body
    // without confirm is rejected at the route); only direct service callers,
    // which never consume confirm, are spared the field.
    confirm: z.string().optional(),
  })
  .strict()
export type DeleteWorkflow = z.infer<typeof DeleteWorkflowSchema>

const ImportWorkflowOverwriteSchema = z
  .object({
    workflowId: z.string().min(1),
    expectedVersion: z.number().int().positive(),
    clientMutationId: WorkflowMutationIdSchema,
  })
  .strict()

const ImportWorkflowMappingsSchema = z.array(ImportRefSelectionSchema).max(256).optional()

/** RFC-199 structured YAML import request; overwrite is always revision-fenced. */
export const ImportWorkflowRequestSchema = z.discriminatedUnion('mode', [
  z
    .object({
      yamlText: z.string(),
      mode: z.literal('fail'),
      selections: ImportWorkflowMappingsSchema,
    })
    .strict(),
  z
    .object({
      yamlText: z.string(),
      mode: z.literal('new'),
      selections: ImportWorkflowMappingsSchema,
    })
    .strict(),
  z
    .object({
      yamlText: z.string(),
      mode: z.literal('overwrite'),
      overwrite: ImportWorkflowOverwriteSchema,
      selections: ImportWorkflowMappingsSchema,
    })
    .strict(),
])
export type ImportWorkflowRequest = z.infer<typeof ImportWorkflowRequestSchema>

export const ImportWorkflowResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('created'), workflow: WorkflowDetailSchema }).strict(),
  z.object({ outcome: z.literal('overwritten'), receipt: SaveWorkflowReceiptSchema }).strict(),
])
export type ImportWorkflowResult = z.infer<typeof ImportWorkflowResultSchema>

// --- /validate response (P-2-01 will fill in real checks) ---

/**
 * Stable semantic rows the frontend inspector can focus. These are not DOM
 * ids: adding a focusable validator field requires extending this shared list
 * and the frontend resolver together.
 */
export const WORKFLOW_NODE_FIELD_KEYS = [
  'title',
  'agent',
  'prompt',
  'input-definition',
  'output-binding',
  'review-source',
  'review-rerunnable-on-reject',
  'review-rerunnable-on-iterate',
  'loop-max-iterations',
  'loop-exit-condition',
  'loop-output-bindings',
  'fanout-inputs',
  'clarify-session-mode',
  'cross-clarify-session-mode',
] as const
export const WorkflowNodeFieldKeySchema = z.enum(WORKFLOW_NODE_FIELD_KEYS)
export type WorkflowNodeFieldKey = z.infer<typeof WorkflowNodeFieldKeySchema>

export const WorkflowValidationTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('node'), nodeId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('node-field'),
      nodeId: z.string().min(1),
      field: WorkflowNodeFieldKeySchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('node-port'),
      nodeId: z.string().min(1),
      direction: z.enum(['input', 'output']),
      portName: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal('edge'), edgeId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('workflow-input'), inputKey: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('workflow-output'), outputName: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('workflow') }).strict(),
])
export type WorkflowValidationTarget = z.infer<typeof WorkflowValidationTargetSchema>

export const WorkflowValidationIssueSchema = z.object({
  /** Stable kebab-case identifier; one per static-check rule. */
  code: z.string(),
  message: z.string(),
  /** Optional pointer into the definition (e.g. node id, edge id). */
  pointer: z.string().optional(),
  /** Strict semantic location; pointer remains for backward compatibility. */
  target: WorkflowValidationTargetSchema.optional(),
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

/**
 * RFC-199 B3: every operation that consumes persisted workflow bytes carries
 * both members of the revision fingerprint. Version alone is insufficient for
 * defensive response-loss reconciliation, while a hash without a version
 * cannot establish the requested point in the workflow history.
 */
export const WorkflowExactRevisionSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    expectedSnapshotHash: WorkflowSnapshotHashSchema,
  })
  .strict()
export type WorkflowExactRevision = z.infer<typeof WorkflowExactRevisionSchema>

export const WorkflowValidationRequestSchema = WorkflowExactRevisionSchema
export type WorkflowValidationRequest = z.infer<typeof WorkflowValidationRequestSchema>

/** Lowercase SHA-256 of the domain-separated validation-context projection. */
export const WorkflowValidationContextHashSchema = z.string().regex(/^[0-9a-f]{64}$/)
export type WorkflowValidationContextHash = z.infer<typeof WorkflowValidationContextHashSchema>

/** Lowercase SHA-256 of one domain-separated canonical draft definition. */
export const WorkflowCandidateHashSchema = z.string().regex(/^[0-9a-f]{64}$/)
export type WorkflowCandidateHash = z.infer<typeof WorkflowCandidateHashSchema>

/**
 * RFC-199 T11: validate an in-memory starter candidate without creating or
 * updating a workflow row. The server always recomputes the hash; the claim is
 * only a fence against validating bytes different from the client preview.
 */
export const WorkflowDraftValidationRequestSchema = z
  .object({
    definition: WorkflowDefinitionSchema,
    claimedCandidateHash: WorkflowCandidateHashSchema,
  })
  .strict()
export type WorkflowDraftValidationRequest = z.infer<typeof WorkflowDraftValidationRequestSchema>

export const WorkflowDraftValidationReceiptSchema = z
  .object({
    candidateHash: WorkflowCandidateHashSchema,
    validationContextHash: WorkflowValidationContextHashSchema,
    validatedAt: z.number().int().nonnegative(),
    ok: z.boolean(),
    issues: z.array(WorkflowValidationIssueSchema),
  })
  .strict()
export type WorkflowDraftValidationReceipt = z.infer<typeof WorkflowDraftValidationReceiptSchema>

/** Exact validation receipt bound to one workflow revision and one inventory. */
export const WorkflowValidationReceiptSchema = z
  .object({
    revision: WorkflowRevisionSchema,
    validationContextHash: WorkflowValidationContextHashSchema,
    validatedAt: z.number().int().nonnegative(),
    ok: z.boolean(),
    issues: z.array(WorkflowValidationIssueSchema),
  })
  .strict()
export type WorkflowValidationReceipt = z.infer<typeof WorkflowValidationReceiptSchema>

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
    /**
     * RFC-165 (F12): 'optional' relaxes the clarify channel from "must ask
     * first" to a dual-envelope directive — the agent may EITHER emit
     * clarify questions OR finish directly with its normal output; every
     * rerun of the same node (initial / retry / post-answer) stays optional.
     * `undefined` keeps the pre-RFC-165 mandatory/suppressed semantics
     * byte-for-byte (additive-field precedent: sessionMode above).
     */
    clarifyMode: z.enum(['optional']).optional(),
  })
  .passthrough()
export type ClarifyNode = z.infer<typeof ClarifyNodeSchema>

// --- RFC-056 Cross-Agent Clarify node ---------------------------------------
//
// Leaf node, 1 input port ('questions') + 2 output ports ('to_designer'
// manual / 'to_questioner' auto). Wired by reverse-drag from the input
// handle onto a downstream agent-single questioner (auto-mints two edges
// using the questioner's `__clarify__` + `__clarify_response__` system
// ports — same mechanism as RFC-023). The third edge — newNode.to_designer
// → designer.__external_feedback__ — is wired MANUALLY by the user to an
// agent-single ancestor (the designer agent). The designer's
// `__external_feedback__` is a system-injected target port (only visible on
// the canvas while ≥1 cross-clarify manual-edge points to it; never in
// agent.outputs / DB).

/** Hard-coded port names on the cross-clarify node. Do not rename without
 *  coordinating with packages/shared/src/clarify-cross.ts + the canvas drag
 *  helper. */
export const CROSS_CLARIFY_INPUT_PORT_NAME = 'questions' as const
export const CROSS_CLARIFY_OUT_TO_DESIGNER_PORT = 'to_designer' as const
export const CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT = 'to_questioner' as const

/** Agent-side system port synthesised when a cross-clarify manual-edge lands
 *  on a designer agent. Mirrors the RFC-023 `__clarify_response__` pattern:
 *  the port exists only in workflow.definition.edges, never in agent.outputs
 *  / DB. The validator adds it to the agent's inbound port set so edges
 *  validate cleanly. */
export const CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT = '__external_feedback__' as const

/**
 * RFC-056: opencode session reuse mode for the QUESTIONER rerun (reject +
 * cascade). RFC-026 semantics: isolated = fresh process every rerun; inline =
 * `--session <id>`. Missing field resolves to `'isolated'` via the helper in
 * shared/clarify-cross.ts (`resolveCrossClarifySessionMode`).
 *
 * The designer-rerun session-mode field was removed by RFC-056 patch
 * 2026-06-22: the designer rerun never resumed a session (always isolated), so
 * `sessionModeForDesigner` was dead config. A stored workflow that still
 * carries it parses fine via `.passthrough()` (back-compat locked by the v4
 * fixture in compat-workflow-schema.test.ts).
 */
export const ClarifyCrossAgentSessionModeSchema = z.enum(['isolated', 'inline'])
export type ClarifyCrossAgentSessionMode = z.infer<typeof ClarifyCrossAgentSessionModeSchema>

export const ClarifyCrossAgentNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('clarify-cross-agent'),
    position: XYSchema.optional(),
    /** Display title in the canvas / inspector. */
    title: z.string().default(''),
    /** Free-form description for canvas authors; not used at runtime. */
    description: z.string().default(''),
    /** Reserved for future per-user assignment; UI does not expose it in v1. */
    assignee: z.string().optional(),
    /**
     * RFC-056 + RFC-026: opencode session reuse mode for the QUESTIONER agent's
     * rerun triggered when the human rejects (or when cascade reset re-dispatches
     * a persistent-stop questioner). Optional; missing field resolves to
     * `'isolated'`.
     */
    sessionModeForQuestioner: ClarifyCrossAgentSessionModeSchema.optional(),
  })
  .passthrough()
export type ClarifyCrossAgentNode = z.infer<typeof ClarifyCrossAgentNodeSchema>

// --- RFC-060 Wrapper-Fanout node --------------------------------------------
//
// Container wrapper that fan-outs an inner subgraph across the items of a
// `list<T>` shardSource port. The wrapper holds:
//
//   - `inputs[]`: declared input ports. EXACTLY ONE input must have
//     `isShardSource: true`; its kind MUST be `list<T>` for some T. Other
//     inputs are broadcast (same value passed to every shard's inner
//     subgraph).
//   - `nodeIds[]`: inner subgraph node ids (same convention as
//     wrapper-git / wrapper-loop). Per RFC-060 design §1.1, inner is
//     stored flat in the top-level `nodes[]` / `edges[]` arrays; the
//     wrapper just references them.
//
// `outputs` is NOT a schema field — runtime derives wrapper outputs from
// the inner subgraph's aggregator agent (RFC-060 design §5.4 via
// `deriveWrapperFanoutOutputs`). When there's no aggregator the wrapper
// gets a single implicit `__done__` (kind: signal) outlet.
//
// Boundary edges connecting wrapper ports to inner nodes carry the
// `boundary: 'wrapper-input' | 'wrapper-output'` flag on the edge
// (see WorkflowEdgeSchema).
//
// PR-C ships this schema + validator rules; the scheduler dispatch path
// lands in PR-D.
export const WrapperFanoutPortSchema = z.object({
  name: z.string().min(1),
  /**
   * AgentOutputKind grammar string (base / path<ext> / list<...>). The
   * validator additionally requires that exactly one port is marked
   * `isShardSource: true` and that its kind parses as `list<T>`.
   */
  kind: z.string().min(1),
  /**
   * Mark the shard source port. Exactly one input MUST set this to true;
   * the validator emits `wrapper-fanout-shard-source-missing` /
   * `-duplicate` otherwise.
   */
  isShardSource: z.boolean().optional(),
})
export type WrapperFanoutPort = z.infer<typeof WrapperFanoutPortSchema>

export const WrapperFanoutNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('wrapper-fanout'),
    position: XYSchema.optional(),
    title: z.string().optional(),
    /** Inner subgraph node ids — must all exist in workflow.definition.nodes. */
    nodeIds: z.array(z.string().min(1)).default([]),
    /** Declared input ports. validator enforces ≥1 with isShardSource: true. */
    inputs: z.array(WrapperFanoutPortSchema).default([]),
    /**
     * Optional author-supplied hint for the runtime cartesian guard. When
     * a wrapper-fanout is nested inside another one, the outer scheduler
     * can't yet know the inner's shard count (depends on a port value
     * produced at run time); the author can pre-declare a conservative
     * upper bound here for static estimation. Falls back to a default
     * estimate in `services/fanout.ts` (PR-D).
     */
    expectedShardCount: z.number().int().positive().max(10_000).optional(),
  })
  .passthrough()
export type WrapperFanoutNode = z.infer<typeof WrapperFanoutNodeSchema>
