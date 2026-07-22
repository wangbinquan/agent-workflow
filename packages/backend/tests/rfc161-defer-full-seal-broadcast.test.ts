// RFC-161 — the defer control channel (centralized answer pane) seals a clarify
// round WITHOUT the quick channel's emitAutoAnswered WS event. On a FULL seal the
// intermediary clarify node_run flips awaiting_human → done, so the route emits a
// `node.status` event → open task canvases refresh node-runs (the clarifyNavKind
// click target) via useTaskSync. A PARTIAL seal keeps the round awaiting_human →
// no event (canvas nav stays 'awaiting').

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import { ulid } from 'ulid'
import type { ClarifyQuestion, TaskWsMessage } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { createSession } from '../src/auth/sessionStore'
import { createUser } from '../src/services/users'
import { createClarifyRound } from '../src/services/clarify/service'
import { resetBroadcastersForTests, TASK_CHANNEL, taskBroadcaster } from '../src/ws/broadcaster'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const SELF_DEF = {
  $schema_version: 3,
  inputs: [],
  nodes: [
    { id: 'designer', kind: 'agent-single', agentName: 'designer' },
    { id: 'c1', kind: 'clarify', title: 'Clarify' },
  ],
  edges: [],
  outputs: [],
}

function makeQ(id: string): ClarifyQuestion {
  return {
    id,
    title: `q-${id}`,
    kind: 'single',
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

const makeAns = (qid: string) => ({
  questionId: qid,
  selectedOptionIndices: [0],
  selectedOptionLabels: [],
  customText: '',
})

interface Harness {
  db: DbClient
  app: Hono
  alice: { id: string; token: string }
}

async function buildHarness(): Promise<Harness> {
  process.env.AGENT_WORKFLOW_HOME = mkdtempSync(join(tmpdir(), 'aw-rfc161-'))
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const u = await createUser(db, {
    username: 'alice',
    displayName: 'alice',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const { token } = await createSession({ db, userId: u.id })
  return { db, app, alice: { id: u.id, token } }
}

async function req(app: Hono, token: string, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function seedSelfRound(
  db: DbClient,
  ownerUserId: string,
  questions: ClarifyQuestion[],
): Promise<{ taskId: string; nodeRunId: string }> {
  const taskId = `task_${ulid()}`
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(SELF_DEF),
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture',
    ownerUserId,
    workflowId,
    workflowSnapshot: JSON.stringify(SELF_DEF),
    repoPath: '/tmp/aw-rfc161',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'awaiting_human',
    inputs: '{}',
    startedAt: Date.now(),
  })
  const sourceRunId = ulid()
  await db.insert(nodeRuns).values({
    id: sourceRunId,
    taskId,
    nodeId: 'designer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    preSnapshot: '',
  })
  const { intermediaryNodeRunId: clarifyNodeRunId } = await createClarifyRound({
    kind: 'self',
    db,
    taskId,
    askingNodeId: 'designer',
    askingNodeRunId: sourceRunId,
    askingShardKey: null,
    intermediaryNodeId: 'c1',
    iteration: 0,
    questions,
  })
  return { taskId, nodeRunId: clarifyNodeRunId }
}

function captureTaskEvents(taskId: string): { events: TaskWsMessage[]; stop: () => void } {
  const events: TaskWsMessage[] = []
  const stop = taskBroadcaster.subscribe(TASK_CHANNEL(taskId), (m) => events.push(m))
  return { events, stop }
}

describe('RFC-161 defer full-seal node.status broadcast', () => {
  let h: Harness
  beforeEach(async () => {
    resetBroadcastersForTests()
    h = await buildHarness()
  })
  afterEach(() => resetBroadcastersForTests())

  test('defer=true FULL seal → node.status(done) for the intermediary run', async () => {
    const { taskId, nodeRunId } = await seedSelfRound(h.db, h.alice.id, [makeQ('q1')])
    const cap = captureTaskEvents(taskId)
    const res = await req(h.app, h.alice.token, `/api/clarify/${nodeRunId}/answers`, {
      answers: [makeAns('q1')],
      defer: true,
    })
    cap.stop()
    expect(res.status).toBe(200)
    const nodeStatus = cap.events.filter(
      (e) => e.type === 'node.status' && e.nodeRunId === nodeRunId,
    )
    expect(nodeStatus.length).toBeGreaterThanOrEqual(1)
    expect((nodeStatus[0] as { status?: string }).status).toBe('done')
  })

  test('defer=true PARTIAL seal → NO node.status (round stays awaiting_human)', async () => {
    const { taskId, nodeRunId } = await seedSelfRound(h.db, h.alice.id, [makeQ('q1'), makeQ('q2')])
    const cap = captureTaskEvents(taskId)
    // Seal only q1 (questionIds cap) → round is not fully sealed.
    const res = await req(h.app, h.alice.token, `/api/clarify/${nodeRunId}/answers`, {
      answers: [makeAns('q1')],
      questionIds: ['q1'],
      defer: true,
    })
    cap.stop()
    expect(res.status).toBe(200)
    const nodeStatus = cap.events.filter(
      (e) => e.type === 'node.status' && e.nodeRunId === nodeRunId,
    )
    expect(nodeStatus.length).toBe(0)
  })
})
