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
  SubmitReviewCommentSchema,
  SubmitReviewDecisionSchema,
  UpdateReviewCommentBodySchema,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { loadConfig } from '@/config'
import type { AppDeps } from '@/server'
import { resumeTask } from '@/services/task'
import {
  addReviewComment,
  countPendingReviews,
  deleteReviewComment,
  getDocVersionDetail,
  getReviewDetail,
  listDocVersionsForReview,
  listReviewSummaries,
  submitReviewDecision,
  updateReviewCommentText,
} from '@/services/review'
import { NotFoundError, ValidationError } from '@/util/errors'
import { Paths } from '@/util/paths'

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
    const args: Parameters<typeof submitReviewDecision>[0] = {
      db: deps.db,
      appHome: appHomeFor(deps),
      nodeRunId,
      decision: parsed.data.decision,
      expectedReviewIteration: parsed.data.reviewIteration,
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
