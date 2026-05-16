// Review feature schemas. Mirrors design/RFC-005-human-review/design.md.
//
// The review node is a leaf node kind ('review') in workflow.NODE_KIND.
// Its strict per-kind shape lives here rather than in workflow.ts so that
// runtime review-specific resource shapes (DocVersion, ReviewComment,
// decision payloads, agent output kinds) stay co-located.
//
// PR-A T1 (RFC-005). Backend services and routes land in PR-B; the schemas
// here only describe transport / persistence shapes the rest of the stack
// will consume.

import { z } from 'zod'
import { PortRefSchema } from './workflow'

// -----------------------------------------------------------------------------
// AgentOutputKind — the per-port output "shape" hint declared on the agent.
//
// Carried as a sidecar map `agent.outputKinds: Record<portName, kind>` (see
// agent.ts). Absent / 'string' means the port content is an opaque string
// (legacy behavior). 'markdown' means the content is markdown body text.
// 'markdown_file' means the content is a worktree-relative path that the
// framework reads from disk before passing downstream.
//
// Only ports declared `kind ∈ {markdown, markdown_file}` may be the input
// source of a review node (enforced by workflow.validator.ts in T3).
// -----------------------------------------------------------------------------
export const AGENT_OUTPUT_KIND = ['string', 'markdown', 'markdown_file'] as const
export const AgentOutputKindSchema = z.enum(AGENT_OUTPUT_KIND)
export type AgentOutputKind = z.infer<typeof AgentOutputKindSchema>

// -----------------------------------------------------------------------------
// Review node — the workflow-side strict shape.
//
// The base WorkflowNodeSchema in workflow.ts stays permissive (passthrough);
// this schema is what the validator checks against and what the editor's
// NodeInspector consumes for the review branch.
// -----------------------------------------------------------------------------
export const ReviewNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('review'),
    position: z.object({ x: z.number(), y: z.number() }).optional(),

    /**
     * The upstream (nodeId, portName) being reviewed. RFC-007: the canvas
     * exposes a single named target Handle (`__review_input__`) so the user
     * can wire this by drag; the connect / disconnect / form-edit paths all
     * keep `inputSource` and the matching `definition.edges[]` entry in
     * lock-step. The runtime still reads from this field (scheduler /
     * dispatchReviewNode) — it's what tells the engine which port to
     * snapshot into doc_versions and which port is the iterate-merge target.
     */
    inputSource: PortRefSchema,

    /** Human-facing label / description (shown in Reviews list + detail). */
    title: z.string().default(''),
    description: z.string().default(''),

    /**
     * On reject: which upstream nodes get rolled back & re-run. Default set by
     * the editor at creation time = [direct upstream] + all its reachable
     * upstreams. Subset-of-reachable-upstreams validated in T3.
     */
    rerunnableOnReject: z.array(z.string()).default([]),
    /**
     * On iterate: which upstream nodes get re-run. Default = [direct upstream]
     * only. Same subset constraint.
     */
    rerunnableOnIterate: z.array(z.string()).default([]),

    /** Default true — reject rolls upstream pre_snapshot back via worktree stash. */
    rollbackFilesOnReject: z.boolean().default(true),
    /** Default false — iterate is "tweak based on comments"; leave files alone. */
    rollbackFilesOnIterate: z.boolean().default(false),

    /**
     * Optional override of how `{{__review_comments__}}` is rendered into the
     * regen prompt. Empty / absent → framework default (markdown bulleted list
     * with section breadcrumb + selected text + ctx + comment). Advanced users
     * can swap in their own template; tokens are resolved with the same
     * skipOnVariables semantics as the rest of prompt.ts.
     */
    commentInjectTemplate: z.string().optional(),

    /** v1 single-user platform; schema slot reserved, UI does not surface. */
    assignee: z.string().optional(),
  })
  .passthrough()
export type ReviewNode = z.infer<typeof ReviewNodeSchema>

// -----------------------------------------------------------------------------
// Review decision — what the user clicks in the review UI.
// -----------------------------------------------------------------------------
export const REVIEW_DECISION_KIND = ['approved', 'rejected', 'iterated'] as const
export const ReviewDecisionKindSchema = z.enum(REVIEW_DECISION_KIND)
export type ReviewDecisionKind = z.infer<typeof ReviewDecisionKindSchema>

// -----------------------------------------------------------------------------
// Doc version — one snapshot per (review node run, version_index).
//
// versionIndex is 1-based: v1 is the first generation, v2 follows the first
// reject/iterate decision, etc. The body itself lives at `bodyPath` relative
// to `~/.agent-workflow/`; commentsJson captures the review_comments array
// at the moment the decision was made (so diff view can show "last round's
// comments" without join chains).
// -----------------------------------------------------------------------------
export const DOC_VERSION_DECISION = ['pending', 'approved', 'rejected', 'iterated'] as const
export const DocVersionDecisionSchema = z.enum(DOC_VERSION_DECISION)
export type DocVersionDecision = z.infer<typeof DocVersionDecisionSchema>

export const DocVersionSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  reviewNodeId: z.string(),
  reviewNodeRunId: z.string(),
  sourceNodeId: z.string(),
  sourcePortName: z.string(),
  versionIndex: z.number().int().positive(),
  reviewIteration: z.number().int().nonnegative(),
  /** Path relative to app home, e.g. `runs/{taskId}/review/{nodeId}/{port}/v1.md`. */
  bodyPath: z.string(),
  /** JSON-string of ReviewComment[] captured at the decision boundary. */
  commentsJson: z.string(),
  decision: DocVersionDecisionSchema,
  /** Reject reason or iterate summary; nullable for pending versions. */
  decisionReason: z.string().nullable(),
  /** The prompt actually sent when this version was generated; nullable for v1 if not yet captured. */
  promptSnapshot: z.string().nullable(),
  /** JSON: {model, variant, temperature} at generation time. */
  agentSnapshot: z.string().nullable(),
  /**
   * Worktree-relative file path captured when this version was generated, if
   * the upstream port resolved as a `markdown_file` (or the forgiveness path
   * silently read a `.md` file). NULL when the source was inline markdown.
   * Surfaced in the iterate re-run prompt so the agent knows which file the
   * comments target.
   */
  sourceFilePath: z.string().nullable().optional(),
  createdAt: z.number().int(),
  decidedAt: z.number().int().nullable(),
  decidedBy: z.string().nullable(),
})
export type DocVersion = z.infer<typeof DocVersionSchema>

// -----------------------------------------------------------------------------
// Review comment — attached to a specific doc_version.
//
// The composite anchor lets the regen prompt unambiguously cite the exact
// selection even when the same text appears multiple times in the doc:
//   sectionPath  – breadcrumb of headings: "## Interfaces > ### POST endpoints"
//   paragraphIdx – 0-based paragraph index inside the deepest heading
//   offsetStart  – char offset within that paragraph's source markdown
//   offsetEnd    – exclusive end offset
//   selectedText – the literal selection
//   contextBefore / contextAfter – ~30 chars of source markdown around
//   occurrenceIndex – 1-based "which occurrence of selectedText in the whole doc"
//
// The frontend computes all of these; the backend recomputes occurrenceIndex
// on write (to defeat client-side forgery) per RFC-005-T10.
// -----------------------------------------------------------------------------
export const ReviewCommentAnchorSchema = z.object({
  sectionPath: z.string(),
  paragraphIdx: z.number().int().nonnegative(),
  offsetStart: z.number().int().nonnegative(),
  offsetEnd: z.number().int().nonnegative(),
  selectedText: z.string().min(1),
  contextBefore: z.string(),
  contextAfter: z.string(),
  occurrenceIndex: z.number().int().positive(),
})
export type ReviewCommentAnchor = z.infer<typeof ReviewCommentAnchorSchema>

export const ReviewCommentSchema = z.object({
  id: z.string(),
  docVersionId: z.string(),
  anchor: ReviewCommentAnchorSchema,
  commentText: z.string().min(1),
  author: z.string(),
  createdAt: z.number().int(),
})
export type ReviewComment = z.infer<typeof ReviewCommentSchema>

// -----------------------------------------------------------------------------
// Request / response shapes for /api/reviews/* (implemented in PR-B T11).
// Schemas live here so frontend can statically type the API client.
// -----------------------------------------------------------------------------

/** POST /api/reviews/:nodeRunId/decision — approve / reject / iterate. */
export const SubmitReviewDecisionSchema = z
  .object({
    decision: ReviewDecisionKindSchema,
    /** Required for reject; ignored for approve/iterate. */
    rejectReason: z.string().optional(),
    /**
     * Optimistic-locking guard: client passes the review_iteration it saw
     * when rendering the page; backend rejects with 409 if mismatched.
     */
    reviewIteration: z.number().int().nonnegative(),
  })
  .refine(
    (d) =>
      d.decision !== 'rejected' ||
      (d.rejectReason !== undefined && d.rejectReason.trim().length > 0),
    { message: 'rejectReason is required when decision = rejected', path: ['rejectReason'] },
  )
export type SubmitReviewDecision = z.infer<typeof SubmitReviewDecisionSchema>

/** POST /api/reviews/:nodeRunId/comments. */
export const SubmitReviewCommentSchema = z.object({
  /** Client-computed anchor; backend recomputes occurrenceIndex from canonical doc. */
  anchor: ReviewCommentAnchorSchema,
  commentText: z.string().min(1),
})
export type SubmitReviewComment = z.infer<typeof SubmitReviewCommentSchema>

/** PATCH /api/reviews/:nodeRunId/comments/:commentId — RFC-009. */
export const UpdateReviewCommentBodySchema = z.object({
  commentText: z.string().min(1),
})
export type UpdateReviewCommentBody = z.infer<typeof UpdateReviewCommentBodySchema>

/** GET /api/reviews — list filter. */
export const REVIEW_LIST_STATUS = ['pending', 'all', 'approved', 'rejected', 'iterated'] as const
export const ListReviewsQuerySchema = z.object({
  status: z.enum(REVIEW_LIST_STATUS).default('pending'),
  taskId: z.string().optional(),
  workflowId: z.string().optional(),
  limit: z.number().int().positive().max(500).default(100),
})
export type ListReviewsQuery = z.infer<typeof ListReviewsQuerySchema>

/** Single entry in GET /api/reviews list response. */
export const ReviewSummarySchema = z.object({
  nodeRunId: z.string(),
  taskId: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  reviewNodeId: z.string(),
  title: z.string(),
  description: z.string(),
  currentVersionIndex: z.number().int().positive(),
  reviewIteration: z.number().int().nonnegative(),
  decision: DocVersionDecisionSchema,
  awaitingReview: z.boolean(),
  shardKey: z.string().nullable(),
  createdAt: z.number().int(),
  decidedAt: z.number().int().nullable(),
})
export type ReviewSummary = z.infer<typeof ReviewSummarySchema>

/** GET /api/reviews/:nodeRunId — full detail used by the review page. */
export const ReviewDetailSchema = z.object({
  summary: ReviewSummarySchema,
  currentVersion: DocVersionSchema,
  currentBody: z.string(),
  comments: z.array(ReviewCommentSchema),
  /** Lightweight rerun candidate list for the readonly "will rerun" modal. */
  rerunnableOnReject: z.array(z.string()),
  rerunnableOnIterate: z.array(z.string()),
})
export type ReviewDetail = z.infer<typeof ReviewDetailSchema>

/** GET /api/reviews/pending-count — global badge in left nav. */
export const ReviewPendingCountSchema = z.object({
  count: z.number().int().nonnegative(),
})
export type ReviewPendingCount = z.infer<typeof ReviewPendingCountSchema>

// -----------------------------------------------------------------------------
// RFC-013: historical-version detail endpoint payload.
//
// `GET /api/reviews/:nodeRunId/versions/:versionId` returns the doc_version
// fields + the markdown body + the review_comments captured against that
// specific version. Used by the read-only historical view in the reviews UI.
// -----------------------------------------------------------------------------
export const DocVersionWithBodyAndCommentsSchema = DocVersionSchema.extend({
  body: z.string(),
  comments: z.array(ReviewCommentSchema),
})
export type DocVersionWithBodyAndComments = z.infer<typeof DocVersionWithBodyAndCommentsSchema>
