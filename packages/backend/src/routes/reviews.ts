// GET    /api/reviews                            list (filter: status / taskId / workflowId)
// GET    /api/reviews/pending-count               { count: N } for badge
// GET    /api/reviews/:nodeRunId                  detail + comments + current body
// GET    /api/reviews/:nodeRunId/versions         all doc_versions for history dropdown
// GET    /api/reviews/:nodeRunId/versions/:vid    one historical version (body + meta)
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
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import type { Actor } from '@/auth/actor'
import { loadConfig } from '@/config'
import { nodeRuns } from '@/db/schema'
import type { AppDeps } from '@/server'
import { isAssignedReviewer } from '@/services/taskCollab'
import { resumeTask } from '@/services/task'
import {
  addReviewComment,
  countPendingReviews,
  deleteReviewComment,
  getDocVersionDetail,
  getReviewDetail,
  listDocVersionsForReview,
  listReviewSummaries,
  setDocumentSelection,
  submitReviewDecision,
  updateReviewCommentText,
} from '@/services/review'
import { ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { Paths } from '@/util/paths'

/**
 * RFC-036 — guard for review decision endpoint. The actor must be the
 * assigned reviewer for this node, the task owner, or an admin. Legacy
 * tasks (no ownerUserId, no assignment row) fall through to admin / owner-
 * via-collaborator, which already passes for daemon-token actor.
 */
async function ensureReviewerAuth(deps: AppDeps, nodeRunId: string, actor: Actor): Promise<void> {
  if (actor.permissions.has('tasks:read:all')) return // admins pass
  const rows = await deps.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1)
  const run = rows[0]
  if (!run) {
    throw new NotFoundError('node-run-not-found', `node run '${nodeRunId}' not found`)
  }
  const { tasks: tasksTable } = await import('@/db/schema')
  const taskRows = await deps.db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, run.taskId))
    .limit(1)
  const task = taskRows[0]
  if (!task) {
    throw new NotFoundError('task-not-found', `task '${run.taskId}' not found`)
  }
  if (task.ownerUserId === actor.user.id) return
  if (await isAssignedReviewer(deps.db, run.taskId, run.nodeId, actor.user.id)) return
  throw new ForbiddenError(
    'not-reviewer',
    'only the assigned reviewer, task owner, or admin can submit this decision',
  )
}

function appHomeFor(_deps: AppDeps): string {
  // RFC-005: doc_version body paths are anchored at the daemon's app home
  // (Paths.root, derived from AGENT_WORKFLOW_HOME env or default ~/.agent-workflow).
  // We do NOT touch config.json here to avoid spuriously writing a default
  // config when configPath is empty (e.g. tests inject deps.configPath = '').
  return Paths.root
}

function resolveOpencodeCmd(configPath: string): string[] | undefined {
  if (configPath === '') return undefined
  try {
    const cfg = loadConfig(configPath)
    if (typeof cfg.opencodePath === 'string' && cfg.opencodePath.length > 0) {
      return [cfg.opencodePath]
    }
  } catch {
    /* nothing */
  }
  return undefined
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
    return c.json(out)
  })

  app.get('/api/reviews/pending-count', async (c) => {
    const count = await countPendingReviews(deps.db)
    return c.json({ count })
  })

  app.get('/api/reviews/:nodeRunId', async (c) => {
    const nodeRunId = c.req.param('nodeRunId')
    const detail = await getReviewDetail(deps.db, appHomeFor(deps), nodeRunId)
    return c.json(detail)
  })

  app.get('/api/reviews/:nodeRunId/versions', async (c) => {
    const nodeRunId = c.req.param('nodeRunId')
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

  app.post('/api/reviews/:nodeRunId/decision', async (c) => {
    const nodeRunId = c.req.param('nodeRunId')
    const raw: unknown = await c.req.json().catch(() => null)
    const parsed = SubmitReviewDecisionSchema.safeParse(raw)
    if (!parsed.success) {
      throw new ValidationError('review-decision-invalid', 'invalid review decision body', {
        issues: parsed.error.issues,
      })
    }
    // RFC-036: reviewer / task owner / admin only. Look up the node_run to
    // find its task + node id, then check assignments + ownership.
    const actor = (await import('@/auth/actor')).actorOf(c)
    await ensureReviewerAuth(deps, nodeRunId, actor)
    const args: Parameters<typeof submitReviewDecision>[0] = {
      db: deps.db,
      appHome: appHomeFor(deps),
      nodeRunId,
      decision: parsed.data.decision,
      expectedReviewIteration: parsed.data.reviewIteration,
      author: actor.user.id,
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
      }
      void resumeTask(deps.db, result.taskId, resumeDeps).catch(() => {
        /* errors land in task.errorMessage via failTask */
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
    const actor = (await import('@/auth/actor')).actorOf(c)
    await ensureReviewerAuth(deps, nodeRunId, actor)
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
    const comment = await addReviewComment({
      db: deps.db,
      appHome: appHomeFor(deps),
      nodeRunId,
      anchor: parsed.data.anchor,
      commentText: parsed.data.commentText,
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
    await deleteReviewComment(deps.db, nodeRunId, commentId)
    return c.json({ ok: true })
  })
}
