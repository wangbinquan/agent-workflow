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
import { and, asc, desc, eq, ne } from 'drizzle-orm'
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
import { isFresherNodeRun } from '@/services/scheduler'
import { setNodeRunStatus, transitionNodeRunStatus } from '@/services/lifecycle'
import { enqueueDistillJob } from '@/services/memoryDistillScheduler'
import { rollbackToSnapshot } from '@/util/git'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'

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
): string {
  return `runs/${taskId}/review/${reviewNodeId}/${portName}/v${versionIndex}.md`
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
  let sourceRun: (typeof sourceRuns)[number] | undefined
  for (const r of sourceRuns) {
    // Skip fan-out child rows — multi-process review fanout per-shard is
    // RFC-005 T14; for now we read the aggregator-side row.
    if (r.parentNodeRunId !== null) continue
    if (isFresherNodeRun(r, sourceRun)) sourceRun = r
  }
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
  let resolvedBody: string
  let resolvedSourcePath: string | undefined
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
  // RFC-052: a review for the current iteration is "decided" the moment ANY
  // top-level row reaches `done` (approve sets status=done) — regardless of
  // what other rows at higher retryIndex / clarifyIteration claim. The
  // pre-RFC-052 bug:
  //   1. user clicks Retry on upstream agent → retryNode cascade mints a
  //      retryIndex+1 'failed/queued for retry' placeholder row for this
  //      review node;
  //   2. scheduler.latestPerNode uses isFresherNodeRun (clarifyIter →
  //      retryIndex → ulid) which prefers the placeholder over the
  //      retry=0 approved row;
  //   3. dispatchReviewNode used `Array.find` to pick whichever row came
  //      first in SQL insertion order (usually retry=0), then unconditionally
  //      reset its status back to awaiting_review and minted a phantom
  //      v(n+1) pending doc_version.
  // With T2 in place the cascade no longer mints those placeholders, but
  // this short-circuit is the defense-in-depth that also handles existing
  // stuck DBs and any other future path that produces extra rows: if a
  // done row exists for this review at this iteration, the review has been
  // approved and the scheduler should treat the node as completed.
  let reuse: (typeof reviewRuns)[number] | undefined
  let alreadyDone = false
  for (const r of reviewRuns) {
    if (r.parentNodeRunId !== null) continue
    if (r.status === 'done') alreadyDone = true
    if (isFresherNodeRun(r, reuse)) reuse = r
  }
  if (alreadyDone) {
    return { kind: 'ok', summary: '', message: '' }
  }

  let reviewNodeRunId: string
  let reviewIteration: number
  if (reuse !== undefined) {
    reviewNodeRunId = reuse.id
    reviewIteration = reuse.reviewIteration
    if (reuse.status !== 'awaiting_review') {
      // pending → awaiting_review (post-iterate / post-reject / fresh).
      // RFC-053: state machine helper enforces legal transition; if reuse
      // is somehow already in a terminal-non-done state the helper will
      // refuse and the dispatch result surfaces failed instead of silently
      // overwriting.
      await transitionNodeRunStatus({
        db,
        nodeRunId: reviewNodeRunId,
        event: { kind: 'park-review' },
        extra: { startedAt: reuse.startedAt ?? Date.now() },
      })
    }
  } else {
    reviewNodeRunId = ulid()
    reviewIteration = 0
    const now = Date.now()
    // RFC-056 patch 2026-05-25 §2.3 — carry the upstream source-agent's
    // crossClarifyIteration onto the review's awaiting_review row so the
    // cross-clarify scope walker (Layer B freshness invariant) sees a
    // continuous iteration across the data graph. Default 0 is preserved
    // when sourceRun lookup turns up empty (initial dispatch without an
    // upstream run, which shouldn't happen but stay defensive).
    await db.insert(nodeRuns).values({
      id: reviewNodeRunId,
      taskId,
      nodeId: node.id,
      status: 'awaiting_review',
      retryIndex: 0,
      iteration,
      reviewIteration: 0,
      crossClarifyIteration: sourceRun.crossClarifyIteration ?? 0,
      startedAt: now,
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
  /** Optional JSON snapshot of {model, variant, temperature}. */
  agentSnapshot?: string
  /**
   * Worktree-relative path the body was read from, when the upstream port
   * resolved as a markdown_file (or the forgiveness branch silently read a
   * `.md` file). Surfaced in the iterate re-run prompt so the agent knows
   * which file the comments target. Undefined when the source was inline.
   */
  sourceFilePath?: string
}

async function createDocVersion(args: CreateDocVersionArgs): Promise<DocVersion> {
  const existing = await args.db
    .select({ versionIndex: docVersions.versionIndex })
    .from(docVersions)
    .where(
      and(
        eq(docVersions.reviewNodeRunId, args.reviewNodeRunId),
        eq(docVersions.sourcePortName, args.sourcePortName),
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
  )
  const absPath = join(args.appHome, bodyPath)
  mkdirSync(dirname(absPath), { recursive: true })
  writeFileSync(absPath, args.body, 'utf8')

  const id = ulid()
  const now = Date.now()
  const sourceFilePath = args.sourceFilePath ?? null
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
    agentSnapshot: args.agentSnapshot ?? null,
    sourceFilePath,
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
    agentSnapshot: args.agentSnapshot ?? null,
    sourceFilePath,
    decidedAt: null,
    decidedBy: null,
    createdAt: now,
  }
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
  const dvRows = await db
    .select()
    .from(docVersions)
    .where(eq(docVersions.reviewNodeRunId, nodeRunId))
    .orderBy(desc(docVersions.versionIndex))
    .limit(1)
  if (dvRows.length === 0) {
    throw new NotFoundError('review-not-found', `no doc_versions for ${nodeRunId}`)
  }
  const dv = rowToDocVersion(dvRows[0]!)
  const body = readDocVersionBody(appHome, dv)
  const commentsRows = await db
    .select()
    .from(reviewComments)
    .where(eq(reviewComments.docVersionId, dv.id))
    .orderBy(asc(reviewComments.anchorParagraphIdx), asc(reviewComments.anchorOffsetStart))
  const comments = commentsRows.map(rowToReviewComment)

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
 * Comment source per decision state:
 *   - `pending`   → live `review_comments` rows for this docVersionId
 *                   (the user is still actively annotating it).
 *   - decided     → parse `doc_versions.commentsJson` (the archived
 *                   snapshot captured at decision time). The live rows
 *                   are deleted by `submitReviewDecision`, so the JSON
 *                   blob is the only remaining source of truth.
 *
 * Comments are sorted by anchor position (paragraph index, then offset)
 * so the UI's bubble layout matches the in-doc reading order without an
 * extra client-side sort. Empty array when there are no comments.
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
  let comments: ReviewComment[]
  if (dv.decision === 'pending') {
    const commentsRows = await db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.docVersionId, dv.id))
      .orderBy(asc(reviewComments.anchorParagraphIdx), asc(reviewComments.anchorOffsetStart))
    comments = commentsRows.map(rowToReviewComment)
  } else {
    comments = parseArchivedComments(dv.commentsJson)
    comments.sort((a, b) => {
      if (a.anchor.paragraphIdx !== b.anchor.paragraphIdx) {
        return a.anchor.paragraphIdx - b.anchor.paragraphIdx
      }
      return a.anchor.offsetStart - b.anchor.offsetStart
    })
  }
  return { ...dv, body, comments }
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
// Comments — add / delete.
// ---------------------------------------------------------------------------

export interface AddReviewCommentArgs {
  db: DbClient
  appHome: string
  nodeRunId: string
  anchor: ReviewCommentAnchor
  commentText: string
  author?: string
}

export async function addReviewComment(args: AddReviewCommentArgs): Promise<ReviewComment> {
  // Pending doc_version for this review run.
  const dvRows = await args.db
    .select()
    .from(docVersions)
    .where(
      and(eq(docVersions.reviewNodeRunId, args.nodeRunId), eq(docVersions.decision, 'pending')),
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
    createdAt: now,
  })

  const comment: ReviewComment = {
    id,
    docVersionId: dv.id,
    anchor: canonical,
    commentText: args.commentText,
    author: args.author ?? 'local',
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

  const dvRows = await args.db
    .select()
    .from(docVersions)
    .where(
      and(eq(docVersions.reviewNodeRunId, args.nodeRunId), eq(docVersions.decision, 'pending')),
    )
    .limit(1)
  if (dvRows.length === 0) {
    throw new ConflictError(
      'review-doc-version-missing',
      `no pending doc_version for review ${args.nodeRunId}`,
    )
  }
  const dv = rowToDocVersion(dvRows[0]!)

  // 1. Archive comments into the doc_version snapshot + drop the row-side.
  const commentRows = await args.db
    .select()
    .from(reviewComments)
    .where(eq(reviewComments.docVersionId, dv.id))
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
                ...(dv.sourceFilePath ? { sourceFilePath: dv.sourceFilePath } : {}),
              })
            : null,
      decidedAt: Date.now(),
      decidedBy: args.author ?? 'local',
      commentsJson: JSON.stringify(commentsArr),
    })
    .where(eq(docVersions.id, dv.id))
  await args.db.delete(reviewComments).where(eq(reviewComments.docVersionId, dv.id))

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
    const decidedBy = args.author ?? 'local'
    const sourcePath = dv.sourceFilePath ?? null
    const approvedDocContent =
      sourcePath !== null && sourcePath.trim().length > 0
        ? sourcePath
        : readDocVersionBody(args.appHome, dv)
    const meta = JSON.stringify({
      decision: 'approved',
      decidedAt,
      decidedBy,
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
      })
      .onConflictDoUpdate({
        target: [nodeRunOutputs.nodeRunId, nodeRunOutputs.portName],
        set: { content: approvedDocContent },
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
    let latest: (typeof upRuns)[number] | undefined
    for (const r of upRuns) {
      if (r.parentNodeRunId !== null) continue
      if (isFresherNodeRun(r, latest)) latest = r
    }
    if (latest === undefined) continue
    // Worktree rollback per the review-node config. Track whether rollback
    // *actually completed* so the supersede marker can distinguish "files
    // rolled back, this attempt is truly canceled" from "files kept, this
    // attempt is just superseded by a newer retry" — UI uses this to pick
    // between the 'Canceled' and 'Superseded' labels.
    let rolledBack = false
    if (rollbackFlag && latest.preSnapshot !== null && latest.preSnapshot !== '') {
      try {
        await rollbackToSnapshot(taskRow.worktreePath, latest.preSnapshot)
        rolledBack = true
      } catch (err) {
        log.warn('review rollback failed', {
          nodeRunId: latest.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    const nextRetryIndex = latest.retryIndex + 1
    // node_runs has no error_summary column; encode the supersede marker as
    // a stable prefix on error_message so tests / future GC can grep it.
    // The optional `-rollback` suffix marks "worktree was actually reset to
    // preSnapshot". Substring matches like `.toContain('superseded-by-review-iterated')`
    // still work either way.
    const supersedeMarker = `superseded-by-review-${args.decision}${rolledBack ? '-rollback' : ''}`
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
        errorMessage: `${supersedeMarker}: Replaced by retry_index ${nextRetryIndex} due to review ${args.decision} of ${dv.reviewNodeId}`,
      },
    })
    await args.db.insert(nodeRuns).values({
      id: ulid(),
      taskId: dv.taskId,
      nodeId,
      status: 'pending',
      retryIndex: nextRetryIndex,
      iteration: latest.iteration,
      parentNodeRunId: null,
      preSnapshot: latest.preSnapshot,
      // Must inherit clarifyIteration so isFresherNodeRun ranks this fresh
      // pending row above any prior clarify-rerun done row at the same node.
      // Without this the scheduler's latestPerNode picks the prior done row,
      // skips agent execution, and dispatchReviewNode reads its stale output
      // into a brand-new doc_version — the "version refreshed without rerun"
      // bug from task 01KS1N8WVZWE8FTR4K9WSETRNW (贪吃蛇). Locked by
      // review-iterate-inherits-clarify-iteration.test.ts.
      clarifyIteration: latest.clarifyIteration,
      // RFC-056 patch 2026-05-25 §2.3 — preserve crossClarifyIteration on
      // the review-iterate placeholder so the cross-clarify counter
      // doesn't silently regress when a user requests changes on a
      // post-cross-clarify designer/questioner output. See
      // patch-2026-05-25-questioner-cascade-no-skip.md §2.3.
      crossClarifyIteration: latest.crossClarifyIteration ?? 0,
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
        if (kind === 'markdown' || kind === 'markdown_file' || kind === 'string') {
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
        if (kind === 'markdown' || kind === 'markdown_file' || kind === 'string') {
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
    agentSnapshot: row.agentSnapshot,
    sourceFilePath: row.sourceFilePath,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
    decidedBy: row.decidedBy,
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

async function loadUpstreamPortKind(
  db: DbClient,
  definition: WorkflowDefinition,
  nodeId: string,
  portName: string,
): Promise<AgentOutputKind | undefined> {
  const node = definition.nodes.find((n) => n.id === nodeId)
  if (node === undefined) return undefined
  if (node.kind !== 'agent-single' && node.kind !== 'agent-multi') return undefined
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
      if (v === 'markdown' || v === 'markdown_file' || v === 'string') return v
    }
  } catch {
    /* fall through */
  }
  return undefined
}
