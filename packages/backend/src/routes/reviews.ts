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
// RFC-333 T8: review decisions enter collaboration's atomic command. The
// committed continuation is woken by composition, never by this route.

import {
  ListReviewsQuerySchema,
  SetDocumentSelectionSchema,
  SubmitReviewCommentSchema,
  SubmitReviewDecisionSchema,
  UpdateReviewCommentBodySchema,
} from '@agent-workflow/shared'
import type {
  ReviewAnchorRequest,
  ReviewAuthorRole,
  ReviewCommentAnchor,
  SubmitReviewComment,
  TaskActorRole,
} from '@agent-workflow/shared'
import type { Context, Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import { registerRoute } from '@/routes/registry'
import { verifiedBodyLimit } from '@/routes/verifiedBodyLimit'
import type { ReviewAccessDecision } from '@/modules/collaboration/public/types'
import type { CollaborationRouteOperations } from '@/modules/collaboration/public/participants'
import { ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'

/**
 * RFC-326 P10 — the two write routes accept batched comments (≤ 200 × 50 000
 * chars by schema) so they get an explicit byte ceiling; `verifiedBodyLimit`
 * also refuses understated / malformed Content-Length declarations.
 */
export const REVIEW_WRITE_BODY_MAX_BYTES = 1024 * 1024

function reviewBodyTooLarge(c: Context): Response {
  return c.json(
    {
      ok: false as const,
      code: 'review-body-too-large',
      message: `review request body exceeds ${REVIEW_WRITE_BODY_MAX_BYTES} bytes`,
    },
    413,
  )
}

const reviewWriteBodyLimit = verifiedBodyLimit({
  maxSize: REVIEW_WRITE_BODY_MAX_BYTES,
  onError: reviewBodyTooLarge,
})

/**
 * RFC-099/RFC-340 — task-member gate retained for selection and final
 * decisions. A node-scoped reviewer never enters this path; their only write
 * surface is requireReviewCommenter below. Returns the task-role snapshot to
 * record on a task-member action.
 */
async function ensureReviewMember(
  operations: CollaborationRouteOperations,
  nodeRunId: string,
  actor: Actor,
): Promise<TaskActorRole> {
  const access = await operations.access.resolveNodeRunTask({
    actor,
    nodeRunId,
  })
  if (!access.nodeRunExists) {
    throw new NotFoundError('node-run-not-found', `node run '${nodeRunId}' not found`)
  }
  if (access.task === null || access.taskId === null) {
    throw new NotFoundError('task-not-found', `task '${access.taskId ?? ''}' not found`)
  }
  if (access.actorRole === null) {
    throw new ForbiddenError(
      'not-task-member',
      'only task members or an actor with the required global task authority can do this',
    )
  }
  return access.actorRole
}

/**
 * RFC-099 (D5) — read gate: reviews inherit task visibility. RFC-285 B1:
 * non-viewers get a 404 byte-identical to the missing-task branch (existence
 * is not probeable via error codes).
 */
async function ensureReviewVisible(
  operations: CollaborationRouteOperations,
  nodeRunId: string,
  actor: Actor,
): Promise<ReviewAccessDecision> {
  const access = await operations.access.resolveReview({ actor, nodeRunId })
  if (access === null) {
    // Keep invisible and absent node-run probes byte-identical.
    throw new NotFoundError('node-run-not-found', `node run '${nodeRunId}' not found`)
  }
  return access
}

async function requireReviewCommenter(
  operations: CollaborationRouteOperations,
  nodeRunId: string,
  actor: Actor,
): Promise<{ access: ReviewAccessDecision; authorRole: ReviewAuthorRole }> {
  const access = await ensureReviewVisible(operations, nodeRunId, actor)
  if (!access.capabilities.canAddComment || access.commentAuthorRole === null) {
    throw new ForbiddenError(
      'review-comment-not-allowed',
      'this review relationship does not allow adding or modifying comments',
    )
  }
  return { access, authorRole: access.commentAuthorRole }
}

/**
 * RFC-326 — split the wire shape of a comment into the service's tagged inputs:
 * `anchor` (web) or `anchorRequest` (simplified locator; all fields absent =
 * document-level). The schema already guarantees the two forms are exclusive.
 */
function toBatchComment(input: SubmitReviewComment): {
  commentText: string
  docVersionId?: string
  anchor?: ReviewCommentAnchor
  anchorRequest?: ReviewAnchorRequest
} {
  return {
    commentText: input.commentText,
    ...(input.docVersionId !== undefined ? { docVersionId: input.docVersionId } : {}),
    ...(input.anchor !== undefined
      ? { anchor: input.anchor }
      : {
          anchorRequest: {
            ...(input.quote !== undefined ? { quote: input.quote } : {}),
            ...(input.occurrence !== undefined ? { occurrence: input.occurrence } : {}),
            ...(input.section !== undefined ? { section: input.section } : {}),
          },
        }),
  }
}

function requireReviewOperations(
  operations: CollaborationRouteOperations | undefined,
): CollaborationRouteOperations['reviews'] {
  if (operations === undefined) throw new Error('collaboration-route-operations-not-composed')
  return operations.reviews
}

export function mountReviewRoutes(
  app: Hono,
  operations: CollaborationRouteOperations,
  appHome: string,
): void {
  if (operations === undefined) throw new Error('collaboration-route-operations-not-composed')
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/reviews',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'List review gates the caller can act on',
    },
    async (c) => {
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
      // Actor filtering happens before pagination so reviewer-only rows are not
      // starved by unrelated global candidates.
      const out = await requireReviewOperations(operations).list({ ...q.data, unbounded: true })
      const visible = await operations.access.filterReviewSummaries({
        actor: actorOf(c),
        rows: out,
      })
      return c.json(visible.slice(0, q.data.limit))
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/reviews/pending-count',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Count of pending review gates',
    },
    async (c) => {
      // RFC-340: badge counts the union of task-visible and assigned-node
      // reviews. RFC-311's indexed count(*) shape remains intact, so the 15s
      // poll still avoids materializing doc_versions + three tables.
      return c.json({
        count: await requireReviewOperations(operations).countPending(actorOf(c)),
      })
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/reviews/:nodeRunId',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Get one review gate',
    },
    async (c) => {
      const nodeRunId = c.req.param('nodeRunId')
      const access = await ensureReviewVisible(operations, nodeRunId, actorOf(c))
      const detail = await requireReviewOperations(operations).detail({
        appHome,
        nodeRunId,
      })
      return c.json({
        ...detail,
        summary: { ...detail.summary, accessScope: access.capabilities.scope },
        capabilities: access.capabilities,
      })
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/reviews/:nodeRunId/versions',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'List review document versions',
    },
    async (c) => {
      const nodeRunId = c.req.param('nodeRunId')
      await ensureReviewVisible(operations, nodeRunId, actorOf(c))
      const versions = await requireReviewOperations(operations).listVersions(nodeRunId)
      if (versions.length === 0) {
        throw new NotFoundError(
          'review-versions-empty',
          `no doc_versions for review run ${nodeRunId}`,
        )
      }
      return c.json(versions)
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/reviews/:nodeRunId/versions/:versionId',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'Get one review document version',
    },
    async (c) => {
      const nodeRunId = c.req.param('nodeRunId')
      await ensureReviewVisible(operations, nodeRunId, actorOf(c))
      const versionId = c.req.param('versionId')
      // RFC-013: returns body + comments for read-only historical view. The
      // helper validates the version belongs to `nodeRunId` so a caller can't
      // brute-force doc_versions across unrelated reviews.
      const dv = await requireReviewOperations(operations).versionDetail({
        appHome,
        nodeRunId,
        versionId,
      })
      if (dv === null) {
        throw new NotFoundError('review-version-not-found', `doc_version ${versionId} not found`)
      }
      return c.json(dv)
    },
  )

  // RFC-142: multi-document round history for the list expand + the read-only
  // historical-round view. [] for single-document reviews.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/reviews/:nodeRunId/rounds',
      permissions: ['tasks:read'],
      tokenAccess: 'allow',
      summary: 'List review rounds',
    },
    async (c) => {
      const nodeRunId = c.req.param('nodeRunId')
      await ensureReviewVisible(operations, nodeRunId, actorOf(c))
      return c.json(
        await requireReviewOperations(operations).listRounds({
          appHome,
          nodeRunId,
        }),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/reviews/:nodeRunId/decision',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Submit a review decision (advances the task)',
    },
    reviewWriteBodyLimit,
    async (c) => {
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
      const role = await ensureReviewMember(operations, nodeRunId, actor)
      const result = await requireReviewOperations(operations).submitDecision({
        actor,
        authorRole: role,
        nodeRunId,
        decision: parsed.data.decision,
        expectedReviewIteration: parsed.data.reviewIteration,
        ...(c.req.header('Idempotency-Key') === undefined
          ? {}
          : { idempotencyKey: c.req.header('Idempotency-Key')! }),
        ...(parsed.data.rejectReason !== undefined
          ? { rejectReason: parsed.data.rejectReason }
          : {}),
        // RFC-326: batched comments / selections land in the decision's transaction.
        ...(parsed.data.comments !== undefined
          ? { comments: parsed.data.comments.map(toBatchComment) }
          : {}),
        ...(parsed.data.selections !== undefined ? { selections: parsed.data.selections } : {}),
      })
      return c.json({
        ok: true,
        taskId: result.taskId,
        reviewIteration: result.reviewIteration,
        receipt: result.receipt,
        commentsAdded: result.commentsAdded,
        commentsSkippedAsDuplicate: result.commentsSkippedAsDuplicate,
        selectionsApplied: result.selectionsApplied,
      })
    },
  )

  // RFC-079: set one multi-document review item's accepted/not_accepted choice.
  // Does not advance the workflow (no resumeTask) — only the round-level
  // decision does.
  registerRoute(
    app,
    {
      method: 'PATCH',
      path: '/api/reviews/:nodeRunId/documents/:docVersionId/selection',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Update a review document selection',
    },
    async (c) => {
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
      await ensureReviewMember(operations, nodeRunId, actor)
      const result = await requireReviewOperations(operations).setSelection({
        nodeRunId,
        docVersionId,
        selection: parsed.data.selection,
      })
      return c.json({ ok: true, ...result })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/reviews/:nodeRunId/comments',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Add a review comment',
    },
    reviewWriteBodyLimit,
    async (c) => {
      const nodeRunId = c.req.param('nodeRunId')
      const raw: unknown = await c.req.json().catch(() => null)
      const parsed = SubmitReviewCommentSchema.safeParse(raw)
      if (!parsed.success) {
        throw new ValidationError('review-comment-invalid', 'invalid review comment body', {
          issues: parsed.error.issues,
        })
      }
      // RFC-099/RFC-340: record who commented and the relationship snapshot
      // (task role or node-scoped reviewer) used for this opinion.
      const actor = actorOf(c)
      const { authorRole } = await requireReviewCommenter(operations, nodeRunId, actor)
      const comment = await requireReviewOperations(operations).addComment({
        appHome,
        nodeRunId,
        // RFC-326: either the web page's composite anchor or the simplified
        // locator (everything absent = document-level), never both (schema).
        ...toBatchComment(parsed.data),
        author: actor.user.id,
        authorRole,
      })
      return c.json(comment, 201)
    },
  )

  registerRoute(
    app,
    {
      method: 'PATCH',
      path: '/api/reviews/:nodeRunId/comments/:commentId',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Edit a review comment',
    },
    async (c) => {
      const nodeRunId = c.req.param('nodeRunId')
      const commentId = c.req.param('commentId')
      const raw: unknown = await c.req.json().catch(() => null)
      const parsed = UpdateReviewCommentBodySchema.safeParse(raw)
      if (!parsed.success) {
        throw new ValidationError('review-comment-invalid', 'invalid review comment body', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      // RFC-285 B6①：写门返回的角色快照连同 actor id 一起下传作者校验。
      const { access, authorRole } = await requireReviewCommenter(operations, nodeRunId, actor)
      const updated = await requireReviewOperations(operations).updateComment({
        nodeRunId,
        commentId,
        commentText: parsed.data.commentText,
        authority: {
          actorUserId: actor.user.id,
          role: authorRole,
          resourceAclBypass: access.capabilities.canManageAnyComments,
        },
      })
      return c.json(updated)
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/reviews/:nodeRunId/comments/:commentId',
      permissions: ['tasks:execute'],
      tokenAccess: 'allow',
      summary: 'Delete a review comment',
    },
    async (c) => {
      const nodeRunId = c.req.param('nodeRunId')
      const commentId = c.req.param('commentId')
      const actor = actorOf(c)
      const { access, authorRole } = await requireReviewCommenter(operations, nodeRunId, actor)
      if (!access.capabilities.canDeleteOwnComments && !access.capabilities.canManageAnyComments) {
        throw new ForbiddenError(
          'review-comment-delete-not-allowed',
          'this review relationship does not allow deleting comments',
        )
      }
      await requireReviewOperations(operations).deleteComment({
        nodeRunId,
        commentId,
        authority: {
          actorUserId: actor.user.id,
          role: authorRole,
          resourceAclBypass: access.capabilities.canManageAnyComments,
        },
      })
      return c.json({ ok: true })
    },
  )
}
