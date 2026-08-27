// Review business logic (RFC-005 PR-B).
//
// This module owns the review feature's state transitions outside the
// scheduler / runner / REST layer:
//
//   - Pure anchor helpers: recomputeOccurrenceIndex, canonicalizeAnchor.
//     Server recomputes the occurrence_index from canonical doc body so a
//     client cannot inflate a forged index to point at a different
//     selection (RFC-005 design.md §6 + plan T10).
//   - Scheduler-side dispatchReviewNode: invoked from scheduler.runOneNode
//     when it lands on a review node. Reads the upstream port content,
//     archives v(n+1) to doc_versions (file + DB row), parks the node_run
//     in status=awaiting_review, broadcasts review.created on /ws/tasks/.
//   - REST-side handlers: submitReviewDecision (approve / reject / iterate),
//     addReviewComment, deleteReviewComment, listReviewSummaries,
//     countPendingReviews, getReviewDetail, listDocVersionsForReview,
//     getDocVersionBody.
//   - Helpers: createDocVersion, archiveCommentsForVersion,
//     cascadeSiblingReviews (sibling reviews of a rejected upstream),
//     rollbackUpstreamNodeRuns (for reject/iterate worktree restoration).
//
// `resumeTask` is invoked by REST decision handlers to re-enter the
// scheduler after a decision lands.

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  notInArray,
  sql,
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { ulid } from 'ulid'
import type {
  AgentOutputKind,
  DocVersion,
  DocVersionDecision,
  NodeRunStatus,
  ReviewBatchSelection,
  ReviewComment,
  ReviewCommentAnchor,
  ReviewDecisionKind,
  ReviewDetail,
  ReviewSummary,
  ReviewPromptContext,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'
import {
  type ReviewAnchorRequest,
  type ReviewAnchorWarning,
  type TaskActorRole,
  buildWorkflowScopeParentMap,
  findAllOccurrences,
  isMultiMarkdownUpstream,
  migrateWorkflowDefinitionToLatest,
  resolveWorkflowSourceRef,
  selectCurrentReviewRound,
  SIBLING_OUTPUTS_INSTRUCTION,
  TERMINAL_TASK_STATUSES,
  WorkflowDefinitionSchema,
} from '@agent-workflow/shared'
import {
  acceptedSubsetPaths,
  allDocumentsDecided,
  buildPriorSelectionLookup,
  extractDocTitle,
  inheritSelection,
  isMultiDocReviewInput,
  isInlineMarkdownListReviewInput,
  isReviewableBodyKindString,
  splitListItems,
  splitMarkdownDocs,
  joinMarkdownDocs,
  LOCAL_DECIDER,
  REVIEW_APPROVAL_META_PORT,
  REVIEW_APPROVED_PORT_MULTI,
  REVIEW_APPROVED_PORT_SINGLE,
  SYSTEM_DECIDER,
} from '@agent-workflow/shared'
import type {
  PriorRoundMember,
  ReviewDocumentSummary,
  ReviewRoundMember,
  ReviewRoundSummary,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import {
  finalizeCommittedHumanGate,
  prepareReviewGateOpen,
} from '@/modules/collaboration/public/commands'
import {
  humanGateComposition,
  type HumanGateOperationStoreBridge as SqliteHumanGateOperationStore,
  type ReviewDecisionManifestBridge as ReviewDecisionManifest,
  type ReviewDecisionReceiptEnvelopeBridge as ReviewDecisionReceiptEnvelope,
  type ValidatedWorkspaceRollbackPlanBridge as ValidatedWorkspaceRollbackPlan,
} from '@/services/humanGateComposition'
import {
  buildReviewAnchorDocument,
  createReviewAnchorBudget,
  readCommittedReviewArtifactBody,
  resolveReviewAnchor,
} from '@/modules/collaboration/public/queries'
import type {
  CanonicalHumanGateRequest,
  ReviewAnchorFailure,
  ReviewGateOpenDocumentDraft,
} from '@/modules/collaboration/public/types'
import {
  agents as agentsTable,
  collaborationGateOperations,
  docVersions,
  nodeRunEvents,
  nodeRunOutputs,
  nodeRuns,
  reviewComments,
  tasks,
  workflows,
} from '@/db/schema'
import { isPathishKindString, readPortArtifact, subsetArchiveJson } from '@/services/portArtifacts'
import { taskAuthorizationCondition } from '@/services/taskAuthorization'
import { chunkedAll } from '@/util/sqlChunk'
import { pickFreshestRun, pickVisibleUpstreamRun } from '@/services/freshness'
import { parseConsumedJson } from '@/services/freshness'
import {
  assertNodeRunSourceTerminationAdmission,
  setNodeRunStatusTx,
  transitionHumanGateTaskTx,
  transitionNodeRunStatus,
  transitionNodeRunStatusTx,
} from '@/services/lifecycle'
import { snapshotNodeAgentWhere } from '@/services/agent'
import { enqueueDistillJob } from '@/services/memoryDistillScheduler'
import { nextRetryIndex, mintNodeRun, mintNodeRunTx } from '@/services/nodeRunMint'
import { loadRollbackTarget, planNodeRunRollbackTargets } from '@/services/nodeRollback'
import {
  currentTaskExecutionContext,
  humanGateNodeProjectionFence,
  withTaskExecutionMutation,
  withTaskExecutionTransaction,
} from '@/services/taskExecutionParticipants'
import {
  withReviewNodeMutationLock,
  withTaskReviewMutationLock,
} from '@/services/reviewMutationCoordinator'
import {
  ConflictError,
  DomainError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@/util/errors'
import { hasActingMembership, hasActingMembershipTx } from '@/services/taskCollab'
import { resolveTaskRole } from '@/services/resourceAcl'
import { createLogger } from '@/util/log'
import { sha256Hex } from '@/util/hash'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'

const {
  canonicalHumanGateRequestHash,
  canonicalHumanGateValueJson,
  decodeReviewDecisionManifest,
  decodeReviewDecisionReceipt,
  deriveHumanGateCompatibilityKey,
  encodeReviewDecisionManifest,
  encodeReviewDecisionReceipt,
  gateDecisionReceipt,
} = humanGateComposition

/** RFC-145: human-readable supersede breadcrumb prefix (message builder only —
 *  the machine contract is the superseded_by_review / rolled_back columns). */
const REVIEW_SUPERSEDE_MARKER_PREFIX = 'superseded-by-review-'

const log = createLogger('review')

// ---------------------------------------------------------------------------
// Anchor — pure functions.
// ---------------------------------------------------------------------------

// RFC-326: the occurrence math is ONE shared implementation
// (packages/shared/src/textOccurrences.ts) used by this canonicaliser, the
// collaboration anchor resolver and the web highlighter — the number stored in
// `occurrence_index` and the number the page counts must be the same number.
// Re-exported so existing import sites and tests keep working.
export { findAllOccurrences }

export interface OccurrenceRecomputeResult {
  /** 1-based occurrence index in the full document body. */
  occurrenceIndex: number
  /** Absolute char offset of the chosen occurrence in the doc body. */
  absoluteOffset: number
  /** True when context disambiguated (contextBefore / After matched). */
  contextMatched: boolean
}

/**
 * Recompute the 1-based occurrence index of `anchor.selectedText` inside
 * `docBody`, choosing the occurrence whose immediate ±context best matches
 * `anchor.contextBefore` / `anchor.contextAfter`.
 *
 * Selection criteria (in order):
 *   1. The occurrence whose (contextBefore endsWith && contextAfter startsWith)
 *      pair fully matches the doc body's surrounding chars.
 *   2. Else: the occurrence whose Levenshtein distance on the context windows
 *      is minimal (longest common prefix on contextBefore + suffix on
 *      contextAfter as a cheap proxy — we avoid pulling in a full edit-distance
 *      lib for one screen of code).
 *   3. Else: fall back to the client-claimed occurrenceIndex if it's a valid
 *      1..N index against the actual occurrence count.
 *
 * Throws ValidationError when `selectedText` is empty or not present at all.
 */
export class AnchorValidationError extends ValidationError {
  constructor(code: string, message: string) {
    // RFC-326 (P6): was a bare Error → the route surfaced a 500 for a made-up
    // selectedText although the docstring above promised a ValidationError.
    super(code, message)
    this.name = 'AnchorValidationError'
  }
}

export function recomputeOccurrenceIndex(
  docBody: string,
  anchor: ReviewCommentAnchor,
): OccurrenceRecomputeResult {
  if (anchor.selectedText.length === 0) {
    throw new AnchorValidationError(
      'anchor-empty-selection',
      'anchor.selectedText must be non-empty',
    )
  }
  const offsets = findAllOccurrences(docBody, anchor.selectedText)
  if (offsets.length === 0) {
    throw new AnchorValidationError(
      'anchor-selection-not-found',
      `anchor.selectedText '${truncate(anchor.selectedText, 40)}' not present in document`,
    )
  }

  // RFC-326 strategy 0 — a self-consistent anchor is taken as-is: `offsetStart`
  // IS an occurrence (so the slice equals selectedText) and every non-empty
  // context side matches there. Server-resolved anchors always satisfy this;
  // web anchors do whenever the proportional heuristic landed on the right
  // occurrence. Without it two occurrences with identical ±30-char contexts
  // (repeated table rows) were both "resolved" to the first one, overriding
  // the caller's explicit choice — the design-gate reproduction of RFC-326.
  const exactIdx = offsets.indexOf(anchor.offsetStart)
  if (exactIdx >= 0 && contextMatchesAt(docBody, anchor, anchor.offsetStart)) {
    return {
      occurrenceIndex: exactIdx + 1,
      absoluteOffset: anchor.offsetStart,
      contextMatched: true,
    }
  }

  // Strategy 1: exact context match. Only applies if AT LEAST ONE context
  // side is non-empty — otherwise every occurrence trivially "matches" and
  // we'd skip strategies 2/3 wrongly.
  const hasContext = anchor.contextBefore.length > 0 || anchor.contextAfter.length > 0
  if (hasContext) {
    let bestExact = -1
    for (let i = 0; i < offsets.length; i++) {
      const off = offsets[i]!
      const before = docBody.slice(Math.max(0, off - anchor.contextBefore.length), off)
      const after = docBody.slice(
        off + anchor.selectedText.length,
        off + anchor.selectedText.length + anchor.contextAfter.length,
      )
      if (
        (anchor.contextBefore.length === 0 || before === anchor.contextBefore) &&
        (anchor.contextAfter.length === 0 || after === anchor.contextAfter)
      ) {
        bestExact = i
        break
      }
    }
    if (bestExact >= 0) {
      return {
        occurrenceIndex: bestExact + 1,
        absoluteOffset: offsets[bestExact]!,
        contextMatched: true,
      }
    }
  }

  // Strategy 2: cheap proxy — longest common suffix on contextBefore + longest
  // common prefix on contextAfter. Picks the candidate with the highest sum.
  let bestIdx = 0
  let bestScore = -1
  for (let i = 0; i < offsets.length; i++) {
    const off = offsets[i]!
    const before = docBody.slice(Math.max(0, off - anchor.contextBefore.length), off)
    const after = docBody.slice(
      off + anchor.selectedText.length,
      off + anchor.selectedText.length + anchor.contextAfter.length,
    )
    const beforeScore = commonSuffixLength(before, anchor.contextBefore)
    const afterScore = commonPrefixLength(after, anchor.contextAfter)
    const score = beforeScore + afterScore
    if (score > bestScore) {
      bestScore = score
      bestIdx = i
    }
  }
  if (bestScore > 0) {
    return {
      occurrenceIndex: bestIdx + 1,
      absoluteOffset: offsets[bestIdx]!,
      contextMatched: false,
    }
  }

  // Strategy 3: fall back to the client's claim, clamped to 1..N.
  const claimed = anchor.occurrenceIndex
  if (Number.isInteger(claimed) && claimed >= 1 && claimed <= offsets.length) {
    return {
      occurrenceIndex: claimed,
      absoluteOffset: offsets[claimed - 1]!,
      contextMatched: false,
    }
  }
  // Last resort: pick the first occurrence. Server still owns the index.
  return {
    occurrenceIndex: 1,
    absoluteOffset: offsets[0]!,
    contextMatched: false,
  }
}

/**
 * Server-side fixup applied before persisting a review_comment row: the
 * client-supplied anchor is replaced with one whose `occurrenceIndex` reflects
 * what the canonical document actually says AND whose `offsetStart/End` point at
 * that same occurrence (RFC-326 P5 — before, only the index was rewritten and
 * the offsets stayed at the client's heuristic guess, so a stored row could
 * name occurrence 3 while its offsets sat on occurrence 2; the web highlighter
 * now locates comments by offset, which needs the row to be self-consistent).
 * `sectionPath` / `paragraphIdx` / contexts stay as posted.
 */
export function canonicalizeAnchor(
  docBody: string,
  anchor: ReviewCommentAnchor,
): ReviewCommentAnchor {
  const recomputed = recomputeOccurrenceIndex(docBody, anchor)
  return {
    ...anchor,
    occurrenceIndex: recomputed.occurrenceIndex,
    offsetStart: recomputed.absoluteOffset,
    offsetEnd: recomputed.absoluteOffset + anchor.selectedText.length,
  }
}

function contextMatchesAt(docBody: string, anchor: ReviewCommentAnchor, offset: number): boolean {
  const before = docBody.slice(Math.max(0, offset - anchor.contextBefore.length), offset)
  const end = offset + anchor.selectedText.length
  const after = docBody.slice(end, end + anchor.contextAfter.length)
  return (
    (anchor.contextBefore.length === 0 || before === anchor.contextBefore) &&
    (anchor.contextAfter.length === 0 || after === anchor.contextAfter)
  )
}

/**
 * RFC-326 — translate a resolver refusal into the 422 the route returns. The
 * candidate keys ride in `message` (the MCP channel forwards only the message)
 * and the structured lists in `details` (REST callers read them as-is).
 */
export function anchorResolutionError(failure: ReviewAnchorFailure): ValidationError {
  return new ValidationError(failure.code, failure.message, {
    candidates: failure.candidates,
    total: failure.total,
    truncated: failure.truncated,
    suggestions: failure.suggestions,
  })
}

/**
 * RFC-326 AC-9 — a server-resolved anchor is persisted verbatim; the only check
 * is that it still describes the body it was resolved against. A mismatch is a
 * programming error (the resolver and this service disagree about the body),
 * not a client error, hence a bare Error (500).
 */
export function assertResolvedAnchorConsistent(docBody: string, anchor: ReviewCommentAnchor): void {
  if (docBody.slice(anchor.offsetStart, anchor.offsetEnd) !== anchor.selectedText) {
    throw new Error(
      `resolved review anchor is inconsistent with the document body at ${anchor.offsetStart}-${anchor.offsetEnd}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++
  return i
}

function commonSuffixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  let i = 0
  while (i < n && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++
  return i
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '…'
}

// ---------------------------------------------------------------------------
// Path conventions for doc_version body files on disk.
// ---------------------------------------------------------------------------

/**
 * Relative path (anchored at app home) for a doc_version body. Used both for
 * the DB index and the file on disk. Returns POSIX-style separators so paths
 * round-trip through SQLite cleanly on Windows / macOS / Linux.
 */
export function docVersionRelativePath(
  taskId: string,
  reviewNodeId: string,
  portName: string,
  versionIndex: number,
  // RFC-079: in multi-document mode each list item gets its own version
  // sequence under an `item_{i}` segment, so item bodies never collide.
  // Undefined (single-document) keeps the legacy path byte-for-byte.
  itemIndex?: number,
): string {
  const itemSeg = itemIndex !== undefined ? `/item_${itemIndex}` : ''
  return `runs/${taskId}/review/${reviewNodeId}/${portName}${itemSeg}/v${versionIndex}.md`
}

// ---------------------------------------------------------------------------
// Review-run picking helpers (RFC-052 reuse + RFC-056 patch-2026-05-26 cci
// alignment). Exported so the patch's unit tests can lock the behavior
// independently of dispatchReviewNode's surrounding state machine.
// ---------------------------------------------------------------------------

export interface ReviewRunsPicked {
  /** Freshest top-level review row by isFresherNodeRun. Used as the reuse
   *  candidate the dispatcher transitions toward awaiting_review. */
  reuse: typeof nodeRuns.$inferSelect | undefined
  /** Freshest top-level review row whose status is `done`. Used solely for
   *  the cci-alignment short-circuit; NOT the reuse target — the cascade-
   *  minted pending row is the dispatch target when alignment fails. */
  latestDone: typeof nodeRuns.$inferSelect | undefined
}

/**
 * Pick the freshest top-level review row (`reuse`) and the freshest
 * top-level `done` review row (`latestDone`) from a list of review_runs
 * for one (taskId, nodeId, iteration). Skips fan-out child rows.
 * Comparator is `isFresherNodeRun` (pure ULID id-order — later-minted row
 * wins; the clarifyIteration/retryIndex tiers this comment used to describe
 * were retired in RFC-074) — same one the scheduler picks `latestPerNode`
 * with (comment fixed by RFC-094, audit S-26).
 */
export function pickFreshestReviewRun(
  reviewRuns: ReadonlyArray<typeof nodeRuns.$inferSelect>,
): ReviewRunsPicked {
  // RFC-096: thin wrapper over the shared picker (freshness.ts) — kept as an
  // exported named function because tests anchor on it.
  return {
    reuse: pickFreshestRun(reviewRuns, { topLevelOnly: true }),
    latestDone: pickFreshestRun(reviewRuns, { topLevelOnly: true, statusIn: ['done'] }),
  }
}

// ---------------------------------------------------------------------------
// Scheduler entry point.
// ---------------------------------------------------------------------------

/**
 * RFC-193 D16 — the upstream port row's archive reference for a review run,
 * located via the run's RFC-074 provenance (consumed_upstream_runs_json). The
 * decision products (approved_doc / accepted) project that port's paths, so
 * they inherit the matching archive slice through subsetArchiveJson. Null
 * provenance (legacy rows) → null (readers use the fallback chain).
 */
async function upstreamPortArchiveJson(
  db: DbClient,
  reviewRun: typeof nodeRuns.$inferSelect,
  sourceNodeId: string,
  sourcePortName: string,
): Promise<string | null> {
  const upstreamRunId = parseConsumedJson(reviewRun.consumedUpstreamRunsJson)[sourceNodeId]
  if (upstreamRunId === undefined) return null
  const rows = await db
    .select({ archiveJson: nodeRunOutputs.archiveJson })
    .from(nodeRunOutputs)
    .where(
      and(eq(nodeRunOutputs.nodeRunId, upstreamRunId), eq(nodeRunOutputs.portName, sourcePortName)),
    )
  return rows[0]?.archiveJson ?? null
}

export interface DispatchReviewArgs {
  db: DbClient
  taskId: string
  appHome: string
  definition: WorkflowDefinition
  node: WorkflowNode // the review node
  iteration: number
  /**
   * RFC-193 D9 — the CONTAINING SCOPE's canonical root, used ONLY as the
   * readPortArtifact fallback for pre-RFC-193 rows (archive_json NULL). The
   * scheduler passes state.scopeRoot (top level: the task worktree; inside a
   * git/loop wrapper: the wrapper-canonical container — reading the TASK
   * worktree there was THE wrapper-review deadlock this RFC roots out). S1
   * repair derives it from the wrapper run lineage (§4.6). This module must
   * never join paths against a worktree it picked itself (source-locked).
   */
  scopeRoot: string
  /**
   * repos[0] 的 worktreeDirName（多 repo 存量行回退的前缀；单 repo ''）。
   * 省略默认 ''——S1 修复等无 repos 上下文的调用方保持现状语义。
   */
  repoDirName?: string
}

export interface DispatchReviewResult {
  kind: 'ok' | 'failed' | 'canceled' | 'awaiting_review'
  summary: string
  message: string
}

/**
 * Scheduler-side dispatch for a `kind: 'review'` node.
 *
 * Flow:
 *   1. Read inputSource from node config.
 *   2. Validate upstream is done at this iteration; otherwise fail (scheduler
 *      should have ordered correctly, so this is a guardrail).
 *   3. Resolve port content (handles markdown_file kind via resolvePortContent).
 *   4. Find or create the review node_run row. If it already exists with
 *      status=awaiting_review and a pending doc_version, re-emit the
 *      broadcast and exit (idempotent on resume).
 *   5. Otherwise transition into awaiting_review, write a new doc_version
 *      file + row at versionIndex = max+1, broadcast review.created.
 */
export function dispatchReviewNode(args: DispatchReviewArgs): Promise<DispatchReviewResult> {
  // Scheduler dispatch, repair dispatch and every user review mutation share
  // one task-scoped linearization point. Register by the already-authoritative
  // taskId (rather than resolving a review row that may not exist yet).
  return withTaskReviewMutationLock(args.taskId, () => dispatchReviewNodeUnlocked(args))
}

async function dispatchReviewNodeUnlocked(args: DispatchReviewArgs): Promise<DispatchReviewResult> {
  const { db, taskId, appHome, definition, node, iteration, scopeRoot, repoDirName } = args

  // Re-read only after acquiring the coordinator. A cancel that linearized
  // first must make dispatch a zero-write loser; S1 repair legitimately calls
  // this while the task is already parked awaiting_review.
  const taskRow = (
    await db
      .select({
        status: tasks.status,
        lifecycleEventRevision: tasks.lifecycleEventRevision,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
  )[0]
  if (taskRow === undefined) {
    return {
      kind: 'failed',
      summary: `review node ${node.id}: task '${taskId}' no longer exists`,
      message: 'task-not-found',
    }
  }
  if (taskRow.status === 'canceled') {
    return {
      kind: 'canceled',
      summary: `review node ${node.id}: task '${taskId}' was canceled before dispatch`,
      message: 'task-canceled',
    }
  }
  if (taskRow.status !== 'running' && taskRow.status !== 'awaiting_review') {
    return {
      kind: 'failed',
      summary: `review node ${node.id}: task '${taskId}' is not dispatchable (${taskRow.status})`,
      message: 'review-task-not-dispatchable',
    }
  }

  const inputSource = readPortRef(node, 'inputSource')
  if (inputSource === null) {
    return {
      kind: 'failed',
      summary: `review node ${node.id} missing inputSource`,
      message: 'review-input-source-missing',
    }
  }

  const sourceResolution = resolveWorkflowSourceRef(
    definition,
    inputSource,
    node.id,
    buildWorkflowScopeParentMap(definition),
  )
  if (!sourceResolution.ok) {
    return {
      kind: 'failed',
      summary: `review node ${node.id}: source '${inputSource.nodeId}.${inputSource.portName}' is not exposed by wrapper '${sourceResolution.wrapperId}'`,
      message: 'wrapper-output-boundary-missing',
    }
  }
  const sourcePortName = sourceResolution.source.portName
  const sourceNodeId = sourceResolution.source.nodeId

  // Locate the upstream node_run at this iteration whose port we should read.
  // Picks the freshest top-level run via the same comparator the scheduler uses
  // (clarifyIteration first, then retryIndex, ulid tie-break). Sorting by
  // retryIndex alone here used to silently shadow a clarify-driven rerun
  // (clarifyIteration=N, retryIndex=0) behind a stale process-retry row
  // (clarifyIteration=0, retryIndex=M>0) that finished BEFORE the clarify
  // session opened, causing review to read a node_run that never emitted the
  // expected port.
  const sourceRuns = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, sourceNodeId)))
  // RFC-096: shared picker, top-level only (fan-out child rows skipped —
  // multi-process review per-shard is RFC-005 T14). Deliberately NO statusIn
  // filter: the freshest row must be checked for done-ness below — filtering
  // would silently fall back to an OLDER done row instead of failing loudly
  // with review-upstream-not-done.
  const sourceRun = pickVisibleUpstreamRun(sourceRuns, iteration)
  if (sourceRun === undefined || sourceRun.status !== 'done') {
    return {
      kind: 'failed',
      summary: `review node ${node.id}: upstream '${sourceNodeId}' has no completed run yet`,
      message: 'review-upstream-not-done',
    }
  }

  // Read port content. agent.outputKinds tells us if it's a markdown_file
  // (path) versus inline markdown.
  const portRows = await db
    .select()
    .from(nodeRunOutputs)
    .where(
      and(eq(nodeRunOutputs.nodeRunId, sourceRun.id), eq(nodeRunOutputs.portName, sourcePortName)),
    )
  const portRow = portRows[0]
  if (portRow === undefined) {
    return {
      kind: 'failed',
      summary: `review node ${node.id}: upstream '${sourceNodeId}' did not emit port '${sourcePortName}'`,
      message: 'review-source-port-missing',
    }
  }

  const upstreamKind =
    portRow.kind ??
    (await loadUpstreamPortKind(db, definition, sourceNodeId, sourcePortName)) ??
    (await loadUpstreamPortKind(db, definition, inputSource.nodeId, inputSource.portName))
  // RFC-079: a list<markdownish> upstream puts this review in MULTI-DOCUMENT
  // mode — each list item is archived as its own doc_version below.
  const isMultiDoc = isMultiDocReviewInput(upstreamKind ?? '')
  let resolvedBody = ''
  let resolvedSourcePath: string | undefined
  let itemPaths: string[] = []
  let inlineBodies: string[] = []
  // RFC-193: ONE reading primitive for every file-backed body — the emit-time
  // archive first (immune to scope nesting / iso lifetime / gitignore /
  // worktree GC), then the SCOPE root as the legacy fallback (pre-RFC-193
  // rows), then missing. Never resolve against a worktree here directly —
  // that re-creates the wrapper-review deadlock this RFC exists to kill.
  const artifactRead = readPortArtifact({
    appHome,
    taskId,
    archiveJson: portRow.archiveJson ?? null,
    content: portRow.content,
    kind: upstreamKind ?? null,
    fallbackWorktreeRoot: scopeRoot,
    legacyRepoDirName: repoDirName ?? '',
  })
  // RFC-081: list<markdown> items are inline document bodies framed by
  // MARKDOWN_DOC_BOUNDARY; list<path<md>> items are newline-separated worktree
  // paths (bodies come from the artifact read above).
  const itemsInline = isMultiDoc && isInlineMarkdownListReviewInput(upstreamKind ?? '')
  if (isMultiDoc) {
    if (itemsInline) {
      inlineBodies = splitMarkdownDocs(portRow.content)
    } else {
      // Split with the SAME shared splitter the validator / downstream
      // wrapper-fanout use so the reviewed item set matches the shard set
      // byte-for-byte (item identity stays the port's own line text).
      itemPaths = splitListItems(portRow.content)
    }
  } else {
    const item0 = artifactRead.items[0]
    if (item0 === undefined || item0.source === 'missing') {
      return {
        kind: 'failed',
        summary: `review node ${node.id}: source content unavailable (archive missing and '${
          item0?.path ?? portRow.content
        }' not readable under scope root)`,
        message: 'review-source-resolve-failed',
      }
    }
    resolvedBody = item0.body
    // sourceFilePath 必须保持【端口 content 的 repo0 相对形态】——它会经
    // approve 原样发布给下游（agent cwd = repo0 根）；item0.path 是容器相对
    // （多 repo 带 repoA/ 前缀），发布它会让下游解析成 repoA/repoA/…（Codex
    // 实现门 P1）。归档 path 只用于定位字节，不做发布形态。
    resolvedSourcePath = isPathishKindString(upstreamKind ?? null)
      ? portRow.content.trim()
      : undefined
  }

  // Find / create the review node_run row.
  const reviewRuns = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, node.id),
        eq(nodeRuns.iteration, iteration),
      ),
    )
  // RFC-074 (T-B4 / T-B9 / T-B10): provenance replaces the RFC-052 "any done
  // short-circuits" + RFC-056 cci-alignment logic. A review row records the
  // exact sourceRun it was produced against in consumed_upstream_runs_json. The
  // SCHEDULER's completed-set gating (isNodeRunFresh) keeps a fresh done review
  // out of dispatch entirely (so approve → no spurious re-review; §1.3 bug
  // structurally gone). The branches here cover the cases that DO reach
  // dispatch: a live awaiting row (resume / awaiting-refresh §7), a prior
  // decision that still covers the source, or a (re-)open.
  const { reuse, latestDone } = pickFreshestReviewRun(reviewRuns)
  const consumedJson = JSON.stringify({ [sourceNodeId]: sourceRun.id })
  // A review row "still covers" the current source iff it recorded consuming
  // this exact source run, OR carries no provenance at all (legacy / null =
  // fresh — migration hard-cut D4). Only a recorded DIFFERENT consumption is a
  // genuine stale signal (RFC-005 US-2: upstream re-ran after the decision).
  const coversSource = (row: typeof nodeRuns.$inferSelect): boolean => {
    const c = parseConsumedJson(row.consumedUpstreamRunsJson)[sourceNodeId]
    return c === undefined || c === sourceRun.id
  }

  if (latestDone !== undefined && coversSource(latestDone)) {
    // A prior decision against this exact source remains decisive.
    return { kind: 'ok', summary: '', message: '' }
  }

  const reuseDocVersions =
    reuse?.status === 'pending' || reuse?.status === 'awaiting_review'
      ? await db
          .select()
          .from(docVersions)
          .where(
            and(
              eq(docVersions.reviewNodeRunId, reuse.id),
              eq(docVersions.sourcePortName, sourcePortName),
            ),
          )
      : []
  const pendingReuseDocVersions = reuseDocVersions.filter(
    (document) => document.decision === 'pending',
  )
  const nextVersionIndex = (itemIndex: number | null): number =>
    Math.max(
      0,
      ...reuseDocVersions
        .filter((document) => document.itemIndex === itemIndex)
        .map((document) => document.versionIndex),
    ) + 1

  const refreshAwaitingReview = reuse?.status === 'awaiting_review' && !coversSource(reuse)
  // RFC-333 T6: every new review-open and every source-refresh round is
  // prepared completely before one TaskParkTx makes the projection visible.
  // Only already-leaked legacy pending rows and same-source repair/resume stay
  // on the compatibility path below.
  if (
    refreshAwaitingReview ||
    (reuse?.status !== 'awaiting_review' && pendingReuseDocVersions.length === 0)
  ) {
    const reviewIteration = reuse?.reviewIteration ?? 0
    const drafts: ReviewGateOpenDocumentDraft[] = []
    if (isMultiDoc) {
      const prior = await loadPriorRound(db, appHome, {
        taskId,
        reviewNodeId: node.id,
        iteration,
      })
      const priorLookup = buildPriorSelectionLookup(prior.members)
      const itemCount = itemsInline ? inlineBodies.length : itemPaths.length
      for (let i = 0; i < itemCount; i++) {
        let body: string
        let itemPath: string | undefined
        if (itemsInline) {
          body = inlineBodies[i]!
        } else {
          itemPath = itemPaths[i]!
          const artItem = artifactRead.items[i]
          body =
            artItem !== undefined && artItem.source !== 'missing'
              ? artItem.body
              : `> ⚠️ RFC-079: file not found in worktree: \`${itemPath}\``
        }
        const inherited = inheritSelection(
          { itemIndex: i, itemPath: itemPath ?? null, body },
          priorLookup,
        )
        drafts.push({
          body,
          sourceNodeId,
          sourcePortName,
          versionIndex: nextVersionIndex(i),
          reviewIteration,
          ...(itemPath === undefined ? {} : { sourceFilePath: itemPath, itemPath }),
          itemIndex: i,
          selection: inherited.selection,
          selectionStale: inherited.stale,
          roundGeneration: prior.nextGeneration,
        })
      }
    } else {
      drafts.push({
        body: resolvedBody,
        sourceNodeId,
        sourcePortName,
        versionIndex: nextVersionIndex(null),
        reviewIteration,
        ...(resolvedSourcePath === undefined ? {} : { sourceFilePath: resolvedSourcePath }),
      })
    }

    // RFC-202: zero documents is a successful empty audit. The node is minted
    // and approved inside one transaction, so no visible human gate exists at
    // any commit boundary and the task remains running.
    if (drafts.length === 0) {
      const decidedAt = Date.now()
      const acceptedKind = itemsInline ? 'list<markdown>' : 'list<path<md>>'
      let reviewNodeRunId = reuse?.status === 'pending' || refreshAwaitingReview ? reuse.id : ''
      const meta = JSON.stringify({
        decision: 'approved',
        decidedAt,
        reviewIteration,
        sourceNodeId,
        sourcePortName,
        itemCount: 0,
        acceptedCount: 0,
        acceptedItemIndices: [],
        auto: 'empty-list',
      })
      withTaskExecutionTransaction({
        db,
        taskId,
        now: decidedAt,
        run: (tx) => {
          if (refreshAwaitingReview) {
            const current = tx
              .select({
                status: nodeRuns.status,
                consumedUpstreamRunsJson: nodeRuns.consumedUpstreamRunsJson,
              })
              .from(nodeRuns)
              .where(eq(nodeRuns.id, reuse.id))
              .get()
            const expectedPendingIds = pendingReuseDocVersions.map((document) => document.id).sort()
            const currentPendingIds = tx
              .select({ id: docVersions.id })
              .from(docVersions)
              .where(
                and(
                  eq(docVersions.reviewNodeRunId, reuse.id),
                  eq(docVersions.sourcePortName, sourcePortName),
                  eq(docVersions.decision, 'pending'),
                ),
              )
              .all()
              .map((document) => document.id)
              .sort()
            if (
              current?.status !== 'awaiting_review' ||
              current.consumedUpstreamRunsJson !== reuse.consumedUpstreamRunsJson ||
              currentPendingIds.length !== expectedPendingIds.length ||
              currentPendingIds.some(
                (documentId, index) => documentId !== expectedPendingIds[index],
              )
            ) {
              throw new ConflictError(
                'review-refresh-stale',
                `review ${reuse.id} changed before empty-source refresh`,
              )
            }
            if (currentPendingIds.length > 0) {
              tx.delete(reviewComments)
                .where(inArray(reviewComments.docVersionId, currentPendingIds))
                .run()
              tx.update(docVersions)
                .set({
                  decision: 'superseded',
                  decisionReason: 'upstream-refreshed',
                  decidedBy: SYSTEM_DECIDER,
                  decidedAt,
                })
                .where(inArray(docVersions.id, currentPendingIds))
                .run()
            }
            tx.update(nodeRuns)
              .set({ consumedUpstreamRunsJson: consumedJson })
              .where(eq(nodeRuns.id, reuse.id))
              .run()
          } else if (reuse?.status === 'pending') {
            transitionNodeRunStatusTx({
              tx,
              nodeRunId: reuse.id,
              event: { kind: 'park-review' },
              extra: {
                startedAt: reuse.startedAt ?? decidedAt,
                consumedUpstreamRunsJson: consumedJson,
              },
            })
          } else {
            reviewNodeRunId = mintNodeRunTx(tx, {
              taskId,
              nodeId: node.id,
              status: 'awaiting_review',
              cause: 'review-park',
              iteration,
              overrides: { reviewIteration, consumedUpstreamRunsJson: consumedJson },
            })
          }
          tx.insert(nodeRunOutputs)
            .values({
              nodeRunId: reviewNodeRunId,
              portName: REVIEW_APPROVED_PORT_MULTI,
              content: '',
              kind: acceptedKind,
              archiveJson: null,
            })
            .onConflictDoUpdate({
              target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
              set: { content: '', kind: acceptedKind, archiveJson: null },
            })
            .run()
          tx.insert(nodeRunOutputs)
            .values({
              nodeRunId: reviewNodeRunId,
              portName: REVIEW_APPROVAL_META_PORT,
              content: meta,
            })
            .onConflictDoUpdate({
              target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
              set: { content: meta },
            })
            .run()
          transitionNodeRunStatusTx({
            tx,
            nodeRunId: reviewNodeRunId,
            event: { kind: 'approve-review' },
            extra: { finishedAt: decidedAt },
          })
          if (refreshAwaitingReview && taskRow.status === 'awaiting_review') {
            transitionHumanGateTaskTx({
              tx,
              taskId,
              expectedTaskRevision: taskRow.lifecycleEventRevision,
              transition: 'release-review',
              now: decidedAt,
            })
          }
          tx.insert(nodeRunEvents)
            .values({
              nodeRunId: reviewNodeRunId,
              ts: decidedAt,
              kind: 'text',
              payload: `[rfc202/review-auto-approved] ${JSON.stringify({
                rfc: 'RFC-202',
                reason: 'empty-list',
                itemCount: 0,
                sourceNodeId,
                sourcePortName,
              })}`,
            })
            .run()
        },
      })
      return {
        kind: 'ok',
        summary: `review node ${node.id} auto-approved (0 documents, empty list)`,
        message: 'review-auto-approved',
      }
    }

    const sourceSnapshotDigest = sha256Hex(
      JSON.stringify({
        sourceRunId: sourceRun.id,
        sourceNodeId,
        sourcePortName,
        upstreamKind: upstreamKind ?? null,
        documents: drafts.map((draft) => ({
          bodySha256: sha256Hex(draft.body),
          itemIndex: draft.itemIndex ?? null,
          itemPath: draft.itemPath ?? null,
          selection: draft.selection ?? null,
          selectionStale: draft.selectionStale ?? null,
          roundGeneration: draft.roundGeneration ?? null,
        })),
      }),
    )
    const collaboration = humanGateComposition.createCollaborationCommandContext({ db, appHome })
    const prepared = prepareReviewGateOpen(collaboration, {
      taskId,
      reviewNodeId: node.id,
      iteration,
      reviewIteration,
      consumedUpstreamRunsJson: consumedJson,
      sourceSnapshotDigest,
      idempotencyKey: `review-open:v1:${taskId}:${node.id}:${String(iteration)}:${String(taskRow.lifecycleEventRevision)}:${sourceSnapshotDigest}`,
      expectedTaskRevision: taskRow.lifecycleEventRevision,
      ...(reuse?.status === 'pending' ? { reusePendingNodeRunId: reuse.id } : {}),
      ...(refreshAwaitingReview
        ? {
            reuseAwaitingNodeRun: {
              id: reuse.id,
              consumedUpstreamRunsJson: reuse.consumedUpstreamRunsJson!,
            },
            supersedePendingDocumentIds: pendingReuseDocVersions.map((document) => document.id),
          }
        : {}),
      documents: drafts,
    })
    if (prepared.kind === 'prepared') {
      const executionContext = currentTaskExecutionContext(taskId)
      humanGateComposition.parkPreparedHumanGate({
        db,
        prepared: prepared.prepared,
        ...(executionContext === undefined ? {} : { executionContext }),
      })
    }
    try {
      finalizeCommittedHumanGate(collaboration, {
        operationId: prepared.operationId,
      })
    } catch (error) {
      // The DB commit is already authoritative; recovery and the read fallback
      // roll the file forward without hiding the just-committed review.
      log.warn('review-open artifact finalization deferred to recovery', {
        taskId,
        operationId: prepared.operationId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    const docs = (
      await db.select().from(docVersions).where(inArray(docVersions.id, prepared.documentIds))
    )
      .map(rowToDocVersion)
      .sort((left, right) => (left.itemIndex ?? 0) - (right.itemIndex ?? 0))
    if (docs.length !== prepared.documentIds.length) {
      throw new Error('review-open-committed-document-projection-missing')
    }
    broadcastReviewCreated(taskId, prepared.nodeRunId, node.id, docs[0]!)
    return {
      kind: 'awaiting_review',
      summary: isMultiDoc
        ? `review node ${node.id} awaiting decision (${docs.length} document${
            docs.length === 1 ? '' : 's'
          })`
        : `review node ${node.id} awaiting decision`,
      message: 'awaiting_review',
    }
  }

  let reviewNodeRunId: string
  let reviewIteration: number
  if (reuse !== undefined && reuse.status === 'awaiting_review') {
    // A live awaiting_review row is the open review for this node. Reuse it and
    // fall through to the doc_version find-or-create below, which re-broadcasts
    // the parked version (resume idempotence, B18) or mints one if it is
    // missing (e.g. the S1 repair "recreate doc_version" path). A stale-source
    // refresh has already returned through the atomic RFC-333 branch above.
    reviewNodeRunId = reuse.id
    reviewIteration = reuse.reviewIteration
  } else if (reuse !== undefined && reuse.status === 'pending') {
    // Defensive (legacy cascade-minted pending row): park it as awaiting_review.
    reviewNodeRunId = reuse.id
    reviewIteration = reuse.reviewIteration
    await transitionNodeRunStatus({
      db,
      nodeRunId: reviewNodeRunId,
      event: { kind: 'park-review' },
      extra: { startedAt: reuse.startedAt ?? Date.now() },
    })
    withTaskExecutionMutation({
      db,
      taskId,
      run: (tx) =>
        tx
          .update(nodeRuns)
          .set({ consumedUpstreamRunsJson: consumedJson })
          .where(eq(nodeRuns.id, reviewNodeRunId))
          .run(),
    })
  } else {
    // No prior review row, OR the freshest is a terminal decision against an
    // OLDER source (RFC-005 US-2 re-review: upstream re-ran after approve /
    // reject / iterate). Mint a fresh awaiting_review row carrying the prior
    // reviewIteration — same review round, re-evaluated on the new content.
    reviewIteration = reuse?.reviewIteration ?? 0
    reviewNodeRunId = await mintNodeRun(db, {
      taskId,
      nodeId: node.id,
      status: 'awaiting_review',
      cause: 'review-park',
      iteration,
      overrides: { reviewIteration, consumedUpstreamRunsJson: consumedJson },
    })
  }

  // Find any pending doc_version on this run/port. If one exists already,
  // we're being re-entered (resume after daemon restart) — no-op the create
  // and re-broadcast the parked state.
  const pendingDocVersions = await db
    .select()
    .from(docVersions)
    .where(
      and(
        eq(docVersions.reviewNodeRunId, reviewNodeRunId),
        eq(docVersions.sourcePortName, sourcePortName),
        eq(docVersions.decision, 'pending'),
      ),
    )
  if (isMultiDoc) {
    // Multi-document round: one doc_version per list item, in item order.
    let docs: DocVersion[]
    if (pendingDocVersions.length > 0) {
      // Resume after restart / awaiting-refresh re-entry — re-use the already
      // archived item set rather than re-creating it.
      docs = pendingDocVersions
        .map(rowToDocVersion)
        .sort((a, b) => (a.itemIndex ?? 0) - (b.itemIndex ?? 0))
    } else {
      docs = []
      // RFC-129: carry each document's accept/not_accept choice forward from the
      // immediately-previous round (item_path-first, item_index fallback),
      // flagging any whose content changed since the human last judged it. This
      // is the single injection point — iterate / reject / refresh / US-2 all
      // re-mint here (design §5). Empty on the first round → all unselected.
      const prior = await loadPriorRound(db, appHome, {
        taskId,
        reviewNodeId: node.id,
        iteration,
      })
      const priorLookup = buildPriorSelectionLookup(prior.members)
      // RFC-129: one generation stamp shared by every member minted in THIS round —
      // a strictly-monotonic counter (prev max + 1, immune to clock ties/rewinds;
      // Codex impl-gate P2) that loadPriorRound reads next time to isolate the
      // immediately-previous generation as a whole.
      const roundGeneration = prior.nextGeneration
      const itemCount = itemsInline ? inlineBodies.length : itemPaths.length
      for (let i = 0; i < itemCount; i++) {
        let body: string
        let itemPath: string | undefined
        if (itemsInline) {
          // RFC-081: list<markdown> — the body IS the inline content; no
          // worktree path, archived with item_path / source_file_path NULL.
          body = inlineBodies[i]!
          itemPath = undefined
        } else {
          itemPath = itemPaths[i]!
          // RFC-193: body from the emit-time archive (index-aligned with
          // splitListItems — the runner archived per line). A missing item
          // must not wedge the whole round — the reviewer can still reject
          // it; keep the RFC-079 placeholder wording (tests anchor on it).
          const artItem = artifactRead.items[i]
          body =
            artItem !== undefined && artItem.source !== 'missing'
              ? artItem.body
              : `> ⚠️ RFC-079: file not found in worktree: \`${itemPath}\``
        }
        // RFC-129: inherit this item's selection from the prior round
        // (path-first / index fallback), stale-flagged when its content changed.
        // New items (no prior match) stay unselected — byte-identical to the old
        // default; on the first round priorLookup is empty so every item is new.
        const inh = inheritSelection(
          { itemIndex: i, itemPath: itemPath ?? null, body },
          priorLookup,
        )
        const dv = await createDocVersion({
          db,
          appHome,
          taskId,
          reviewNodeId: node.id,
          reviewNodeRunId,
          sourceNodeId,
          sourcePortName,
          reviewIteration,
          body,
          ...(itemPath !== undefined ? { sourceFilePath: itemPath, itemPath } : {}),
          itemIndex: i,
          selection: inh.selection,
          selectionStale: inh.stale,
          roundGeneration,
        })
        docs.push(dv)
      }
    }
    // RFC-202 T1: an EMPTY upstream list means "zero findings" — that is the
    // success case of the Code→Audit→Fix workflow, not something a human can
    // review. The old behavior parked an empty round, which was unreachable
    // from every UI entry (no doc_versions → invisible in the inbox, detail
    // 404s, canvas nav null) and undecidable via the API (submitReviewDecision
    // 409s on zero pending rows) — the task wedged in awaiting_review forever.
    // Auto-approve instead: publish the same empty `accepted` +
    // `approval_meta` an empty-subset human approval would emit
    // (approveMultiDocReview semantics), close the run, and let the scheduler
    // continue downstream. Wedged legacy rounds heal here too: S1 repair /
    // resume re-enters this dispatch with pendingDocVersions=[] and falls
    // into this branch.
    if (docs.length === 0) {
      const decidedAt = Date.now()
      const acceptedKind = itemsInline ? 'list<markdown>' : 'list<path<md>>'
      // RFC-099 prompt isolation: approval_meta is a downstream-consumable
      // port — no decider identity; `auto` marks the framework decision.
      const meta = JSON.stringify({
        decision: 'approved',
        decidedAt,
        reviewIteration,
        sourceNodeId,
        sourcePortName,
        itemCount: 0,
        acceptedCount: 0,
        acceptedItemIndices: [],
        auto: 'empty-list',
      })
      withTaskExecutionTransaction({
        db,
        taskId,
        run: (tx) => {
          tx.insert(nodeRunOutputs)
            .values({
              nodeRunId: reviewNodeRunId,
              portName: REVIEW_APPROVED_PORT_MULTI,
              content: '',
              kind: acceptedKind,
              archiveJson: null,
            })
            .onConflictDoUpdate({
              target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
              set: { content: '', kind: acceptedKind, archiveJson: null },
            })
            .run()
          tx.insert(nodeRunOutputs)
            .values({
              nodeRunId: reviewNodeRunId,
              portName: REVIEW_APPROVAL_META_PORT,
              content: meta,
            })
            .onConflictDoUpdate({
              target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
              set: { content: meta },
            })
            .run()
          transitionNodeRunStatusTx({
            tx,
            nodeRunId: reviewNodeRunId,
            event: { kind: 'approve-review' },
            extra: { finishedAt: decidedAt },
          })
          // Persistent, user-visible audit record (node drawer "events" tab) —
          // the dispatch summary string is discarded by runScope and node_runs
          // has no summary column, so this event is the durable trace.
          tx.insert(nodeRunEvents)
            .values({
              nodeRunId: reviewNodeRunId,
              ts: decidedAt,
              kind: 'text',
              payload: `[rfc202/review-auto-approved] ${JSON.stringify({
                rfc: 'RFC-202',
                reason: 'empty-list',
                itemCount: 0,
                sourceNodeId,
                sourcePortName,
              })}`,
            })
            .run()
        },
      })
      return {
        kind: 'ok',
        summary: `review node ${node.id} auto-approved (0 documents, empty list)`,
        message: 'review-auto-approved',
      }
    }
    // One broadcast is enough — the WS event just triggers an inbox/detail
    // refetch that pulls the whole document set.
    broadcastReviewCreated(taskId, reviewNodeRunId, node.id, docs[0]!)
    return {
      kind: 'awaiting_review',
      summary: `review node ${node.id} awaiting decision (${docs.length} document${
        docs.length === 1 ? '' : 's'
      })`,
      message: 'awaiting_review',
    }
  }

  // Single-document (unchanged).
  let docVersion: DocVersion
  if (pendingDocVersions.length > 0) {
    docVersion = rowToDocVersion(pendingDocVersions[0]!)
  } else {
    docVersion = await createDocVersion({
      db,
      appHome,
      taskId,
      reviewNodeId: node.id,
      reviewNodeRunId,
      sourceNodeId,
      sourcePortName,
      reviewIteration,
      body: resolvedBody,
      ...(resolvedSourcePath !== undefined ? { sourceFilePath: resolvedSourcePath } : {}),
    })
  }

  broadcastReviewCreated(taskId, reviewNodeRunId, node.id, docVersion)
  return {
    kind: 'awaiting_review',
    summary: `review node ${node.id} awaiting decision`,
    message: 'awaiting_review',
  }
}

// ---------------------------------------------------------------------------
// doc_version create + body I/O.
// ---------------------------------------------------------------------------

export interface CreateDocVersionArgs {
  db: DbClient
  appHome: string
  taskId: string
  reviewNodeId: string
  reviewNodeRunId: string
  sourceNodeId: string
  sourcePortName: string
  reviewIteration: number
  body: string
  /** Optional snapshot of the prompt that produced this version. */
  promptSnapshot?: string
  /**
   * Worktree-relative path the body was read from, when the upstream port
   * resolved as a markdown_file (or the forgiveness branch silently read a
   * `.md` file). Surfaced in the iterate re-run prompt so the agent knows
   * which file the comments target. Undefined when the source was inline.
   */
  sourceFilePath?: string
  /**
   * RFC-079 multi-document mode: 0-based item index within the round. When
   * set, the version sequence is keyed per-item and the row carries
   * item_index / item_path / selection. Undefined ⇒ single-document row
   * (all three columns NULL — legacy behavior unchanged).
   */
  itemIndex?: number
  /** RFC-079: worktree-relative path of this list member. */
  itemPath?: string
  /** RFC-079: initial per-document selection (defaults to 'unselected'). */
  selection?: 'unselected' | 'accepted' | 'not_accepted'
  /**
   * RFC-129: initial cross-round inheritance staleness for a multi-document
   * member (defaults to false). Ignored on single-document rows (itemIndex
   * undefined → column NULL). See loadPriorRoundMembers / inheritSelection.
   */
  selectionStale?: boolean
  /**
   * RFC-129: per-mint monotonic generation counter (see schema.ts / loadPriorRound).
   * The dispatchReviewNode mint loop passes the same value (prev max + 1) to every
   * item's create; undefined on single-document rows → column NULL.
   */
  roundGeneration?: number
}

async function createDocVersion(args: CreateDocVersionArgs): Promise<DocVersion> {
  // RFC-079 (risk #1): version sequence is per (reviewNodeRun, sourcePort) for
  // single-doc, but per (reviewNodeRun, sourcePort, item_index) in multi-doc —
  // otherwise N items sharing a sourcePort would pollute each other's
  // versionIndex. Single-doc rows match on item_index IS NULL, preserving the
  // exact legacy sequence.
  const existing = await args.db
    .select({ versionIndex: docVersions.versionIndex })
    .from(docVersions)
    .where(
      and(
        eq(docVersions.reviewNodeRunId, args.reviewNodeRunId),
        eq(docVersions.sourcePortName, args.sourcePortName),
        args.itemIndex !== undefined
          ? eq(docVersions.itemIndex, args.itemIndex)
          : isNull(docVersions.itemIndex),
      ),
    )
    .orderBy(desc(docVersions.versionIndex))
    .limit(1)
  const nextVersion = (existing[0]?.versionIndex ?? 0) + 1

  const bodyPath = docVersionRelativePath(
    args.taskId,
    args.reviewNodeId,
    args.sourcePortName,
    nextVersion,
    args.itemIndex,
  )
  const absPath = join(args.appHome, bodyPath)
  mkdirSync(dirname(absPath), { recursive: true })
  writeFileSync(absPath, args.body, 'utf8')

  const id = ulid()
  const now = Date.now()
  const sourceFilePath = args.sourceFilePath ?? null
  // RFC-079: multi-document fields. Single-document rows (itemIndex undefined)
  // store NULL for all three — the system-wide single-doc discriminator.
  const itemIndex = args.itemIndex ?? null
  const itemPath = args.itemPath ?? null
  const selection: 'unselected' | 'accepted' | 'not_accepted' | null =
    args.itemIndex !== undefined ? (args.selection ?? 'unselected') : null
  // RFC-129: single-document rows keep NULL (single-doc discriminator); a
  // multi-document member carries its inherited staleness (default false).
  const selectionStale: boolean | null =
    args.itemIndex !== undefined ? (args.selectionStale ?? false) : null
  await args.db.insert(docVersions).values({
    id,
    taskId: args.taskId,
    reviewNodeId: args.reviewNodeId,
    reviewNodeRunId: args.reviewNodeRunId,
    sourceNodeId: args.sourceNodeId,
    sourcePortName: args.sourcePortName,
    versionIndex: nextVersion,
    reviewIteration: args.reviewIteration,
    bodyPath,
    commentsJson: '[]',
    decision: 'pending',
    decisionReason: null,
    promptSnapshot: args.promptSnapshot ?? null,
    sourceFilePath,
    itemIndex,
    selection,
    itemPath,
    selectionStale,
    // RFC-129: internal generation stamp (not surfaced on the DocVersion DTO).
    roundGeneration: args.roundGeneration ?? null,
    decidedAt: null,
    decidedBy: null,
    createdAt: now,
  })

  return {
    id,
    taskId: args.taskId,
    reviewNodeId: args.reviewNodeId,
    reviewNodeRunId: args.reviewNodeRunId,
    sourceNodeId: args.sourceNodeId,
    sourcePortName: args.sourcePortName,
    versionIndex: nextVersion,
    reviewIteration: args.reviewIteration,
    bodyPath,
    commentsJson: '[]',
    decision: 'pending',
    decisionReason: null,
    promptSnapshot: args.promptSnapshot ?? null,
    sourceFilePath,
    itemIndex,
    selection,
    itemPath,
    selectionStale,
    decidedAt: null,
    decidedBy: null,
    createdAt: now,
  }
}

/**
 * RFC-129: load the IMMEDIATELY-PREVIOUS multi-document review round's members
 * for a review node (design §3) AND the next generation stamp to mint with.
 * Spans node_runs (covers US-2's fresh run) but is scoped to one workflow
 * `iteration` so loop passes stay independent.
 *
 * The prior generation is the rows with the MAX `round_generation` — a per-mint
 * strictly-monotonic counter (this function returns `nextGeneration = maxGen + 1`,
 * which the mint stamps on every member so the key can never tie or rewind, cf.
 * Date.now(); Codex impl-gate P2). At the mint injection point the current round's
 * rows do not exist yet, so the highest round_generation present is always the
 * immediately-previous round. Taking a whole generation — rather than
 * newest-row-per-item_index — is what keeps a refresh/US-2 that dropped then
 * later re-added a document from resurrecting an older generation's selection
 * (AC-11): two generations can share a review_iteration, but never a
 * round_generation. Rows with a NULL round_generation (pre-RFC-129 upgrade-window
 * data) are skipped — they do not inherit, and `nextGeneration` restarts at 1.
 */
async function loadPriorRound(
  db: DbClient,
  appHome: string,
  args: { taskId: string; reviewNodeId: string; iteration: number },
): Promise<{ members: PriorRoundMember[]; nextGeneration: number }> {
  // Review node_runs at this workflow iteration (spans reruns + US-2 fresh run).
  const runIds = (
    await db
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, args.taskId),
          eq(nodeRuns.nodeId, args.reviewNodeId),
          eq(nodeRuns.iteration, args.iteration),
        ),
      )
  ).map((r) => r.id)
  if (runIds.length === 0) return { members: [], nextGeneration: 1 }
  const rows = (
    await db
      .select()
      .from(docVersions)
      .where(
        and(
          eq(docVersions.reviewNodeId, args.reviewNodeId),
          inArray(docVersions.reviewNodeRunId, runIds),
        ),
      )
  ).filter((r) => r.itemIndex !== null && r.roundGeneration !== null)
  if (rows.length === 0) return { members: [], nextGeneration: 1 }
  // The immediately-previous generation = rows carrying the max round_generation;
  // the next mint takes maxGen + 1 so the stamp is a strictly-monotonic counter
  // (no Date.now() ties/rewinds — Codex impl-gate P2). Scoped to this iteration.
  const maxGen = Math.max(...rows.map((r) => r.roundGeneration as number))
  // A mint creates each item_index exactly once, so within one generation
  // item_index is unique; dedup by newest id defensively (belt-and-suspenders).
  const byIndex = new Map<number, (typeof rows)[number]>()
  for (const r of rows) {
    if (r.roundGeneration !== maxGen) continue
    const idx = r.itemIndex as number
    const cur = byIndex.get(idx)
    if (cur === undefined || r.id > cur.id) byIndex.set(idx, r)
  }
  const members: PriorRoundMember[] = []
  const collaboration = humanGateComposition.createCollaborationCommandContext({ db, appHome })
  for (const r of byIndex.values()) {
    let body = ''
    try {
      body = readCommittedReviewArtifactBody(collaboration, r.bodyPath)
    } catch {
      // Missing prior body → treat as "" so any real new content compares as
      // changed (conservative: prefer an extra stale flag over a silent carry).
      body = ''
    }
    members.push({
      itemIndex: r.itemIndex as number,
      itemPath: r.itemPath,
      selection: (r.selection ?? 'unselected') as PriorRoundMember['selection'],
      selectionStale: r.selectionStale ?? false,
      body,
    })
  }
  return { members, nextGeneration: maxGen + 1 }
}

export function readDocVersionBody(db: DbClient, appHome: string, docVersion: DocVersion): string {
  try {
    return readCommittedReviewArtifactBody(
      humanGateComposition.createCollaborationCommandContext({ db, appHome }),
      docVersion.bodyPath,
    )
  } catch {
    const abs = join(appHome, docVersion.bodyPath)
    throw new NotFoundError('doc-version-body-missing', `doc_version body file not found: ${abs}`)
  }
}

// ---------------------------------------------------------------------------
// RFC-149: review round mode — decision-side single source of truth.
// ---------------------------------------------------------------------------

/**
 * Resolve a review round's mode from its doc_versions rows (RFC-149 §2).
 * DECISION-side oracle only: dispatch (dispatchReviewNode) derives the mode
 * from the upstream port KIND — it is the producer of these rows and stays
 * kind-driven — while every reader that used to re-derive the mode from the
 * archived data shape (item_index / item_path NULL sentinels) goes through
 * here instead of hand-rolling the sentinels.
 *
 *   - 'single'       — no member carries item_index (single-document round)
 *   - 'multi-inline' — multi-document, items are INLINE markdown bodies
 *                      (list<markdown>: item_path NULL on every member)
 *   - 'multi-path'   — multi-document, items are worktree paths
 *                      (list<path<md>>: item_path set)
 *
 * Empty array ⇒ 'single' (`some` over [] is false — callers reject empty
 * rounds before the mode matters; the grid is locked in
 * rfc149-decision-policy.test.ts).
 */
export function resolveReviewRoundMode(
  dvs: ReadonlyArray<{ itemIndex?: number | null; itemPath?: string | null }>,
): 'single' | 'multi-inline' | 'multi-path' {
  const isMultiDoc = dvs.some((d) => d.itemIndex !== null && d.itemIndex !== undefined)
  if (!isMultiDoc) return 'single'
  const itemsInline = dvs.length > 0 && dvs.every((d) => (d.itemPath ?? null) === null)
  return itemsInline ? 'multi-inline' : 'multi-path'
}

// ---------------------------------------------------------------------------
// REST helpers — list / detail / counters.
// ---------------------------------------------------------------------------

export interface ListReviewSummariesFilter {
  status?: 'pending' | 'all' | 'approved' | 'rejected' | 'iterated'
  taskId?: string
  workflowId?: string
  limit?: number
}

/**
 * RFC-158: parse one task's `workflowSnapshot` for its review nodes'
 * editor-set title/description. Corrupt JSON → empty map (callers fall back to
 * nodeId / empty). Extracted so listReviewSummaries and getReviewDetail share
 * one parse.
 */
function parseReviewNodeMeta(
  workflowSnapshot: string,
): Map<string, { title: string; description: string }> {
  const meta = new Map<string, { title: string; description: string }>()
  try {
    const def = JSON.parse(workflowSnapshot) as WorkflowDefinition
    for (const node of def.nodes ?? []) {
      if ((node as { kind?: string }).kind !== 'review') continue
      const n = node as Record<string, unknown>
      const title = typeof n.title === 'string' ? n.title : ''
      const description = typeof n.description === 'string' ? n.description : ''
      meta.set(node.id, { title, description })
    }
  } catch {
    // corrupt snapshot — leave meta empty.
  }
  return meta
}

/**
 * RFC-158: assemble ONE ReviewSummary from an already-selected latest-per-port
 * doc_version + its run / task / workflow / node meta. Extracted so
 * getReviewDetail can build a summary directly by nodeRunId instead of scanning
 * the global `listReviewSummaries(limit)` (which silently 404'd a review whose
 * versions fell out of the newest-500 window — the pre-RFC-158 latent bug).
 */
function assembleReviewSummary(
  dv: typeof docVersions.$inferSelect,
  run: Pick<typeof nodeRuns.$inferSelect, 'status' | 'reviewIteration' | 'shardKey'>,
  task: Pick<typeof tasks.$inferSelect, 'id' | 'name' | 'workflowId' | 'status'>,
  wf: Pick<typeof workflows.$inferSelect, 'name'>,
  nodeMeta: { title: string; description: string } | undefined,
): ReviewSummary {
  const awaitingReview = run.status === 'awaiting_review' && dv.decision === 'pending'
  const titleTrimmed = nodeMeta?.title.trim() ?? ''
  return {
    nodeRunId: dv.reviewNodeRunId,
    taskId: dv.taskId,
    // RFC-037: required taskName from tasks.name.
    taskName: task.name,
    workflowId: task.workflowId,
    workflowName: wf.name,
    reviewNodeId: dv.reviewNodeId,
    title: titleTrimmed !== '' ? nodeMeta!.title : dv.reviewNodeId,
    description: nodeMeta?.description ?? '',
    currentVersionIndex: dv.versionIndex,
    reviewIteration: run.reviewIteration,
    decision: dv.decision as DocVersionDecision,
    awaitingReview,
    shardKey: run.shardKey,
    // RFC-079: a non-NULL item_index marks this review as a multi-document
    // round (the inbox tags it + routes into the document-list view).
    isMultiDoc: resolveReviewRoundMode([dv]) !== 'single',
    createdAt: dv.createdAt,
    decidedAt: dv.decidedAt,
  }
}

export async function listReviewSummaries(
  db: DbClient,
  filter: ListReviewSummariesFilter = {},
): Promise<ReviewSummary[]> {
  // Join doc_versions ↔ nodeRuns ↔ tasks ↔ workflows. We do it manually with
  // separate selects to keep things composable across drizzle limitations on
  // SQLite multi-join.
  //
  // RFC-202 T6: the PENDING (inbox) query must apply its predicates BEFORE
  // any pagination window — the old unconditional `.limit()` on raw
  // doc_versions let a page of terminal-task zombies push actionable rounds
  // out of the window entirely (Codex design-gate P1). For pending we fetch
  // the pending rows via SQL predicate (bounded set), filter, and apply the
  // limit at the very end; historical queries keep the original shape.
  const isPendingQuery = filter.status === 'pending'
  const dvRows = isPendingQuery
    ? await db
        .select()
        .from(docVersions)
        .where(eq(docVersions.decision, 'pending'))
        .orderBy(desc(docVersions.createdAt))
    : await db
        .select()
        .from(docVersions)
        .orderBy(desc(docVersions.createdAt))
        .limit(filter.limit ?? 100)

  if (dvRows.length === 0) return []

  // RFC-311: point lookups for exactly the referenced rows. The previous shape
  // pulled node_runs, tasks and workflows COMPLETE (all columns — prompt_text,
  // workflow_snapshot, every *_json) and filtered in JS; on the 15s inbox
  // badge poll that materialized three whole tables per open tab (audit L1-1).
  const nodeRunIds = Array.from(new Set(dvRows.map((r) => r.reviewNodeRunId)))
  const nodeRunRows = await chunkedAll(nodeRunIds, (ids) =>
    db
      .select({
        id: nodeRuns.id,
        status: nodeRuns.status,
        reviewIteration: nodeRuns.reviewIteration,
        shardKey: nodeRuns.shardKey,
      })
      .from(nodeRuns)
      .where(inArray(nodeRuns.id, ids)),
  )
  const runById = new Map(nodeRunRows.map((r) => [r.id, r]))
  const taskIds = Array.from(new Set(dvRows.map((r) => r.taskId)))
  const taskRows = await chunkedAll(taskIds, (ids) =>
    db
      .select({
        id: tasks.id,
        name: tasks.name,
        workflowId: tasks.workflowId,
        status: tasks.status,
        workflowSnapshot: tasks.workflowSnapshot,
      })
      .from(tasks)
      .where(inArray(tasks.id, ids)),
  )
  const taskById = new Map(taskRows.map((r) => [r.id, r]))
  const workflowIds = Array.from(new Set(taskRows.map((t) => t.workflowId)))
  const wfRows = await chunkedAll(workflowIds, (ids) =>
    db
      .select({ id: workflows.id, name: workflows.name })
      .from(workflows)
      .where(inArray(workflows.id, ids)),
  )
  const wfById = new Map(wfRows.map((r) => [r.id, r]))

  // Parse each task's workflowSnapshot once to extract the per-review-node
  // human-readable title/description set in the workflow editor. Falls back
  // to {} on corrupt JSON; the per-row lookup then degrades to nodeId/empty.
  const reviewNodeMetaByTask = new Map<
    string,
    Map<string, { title: string; description: string }>
  >()
  for (const task of taskById.values()) {
    reviewNodeMetaByTask.set(task.id, parseReviewNodeMeta(task.workflowSnapshot))
  }

  // Pick only the latest doc_version per (reviewNodeRunId, sourcePortName);
  // historical pending=false versions live in the history dropdown not the
  // pending inbox.
  const latestPerRun = new Map<string, (typeof dvRows)[number]>()
  for (const dv of dvRows) {
    const key = `${dv.reviewNodeRunId}:${dv.sourcePortName}`
    const prev = latestPerRun.get(key)
    if (prev === undefined || dv.versionIndex > prev.versionIndex) latestPerRun.set(key, dv)
  }

  const out: ReviewSummary[] = []
  for (const dv of latestPerRun.values()) {
    const run = runById.get(dv.reviewNodeRunId)
    if (run === undefined) continue
    const task = taskById.get(dv.taskId)
    if (task === undefined) continue
    const wf = wfById.get(task.workflowId)
    if (wf === undefined) continue
    const awaitingReview = run.status === 'awaiting_review' && dv.decision === 'pending'
    // RFC-202 T6: dead tasks' rounds leave the pending inbox. done/canceled
    // are hard-sealed by the terminal sweep; failed/interrupted are revivable
    // and only filtered here (they reappear if the task is resumed).
    if (isPendingQuery && (TERMINAL_TASK_STATUSES as readonly string[]).includes(task.status)) {
      continue
    }
    if (filter.status !== undefined && filter.status !== 'all') {
      if (filter.status === 'pending' && !awaitingReview) continue
      if (filter.status === 'approved' && dv.decision !== 'approved') continue
      if (filter.status === 'rejected' && dv.decision !== 'rejected') continue
      if (filter.status === 'iterated' && dv.decision !== 'iterated') continue
    }
    if (filter.taskId !== undefined && filter.taskId !== task.id) continue
    if (filter.workflowId !== undefined && filter.workflowId !== task.workflowId) continue
    const nodeMeta = reviewNodeMetaByTask.get(task.id)?.get(dv.reviewNodeId)
    out.push(assembleReviewSummary(dv, run, task, wf, nodeMeta))
  }
  // RFC-202 T6: pending pagination happens AFTER filtering (see above).
  return isPendingQuery ? out.slice(0, filter.limit ?? 100) : out
}

/**
 * RFC-311 — badge count as ONE indexed SQL statement. Mirrors the pending
 * branch of `listReviewSummaries` predicate-for-predicate:
 *   dv.decision='pending'                       (partial idx_doc_versions_pending_created)
 *   latest pending version per (run, port)      (NOT EXISTS newer pending sibling)
 *   run exists ∧ status='awaiting_review'       (awaitingReview requirement)
 *   task exists ∧ status ∉ TERMINAL             (RFC-202 T6 zombie filter)
 *   workflow exists                             (assemble skips orphan workflows)
 * plus the route-level per-actor visibility (`filterVisibleByTask`) folded in
 * via `taskAuthorizationCondition` when an actor is passed. The oracle test
 * (rfc311-badge-counts) locks this count to the list+filter pipeline's length.
 */
export async function countPendingReviews(db: DbClient, actor?: Actor): Promise<number> {
  const newer = alias(docVersions, 'dv_newer')
  const conditions = [
    eq(docVersions.decision, 'pending'),
    notExists(
      db
        .select({ one: sql`1` })
        .from(newer)
        .where(
          and(
            eq(newer.reviewNodeRunId, docVersions.reviewNodeRunId),
            eq(newer.sourcePortName, docVersions.sourcePortName),
            eq(newer.decision, 'pending'),
            gt(newer.versionIndex, docVersions.versionIndex),
          ),
        ),
    ),
  ]
  if (actor !== undefined) {
    conditions.push(
      taskAuthorizationCondition(db, { id: tasks.id, ownerUserId: tasks.ownerUserId }, actor),
    )
  }
  const rows = await db
    .select({ n: count() })
    .from(docVersions)
    .innerJoin(
      nodeRuns,
      and(eq(nodeRuns.id, docVersions.reviewNodeRunId), eq(nodeRuns.status, 'awaiting_review')),
    )
    .innerJoin(
      tasks,
      and(eq(tasks.id, docVersions.taskId), notInArray(tasks.status, [...TERMINAL_TASK_STATUSES])),
    )
    .innerJoin(workflows, eq(workflows.id, tasks.workflowId))
    .where(and(...conditions))
  return rows[0]?.n ?? 0
}

export async function getReviewDetail(
  db: DbClient,
  appHome: string,
  nodeRunId: string,
): Promise<ReviewDetail> {
  const allRows = await db
    .select()
    .from(docVersions)
    .where(eq(docVersions.reviewNodeRunId, nodeRunId))
  if (allRows.length === 0) {
    throw new NotFoundError('review-not-found', `no doc_versions for ${nodeRunId}`)
  }
  // RFC-158: build the summary DIRECTLY by nodeRunId (run → task → workflow →
  // node meta), not by scanning `listReviewSummaries(limit: 500)` — the global
  // newest-500 window silently 404'd any review whose doc_versions aged out of
  // it. Latest-per-port row (max versionIndex) drives the summary, matching the
  // list's `latestPerRun` selection.
  const summaryRunRows = await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1)
  const summaryRun = summaryRunRows[0]
  if (summaryRun === undefined) {
    throw new NotFoundError('review-not-found', `node run ${nodeRunId} not found`)
  }
  const summaryTaskRows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.id, summaryRun.taskId))
    .limit(1)
  const summaryTask = summaryTaskRows[0]
  if (summaryTask === undefined) {
    throw new NotFoundError('review-not-found', `task ${summaryRun.taskId} not found`)
  }
  const summaryWfRows = await db
    .select()
    .from(workflows)
    .where(eq(workflows.id, summaryTask.workflowId))
    .limit(1)
  const summaryWf = summaryWfRows[0]
  if (summaryWf === undefined) {
    throw new NotFoundError('review-not-found', `workflow ${summaryTask.workflowId} not found`)
  }
  const summaryDv = allRows.slice().sort((a, b) => b.versionIndex - a.versionIndex)[0]!
  const summaryNodeMeta = parseReviewNodeMeta(summaryTask.workflowSnapshot).get(
    summaryDv.reviewNodeId,
  )
  const summary = assembleReviewSummary(
    summaryDv,
    summaryRun,
    summaryTask,
    summaryWf,
    summaryNodeMeta,
  )
  // RFC-079: multi-document mode (any member carries item_index). Build the
  // document list and default the rendered "current" document to the first
  // item; the frontend lazy-loads other items via the versions endpoint.
  // RFC-158: ONE current-round selector, shared with the task-detail canvas nav
  // oracle (getTaskNodeRuns), so "the node is clickable" and "the bare route
  // renders this version" can never diverge. `allRows.length > 0` was just
  // asserted, so the selector is non-null.
  const isMulti = resolveReviewRoundMode(allRows) !== 'single'
  const round = selectCurrentReviewRound(allRows)!
  const dv: DocVersion = rowToDocVersion(round.representative)
  // RFC-158 (R6): tolerate a missing/pruned body file on BOTH branches (the
  // multi-doc path already did) — otherwise a single-doc review with a GC'd
  // body file throws `doc-version-body-missing`, breaking the nav oracle's
  // "has doc_version ⟹ renders" invariant.
  let body: string
  try {
    body = readDocVersionBody(db, appHome, dv)
  } catch {
    body = ''
  }
  let documents: ReviewDocumentSummary[] | undefined
  if (isMulti) {
    // RFC-142 (G4): "newest round" respects RFC-129 round_generation (a refresh
    // leaves two generations at one reviewIteration). selectCurrentReviewRound
    // encapsulates that pending-first-else-newest-gen selection.
    documents = []
    for (const m of round.members) {
      documents.push((await buildRoundMember(db, appHome, m)).summary)
    }
  }
  // RFC-142 (Codex impl-gate P2): decided versions must read the FROZEN
  // comment snapshot — the live rows are deleted at decision time, so the old
  // live-only read rendered a decided round's first document (and a decided
  // single-doc current view) with an empty comment pane while the navigator
  // badge counted the archive.
  const comments = await commentsForDocVersion(db, dv)

  // Reach for the review node's per-node rerunnable configs.
  const taskRows = await db.select().from(tasks).where(eq(tasks.id, summary.taskId)).limit(1)
  const taskRow = taskRows[0]
  let rerunnableOnReject: string[] = []
  let rerunnableOnIterate: string[] = []
  if (taskRow !== undefined) {
    try {
      const def = JSON.parse(taskRow.workflowSnapshot) as WorkflowDefinition
      const node = def.nodes.find((n) => n.id === summary.reviewNodeId)
      if (node !== undefined) {
        const cfgReject = (node as Record<string, unknown>).rerunnableOnReject
        const cfgIterate = (node as Record<string, unknown>).rerunnableOnIterate
        if (Array.isArray(cfgReject))
          rerunnableOnReject = cfgReject.filter((s): s is string => typeof s === 'string')
        if (Array.isArray(cfgIterate))
          rerunnableOnIterate = cfgIterate.filter((s): s is string => typeof s === 'string')
      }
    } catch {
      // workflowSnapshot corrupt — leave both as empty; UI will degrade gracefully
    }
  }

  return {
    summary,
    currentVersion: dv,
    currentBody: body,
    comments,
    rerunnableOnReject,
    rerunnableOnIterate,
    ...(documents !== undefined ? { documents } : {}),
  }
}

export async function listDocVersionsForReview(
  db: DbClient,
  nodeRunId: string,
): Promise<DocVersion[]> {
  const rows = await db
    .select()
    .from(docVersions)
    .where(eq(docVersions.reviewNodeRunId, nodeRunId))
    .orderBy(desc(docVersions.versionIndex))
  return rows.map(rowToDocVersion)
}

export async function getDocVersion(db: DbClient, versionId: string): Promise<DocVersion | null> {
  const rows = await db.select().from(docVersions).where(eq(docVersions.id, versionId)).limit(1)
  return rows.length > 0 ? rowToDocVersion(rows[0]!) : null
}

/**
 * RFC-013: fetch a single doc_version's body + the comments captured
 * against that specific version. The route layer uses this to power the
 * historical-version read-only view in the /reviews UI.
 *
 * Returns null when the version does not exist OR exists but does not belong
 * to `nodeRunId`. The nodeRunId scoping is deliberate — without it, the
 * endpoint would let a caller probe doc_versions across unrelated reviews by
 * brute-forcing ULIDs.
 *
 * Comment source per decision state: see `commentsForDocVersion` (pending →
 * live rows, decided → frozen commentsJson; anchor-sorted; empty when none).
 */
export async function getDocVersionDetail(
  db: DbClient,
  appHome: string,
  nodeRunId: string,
  versionId: string,
): Promise<(DocVersion & { body: string; comments: ReviewComment[] }) | null> {
  const dv = await getDocVersion(db, versionId)
  if (dv === null) return null
  if (dv.reviewNodeRunId !== nodeRunId) return null
  const body = readDocVersionBody(db, appHome, dv)
  const comments = await commentsForDocVersion(db, dv)
  return { ...dv, body, comments }
}

/**
 * Comment source per decision state — the SINGLE rule shared by
 * getReviewDetail / getDocVersionDetail / buildRoundMember (RFC-142, Codex
 * impl-gate P2 unified the three forks):
 *   - `pending` → live `review_comments` rows (the user is annotating it);
 *   - decided   → parse the frozen `commentsJson` snapshot
 *                 (`submitReviewDecision` deletes the live rows at decision
 *                 time, so the archive is the only remaining source).
 * Sorted by anchor position (paragraph index, then offset) either way.
 */
async function commentsForDocVersion(
  db: DbClient,
  dv: { id: string; decision: string; commentsJson: string },
): Promise<ReviewComment[]> {
  if (dv.decision === 'pending') {
    const rows = await db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.docVersionId, dv.id))
      .orderBy(asc(reviewComments.anchorParagraphIdx), asc(reviewComments.anchorOffsetStart))
    return rows.map(rowToReviewComment)
  }
  const comments = parseArchivedComments(dv.commentsJson)
  comments.sort((a, b) => {
    if (a.anchor.paragraphIdx !== b.anchor.paragraphIdx) {
      return a.anchor.paragraphIdx - b.anchor.paragraphIdx
    }
    return a.anchor.offsetStart - b.anchor.offsetStart
  })
  return comments
}

/**
 * Robust-parse the archived comments blob stored on `doc_versions.commentsJson`.
 *
 * `submitReviewDecision` writes `JSON.stringify(commentsArr)` here at the
 * moment of approve / reject / iterate, so a well-formed row should round-trip
 * via JSON.parse. We still guard against three realistic failure modes that
 * would otherwise crash the read-only view:
 *
 *   1. Empty / null / non-string column (legacy rows written before commentsJson
 *      was always populated) → treat as empty.
 *   2. JSON that doesn't parse (manual DB tampering, partial write) → log
 *      and treat as empty rather than 500ing the whole detail endpoint.
 *   3. JSON that parses to a non-array → treat as empty.
 *
 * Anchor shape mismatches inside individual entries fall through to runtime
 * type errors at the route serializer; we don't filter per-entry because
 * the writer side controls the shape and any drift there is a real bug.
 */
function parseArchivedComments(json: string | null | undefined): ReviewComment[] {
  if (json === null || json === undefined || json.length === 0 || json === '[]') return []
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed as ReviewComment[]
  } catch (err) {
    log.warn('doc_versions.commentsJson is not valid JSON; returning empty', {
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}

// ---------------------------------------------------------------------------
// RFC-142: multi-document review rounds.
// ---------------------------------------------------------------------------

/**
 * RFC-142: build one document's list-entry summary + its member-level
 * decision. Shared by getReviewDetail's current-round `documents` and the
 * /rounds member lists — extracted so the two constructions never fork.
 *
 * commentCount follows `commentsForDocVersion`'s single rule: pending → live
 * review_comments rows; decided → the frozen commentsJson snapshot
 * (submitReviewDecision deletes the live rows, so counting them yielded a
 * constant 0 for every decided round — fixed here).
 */
async function buildRoundMember(
  db: DbClient,
  appHome: string,
  m: typeof docVersions.$inferSelect,
): Promise<{ summary: ReviewDocumentSummary; decision: DocVersionDecision }> {
  const mdv = rowToDocVersion(m)
  let mbody = ''
  try {
    mbody = readDocVersionBody(db, appHome, mdv)
  } catch {
    mbody = ''
  }
  const commentCount = (await commentsForDocVersion(db, m)).length
  return {
    summary: {
      docVersionId: m.id,
      itemIndex: m.itemIndex ?? 0,
      itemPath: m.itemPath ?? '',
      title: extractDocTitle(mbody, m.itemPath ?? m.id),
      selection: (m.selection ?? 'unselected') as 'unselected' | 'accepted' | 'not_accepted',
      commentCount,
      // RFC-129: inherited selection whose content changed since the human
      // last judged it → "已变更" badge (advisory only; approve unaffected).
      stale: m.selectionStale === true,
    },
    decision: m.decision as DocVersionDecision,
  }
}

/**
 * Minimal doc_versions row slice `groupDocVersionRounds` needs. Structurally
 * satisfied by drizzle's full row; tests can hand-build these (pure, no IO).
 */
export interface RoundGroupRow {
  id: string
  reviewIteration: number
  roundGeneration: number | null
  itemIndex: number | null
  decision: string
  decisionReason: string | null
  decidedAt: number | null
  decidedBy: string | null
  decidedByRole: string | null
  createdAt: number
}

export interface DocVersionRound<R extends RoundGroupRow> {
  roundKey: string
  reviewIteration: number
  roundGeneration: number | null
  decision: DocVersionDecision
  decisionReason: string | null
  decidedAt: number | null
  decidedBy: string | null
  decidedByRole: TaskActorRole | null
  createdAt: number
  isCurrent: boolean
  /** item_index ascending. */
  members: R[]
  /** Diagnostics only: members disagree on decision (writer stamps a whole round at once). */
  hasMixedDecisions: boolean
}

/**
 * RFC-142: group a review's doc_versions rows into rounds (pure, exported for
 * unit tests).
 *
 * Grouping key: rows with a round_generation group by it (`g{n}`); legacy
 * NULL-generation rows (pre-migration-0070) group by review_iteration
 * (`i{n}-legacy`). Order: legacy rounds first by iteration — every post-0070
 * mint stamps a generation, so legacy rows are necessarily older — then
 * generation rounds in generation order (strictly monotonic per mint,
 * loadPriorRound's counter).
 *
 * Round-level fields (design D4): decision = first non-pending member (the
 * decision writer stamps a whole round at once — heterogeneity is surfaced
 * via hasMixedDecisions for the caller to warn on); decisionReason only for
 * rejected (shared reject reason) and superseded ('upstream-refreshed'
 * system marker) — iterated feedback lives in each member's frozen comments;
 * decided* from the member with the newest decidedAt; createdAt =
 * min(member.createdAt); isCurrent = the pending round, else the newest —
 * matching what getReviewDetail renders (G4-fixed selection).
 */
export function groupDocVersionRounds<R extends RoundGroupRow>(
  rows: readonly R[],
): DocVersionRound<R>[] {
  const items = rows.filter((r) => r.itemIndex !== null)
  if (items.length === 0) return []
  const byKey = new Map<string, R[]>()
  for (const r of items) {
    const key =
      r.roundGeneration !== null ? `g${r.roundGeneration}` : `i${r.reviewIteration}-legacy`
    const list = byKey.get(key)
    if (list === undefined) byKey.set(key, [r])
    else list.push(r)
  }
  const groups: DocVersionRound<R>[] = [...byKey.entries()].map(([roundKey, members]) => {
    members.sort((a, b) =>
      (a.itemIndex ?? 0) !== (b.itemIndex ?? 0)
        ? (a.itemIndex ?? 0) - (b.itemIndex ?? 0)
        : a.id < b.id
          ? -1
          : 1,
    )
    const decision = (members.find((m) => m.decision !== 'pending')?.decision ??
      'pending') as DocVersionDecision
    const decisionReason =
      decision === 'rejected' || decision === 'superseded'
        ? (members.find((m) => m.decisionReason !== null && m.decisionReason !== '')
            ?.decisionReason ?? null)
        : null
    let decider: R | undefined
    for (const m of members) {
      if (m.decidedAt === null) continue
      if (decider === undefined || (decider.decidedAt ?? 0) < m.decidedAt) decider = m
    }
    const first = members[0]!
    return {
      roundKey,
      reviewIteration: first.reviewIteration,
      roundGeneration: first.roundGeneration,
      decision,
      decisionReason,
      decidedAt: decider?.decidedAt ?? null,
      decidedBy: decider?.decidedBy ?? null,
      decidedByRole: (decider?.decidedByRole ?? null) as DocVersionRound<R>['decidedByRole'],
      createdAt: Math.min(...members.map((m) => m.createdAt)),
      isCurrent: false,
      members,
      hasMixedDecisions: new Set(members.map((m) => m.decision)).size > 1,
    }
  })
  groups.sort((a, b) => {
    const aLegacy = a.roundGeneration === null
    const bLegacy = b.roundGeneration === null
    if (aLegacy !== bLegacy) return aLegacy ? -1 : 1
    if (aLegacy) return a.reviewIteration - b.reviewIteration
    return (a.roundGeneration as number) - (b.roundGeneration as number)
  })
  const pendingIdx = groups.findIndex((g) => g.decision === 'pending')
  ;(pendingIdx >= 0 ? groups[pendingIdx]! : groups[groups.length - 1]!).isCurrent = true
  return groups
}

/**
 * RFC-142: list a multi-document review's rounds (ascending, oldest → newest)
 * for the /reviews list expand and the read-only historical-round view
 * (`?round=<roundKey>`). Returns [] for single-document reviews (no
 * item_index rows). Scoped to one nodeRunId — exactly /versions' scope.
 */
export async function listReviewRounds(
  db: DbClient,
  appHome: string,
  nodeRunId: string,
): Promise<ReviewRoundSummary[]> {
  const rows = await db.select().from(docVersions).where(eq(docVersions.reviewNodeRunId, nodeRunId))
  const groups = groupDocVersionRounds(rows)
  const out: ReviewRoundSummary[] = []
  for (const g of groups) {
    if (g.hasMixedDecisions) {
      log.warn('review round members disagree on decision — writer invariant broken', {
        nodeRunId,
        roundKey: g.roundKey,
      })
    }
    const members: ReviewRoundMember[] = []
    for (const m of g.members) {
      const built = await buildRoundMember(db, appHome, m)
      members.push({ ...built.summary, decision: built.decision })
    }
    out.push({
      roundKey: g.roundKey,
      reviewIteration: g.reviewIteration,
      roundGeneration: g.roundGeneration,
      decision: g.decision,
      decisionReason: g.decisionReason,
      decidedAt: g.decidedAt,
      decidedBy: g.decidedBy,
      decidedByRole: g.decidedByRole,
      createdAt: g.createdAt,
      isCurrent: g.isCurrent,
      members,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Comments — add / delete.
// ---------------------------------------------------------------------------

export interface AddReviewCommentArgs {
  db: DbClient
  appHome: string
  nodeRunId: string
  /**
   * The web page's DOM-computed composite anchor (canonicalised here). Exactly
   * one of `anchor` / `anchorRequest` must be given.
   */
  anchor?: ReviewCommentAnchor
  /**
   * RFC-326: the simplified locator (`quote` / `occurrence` / `section`; all
   * absent = document-level) resolved server-side against the pending body.
   */
  anchorRequest?: ReviewAnchorRequest
  commentText: string
  author?: string
  /** RFC-099 (D7) — task-relationship role snapshot; UI/audit only. */
  authorRole?: TaskActorRole
  /**
   * RFC-079: in a multi-document round several doc_versions are pending at once;
   * the caller passes the specific document the comment anchors to. Single-doc
   * callers omit it and the (one) pending doc_version is used.
   */
  docVersionId?: string
}

async function assertReviewRoundWritable(
  db: DbClient,
  nodeRunId: string,
): Promise<typeof nodeRuns.$inferSelect> {
  const run = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1))[0]
  if (run === undefined) {
    throw new NotFoundError('review-not-found', `review run ${nodeRunId} not found`)
  }
  const task = (
    await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, run.taskId)).limit(1)
  )[0]
  if (task === undefined) {
    throw new NotFoundError('task-not-found', `task ${run.taskId} not found`)
  }
  // RFC-202's hard seal is deliberately the UNREVIVABLE pair only. failed /
  // interrupted tasks can be resumed and their still-awaiting review remains
  // writable; treating all four lifecycle-terminal values alike here would
  // make the review impossible to prepare before recovery.
  if (task.status === 'done' || task.status === 'canceled') {
    throw new ConflictError(
      'task-terminal',
      `task ${run.taskId} is '${task.status}'; this review round is closed`,
    )
  }
  if (run.status !== 'awaiting_review') {
    throw new ConflictError(
      'review-not-awaiting',
      `review ${nodeRunId} is not awaiting_review (status=${run.status})`,
    )
  }
  return run
}

/** RFC-326: the created comment plus the resolver's warnings (empty on the web path). */
export interface AddReviewCommentResult extends ReviewComment {
  warnings: ReviewAnchorWarning[]
}

export async function addReviewComment(
  args: AddReviewCommentArgs,
): Promise<AddReviewCommentResult> {
  return withReviewNodeMutationLock(args.db, args.nodeRunId, () => addReviewCommentUnlocked(args))
}

/**
 * RFC-326 P3 — pick the pending doc_version a comment / selection targets.
 *
 * Multi-document mode is decided by `resolveReviewRoundMode` (any member with an
 * `itemIndex`), NOT by counting pending rows: a `list<path<md>>` round with one
 * item is still multi-document, and silently attaching a comment to "the" row
 * was exactly the data error this closes. Callers must name the document.
 */
export async function selectPendingDocVersion(
  db: DbClient,
  nodeRunId: string,
  docVersionId: string | undefined,
): Promise<DocVersion> {
  const pendingRows = await db
    .select()
    .from(docVersions)
    .where(and(eq(docVersions.reviewNodeRunId, nodeRunId), eq(docVersions.decision, 'pending')))
  if (pendingRows.length === 0) {
    throw new ConflictError('review-not-awaiting', `review ${nodeRunId} has no pending doc_version`)
  }
  if (docVersionId !== undefined) {
    const row = pendingRows.find((r) => r.id === docVersionId)
    if (row === undefined) {
      throw new NotFoundError(
        'doc-version-not-found',
        `doc_version ${docVersionId} is not a pending document of review ${nodeRunId}`,
      )
    }
    return rowToDocVersion(row)
  }
  if (resolveReviewRoundMode(pendingRows) !== 'single') {
    throw new ValidationError(
      'review-doc-version-required',
      `review ${nodeRunId} is a multi-document round; pass docVersionId to name the document the comment belongs to`,
    )
  }
  return rowToDocVersion(pendingRows[0]!)
}

/**
 * RFC-326 — resolve whichever anchor form the caller gave against `body`.
 * Web anchors are canonicalised (strategy 0 first, then the legacy context
 * strategies); simplified locators go through the collaboration resolver and
 * are persisted verbatim.
 */
export function resolveCommentAnchor(
  body: string,
  input: { anchor?: ReviewCommentAnchor; anchorRequest?: ReviewAnchorRequest },
): { anchor: ReviewCommentAnchor; warnings: ReviewAnchorWarning[] } {
  if ((input.anchor === undefined) === (input.anchorRequest === undefined)) {
    throw new Error('addReviewComment: pass exactly one of `anchor` / `anchorRequest`')
  }
  if (input.anchorRequest !== undefined) {
    const resolution = resolveReviewAnchor(buildReviewAnchorDocument(body), input.anchorRequest)
    if (!resolution.ok) throw anchorResolutionError(resolution)
    assertResolvedAnchorConsistent(body, resolution.anchor)
    return { anchor: resolution.anchor, warnings: resolution.warnings }
  }
  return { anchor: canonicalizeAnchor(body, input.anchor!), warnings: [] }
}

async function addReviewCommentUnlocked(
  args: AddReviewCommentArgs,
): Promise<AddReviewCommentResult> {
  await assertReviewRoundWritable(args.db, args.nodeRunId)
  const dv = await selectPendingDocVersion(args.db, args.nodeRunId, args.docVersionId)
  const body = readDocVersionBody(args.db, args.appHome, dv)
  const { anchor: canonical, warnings } = resolveCommentAnchor(body, args)

  const id = ulid()
  const now = Date.now()
  await args.db.insert(reviewComments).values({
    id,
    docVersionId: dv.id,
    anchorSectionPath: canonical.sectionPath,
    anchorParagraphIdx: canonical.paragraphIdx,
    anchorOffsetStart: canonical.offsetStart,
    anchorOffsetEnd: canonical.offsetEnd,
    selectedText: canonical.selectedText,
    contextBefore: canonical.contextBefore,
    contextAfter: canonical.contextAfter,
    occurrenceIndex: canonical.occurrenceIndex,
    commentText: args.commentText,
    author: args.author ?? LOCAL_DECIDER,
    authorRole: args.authorRole ?? null,
    createdAt: now,
  })

  const comment: ReviewComment = {
    id,
    docVersionId: dv.id,
    anchor: canonical,
    commentText: args.commentText,
    author: args.author ?? LOCAL_DECIDER,
    authorRole: args.authorRole ?? null,
    createdAt: now,
  }
  emitReviewCommentAddedEvent(dv.taskId, args.nodeRunId, dv.id, comment)
  return { ...comment, warnings }
}

// RFC-009-T1: edit an existing review comment's body. Only allowed while the
// review is still awaiting a decision (pending doc_version exists for this
// nodeRunId AND the comment belongs to that pending doc_version). We do not
// touch the anchor or createdAt — only commentText changes, and a 409 is the
// outcome once the review has been approved/rejected/iterated.
/**
 * RFC-285 B6①（作者校验）—— 评论写权的三层判定：
 * - task owner / 持有 `resource-acl:bypass` 的操作者旁路；
 * - 普通协作者只能改/删**自己**的评论（row.author === actorUserId）；
 * - 历史行 author 为 LOCAL_DECIDER 兜底值（'local'）时永远不等于任何真实
 *   user id ⇒ 自然落入 owner/`resource-acl:bypass` 通道（用户拍板：无法归属作者的行不给
 *   「作者」通道）。
 * 此前 PATCH/DELETE 均无 actor 入参——任何任务成员可改/删他人评论（冒名洞）。
 */
export interface ReviewCommentAuthz {
  actorUserId: string
  role: TaskActorRole
  resourceAclBypass?: boolean
}

function assertCommentWriteAllowed(author: string, authz: ReviewCommentAuthz): void {
  if (authz.role === 'owner' || authz.resourceAclBypass === true) return
  if (author !== authz.actorUserId) {
    throw new ForbiddenError(
      'review-comment-not-author',
      'only the comment author (or the task owner / an actor with resource-acl:bypass) may modify this comment',
    )
  }
}

export async function updateReviewCommentText(
  db: DbClient,
  nodeRunId: string,
  commentId: string,
  commentText: string,
  authz: ReviewCommentAuthz,
): Promise<ReviewComment> {
  return withReviewNodeMutationLock(db, nodeRunId, () =>
    updateReviewCommentTextUnlocked(db, nodeRunId, commentId, commentText, authz),
  )
}

async function updateReviewCommentTextUnlocked(
  db: DbClient,
  nodeRunId: string,
  commentId: string,
  commentText: string,
  authz: ReviewCommentAuthz,
): Promise<ReviewComment> {
  await assertReviewRoundWritable(db, nodeRunId)
  const rows = await db
    .select()
    .from(reviewComments)
    .where(eq(reviewComments.id, commentId))
    .limit(1)
  if (rows.length === 0) {
    throw new NotFoundError('review-comment-not-found', `review_comment ${commentId} not found`)
  }
  const row = rows[0]!
  // Confirm the comment belongs to a pending doc_version on this nodeRunId.
  const dvRows = await db
    .select()
    .from(docVersions)
    .where(eq(docVersions.id, row.docVersionId))
    .limit(1)
  if (dvRows.length === 0) {
    throw new NotFoundError(
      'review-comment-not-found',
      `review_comment ${commentId} has no doc_version`,
    )
  }
  const dv = rowToDocVersion(dvRows[0]!)
  if (dv.reviewNodeRunId !== nodeRunId) {
    throw new NotFoundError(
      'review-comment-not-found',
      `review_comment ${commentId} does not belong to review ${nodeRunId}`,
    )
  }
  if (dv.decision !== 'pending') {
    throw new ConflictError(
      'review-not-awaiting',
      `review ${nodeRunId} is not awaiting a decision; comments are immutable`,
    )
  }
  assertCommentWriteAllowed(row.author, authz)
  await db.update(reviewComments).set({ commentText }).where(eq(reviewComments.id, commentId))

  const updated: ReviewComment = {
    id: row.id,
    docVersionId: row.docVersionId,
    anchor: {
      sectionPath: row.anchorSectionPath,
      paragraphIdx: row.anchorParagraphIdx,
      offsetStart: row.anchorOffsetStart,
      offsetEnd: row.anchorOffsetEnd,
      selectedText: row.selectedText,
      contextBefore: row.contextBefore,
      contextAfter: row.contextAfter,
      occurrenceIndex: row.occurrenceIndex,
    },
    commentText,
    author: row.author,
    createdAt: row.createdAt,
  }
  emitReviewCommentUpdatedEvent(dv.taskId, nodeRunId, dv.id, updated)
  return updated
}

export async function deleteReviewComment(
  db: DbClient,
  nodeRunId: string,
  commentId: string,
  authz: ReviewCommentAuthz,
): Promise<void> {
  return withReviewNodeMutationLock(db, nodeRunId, () =>
    deleteReviewCommentUnlocked(db, nodeRunId, commentId, authz),
  )
}

async function deleteReviewCommentUnlocked(
  db: DbClient,
  nodeRunId: string,
  commentId: string,
  authz: ReviewCommentAuthz,
): Promise<void> {
  await assertReviewRoundWritable(db, nodeRunId)
  const rows = await db
    .select()
    .from(reviewComments)
    .where(eq(reviewComments.id, commentId))
    .limit(1)
  if (rows.length === 0) {
    throw new NotFoundError('review-comment-not-found', `review_comment ${commentId} not found`)
  }
  const row = rows[0]!
  const dvRow = await db
    .select()
    .from(docVersions)
    .where(eq(docVersions.id, row.docVersionId))
    .limit(1)
  const dv = dvRow[0]
  if (dv === undefined || dv.reviewNodeRunId !== nodeRunId) {
    throw new NotFoundError(
      'review-comment-not-found',
      `review_comment ${commentId} does not belong to review ${nodeRunId}`,
    )
  }
  if (dv.decision !== 'pending') {
    throw new ConflictError(
      'review-not-awaiting',
      `review ${nodeRunId} is not awaiting a decision; comments are immutable`,
    )
  }
  assertCommentWriteAllowed(row.author, authz)
  await db.delete(reviewComments).where(eq(reviewComments.id, commentId))
  emitReviewCommentDeletedEvent(dv.taskId, nodeRunId, row.docVersionId, commentId)
}

// ---------------------------------------------------------------------------
// Decision (approve / reject / iterate).
// ---------------------------------------------------------------------------

// RFC-149: review decision policy table.
//
// `submitReviewDecision` used to branch on `args.decision` at ≥13 independent
// points (iteration bump, decisionReason derivation, rerun/rollback key pairs,
// supersede column value + marker, mint cause, cascade semantics, lifecycle
// event). Each policy dimension now lives in ONE row per decision below and
// the function keeps only the path-shape skeleton (approve early-return +
// multi-doc approve gate — D2). Adding a decision kind = adding a row: the
// mapped `satisfies` makes a missing/extra row a compile error.

/**
 * The rerun/rollback/supersede/cascade half of a decision policy. Only
 * rejected/iterated carry it — approve early-returns before the rerun block.
 * All six fields are REQUIRED (design-gate revision): an optional slot would
 * let a new row compile while silently dropping the reject/iterate asymmetry.
 */
export interface ReviewRerunPolicy {
  /** Review-node config key listing which upstream nodes re-run. */
  rerunnableKey: 'rerunnableOnReject' | 'rerunnableOnIterate'
  /** Review-node config key gating the upstream worktree rollback. */
  rollbackKey: 'rollbackFilesOnReject' | 'rollbackFilesOnIterate'
  /** Config-absent default — reject rolls files back, iterate keeps them. */
  rollbackDefault: boolean
  /** `node_runs.superseded_by_review` column value (the human-breadcrumb
   *  supersede marker derives from it byte-for-byte). */
  supersededByReview: 'rejected' | 'iterated'
  /** `rerun_cause` stamped on the freshly minted upstream retry row. */
  mintCause: 'review-reject' | 'review-iterate'
  /** Sibling-review cascade rule: reject always cascades (RFC-005 A2);
   *  iterate only when the upstream opted into sibling sync (RFC-014). */
  cascade: 'always' | 'sibling-sync-conditional'
}

export interface ReviewDecisionPolicyBase {
  /** Whether the decision bumps review_iteration (approve keeps it). */
  bumpsIteration: boolean
  /** transitionNodeRunStatus event kind closing / re-opening the review row. */
  lifecycleEvent: 'approve-review' | 'reject-review' | 'iterate-review'
  /** How doc_versions.decision_reason is derived at archive time. */
  decisionReason: 'reject-reason' | 'render-comments' | 'none'
}

/** approved FORBIDS the rerun slot; rejected/iterated must carry it in full. */
export type ReviewDecisionPolicyOf<K extends ReviewDecisionKind> = ReviewDecisionPolicyBase &
  (K extends 'approved' ? { rerun?: never } : { rerun: ReviewRerunPolicy })

/** Widened view for lookup sites indexing by a runtime ReviewDecisionKind. */
export type ReviewDecisionPolicy = ReviewDecisionPolicyOf<ReviewDecisionKind>

export const REVIEW_DECISION_POLICY = {
  approved: {
    bumpsIteration: false,
    lifecycleEvent: 'approve-review',
    decisionReason: 'none',
  },
  rejected: {
    bumpsIteration: true,
    lifecycleEvent: 'reject-review',
    decisionReason: 'reject-reason',
    rerun: {
      rerunnableKey: 'rerunnableOnReject',
      rollbackKey: 'rollbackFilesOnReject',
      rollbackDefault: true,
      supersededByReview: 'rejected',
      mintCause: 'review-reject',
      cascade: 'always',
    },
  },
  iterated: {
    bumpsIteration: true,
    lifecycleEvent: 'iterate-review',
    decisionReason: 'render-comments',
    rerun: {
      rerunnableKey: 'rerunnableOnIterate',
      rollbackKey: 'rollbackFilesOnIterate',
      rollbackDefault: false,
      supersededByReview: 'iterated',
      mintCause: 'review-iterate',
      cascade: 'sibling-sync-conditional',
    },
  },
} as const satisfies { [K in ReviewDecisionKind]: ReviewDecisionPolicyOf<K> }

export interface SubmitReviewDecisionArgs {
  db: DbClient
  appHome: string
  nodeRunId: string
  decision: ReviewDecisionKind
  rejectReason?: string
  /** Optimistic-lock guard against the iteration the client saw. */
  expectedReviewIteration: number
  /** RFC-333 optional official-client lifecycle fence; legacy callers snapshot it at prepare. */
  expectedTaskRevision?: number
  /** RFC-333 optional official-client gate fence; legacy callers snapshot the current revision. */
  expectedGateRevision?: number
  /** RFC-333 explicit header value; absent callers use the canonical compatibility key. */
  idempotencyKey?: string
  author?: string
  /** RFC-099 (D7) — task-relationship role snapshot of the decider. */
  authorRole?: TaskActorRole
  /**
   * RFC-326 P16 — the acting user. When present, task membership is re-verified
   * before the external (worktree rollback) phase and again inside the commit
   * transaction, linearised with `updateTaskMembers` by the shared task lock.
   * Absent = trusted internal caller (tests, system paths); the HTTP route ALWAYS
   * passes it (locked by rfc326-mcp-review-tools.test.ts).
   */
  actor?: Actor
  /** RFC-326 — comments written in the same transaction as the decision. */
  comments?: ReadonlyArray<ReviewBatchComment>
  /** RFC-326 — per-document selections applied before a multi-document decision. */
  selections?: ReadonlyArray<ReviewBatchSelection>
}

/** One batched comment: exactly one of `anchor` / `anchorRequest`, like `addReviewComment`. */
export interface ReviewBatchComment {
  commentText: string
  docVersionId?: string
  anchor?: ReviewCommentAnchor
  anchorRequest?: ReviewAnchorRequest
}

export interface SubmitReviewDecisionResult {
  taskId: string
  reviewIteration: number
  /**
   * For reject/iterate the caller should re-enter the scheduler by calling
   * resumeTask(taskId); approve completes inline.
   */
  resumeRequired: boolean
  /** Durable command identity; route facades expose the narrow receipt, never the intent id. */
  receipt: ReviewDecisionReceiptEnvelope['decision']
  /** Opaque hand-off used only by the composition root to wake the committed intent. */
  continuationRef: string
  /** RFC-326 — present only when the request carried a batch. */
  batch?: {
    commentsAdded: number
    commentsSkippedAsDuplicate: number
    selectionsApplied: number
  }
}

export async function submitReviewDecision(
  args: SubmitReviewDecisionArgs,
): Promise<SubmitReviewDecisionResult> {
  return withReviewNodeMutationLock(args.db, args.nodeRunId, () =>
    submitReviewDecisionUnlocked(args),
  )
}

// ---------------------------------------------------------------------------
// RFC-326 D6 — the decision is four phases (design §6.1):
//
//   prepare   reads, pure computation and file reads only; every validation the
//             request can fail (state, iteration, membership, fence, every batch
//             anchor, every selection target, snapshot parsing, accepted bodies)
//             runs HERE, so a refusal leaves nothing behind — not even a worktree
//             rollback.
//   external  the worktree rollback (reject / iterate with the rollback flag),
//             idempotent, before the transaction (its outcome is a persisted fact
//             on the retired row — see design §6.3 for the residual form).
//   commit    ONE dbTxSync: re-check, batch selections, batch comments, archive,
//             outputs / status / re-run mints / sibling cascade.
//   after     WS events and the best-effort distill enqueue (N10 / P14).
//
// Before this, archiving (the first write) preceded snapshot parsing and
// accepted-body reads, so a corrupt snapshot or a GC'd body left "document
// decided, run still awaiting" — a state no later request could repair.
// ---------------------------------------------------------------------------

interface PreparedSelection {
  docVersionId: string
  selection: 'accepted' | 'not_accepted'
}

interface PreparedComment {
  docVersion: DocVersion
  anchor: ReviewCommentAnchor
  commentText: string
}

interface PreparedOutput {
  portName: string
  content: string
  kind: string | null
  archiveJson: string | null
}

interface PreparedRerunUpstream {
  nodeId: string
  latest: typeof nodeRuns.$inferSelect
  nextRetry: number
  /** Preallocated so the decision manifest and the committed projection are exact. */
  rerunNodeRunId: string
  /** True when the external phase actually rolled at least one worktree back. */
  rolledBack: boolean
}

interface PreparedSibling {
  runId: string
  reviewIteration: number
  pendingDocVersionIds: string[]
}

interface PreparedRerun {
  rerunPolicy: ReviewRerunPolicy
  rollbackFlag: boolean
  rollbackTarget: Awaited<ReturnType<typeof loadRollbackTarget>>
  upstreams: PreparedRerunUpstream[]
  cascadeReason: 'rejected' | 'iterated' | null
  siblings: PreparedSibling[]
}

/**
 * Returns the actor's task role as of the rows just read (null for a trusted
 * internal caller without an actor). RFC-326 impl-gate P1: the commit point
 * must RECORD this fresh role — an owner whose task was transferred while the
 * decision queued is a collaborator by the time it commits, and the archived
 * `decidedByRole` / batch `authorRole` say so, not the route's snapshot.
 */
function assertActingMember(
  actor: Actor | undefined,
  taskId: string,
  ownerUserId: string | null,
  isMember: boolean,
): TaskActorRole | null {
  if (actor === undefined) return null
  const role = resolveTaskRole(actor, ownerUserId, isMember)
  if (role !== null) return role
  throw new ForbiddenError(
    'not-task-member',
    `only task members or an actor with the required global task authority can decide review gates of task ${taskId}`,
  )
}

/**
 * The validations that must hold at three points: prepare (fast fail), before
 * the external phase (nothing destructive on a stale view), and inside the
 * transaction (the commit point). One function, called with the row just read.
 */
function assertDecisionAdmissible(
  args: SubmitReviewDecisionArgs,
  run: { status: string; reviewIteration: number; taskId: string },
  task: {
    status: string
    ownerUserId: string | null
    sourceTerminationFence: 'closed' | 'merged' | null
  },
  isMember: boolean,
  targetSelfStatus: NodeRunStatus,
): TaskActorRole | null {
  // RFC-202's hard seal is deliberately the UNREVIVABLE pair only.
  if (task.status === 'done' || task.status === 'canceled') {
    throw new ConflictError(
      'task-terminal',
      `task ${run.taskId} is '${task.status}'; this review round is closed and no longer accepts decisions`,
    )
  }
  if (run.status !== 'awaiting_review') {
    throw new ConflictError(
      'review-not-awaiting',
      `review ${args.nodeRunId} not awaiting_review (status=${run.status})`,
    )
  }
  if (run.reviewIteration !== args.expectedReviewIteration) {
    throw new ConflictError(
      'review-iteration-mismatch',
      `review_iteration changed under you (server=${run.reviewIteration}, client=${args.expectedReviewIteration})`,
    )
  }
  const role = assertActingMember(args.actor, run.taskId, task.ownerUserId, isMember)
  // RFC-303: the review row itself moves to `done` (approve) or back to `pending`
  // (reject / iterate); a fenced task refuses the latter — checked before any
  // worktree is touched, with the SAME predicate the Tx helpers apply.
  assertNodeRunSourceTerminationAdmission(run.taskId, task.sourceTerminationFence, targetSelfStatus)
  return role
}

function canonicalReviewDecisionPayload(args: SubmitReviewDecisionArgs) {
  return {
    kind: 'review-decision' as const,
    decision: args.decision,
    reviewIteration: args.expectedReviewIteration,
    rejectReason: args.rejectReason ?? null,
    commentsJson: canonicalHumanGateValueJson(args.comments ?? []),
    selectionsJson: canonicalHumanGateValueJson(args.selections ?? []),
  }
}

function resultFromReviewDecisionReceipt(
  envelope: ReviewDecisionReceiptEnvelope,
  hasBatch: boolean,
): SubmitReviewDecisionResult {
  return {
    taskId: envelope.result.taskId,
    reviewIteration: envelope.result.reviewIteration,
    resumeRequired: true,
    receipt: gateDecisionReceipt({ ...envelope.decision, replayed: true }),
    continuationRef: envelope.result.continuationRef,
    ...(hasBatch
      ? {
          batch: {
            commentsAdded: envelope.result.commentsAdded,
            commentsSkippedAsDuplicate: envelope.result.commentsSkippedAsDuplicate,
            selectionsApplied: envelope.result.selectionsApplied,
          },
        }
      : {}),
  }
}

/**
 * A compatibility retry arrives after the review row has already closed, so it
 * must be recognized before the ordinary `awaiting_review` admission check.
 * Explicit keys match their one row; keyless web/MCP callers match the latest
 * canonical payload/actor and reuse that row's captured revisions.
 */
function replayCommittedReviewDecision(
  args: SubmitReviewDecisionArgs,
  taskId: string,
): SubmitReviewDecisionResult | null {
  const gateRef = `review:${args.nodeRunId}`
  const payload = canonicalReviewDecisionPayload(args)
  const actorUserId = args.actor?.user.id ?? null
  const rows = args.db
    .select()
    .from(collaborationGateOperations)
    .where(
      and(
        eq(collaborationGateOperations.taskId, taskId),
        eq(collaborationGateOperations.gateKind, 'review'),
        eq(collaborationGateOperations.gateRef, gateRef),
        eq(collaborationGateOperations.operationKind, 'decide'),
      ),
    )
    .orderBy(desc(collaborationGateOperations.createdAt))
    .all()
  const explicit = args.idempotencyKey
  const candidate = rows.find((row) => {
    if (explicit !== undefined && row.idempotencyKey !== explicit) return false
    if (row.receiptJson === null || row.actorUserId !== actorUserId) return false
    let manifest: ReviewDecisionManifest
    try {
      manifest = decodeReviewDecisionManifest(row.manifestJson)
    } catch {
      return false
    }
    const request: CanonicalHumanGateRequest = {
      schemaVersion: 1,
      taskId,
      gateKind: 'review',
      operationKind: 'decide',
      gateRef,
      actorUserId,
      expectedTaskRevision: args.expectedTaskRevision ?? row.expectedTaskRevision,
      expectedGateRevision: args.expectedGateRevision ?? row.expectedGateRevision,
      payload,
    }
    return (
      canonicalHumanGateRequestHash(request) === row.requestHash &&
      canonicalHumanGateRequestHash(manifest.request) === row.requestHash
    )
  })
  if (candidate === undefined) {
    if (explicit !== undefined && rows.some((row) => row.idempotencyKey === explicit)) {
      throw new ConflictError(
        'human-gate-idempotency-conflict',
        `review decision idempotency key is already bound to another request`,
      )
    }
    return null
  }
  return resultFromReviewDecisionReceipt(
    decodeReviewDecisionReceipt(candidate.receiptJson!),
    args.comments !== undefined || args.selections !== undefined,
  )
}

function ensureLegacyReviewGateRevisionTx(input: {
  tx: DbTxSync
  operations: SqliteHumanGateOperationStore
  taskId: string
  nodeRunId: string
  expectedTaskRevision: number
  reviewIteration: number
  now: number
}): number {
  const gateRef = `review:${input.nodeRunId}`
  const current = input.operations.latestGateRevisionTx({
    tx: input.tx,
    gateKind: 'review',
    gateRef,
  })
  if (current !== 0) return current
  const request: CanonicalHumanGateRequest = {
    schemaVersion: 1,
    taskId: input.taskId,
    gateKind: 'review',
    operationKind: 'legacy-seed',
    gateRef,
    actorUserId: null,
    expectedTaskRevision: input.expectedTaskRevision,
    expectedGateRevision: 0,
    payload: {
      kind: 'legacy-seed',
      factDigest: sha256Hex(
        canonicalHumanGateValueJson({
          taskId: input.taskId,
          nodeRunId: input.nodeRunId,
          reviewIteration: input.reviewIteration,
        }),
      ),
    },
  }
  const operationId = ulid(input.now)
  const begun = input.operations.beginTx({
    tx: input.tx,
    operationId,
    request,
    idempotencyKey: `legacy:review:${input.nodeRunId}:1`,
    now: input.now,
  })
  input.operations.commitTx({
    tx: input.tx,
    operationId: begun.operation.id,
    expectedClaimEpoch: begun.operation.claimEpoch,
    receiptJson: canonicalHumanGateValueJson({
      schemaVersion: 1,
      kind: 'legacy-seed',
      gateRef,
      gateRevision: 1,
    }),
    now: input.now,
  })
  input.operations.completeTx({
    tx: input.tx,
    operationId: begun.operation.id,
    expectedClaimEpoch: begun.operation.claimEpoch,
    now: input.now,
  })
  return 1
}

function reviewDecisionProjectionMember(row: typeof nodeRuns.$inferSelect) {
  return {
    id: row.id,
    taskId: row.taskId,
    nodeId: row.nodeId,
    parentNodeRunId: row.parentNodeRunId,
    iteration: row.iteration,
    shardKey: row.shardKey,
    retryIndex: row.retryIndex,
    reviewIteration: row.reviewIteration,
    status: row.status,
    failureCode: row.failureCode,
    preSnapshot: row.preSnapshot,
    preSnapshotReposJson: row.preSnapshotReposJson,
    rerunCause: row.rerunCause,
    supersededByReview: row.supersededByReview,
    rolledBack: row.rolledBack,
    continuationSlotKey: row.continuationSlotKey,
    lineageSlotPathJson: row.lineageSlotPathJson,
    operationGeneration: row.operationGeneration,
  }
}

async function submitReviewDecisionUnlocked(
  args: SubmitReviewDecisionArgs,
): Promise<SubmitReviewDecisionResult> {
  const { db } = args

  // ── prepare A: rows + admission ────────────────────────────────────────────
  const run = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, args.nodeRunId)).limit(1))[0]
  if (run === undefined) {
    throw new NotFoundError('review-not-found', `review run ${args.nodeRunId} not found`)
  }
  const taskRow = (await db.select().from(tasks).where(eq(tasks.id, run.taskId)).limit(1))[0]
  if (taskRow === undefined) {
    throw new NotFoundError('task-not-found', `task ${run.taskId} not found`)
  }
  if (args.idempotencyKey !== undefined && args.idempotencyKey.trim().length === 0) {
    throw new ValidationError(
      'review-decision-invalid',
      'review decision idempotency key must not be empty',
    )
  }
  const replay = replayCommittedReviewDecision(args, run.taskId)
  if (replay !== null) return replay
  // Widened to the lookup view (RFC-149): `rerun` is absent on approve and the
  // full re-run policy on reject / iterate — the ONE place the path forks.
  const policy: ReviewDecisionPolicy = REVIEW_DECISION_POLICY[args.decision]
  // The review row closes (`done`) when the decision carries no re-run slot and
  // re-opens (`pending`) otherwise — read off the policy table (RFC-149), not a
  // second decision comparison.
  const targetSelfStatus: NodeRunStatus = policy.rerun === undefined ? 'done' : 'pending'
  const memberBefore =
    args.actor === undefined ? false : await hasActingMembership(db, run.taskId, args.actor.user.id)
  assertDecisionAdmissible(args, run, taskRow, memberBefore, targetSelfStatus)

  // RFC-079: a multi-document round has N pending doc_versions (one per list
  // item, item_index set); single-document has exactly one (item_index NULL).
  const dvRows = await db
    .select()
    .from(docVersions)
    .where(
      and(eq(docVersions.reviewNodeRunId, args.nodeRunId), eq(docVersions.decision, 'pending')),
    )
    .orderBy(asc(docVersions.itemIndex))
  if (dvRows.length === 0) {
    throw new ConflictError(
      'review-doc-version-missing',
      `no pending doc_version for review ${args.nodeRunId}`,
    )
  }
  const dvs = dvRows.map(rowToDocVersion)
  // Representative row — taskId / sourceNodeId / reviewNodeId / sourcePortName
  // are identical across every item of a round (one shared upstream port).
  const dv = dvs[0]!
  const isMultiDoc = resolveReviewRoundMode(dvs) !== 'single'

  // ── prepare B: batch selections → effective view ──────────────────────────
  const selections: PreparedSelection[] = []
  for (const s of args.selections ?? []) {
    const target = dvs.find((d) => d.id === s.docVersionId)
    if (target === undefined) {
      throw new NotFoundError(
        'doc-version-not-found',
        `doc_version ${s.docVersionId} is not a pending document of review ${args.nodeRunId}`,
      )
    }
    if (target.itemIndex === null || target.itemIndex === undefined) {
      throw new ConflictError(
        'review-not-multi-doc',
        `doc_version ${s.docVersionId} is not a multi-document item`,
      )
    }
    selections.push({ docVersionId: s.docVersionId, selection: s.selection })
  }
  const selectionById = new Map(selections.map((s) => [s.docVersionId, s.selection] as const))
  // Every approve computation below reads THIS view (design §6.1: completeness,
  // accepted subset, bodies, paths, archive, meta), never the pre-batch rows.
  const effectiveDvs: DocVersion[] = dvs.map((d) => {
    const overlay = selectionById.get(d.id)
    return overlay === undefined ? d : { ...d, selection: overlay, selectionStale: false }
  })

  // ── prepare C: batch comments → resolved anchors ──────────────────────────
  const bodyCache = new Map<string, string>()
  const readBody = (d: DocVersion): string => {
    let body = bodyCache.get(d.id)
    if (body === undefined) {
      body = readDocVersionBody(args.db, args.appHome, d)
      bodyCache.set(d.id, body)
    }
    return body
  }
  const docModelCache = new Map<string, ReturnType<typeof buildReviewAnchorDocument>>()
  const budget = createReviewAnchorBudget()
  const comments: PreparedComment[] = []
  const batchComments = args.comments ?? []
  for (let index = 0; index < batchComments.length; index++) {
    const c = batchComments[index]!
    let target: DocVersion
    if (c.docVersionId !== undefined) {
      const found = dvs.find((d) => d.id === c.docVersionId)
      if (found === undefined) {
        throw new NotFoundError(
          'doc-version-not-found',
          `doc_version ${c.docVersionId} is not a pending document of review ${args.nodeRunId}`,
          { index },
        )
      }
      target = found
    } else if (isMultiDoc) {
      throw new ValidationError(
        'review-doc-version-required',
        `review ${args.nodeRunId} is a multi-document round; comments[${index}] must name its document via docVersionId`,
        { index },
      )
    } else {
      target = dv
    }
    const body = readBody(target)
    try {
      if ((c.anchor === undefined) === (c.anchorRequest === undefined)) {
        throw new ValidationError(
          'review-comment-invalid',
          `comments[${index}]: pass exactly one of anchor / quote-occurrence-section`,
          { index },
        )
      }
      let anchor: ReviewCommentAnchor
      if (c.anchorRequest !== undefined) {
        let model = docModelCache.get(target.id)
        if (model === undefined) {
          model = buildReviewAnchorDocument(body)
          docModelCache.set(target.id, model)
        }
        const resolution = resolveReviewAnchor(model, c.anchorRequest, budget)
        if (!resolution.ok) throw anchorResolutionError(resolution)
        assertResolvedAnchorConsistent(body, resolution.anchor)
        anchor = resolution.anchor
      } else {
        anchor = canonicalizeAnchor(body, c.anchor!)
      }
      comments.push({ docVersion: target, anchor, commentText: c.commentText })
    } catch (err) {
      // Name the offending entry so a 200-comment batch is actionable.
      if (err instanceof DomainError) {
        const details = (err.details ?? {}) as Record<string, unknown>
        throw new ValidationError(err.code, `comments[${index}]: ${err.message}`, {
          ...details,
          index,
        })
      }
      throw err
    }
  }

  // ── prepare D: decision preconditions on the effective view ──────────────
  if (isMultiDoc && args.decision === 'approved' && !allDocumentsDecided(effectiveDvs)) {
    throw new ConflictError(
      'review-selection-incomplete',
      `review ${args.nodeRunId} has undecided documents; decide every document before approving`,
    )
  }

  // ── prepare E: approve payload ────────────────────────────────────────────
  const decidedAt = Date.now()
  let outputs: PreparedOutput[] | null = null
  let distillSourceEventId = dv.id
  if (args.decision === 'approved') {
    outputs = isMultiDoc
      ? await planMultiDocApprove(db, run, effectiveDvs, readBody, decidedAt)
      : await planSingleDocApprove(db, run, dv, readBody, decidedAt)
    distillSourceEventId = isMultiDoc ? effectiveDvs[0]!.id : dv.id
  }

  // ── prepare F: re-run plan (reject / iterate) ─────────────────────────────
  let rerun: PreparedRerun | null = null
  if (policy.rerun !== undefined) {
    rerun = await planRerun(args, run, taskRow, dv)
  }

  // ── prepare G: durable rollback plan; canonical worktree is untouched ─────
  let workspaceRollbackPlan: ValidatedWorkspaceRollbackPlan | null = null
  if (rerun !== null && rerun.rollbackFlag && rerun.rollbackTarget !== null) {
    const candidates = rerun.upstreams.map((up) => ({
      sourceNodeRunId: up.latest.id,
      targets: planNodeRunRollbackTargets(rerun!.rollbackTarget!, up.latest, {
        resetOnEmptySnapshot: false,
      }),
    }))
    if (candidates.some((candidate) => candidate.targets.length > 0)) {
      workspaceRollbackPlan = await humanGateComposition.prepareWorkspaceRollbackPlan({
        taskId: taskRow.id,
        candidates,
      })
    }
  }

  const operationId = ulid(decidedAt)
  const gateRef = `review:${args.nodeRunId}`
  const capturedTaskRevision = args.expectedTaskRevision ?? taskRow.lifecycleEventRevision
  const latestGateRevision =
    db
      .select({ revision: collaborationGateOperations.resultGateRevision })
      .from(collaborationGateOperations)
      .where(
        and(
          eq(collaborationGateOperations.gateKind, 'review'),
          eq(collaborationGateOperations.gateRef, gateRef),
          isNotNull(collaborationGateOperations.resultGateRevision),
        ),
      )
      .orderBy(desc(collaborationGateOperations.resultGateRevision))
      .limit(1)
      .get()?.revision ?? 0
  // A legacy gate is seeded to revision 1 in the final transaction before the
  // decision operation begins. New RFC-333 gates already have open revision 1.
  const capturedGateRevision =
    args.expectedGateRevision ?? (latestGateRevision === 0 ? 1 : latestGateRevision)
  const request: CanonicalHumanGateRequest = {
    schemaVersion: 1,
    taskId: taskRow.id,
    gateKind: 'review',
    operationKind: 'decide',
    gateRef,
    actorUserId: args.actor?.user.id ?? null,
    expectedTaskRevision: capturedTaskRevision,
    expectedGateRevision: capturedGateRevision,
    payload: canonicalReviewDecisionPayload(args),
  }
  const idempotencyKey = args.idempotencyKey ?? deriveHumanGateCompatibilityKey(request)
  const sourceNodeRunIds = rerun?.upstreams.map((up) => up.latest.id) ?? []
  const rerunNodeRunIds = rerun?.upstreams.map((up) => up.rerunNodeRunId) ?? []
  const decisionManifest: ReviewDecisionManifest = {
    schemaVersion: 1,
    kind: 'review-decision',
    request,
    sourceNodeRunIds,
    rerunNodeRunIds,
    workspaceRollbackPlan,
  }
  const decisionManifestJson = encodeReviewDecisionManifest(decisionManifest)
  const operations = humanGateComposition.createHumanGateOperationStore()

  // ── commit: one transaction ───────────────────────────────────────────────
  const nextIter = policy.bumpsIteration ? run.reviewIteration + 1 : run.reviewIteration
  const committed = dbTxSync(db, (tx) => {
    // 0. Re-check at the commit point: a concurrent cancel / decision / member
    //    removal that slipped past the lock-free prepare loses here.
    const liveRun = tx
      .select({
        status: nodeRuns.status,
        reviewIteration: nodeRuns.reviewIteration,
        taskId: nodeRuns.taskId,
      })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, args.nodeRunId))
      .get()
    const liveTask = tx
      .select({
        status: tasks.status,
        ownerUserId: tasks.ownerUserId,
        sourceTerminationFence: tasks.sourceTerminationFence,
      })
      .from(tasks)
      .where(eq(tasks.id, run.taskId))
      .get()
    if (liveRun === undefined || liveTask === undefined) {
      throw new NotFoundError('review-not-found', `review run ${args.nodeRunId} not found`)
    }
    const memberNow =
      args.actor === undefined ? false : hasActingMembershipTx(tx, run.taskId, args.actor.user.id)
    const freshRole = assertDecisionAdmissible(args, liveRun, liveTask, memberNow, targetSelfStatus)
    // The role written to every row of this decision: the one just re-resolved
    // when an actor is known, the caller's snapshot otherwise (internal paths).
    const effectiveRole: TaskActorRole | null =
      args.actor !== undefined ? freshRole : (args.authorRole ?? null)

    const currentGateRevision = ensureLegacyReviewGateRevisionTx({
      tx,
      operations,
      taskId: taskRow.id,
      nodeRunId: args.nodeRunId,
      expectedTaskRevision: capturedTaskRevision,
      reviewIteration: run.reviewIteration,
      now: decidedAt,
    })
    if (currentGateRevision !== capturedGateRevision) {
      throw new ConflictError(
        'human-gate-operation-stale',
        `review gate revision changed (expected ${capturedGateRevision}, current ${currentGateRevision})`,
      )
    }
    const begun = operations.beginTx({
      tx,
      operationId,
      request,
      idempotencyKey,
      now: decidedAt,
    })
    if (begun.replayed) {
      if (begun.operation.receiptJson === null) {
        throw new ConflictError(
          'human-gate-operation-conflict',
          `review decision operation '${begun.operation.id}' has not committed`,
        )
      }
      return {
        kind: 'replayed' as const,
        receipt: decodeReviewDecisionReceipt(begun.operation.receiptJson),
      }
    }
    operations.markPreparedTx({
      tx,
      operationId: begun.operation.id,
      expectedClaimEpoch: begun.operation.claimEpoch,
      manifestJson: decisionManifestJson,
      now: decidedAt,
    })

    // 1. Batch selections (RFC-129: judging the current content clears stale).
    let selectionsApplied = 0
    for (const s of selections) {
      const changed = tx
        .update(docVersions)
        .set({ selection: s.selection, selectionStale: false })
        .where(
          and(
            eq(docVersions.id, s.docVersionId),
            eq(docVersions.reviewNodeRunId, args.nodeRunId),
            eq(docVersions.decision, 'pending'),
          ),
        )
        .returning({ id: docVersions.id })
        .all()
      if (changed.length === 0) {
        throw new ConflictError(
          'review-doc-decided',
          `doc_version ${s.docVersionId} already decided`,
        )
      }
      selectionsApplied += 1
    }

    // 2. Batch comments — deduplicated on (document, range, text) so a retry after
    //    a rolled-back attempt cannot double-post.
    const inserted: Array<{ docVersion: DocVersion; comment: ReviewComment }> = []
    let skipped = 0
    for (const c of comments) {
      const dup = tx
        .select({ id: reviewComments.id })
        .from(reviewComments)
        .where(
          and(
            eq(reviewComments.docVersionId, c.docVersion.id),
            eq(reviewComments.anchorOffsetStart, c.anchor.offsetStart),
            eq(reviewComments.anchorOffsetEnd, c.anchor.offsetEnd),
            eq(reviewComments.selectedText, c.anchor.selectedText),
            eq(reviewComments.commentText, c.commentText),
          ),
        )
        .get()
      if (dup !== undefined) {
        skipped += 1
        continue
      }
      const id = ulid()
      const createdAt = Date.now()
      const author = args.author ?? LOCAL_DECIDER
      const authorRole = effectiveRole
      tx.insert(reviewComments)
        .values({
          id,
          docVersionId: c.docVersion.id,
          anchorSectionPath: c.anchor.sectionPath,
          anchorParagraphIdx: c.anchor.paragraphIdx,
          anchorOffsetStart: c.anchor.offsetStart,
          anchorOffsetEnd: c.anchor.offsetEnd,
          selectedText: c.anchor.selectedText,
          contextBefore: c.anchor.contextBefore,
          contextAfter: c.anchor.contextAfter,
          occurrenceIndex: c.anchor.occurrenceIndex,
          commentText: c.commentText,
          author,
          authorRole,
          createdAt,
        })
        .run()
      inserted.push({
        docVersion: c.docVersion,
        comment: {
          id,
          docVersionId: c.docVersion.id,
          anchor: c.anchor,
          commentText: c.commentText,
          author,
          authorRole,
          createdAt,
        },
      })
    }

    // 3. Archive each pending doc_version's comments (batch included) into its
    //    snapshot + drop the row-side comments. For iterate, each document's own
    //    comments render into its decisionReason (carried, with a File header,
    //    into the aggregated re-run prompt by buildReviewPromptContext).
    for (const d of dvs) {
      const commentRows = tx
        .select()
        .from(reviewComments)
        .where(eq(reviewComments.docVersionId, d.id))
        .orderBy(asc(reviewComments.anchorParagraphIdx), asc(reviewComments.anchorOffsetStart))
        .all()
      const commentsArr = commentRows.map(rowToReviewComment)
      const claimed = tx
        .update(docVersions)
        .set({
          decision: args.decision,
          decisionReason:
            policy.decisionReason === 'reject-reason'
              ? (args.rejectReason ?? null)
              : policy.decisionReason === 'render-comments'
                ? renderCommentsForPrompt(commentsArr, {
                    ...(d.sourceFilePath ? { sourceFilePath: d.sourceFilePath } : {}),
                  })
                : null,
          decidedAt,
          decidedBy: args.author ?? LOCAL_DECIDER,
          decidedByRole: effectiveRole,
          commentsJson: JSON.stringify(commentsArr),
        })
        .where(and(eq(docVersions.id, d.id), eq(docVersions.decision, 'pending')))
        .returning({ id: docVersions.id })
        .all()
      if (claimed.length === 0) {
        throw new ConflictError(
          'review-decision-conflict',
          `doc_version ${d.id} was decided concurrently; review ${args.nodeRunId} decision claim lost`,
        )
      }
      tx.delete(reviewComments).where(eq(reviewComments.docVersionId, d.id)).run()
    }

    if (outputs !== null) {
      // 4a. approve — publish the declared output ports into node_run_outputs so
      //     downstream bindings + the task-detail Outputs tab can resolve them.
      //     Upsert (RFC-052): defense-in-depth against a re-entered approve.
      for (const out of outputs) {
        tx.insert(nodeRunOutputs)
          .values({
            nodeRunId: args.nodeRunId,
            portName: out.portName,
            content: out.content,
            kind: out.kind,
            archiveJson: out.archiveJson,
          })
          .onConflictDoUpdate({
            target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
            set: { content: out.content, kind: out.kind, archiveJson: out.archiveJson },
          })
          .run()
      }
      // RFC-053: approve-review enforces awaiting_review → done at the helper.
      transitionNodeRunStatusTx({
        tx,
        nodeRunId: args.nodeRunId,
        event: { kind: policy.lifecycleEvent },
        extra: { finishedAt: decidedAt },
      })
    } else if (rerun !== null) {
      // 4b. reject / iterate — retire the superseded upstream rows, mint their
      //     re-runs, cascade to sibling reviews, and re-open this review row.
      for (const up of rerun.upstreams) {
        // RFC-145: the marker string is HUMAN BREADCRUMBS only — the machine
        // facts land on superseded_by_review / rolled_back in the same write.
        // RFC-095: the prefix is a LOAD-BEARING dispatch contract (isDispatchable
        // keeps canceled rows carrying it parked).
        const supersedeMarker = `${REVIEW_SUPERSEDE_MARKER_PREFIX}${rerun.rerunPolicy.supersededByReview}${up.rolledBack ? '-rollback' : ''}`
        // RFC-053: supersede must be able to cancel BOTH live rows AND a `done`
        // row (typical — the agent finished before the decision). allowTerminal
        // documents the intentional terminal-rewrite.
        setNodeRunStatusTx({
          tx,
          nodeRunId: up.latest.id,
          to: 'canceled',
          allowedFrom: ['pending', 'running', 'awaiting_review', 'awaiting_human', 'done'],
          allowTerminal: true,
          reason: supersedeMarker,
          extra: {
            finishedAt: up.latest.finishedAt ?? Date.now(),
            errorMessage: `${supersedeMarker}: Replaced by retry_index ${up.nextRetry} due to review ${rerun.rerunPolicy.supersededByReview} of ${dv.reviewNodeId}`,
            supersededByReview: rerun.rerunPolicy.supersededByReview,
            rolledBack: up.rolledBack,
          },
        })
        // RFC-011: a fresh node_run row at retry_index+1 keeps the old row's
        // promptText / outputs for the Prompt tab attempts switcher. No
        // inheritFrom: only preSnapshot is carried, plus an explicit top-level
        // parent; startedAt null = "no timing until it actually runs"
        // (RFC-074 PR-C: no clarifyIteration inherit, see
        // review-iterate-inherits-clarify-iteration.test.ts).
        mintNodeRunTx(tx, {
          id: up.rerunNodeRunId,
          taskId: dv.taskId,
          nodeId: up.nodeId,
          status: 'pending',
          cause: rerun.rerunPolicy.mintCause,
          retryIndex: up.nextRetry,
          iteration: up.latest.iteration,
          overrides: { parentNodeRunId: null, preSnapshot: up.latest.preSnapshot, startedAt: null },
        })
      }
      // Sibling cascade (RFC-005 A2 reject: always; RFC-014 iterate: only when the
      // upstream agent syncs ≥ 2 markdown outputs — decided in prepare).
      for (const sibling of rerun.siblings) {
        for (const pendingId of sibling.pendingDocVersionIds) {
          tx.update(docVersions)
            .set({
              decision: 'rejected',
              decisionReason: 'invalidated by sibling reject (RFC-005 A2)',
              decidedAt: Date.now(),
              decidedBy: SYSTEM_DECIDER,
            })
            .where(eq(docVersions.id, pendingId))
            .run()
        }
        setNodeRunStatusTx({
          tx,
          nodeRunId: sibling.runId,
          to: 'pending',
          allowedFrom: ['pending', 'running', 'awaiting_review', 'awaiting_human', 'done'],
          allowTerminal: true,
          reason: 'review-sibling-cascade',
          extra: { reviewIteration: sibling.reviewIteration + 1 },
        })
      }
      // Bump this review's reviewIteration + status=pending so the scheduler
      // re-runs it (RFC-053: iterate-review / reject-review enforce
      // awaiting_review → pending).
      transitionNodeRunStatusTx({
        tx,
        nodeRunId: args.nodeRunId,
        event: { kind: policy.lifecycleEvent },
        extra: { reviewIteration: nextIter },
      })
    }

    const lineageIds = [...sourceNodeRunIds, ...rerunNodeRunIds]
    const projectionRows =
      lineageIds.length === 0
        ? []
        : tx.select().from(nodeRuns).where(inArray(nodeRuns.id, lineageIds)).all()
    const expectedNodeProjection = humanGateNodeProjectionFence(
      projectionRows.map(reviewDecisionProjectionMember),
    )
    const accepted = humanGateComposition.bindTaskDecisionParticipantInTx(tx).acceptGateDecisionTx({
      taskId: taskRow.id,
      gate: { kind: 'review', ref: gateRef },
      expectedTaskRevision: capturedTaskRevision,
      expectedNodeProjection,
      continuationLineage: { sourceNodeRunIds, rerunNodeRunIds },
      ...(workspaceRollbackPlan === null
        ? {}
        : {
            workspaceRollbackPlan: {
              operationId: begun.operation.id,
              planDigest: workspaceRollbackPlan.digest,
            },
          }),
      operationId: begun.operation.id,
      now: decidedAt,
    })
    const receipt: ReviewDecisionReceiptEnvelope = {
      schemaVersion: 1,
      kind: 'review-decision',
      decision: gateDecisionReceipt({
        operationId: begun.operation.id,
        gate: { kind: 'review', ref: gateRef },
        gateRevision: capturedGateRevision + 1,
        taskRevision: accepted.taskRevision,
        acceptedAt: decidedAt,
        replayed: false,
      }),
      result: {
        taskId: taskRow.id,
        reviewIteration: nextIter,
        continuationRef: accepted.continuationRef,
        commentsAdded: inserted.length,
        commentsSkippedAsDuplicate: skipped,
        selectionsApplied,
      },
    }
    operations.commitTx({
      tx,
      operationId: begun.operation.id,
      expectedClaimEpoch: begun.operation.claimEpoch,
      receiptJson: encodeReviewDecisionReceipt(receipt),
      now: decidedAt,
    })
    operations.completeTx({
      tx,
      operationId: begun.operation.id,
      expectedClaimEpoch: begun.operation.claimEpoch,
      now: decidedAt,
    })

    return { kind: 'committed' as const, inserted, skipped, selectionsApplied, receipt }
  })

  if (committed.kind === 'replayed') {
    return resultFromReviewDecisionReceipt(
      committed.receipt,
      args.comments !== undefined || args.selections !== undefined,
    )
  }

  // ── after commit: events + best-effort distill ────────────────────────────
  for (const s of selections) {
    emitReviewSelectionChanged(dv.taskId, args.nodeRunId, s.docVersionId, s.selection)
  }
  for (const { docVersion, comment } of committed.inserted) {
    emitReviewCommentAddedEvent(dv.taskId, args.nodeRunId, docVersion.id, comment)
  }
  emitReviewDecisionEvent(dv.taskId, args.nodeRunId, args.decision, nextIter, args.decision)
  // RFC-041: feed the decision into the memory distill queue. Best-effort by
  // design (N10 / P14): its own write, after the decision committed; a failure
  // here never blocks or reverts the decision.
  await enqueueDistillJob(db, {
    sourceKind: 'review',
    sourceEventId: distillSourceEventId,
    taskId: dv.taskId,
  }).catch(() => {
    /* swallow — distill is async, downstream broken queue must not affect decision */
  })

  const hasBatch = args.comments !== undefined || args.selections !== undefined
  return {
    taskId: dv.taskId,
    reviewIteration: nextIter,
    resumeRequired: true,
    receipt: committed.receipt.decision,
    continuationRef: committed.receipt.result.continuationRef,
    ...(hasBatch
      ? {
          batch: {
            commentsAdded: committed.inserted.length,
            commentsSkippedAsDuplicate: committed.skipped,
            selectionsApplied: committed.selectionsApplied,
          },
        }
      : {}),
  }
}

/**
 * Single-document approve payload: `approved_doc` mirrors the SHAPE upstream
 * emitted (a worktree-relative path for markdown_file ports, so downstream's
 * resolvePortContent re-reads the file; the body verbatim for inline markdown)
 * plus the `approval_meta` blob. RFC-072: a path-shaped doc persists kind
 * 'path<md>' (canonical, never the legacy alias) so the Outputs tab offers a
 * Download; RFC-193 D16: it also carries the upstream port's archive slice.
 * RFC-099 prompt isolation: no decider identity in the port payload.
 */
async function planSingleDocApprove(
  db: DbClient,
  run: typeof nodeRuns.$inferSelect,
  dv: DocVersion,
  readBody: (d: DocVersion) => string,
  decidedAt: number,
): Promise<PreparedOutput[]> {
  const sourcePath = dv.sourceFilePath ?? null
  const hasSourcePath = sourcePath !== null && sourcePath.trim().length > 0
  const approvedDocContent = hasSourcePath ? (sourcePath as string) : readBody(dv)
  const approvedDocKind = hasSourcePath ? 'path<md>' : null
  const approvedArchiveJson = hasSourcePath
    ? subsetArchiveJson(
        await upstreamPortArchiveJson(db, run, dv.sourceNodeId, dv.sourcePortName),
        [sourcePath as string],
      )
    : null
  const meta = JSON.stringify({
    decision: 'approved',
    decidedAt,
    reviewIteration: run.reviewIteration,
    versionIndex: dv.versionIndex,
    sourceNodeId: dv.sourceNodeId,
    sourcePortName: dv.sourcePortName,
  })
  return [
    {
      portName: REVIEW_APPROVED_PORT_SINGLE,
      content: approvedDocContent,
      kind: approvedDocKind,
      archiveJson: approvedArchiveJson,
    },
    { portName: REVIEW_APPROVAL_META_PORT, content: meta, kind: null, archiveJson: null },
  ]
}

/**
 * RFC-079: multi-document approve payload — the curated subset (accepted items,
 * in item_index order) on the `accepted` port. RFC-081: a list<markdown> round
 * archives items inline, so the subset is the accepted bodies joined by
 * MARKDOWN_DOC_BOUNDARY (kind list<markdown>); a list<path<md>> round joins the
 * accepted worktree paths by newline (kind list<path<md>>). Empty subset →
 * empty content → downstream wrapper-fanout completes immediately. RFC-193 D16:
 * a path-list subset carries the matching slice of the upstream archive so it
 * stays artifact-readable after worktree GC. Reads the EFFECTIVE (batch-applied)
 * view — RFC-326 design §6.1.
 */
async function planMultiDocApprove(
  db: DbClient,
  run: typeof nodeRuns.$inferSelect,
  effectiveDvs: DocVersion[],
  readBody: (d: DocVersion) => string,
  decidedAt: number,
): Promise<PreparedOutput[]> {
  const acceptedItemIndices = effectiveDvs
    .filter((d) => d.selection === 'accepted')
    .map((d) => d.itemIndex)
    .filter((i): i is number => i !== null && i !== undefined)
    .sort((a, b) => a - b)
  const itemsInline = resolveReviewRoundMode(effectiveDvs) === 'multi-inline'
  let acceptedContent: string
  let acceptedKind: string
  if (itemsInline) {
    const acceptedBodies = effectiveDvs
      .filter((d) => d.selection === 'accepted')
      .slice()
      .sort((a, b) => (a.itemIndex ?? 0) - (b.itemIndex ?? 0))
      .map((d) => readBody(d))
    acceptedContent = joinMarkdownDocs(acceptedBodies)
    acceptedKind = 'list<markdown>'
  } else {
    acceptedContent = acceptedSubsetPaths(effectiveDvs).join('\n')
    acceptedKind = 'list<path<md>>'
  }
  const rep = effectiveDvs[0]!
  // RFC-099 prompt isolation: approval_meta is a downstream-consumable PORT, so
  // it must NOT carry the decider's identity.
  const meta = JSON.stringify({
    decision: 'approved',
    decidedAt,
    reviewIteration: run.reviewIteration,
    sourceNodeId: rep.sourceNodeId,
    sourcePortName: rep.sourcePortName,
    itemCount: effectiveDvs.length,
    acceptedCount: acceptedItemIndices.length,
    acceptedItemIndices,
  })
  const acceptedArchiveJson = itemsInline
    ? null
    : subsetArchiveJson(
        await upstreamPortArchiveJson(db, run, rep.sourceNodeId, rep.sourcePortName),
        acceptedSubsetPaths(effectiveDvs),
      )
  return [
    {
      portName: REVIEW_APPROVED_PORT_MULTI,
      content: acceptedContent,
      kind: acceptedKind,
      archiveJson: acceptedArchiveJson,
    },
    { portName: REVIEW_APPROVAL_META_PORT, content: meta, kind: null, archiveJson: null },
  ]
}

/**
 * Everything a reject / iterate needs to know BEFORE it writes: the parsed
 * snapshot, the re-run set, the freshest row per upstream, the rollback target
 * and the sibling cascade. Every deterministic failure of the old path
 * (`workflow-snapshot-corrupt`, `review-node-missing-from-snapshot`) now happens
 * here, ahead of the external phase and the transaction.
 */
async function planRerun(
  args: SubmitReviewDecisionArgs,
  run: typeof nodeRuns.$inferSelect,
  taskRow: typeof tasks.$inferSelect,
  dv: DocVersion,
): Promise<PreparedRerun> {
  const { db } = args
  let definition: WorkflowDefinition | null = null
  try {
    definition = JSON.parse(taskRow.workflowSnapshot) as WorkflowDefinition
  } catch {
    throw new ValidationError(
      'workflow-snapshot-corrupt',
      `task ${taskRow.id} workflowSnapshot is invalid JSON`,
    )
  }
  const reviewNode = definition.nodes.find((n) => n.id === dv.reviewNodeId)
  if (reviewNode === undefined) {
    throw new ValidationError(
      'review-node-missing-from-snapshot',
      `review node ${dv.reviewNodeId} not in task workflow snapshot`,
    )
  }
  // RFC-149: the rerun half of the policy row. approved never reaches here.
  const rerunPolicy = (REVIEW_DECISION_POLICY[args.decision] as ReviewDecisionPolicy).rerun
  if (rerunPolicy === undefined) {
    throw new Error(
      `review decision '${args.decision}' carries no rerun policy — ` +
        'approve must early-return before the rerun block',
    )
  }
  const rerunCfgRaw = (reviewNode as Record<string, unknown>)[rerunPolicy.rerunnableKey]
  const rerunSet = new Set<string>(
    Array.isArray(rerunCfgRaw) ? rerunCfgRaw.filter((s): s is string => typeof s === 'string') : [],
  )
  rerunSet.add(dv.sourceNodeId) // direct upstream always rerunnable, regardless of config
  const rollbackFlag = readBool(reviewNode, rerunPolicy.rollbackKey, rerunPolicy.rollbackDefault)

  const upstreams: PreparedRerunUpstream[] = []
  for (const nodeId of rerunSet) {
    const upRuns = await db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, dv.taskId),
          eq(nodeRuns.nodeId, nodeId),
          eq(nodeRuns.iteration, run.iteration),
        ),
      )
    // Pick the freshest top-level upstream row with the same comparator the
    // scheduler / dispatchReviewNode use (clarifyIteration → retryIndex → ulid);
    // a plain desc(retryIndex) sort shadows the clarify-rerun row (locked by
    // review-iterate-inherits-clarify-iteration.test.ts). RFC-096: intentionally
    // no status filter — supersede must cancel live rows AND the typical done row.
    const latest = pickFreshestRun(upRuns, { topLevelOnly: true })
    if (latest === undefined) continue
    // RFC-284 T21：latest 单行口径 = 单元素集特例，收编 nextRetryIndex。
    upstreams.push({
      nodeId,
      latest,
      nextRetry: nextRetryIndex([latest]),
      rerunNodeRunId: ulid(),
      rolledBack: false,
    })
  }
  const needsRollback =
    rollbackFlag &&
    upstreams.some((u) => u.latest.preSnapshot !== null || u.latest.preSnapshotReposJson !== null)
  const rollbackTarget = needsRollback ? await loadRollbackTarget(db, taskRow.id) : null

  let cascadeReason: 'rejected' | 'iterated' | null = null
  if (rerunPolicy.cascade === 'always') {
    cascadeReason = rerunPolicy.supersededByReview
  } else if (rerunPolicy.cascade === 'sibling-sync-conditional') {
    const triggered = await iterateSiblingCascadeApplies({
      db,
      upstreamNodeId: dv.sourceNodeId,
      definition,
    })
    if (triggered) cascadeReason = rerunPolicy.supersededByReview
  }
  const siblings: PreparedSibling[] = []
  if (cascadeReason !== null) {
    for (const n of definition.nodes) {
      if (n.kind !== 'review') continue
      if (n.id === dv.reviewNodeId) continue
      const inputSource = readPortRef(n, 'inputSource')
      if (inputSource === null || inputSource.nodeId !== dv.sourceNodeId) continue
      const siblingRuns = await db
        .select()
        .from(nodeRuns)
        .where(
          and(
            eq(nodeRuns.taskId, dv.taskId),
            eq(nodeRuns.nodeId, n.id),
            eq(nodeRuns.iteration, run.iteration),
          ),
        )
      for (const s of siblingRuns) {
        if (s.parentNodeRunId !== null) continue
        const pending = await db
          .select({ id: docVersions.id })
          .from(docVersions)
          .where(and(eq(docVersions.reviewNodeRunId, s.id), eq(docVersions.decision, 'pending')))
        siblings.push({
          runId: s.id,
          reviewIteration: s.reviewIteration,
          pendingDocVersionIds: pending.map((p) => p.id),
        })
      }
    }
  }
  return { rerunPolicy, rollbackFlag, rollbackTarget, upstreams, cascadeReason, siblings }
}

/**
 * RFC-079: set one multi-document review item's curation choice
 * (accepted / not_accepted). Does NOT advance the workflow or bump
 * reviewIteration — only the round-level decision (approve/reject/iterate)
 * does, so this PATCH never trips the optimistic-lock. Validates the review is
 * still awaiting and the doc_version is a pending multi-document member.
 */
export async function setDocumentSelection(args: {
  db: DbClient
  nodeRunId: string
  docVersionId: string
  selection: 'accepted' | 'not_accepted'
}): Promise<{ taskId: string; docVersionId: string; selection: 'accepted' | 'not_accepted' }> {
  return withReviewNodeMutationLock(args.db, args.nodeRunId, () =>
    setDocumentSelectionUnlocked(args),
  )
}

async function setDocumentSelectionUnlocked(args: {
  db: DbClient
  nodeRunId: string
  docVersionId: string
  selection: 'accepted' | 'not_accepted'
}): Promise<{ taskId: string; docVersionId: string; selection: 'accepted' | 'not_accepted' }> {
  await assertReviewRoundWritable(args.db, args.nodeRunId)
  const dvRows = await args.db
    .select()
    .from(docVersions)
    .where(eq(docVersions.id, args.docVersionId))
    .limit(1)
  const dvRow = dvRows[0]
  if (dvRow === undefined || dvRow.reviewNodeRunId !== args.nodeRunId) {
    throw new NotFoundError(
      'doc-version-not-found',
      `doc_version ${args.docVersionId} not found on review ${args.nodeRunId}`,
    )
  }
  if (dvRow.itemIndex === null) {
    throw new ConflictError(
      'review-not-multi-doc',
      `doc_version ${args.docVersionId} is not a multi-document item`,
    )
  }
  if (dvRow.decision !== 'pending') {
    throw new ConflictError(
      'review-doc-decided',
      `doc_version ${args.docVersionId} already decided (${dvRow.decision})`,
    )
  }
  await args.db
    .update(docVersions)
    // RFC-129: a human judging the CURRENT content clears the inherited-stale
    // flag (the sole clear path; see loadPriorRoundMembers stale propagation).
    .set({ selection: args.selection, selectionStale: false })
    .where(eq(docVersions.id, args.docVersionId))
  emitReviewSelectionChanged(dvRow.taskId, args.nodeRunId, args.docVersionId, args.selection)
  return { taskId: dvRow.taskId, docVersionId: args.docVersionId, selection: args.selection }
}

function emitReviewSelectionChanged(
  taskId: string,
  nodeRunId: string,
  docVersionId: string,
  selection: 'unselected' | 'accepted' | 'not_accepted',
): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'review.selection_changed',
    nodeRunId,
    docVersionId,
    selection,
  })
}

async function iterateSiblingCascadeApplies(args: {
  db: DbClient
  upstreamNodeId: string
  definition: WorkflowDefinition
}): Promise<boolean> {
  const upstreamNode = args.definition.nodes.find((n) => n.id === args.upstreamNodeId)
  if (upstreamNode === undefined) return false
  // RFC-223 (PR-3a): resolve the upstream agent by the frozen CANONICAL id first
  // (rename/ABA-safe); fall back to name only for legacy / unstamped snapshots.
  const where = snapshotNodeAgentWhere(upstreamNode)
  if (where === null) return false
  const agentRows = await args.db.select().from(agentsTable).where(where).limit(1)
  const agentRow = agentRows[0]
  if (agentRow === undefined) return false
  if (!agentRow.syncOutputsOnIterate) return false
  let outputKinds: Record<string, AgentOutputKind> = {}
  try {
    const fmExtra = JSON.parse(agentRow.frontmatterExtra) as Record<string, unknown>
    const raw = fmExtra.outputKinds
    if (raw !== null && raw !== undefined && typeof raw === 'object') {
      for (const [port, kind] of Object.entries(raw as Record<string, unknown>)) {
        // RFC-081: surface every declared (string) kind; isMultiMarkdownUpstream
        // now decides which are markdown-bodied via isReviewableBodyKind, so a
        // path<md> sibling is no longer silently dropped here.
        if (typeof kind === 'string') {
          outputKinds[port] = kind
        }
      }
    }
  } catch {
    outputKinds = {}
  }
  let outputNames: string[] = []
  try {
    outputNames = JSON.parse(agentRow.outputs) as string[]
  } catch {
    return false
  }
  const { trigger } = isMultiMarkdownUpstream({
    outputs: outputNames.map((name) => {
      const kind = outputKinds[name]
      return kind !== undefined ? { name, kind } : { name }
    }),
    syncOutputsOnIterate: agentRow.syncOutputsOnIterate,
  })
  return trigger
}

// ---------------------------------------------------------------------------
// Prompt rendering for {{__review_comments__}}.
// ---------------------------------------------------------------------------

export interface RenderCommentsForPromptOptions {
  /**
   * Worktree-relative path the reviewed document was read from. When set,
   * the renderer prepends a single `**File**: \`<path>\`` line so the
   * iterate re-run prompt cites which file the agent should modify.
   * Captured at dispatch time on `doc_versions.source_file_path` for
   * markdown_file ports (and the forgiveness branch).
   */
  sourceFilePath?: string
}

/**
 * Render an array of review comments into a markdown bullet list suitable
 * for passing through `{{__review_comments__}}`. Each item carries the
 * breadcrumb path, the literal selection (with occurrence index to
 * disambiguate same-string repeats), surrounding context, and the comment.
 *
 * When `opts.sourceFilePath` is set, a single `**File**: \`<path>\`` header
 * line is emitted before the comments — without it, agents have no reliable
 * way to know which file the comments target (port content has been
 * resolved to body text by the time the iterate prompt is built).
 */
export function renderCommentsForPrompt(
  comments: readonly ReviewComment[],
  opts?: RenderCommentsForPromptOptions,
): string {
  if (comments.length === 0) return ''
  const lines: string[] = []
  const sourceFilePath = opts?.sourceFilePath?.trim()
  if (sourceFilePath !== undefined && sourceFilePath.length > 0) {
    lines.push(`**File**: \`${sourceFilePath}\``)
    lines.push('')
  }
  comments.forEach((c, idx) => {
    lines.push(`### Comment ${idx + 1}`)
    lines.push(`**Location**: ${c.anchor.sectionPath}, paragraph ${c.anchor.paragraphIdx}`)
    lines.push(
      `**Selection** (occurrence ${c.anchor.occurrenceIndex} of "${c.anchor.selectedText}"):`,
    )
    lines.push(`> …${c.anchor.contextBefore}**${c.anchor.selectedText}**${c.anchor.contextAfter}…`)
    lines.push(`**Comment**: ${c.commentText}`)
    lines.push('')
  })
  return lines.join('\n')
}

/**
 * RFC-149: per-decision ReviewPromptContext builders — the sister table to
 * REVIEW_DECISION_POLICY (design D1: these builders eat the decided
 * doc_versions row + DB/appHome handles, so they stay out of the pure-data
 * main table). `null` = the decision contributes no re-run context.
 */
type ReviewPromptCtxBuilder = (args: {
  db: DbClient
  appHome: string
  taskId: string
  upstreamNodeId: string
  dv: typeof docVersions.$inferSelect
}) => Promise<ReviewPromptContext | undefined>

const REVIEW_PROMPT_CTX_BUILDERS: Record<DocVersionDecision, ReviewPromptCtxBuilder | null> = {
  pending: null,
  approved: null,
  superseded: null,
  rejected: async ({ dv }) => ({ rejection: dv.decisionReason ?? '' }),
  iterated: async ({ db, appHome, taskId, upstreamNodeId, dv }) => {
    // RFC-079: multi-document iterate. The latest decided row is just ONE item
    // of the round; aggregate EVERY iterated item's feedback for this upstream
    // at the same reviewIteration so the re-run prompt sees all per-document
    // comments — not only the most-recently-touched item. Each item's
    // decisionReason already carries a `**File**: <path>` header (rendered with
    // its itemPath), which is the per-document distinction. Single-document rows
    // (item_index NULL) skip this and keep the legacy single-row path below.
    if (dv.itemIndex !== null) {
      const roundRows = await db
        .select()
        .from(docVersions)
        .where(
          and(
            eq(docVersions.taskId, taskId),
            eq(docVersions.sourceNodeId, upstreamNodeId),
            eq(docVersions.decision, 'iterated'),
            eq(docVersions.reviewIteration, dv.reviewIteration),
            ne(docVersions.decidedBy, SYSTEM_DECIDER),
          ),
        )
        .orderBy(asc(docVersions.itemIndex))
      const sections = roundRows
        .map((r) => (r.decisionReason ?? '').trim())
        .filter((s) => s.length > 0)
      // sibling-outputs (RFC-014 multi-PORT) is orthogonal to multi-DOC (one
      // list port, many items) and does not apply to a multi-document round.
      return {
        comments: sections.join('\n\n'),
        iterateTargetPort: dv.sourcePortName,
      }
    }
    const ctx: ReviewPromptContext = {
      comments: dv.decisionReason ?? '',
      iterateTargetPort: dv.sourcePortName,
    }
    const siblingOutputs = await buildSiblingOutputsBlock({
      db,
      appHome,
      taskId,
      upstreamNodeId,
      targetPortName: dv.sourcePortName,
    })
    if (siblingOutputs !== undefined) ctx.siblingOutputs = siblingOutputs
    return ctx
  },
}

/**
 * Build the ReviewPromptContext for the upstream re-run on reject/iterate.
 * Called by the scheduler when it re-runs the upstream node after a decision.
 *
 * RFC-014: on the iterate path, if the upstream agent declares ≥ 2 markdown
 * outputs AND has `syncOutputsOnIterate: true`, the context also carries a
 * pre-rendered `siblingOutputs` block (English consistency instruction +
 * each sibling document's current body). Reject path always leaves
 * `siblingOutputs` undefined — locked by review-prompt-injection.test.ts A6.
 */
export async function buildReviewPromptContext(
  db: DbClient,
  appHome: string,
  upstreamNodeId: string,
  taskId: string,
  iteration: number,
): Promise<ReviewPromptContext | undefined> {
  // Find the most recently USER-decided doc_version where sourceNodeId =
  // upstreamNodeId. SQLite orders NULL first in DESC, so:
  //   - pending rows must be filtered explicitly (otherwise their NULL
  //     decidedAt would win in DESC)
  //   - rows produced by cascadeSiblingReviews (decidedBy=SYSTEM_DECIDER) must
  //     be filtered too — those mark "this port's pending doc was invalidated
  //     by a sibling decision", not "the user decided on this port". Without
  //     this filter, RFC-014's multi-port iterate would surface the
  //     system-decided cascade row instead of the user's iterate row.
  const dvRows = await db
    .select()
    .from(docVersions)
    .where(
      and(
        eq(docVersions.taskId, taskId),
        eq(docVersions.sourceNodeId, upstreamNodeId),
        ne(docVersions.decision, 'pending'),
        ne(docVersions.decidedBy, SYSTEM_DECIDER),
      ),
    )
    .orderBy(desc(docVersions.decidedAt))
    .limit(1)
  const dv = dvRows[0]
  if (dv === undefined) return undefined
  // RFC-149: per-decision ctx construction is table-driven (sister table
  // above); pending / approved / superseded rows contribute no context.
  void iteration
  const builder = REVIEW_PROMPT_CTX_BUILDERS[dv.decision as DocVersionDecision] ?? null
  if (builder === null) return undefined
  const context = await builder({ db, appHome, taskId, upstreamNodeId, dv })
  if (context === undefined || dv.decision !== 'iterated') return context

  // RFC-292: the custom review-comment template belongs to the review node,
  // while the prompt is rendered for its upstream agent. Resolve it from the
  // frozen task snapshot so a mid-run workflow edit cannot change an already
  // launched task. Reject/approve/pending paths intentionally never receive it.
  const taskRow = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]
  if (taskRow === undefined) return context
  try {
    const parsed = WorkflowDefinitionSchema.parse(JSON.parse(taskRow.workflowSnapshot))
    const definition = migrateWorkflowDefinitionToLatest(parsed)
    const reviewNode = definition.nodes.find((node) => node.id === dv.reviewNodeId)
    if (reviewNode?.kind === 'review') {
      const template = (reviewNode as Record<string, unknown>).commentInjectTemplate
      if (typeof template === 'string' && template.trim().length > 0) {
        context.commentInjectTemplate = template
      }
    }
  } catch (error) {
    log.warn('review prompt: frozen workflow snapshot is invalid; using default comments', {
      taskId,
      reviewNodeId: dv.reviewNodeId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return context
}

// ---------------------------------------------------------------------------
// RFC-014: sibling-outputs block builder.
// ---------------------------------------------------------------------------

interface BuildSiblingOutputsArgs {
  db: DbClient
  appHome: string
  taskId: string
  /** Upstream agent node id (from doc_version.sourceNodeId). */
  upstreamNodeId: string
  /** Port being iterated — excluded from the sibling list. */
  targetPortName: string
}

/**
 * RFC-014 §3.2: assemble the `{{__sibling_outputs__}}` payload. Returns
 * undefined when:
 *   - the upstream agent doesn't have `syncOutputsOnIterate: true`, OR
 *   - the agent declares < 2 markdown[_file] outputs, OR
 *   - no sibling port has any doc_version body to read.
 *
 * Otherwise returns a markdown block with the stable English instruction
 * prefix + a `### {port}\n{body}` section per sibling.
 */
export async function buildSiblingOutputsBlock(
  args: BuildSiblingOutputsArgs,
): Promise<string | undefined> {
  const { db, appHome, taskId, upstreamNodeId, targetPortName } = args

  const taskRow = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]
  if (taskRow === undefined) return undefined
  let definition: WorkflowDefinition
  try {
    definition = JSON.parse(taskRow.workflowSnapshot) as WorkflowDefinition
  } catch {
    return undefined
  }
  const upstreamNode = definition.nodes.find((n) => n.id === upstreamNodeId)
  if (upstreamNode === undefined) return undefined
  // RFC-223 (PR-3a): resolve the upstream agent by the frozen CANONICAL id first
  // (rename/ABA-safe); fall back to name only for legacy / unstamped snapshots.
  const agentName = (upstreamNode as Record<string, unknown>).agentName
  const where = snapshotNodeAgentWhere(upstreamNode)
  if (where === null) return undefined
  const agentRows = await db.select().from(agentsTable).where(where).limit(1)
  const agentRow = agentRows[0]
  if (agentRow === undefined) {
    log.warn('sibling-outputs: upstream agent row not found; skipping', { agentName, taskId })
    return undefined
  }

  let outputKinds: Record<string, AgentOutputKind> = {}
  try {
    const fmExtra = JSON.parse(agentRow.frontmatterExtra) as Record<string, unknown>
    const raw = fmExtra.outputKinds
    if (raw !== null && raw !== undefined && typeof raw === 'object') {
      for (const [port, kind] of Object.entries(raw as Record<string, unknown>)) {
        // RFC-081: surface every declared (string) kind; isMultiMarkdownUpstream
        // now decides which are markdown-bodied via isReviewableBodyKind, so a
        // path<md> sibling is no longer silently dropped here.
        if (typeof kind === 'string') {
          outputKinds[port] = kind
        }
      }
    }
  } catch {
    outputKinds = {}
  }

  let outputNames: string[] = []
  try {
    outputNames = JSON.parse(agentRow.outputs) as string[]
  } catch {
    return undefined
  }

  const { trigger, markdownPorts } = isMultiMarkdownUpstream({
    outputs: outputNames.map((name) => {
      const kind = outputKinds[name]
      return kind !== undefined ? { name, kind } : { name }
    }),
    syncOutputsOnIterate: agentRow.syncOutputsOnIterate,
  })
  if (!trigger) return undefined

  const siblingPortNames = markdownPorts.filter((p) => p !== targetPortName)
  if (siblingPortNames.length === 0) return undefined

  // RFC-014 §3.2 (updated): emit worktree-relative file paths only, not body
  // text — the agent already has cwd = worktree and can re-read whichever
  // sibling files it needs. Skipping the body keeps the prompt short and
  // avoids re-injecting potentially stale snapshots when the worktree was
  // touched between iterations. Inline `markdown` ports (no sourceFilePath)
  // are skipped entirely; if every sibling is inline → return undefined and
  // the prompt token resolves to empty.
  void appHome
  const sections: string[] = []
  for (const portName of siblingPortNames) {
    const rows = await db
      .select()
      .from(docVersions)
      .where(
        and(
          eq(docVersions.taskId, taskId),
          eq(docVersions.sourceNodeId, upstreamNodeId),
          eq(docVersions.sourcePortName, portName),
        ),
      )
      .orderBy(desc(docVersions.reviewIteration), desc(docVersions.createdAt))
      .limit(1)
    const row = rows[0]
    if (row === undefined) continue
    const path = row.sourceFilePath
    if (path === null || path === undefined || path.trim().length === 0) continue
    sections.push(`- ${portName}: ${path}`)
  }
  if (sections.length === 0) return undefined
  return `${SIBLING_OUTPUTS_INSTRUCTION}\n\n${sections.join('\n')}`
}

// ---------------------------------------------------------------------------
// WS broadcast helpers.
// ---------------------------------------------------------------------------

function broadcastReviewCreated(
  taskId: string,
  nodeRunId: string,
  reviewNodeId: string,
  dv: DocVersion,
): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'review.created',
    nodeRunId,
    reviewNodeId,
    docVersionId: dv.id,
    versionIndex: dv.versionIndex,
    reviewIteration: dv.reviewIteration,
  })
}

/**
 * Broadcast a review.decision_made event — called from a context that has
 * the taskId directly (REST decision handler).
 */
export function emitReviewDecisionEvent(
  taskId: string,
  nodeRunId: string,
  decision: ReviewDecisionKind,
  reviewIteration: number,
  docVersionDecision: DocVersionDecision,
): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'review.decision_made',
    nodeRunId,
    decision,
    reviewIteration,
    docVersionDecision,
  })
}

export function emitReviewCommentAddedEvent(
  taskId: string,
  nodeRunId: string,
  docVersionId: string,
  comment: ReviewComment,
): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'review.comment_added',
    nodeRunId,
    docVersionId,
    comment,
  })
}

export function emitReviewCommentDeletedEvent(
  taskId: string,
  nodeRunId: string,
  docVersionId: string,
  commentId: string,
): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'review.comment_deleted',
    nodeRunId,
    docVersionId,
    commentId,
  })
}

export function emitReviewCommentUpdatedEvent(
  taskId: string,
  nodeRunId: string,
  docVersionId: string,
  comment: ReviewComment,
): void {
  taskBroadcaster.broadcast(TASK_CHANNEL(taskId), {
    id: -1,
    type: 'review.comment_updated',
    nodeRunId,
    docVersionId,
    comment,
  })
}

// ---------------------------------------------------------------------------
// Row → DTO conversions.
// ---------------------------------------------------------------------------

function rowToDocVersion(row: typeof docVersions.$inferSelect): DocVersion {
  return {
    id: row.id,
    taskId: row.taskId,
    reviewNodeId: row.reviewNodeId,
    reviewNodeRunId: row.reviewNodeRunId,
    sourceNodeId: row.sourceNodeId,
    sourcePortName: row.sourcePortName,
    versionIndex: row.versionIndex,
    reviewIteration: row.reviewIteration,
    bodyPath: row.bodyPath,
    commentsJson: row.commentsJson,
    decision: row.decision as DocVersionDecision,
    decisionReason: row.decisionReason,
    promptSnapshot: row.promptSnapshot,
    sourceFilePath: row.sourceFilePath,
    // RFC-079: multi-document fields (NULL on single-document rows).
    itemIndex: row.itemIndex,
    selection: row.selection,
    itemPath: row.itemPath,
    // RFC-129: inheritance staleness ({ mode: 'boolean' } → boolean | null).
    selectionStale: row.selectionStale ?? null,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    decidedBy: row.decidedBy,
    decidedByRole: (row.decidedByRole ?? null) as DocVersion['decidedByRole'],
  }
}

function rowToReviewComment(row: typeof reviewComments.$inferSelect): ReviewComment {
  return {
    id: row.id,
    docVersionId: row.docVersionId,
    anchor: {
      sectionPath: row.anchorSectionPath,
      paragraphIdx: row.anchorParagraphIdx,
      offsetStart: row.anchorOffsetStart,
      offsetEnd: row.anchorOffsetEnd,
      selectedText: row.selectedText,
      contextBefore: row.contextBefore,
      contextAfter: row.contextAfter,
      occurrenceIndex: row.occurrenceIndex,
    },
    commentText: row.commentText,
    author: row.author,
    authorRole: (row.authorRole ?? null) as ReviewComment['authorRole'],
    createdAt: row.createdAt,
  }
}

// ---------------------------------------------------------------------------
// Misc helpers.
// ---------------------------------------------------------------------------

function readPortRef(node: WorkflowNode, key: string): { nodeId: string; portName: string } | null {
  const v = (node as Record<string, unknown>)[key]
  if (v === undefined || v === null || typeof v !== 'object') return null
  const rec = v as Record<string, unknown>
  if (typeof rec.nodeId !== 'string' || typeof rec.portName !== 'string') return null
  return { nodeId: rec.nodeId, portName: rec.portName }
}

function readBool(node: WorkflowNode, key: string, fallback: boolean): boolean {
  const v = (node as Record<string, unknown>)[key]
  return typeof v === 'boolean' ? v : fallback
}

// Exported for the regression test that locks the path<md> recognition fix.
export async function loadUpstreamPortKind(
  db: DbClient,
  definition: WorkflowDefinition,
  nodeId: string,
  portName: string,
): Promise<AgentOutputKind | undefined> {
  const node = definition.nodes.find((n) => n.id === nodeId)
  if (node === undefined) return undefined
  if (node.kind !== 'agent-single') return undefined
  // RFC-223 (PR-3a): resolve by the frozen CANONICAL id first (rename/ABA-safe).
  const where = snapshotNodeAgentWhere(node)
  if (where === null) return undefined
  const rows = await db.select().from(agentsTable).where(where).limit(1)
  const row = rows[0]
  if (row === undefined) return undefined
  try {
    const parsed = JSON.parse(row.frontmatterExtra) as Record<string, unknown>
    const kinds = parsed.outputKinds
    if (kinds !== undefined && kinds !== null && typeof kinds === 'object') {
      const v = (kinds as Record<string, unknown>)[portName]
      if (typeof v !== 'string') return undefined
      // 'string' = opaque passthrough (legacy; not markdown but harmless —
      // resolvePortContentDetailed passes it through unchanged).
      if (v === 'string') return v
      // Single-document markdownish input: base 'markdown' or path<md> /
      // path<markdown> (the legacy 'markdown_file' folds to path<md> at parse).
      // Use the canonical kindParser predicate so this never drifts from the
      // validator / resolvePortContentDetailed. CRITICAL: a bare path<md> MUST
      // resolve here and be returned — otherwise dispatchReviewNode passes
      // `kind: undefined` to resolvePortContentDetailed, which raw-passes the
      // worktree path string through as the document body instead of reading
      // the .md file from disk (the reported bug: review sees the path, not the
      // file content).
      if (isReviewableBodyKindString(v)) return v
      // RFC-079: a list<markdownish> kind (list<path<md>> / list<markdown>)
      // drives multi-document review — return it so dispatchReviewNode enters
      // multi-doc mode.
      if (isMultiDocReviewInput(v)) return v
    }
  } catch {
    /* fall through */
  }
  return undefined
}
