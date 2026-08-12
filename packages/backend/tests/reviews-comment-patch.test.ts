// Locks in RFC-009-T1: PATCH /api/reviews/:nodeRunId/comments/:commentId.
//
// Coverage:
//   - 200 happy path: awaiting review + valid body → update + return new row
//   - 422 invalid body: zod rejects empty commentText (ValidationError handler)
//   - 404 not found: bad commentId / mismatched nodeRunId / dangling row
//   - 409 conflict: doc_version.decision !== 'pending' (already approved /
//     rejected / iterated)
//   - ws broadcast: emitReviewCommentUpdatedEvent fires on success
//
// Test harness seeds rows directly (workflow → task → node_run → doc_version
// → review_comment) so we don't have to spin up the scheduler. The service
// function is the source of truth for the 200/404/409 branches; the route is
// covered once via app.fetch for the happy path + 400 validation.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { docVersions, nodeRuns, reviewComments, tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { deleteReviewComment, updateReviewCommentText } from '../src/services/review'
import { ConflictError, NotFoundError } from '../src/util/errors'
import { TASK_CHANNEL, taskBroadcaster } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Seed {
  db: DbClient
  taskId: string
  nodeRunId: string
  docVersionId: string
  commentId: string
}

async function seed(opts: { decision?: 'pending' | 'approved' } = {}): Promise<Seed> {
  const decision = opts.decision ?? 'pending'
  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = 'wf_test'
  const taskId = 'task_test'
  const nodeRunId = 'run_test'
  const docVersionId = 'dv_test'
  const commentId = 'cmt_test'

  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    description: '',
    version: 1,
    schemaVersion: 2,
    definition: JSON.stringify({ $schema_version: 2, nodes: [], edges: [], inputs: [] }),
    createdAt: 1,
    updatedAt: 1,
  })
  await db.insert(tasks).values({
    name: 'fixture-task',

    id: taskId,
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/x',
    worktreePath: '/tmp/x',
    baseBranch: 'main',
    branch: 'agent-workflow/x',
    status: 'awaiting_review',
    inputs: '{}',
    startedAt: 1,
  })
  await db.insert(nodeRuns).values({
    id: nodeRunId,
    taskId,
    nodeId: 'rev_1',
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
    status: 'awaiting_review',
  })
  await db.insert(docVersions).values({
    id: docVersionId,
    taskId,
    reviewNodeId: 'rev_1',
    reviewNodeRunId: nodeRunId,
    sourceNodeId: 'designer',
    sourcePortName: 'design',
    versionIndex: 1,
    reviewIteration: 0,
    bodyPath: 'irrelevant',
    commentsJson: '[]',
    decision,
    createdAt: 1,
  })
  await db.insert(reviewComments).values({
    id: commentId,
    docVersionId,
    anchorSectionPath: '# Design',
    anchorParagraphIdx: 0,
    anchorOffsetStart: 0,
    anchorOffsetEnd: 5,
    selectedText: 'Hello',
    contextBefore: '',
    contextAfter: '',
    occurrenceIndex: 1,
    commentText: 'original',
    author: 'local',
    createdAt: 1,
  })

  return { db, taskId, nodeRunId, docVersionId, commentId }
}

// RFC-285 B6①：service 签名新增作者校验 authz——本文件既有用例全走 owner 旁路
// 保持原语义；作者矩阵的专项覆盖在 reviews-comment-patch 的 B6① describe。
const OWNER_AUTHZ = { actorUserId: 'u_owner_authz', role: 'owner' as const }

describe('RFC-009-T1 updateReviewCommentText service', () => {
  test('200 happy path — updates commentText, returns new row, fires ws event', async () => {
    const s = await seed()

    let captured: unknown = null
    const unsub = taskBroadcaster.subscribe(TASK_CHANNEL(s.taskId), (evt) => {
      captured = evt
    })

    const updated = await updateReviewCommentText(
      s.db,
      s.nodeRunId,
      s.commentId,
      'revised text',
      OWNER_AUTHZ,
    )
    unsub()

    expect(updated.commentText).toBe('revised text')
    expect(updated.id).toBe(s.commentId)
    expect(updated.anchor.selectedText).toBe('Hello')

    const stored = await s.db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.id, s.commentId))
    expect(stored[0]?.commentText).toBe('revised text')

    expect(captured).toMatchObject({
      type: 'review.comment_updated',
      nodeRunId: s.nodeRunId,
      docVersionId: s.docVersionId,
    })
  })

  test('404 — commentId does not exist', async () => {
    const s = await seed()
    await expect(
      updateReviewCommentText(s.db, s.nodeRunId, 'cmt_missing', 'x', OWNER_AUTHZ),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  test('404 — nodeRunId mismatched (cross-review write)', async () => {
    const s = await seed()
    await expect(
      updateReviewCommentText(s.db, 'run_other', s.commentId, 'x', OWNER_AUTHZ),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  test('409 — doc_version no longer pending (review already decided)', async () => {
    const s = await seed({ decision: 'approved' })
    await expect(
      updateReviewCommentText(s.db, s.nodeRunId, s.commentId, 'too late', OWNER_AUTHZ),
    ).rejects.toBeInstanceOf(ConflictError)

    // Original commentText untouched.
    const stored = await s.db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.id, s.commentId))
    expect(stored[0]?.commentText).toBe('original')
  })
})

describe('review comment ownership and terminal guards', () => {
  test('delete refuses a comment owned by a different review and preserves it', async () => {
    const s = await seed()
    await s.db.insert(nodeRuns).values({
      id: 'run_other',
      taskId: s.taskId,
      nodeId: 'rev_2',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'awaiting_review',
    })
    await s.db.insert(docVersions).values({
      id: 'dv_other',
      taskId: s.taskId,
      reviewNodeId: 'rev_2',
      reviewNodeRunId: 'run_other',
      sourceNodeId: 'designer',
      sourcePortName: 'other',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: 'irrelevant',
      commentsJson: '[]',
      decision: 'pending',
      createdAt: 1,
    })
    await s.db.insert(reviewComments).values({
      id: 'cmt_other',
      docVersionId: 'dv_other',
      anchorSectionPath: '# Other',
      anchorParagraphIdx: 0,
      anchorOffsetStart: 0,
      anchorOffsetEnd: 5,
      selectedText: 'Other',
      contextBefore: '',
      contextAfter: '',
      occurrenceIndex: 1,
      commentText: 'belongs elsewhere',
      author: 'local',
      createdAt: 1,
    })

    await expect(
      deleteReviewComment(s.db, s.nodeRunId, 'cmt_other', OWNER_AUTHZ),
    ).rejects.toMatchObject({
      code: 'review-comment-not-found',
    })
    const preserved = await s.db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.id, 'cmt_other'))
    expect(preserved).toHaveLength(1)
  })

  test('terminal task rejects comment edits before touching the row', async () => {
    const s = await seed()
    await s.db.update(tasks).set({ status: 'canceled' }).where(eq(tasks.id, s.taskId))

    await expect(
      updateReviewCommentText(s.db, s.nodeRunId, s.commentId, 'too late', OWNER_AUTHZ),
    ).rejects.toMatchObject({ code: 'task-terminal' })
    const stored = await s.db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.id, s.commentId))
    expect(stored[0]?.commentText).toBe('original')
  })
})

describe('RFC-009-T1 PATCH /api/reviews/:nodeRunId/comments/:id route', () => {
  const HEADERS = { Authorization: 'Bearer tok' }
  let s: Seed
  beforeEach(async () => {
    s = await seed()
  })
  afterEach(() => {
    // in-memory db is GC'd; nothing else to clean.
  })

  test('200 — round-trip via HTTP, response body matches db', async () => {
    const app = createApp({
      token: 'tok',
      configPath: '',
      opencodeVersion: '1.14.99',
      dbVersion: 1,
      db: s.db,
    })
    const res = await app.fetch(
      new Request(`http://localhost/api/reviews/${s.nodeRunId}/comments/${s.commentId}`, {
        method: 'PATCH',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ commentText: 'edited via http' }),
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; commentText: string }
    expect(body.commentText).toBe('edited via http')
    expect(body.id).toBe(s.commentId)

    const stored = await s.db
      .select()
      .from(reviewComments)
      .where(eq(reviewComments.id, s.commentId))
    expect(stored[0]?.commentText).toBe('edited via http')
  })

  test('422 — empty commentText rejected by zod (min length 1)', async () => {
    const app = createApp({
      token: 'tok',
      configPath: '',
      opencodeVersion: '1.14.99',
      dbVersion: 1,
      db: s.db,
    })
    const res = await app.fetch(
      new Request(`http://localhost/api/reviews/${s.nodeRunId}/comments/${s.commentId}`, {
        method: 'PATCH',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ commentText: '' }),
      }),
    )
    // ValidationError surfaces as 422 in this project's error handler.
    expect(res.status).toBe(422)
  })
})

// ---------------------------------------------------------------------------
// RFC-285 B6① —— 作者校验矩阵（此前 PATCH/DELETE 无 actor 入参：任何任务成员
// 可改/删他人评论的冒名洞）。角色语义：owner 与资源管理员（admin/manager）
// 旁路；普通协作者（'user'）只能动 author === 本人 的行；LOCAL_DECIDER
// 兜底行（'local'）不等于任何真实 user id ⇒ 自然 owner/admin-only（用户拍板）。
// ---------------------------------------------------------------------------

describe('RFC-285 B6① — review comment authorship matrix', () => {
  async function seedAuthored(author: string): Promise<Seed> {
    const s = await seed()
    await s.db.update(reviewComments).set({ author }).where(eq(reviewComments.id, s.commentId))
    return s
  }

  test('协作者改他人评论 → 403 review-comment-not-author，行不动', async () => {
    const s = await seedAuthored('u_author')
    await expect(
      updateReviewCommentText(s.db, s.nodeRunId, s.commentId, 'hijack', {
        actorUserId: 'u_other',
        role: 'user',
      }),
    ).rejects.toMatchObject({ code: 'review-comment-not-author', status: 403 })
    const row = (
      await s.db.select().from(reviewComments).where(eq(reviewComments.id, s.commentId))
    )[0]!
    expect(row.commentText).toBe('original')
  })

  test('作者本人（user 角色）改自己的评论 → 成功', async () => {
    const s = await seedAuthored('u_author')
    const updated = await updateReviewCommentText(s.db, s.nodeRunId, s.commentId, 'mine', {
      actorUserId: 'u_author',
      role: 'user',
    })
    expect(updated.commentText).toBe('mine')
  })

  test('owner / admin / manager 旁路可改他人评论', async () => {
    for (const role of ['owner', 'admin', 'manager'] as const) {
      const s = await seedAuthored('u_author')
      const updated = await updateReviewCommentText(s.db, s.nodeRunId, s.commentId, `by-${role}`, {
        actorUserId: 'u_priv',
        role,
      })
      expect(updated.commentText).toBe(`by-${role}`)
    }
  })

  test('LOCAL_DECIDER 兜底行：协作者 403（即便自称 local）、owner 可动（Q 拍板 owner/admin-only）', async () => {
    const s = await seedAuthored('local')
    await expect(
      updateReviewCommentText(s.db, s.nodeRunId, s.commentId, 'x', {
        actorUserId: 'u_random',
        role: 'user',
      }),
    ).rejects.toMatchObject({ code: 'review-comment-not-author' })
    const ok = await updateReviewCommentText(s.db, s.nodeRunId, s.commentId, 'owner-touch', {
      actorUserId: 'u_owner',
      role: 'owner',
    })
    expect(ok.commentText).toBe('owner-touch')
  })

  test('delete 同矩阵：协作者删他人 403、作者删自己成功', async () => {
    const s = await seedAuthored('u_author')
    await expect(
      deleteReviewComment(s.db, s.nodeRunId, s.commentId, {
        actorUserId: 'u_other',
        role: 'user',
      }),
    ).rejects.toMatchObject({ code: 'review-comment-not-author' })
    await deleteReviewComment(s.db, s.nodeRunId, s.commentId, {
      actorUserId: 'u_author',
      role: 'user',
    })
    const rows = await s.db.select().from(reviewComments).where(eq(reviewComments.id, s.commentId))
    expect(rows.length).toBe(0)
  })

  // B6① 冻结回归锁（v1 虚项降级产物）：update/delete 对 decided 行的 409 对称
  // 冻结由上方既有「409 conflict」用例双向锁定——此处只锁语序：作者校验在
  // 冻结判之后（decided 行对任何人都是 409，绝不因作者不符而先泄 403）。
  test('冻结优先于作者校验：decided 行对非作者也是 409 而非 403', async () => {
    const s = await seed({ decision: 'approved' })
    await expect(
      updateReviewCommentText(s.db, s.nodeRunId, s.commentId, 'x', {
        actorUserId: 'u_other',
        role: 'user',
      }),
    ).rejects.toMatchObject({ code: 'review-not-awaiting', status: 409 })
  })
})
