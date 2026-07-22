// RFC-053 PR-D — invariant C1 (clarify_session ↔ clarify node_run).
//
// Closed clarify_session (status ∈ {answered, canceled}) ⟹ its
// clarify_node_run is NOT stuck in awaiting_human. The bug shape is:
// user submitted answers (session.status='answered') but the clarify
// node_run was never promoted out of awaiting_human, leaving the task
// permanently parked.

import { afterEach, describe, expect, test } from 'bun:test'
import { insertLegacySelfClarify } from './clarify-fixtures'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { runLifecycleInvariants } from '../src/services/lifecycleInvariants'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  taskId: string
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc053-prd-clarify-'))
  mkdirSync(tmp, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const def: WorkflowDefinition = {
    $schema_version: 3,
    inputs: [],
    nodes: [{ id: 'clr_1', kind: 'clarify' } as WorkflowNode],
    edges: [],
  }
  const workflowId = ulid()
  await db.insert(workflows).values({ id: workflowId, name: 'w', definition: JSON.stringify(def) })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: tmp,
    worktreePath: tmp,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    // 'running' so T1/T2/T3 don't trigger.
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return { db, taskId, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

async function insertClarifyRun(
  db: DbClient,
  taskId: string,
  status: 'awaiting_human' | 'running' | 'done' | 'canceled',
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: 'clr_1',
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
    status,
    startedAt: Date.now() - 100,
    finishedAt: status === 'done' || status === 'canceled' ? Date.now() : null,
  })
  return id
}

async function insertClarifySession(
  db: DbClient,
  taskId: string,
  opts: {
    clarifyNodeRunId: string
    status: 'awaiting_human' | 'answered' | 'canceled'
  },
): Promise<string> {
  const id = ulid()
  await insertLegacySelfClarify(db, {
    id,
    taskId,
    sourceAgentNodeId: 'src',
    sourceAgentNodeRunId: ulid(),
    sourceShardKey: null,
    clarifyNodeId: 'clr_1',
    clarifyNodeRunId: opts.clarifyNodeRunId,
    iterationIndex: 0,
    questionsJson: '[]',
    answersJson: opts.status === 'awaiting_human' ? null : '[]',
    status: opts.status,
    answeredAt: opts.status === 'awaiting_human' ? null : Date.now(),
  })
  return id
}

describe('RFC-053 PR-D — C1 (closed clarify_session ⟹ clarify node_run not awaiting_human)', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('satisfied: answered session + done clarify run → no C1 alert', async () => {
    h = await buildHarness()
    const run = await insertClarifyRun(h.db, h.taskId, 'done')
    await insertClarifySession(h.db, h.taskId, { clarifyNodeRunId: run, status: 'answered' })
    const result = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    expect(result.openAlerts.filter((a) => a.rule === 'C1')).toHaveLength(0)
  })

  test('satisfied: answered session + running clarify run → no C1 alert', async () => {
    h = await buildHarness()
    const run = await insertClarifyRun(h.db, h.taskId, 'running')
    await insertClarifySession(h.db, h.taskId, { clarifyNodeRunId: run, status: 'answered' })
    const result = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    expect(result.openAlerts.filter((a) => a.rule === 'C1')).toHaveLength(0)
  })

  test('open session is allowed: awaiting_human session + awaiting_human run → no C1 alert', async () => {
    h = await buildHarness()
    const run = await insertClarifyRun(h.db, h.taskId, 'awaiting_human')
    await insertClarifySession(h.db, h.taskId, {
      clarifyNodeRunId: run,
      status: 'awaiting_human',
    })
    const result = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    // C1 only fires on closed sessions; an open one is fine.
    expect(result.openAlerts.filter((a) => a.rule === 'C1')).toHaveLength(0)
  })

  test('violated: answered session but clarify run still awaiting_human → C1 alert', async () => {
    h = await buildHarness()
    const run = await insertClarifyRun(h.db, h.taskId, 'awaiting_human')
    const session = await insertClarifySession(h.db, h.taskId, {
      clarifyNodeRunId: run,
      status: 'answered',
    })
    const result = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    const c1 = result.openAlerts.filter((a) => a.rule === 'C1')
    expect(c1).toHaveLength(1)
    expect(c1[0]!.detail).toMatchObject({
      clarifySessionId: session,
      clarifySessionStatus: 'answered',
      clarifyNodeRunId: run,
      actualStatus: 'awaiting_human',
    })
  })

  test('violated: canceled session but clarify run still awaiting_human → C1 alert', async () => {
    h = await buildHarness()
    const run = await insertClarifyRun(h.db, h.taskId, 'awaiting_human')
    await insertClarifySession(h.db, h.taskId, {
      clarifyNodeRunId: run,
      status: 'canceled',
    })
    const result = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    expect(result.openAlerts.filter((a) => a.rule === 'C1')).toHaveLength(1)
  })

  test('resolution: promoting the run to done flips the C1 row', async () => {
    h = await buildHarness()
    const run = await insertClarifyRun(h.db, h.taskId, 'awaiting_human')
    await insertClarifySession(h.db, h.taskId, { clarifyNodeRunId: run, status: 'answered' })
    const r1 = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    expect(r1.newAlerts).toBe(1)
    await h.db
      .update(nodeRuns)
      .set({ status: 'done', finishedAt: Date.now() })
      .where(eq(nodeRuns.id, run))
    const r2 = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    expect(r2.resolvedAlerts).toBe(1)
    expect(r2.openAlerts.filter((a) => a.rule === 'C1')).toHaveLength(0)
  })
})
