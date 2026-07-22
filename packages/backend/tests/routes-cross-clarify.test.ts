// RFC-056 PR-B T7 — integration tests for the cross-clarify side of /api/clarify.
//
// Mixed routes (existing /api/clarify endpoints, augmented):
//   GET    /api/clarify                    list mixes self + cross with kind chip.
//   GET    /api/clarify/:nodeRunId         branches by node kind; returns
//                                          { kind: 'cross', session: {...} } for
//                                          cross-clarify node_runs.
//   POST   /api/clarify/:nodeRunId/answers branches: accepts directive 'continue'
//                                          or 'stop' for cross-clarify nodes.
//
// LOCKS:
//   1. List returns both self + cross summaries with `kind` chip.
//   2. Detail returns cross-clarify session shape when nodeRunId belongs to a
//      cross-clarify node.
//   3. POST + directive='continue' answers a cross-clarify session.
//   4. POST + directive='stop' marks the session 'answered'+'stop' and the
//      response surfaces 'questioner-stop-triggered'.
//   5. If-Match mismatch returns 409 cross-clarify-iteration-mismatch.
//   6. POST fails for cross-clarify with non-admin / non-target actor (auth gate).

import { createClarifyRound } from '../src/services/clarify/service'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, nodeRuns, tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const Q1: ClarifyQuestion = {
  id: 'q1',
  title: 'Why Redis?',
  kind: 'single',
  recommended: false,
  options: [
    { label: 'Cluster reuse', description: '', recommended: false, recommendationReason: '' },
    { label: 'Simplicity', description: '', recommended: false, recommendationReason: '' },
  ],
}

function buildApp(): { db: DbClient; app: Hono } {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: '',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  return { db, app }
}

async function req(app: Hono, path: string, init?: RequestInit): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  })
}

function defaultDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
      { id: 'cross1', kind: 'clarify-cross-agent' },
    ],
    edges: [
      {
        id: 'e_q_cc',
        source: { nodeId: 'questioner', portName: '__clarify__' },
        target: { nodeId: 'cross1', portName: 'questions' },
      },
      {
        id: 'e_cc_d',
        source: { nodeId: 'cross1', portName: 'to_designer' },
        target: { nodeId: 'designer', portName: '__external_feedback__' },
      },
    ],
    outputs: [],
  }
}

async function seedTask(db: DbClient, opts: { taskId?: string } = {}): Promise<{ taskId: string }> {
  const taskId = opts.taskId ?? `task_${ulid()}`
  const def = defaultDef()
  const workflowId = `wf_${taskId}`
  await db
    .insert(workflows)
    .values({
      id: workflowId,
      name: 'wf',
      description: '',
      definition: JSON.stringify(def),
      version: 1,
      schemaVersion: 4,
    })
    .onConflictDoNothing()
  await db
    .insert(tasks)
    .values({
      id: taskId,
      name: 'fixture-task',
      workflowId,
      workflowSnapshot: JSON.stringify(def),
      repoPath: '/tmp/aw-rfc056-routes-test',
      worktreePath: '',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'awaiting_human',
      inputs: '{}',
      startedAt: Date.now(),
    })
    .onConflictDoNothing()
  return { taskId }
}

async function seedCrossClarifySession(
  db: DbClient,
  opts: { taskId?: string } = {},
): Promise<{ taskId: string; intermediaryNodeRunId: string; sessionId: string }> {
  const { taskId } = await seedTask(db, opts.taskId ? { taskId: opts.taskId } : {})
  const questionerRunId = ulid()
  // Seed prior designer + questioner node_runs so the answer's auto-dispatch has
  // runs to inherit when the test submits with directive='continue'.
  await db.insert(nodeRuns).values({
    id: questionerRunId,
    taskId,
    nodeId: 'questioner',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
  })
  await db.insert(nodeRuns).values({
    id: ulid(),
    taskId,
    nodeId: 'designer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
  })
  const { round: session, intermediaryNodeRunId: crossClarifyNodeRunId } = await createClarifyRound(
    {
      kind: 'cross',
      db,
      taskId,
      intermediaryNodeId: 'cross1',
      askingNodeId: 'questioner',
      askingNodeRunId: questionerRunId,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      questions: [Q1],
    },
  )
  return { taskId, intermediaryNodeRunId: crossClarifyNodeRunId, sessionId: session.id }
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterEach(() => {
  resetBroadcastersForTests()
})

describe('GET /api/clarify — mixed self + cross with kind chip', () => {
  test('list mixes self-clarify and cross-clarify sessions and tags each with kind', async () => {
    const { db, app } = buildApp()
    // Self-clarify session
    const taskA = `task_${ulid()}`
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [],
      nodes: [
        { id: 'designer', kind: 'agent-single', agentName: 'designer' },
        { id: 'c1', kind: 'clarify', title: 'self-clarify' },
      ],
      edges: [],
      outputs: [],
    }
    await db.insert(workflows).values({
      id: `wf_${taskA}`,
      name: 'wf',
      description: '',
      definition: JSON.stringify(def),
      version: 1,
      schemaVersion: 3,
    })
    await db.insert(tasks).values({
      id: taskA,
      name: 't',
      workflowId: `wf_${taskA}`,
      workflowSnapshot: JSON.stringify(def),
      repoPath: '/tmp',
      worktreePath: '',
      baseBranch: 'main',
      branch: `agent-workflow/${taskA}`,
      status: 'awaiting_human',
      inputs: '{}',
      startedAt: Date.now() - 100, // earlier
    })
    const sourceRunId = ulid()
    await db.insert(nodeRuns).values({
      id: sourceRunId,
      taskId: taskA,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await createClarifyRound({
      kind: 'self',
      db,
      taskId: taskA,
      askingNodeId: 'designer',
      askingNodeRunId: sourceRunId,
      askingShardKey: null,
      intermediaryNodeId: 'c1',
      iteration: 0,
      questions: [Q1],
    })

    await seedCrossClarifySession(db)

    const res = await req(app, '/api/clarify')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ kind: 'self' | 'cross' }>
    const kinds = new Set(body.map((b) => b.kind))
    expect(kinds.has('self')).toBe(true)
    expect(kinds.has('cross')).toBe(true)
  })
})

describe('GET /api/clarify/:nodeRunId — branches by node kind', () => {
  test('returns ClarifyRound (with kind="cross" + intermediaryNodeId) for cross-clarify node_run', async () => {
    // RFC-058 T14: detail endpoint now emits a single ClarifyRound shape;
    // cross-clarify rows surface as `kind: 'cross'` + `intermediaryNodeId`
    // (formerly `crossClarifyNodeId`).
    const { db, app } = buildApp()
    const { intermediaryNodeRunId: crossClarifyNodeRunId } = await seedCrossClarifySession(db)

    const res = await req(app, `/api/clarify/${crossClarifyNodeRunId}`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      kind: 'self' | 'cross'
      status: string
      questions: unknown[]
      intermediaryNodeId: string
    }
    expect(body.kind).toBe('cross')
    expect(body.status).toBe('awaiting_human')
    expect(body.questions.length).toBe(1)
    expect(body.intermediaryNodeId).toBe('cross1')
  })
})

describe('POST /api/clarify/:nodeRunId/answers — cross-clarify directive branch', () => {
  // RFC-132 PR-B (universal deferred model): the quick channel AUTO-DISPATCHES for EVERY task via
  // autoDispatchClarifyRound. RFC-162 (designer-by-default deleted): a cross round produces ONE
  // questioner entry, and the quick channel auto-dispatches self/questioner ONLY (designers are
  // never auto-dispatched). So a 'continue' answer reruns the QUESTIONER
  // (cross-clarify-questioner-rerun) and mints NO designer — "let the upstream revise" is now an
  // explicit board reassign, not an implicit designer-scope. The response is the autodispatch shape.
  test('directive=continue auto-dispatches the questioner rerun (no designer)', async () => {
    const { db, app } = buildApp()
    const { taskId, intermediaryNodeRunId: crossClarifyNodeRunId } =
      await seedCrossClarifySession(db)
    const res = await req(app, `/api/clarify/${crossClarifyNodeRunId}/answers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answers: [
          {
            questionId: 'q1',
            selectedOptionIndices: [0],
            selectedOptionLabels: [],
            customText: '',
          },
        ],
        directive: 'continue',
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; kind: string; roundKind: string }
    expect(body.kind).toBe('autodispatch')
    expect(body.roundKind).toBe('cross')
    const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    // The asker (questioner) re-runs; RFC-162 creates no designer entry → no designer rerun.
    expect(
      runs.some(
        (r) => r.nodeId === 'questioner' && r.rerunCause === 'cross-clarify-questioner-rerun',
      ),
    ).toBe(true)
    expect(
      runs.some((r) => r.nodeId === 'designer' && r.rerunCause === 'cross-clarify-answer'),
    ).toBe(false)
  })

  test('directive=stop auto-dispatches the questioner stop rerun (no designer)', async () => {
    const { db, app } = buildApp()
    const { taskId, intermediaryNodeRunId: crossClarifyNodeRunId } =
      await seedCrossClarifySession(db)
    const res = await req(app, `/api/clarify/${crossClarifyNodeRunId}/answers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        answers: [
          {
            questionId: 'q1',
            selectedOptionIndices: [0],
            selectedOptionLabels: [],
            customText: '',
          },
        ],
        directive: 'stop',
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { kind: string; roundKind: string }
    expect(body.kind).toBe('autodispatch')
    expect(body.roundKind).toBe('cross')
    const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    // stop → the questioner re-runs (with the STOP anchor); NO designer rerun.
    expect(
      runs.some(
        (r) => r.nodeId === 'questioner' && r.rerunCause === 'cross-clarify-questioner-rerun',
      ),
    ).toBe(true)
    expect(
      runs.some((r) => r.nodeId === 'designer' && r.rerunCause === 'cross-clarify-answer'),
    ).toBe(false)
    // 'stop' persists onto the round.
    const round = (
      await db
        .select()
        .from(clarifyRounds)
        .where(eq(clarifyRounds.intermediaryNodeRunId, crossClarifyNodeRunId))
        .limit(1)
    )[0]
    expect(round?.directive).toBe('stop')
  })

  // RFC-132 PR-B: the unified quick channel honors If-Match via autoDispatchClarifyRound, which throws
  // the shared 'clarify-iteration-mismatch' (not the cross-specific code) — the single path.
  test('If-Match header mismatch → 409 clarify-iteration-mismatch', async () => {
    const { db, app } = buildApp()
    const { intermediaryNodeRunId: crossClarifyNodeRunId } = await seedCrossClarifySession(db)
    const res = await req(app, `/api/clarify/${crossClarifyNodeRunId}/answers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'If-Match': '99' },
      body: JSON.stringify({
        answers: [
          {
            questionId: 'q1',
            selectedOptionIndices: [0],
            selectedOptionLabels: [],
            customText: '',
          },
        ],
        directive: 'continue',
      }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('clarify-iteration-mismatch')
  })
})

// RFC-162: retired — per-question `questionScopes` deleted (cross unified with self). The clarify
// submit schema no longer accepts `questionScopes` (extra keys are stripped, not an error), the
// detail response no longer surfaces `questionScopes`, and there is no more
// `cross-clarify-question-scopes-malformed` 422. The surviving directive coverage (a 'continue'
// cross answer reruns the questioner, no designer) lives in the directive-branch block above.
