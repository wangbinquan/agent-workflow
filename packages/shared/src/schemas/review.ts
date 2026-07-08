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
import { isRegisteredKindString, isReviewableBodyKindString } from '../kindParser'
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
// RFC-060 PR-A upgrade: AgentOutputKind is now a STRING LITERAL accepting
// any base / path<ext> / list<...> kind that parses + uses a registered
// base name (see `kindParser.ts`). The three legacy enum values
// 'string' / 'markdown' / 'markdown_file' remain valid: 'string' and
// 'markdown' parse as base kinds in the registered allowlist; 'markdown_file'
// folds into 'path<md>' at parse time. New parametric kinds like
// 'path<md>' / 'list<path<md>>' / 'list<string>' are now also accepted by
// the schema.
//
// The legacy AGENT_OUTPUT_KIND array is kept as an explicit anchor for the
// RFC-049 OutputKindHandler registry coverage test (HANDLERS table must map
// these three literals 1:1). Don't extend this array for new wrapper-fanout
// kinds — extend `REGISTERED_BASE_KINDS` (kindParser.ts) for new base names
// and the kindParser grammar already covers path<*> / list<...>.
//
// Only ports declared as some form of markdown body (parsed kind is base
// 'markdown' or path<md>) may be the input source of a review node
// (enforced by workflow.validator.ts in T3 + RFC-060 §10.2).
// -----------------------------------------------------------------------------
export const AGENT_OUTPUT_KIND = ['string', 'markdown', 'markdown_file'] as const
export type LegacyAgentOutputKind = (typeof AGENT_OUTPUT_KIND)[number]

export const AgentOutputKindSchema = z.string().refine(isRegisteredKindString, {
  message:
    "kind must be a registered base kind, 'path<ext>', or 'list<...>' " +
    '(see RFC-060 kindParser.ts)',
})
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

/**
 * RFC-145 — `node_runs.superseded_by_review` value domain: the decision that
 * retired a run row (review.ts supersede path). `approved` never supersedes
 * (the approve branch early-returns before any marker/mint), so this is
 * REVIEW_DECISION_KIND minus 'approved'.
 *
 * NOT to be confused with `DOC_VERSION_DECISION`'s 'superseded' below — that
 * one is a doc_versions lifecycle value (RFC-074: system retires an awaiting
 * version when upstream refreshes) and has nothing to do with node_run rows.
 */
export const SUPERSEDE_DECISIONS = ['iterated', 'rejected'] as const
export const SupersedeDecisionSchema = z.enum(SUPERSEDE_DECISIONS)
export type SupersedeDecision = z.infer<typeof SupersedeDecisionSchema>

// -----------------------------------------------------------------------------
// Doc version — one snapshot per (review node run, version_index).
//
// versionIndex is 1-based: v1 is the first generation, v2 follows the first
// reject/iterate decision, etc. The body itself lives at `bodyPath` relative
// to `~/.agent-workflow/`; commentsJson captures the review_comments array
// at the moment the decision was made (so diff view can show "last round's
// comments" without join chains).
// -----------------------------------------------------------------------------
// RFC-074: 'superseded' — system-set when an awaiting review's upstream
// produced a fresher run; the stale doc_version is retired and v(n+1) minted
// (design §7). Not user-selectable (ReviewDecisionSchema stays approve/reject/
// iterate); it only ever appears on a historical doc_version row.
// RFC-145: distinct concept from `node_runs.superseded_by_review`
// (SUPERSEDE_DECISIONS above) — that column records which USER DECISION
// retired a run row; this 'superseded' is a SYSTEM retirement of a doc
// version. Same word, different lifecycles.
export const DOC_VERSION_DECISION = [
  'pending',
  'approved',
  'rejected',
  'iterated',
  'superseded',
] as const
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
  /**
   * Worktree-relative file path captured when this version was generated, if
   * the upstream port resolved as a `markdown_file` (or the forgiveness path
   * silently read a `.md` file). NULL when the source was inline markdown.
   * Surfaced in the iterate re-run prompt so the agent knows which file the
   * comments target.
   */
  sourceFilePath: z.string().nullable().optional(),
  /**
   * RFC-079: 0-based item index within a multi-document review round. NULL /
   * absent on single-document rows (the discriminator for single-doc mode).
   */
  itemIndex: z.number().int().nonnegative().nullable().optional(),
  /**
   * RFC-079: per-document curation choice in multi-doc mode. NULL / absent on
   * single-document rows. Orthogonal to `decision` (round-level state).
   */
  selection: z.enum(['unselected', 'accepted', 'not_accepted']).nullable().optional(),
  /**
   * RFC-079: worktree-relative path of a list<path<md>> member. NULL / absent
   * on single-document / inline rows.
   */
  itemPath: z.string().nullable().optional(),
  /**
   * RFC-129: cross-round selection inheritance staleness. true when this
   * member's `selection` was inherited from the prior round and its content
   * changed since the human last judged it (propagated until a human re-marks).
   * NULL / absent on single-document / legacy / unselected / freshly-judged rows.
   */
  selectionStale: z.boolean().nullable().optional(),
  createdAt: z.number().int(),
  decidedAt: z.number().int().nullable(),
  decidedBy: z.string().nullable(),
  /** RFC-099 (D7) — role snapshot of the decider; null on historic/system rows. */
  decidedByRole: z.enum(['owner', 'user', 'admin']).nullable().optional(),
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
  /** RFC-099 (D7) — task-relationship role snapshot ('owner'|'user'|'admin');
   *  null on historic rows. UI-only; renderCommentsForPrompt never reads it. */
  authorRole: z.enum(['owner', 'user', 'admin']).nullable().optional(),
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
  /**
   * RFC-079: the document this comment anchors to, in a multi-document review
   * round (several doc_versions pending at once). Omitted for single-document
   * reviews (the one pending doc_version is used).
   */
  docVersionId: z.string().optional(),
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
  /**
   * RFC-037: display name of the owning task (`tasks.name`). Required; backend
   * joins at query time. Lets the reviews list / inbox disambiguate multiple
   * tasks that share a workflow.
   */
  taskName: z.string(),
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
  /**
   * RFC-079: true when this review node_run is a multi-document round (its
   * doc_versions carry non-NULL item_index). Lets the reviews inbox tag the
   * row "multi-document" and route into the document-list view. Absent /
   * false for single-document reviews.
   */
  isMultiDoc: z.boolean().optional(),
  createdAt: z.number().int(),
  decidedAt: z.number().int().nullable(),
})
export type ReviewSummary = z.infer<typeof ReviewSummarySchema>

// -----------------------------------------------------------------------------
// RFC-079: multi-document review.
//
// PATCH /api/reviews/:nodeRunId/documents/:docVersionId/selection — set one
// document's curation choice. Does NOT advance the workflow or bump
// reviewIteration; only the round-level decision (approve/reject/iterate) does.
// -----------------------------------------------------------------------------
export const SetDocumentSelectionSchema = z.object({
  selection: z.enum(['accepted', 'not_accepted']),
})
export type SetDocumentSelection = z.infer<typeof SetDocumentSelectionSchema>

/**
 * RFC-079: one entry per document in a multi-document review round. Drives the
 * left-hand document list in the reviews detail page. Absent on single-doc
 * reviews (ReviewDetail.documents is undefined → single-document layout).
 */
export const ReviewDocumentSummarySchema = z.object({
  docVersionId: z.string(),
  itemIndex: z.number().int().nonnegative(),
  itemPath: z.string(),
  /** First markdown heading / first non-empty line / filename fallback. */
  title: z.string(),
  selection: z.enum(['unselected', 'accepted', 'not_accepted']),
  commentCount: z.number().int().nonnegative(),
  /**
   * RFC-129: true when this document's `selection` was inherited from the prior
   * round and its content changed since the human last judged it — drives the
   * "已变更" badge. Absent / false on single-doc & first-round & re-affirmed docs.
   */
  stale: z.boolean().optional(),
})
export type ReviewDocumentSummary = z.infer<typeof ReviewDocumentSummarySchema>

/** GET /api/reviews/:nodeRunId — full detail used by the review page. */
export const ReviewDetailSchema = z.object({
  summary: ReviewSummarySchema,
  currentVersion: DocVersionSchema,
  currentBody: z.string(),
  comments: z.array(ReviewCommentSchema),
  /** Lightweight rerun candidate list for the readonly "will rerun" modal. */
  rerunnableOnReject: z.array(z.string()),
  rerunnableOnIterate: z.array(z.string()),
  /**
   * RFC-079: present (non-empty) only for a multi-document review round. Lists
   * every document in `item_index` order; `currentVersion`/`currentBody`/
   * `comments` refer to the currently-selected document. Undefined for
   * single-document reviews → the page renders the existing two-column layout.
   */
  documents: z.array(ReviewDocumentSummarySchema).optional(),
})
export type ReviewDetail = z.infer<typeof ReviewDetailSchema>

/** GET /api/reviews/pending-count — global badge in left nav. */
export const ReviewPendingCountSchema = z.object({
  count: z.number().int().nonnegative(),
})
export type ReviewPendingCount = z.infer<typeof ReviewPendingCountSchema>

// -----------------------------------------------------------------------------
// RFC-142: multi-document review rounds.
//
// `GET /api/reviews/:nodeRunId/rounds` returns one entry per review round
// (grouped by review_iteration + RFC-129 round_generation; legacy NULL-
// generation rows group by review_iteration alone). Drives the round rows in
// the /reviews list expand and the read-only historical-round view
// (`?round=<roundKey>`). Empty array for single-document reviews.
// -----------------------------------------------------------------------------
export const ReviewRoundMemberSchema = ReviewDocumentSummarySchema.extend({
  /** Member-level decision (superseded members surface in retired rounds). */
  decision: DocVersionDecisionSchema,
})
export type ReviewRoundMember = z.infer<typeof ReviewRoundMemberSchema>

export const ReviewRoundSummarySchema = z.object({
  /** Opaque round handle for `?round=` — 'g{generation}' | 'i{iteration}-legacy'. */
  roundKey: z.string(),
  reviewIteration: z.number().int().nonnegative(),
  /** NULL on pre-RFC-129 (migration 0070) legacy rounds. */
  roundGeneration: z.number().int().positive().nullable(),
  /** Round-level decision (the decision writer stamps a whole round at once). */
  decision: DocVersionDecisionSchema,
  /**
   * Round-level reason: rejected → the shared reject reason; superseded →
   * the system retirement marker ('upstream-refreshed'). NULL on iterated
   * rounds (per-document feedback lives in each member's frozen comments),
   * approved and pending rounds.
   */
  decisionReason: z.string().nullable(),
  decidedAt: z.number().int().nullable(),
  decidedBy: z.string().nullable(),
  decidedByRole: z.enum(['owner', 'user', 'admin']).nullable(),
  /** min(member.createdAt) — when the round was minted. */
  createdAt: z.number().int(),
  /** True on the round the interactive detail view renders (pending, else newest). */
  isCurrent: z.boolean(),
  /** item_index ascending. */
  members: z.array(ReviewRoundMemberSchema),
})
export type ReviewRoundSummary = z.infer<typeof ReviewRoundSummarySchema>

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

// -----------------------------------------------------------------------------
// RFC-014: multi-markdown upstream detection.
//
// Pure helper used by services/review.ts on the iterate decision path.
// Inputs: upstream agent's declared output ports + the agent's
// syncOutputsOnIterate switch. Output: `{ trigger, markdownPorts }` pair
// driving (a) whether the iterate path regenerates every markdown[_file]
// sibling port and cascades sibling reviews, and (b) whether
// `{{__sibling_outputs__}}` gets populated.
//
// Trigger rule (AND):
//   1. syncOutputsOnIterate === true                           (agent opt-in)
//   2. count of outputs where kind ∈ {markdown, markdown_file} is ≥ 2
//
// kind = undefined / 'string' is treated as non-markdown (RFC-005 §3).
// -----------------------------------------------------------------------------
export interface MultiMarkdownUpstreamInput {
  /** All output port specs declared on the upstream agent. */
  outputs: ReadonlyArray<{ name: string; kind?: AgentOutputKind }>
  /** Agent-level switch (RFC-014 §2.1 #6). */
  syncOutputsOnIterate: boolean
}

export interface MultiMarkdownUpstreamResult {
  trigger: boolean
  markdownPorts: string[]
}

export function isMultiMarkdownUpstream(
  input: MultiMarkdownUpstreamInput,
): MultiMarkdownUpstreamResult {
  if (!input.syncOutputsOnIterate) {
    return { trigger: false, markdownPorts: [] }
  }
  // RFC-081: a markdown-bodied port is any kind isReviewableBodyKind admits
  // (base markdown / path<md> / path<markdown> / the markdown_file alias) —
  // delegated to the single kindParser predicate instead of the stale literal
  // pair, so a path<md> sibling now correctly participates in the cascade.
  const markdownPorts: string[] = []
  for (const o of input.outputs) {
    if (o.kind !== undefined && isReviewableBodyKindString(o.kind)) {
      markdownPorts.push(o.name)
    }
  }
  return { trigger: markdownPorts.length >= 2, markdownPorts }
}

/**
 * RFC-014: stable English instruction prefix injected at the top of the
 * `{{__sibling_outputs__}}` block. Source-level grep tests assert this
 * literal — renaming it silently would let agents miss the consistency cue.
 */
export const SIBLING_OUTPUTS_INSTRUCTION =
  'You also produced the following sibling documents. ' +
  'They are tightly coupled with the document being revised; ' +
  'rewrite them coherently so the whole set stays consistent.'
