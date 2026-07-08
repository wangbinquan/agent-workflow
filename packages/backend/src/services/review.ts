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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm'
import { dbTxSync } from '@/db/txSync'
import { ulid } from 'ulid'
import type {
  AgentOutputKind,
  DocVersion,
  DocVersionDecision,
  ReviewComment,
  ReviewCommentAnchor,
  ReviewDecisionKind,
  ReviewDetail,
  ReviewSummary,
  ReviewPromptContext,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'
import { isMultiMarkdownUpstream, SIBLING_OUTPUTS_INSTRUCTION } from '@agent-workflow/shared'
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
} from '@agent-workflow/shared'
import type {
  PriorRoundMember,
  ReviewDocumentSummary,
  ReviewRoundMember,
  ReviewRoundSummary,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import {
  agents as agentsTable,
  docVersions,
  nodeRunOutputs,
  nodeRuns,
  reviewComments,
  tasks,
  workflows,
} from '@/db/schema'
import { resolvePortContentDetailed } from '@/services/envelope'
import { pickFreshestRun } from '@/services/freshness'
import { parseConsumedJson } from '@/services/freshness'
import { setNodeRunStatus, transitionNodeRunStatus } from '@/services/lifecycle'
import { enqueueDistillJob } from '@/services/memoryDistillScheduler'
import { mintNodeRun } from '@/services/nodeRunMint'
import { loadRollbackTarget, rollbackNodeRunWorktrees } from '@/services/nodeRollback'
import { getTaskWriteSem } from '@/services/taskWriteLocks'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'

/** RFC-145: human-readable supersede breadcrumb prefix (message builder only —
 *  the machine contract is the superseded_by_review / rolled_back columns). */
const REVIEW_SUPERSEDE_MARKER_PREFIX = 'superseded-by-review-'

const log = createLogger('review')

// ---------------------------------------------------------------------------
// Anchor — pure functions.
// ---------------------------------------------------------------------------

/**
 * Find every occurrence of `needle` in `haystack` and return their 0-based
 * start offsets in the order they appear. Exposed (vs. inlined) so tests can
 * pin the contract.
 */
export function findAllOccurrences(haystack: string, needle: string): number[] {
  if (needle.length === 0) return []
  const out: number[] = []
  let from = 0
  while (true) {
    const idx = haystack.indexOf(needle, from)
    if (idx < 0) break
    out.push(idx)
    from = idx + needle.length
  }
  return out
}

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
export class AnchorValidationError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
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
 * what the canonical document actually says. All other anchor fields stay as
 * the client posted them — the source of truth for which selection range a
 * comment refers to is `(sectionPath + paragraphIdx + offsetStart/End +
 * selectedText)`; only the occurrenceIndex disambiguates same-string repeats.
 */
export function canonicalizeAnchor(
  docBody: string,
  anchor: ReviewCommentAnchor,
): ReviewCommentAnchor {
  const recomputed = recomputeOccurrenceIndex(docBody, anchor)
  return { ...anchor, occurrenceIndex: recomputed.occurrenceIndex }
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

export interface DispatchReviewArgs {
  db: DbClient
  taskId: string
  task: typeof tasks.$inferSelect
  appHome: string
  definition: WorkflowDefinition
  node: WorkflowNode // the review node
  iteration: number
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
export async function dispatchReviewNode(args: DispatchReviewArgs): Promise<DispatchReviewResult> {
  const { db, taskId, task, appHome, definition, node, iteration } = args

  const inputSource = readPortRef(node, 'inputSource')
  if (inputSource === null) {
    return {
      kind: 'failed',
      summary: `review node ${node.id} missing inputSource`,
      message: 'review-input-source-missing',
    }
  }

  const sourcePortName = inputSource.portName
  const sourceNodeId = inputSource.nodeId

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
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, sourceNodeId),
        eq(nodeRuns.iteration, iteration),
      ),
    )
  // RFC-096: shared picker, top-level only (fan-out child rows skipped —
  // multi-process review per-shard is RFC-005 T14). Deliberately NO statusIn
  // filter: the freshest row must be checked for done-ness below — filtering
  // would silently fall back to an OLDER done row instead of failing loudly
  // with review-upstream-not-done.
  const sourceRun = pickFreshestRun(sourceRuns, { topLevelOnly: true })
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

  const upstreamKind = await loadUpstreamPortKind(db, definition, sourceNodeId, sourcePortName)
  // RFC-079: a list<markdownish> upstream puts this review in MULTI-DOCUMENT
  // mode — each list item is archived as its own doc_version below.
  const isMultiDoc = isMultiDocReviewInput(upstreamKind ?? '')
  let resolvedBody = ''
  let resolvedSourcePath: string | undefined
  let itemPaths: string[] = []
  let inlineBodies: string[] = []
  // RFC-081: list<markdown> items are inline document bodies framed by
  // MARKDOWN_DOC_BOUNDARY; list<path<md>> items are newline-separated worktree
  // paths (read from disk at archive time).
  const itemsInline = isMultiDoc && isInlineMarkdownListReviewInput(upstreamKind ?? '')
  if (isMultiDoc) {
    if (itemsInline) {
      inlineBodies = splitMarkdownDocs(portRow.content)
    } else {
      // Split with the SAME shared splitter the validator / downstream
      // wrapper-fanout use so the reviewed item set matches the shard set
      // byte-for-byte. Each item's body is read from the worktree below.
      itemPaths = splitListItems(portRow.content)
    }
  } else {
    try {
      const resolved = resolvePortContentDetailed({
        rawContent: portRow.content,
        kind: upstreamKind,
        worktreePath: task.worktreePath,
      })
      resolvedBody = resolved.body
      resolvedSourcePath = resolved.sourcePath
    } catch (err) {
      return {
        kind: 'failed',
        summary: `review node ${node.id}: ${(err as Error).message}`,
        message: 'review-source-resolve-failed',
      }
    }
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

  let reviewNodeRunId: string
  let reviewIteration: number
  if (reuse !== undefined && reuse.status === 'awaiting_review') {
    // A live awaiting_review row is the open review for this node. Reuse it and
    // fall through to the doc_version find-or-create below, which re-broadcasts
    // the parked version (resume idempotence, B18) or mints one if it is
    // missing (e.g. the S1 repair "recreate doc_version" path).
    reviewNodeRunId = reuse.id
    reviewIteration = reuse.reviewIteration
    if (!coversSource(reuse)) {
      // (T-B10 / §7) Awaiting on a STALE source — the user is mid-review and the
      // upstream produced a fresher run. Refresh in place: retire the pending
      // doc_version(s), drop their now-meaningless anchored comments, re-stamp
      // the row's provenance. createDocVersion below makes v(n+1) on new body.
      // RFC-093: synchronous transaction (dbTxSync) — the previous
      // `db.transaction(async …)` COMMITted at its first await and left this
      // three-step retire sequence non-atomic (audit S-10).
      dbTxSync(db, (tx) => {
        const stale = tx
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
        for (const s of stale) {
          tx.delete(reviewComments).where(eq(reviewComments.docVersionId, s.id)).run()
        }
        tx.update(docVersions)
          .set({
            decision: 'superseded',
            decisionReason: 'upstream-refreshed',
            decidedBy: 'system',
            decidedAt: Date.now(),
          })
          .where(
            and(
              eq(docVersions.reviewNodeRunId, reuse.id),
              eq(docVersions.sourcePortName, sourcePortName),
              eq(docVersions.decision, 'pending'),
            ),
          )
          .run()
        tx.update(nodeRuns)
          .set({ consumedUpstreamRunsJson: consumedJson })
          .where(eq(nodeRuns.id, reuse.id))
          .run()
      })
    }
  } else if (latestDone !== undefined && coversSource(latestDone)) {
    // A prior decision (approve / reject / iterate) still covers the current
    // source — nothing to do. This is RFC-052's "any done is decisive", now
    // scoped to provenance: null/legacy consumed counts as covering (D4), so
    // pre-RFC-074 approvals AND the terminal-state placeholder-row case (a
    // higher-retry failed row sitting beside an approved done row) short-circuit
    // exactly as before. Only a recorded-different consumption falls through to
    // a US-2 re-review below.
    return { kind: 'ok', summary: '', message: '' }
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
    await db
      .update(nodeRuns)
      .set({ consumedUpstreamRunsJson: consumedJson })
      .where(eq(nodeRuns.id, reviewNodeRunId))
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
          try {
            body = readFileSync(join(task.worktreePath, itemPath), 'utf8')
          } catch {
            // A missing / unreadable file must not wedge the whole round — the
            // reviewer can still reject it. Surface a visible placeholder body.
            body = `> ⚠️ RFC-079: file not found in worktree: \`${itemPath}\``
          }
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
    // One broadcast is enough — the WS event just triggers an inbox/detail
    // refetch that pulls the whole document set. Empty list → park an empty
    // round (approve emits an empty `accepted`); skip the broadcast (no dv).
    if (docs.length > 0) {
      broadcastReviewCreated(taskId, reviewNodeRunId, node.id, docs[0]!)
    }
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
  for (const r of byIndex.values()) {
    let body = ''
    try {
      body = readFileSync(join(appHome, r.bodyPath), 'utf8')
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

export function readDocVersionBody(appHome: string, docVersion: DocVersion): string {
  const abs = join(appHome, docVersion.bodyPath)
  if (!existsSync(abs)) {
    throw new NotFoundError('doc-version-body-missing', `doc_version body file not found: ${abs}`)
  }
  return readFileSync(abs, 'utf8')
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

export async function listReviewSummaries(
  db: DbClient,
  filter: ListReviewSummariesFilter = {},
): Promise<ReviewSummary[]> {
  // Join doc_versions ↔ nodeRuns ↔ tasks ↔ workflows. We do it manually with
  // separate selects to keep things composable across drizzle limitations on
  // SQLite multi-join.
  const dvRows = await db
    .select()
    .from(docVersions)
    .orderBy(desc(docVersions.createdAt))
    .limit(filter.limit ?? 100)

  if (dvRows.length === 0) return []

  const nodeRunIds = Array.from(new Set(dvRows.map((r) => r.reviewNodeRunId)))
  const nodeRunRowsRaw = await db.select().from(nodeRuns)
  const runById = new Map(
    nodeRunRowsRaw.filter((r) => nodeRunIds.includes(r.id)).map((r) => [r.id, r]),
  )
  const taskIds = Array.from(new Set(dvRows.map((r) => r.taskId)))
  const taskRowsAll = await db.select().from(tasks)
  const taskById = new Map(taskRowsAll.filter((r) => taskIds.includes(r.id)).map((r) => [r.id, r]))
  const workflowIds = Array.from(new Set(Array.from(taskById.values()).map((t) => t.workflowId)))
  const wfRowsAll = await db.select().from(workflows)
  const wfById = new Map(wfRowsAll.filter((r) => workflowIds.includes(r.id)).map((r) => [r.id, r]))

  // Parse each task's workflowSnapshot once to extract the per-review-node
  // human-readable title/description set in the workflow editor. Falls back
  // to {} on corrupt JSON; the per-row lookup then degrades to nodeId/empty.
  const reviewNodeMetaByTask = new Map<
    string,
    Map<string, { title: string; description: string }>
  >()
  for (const task of taskById.values()) {
    const meta = new Map<string, { title: string; description: string }>()
    try {
      const def = JSON.parse(task.workflowSnapshot) as WorkflowDefinition
      for (const node of def.nodes ?? []) {
        if ((node as { kind?: string }).kind !== 'review') continue
        const n = node as Record<string, unknown>
        const title = typeof n.title === 'string' ? n.title : ''
        const description = typeof n.description === 'string' ? n.description : ''
        meta.set(node.id, { title, description })
      }
    } catch {
      // corrupt snapshot — leave meta empty, callers fall back to nodeId.
    }
    reviewNodeMetaByTask.set(task.id, meta)
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
    if (filter.status !== undefined && filter.status !== 'all') {
      if (filter.status === 'pending' && !awaitingReview) continue
      if (filter.status === 'approved' && dv.decision !== 'approved') continue
      if (filter.status === 'rejected' && dv.decision !== 'rejected') continue
      if (filter.status === 'iterated' && dv.decision !== 'iterated') continue
    }
    if (filter.taskId !== undefined && filter.taskId !== task.id) continue
    if (filter.workflowId !== undefined && filter.workflowId !== task.workflowId) continue
    const nodeMeta = reviewNodeMetaByTask.get(task.id)?.get(dv.reviewNodeId)
    const titleTrimmed = nodeMeta?.title.trim() ?? ''
    out.push({
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
      isMultiDoc: dv.itemIndex !== null && dv.itemIndex !== undefined,
      createdAt: dv.createdAt,
      decidedAt: dv.decidedAt,
    })
  }
  return out
}

export async function countPendingReviews(db: DbClient): Promise<number> {
  const summaries = await listReviewSummaries(db, { status: 'pending', limit: 500 })
  return summaries.length
}

export async function getReviewDetail(
  db: DbClient,
  appHome: string,
  nodeRunId: string,
): Promise<ReviewDetail> {
  const summary = (await listReviewSummaries(db, { limit: 500 })).find(
    (s) => s.nodeRunId === nodeRunId,
  )
  if (summary === undefined) {
    throw new NotFoundError('review-not-found', `review for nodeRun ${nodeRunId} not found`)
  }
  const allRows = await db
    .select()
    .from(docVersions)
    .where(eq(docVersions.reviewNodeRunId, nodeRunId))
  if (allRows.length === 0) {
    throw new NotFoundError('review-not-found', `no doc_versions for ${nodeRunId}`)
  }
  // RFC-079: multi-document mode (any member carries item_index). Build the
  // document list and default the rendered "current" document to the first
  // item; the frontend lazy-loads other items via the versions endpoint.
  const isMulti = allRows.some((r) => r.itemIndex !== null)
  let dv: DocVersion
  let body: string
  let documents: ReviewDocumentSummary[] | undefined
  if (isMulti) {
    // Current round = pending members (awaiting); if decided, the members of
    // the newest round at the highest reviewIteration. RFC-142 (G4): "newest
    // round" must respect RFC-129 round_generation — an upstream refresh
    // leaves two generations at the SAME reviewIteration (superseded old gen
    // + fresh gen), and iteration-only filtering mixed both generations into
    // the document list (duplicate itemIndex entries). Legacy iterations
    // whose rows all predate migration 0070 (NULL generation) keep the
    // whole-iteration behavior unchanged.
    const itemRows = allRows.filter((r) => r.itemIndex !== null)
    let members = itemRows.filter((r) => r.decision === 'pending')
    if (members.length === 0) {
      const maxIter = Math.max(...itemRows.map((r) => r.reviewIteration))
      const atIter = itemRows.filter((r) => r.reviewIteration === maxIter)
      const gens = atIter.map((r) => r.roundGeneration).filter((g): g is number => g !== null)
      members =
        gens.length > 0 ? atIter.filter((r) => r.roundGeneration === Math.max(...gens)) : atIter
    }
    members.sort((a, b) => (a.itemIndex ?? 0) - (b.itemIndex ?? 0))
    documents = []
    for (const m of members) {
      documents.push((await buildRoundMember(db, appHome, m)).summary)
    }
    dv = rowToDocVersion(members[0]!)
    try {
      body = readDocVersionBody(appHome, dv)
    } catch {
      body = ''
    }
  } else {
    // Single-document: latest version (behavior unchanged).
    const latest = allRows.slice().sort((a, b) => b.versionIndex - a.versionIndex)[0]!
    dv = rowToDocVersion(latest)
    body = readDocVersionBody(appHome, dv)
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
  const body = readDocVersionBody(appHome, dv)
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
    mbody = readDocVersionBody(appHome, mdv)
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
  decidedByRole: 'owner' | 'user' | 'admin' | null
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
  anchor: ReviewCommentAnchor
  commentText: string
  author?: string
  /** RFC-099 (D7) — task-relationship role snapshot; UI/audit only. */
  authorRole?: 'owner' | 'user' | 'admin'
  /**
   * RFC-079: in a multi-document round several doc_versions are pending at once;
   * the caller passes the specific document the comment anchors to. Single-doc
   * callers omit it and the (one) pending doc_version is used.
   */
  docVersionId?: string
}

export async function addReviewComment(args: AddReviewCommentArgs): Promise<ReviewComment> {
  // Pending doc_version for this review run. RFC-079: when docVersionId is given
  // (multi-document), scope to that exact pending member.
  const dvRows = await args.db
    .select()
    .from(docVersions)
    .where(
      args.docVersionId !== undefined
        ? and(
            eq(docVersions.id, args.docVersionId),
            eq(docVersions.reviewNodeRunId, args.nodeRunId),
            eq(docVersions.decision, 'pending'),
          )
        : and(eq(docVersions.reviewNodeRunId, args.nodeRunId), eq(docVersions.decision, 'pending')),
    )
    .limit(1)
  if (dvRows.length === 0) {
    throw new ConflictError(
      'review-not-awaiting',
      `review ${args.nodeRunId} has no pending doc_version`,
    )
  }
  const dv = rowToDocVersion(dvRows[0]!)
  const body = readDocVersionBody(args.appHome, dv)
  const canonical = canonicalizeAnchor(body, args.anchor)

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
    author: args.author ?? 'local',
    authorRole: args.authorRole ?? null,
    createdAt: now,
  })

  const comment: ReviewComment = {
    id,
    docVersionId: dv.id,
    anchor: canonical,
    commentText: args.commentText,
    author: args.author ?? 'local',
    authorRole: args.authorRole ?? null,
    createdAt: now,
  }
  emitReviewCommentAddedEvent(dv.taskId, args.nodeRunId, dv.id, comment)
  return comment
}

// RFC-009-T1: edit an existing review comment's body. Only allowed while the
// review is still awaiting a decision (pending doc_version exists for this
// nodeRunId AND the comment belongs to that pending doc_version). We do not
// touch the anchor or createdAt — only commentText changes, and a 409 is the
// outcome once the review has been approved/rejected/iterated.
export async function updateReviewCommentText(
  db: DbClient,
  nodeRunId: string,
  commentId: string,
  commentText: string,
): Promise<ReviewComment> {
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
): Promise<void> {
  const rows = await db
    .select()
    .from(reviewComments)
    .where(eq(reviewComments.id, commentId))
    .limit(1)
  if (rows.length === 0) {
    throw new NotFoundError('review-comment-not-found', `review_comment ${commentId} not found`)
  }
  const row = rows[0]!
  await db.delete(reviewComments).where(eq(reviewComments.id, commentId))
  // Look up the taskId via the doc_version so we can scope the broadcast.
  const dvRow = await db
    .select({ taskId: docVersions.taskId })
    .from(docVersions)
    .where(eq(docVersions.id, row.docVersionId))
    .limit(1)
  if (dvRow[0] !== undefined) {
    emitReviewCommentDeletedEvent(dvRow[0].taskId, nodeRunId, row.docVersionId, commentId)
  }
}

// ---------------------------------------------------------------------------
// Decision (approve / reject / iterate).
// ---------------------------------------------------------------------------

export interface SubmitReviewDecisionArgs {
  db: DbClient
  appHome: string
  nodeRunId: string
  decision: ReviewDecisionKind
  rejectReason?: string
  /** Optimistic-lock guard against the iteration the client saw. */
  expectedReviewIteration: number
  author?: string
  /** RFC-099 (D7) — task-relationship role snapshot of the decider. */
  authorRole?: 'owner' | 'user' | 'admin'
}

export interface SubmitReviewDecisionResult {
  taskId: string
  reviewIteration: number
  /**
   * For reject/iterate the caller should re-enter the scheduler by calling
   * resumeTask(taskId); approve completes inline.
   */
  resumeRequired: boolean
}

/**
 * RFC-079: multi-document approve. Writes the curated subset (accepted items,
 * in item_index order) to the `accepted` output port as a newline-joined
 * list<path<md>>, plus an `approval_meta` blob, then transitions the review
 * node_run to done. The per-document doc_versions are already archived as
 * decision='approved' by the caller. The single-document approve path is
 * untouched — this is only reached when the round has item_index rows.
 */
async function approveMultiDocReview(args: {
  db: DbClient
  appHome: string
  nodeRunId: string
  run: typeof nodeRuns.$inferSelect
  dvs: DocVersion[]
  author?: string
}): Promise<SubmitReviewDecisionResult> {
  const { db, appHome, nodeRunId, run, dvs } = args
  const decidedAt = Date.now()
  const acceptedItemIndices = dvs
    .filter((d) => d.selection === 'accepted')
    .map((d) => d.itemIndex)
    .filter((i): i is number => i !== null && i !== undefined)
    .sort((a, b) => a - b)
  // RFC-081: a list<markdown> round archives items inline (item_path NULL) — the
  // accepted subset is the accepted bodies (in item order) joined by
  // MARKDOWN_DOC_BOUNDARY, emitted as list<markdown>. A list<path<md>> round
  // joins accepted worktree paths by newline, emitted as list<path<md>>. Empty
  // subset → empty content → downstream wrapper-fanout sees an empty list and
  // completes immediately. Detect inline from the archived rows.
  const itemsInline = dvs.length > 0 && dvs.every((d) => (d.itemPath ?? null) === null)
  let acceptedContent: string
  let acceptedKind: string
  if (itemsInline) {
    const acceptedBodies = dvs
      .filter((d) => d.selection === 'accepted')
      .slice()
      .sort((a, b) => (a.itemIndex ?? 0) - (b.itemIndex ?? 0))
      .map((d) => readDocVersionBody(appHome, d))
    acceptedContent = joinMarkdownDocs(acceptedBodies)
    acceptedKind = 'list<markdown>'
  } else {
    acceptedContent = acceptedSubsetPaths(dvs).join('\n')
    acceptedKind = 'list<path<md>>'
  }
  const rep = dvs[0]!
  // RFC-099 prompt isolation: approval_meta is a downstream-consumable PORT,
  // so it must NOT carry the decider's identity. doc_versions.decided_by(_role)
  // keeps the audit record for the UI.
  const meta = JSON.stringify({
    decision: 'approved',
    decidedAt,
    reviewIteration: run.reviewIteration,
    sourceNodeId: rep.sourceNodeId,
    sourcePortName: rep.sourcePortName,
    itemCount: dvs.length,
    acceptedCount: acceptedItemIndices.length,
    acceptedItemIndices,
  })
  await db
    .insert(nodeRunOutputs)
    .values({ nodeRunId, portName: 'accepted', content: acceptedContent, kind: acceptedKind })
    .onConflictDoUpdate({
      target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
      set: { content: acceptedContent, kind: acceptedKind },
    })
  await db
    .insert(nodeRunOutputs)
    .values({ nodeRunId, portName: 'approval_meta', content: meta })
    .onConflictDoUpdate({
      target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
      set: { content: meta },
    })
  await transitionNodeRunStatus({
    db,
    nodeRunId,
    event: { kind: 'approve-review' },
    extra: { finishedAt: decidedAt },
  })
  await enqueueDistillJob(db, {
    sourceKind: 'review',
    sourceEventId: rep.id,
    taskId: rep.taskId,
  }).catch(() => {
    /* swallow — distill is async, must not affect the decision return path */
  })
  return { taskId: rep.taskId, reviewIteration: run.reviewIteration, resumeRequired: true }
}

export async function submitReviewDecision(
  args: SubmitReviewDecisionArgs,
): Promise<SubmitReviewDecisionResult> {
  // Re-read the review node_run + pending doc_version.
  const runRows = await args.db
    .select()
    .from(nodeRuns)
    .where(eq(nodeRuns.id, args.nodeRunId))
    .limit(1)
  if (runRows.length === 0) {
    throw new NotFoundError('review-not-found', `review run ${args.nodeRunId} not found`)
  }
  const run = runRows[0]!
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

  // RFC-079: a multi-document round has N pending doc_versions (one per list
  // item, item_index set); single-document has exactly one (item_index NULL).
  // Single-document behavior is preserved exactly: with one pending row the
  // loop + branches below collapse to the legacy path. (`.limit(1)` is dropped
  // in favor of ordering by item_index so every member of a round is decided.)
  const dvRows = await args.db
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
  const isMultiDoc = dvs.some((d) => d.itemIndex !== null && d.itemIndex !== undefined)

  // RFC-079: a multi-document approve requires every document decided
  // (accepted / not_accepted) — reject an undecided round before any mutation.
  if (isMultiDoc && args.decision === 'approved' && !allDocumentsDecided(dvs)) {
    throw new ConflictError(
      'review-selection-incomplete',
      `review ${args.nodeRunId} has undecided documents; decide every document before approving`,
    )
  }

  // 1. Archive each pending doc_version's comments into its snapshot + drop the
  //    row-side comments. Single-document = exactly one iteration. For iterate,
  //    each document's own comments render into its decisionReason (carried,
  //    with a File header, into the aggregated re-run prompt by
  //    buildReviewPromptContext).
  for (const d of dvs) {
    const commentRows = await args.db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.docVersionId, d.id))
      .orderBy(asc(reviewComments.anchorParagraphIdx), asc(reviewComments.anchorOffsetStart))
    const commentsArr = commentRows.map(rowToReviewComment)
    await args.db
      .update(docVersions)
      .set({
        decision: args.decision,
        decisionReason:
          args.decision === 'rejected'
            ? (args.rejectReason ?? null)
            : args.decision === 'iterated'
              ? renderCommentsForPrompt(commentsArr, {
                  ...(d.sourceFilePath ? { sourceFilePath: d.sourceFilePath } : {}),
                })
              : null,
        decidedAt: Date.now(),
        decidedBy: args.author ?? 'local',
        decidedByRole: args.authorRole ?? null,
        commentsJson: JSON.stringify(commentsArr),
      })
      .where(eq(docVersions.id, d.id))
    await args.db.delete(reviewComments).where(eq(reviewComments.docVersionId, d.id))
  }

  // 2. Broadcast decision.
  emitReviewDecisionEvent(
    dv.taskId,
    args.nodeRunId,
    args.decision,
    run.reviewIteration + (args.decision === 'approved' ? 0 : 1),
    args.decision,
  )

  // 3. Per-decision state mutation.
  if (args.decision === 'approved') {
    if (isMultiDoc) {
      // RFC-079: multi-document approve emits the curated subset (accepted
      // items, in item order) on the `accepted` port instead of approved_doc.
      return approveMultiDocReview({
        db: args.db,
        appHome: args.appHome,
        nodeRunId: args.nodeRunId,
        run,
        dvs,
        author: args.author,
      })
    }
    // Publish the two declared output ports (`approved_doc`, `approval_meta`)
    // into node_run_outputs so downstream output bindings + the task-detail
    // TaskOutputPanel can resolve them. Without these rows downstream
    // consumers see no output for the review run and render "等待中…" forever
    // even though the review is `done` and the upstream content exists. The
    // workflow.validator already promises these ports exist (RFC-005
    // design.md §2.2, workflow.validator.ts approved_doc / approval_meta).
    //
    // approved_doc must mirror the *shape* upstream emitted, not the
    // resolved body — otherwise a downstream agent declared to consume
    // `markdown_file` paths would receive raw markdown text and break. When
    // the doc_version carries a sourceFilePath (= upstream port was kind
    // 'markdown_file'), pass the same worktree-relative path through so
    // downstream's resolvePortContent re-reads the file. Inline markdown
    // (no sourceFilePath) still publishes the body verbatim.
    const decidedAt = Date.now()
    const sourcePath = dv.sourceFilePath ?? null
    const hasSourcePath = sourcePath !== null && sourcePath.trim().length > 0
    const approvedDocContent = hasSourcePath
      ? (sourcePath as string)
      : readDocVersionBody(args.appHome, dv)
    // RFC-072: when the approved doc is a passed-through file path (upstream
    // port was a markdownish file kind → sourceFilePath set), persist that kind
    // so the task-detail Outputs tab offers a Download button. Inline-markdown
    // approvals carry the body verbatim → no file kind, no download.
    // flag-audit §8 决策：写 canonical 'path<md>'，不再向新行倒灌 legacy 别名
    // 'markdown_file'（kindParser 约定 stringifyKind 永不输出别名；存量行由
    // migration 0075 清洗，读侧 parse 时两者本就等价折叠）。
    const approvedDocKind = hasSourcePath ? 'path<md>' : null
    // RFC-099 prompt isolation: no decider identity in the port payload.
    const meta = JSON.stringify({
      decision: 'approved',
      decidedAt,
      reviewIteration: run.reviewIteration,
      versionIndex: dv.versionIndex,
      sourceNodeId: dv.sourceNodeId,
      sourcePortName: dv.sourcePortName,
    })
    // RFC-052: upsert outputs instead of plain insert. The original code threw
    // SqliteError(UNIQUE) on the (nodeRunId, portName) PK when the user
    // approved a phantom v(n+1) that the buggy dispatchReviewNode had minted
    // after a first approve — and the throw skipped the `status='done'`
    // update + `resumeRequired` return, leaving the node_run in a half-
    // decided middle state forever. With T1 + T2 in place this path
    // shouldn't be re-entered with already-existing outputs, but keep upsert
    // as a defense-in-depth: any future edge that reaches the approved
    // branch twice no longer corrupts node_run state.
    await args.db
      .insert(nodeRunOutputs)
      .values({
        nodeRunId: args.nodeRunId,
        portName: 'approved_doc',
        content: approvedDocContent,
        kind: approvedDocKind,
      })
      .onConflictDoUpdate({
        target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
        set: { content: approvedDocContent, kind: approvedDocKind },
      })
    await args.db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: args.nodeRunId, portName: 'approval_meta', content: meta })
      .onConflictDoUpdate({
        target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
        set: { content: meta },
      })
    // RFC-053: approve-review enforces awaiting_review → done at the helper.
    // Pre-check at line ~1045 also catches non-awaiting; this is the
    // belt-and-suspenders write.
    await transitionNodeRunStatus({
      db: args.db,
      nodeRunId: args.nodeRunId,
      event: { kind: 'approve-review' },
      extra: { finishedAt: decidedAt },
    })
    // RFC-041: feed the approved decision into the memory distill queue.
    // Best-effort — never blocks the decision return path.
    await enqueueDistillJob(args.db, {
      sourceKind: 'review',
      sourceEventId: dv.id,
      taskId: dv.taskId,
    }).catch(() => {
      /* swallow — distill is async, downstream broken queue must not affect decision */
    })
    return { taskId: dv.taskId, reviewIteration: run.reviewIteration, resumeRequired: true }
  }

  // reject / iterate: reset upstream + sibling reviews (reject only), bump
  // this review's reviewIteration, set status back to pending so scheduler
  // re-runs the node (which will create v(n+1) doc_version).
  const taskRow = (await args.db.select().from(tasks).where(eq(tasks.id, dv.taskId)).limit(1))[0]
  if (taskRow === undefined) {
    throw new NotFoundError('task-not-found', `task ${dv.taskId} not found`)
  }
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
  const rerunCfgRaw = (reviewNode as Record<string, unknown>)[
    args.decision === 'rejected' ? 'rerunnableOnReject' : 'rerunnableOnIterate'
  ]
  const rerunSet = new Set<string>(
    Array.isArray(rerunCfgRaw) ? rerunCfgRaw.filter((s): s is string => typeof s === 'string') : [],
  )
  rerunSet.add(dv.sourceNodeId) // direct upstream always rerunnable, regardless of config
  const rollbackFlag =
    args.decision === 'rejected'
      ? readBool(reviewNode, 'rollbackFilesOnReject', true)
      : readBool(reviewNode, 'rollbackFilesOnIterate', false)

  // RFC-011: mint a fresh node_run row at retry_index+1 for each rerunnable
  // upstream node instead of resetting the latest row in place — this
  // preserves the old row's promptText (and outputs) for the Prompt tab
  // attempts switcher. Old row goes to a terminal canceled state with an
  // errorSummary that machine-identifies the supersede reason.
  for (const nodeId of rerunSet) {
    const upRuns = await args.db
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
    // scheduler / dispatchReviewNode use (clarifyIteration → retryIndex → ulid).
    // A plain desc(retryIndex) sort silently shadows the clarify-rerun row
    // (clarifyIteration=N, retryIndex=0) behind any stale process-retry row
    // (clarifyIteration=0, retryIndex=M>0). When that happens the new pending
    // row inherits the WRONG clarifyIteration and loses the latestPerNode
    // race in scheduler.runScope, so the agent never re-runs and review
    // immediately reads the stale upstream output to mint v(n+1) — i.e. iterate
    // looks like "version refreshed, no agent run". Locked by
    // review-iterate-inherits-clarify-iteration.test.ts.
    // RFC-096: shared picker; intentionally no status filter — supersede must
    // be able to cancel live rows AND the typical done row alike.
    const latest = pickFreshestRun(upRuns, { topLevelOnly: true })
    if (latest === undefined) continue
    // Worktree rollback per the review-node config. Track whether rollback
    // *actually completed* so the supersede marker can distinguish "files
    // rolled back, this attempt is truly canceled" from "files kept, this
    // attempt is just superseded by a newer retry" — UI uses this to pick
    // between the 'Canceled' and 'Superseded' labels.
    let rolledBack = false
    // RFC-098 B1 (audit S-9 / ⑥-10): write-lock + shared multi-repo rollback;
    // `rolledBack` (the '-rollback' supersede-marker suffix) now means "at
    // least one worktree actually rolled back with zero failures".
    if (rollbackFlag && (latest.preSnapshot !== null || latest.preSnapshotReposJson !== null)) {
      const target = await loadRollbackTarget(args.db, taskRow.id)
      if (target !== null) {
        try {
          const outcome = await getTaskWriteSem(taskRow.id).run(() =>
            rollbackNodeRunWorktrees(target, latest, { resetOnEmptySnapshot: false }, log),
          )
          rolledBack = outcome.attempted && outcome.failures.length === 0
        } catch (err) {
          log.warn('review rollback failed', {
            nodeRunId: latest.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
    const nextRetryIndex = latest.retryIndex + 1
    // RFC-145: the marker string is HUMAN BREADCRUMBS only — the machine
    // facts land on superseded_by_review / rolled_back in the same write.
    // The prefix constant lives here (message builder) now that
    // isReviewSupersededRow reads the column instead of parsing it.
    // The optional `-rollback` suffix marks "worktree was actually reset to
    // preSnapshot". Substring matches like `.toContain('superseded-by-review-iterated')`
    // still work either way. RFC-095: the prefix is now a LOAD-BEARING dispatch
    // contract — isDispatchable keeps canceled rows carrying it parked while
    // plain canceled rows are revival-dispatchable; build it from the shared
    // constant so the two sides cannot drift.
    const supersedeMarker = `${REVIEW_SUPERSEDE_MARKER_PREFIX}${args.decision}${rolledBack ? '-rollback' : ''}`
    // RFC-053: supersede must be able to cancel BOTH live rows (pending /
    // running / awaiting_*) AND a `done` row (typical case — agent already
    // finished before the review decision triggered an iterate). We use
    // setNodeRunStatus with an explicit allowedFrom including 'done' +
    // allowTerminal=true to document the intentional terminal-rewrite —
    // future readers see the semantic exception explicitly rather than
    // hidden behind a raw db.update.
    await setNodeRunStatus({
      db: args.db,
      nodeRunId: latest.id,
      to: 'canceled',
      allowedFrom: ['pending', 'running', 'awaiting_review', 'awaiting_human', 'done'],
      allowTerminal: true,
      reason: supersedeMarker,
      extra: {
        finishedAt: latest.finishedAt ?? Date.now(),
        // RFC-145: errorMessage keeps the human-readable marker string
        // (breadcrumbs; substring test locks stay green), but the MACHINE
        // facts land structured — isReviewSupersededRow / clarifyRerunLedger /
        // the frontend decode read these columns, never the prefix.
        errorMessage: `${supersedeMarker}: Replaced by retry_index ${nextRetryIndex} due to review ${args.decision} of ${dv.reviewNodeId}`,
        supersededByReview: args.decision === 'iterated' ? 'iterated' : 'rejected',
        rolledBack,
      },
    })
    await mintNodeRun(args.db, {
      taskId: dv.taskId,
      nodeId,
      status: 'pending',
      cause: args.decision === 'iterated' ? 'review-iterate' : 'review-reject',
      retryIndex: nextRetryIndex,
      iteration: latest.iteration,
      // No inheritFrom: this mint historically carried ONLY preSnapshot from
      // the superseded row (reviewIteration / shardKey stay at their column
      // defaults) plus an explicit top-level parent — keep that byte-for-byte.
      // startedAt: null preserves the legacy "no timing until it actually
      // runs" shape of this rerun row.
      overrides: { parentNodeRunId: null, preSnapshot: latest.preSnapshot, startedAt: null },
      // RFC-074 PR-C: no clarifyIteration inherit. This fresh insert is the
      // latest id, so isFresherNodeRun (pure id-order) ranks it above the prior
      // clarify-rerun done row automatically — the scheduler runs the agent
      // before dispatchReviewNode reads its output, so the "version refreshed
      // without rerun" bug (task 01KS1N8WVZWE8FTR4K9WSETRNW 贪吃蛇) stays fixed.
      // Locked by review-iterate-inherits-clarify-iteration.test.ts.
    })
  }

  // Sibling cascade:
  //  - reject (RFC-005 A2): always cascade; all sibling reviews invalidated.
  //  - iterate (RFC-014 §2.1 #3): cascade only when the upstream agent has
  //    `syncOutputsOnIterate: true` AND declares ≥ 2 markdown[_file] outputs.
  //    Already-approved siblings get pulled back to awaiting_review with a
  //    bumped reviewIteration — locked by review-iterate-sibling-cascade.test.ts.
  let cascadeReason: 'rejected' | 'iterated' | null = null
  if (args.decision === 'rejected') {
    cascadeReason = 'rejected'
  } else if (args.decision === 'iterated') {
    const triggered = await iterateSiblingCascadeApplies({
      db: args.db,
      upstreamNodeId: dv.sourceNodeId,
      definition,
    })
    if (triggered) cascadeReason = 'iterated'
  }
  if (cascadeReason !== null) {
    await cascadeSiblingReviews({
      db: args.db,
      definition,
      taskId: dv.taskId,
      iteration: run.iteration,
      upstreamNodeId: dv.sourceNodeId,
      exceptReviewNodeId: dv.reviewNodeId,
      triggeredBy: cascadeReason,
    })
  }

  // Bump this review's reviewIteration + status=pending so scheduler re-runs.
  // RFC-053: iterate-review / reject-review enforce awaiting_review → pending.
  const nextIter = run.reviewIteration + 1
  await transitionNodeRunStatus({
    db: args.db,
    nodeRunId: args.nodeRunId,
    event: args.decision === 'iterated' ? { kind: 'iterate-review' } : { kind: 'reject-review' },
    extra: { reviewIteration: nextIter },
  })

  // RFC-041: same as the approve path — feed the (reject / iterate)
  // decision into the distill queue. Best-effort.
  await enqueueDistillJob(args.db, {
    sourceKind: 'review',
    sourceEventId: dv.id,
    taskId: dv.taskId,
  }).catch(() => {
    /* swallow — see comment above */
  })

  return { taskId: dv.taskId, reviewIteration: nextIter, resumeRequired: true }
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
  const runRows = await args.db
    .select()
    .from(nodeRuns)
    .where(eq(nodeRuns.id, args.nodeRunId))
    .limit(1)
  if (runRows.length === 0) {
    throw new NotFoundError('review-not-found', `review run ${args.nodeRunId} not found`)
  }
  if (runRows[0]!.status !== 'awaiting_review') {
    throw new ConflictError(
      'review-not-awaiting',
      `review ${args.nodeRunId} is not awaiting_review (status=${runRows[0]!.status})`,
    )
  }
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

interface CascadeSiblingArgs {
  db: DbClient
  definition: WorkflowDefinition
  taskId: string
  iteration: number
  upstreamNodeId: string
  exceptReviewNodeId: string
  /**
   * RFC-014: which decision triggered this cascade. Pre-RFC-014 callers only
   * fired this on reject; the optional default keeps that backward compat.
   */
  triggeredBy?: 'rejected' | 'iterated'
}

/**
 * RFC-014 §2.2: check whether an iterate decision should trigger the same
 * sibling-review cascade reject already does. True iff the upstream agent has
 * `syncOutputsOnIterate: true` AND declares ≥ 2 markdown[_file] outputs.
 */
async function iterateSiblingCascadeApplies(args: {
  db: DbClient
  upstreamNodeId: string
  definition: WorkflowDefinition
}): Promise<boolean> {
  const upstreamNode = args.definition.nodes.find((n) => n.id === args.upstreamNodeId)
  if (upstreamNode === undefined) return false
  const agentName = (upstreamNode as Record<string, unknown>).agentName
  if (typeof agentName !== 'string' || agentName.length === 0) return false
  const agentRows = await args.db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.name, agentName))
    .limit(1)
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

async function cascadeSiblingReviews(args: CascadeSiblingArgs): Promise<void> {
  for (const n of args.definition.nodes) {
    if (n.kind !== 'review') continue
    if (n.id === args.exceptReviewNodeId) continue
    const inputSource = readPortRef(n, 'inputSource')
    if (inputSource === null || inputSource.nodeId !== args.upstreamNodeId) continue
    // Reset sibling review node_run for this iteration back to pending so
    // scheduler creates a new doc_version when the upstream produces new
    // content.
    const siblings = await args.db
      .select()
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.taskId, args.taskId),
          eq(nodeRuns.nodeId, n.id),
          eq(nodeRuns.iteration, args.iteration),
        ),
      )
    for (const s of siblings) {
      if (s.parentNodeRunId !== null) continue
      // Mark the sibling's currently-pending doc_version (if any) as rejected
      // so the new run creates a fresh v(n+1); historical decisions stay.
      const dvPending = await args.db
        .select()
        .from(docVersions)
        .where(and(eq(docVersions.reviewNodeRunId, s.id), eq(docVersions.decision, 'pending')))
      for (const d of dvPending) {
        await args.db
          .update(docVersions)
          .set({
            decision: 'rejected',
            decisionReason: 'invalidated by sibling reject (RFC-005 A2)',
            decidedAt: Date.now(),
            decidedBy: 'system',
          })
          .where(eq(docVersions.id, d.id))
      }
      // RFC-053: sibling cascade can pull a sibling back from any prior
      // state — typically awaiting_review, but also `done` if the sibling
      // was already approved when reject hit. Use setNodeRunStatus with
      // allowTerminal=true so the intentional "overwrite a terminal" is
      // visible in code.
      await setNodeRunStatus({
        db: args.db,
        nodeRunId: s.id,
        to: 'pending',
        allowedFrom: ['pending', 'running', 'awaiting_review', 'awaiting_human', 'done'],
        allowTerminal: true,
        reason: 'review-sibling-cascade',
        extra: { reviewIteration: s.reviewIteration + 1 },
      })
    }
  }
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
  //   - rows produced by cascadeSiblingReviews (decidedBy='system') must be
  //     filtered too — those mark "this port's pending doc was invalidated by
  //     a sibling decision", not "the user decided on this port". Without
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
        ne(docVersions.decidedBy, 'system'),
      ),
    )
    .orderBy(desc(docVersions.decidedAt))
    .limit(1)
  const dv = dvRows[0]
  if (dv === undefined) return undefined
  // RFC-079: multi-document iterate. The latest decided row is just ONE item
  // of the round; aggregate EVERY iterated item's feedback for this upstream
  // at the same reviewIteration so the re-run prompt sees all per-document
  // comments — not only the most-recently-touched item. Each item's
  // decisionReason already carries a `**File**: <path>` header (rendered with
  // its itemPath), which is the per-document distinction. Single-document rows
  // (item_index NULL) skip this and keep the legacy single-row path below.
  if (dv.itemIndex !== null && dv.decision === 'iterated') {
    const roundRows = await db
      .select()
      .from(docVersions)
      .where(
        and(
          eq(docVersions.taskId, taskId),
          eq(docVersions.sourceNodeId, upstreamNodeId),
          eq(docVersions.decision, 'iterated'),
          eq(docVersions.reviewIteration, dv.reviewIteration),
          ne(docVersions.decidedBy, 'system'),
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
  if (dv.decision === 'rejected') {
    return { rejection: dv.decisionReason ?? '' }
  }
  if (dv.decision === 'iterated') {
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
  }
  // pending / approved → no review context
  void iteration
  return undefined
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
  const agentName = (upstreamNode as Record<string, unknown>).agentName
  if (typeof agentName !== 'string' || agentName.length === 0) return undefined

  const agentRows = await db
    .select()
    .from(agentsTable)
    .where(eq(agentsTable.name, agentName))
    .limit(1)
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
  const agentName = (node as Record<string, unknown>).agentName
  if (typeof agentName !== 'string') return undefined
  const rows = await db.select().from(agentsTable).where(eq(agentsTable.name, agentName)).limit(1)
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
