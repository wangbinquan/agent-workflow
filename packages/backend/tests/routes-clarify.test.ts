// RFC-023 PR-B T13 — integration tests for the four /api/clarify endpoints.
//
//   GET    /api/clarify                       — list + filter
//   GET    /api/clarify/pending-count         — left-nav badge
//   GET    /api/clarify/:nodeRunId            — session detail
//   POST   /api/clarify/:nodeRunId/answers    — submit answers + optimistic lock
//
// Hits the routes through createApp so the full token middleware + Hono
// routing layer runs, not just the service layer. Each route's failure mode
// (404 / 409 / 422) is locked here so the front-end can rely on stable codes.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import { clarifyRounds, nodeRuns, tasks, workflows } from '../src/db/schema'
import { createClarifyRound } from '../src/services/clarify/service'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type {
  ClarifyAnswer,
  ClarifySession,
  ClarifySessionSummary,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'

const TOKEN = 'a'.repeat(64)

const QUESTION = {
  id: 'qdb',
  title: 'Which database?',
  kind: 'single' as const,
  recommended: true,
  options: [
    { label: 'Postgres', description: '', recommended: false, recommendationReason: '' },
    { label: 'MySQL', description: '', recommended: false, recommendationReason: '' },
  ],
}

async function req(app: Hono, path: string, init?: RequestInit): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  })
}

async function seedSession(
  db: ProviderNeutralDatabase,
  opts: {
    taskId?: string
    sourceShardKey?: string | null
    iterationIndex?: number
  } = {},
  lineage?: typeof providerTaskLineage,
): Promise<{ taskId: string; intermediaryNodeRunId: string; sessionId: string }> {
  const taskId = opts.taskId ?? `task_${ulid()}`
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
  // Idempotently seed workflow + task rows for this clarify session.
  const workflowId = `wf_${taskId}`
  await db
    .insert(workflows)
    .values({
      id: workflowId,
      name: 'wf',
      description: '',
      definition: JSON.stringify(def),
      version: 1,
      schemaVersion: 3,
    })
    .onConflictDoNothing()
  await db
    .insert(tasks)
    .values({
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

      ...(lineage?.(taskId) ?? {}),
    })
    .onConflictDoNothing()
  const sourceRunId = ulid()
  await db.insert(nodeRuns).values({
    id: sourceRunId,
    taskId,
    nodeId: 'designer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    shardKey: opts.sourceShardKey ?? null,
  })
  const { round: session, intermediaryNodeRunId: clarifyNodeRunId } = await createClarifyRound({
    kind: 'self',
    db,
    taskId,
    askingNodeId: 'designer',
    askingNodeRunId: sourceRunId,
    askingShardKey: opts.sourceShardKey ?? null,
    intermediaryNodeId: 'c1',
    iteration: opts.iterationIndex ?? 0,
    questions: [QUESTION],
  })
  return { taskId, intermediaryNodeRunId: clarifyNodeRunId, sessionId: session.id }
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterEach(() => {
  resetBroadcastersForTests()
})

describe('GET /api/clarify', () => {
  registerProviderApplication((buildApp, seedSession) => {
    test('returns awaiting_human sessions by default and supports task filter', async () => {
      const { db, app } = await buildApp()
      const a = await seedSession(db)
      const b = await seedSession(db)
      const res = await req(app, '/api/clarify')
      expect(res.status).toBe(200)
      const body = (await res.json()) as ClarifySessionSummary[]
      expect(body.map((s) => s.taskId).sort()).toEqual([a.taskId, b.taskId].sort())

      const filtered = await req(app, `/api/clarify?taskId=${a.taskId}`)
      const filteredBody = (await filtered.json()) as ClarifySessionSummary[]
      expect(filteredBody.length).toBe(1)
      expect(filteredBody[0]?.taskId).toBe(a.taskId)
    })
  })

  registerProviderApplication((buildApp, seedSession) => {
    test('summary payload carries askingShardKey for agent-multi grouping', async () => {
      // RFC-058 T14: response shape switched to ClarifyRoundSummary —
      // legacy field `sourceShardKey` is now exposed as `askingShardKey`.
      const { db, app } = await buildApp()
      const taskId = `task_${ulid()}`
      await seedSession(db, { taskId, sourceShardKey: 'shard-A' })
      await seedSession(db, { taskId, sourceShardKey: 'shard-B' })
      const res = await req(app, `/api/clarify?taskId=${taskId}`)
      const body = (await res.json()) as Array<{ askingShardKey: string | null }>
      expect(body.length).toBe(2)
      const shardKeys = body.map((s) => s.askingShardKey).sort()
      expect(shardKeys).toEqual(['shard-A', 'shard-B'])
    })
  })
})

describe('GET /api/clarify/pending-count', () => {
  registerProviderApplication((buildApp, seedSession) => {
    test('returns the count of awaiting_human sessions', async () => {
      const { db, app } = await buildApp()
      await seedSession(db)
      await seedSession(db)
      const res = await req(app, '/api/clarify/pending-count')
      const body = (await res.json()) as { count: number }
      expect(body.count).toBe(2)
    })
  })
})

describe('GET /api/clarify/:nodeRunId', () => {
  registerProviderApplication((buildApp, seedSession) => {
    test('returns full session payload (questions + null answers + status)', async () => {
      const { db, app } = await buildApp()
      const { intermediaryNodeRunId: clarifyNodeRunId } = await seedSession(db)
      const res = await req(app, `/api/clarify/${clarifyNodeRunId}`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as ClarifySession
      expect(body.status).toBe('awaiting_human')
      expect(body.questions).toHaveLength(1)
      expect(body.answers).toBeUndefined()
    })
  })

  registerProviderApplication((buildApp) => {
    test('404 when nodeRunId is unknown', async () => {
      const { app } = await buildApp()
      const res = await req(app, '/api/clarify/no-such-id')
      expect(res.status).toBe(404)
    })
  })
})

describe('POST /api/clarify/:nodeRunId/answers', () => {
  // RFC-132 PR-B (universal deferred model): the quick channel now AUTO-DISPATCHES for EVERY task
  // (no legacy immediate mint). The response is the autodispatch shape ({ kind:'autodispatch',
  // roundKind, reruns }); the server-sealed labels + answered flip persist on the round.
  registerProviderApplication((buildApp, seedSession) => {
    test('valid submission seals labels, marks round answered, auto-dispatches a rerun', async () => {
      const { db, app } = await buildApp()
      const { intermediaryNodeRunId: clarifyNodeRunId } = await seedSession(db)
      const res = await req(app, `/api/clarify/${clarifyNodeRunId}/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          answers: [
            {
              questionId: 'qdb',
              selectedOptionIndices: [1],
              selectedOptionLabels: ['<<malicious>>'],
              customText: '',
            },
          ],
        }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        ok: boolean
        kind: string
        roundKind: string
        reruns: Array<{ nodeRunId: string }>
      }
      expect(body.ok).toBe(true)
      expect(body.kind).toBe('autodispatch')
      expect(body.roundKind).toBe('self')
      // the auto-dispatched self continuation rerun
      expect((body.reruns[0]?.nodeRunId ?? '').length).toBeGreaterThan(0)
      // server-sealed labels (client forgery defended) + answered flip persist on the round.
      const round = (
        await db
          .select()
          .from(clarifyRounds)
          .where(eq(clarifyRounds.intermediaryNodeRunId, clarifyNodeRunId))
          .limit(1)
      )[0]
      expect(round?.status).toBe('answered')
      const answers = JSON.parse(round?.answersJson ?? '[]') as ClarifyAnswer[]
      expect(answers[0]?.selectedOptionLabels).toEqual(['MySQL'])
    })
  })

  registerProviderApplication((buildApp, seedSession) => {
    test('If-Match header optimistic lock: mismatched iteration returns ConflictError (409)', async () => {
      const { db, app } = await buildApp()
      const { intermediaryNodeRunId: clarifyNodeRunId } = await seedSession(db)
      const res = await req(app, `/api/clarify/${clarifyNodeRunId}/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'If-Match': '99' },
        body: JSON.stringify({
          answers: [
            {
              questionId: 'qdb',
              selectedOptionIndices: [0],
              selectedOptionLabels: [],
              customText: '',
            },
          ],
        }),
      })
      expect(res.status).toBe(409)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe('clarify-iteration-mismatch')
    })
  })

  registerProviderApplication((buildApp, seedSession) => {
    test('schema-invalid payload returns 422 with clarify-answers-invalid', async () => {
      const { db, app } = await buildApp()
      const { intermediaryNodeRunId: clarifyNodeRunId } = await seedSession(db)
      const res = await req(app, `/api/clarify/${clarifyNodeRunId}/answers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers: 'not-an-array' }),
      })
      expect(res.status).toBe(422)
      const body = (await res.json()) as { code: string }
      expect(body.code).toBe('clarify-answers-invalid')
    })
  })

  // RFC-023 directive iteration — the POST body now carries an optional
  // `directive` field. Bodies that omit it must still parse (back-compat
  // with deployed clients) and default to 'continue'; 'stop' must round-trip
  // into the session row so a later prompt assembly can act on it. Locks the
  // wire format that the frontend two-button footer relies on.
  describe('POST /answers — directive iteration', () => {
    registerProviderApplication((buildApp, seedSession) => {
      test('omitted directive defaults to "continue" on the persisted session', async () => {
        const { db, app } = await buildApp()
        const { intermediaryNodeRunId: clarifyNodeRunId } = await seedSession(db)
        const res = await req(app, `/api/clarify/${clarifyNodeRunId}/answers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            answers: [
              {
                questionId: 'qdb',
                selectedOptionIndices: [0],
                selectedOptionLabels: [],
                customText: '',
              },
            ],
          }),
        })
        expect(res.status).toBe(200)
        // RFC-132 PR-B: directive persists on the round via the seal (autodispatch path).
        const round = (
          await db
            .select()
            .from(clarifyRounds)
            .where(eq(clarifyRounds.intermediaryNodeRunId, clarifyNodeRunId))
            .limit(1)
        )[0]
        expect(round?.directive).toBe('continue')
      })
    })

    registerProviderApplication((buildApp, seedSession) => {
      test('explicit directive="stop" round-trips to the session row', async () => {
        const { db, app } = await buildApp()
        const { intermediaryNodeRunId: clarifyNodeRunId } = await seedSession(db)
        const res = await req(app, `/api/clarify/${clarifyNodeRunId}/answers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            directive: 'stop',
            answers: [
              {
                questionId: 'qdb',
                selectedOptionIndices: [0],
                selectedOptionLabels: [],
                customText: '',
              },
            ],
          }),
        })
        expect(res.status).toBe(200)
        // RFC-132 PR-B: 'stop' round-trips onto the round via the seal (autodispatch path).
        const round = (
          await db
            .select()
            .from(clarifyRounds)
            .where(eq(clarifyRounds.intermediaryNodeRunId, clarifyNodeRunId))
            .limit(1)
        )[0]
        expect(round?.directive).toBe('stop')
      })
    })

    registerProviderApplication((buildApp, seedSession) => {
      test('unknown directive value returns 422 (schema enum guard)', async () => {
        const { db, app } = await buildApp()
        const { intermediaryNodeRunId: clarifyNodeRunId } = await seedSession(db)
        const res = await req(app, `/api/clarify/${clarifyNodeRunId}/answers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            directive: 'maybe',
            answers: [
              {
                questionId: 'qdb',
                selectedOptionIndices: [0],
                selectedOptionLabels: [],
                customText: '',
              },
            ],
          }),
        })
        expect(res.status).toBe(422)
        const body = (await res.json()) as { code: string }
        expect(body.code).toBe('clarify-answers-invalid')
      })
    })
  })
})

// RFC-359 W50: keep native registrations while the selected calls use the complete provider application.
// RFC-359 AC-6：生命周期走共用的 `describeEachProviderHttpApplication`（`tests/helpers/`），
// 这里只剩「把本文件的 seed 夹具绑上去」这一点文件私有的东西。
function registerProviderApplication(
  register: (
    buildApp: () => Promise<{ db: ProviderNeutralDatabase; app: Hono }>,
    seedSessionFixture: typeof seedSession,
  ) => void,
): void {
  describeEachProviderHttpApplication(
    'provider',
    {
      token: TOKEN,
      opencodeVersion: '1.14.25',
      dbVersion: 1,
      tempPrefix: 'rfc359-w50-routes-clarify-',
    },
    (scope) =>
      register(
        async () => ({ db: scope.harness.db, app: (await scope.open()).app }),
        (db, opts) => seedSession(db, opts, providerTaskLineage),
      ),
  )
}

function providerTaskLineage(id: string) {
  return {
    executionLineageId: id,
    lineageSlotPathJson: JSON.stringify([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: id, workflowRevision: null },
    ]),
  }
}
