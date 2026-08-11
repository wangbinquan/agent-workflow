// RFC-280 T3 — read end for node_runs.startup_verification_json:
// services/execution/startupVerificationRead.getStartupVerification + the
// GET /api/tasks/:id/node-runs/:nodeRunId/startup-verification route.
// Locks: available:true round-trip through zod / available:false for NULL,
// corrupt JSON and schema-mismatch rows / 404 task / 404 node-run.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import type {
  StartupVerificationRecord,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import { getStartupVerification } from '../src/services/execution/startupVerificationRead'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function buildApp(): { db: DbClient; app: Hono } {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: '',
    opencodeVersion: '1.15.0',
    dbVersion: 1,
    db,
  })
  return { db, app }
}

const RECORD: StartupVerificationRecord = {
  declared: {
    mcpServers: ['rag-search'],
    skippedDisabledMcps: [],
    skills: [],
    subagents: [],
    plugins: [],
    tools: null,
    droppedParams: [],
    unsupported: [],
    unobservable: [],
  },
  observation: {
    state: 'verified',
    source: 'claude-init',
    mcpServers: [{ name: 'rag-search', status: 'failed' }],
  },
  verification: {
    observation: 'verified',
    mcpUnusable: [{ name: 'rag-search', status: 'failed' }],
    skillsMissing: [],
    subagentsMissing: [],
    toolsMissing: [],
    pluginsMissing: [],
  },
}

async function seed(
  db: DbClient,
  startupVerificationJson: string | null,
): Promise<{ taskId: string; nodeRunId: string }> {
  const taskId = `task_${ulid()}`
  const workflowId = `wf_${taskId}`
  const nodeId = 'n1'
  const def: WorkflowDefinition = {
    $schema_version: 3,
    inputs: [],
    nodes: [{ id: nodeId, kind: 'agent-single', agentName: 'coder' } as WorkflowNode],
    edges: [],
    outputs: [],
  }
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
    repoPath: '/tmp/test',
    worktreePath: '/tmp/test',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'done',
    inputs: '{}',
    startedAt: 1000,
  })
  const nodeRunId = ulid()
  await db.insert(nodeRuns).values({
    id: nodeRunId,
    taskId,
    nodeId,
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
    status: 'done',
    promptText: 'go',
    startedAt: 1000,
    startupVerificationJson,
  })
  return { taskId, nodeRunId }
}

describe('getStartupVerification (RFC-280 T3)', () => {
  beforeEach(() => resetBroadcastersForTests())
  afterEach(() => resetBroadcastersForTests())

  test('persisted record round-trips through zod as available:true', async () => {
    const { db } = buildApp()
    const { taskId, nodeRunId } = await seed(db, JSON.stringify(RECORD))
    const out = await getStartupVerification(db, taskId, nodeRunId)
    expect(out.available).toBe(true)
    if (out.available) {
      expect(out.record.verification.mcpUnusable).toEqual([
        { name: 'rag-search', status: 'failed' },
      ])
    }
  })

  test('NULL / corrupt / schema-mismatch rows all read as available:false', async () => {
    const { db } = buildApp()
    for (const stored of [null, '{not json', JSON.stringify({ wrong: 'shape' })]) {
      const { taskId, nodeRunId } = await seed(db, stored)
      expect(await getStartupVerification(db, taskId, nodeRunId)).toEqual({ available: false })
    }
  })

  test('unknown task / node-run → 404-shaped NotFoundError', async () => {
    const { db } = buildApp()
    const { taskId } = await seed(db, null)
    await expect(getStartupVerification(db, 'task_missing', 'nr')).rejects.toThrow(
      "task 'task_missing' not found",
    )
    await expect(getStartupVerification(db, taskId, 'nr_missing')).rejects.toThrow(
      'not found under task',
    )
  })

  test('route serves the record over HTTP with token auth', async () => {
    const { db, app } = buildApp()
    const { taskId, nodeRunId } = await seed(db, JSON.stringify(RECORD))
    const res = await app.request(
      `/api/tasks/${taskId}/node-runs/${nodeRunId}/startup-verification`,
      { headers: { Authorization: `Bearer ${TOKEN}` } },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { available: boolean }
    expect(body.available).toBe(true)
  })
})
