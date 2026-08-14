// RFC-294 W4/P0-C pre-refactor oracle.
//
// This file deliberately crosses the real HTTP -> route policy -> review
// application/service -> SQLite path.  Directory moves are allowed; changing
// the visible 404/403/conflict split, losing a committed decision, or leaking
// continuation/worker internals is not.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

import { createSession } from '@/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '@/db/client'
import {
  docVersions,
  nodeRunOutputs,
  nodeRuns,
  reviewComments,
  taskCollaborators,
  tasks,
  workflows,
} from '@/db/schema'
import { createApp } from '@/server'
import { createUser } from '@/services/users'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAEMON_TOKEN = 'd'.repeat(64)

interface Principal {
  id: string
  token: string
}

interface Fixture {
  db: DbClient
  app: Hono
  root: string
  previousHome: string | undefined
  owner: Principal
  collaborator: Principal
  stranger: Principal
  taskId: string
  reviewRunId: string
  probeRunId: string
  docVersionId: string
}

let fixture: Fixture

async function principal(db: DbClient, username: string): Promise<Principal> {
  const user = await createUser(db, {
    username,
    displayName: username,
    role: 'user',
    password: 'longEnoughPassword',
  })
  const { token } = await createSession({ db, userId: user.id })
  return { id: user.id, token }
}

async function request(
  app: Hono,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return app.request(path, { ...init, headers })
}

beforeEach(async () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc294-route-gate-'))
  const appHome = join(root, 'home')
  mkdirSync(join(appHome, 'doc_versions'), { recursive: true })
  const previousHome = process.env.AGENT_WORKFLOW_HOME
  process.env.AGENT_WORKFLOW_HOME = appHome

  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const owner = await principal(db, `owner-${ulid().toLowerCase()}`)
  const collaborator = await principal(db, `member-${ulid().toLowerCase()}`)
  const stranger = await principal(db, `stranger-${ulid().toLowerCase()}`)

  const definition: WorkflowDefinition = {
    $schema_version: 2,
    inputs: [],
    nodes: [
      {
        id: 'writer',
        kind: 'agent-single',
        agentName: 'writer',
        promptTemplate: '',
      } as WorkflowNode,
      {
        id: 'review',
        kind: 'review',
        inputSource: { nodeId: 'writer', portName: 'document' },
      } as unknown as WorkflowNode,
    ],
    edges: [],
  }
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'rfc294-route-oracle',
    definition: JSON.stringify(definition),
  })

  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc294-route-oracle',
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: join(root, 'missing-worktree'),
    worktreePath: join(root, 'missing-worktree'),
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'awaiting_review',
    inputs: '{}',
    startedAt: Date.now(),
    ownerUserId: owner.id,
  })
  await db.insert(taskCollaborators).values([
    {
      taskId,
      userId: owner.id,
      role: 'owner',
      addedBy: owner.id,
      addedAt: Date.now(),
    },
    {
      taskId,
      userId: collaborator.id,
      role: 'collaborator',
      addedBy: owner.id,
      addedAt: Date.now(),
    },
  ])

  const writerRunId = ulid()
  await db.insert(nodeRuns).values({
    id: writerRunId,
    taskId,
    nodeId: 'writer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 100,
    finishedAt: Date.now() - 50,
  })
  await db.insert(nodeRunOutputs).values({
    nodeRunId: writerRunId,
    portName: 'document',
    content: '# reviewed body',
  })

  const reviewRunId = ulid()
  await db.insert(nodeRuns).values({
    id: reviewRunId,
    taskId,
    nodeId: 'review',
    status: 'awaiting_review',
    retryIndex: 0,
    iteration: 0,
    reviewIteration: 0,
    startedAt: Date.now() - 25,
  })
  const bodyPath = 'doc_versions/rfc294.md'
  writeFileSync(join(appHome, bodyPath), '# reviewed body')
  const docVersionId = ulid()
  await db.insert(docVersions).values({
    id: docVersionId,
    taskId,
    reviewNodeId: 'review',
    reviewNodeRunId: reviewRunId,
    sourceNodeId: 'writer',
    sourcePortName: 'document',
    versionIndex: 1,
    reviewIteration: 0,
    bodyPath,
    decision: 'pending',
  })

  // This row intentionally has no review documents.  An unauthorized caller
  // is rejected before the detail query, so we can delete it between two
  // probes and prove that hidden-vs-missing stays byte-identical.
  const probeRunId = ulid()
  await db.insert(nodeRuns).values({
    id: probeRunId,
    taskId,
    nodeId: 'review-probe',
    status: 'awaiting_review',
    retryIndex: 0,
    iteration: 0,
    reviewIteration: 0,
  })

  fixture = {
    db,
    app,
    root,
    previousHome,
    owner,
    collaborator,
    stranger,
    taskId,
    reviewRunId,
    probeRunId,
    docVersionId,
  }
})

afterEach(() => {
  fixture.db.$client.close()
  rmSync(fixture.root, { recursive: true, force: true })
  if (fixture.previousHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
  else process.env.AGENT_WORKFLOW_HOME = fixture.previousHome
})

function decisionBody(reviewIteration: number): string {
  return JSON.stringify({ decision: 'approved', reviewIteration })
}

async function currentDecisionState() {
  const doc = fixture.db
    .select()
    .from(docVersions)
    .where(eq(docVersions.id, fixture.docVersionId))
    .get()
  const run = fixture.db.select().from(nodeRuns).where(eq(nodeRuns.id, fixture.reviewRunId)).get()
  const outputs = await fixture.db
    .select()
    .from(nodeRunOutputs)
    .where(eq(nodeRunOutputs.nodeRunId, fixture.reviewRunId))
  return { doc, run, outputs }
}

describe('RFC-294 W4 route -> application -> DB compatibility', () => {
  test('a task collaborator can write through HTTP and the durable review mutation is complete', async () => {
    const response = await request(
      fixture.app,
      fixture.collaborator.token,
      `/api/reviews/${fixture.reviewRunId}/comments`,
      {
        method: 'POST',
        body: JSON.stringify({
          anchor: {
            sectionPath: 'reviewed body',
            paragraphIdx: 0,
            offsetStart: 2,
            offsetEnd: 10,
            selectedText: 'reviewed',
            contextBefore: '# ',
            contextAfter: ' body',
            occurrenceIndex: 1,
          },
          commentText: 'Please preserve this user-visible contract.',
        }),
      },
    )

    expect(response.status).toBe(201)
    const body = (await response.json()) as Record<string, unknown>
    expect(body).toMatchObject({
      commentText: 'Please preserve this user-visible contract.',
      author: fixture.collaborator.id,
      authorRole: 'user',
    })
    expect(JSON.stringify(body)).not.toMatch(
      /ContinuationIntent|OwnershipToken|workerId|leaseEpoch|AbortController|worktreePath/,
    )

    const row = fixture.db.select().from(reviewComments).get()
    expect(row).toMatchObject({
      docVersionId: fixture.docVersionId,
      commentText: 'Please preserve this user-visible contract.',
      author: fixture.collaborator.id,
      authorRole: 'user',
    })
    const state = await currentDecisionState()
    expect(state.doc?.decision).toBe('pending')
    expect(state.run?.status).toBe('awaiting_review')
    expect(state.outputs).toEqual([])
  })

  test('a hidden review and the same missing node-run id return byte-identical 404s', async () => {
    const hidden = await request(
      fixture.app,
      fixture.stranger.token,
      `/api/reviews/${fixture.probeRunId}`,
    )
    expect(hidden.status).toBe(404)
    const hiddenBody = await hidden.text()

    await fixture.db.delete(nodeRuns).where(eq(nodeRuns.id, fixture.probeRunId))
    const missing = await request(
      fixture.app,
      fixture.stranger.token,
      `/api/reviews/${fixture.probeRunId}`,
    )
    expect(missing.status).toBe(404)
    expect(await missing.text()).toBe(hiddenBody)
  })

  test('an accepted member decision returns the stable envelope and durably completes the gate', async () => {
    const response = await request(
      fixture.app,
      fixture.collaborator.token,
      `/api/reviews/${fixture.reviewRunId}/decision`,
      { method: 'POST', body: decisionBody(0) },
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as Record<string, unknown>
    // `resumeRequired` is a legacy service/route handshake, not part of the
    // P0-C route contract.  Keep only the stable acknowledgement + task id;
    // the refactor may remove that compatibility field when continuation is
    // owned atomically below the route.
    expect(body).toMatchObject({ ok: true, taskId: fixture.taskId })
    expect(JSON.stringify(body)).not.toMatch(
      /ContinuationIntent|OwnershipToken|workerId|leaseEpoch|AbortController|worktreePath/,
    )

    const state = await currentDecisionState()
    expect(state.doc).toMatchObject({
      decision: 'approved',
      decidedBy: fixture.collaborator.id,
      decidedByRole: 'user',
    })
    expect(state.run?.status).toBe('done')
    expect(state.outputs.map((row) => row.portName).sort()).toEqual([
      'approval_meta',
      'approved_doc',
    ])
  })

  test('write membership denial is 403, stale OCC is 409, and neither mutates the gate', async () => {
    const forbidden = await request(
      fixture.app,
      fixture.stranger.token,
      `/api/reviews/${fixture.reviewRunId}/decision`,
      { method: 'POST', body: decisionBody(0) },
    )
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toMatchObject({ code: 'not-task-member' })

    const stale = await request(
      fixture.app,
      fixture.collaborator.token,
      `/api/reviews/${fixture.reviewRunId}/decision`,
      { method: 'POST', body: decisionBody(9) },
    )
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ code: 'review-iteration-mismatch' })

    const state = await currentDecisionState()
    expect(state.doc).toMatchObject({ decision: 'pending', decidedBy: null, decidedAt: null })
    expect(state.run).toMatchObject({ status: 'awaiting_review', reviewIteration: 0 })
    expect(state.outputs).toEqual([])
  })
})
