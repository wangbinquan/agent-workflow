import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { buildActor } from '../src/auth/actor'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb } from '../src/db/client'
import {
  docVersions,
  nodeRuns,
  reviewComments,
  reviewNodeReviewers,
  taskCollaborators,
  tasks,
  users,
  workflows,
} from '../src/db/schema'
import { createCollaborationCommandContext } from '../src/modules/collaboration/composition'
import { replaceReviewNodeReviewers } from '../src/modules/collaboration/public/commands'
import {
  getReviewNodeReviewerConfig,
  resolveReviewAccess,
} from '../src/modules/collaboration/public/queries'
import { deriveReviewAccess } from '../src/modules/collaboration/domain/reviewAccess'
import { createSqliteTaskExecutionReadModels } from '../src/modules/task-execution/infrastructure/sqliteTaskExecutionReadModels'
import { createApp } from '../src/server'
import { countPendingReviews } from '../src/services/review'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function actor(id: string) {
  return buildActor({
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
    source: 'session',
  })
}

async function fixture() {
  const db = createInMemoryDb(MIGRATIONS)
  const now = 1_789_000_000_000
  await db.insert(users).values(
    ['owner', 'reviewer', 'other'].map((id) => ({
      id,
      username: id,
      displayName: id,
      role: 'user' as const,
      status: 'active' as const,
      createdAt: now,
      updatedAt: now,
    })),
  )
  await db.insert(workflows).values({
    id: 'wf',
    name: 'Workflow',
    definition: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
  })
  await db.insert(tasks).values({
    id: 'task',
    name: 'Task',
    workflowId: 'wf',
    workflowSnapshot: JSON.stringify({
      nodes: [
        { id: 'review-a', kind: 'review', title: 'Review A', description: 'A document' },
        { id: 'review-b', kind: 'review', title: 'Review B', description: 'Another document' },
        { id: 'worker', kind: 'agent' },
      ],
      edges: [],
      inputs: [],
    }),
    repoPath: '/tmp/rfc340',
    worktreePath: '/tmp/rfc340',
    baseBranch: 'main',
    branch: 'agent-workflow/rfc340',
    status: 'awaiting_review',
    inputs: '{}',
    startedAt: now,
    ownerUserId: 'owner',
  })
  await db.insert(nodeRuns).values([
    ...['a', 'b'].map((suffix) => ({
      id: suffix === 'a' ? 'run' : `run-${suffix}`,
      taskId: 'task',
      nodeId: `review-${suffix}`,
      status: 'awaiting_review' as const,
      retryIndex: 0,
      iteration: 0,
      reviewIteration: 0,
      startedAt: now,
    })),
    {
      id: 'run-history',
      taskId: 'task',
      nodeId: 'review-a',
      status: 'done' as const,
      retryIndex: 0,
      iteration: 1,
      reviewIteration: 1,
      startedAt: now - 1,
      finishedAt: now,
    },
  ])
  await db.insert(docVersions).values([
    ...['a', 'b'].map((suffix) => ({
      id: suffix === 'a' ? 'doc' : `doc-${suffix}`,
      taskId: 'task',
      reviewNodeId: `review-${suffix}`,
      reviewNodeRunId: suffix === 'a' ? 'run' : `run-${suffix}`,
      sourceNodeId: 'worker',
      sourcePortName: 'document',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: 'not-read.md',
      decision: 'pending' as const,
      createdAt: now,
    })),
    {
      id: 'doc-history',
      taskId: 'task',
      reviewNodeId: 'review-a',
      reviewNodeRunId: 'run-history',
      sourceNodeId: 'worker',
      sourcePortName: 'document',
      versionIndex: 1,
      reviewIteration: 1,
      bodyPath: 'not-read.md',
      decision: 'approved' as const,
      createdAt: now - 1,
      decidedAt: now,
    },
  ])
  const taskExecutionReadModels = createSqliteTaskExecutionReadModels(db)
  const context = createCollaborationCommandContext({
    db,
    taskExecutionReadModels,
  })
  return { db, context, taskExecutionReadModels }
}

describe('RFC-340 review access matrix', () => {
  test('assigned reviewer is opinion-only and task roles retain their stronger union', () => {
    expect(
      deriveReviewAccess({
        taskVisible: false,
        taskActorRole: null,
        assignedReviewer: false,
        resourceAclBypass: false,
      }),
    ).toBeNull()
    expect(
      deriveReviewAccess({
        taskVisible: false,
        taskActorRole: null,
        assignedReviewer: true,
        resourceAclBypass: false,
      }),
    ).toEqual({
      capabilities: {
        scope: 'review-node',
        canAddComment: true,
        canEditOwnComments: true,
        canDeleteOwnComments: false,
        canManageAnyComments: false,
        canSelectDocuments: false,
        canDecide: false,
      },
      commentAuthorRole: 'reviewer',
    })
    expect(
      deriveReviewAccess({
        taskVisible: true,
        taskActorRole: null,
        assignedReviewer: false,
        resourceAclBypass: false,
      })?.capabilities,
    ).toEqual({
      scope: 'task',
      canAddComment: false,
      canEditOwnComments: false,
      canDeleteOwnComments: false,
      canManageAnyComments: false,
      canSelectDocuments: false,
      canDecide: false,
    })
    expect(
      deriveReviewAccess({
        taskVisible: true,
        taskActorRole: 'user',
        assignedReviewer: true,
        resourceAclBypass: false,
      })?.capabilities,
    ).toEqual({
      scope: 'task',
      canAddComment: true,
      canEditOwnComments: true,
      canDeleteOwnComments: true,
      canManageAnyComments: false,
      canSelectDocuments: true,
      canDecide: true,
    })
    expect(
      deriveReviewAccess({
        taskVisible: true,
        taskActorRole: 'owner',
        assignedReviewer: false,
        resourceAclBypass: false,
      })?.capabilities.canManageAnyComments,
    ).toBe(true)
    expect(
      deriveReviewAccess({
        taskVisible: true,
        taskActorRole: 'manager',
        assignedReviewer: false,
        resourceAclBypass: true,
      })?.capabilities,
    ).toMatchObject({ canManageAnyComments: true, canSelectDocuments: true, canDecide: true })
  })

  test('owner full-replaces assignments; removal revokes and re-add restores node history access', async () => {
    const { db, context } = await fixture()
    const owner = actor('owner')
    const reviewer = actor('reviewer')

    await replaceReviewNodeReviewers(context, {
      actor: owner,
      taskId: 'task',
      body: { nodes: [{ reviewNodeId: 'review-a', reviewerUserIds: ['reviewer'] }] },
    })
    expect(
      (await getReviewNodeReviewerConfig(context, { actor: owner, taskId: 'task' })).nodes[0],
    ).toMatchObject({ reviewNodeId: 'review-a', reviewers: [{ id: 'reviewer' }] })
    expect(await resolveReviewAccess(context, { actor: reviewer, nodeRunId: 'run' })).toMatchObject(
      {
        commentAuthorRole: 'reviewer',
        capabilities: { scope: 'review-node', canAddComment: true, canDecide: false },
      },
    )
    expect(
      await resolveReviewAccess(context, { actor: reviewer, nodeRunId: 'run-history' }),
    ).toMatchObject({ capabilities: { scope: 'review-node' } })
    expect(await countPendingReviews(db, reviewer)).toBe(1)

    await replaceReviewNodeReviewers(context, {
      actor: owner,
      taskId: 'task',
      body: { nodes: [] },
    })
    expect(await resolveReviewAccess(context, { actor: reviewer, nodeRunId: 'run' })).toBeNull()
    expect(await countPendingReviews(db, reviewer)).toBe(0)

    await replaceReviewNodeReviewers(context, {
      actor: owner,
      taskId: 'task',
      body: { nodes: [{ reviewNodeId: 'review-a', reviewerUserIds: ['reviewer'] }] },
    })
    expect(await resolveReviewAccess(context, { actor: reviewer, nodeRunId: 'run' })).not.toBeNull()
  })

  test('HTTP reviewer surface lists assigned gates, permits own edits, and refuses delete/decision/selection', async () => {
    const { db, context, taskExecutionReadModels } = await fixture()
    await replaceReviewNodeReviewers(context, {
      actor: actor('owner'),
      taskId: 'task',
      body: { nodes: [{ reviewNodeId: 'review-a', reviewerUserIds: ['reviewer'] }] },
    })
    await db.insert(reviewComments).values([
      {
        id: 'comment',
        docVersionId: 'doc',
        anchorSectionPath: '',
        anchorParagraphIdx: 0,
        anchorOffsetStart: 0,
        anchorOffsetEnd: 0,
        selectedText: '',
        contextBefore: '',
        contextAfter: '',
        occurrenceIndex: 0,
        commentText: 'original',
        author: 'reviewer',
        authorRole: 'reviewer',
        createdAt: 1,
      },
      {
        id: 'other-comment',
        docVersionId: 'doc',
        anchorSectionPath: '',
        anchorParagraphIdx: 0,
        anchorOffsetStart: 0,
        anchorOffsetEnd: 0,
        selectedText: '',
        contextBefore: '',
        contextAfter: '',
        occurrenceIndex: 0,
        commentText: 'another opinion',
        author: 'other',
        authorRole: 'user',
        createdAt: 2,
      },
    ])
    const token = (await createSession({ db, userId: 'reviewer' })).token
    const app = createApp({
      token: 'daemon-token',
      configPath: '',
      opencodeVersion: 'test',
      dbVersion: 217,
      db,
      collaborationContext: context,
      taskExecutionReadModels,
    })
    const request = (path: string, init: RequestInit = {}) =>
      app.fetch(
        new Request(`http://localhost${path}`, {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(init.headers ?? {}),
          },
        }),
      )

    const list = await request('/api/reviews?status=pending')
    expect(list.status).toBe(200)
    expect(await list.json()).toMatchObject([
      { nodeRunId: 'run', taskId: 'task', reviewNodeId: 'review-a', accessScope: 'review-node' },
    ])
    const count = await request('/api/reviews/pending-count')
    expect(await count.json()).toEqual({ count: 1 })

    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc340-comment-'))
    const previousAppHome = process.env.AGENT_WORKFLOW_HOME
    writeFileSync(join(appHome, 'not-read.md'), '# Review document\n', 'utf8')
    process.env.AGENT_WORKFLOW_HOME = appHome
    try {
      const detail = await request('/api/reviews/run')
      expect(detail.status).toBe(200)
      expect(await detail.json()).toMatchObject({
        capabilities: {
          scope: 'review-node',
          canAddComment: true,
          canEditOwnComments: true,
          canDeleteOwnComments: false,
          canSelectDocuments: false,
          canDecide: false,
        },
        comments: [
          { id: 'comment', author: 'reviewer', commentText: 'original' },
          { id: 'other-comment', author: 'other', commentText: 'another opinion' },
        ],
      })

      const add = await request('/api/reviews/run/comments', {
        method: 'POST',
        body: JSON.stringify({ commentText: 'New reviewer opinion' }),
      })
      expect(add.status).toBe(201)
      expect(await add.json()).toMatchObject({
        commentText: 'New reviewer opinion',
        author: 'reviewer',
        authorRole: 'reviewer',
      })
    } finally {
      if (previousAppHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
      else process.env.AGENT_WORKFLOW_HOME = previousAppHome
      rmSync(appHome, { recursive: true, force: true })
    }

    const edit = await request('/api/reviews/run/comments/comment', {
      method: 'PATCH',
      body: JSON.stringify({ commentText: 'reviewer edit' }),
    })
    expect(edit.status).toBe(200)
    expect(await edit.json()).toMatchObject({ commentText: 'reviewer edit', author: 'reviewer' })

    const editOther = await request('/api/reviews/run/comments/other-comment', {
      method: 'PATCH',
      body: JSON.stringify({ commentText: 'forbidden edit' }),
    })
    expect(editOther.status).toBe(403)
    expect(
      (await db.select().from(reviewComments).where(eq(reviewComments.id, 'other-comment')))[0]
        ?.commentText,
    ).toBe('another opinion')

    const remove = await request('/api/reviews/run/comments/comment', { method: 'DELETE' })
    expect(remove.status).toBe(403)
    expect(await remove.json()).toMatchObject({ code: 'review-comment-delete-not-allowed' })
    expect(
      (await db.select().from(reviewComments).where(eq(reviewComments.id, 'comment')))[0]
        ?.commentText,
    ).toBe('reviewer edit')

    const decision = await request('/api/reviews/run/decision', {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved', reviewIteration: 0 }),
    })
    expect(decision.status).toBe(403)
    const selection = await request('/api/reviews/run/documents/doc/selection', {
      method: 'PATCH',
      body: JSON.stringify({ selection: 'accepted' }),
    })
    expect(selection.status).toBe(403)
  })

  test('HTTP configuration is owner-only, full-replace, and never creates task membership', async () => {
    const { db, context, taskExecutionReadModels } = await fixture()
    const app = createApp({
      token: 'daemon-token',
      configPath: '',
      opencodeVersion: 'test',
      dbVersion: 217,
      db,
      collaborationContext: context,
      taskExecutionReadModels,
    })
    const ownerToken = (await createSession({ db, userId: 'owner' })).token
    const reviewerToken = (await createSession({ db, userId: 'reviewer' })).token
    const request = (token: string, init: RequestInit = {}) =>
      app.fetch(
        new Request('http://localhost/api/tasks/task/reviewers', {
          ...init,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(init.headers ?? {}),
          },
        }),
      )

    const initial = await request(ownerToken)
    expect(initial.status).toBe(200)
    const initialBody = (await initial.json()) as {
      taskId: string
      canManage: boolean
      nodes: Array<{ reviewNodeId: string; reviewers: unknown[] }>
    }
    expect(initialBody.taskId).toBe('task')
    expect(initialBody.canManage).toBe(true)
    expect(initialBody.nodes.map((node) => node.reviewNodeId)).toEqual(['review-a', 'review-b'])
    expect(initialBody.nodes.every((node) => node.reviewers.length === 0)).toBe(true)

    const replaced = await request(ownerToken, {
      method: 'PUT',
      body: JSON.stringify({
        nodes: [{ reviewNodeId: 'review-a', reviewerUserIds: ['reviewer'] }],
      }),
    })
    expect(replaced.status).toBe(200)
    const replacedBody = (await replaced.json()) as {
      nodes: Array<{ reviewNodeId: string; reviewers: Array<{ id: string }> }>
    }
    expect(replacedBody.nodes.find((node) => node.reviewNodeId === 'review-a')).toMatchObject({
      reviewers: [{ id: 'reviewer' }],
    })
    expect(replacedBody.nodes.find((node) => node.reviewNodeId === 'review-b')).toMatchObject({
      reviewers: [],
    })
    expect(await db.select().from(taskCollaborators)).toEqual([])

    const forbidden = await request(reviewerToken)
    expect(forbidden.status).toBe(404)

    await db.delete(tasks).where(eq(tasks.id, 'task'))
    expect(await db.select().from(reviewNodeReviewers)).toEqual([])
  })

  test('rejects duplicate nodes, unknown nodes, inactive users, and non-owner management', async () => {
    const { db, context } = await fixture()
    const owner = actor('owner')
    await expect(
      replaceReviewNodeReviewers(context, {
        actor: owner,
        taskId: 'task',
        body: {
          nodes: [
            { reviewNodeId: 'review-a', reviewerUserIds: [] },
            { reviewNodeId: 'review-a', reviewerUserIds: [] },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'review-reviewers-duplicate-node' })
    await expect(
      replaceReviewNodeReviewers(context, {
        actor: owner,
        taskId: 'task',
        body: { nodes: [{ reviewNodeId: 'worker', reviewerUserIds: ['reviewer'] }] },
      }),
    ).rejects.toMatchObject({ code: 'review-reviewers-node-invalid' })
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, 'reviewer'))
    await expect(
      replaceReviewNodeReviewers(context, {
        actor: owner,
        taskId: 'task',
        body: { nodes: [{ reviewNodeId: 'review-a', reviewerUserIds: ['reviewer'] }] },
      }),
    ).rejects.toMatchObject({ code: 'review-reviewers-user-invalid' })
    await expect(
      getReviewNodeReviewerConfig(context, { actor: actor('other'), taskId: 'task' }),
    ).rejects.toMatchObject({ code: 'forbidden' })
  })
})
