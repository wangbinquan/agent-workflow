// GET    /api/reviews                            list (filter: status / taskId / workflowId)
// GET    /api/reviews/pending-count               { count: N } for badge
// GET    /api/reviews/:nodeRunId                  detail + comments + current body
// GET    /api/reviews/:nodeRunId/versions         all doc_versions for history dropdown
// GET    /api/reviews/:nodeRunId/versions/:vid    one historical version (body + meta)
// GET    /api/reviews/:nodeRunId/rounds           RFC-142 multi-doc round history
// POST   /api/reviews/:nodeRunId/decision         approve / reject / iterate
// POST   /api/reviews/:nodeRunId/comments         add review comment
// PATCH  /api/reviews/:nodeRunId/comments/:id     edit comment body (RFC-009)
// DELETE /api/reviews/:nodeRunId/comments/:id     delete review comment
//
// RFC-005 PR-B T11 + T12. After decision lands, resumeTask re-enters the
// scheduler so approve advances downstream, reject/iterate re-runs upstream.

import {
  ListReviewsQuerySchema,
  SetDocumentSelectionSchema,
  SubmitReviewCommentSchema,
  SubmitReviewDecisionSchema,
  UpdateReviewCommentBodySchema,
} from '@agent-workflow/shared'
import type { TaskActorRole } from '@agent-workflow/shared'
import { eq, inArray } from 'drizzle-orm'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
// RFC-143 PR-5: resolveOpencodeCmd deduped to util/opencode (was 5 route-local copies).
import { resolveOpencodeCmd } from '@/util/opencode'
import { nodeRuns, tasks as tasksTable } from '@/db/schema'
import type { AppDeps } from '@/server'
import { canViewTask, requireTaskMember } from '@/services/taskCollab'
import { resumeTask } from '@/services/task'
import { resolveLaunchRuntimeConfig } from '@/services/launchRuntimeConfig'
import {
  addReviewComment,
  countPendingReviews,
  deleteReviewComment,
  getDocVersionDetail,
  getReviewDetail,
  listDocVersionsForReview,
  listReviewRounds,
  listReviewSummaries,
  setDocumentSelection,
  submitReviewDecision,
  updateReviewCommentText,
} from '@/services/review'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'

const log = createLogger('reviews')

/**
 * RFC-099 (D5/D7) — answer-rights gate for every review write (decision /
 * selection / comments): the actor must be a task member (owner or
 * collaborator) or an admin. Replaces the RFC-036 assigned-reviewer triple
 * (the node-level assignment mechanism is removed). Returns the role
 * snapshot to record on the action.
 */
async function ensureReviewMember(
  deps: AppDeps,
  nodeRunId: string,
  actor: Actor,
): Promise<TaskActorRole> {
  const rows = await deps.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1)
  const run = rows[0]
  if (!run) {
    throw new NotFoundError('node-run-not-found', `node run '${nodeRunId}' not found`)
  }
  const taskRows = await deps.db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, run.taskId))
    .limit(1)
  const task = taskRows[0]
  if (!task) {
    throw new NotFoundError('task-not-found', `task '${run.taskId}' not found`)
  }
  return requireTaskMember(deps.db, actor, task)
}

/**
 * RFC-099 (D5) — read gate: reviews inherit task visibility. Non-viewers get
 * the same 403 shape the task routes use ('task-not-visible').
 */
async function ensureReviewVisible(deps: AppDeps, nodeRunId: string, actor: Actor): Promise<void> {
  const rows = await deps.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1)
  const run = rows[0]
  if (!run) {
    throw new NotFoundError('node-run-not-found', `node run '${nodeRunId}' not found`)
  }
  const taskRows = await deps.db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, run.taskId))
    .limit(1)
  const task = taskRows[0]
  if (!task) {
    throw new NotFoundError('task-not-found', `task '${run.taskId}' not found`)
  }
  if (!(await canViewTask(deps.db, actor, task))) {
    throw new ForbiddenError('task-not-visible', `task '${task.id}' is not visible to this actor`)
  }
}

/**
 * RFC-099 (D5) — list filter: keep only summaries whose task is visible to
 * the actor. One tasks query per distinct taskId batch.
 */
async function filterVisibleByTask<T extends { taskId: string }>(
  deps: AppDeps,
  actor: Actor,
  rows: readonly T[],
): Promise<T[]> {
  if (actor.permissions.has('tasks:read:all')) return [...rows]
  const taskIds = [...new Set(rows.map((r) => r.taskId))]
  if (taskIds.length === 0) return []
  const taskRows = await deps.db
    .select({ id: tasksTable.id, ownerUserId: tasksTable.ownerUserId })
    .from(tasksTable)
    .where(inArray(tasksTable.id, taskIds))
  const visible = new Set<string>()
  for (const t of taskRows) {
    if (await canViewTask(deps.db, actor, t)) visible.add(t.id)
  }
  return rows.filter((r) => visible.has(r.taskId))
}

function appHomeFor(_deps: AppDeps): string {
  // RFC-005: doc_version body paths are anchored at the daemon's app home
  // (Paths.root, derived from AGENT_WORKFLOW_HOME env or default ~/.agent-workflow).
  // We do NOT touch config.json here to avoid spuriously writing a default
  // config when configPath is empty (e.g. tests inject deps.configPath = '').
  return Paths.root
}

export function mountReviewRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/reviews', async (c) => {
    const q = ListReviewsQuerySchema.safeParse({
      status: c.req.query('status') ?? 'pending',
      taskId: c.req.query('taskId') ?? c.req.query('task_id') ?? undefined,
      workflowId: c.req.query('workflowId') ?? c.req.query('workflow_id') ?? undefined,
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    })
    if (!q.success) {
      throw new ValidationError('review-list-query-invalid', 'invalid review list query', {
        issues: q.error.issues,
      })
    }
    const out = await listReviewSummaries(deps.db, q.data)
    return c.json(await filterVisibleByTask(deps, actorOf(c), out))
  })

  app.get('/api/reviews/pending-count', async (c) => {
    // RFC-099: badge counts only reviews on tasks visible to the actor.
    const actor = actorOf(c)
    if (actor.permissions.has('tasks:read:all')) {
      return c.json({ count: await countPendingReviews(deps.db) })
    }
    const pending = await listReviewSummaries(deps.db, { status: 'pending' })
    const visible = await filterVisibleByTask(deps, actor, pending)
    return c.json({ count: visible.length })
  })

  app.get('/api/reviews/:nodeRunId', async (c) => {
    const nodeRunId = c.req.param('nodeRunId')
    await ensureReviewVisible(deps, nodeRunId, actorOf(c))
    const detail = await getReviewDetail(deps.db, appHomeFor(deps), nodeRunId)
    return c.json(detail)
  })

  app.get('/api/reviews/:nodeRunId/versions', async (c) => {
    const nodeRunId = c.req.param('nodeRunId')
    await ensureReviewVisible(deps, nodeRunId, actorOf(c))
    const versions = await listDocVersionsForReview(deps.db, nodeRunId)
    if (versions.length === 0) {
      throw new NotFoundError(
        'review-versions-empty',
        `no doc_versions for review run ${nodeRunId}`,
      )
    }
    return c.json(versions)
  })

  app.get('/api/reviews/:nodeRunId/versions/:versionId', async (c) => {
    const nodeRunId = c.req.param('nodeRunId')
    await ensureReviewVisible(deps, nodeRunId, actorOf(c))
    const versionId = c.req.param('versionId')
    // RFC-013: returns body + comments for read-only historical view. The
    // helper validates the version belongs to `nodeRunId` so a caller can't
    // brute-force doc_versions across unrelated reviews.
    const dv = await getDocVersionDetail(deps.db, appHomeFor(deps), nodeRunId, versionId)
    if (dv === null) {
      throw new NotFoundError('review-version-not-found', `doc_version ${versionId} not found`)
    }
    return c.json(dv)
  })

  // RFC-142: multi-document round history for the list expand + the read-only
  // historical-round view. [] for single-document reviews.
  app.get('/api/reviews/:nodeRunId/rounds', async (c) => {
    const nodeRunId = c.req.param('nodeRunId')
    await ensureReviewVisible(deps, nodeRunId, actorOf(c))
    return c.json(await listReviewRounds(deps.db, appHomeFor(deps), nodeRunId))
  })

  app.post('/api/reviews/:nodeRunId/decision', async (c) => {
    const nodeRunId = c.req.param('nodeRunId')
    const raw: unknown = await c.req.json().catch(() => null)
    const parsed = SubmitReviewDecisionSchema.safeParse(raw)
    if (!parsed.success) {
      throw new ValidationError('review-decision-invalid', 'invalid review decision body', {
        issues: parsed.error.issues,
      })
    }
    // RFC-099 (D5/D7): any task member (or admin) may decide; record the
    // user id + role snapshot on the decision row.
    const actor = actorOf(c)
    const role = await ensureReviewMember(deps, nodeRunId, actor)
    const args: Parameters<typeof submitReviewDecision>[0] = {
      db: deps.db,
      appHome: appHomeFor(deps),
      nodeRunId,
      decision: parsed.data.decision,
      expectedReviewIteration: parsed.data.reviewIteration,
      author: actor.user.id,
      authorRole: role,
      ...(parsed.data.rejectReason !== undefined ? { rejectReason: parsed.data.rejectReason } : {}),
    }
    const result = await submitReviewDecision(args)
    if (result.resumeRequired) {
      // Fire-and-forget; the scheduler re-enters and drives the task forward.
      const opencodeCmd = resolveOpencodeCmd(deps.configPath)
      const resumeDeps: Parameters<typeof resumeTask>[2] = {
        db: deps.db,
        appHome: appHomeFor(deps),
        ...(opencodeCmd ? { opencodeCmd } : {}),
        // RFC-108 T4 (Codex impl gate P2): a review decision resumes the task;
        // thread the per-node timeout floor (+commit&push/concurrency) so the
        // continued nodes are not unbounded.
        ...resolveLaunchRuntimeConfig(deps.configPath),
      }
      // RFC-097 (audit S-27): classified swallow — `task-not-resumable` is
      // EXPECTED when the task is still running or actively driven (the live
      // dispatch loop picks the freshly minted pending rerun row up via
      // deriveFrontier's pending-anchor release, RFC-092); anything else is
      // surfaced at warn so failures stop vanishing.
      void resumeTask(deps.db, result.taskId, resumeDeps).catch((err) => {
        if (err instanceof ConflictError && err.code === 'task-not-resumable') {
          log.info('review resume deferred — live dispatch loop picks up the pending rerun', {
            taskId: result.taskId,
          })
          return
        }
        log.warn('review resume threw', {
          taskId: result.taskId,
          error: err instanceof Error ? err.message : String(err),
        })
      })
    }
    return c.json({ ok: true, ...result })
  })

  // RFC-079: set one multi-document review item's accepted/not_accepted choice.
  // Does not advance the workflow (no resumeTask) — only the round-level
  // decision does.
  app.patch('/api/reviews/:nodeRunId/documents/:docVersionId/selection', async (c) => {
    const nodeRunId = c.req.param('nodeRunId')
    const docVersionId = c.req.param('docVersionId')
    const raw: unknown = await c.req.json().catch(() => null)
    const parsed = SetDocumentSelectionSchema.safeParse(raw)
    if (!parsed.success) {
      throw new ValidationError('review-selection-invalid', 'invalid selection body', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    await ensureReviewMember(deps, nodeRunId, actor)
    const result = await setDocumentSelection({
      db: deps.db,
      nodeRunId,
      docVersionId,
      selection: parsed.data.selection,
    })
    return c.json({ ok: true, ...result })
  })

  app.post('/api/reviews/:nodeRunId/comments', async (c) => {
    const nodeRunId = c.req.param('nodeRunId')
    const raw: unknown = await c.req.json().catch(() => null)
    const parsed = SubmitReviewCommentSchema.safeParse(raw)
    if (!parsed.success) {
      throw new ValidationError('review-comment-invalid', 'invalid review comment body', {
        issues: parsed.error.issues,
      })
    }
    // RFC-099 (D7): record who commented and with which task role.
    const actor = actorOf(c)
    const role = await ensureReviewMember(deps, nodeRunId, actor)
    const comment = await addReviewComment({
      db: deps.db,
      appHome: appHomeFor(deps),
      nodeRunId,
      anchor: parsed.data.anchor,
      commentText: parsed.data.commentText,
      author: actor.user.id,
      authorRole: role,
      ...(parsed.data.docVersionId !== undefined ? { docVersionId: parsed.data.docVersionId } : {}),
    })
    return c.json(comment, 201)
  })

  app.patch('/api/reviews/:nodeRunId/comments/:commentId', async (c) => {
    const nodeRunId = c.req.param('nodeRunId')
    const commentId = c.req.param('commentId')
    const raw: unknown = await c.req.json().catch(() => null)
    const parsed = UpdateReviewCommentBodySchema.safeParse(raw)
    if (!parsed.success) {
      throw new ValidationError('review-comment-invalid', 'invalid review comment body', {
        issues: parsed.error.issues,
      })
    }
    await ensureReviewMember(deps, nodeRunId, actorOf(c))
    const updated = await updateReviewCommentText(
      deps.db,
      nodeRunId,
      commentId,
      parsed.data.commentText,
    )
    return c.json(updated)
  })

  app.delete('/api/reviews/:nodeRunId/comments/:commentId', async (c) => {
    const nodeRunId = c.req.param('nodeRunId')
    const commentId = c.req.param('commentId')
    await ensureReviewMember(deps, nodeRunId, actorOf(c))
    await deleteReviewComment(deps.db, nodeRunId, commentId)
    return c.json({ ok: true })
  })
}
