// RFC-099 B3 — task-membership answer rights + attribution recording.
//
// Locks the D5/D7/D8/D14 behavior end to end over HTTP:
//   - review decision/comments: any task member may act (the RFC-036
//     assigned-reviewer gate is gone); strangers get 403 not-task-member;
//     author + role snapshots land on review_comments / doc_versions.
//   - clarify: member-gated draft saves with per-question last-write-wins +
//     per-question attribution; submit freezes attribution (draft editors
//     kept where values match, submitter takes over changed answers) and
//     records the submitter's role; drafts reject non-awaiting rounds.

import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { Hono } from 'hono'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  clarifyRounds,
  docVersions,
  nodeRunOutputs,
  nodeRuns,
  reviewComments,
  taskCollaborators,
  tasks,
  workflows,
} from '../src/db/schema'
import { createApp } from '../src/server'
import { createClarifyRound } from '../src/services/clarify/service'
import { createUser } from '../src/services/users'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Users {
  alice: { id: string; token: string } // task owner
  carol: { id: string; token: string } // collaborator
  dave: { id: string; token: string } // stranger
  admin: { id: string; token: string }
}

async function seedUsers(db: DbClient): Promise<Users> {
  async function mk(username: string, role: 'admin' | 'user') {
    const u = await createUser(db, {
      username,
      displayName: `dn-${username}`,
      role,
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db, userId: u.id })
    return { id: u.id, token }
  }
  return {
    alice: await mk('alice', 'user'),
    carol: await mk('carol', 'user'),
    dave: await mk('dave', 'user'),
    admin: await mk('root', 'admin'),
  }
}

async function req(
  app: Hono,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

async function addMembership(
  db: DbClient,
  taskId: string,
  ownerId: string,
  collaboratorId: string,
): Promise<void> {
  await db.insert(taskCollaborators).values([
    { taskId, userId: ownerId, role: 'owner', addedBy: ownerId, addedAt: Date.now() },
    { taskId, userId: collaboratorId, role: 'collaborator', addedBy: ownerId, addedAt: Date.now() },
  ])
}

// ---------------------------------------------------------------------------
// Review side — light direct-DB fixture (mirrors review-decision-full-asserts)
// ---------------------------------------------------------------------------

describe('RFC-099 — review membership + attribution', () => {
  let db: DbClient
  let app: Hono
  let users: Users
  let taskId = ''
  let reviewRunId = ''
  let appHome = ''

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc099-rev-'))
    appHome = join(tmp, 'appHome')
    mkdirSync(appHome, { recursive: true })
    process.env.AGENT_WORKFLOW_HOME = appHome
    app = createApp({
      token: DAEMON_TOKEN,
      configPath: '',
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      db,
    })
    users = await seedUsers(db)

    const definition: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [],
      nodes: [
        { id: 'doc', kind: 'agent-single', agentName: 'doc', promptTemplate: '' } as WorkflowNode,
        {
          id: 'rev_1',
          kind: 'review',
          inputSource: { nodeId: 'doc', portName: 'docpath' },
        } as unknown as WorkflowNode,
      ],
      edges: [],
    }
    const workflowId = ulid()
    await db
      .insert(workflows)
      .values({ id: workflowId, name: 'wf', definition: JSON.stringify(definition) })
    taskId = ulid()
    await db.insert(tasks).values({
      name: 't',
      id: taskId,
      workflowId,
      workflowSnapshot: JSON.stringify(definition),
      repoPath: '/tmp/never-read',
      worktreePath: '/tmp/never-read',
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      status: 'awaiting_review',
      inputs: '{}',
      startedAt: Date.now(),
      ownerUserId: users.alice.id,
    })
    await addMembership(db, taskId, users.alice.id, users.carol.id)

    const agentRunId = ulid()
    await db.insert(nodeRuns).values({
      id: agentRunId,
      taskId,
      nodeId: 'doc',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 1000,
      finishedAt: Date.now() - 900,
    })
    await db
      .insert(nodeRunOutputs)
      .values({ nodeRunId: agentRunId, portName: 'docpath', content: '# body inline' })
    reviewRunId = ulid()
    await db.insert(nodeRuns).values({
      id: reviewRunId,
      taskId,
      nodeId: 'rev_1',
      status: 'awaiting_review',
      retryIndex: 0,
      iteration: 0,
      reviewIteration: 0,
      startedAt: Date.now() - 50,
    })
    mkdirSync(join(appHome, 'doc_versions'), { recursive: true })
    writeFileSync(join(appHome, 'doc_versions/v1.md'), '# body inline')
    await db.insert(docVersions).values({
      id: ulid(),
      taskId,
      reviewNodeId: 'rev_1',
      reviewNodeRunId: reviewRunId,
      sourceNodeId: 'doc',
      sourcePortName: 'docpath',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: 'doc_versions/v1.md',
      decision: 'pending',
    })
  })

  test('stranger cannot read or decide; collaborator comment + decision record role snapshots', async () => {
    // stranger read → 403 task-not-visible (mirror of task routes)
    const daveDetail = await req(app, users.dave.token, `/api/reviews/${reviewRunId}`)
    expect(daveDetail.status).toBe(403)
    // stranger decision → 403 not-task-member
    const daveDecision = await req(app, users.dave.token, `/api/reviews/${reviewRunId}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved', reviewIteration: 0 }),
    })
    expect(daveDecision.status).toBe(403)

    // collaborator comments — author + role land on the row and the response
    const comment = await req(app, users.carol.token, `/api/reviews/${reviewRunId}/comments`, {
      method: 'POST',
      body: JSON.stringify({
        anchor: {
          sectionPath: 'body inline',
          paragraphIdx: 0,
          offsetStart: 2,
          offsetEnd: 6,
          selectedText: 'body',
          contextBefore: '# ',
          contextAfter: ' inline',
          occurrenceIndex: 1,
        },
        commentText: 'tighten this paragraph',
      }),
    })
    expect(comment.status).toBe(201)
    const commentBody = (await comment.json()) as { author: string; authorRole: string }
    expect(commentBody.author).toBe(users.carol.id)
    expect(commentBody.authorRole).toBe('user')
    const commentRow = (await db.select().from(reviewComments))[0]!
    expect(commentRow.author).toBe(users.carol.id)
    expect(commentRow.authorRole).toBe('user')

    // collaborator decision (pre-RFC-099 this was 403 not-reviewer)
    const decision = await req(app, users.carol.token, `/api/reviews/${reviewRunId}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved', reviewIteration: 0 }),
    })
    expect(decision.status).toBe(200)
    const dv = (await db.select().from(docVersions))[0]!
    expect(dv.decision).toBe('approved')
    expect(dv.decidedBy).toBe(users.carol.id)
    expect(dv.decidedByRole).toBe('user')
    // RFC-099 prompt isolation — approval_meta port carries no identity
    const metaRow = (
      await db.select().from(nodeRunOutputs).where(eq(nodeRunOutputs.nodeRunId, reviewRunId))
    ).find((o) => o.portName === 'approval_meta')!
    expect(metaRow.content).not.toContain(users.carol.id)
    expect(metaRow.content).not.toContain('dn-carol')
  })

  test('owner decision records owner role; non-member admin records admin (D17)', async () => {
    const decision = await req(app, users.admin.token, `/api/reviews/${reviewRunId}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'rejected', rejectReason: 'redo', reviewIteration: 0 }),
    })
    expect(decision.status).toBe(200)
    const dv = (await db.select().from(docVersions))[0]!
    expect(dv.decidedBy).toBe(users.admin.id)
    expect(dv.decidedByRole).toBe('admin')
  })

  test('review list + pending-count filter by task visibility', async () => {
    const carolList = (await (
      await req(app, users.carol.token, '/api/reviews?status=pending')
    ).json()) as unknown[]
    expect(carolList.length).toBe(1)
    const daveList = (await (
      await req(app, users.dave.token, '/api/reviews?status=pending')
    ).json()) as unknown[]
    expect(daveList.length).toBe(0)
    const daveCount = (await (
      await req(app, users.dave.token, '/api/reviews/pending-count')
    ).json()) as { count: number }
    expect(daveCount.count).toBe(0)
    const adminCount = (await (
      await req(app, users.admin.token, '/api/reviews/pending-count')
    ).json()) as { count: number }
    expect(adminCount.count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Clarify side — createClarifyRound fixture + collaborative drafts
// ---------------------------------------------------------------------------

const QUESTIONS = [
  {
    id: 'q1',
    title: 'Which database?',
    kind: 'single' as const,
    recommended: true,
    options: [
      { label: 'Postgres', description: '', recommended: false, recommendationReason: '' },
      { label: 'MySQL', description: '', recommended: false, recommendationReason: '' },
    ],
  },
  {
    id: 'q2',
    title: 'Which cache?',
    kind: 'single' as const,
    recommended: true,
    options: [
      { label: 'Redis', description: '', recommended: false, recommendationReason: '' },
      { label: 'Memcached', description: '', recommended: false, recommendationReason: '' },
    ],
  },
]

describe('RFC-099 — clarify membership, drafts, attribution freeze', () => {
  let db: DbClient
  let app: Hono
  let users: Users
  let taskId = ''
  let clarifyNodeRunId = ''
  let roundId = ''

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    app = createApp({
      token: DAEMON_TOKEN,
      configPath: '',
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      db,
    })
    users = await seedUsers(db)

    taskId = `task_${ulid()}`
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [],
      nodes: [
        { id: 'designer', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
        { id: 'c1', kind: 'clarify', title: 'Clarify' } as WorkflowNode,
      ],
      edges: [],
      outputs: [],
    }
    const workflowId = `wf_${taskId}`
    await db.insert(workflows).values({
      id: workflowId,
      name: 'wf',
      description: '',
      definition: JSON.stringify(def),
      version: 1,
      schemaVersion: 3,
    })
    await db.insert(tasks).values({
      name: 'fixture-task',
      id: taskId,
      workflowId,
      workflowSnapshot: JSON.stringify(def),
      repoPath: '/tmp/aw-test/repo',
      worktreePath: '',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'awaiting_human',
      inputs: '{}',
      startedAt: Date.now(),
      ownerUserId: users.alice.id,
    })
    await addMembership(db, taskId, users.alice.id, users.carol.id)
    const sourceRunId = ulid()
    await db.insert(nodeRuns).values({
      id: sourceRunId,
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const created = await createClarifyRound({
      kind: 'self',
      db,
      taskId,
      askingNodeId: 'designer',
      askingNodeRunId: sourceRunId,
      askingShardKey: null,
      intermediaryNodeId: 'c1',
      iteration: 0,
      questions: QUESTIONS,
    })
    clarifyNodeRunId = created.intermediaryNodeRunId
    roundId = created.round.id
  })

  function draftBody(questionId: string, optionIdx: number, customText = '') {
    return JSON.stringify({
      roundId,
      questionId,
      selectedOptionIndices: [optionIdx],
      customText,
    })
  }

  test('draft: member-gated, per-question LWW, attribution per editor; submit freezes (D8/D14/D17)', async () => {
    // stranger draft → 403
    expect(
      (
        await req(app, users.dave.token, `/api/clarify/${clarifyNodeRunId}/draft`, {
          method: 'PUT',
          body: draftBody('q1', 0),
        })
      ).status,
    ).toBe(403)

    // carol drafts q1=Postgres; alice drafts q2=Redis
    expect(
      (
        await req(app, users.carol.token, `/api/clarify/${clarifyNodeRunId}/draft`, {
          method: 'PUT',
          body: draftBody('q1', 0),
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await req(app, users.alice.token, `/api/clarify/${clarifyNodeRunId}/draft`, {
          method: 'PUT',
          body: draftBody('q2', 0),
        })
      ).status,
    ).toBe(200)

    // LWW: alice overwrites carol's q1 → q1 attribution flips to alice/owner
    expect(
      (
        await req(app, users.alice.token, `/api/clarify/${clarifyNodeRunId}/draft`, {
          method: 'PUT',
          body: draftBody('q1', 1),
        })
      ).status,
    ).toBe(200)

    // detail exposes drafts + live attributions
    const detail = (await (
      await req(app, users.carol.token, `/api/clarify/${clarifyNodeRunId}`)
    ).json()) as {
      draftAnswers: Record<string, { selectedOptionIndices: number[] }>
      answerAttributions: Record<string, { userId: string; role: string }>
    }
    expect(detail.draftAnswers.q1?.selectedOptionIndices).toEqual([1])
    expect(detail.answerAttributions.q1?.userId).toBe(users.alice.id)
    expect(detail.answerAttributions.q1?.role).toBe('owner')
    expect(detail.answerAttributions.q2?.userId).toBe(users.alice.id)

    // unknown question id → 404
    expect(
      (
        await req(app, users.carol.token, `/api/clarify/${clarifyNodeRunId}/draft`, {
          method: 'PUT',
          body: draftBody('q-nope', 0),
        })
      ).status,
    ).toBe(404)

    // carol submits: q1 kept as alice's draft value (MySQL idx 1) → attribution
    // stays alice/owner; q2 changed by carol at submit (Memcached idx 1) →
    // attribution becomes carol/user; submitter = carol/user.
    const submit = await req(app, users.carol.token, `/api/clarify/${clarifyNodeRunId}/answers`, {
      method: 'POST',
      body: JSON.stringify({
        answers: [
          {
            questionId: 'q1',
            selectedOptionIndices: [1],
            selectedOptionLabels: [],
            customText: '',
          },
          {
            questionId: 'q2',
            selectedOptionIndices: [1],
            selectedOptionLabels: [],
            customText: '',
          },
        ],
      }),
    })
    expect(submit.status).toBe(200)
    const row = (await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, roundId)))[0]!
    expect(row.status).toBe('answered')
    expect(row.answeredBy).toBe(users.carol.id)
    expect(row.submittedByRole).toBe('user')
    expect(row.draftAnswersJson).toBeNull()
    const attrs = JSON.parse(row.answerAttributionsJson!) as Record<
      string,
      { userId: string; role: string }
    >
    expect(attrs.q1).toMatchObject({ userId: users.alice.id, role: 'owner' })
    expect(attrs.q2).toMatchObject({ userId: users.carol.id, role: 'user' })

    // drafts on an answered round → 409
    const late = await req(app, users.carol.token, `/api/clarify/${clarifyNodeRunId}/draft`, {
      method: 'PUT',
      body: draftBody('q1', 0),
    })
    expect(late.status).toBe(409)
  })

  test('stranger cannot submit answers or read detail; list/pending-count filtered', async () => {
    expect(
      (
        await req(app, users.dave.token, `/api/clarify/${clarifyNodeRunId}/answers`, {
          method: 'POST',
          body: JSON.stringify({
            answers: [
              {
                questionId: 'q1',
                selectedOptionIndices: [0],
                selectedOptionLabels: [],
                customText: '',
              },
              {
                questionId: 'q2',
                selectedOptionIndices: [0],
                selectedOptionLabels: [],
                customText: '',
              },
            ],
          }),
        })
      ).status,
    ).toBe(403)
    expect((await req(app, users.dave.token, `/api/clarify/${clarifyNodeRunId}`)).status).toBe(403)
    const daveCount = (await (
      await req(app, users.dave.token, '/api/clarify/pending-count')
    ).json()) as { count: number }
    expect(daveCount.count).toBe(0)
    const carolCount = (await (
      await req(app, users.carol.token, '/api/clarify/pending-count')
    ).json()) as { count: number }
    expect(carolCount.count).toBe(1)
    const daveList = (await (await req(app, users.dave.token, '/api/clarify')).json()) as unknown[]
    expect(daveList.length).toBe(0)
  })
})
