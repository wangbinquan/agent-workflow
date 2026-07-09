import { rimrafDir } from './helpers/cleanup'
// RFC-053 PR-A T1c — double-layer / cross-table invariant demonstrations.
//
// Each invariant is implemented here as a small async function. Tests
// construct DB shapes that satisfy or violate each rule and assert the
// utility's output. PR-D will move these checks into a real
// `services/lifecycleInvariants.ts`; this file becomes either the
// reference behavior or migrates over to call the service.
//
// Rules (per design/RFC-053-…/design.md §P-3):
//   R1  doc_version.decision='approved' ⟹ node_run.status='done'
//   R2  review node_run.status='done'   ⟹ some doc_version.decision='approved'
//   C1  clarify_sessions.status='answered'+ ⟹ clarify node_run.status ∈ {done, running}
//   T1  tasks.status='awaiting_review' ⟹ ∃ review node_run.status='awaiting_review'
//   T2  tasks.status='awaiting_human'  ⟹ ∃ node_run.status='awaiting_human'
//   T3  tasks.status='done'            ⟹ all output node_runs.status='done'
//   U1  per (task, nodeId, iteration), ≤ 1 row in {awaiting_review, awaiting_human}

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { clarifySessions, docVersions, nodeRuns, tasks, workflows } from '../src/db/schema'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// ---------------------------------------------------------------------------
// Invariant checker (PR-A inline; PR-D will extract to services/).
// ---------------------------------------------------------------------------

type Rule = 'R1' | 'R2' | 'C1' | 'T1' | 'T2' | 'T3' | 'U1'
interface Violation {
  rule: Rule
  detail: string
}

async function checkInvariants(db: DbClient, taskId: string): Promise<Violation[]> {
  const v: Violation[] = []
  const taskRow = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]
  if (taskRow === undefined) return v

  const def = JSON.parse(taskRow.workflowSnapshot) as {
    nodes?: Array<{ id?: string; kind?: string }>
  }
  const kindOf = new Map<string, string>()
  for (const n of def.nodes ?? []) {
    if (typeof n.id === 'string' && typeof n.kind === 'string') kindOf.set(n.id, n.kind)
  }
  const allRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  const allDocs = await db.select().from(docVersions).where(eq(docVersions.taskId, taskId))
  const allSessions = await db
    .select()
    .from(clarifySessions)
    .where(eq(clarifySessions.taskId, taskId))

  // R1: approved doc_versions ⟹ review node_run done
  for (const dv of allDocs) {
    if (dv.decision !== 'approved') continue
    const run = allRuns.find((r) => r.id === dv.reviewNodeRunId)
    if (run === undefined) {
      v.push({ rule: 'R1', detail: `approved doc_version ${dv.id} has no node_run` })
      continue
    }
    if (run.status !== 'done') {
      v.push({
        rule: 'R1',
        detail: `approved doc_version ${dv.id} → node_run ${run.id} status='${run.status}' (expected 'done')`,
      })
    }
  }

  // R2: review node_run done ⟹ has approved doc_version
  for (const r of allRuns) {
    if (kindOf.get(r.nodeId) !== 'review') continue
    if (r.parentNodeRunId !== null) continue
    if (r.status !== 'done') continue
    const has = allDocs.some((dv) => dv.reviewNodeRunId === r.id && dv.decision === 'approved')
    if (!has) {
      v.push({
        rule: 'R2',
        detail: `review node_run ${r.id} is done but has no approved doc_version`,
      })
    }
  }

  // C1: answered+ clarify_sessions ⟹ clarify node_run done/running
  const RESOLVED_SESSION = new Set(['answered', 'timed_out', 'canceled', 'closed'])
  for (const s of allSessions) {
    if (!RESOLVED_SESSION.has(s.status)) continue
    const run = allRuns.find((r) => r.id === s.clarifyNodeRunId)
    if (run === undefined) {
      v.push({ rule: 'C1', detail: `resolved clarify_session ${s.id} has no clarify node_run` })
      continue
    }
    if (run.status !== 'done' && run.status !== 'running') {
      v.push({
        rule: 'C1',
        detail: `clarify_session ${s.id} status='${s.status}' but clarify node_run ${run.id} status='${run.status}'`,
      })
    }
  }

  // T1: task awaiting_review ⟹ ∃ review node_run awaiting_review
  if (taskRow.status === 'awaiting_review') {
    const has = allRuns.some(
      (r) => kindOf.get(r.nodeId) === 'review' && r.status === 'awaiting_review',
    )
    if (!has) {
      v.push({
        rule: 'T1',
        detail: `task ${taskId} status='awaiting_review' but no review node_run is awaiting_review`,
      })
    }
  }

  // T2: task awaiting_human ⟹ ∃ node_run awaiting_human
  if (taskRow.status === 'awaiting_human') {
    const has = allRuns.some((r) => r.status === 'awaiting_human')
    if (!has) {
      v.push({
        rule: 'T2',
        detail: `task ${taskId} status='awaiting_human' but no node_run is awaiting_human`,
      })
    }
  }

  // T3: task done ⟹ all output node_runs done (or none — outputs may be skipped)
  if (taskRow.status === 'done') {
    for (const r of allRuns) {
      if (kindOf.get(r.nodeId) !== 'output') continue
      if (r.parentNodeRunId !== null) continue
      if (r.status !== 'done') {
        v.push({
          rule: 'T3',
          detail: `task done but output node_run ${r.id} status='${r.status}'`,
        })
      }
    }
  }

  // U1: per (task, nodeId, iteration) ≤ 1 row in {awaiting_review, awaiting_human}
  const u1Groups = new Map<string, number>()
  for (const r of allRuns) {
    if (r.parentNodeRunId !== null) continue
    if (r.status !== 'awaiting_review' && r.status !== 'awaiting_human') continue
    const key = `${r.nodeId}::${r.iteration}`
    u1Groups.set(key, (u1Groups.get(key) ?? 0) + 1)
  }
  for (const [key, count] of u1Groups) {
    if (count > 1) {
      v.push({ rule: 'U1', detail: `(nodeId,iteration)=${key} has ${count} active rows` })
    }
  }

  return v
}

// ---------------------------------------------------------------------------
// Harness: minimal workflow with one agent, two reviews, one output.
// ---------------------------------------------------------------------------

interface Harness {
  db: DbClient
  taskId: string
  cleanup: () => void
}

async function buildHarness(
  taskStatus:
    | 'pending'
    | 'running'
    | 'awaiting_review'
    | 'awaiting_human'
    | 'done'
    | 'failed'
    | 'canceled'
    | 'interrupted',
): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc053-t1c-'))
  mkdirSync(tmp, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)

  const definition: WorkflowDefinition = {
    $schema_version: 2,
    inputs: [],
    nodes: [
      { id: 'doc', kind: 'agent-single', agentName: 'doc', promptTemplate: '' } as WorkflowNode,
      { id: 'clarify_x', kind: 'clarify' } as WorkflowNode,
      {
        id: 'rev_1',
        kind: 'review',
        inputSource: { nodeId: 'doc', portName: 'docpath' },
      } as unknown as WorkflowNode,
      {
        id: 'rev_2',
        kind: 'review',
        inputSource: { nodeId: 'doc', portName: 'sidecar' },
      } as unknown as WorkflowNode,
      { id: 'out_1', kind: 'output' } as WorkflowNode,
    ],
    edges: [],
  }
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'w',
    definition: JSON.stringify(definition),
  })
  const taskId = ulid()
  await db.insert(tasks).values({
    name: 't',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: tmp,
    worktreePath: tmp,
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    status: taskStatus,
    inputs: '{}',
    startedAt: Date.now(),
  })
  return {
    db,
    taskId,
    cleanup: () => rimrafDir(tmp),
  }
}

async function insertNodeRun(
  db: DbClient,
  taskId: string,
  opts: {
    nodeId: string
    status:
      | 'pending'
      | 'running'
      | 'awaiting_review'
      | 'awaiting_human'
      | 'done'
      | 'failed'
      | 'canceled'
      | 'interrupted'
    retryIndex?: number
    iteration?: number
    parentNodeRunId?: string | null
    reviewIteration?: number
    clarifyIteration?: number
    finishedAt?: number | null
  },
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: opts.nodeId,
    iteration: opts.iteration ?? 0,
    retryIndex: opts.retryIndex ?? 0,
    reviewIteration: opts.reviewIteration ?? 0,
    parentNodeRunId: opts.parentNodeRunId ?? null,
    status: opts.status,
    startedAt: Date.now() - 100,
    finishedAt: opts.finishedAt ?? null,
  })
  return id
}

async function insertDocVersion(
  db: DbClient,
  taskId: string,
  opts: {
    reviewNodeId: string
    reviewNodeRunId: string
    decision: 'pending' | 'approved' | 'rejected' | 'iterated'
    versionIndex: number
    reviewIteration?: number
  },
): Promise<string> {
  const id = ulid()
  await db.insert(docVersions).values({
    id,
    taskId,
    reviewNodeId: opts.reviewNodeId,
    reviewNodeRunId: opts.reviewNodeRunId,
    sourceNodeId: 'doc',
    sourcePortName: 'docpath',
    versionIndex: opts.versionIndex,
    reviewIteration: opts.reviewIteration ?? 0,
    bodyPath: `doc_versions/v${opts.versionIndex}.md`,
    decision: opts.decision,
    decidedAt: opts.decision === 'pending' ? null : Date.now(),
  })
  return id
}

describe('RFC-053 PR-A T1c — double-layer invariants', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('I1 satisfied — task done, all consistent', async () => {
    h = await buildHarness('done')
    const r1Run = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'done',
      finishedAt: Date.now(),
    })
    await insertDocVersion(h.db, h.taskId, {
      reviewNodeId: 'rev_1',
      reviewNodeRunId: r1Run,
      decision: 'approved',
      versionIndex: 1,
    })
    await insertNodeRun(h.db, h.taskId, {
      nodeId: 'out_1',
      status: 'done',
      finishedAt: Date.now(),
    })

    const v = await checkInvariants(h.db, h.taskId)
    expect(v).toEqual([])
  })

  test('I2 R1 violated — approved doc_version but review run not done (RFC-052 shape)', async () => {
    h = await buildHarness('awaiting_review')
    const r1Run = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'awaiting_review', // ← bug shape
    })
    await insertDocVersion(h.db, h.taskId, {
      reviewNodeId: 'rev_1',
      reviewNodeRunId: r1Run,
      decision: 'approved', // ← approved already
      versionIndex: 1,
    })

    const v = await checkInvariants(h.db, h.taskId)
    const r1 = v.filter((x) => x.rule === 'R1')
    expect(r1.length).toBe(1)
  })

  test('I3 R2 violated — review run done but no approved doc_version', async () => {
    h = await buildHarness('running')
    await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'done',
      finishedAt: Date.now(),
    })
    // No doc_version inserted.

    const v = await checkInvariants(h.db, h.taskId)
    expect(v.some((x) => x.rule === 'R2')).toBe(true)
  })

  test('I4 C1 satisfied — answered session + done clarify run', async () => {
    h = await buildHarness('running')
    const clarifyRun = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'clarify_x',
      status: 'done',
      finishedAt: Date.now(),
    })
    const agentRun = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'doc',
      status: 'awaiting_human',
    })
    await h.db.insert(clarifySessions).values({
      id: ulid(),
      taskId: h.taskId,
      clarifyNodeId: 'clarify_x',
      clarifyNodeRunId: clarifyRun,
      sourceAgentNodeId: 'doc',
      sourceAgentNodeRunId: agentRun,
      iterationIndex: 0,
      status: 'answered',
      questionsJson: '[]',
      answersJson: '[]',
      createdAt: Date.now() - 100,
    })

    const v = await checkInvariants(h.db, h.taskId)
    expect(v.some((x) => x.rule === 'C1')).toBe(false)
  })

  test('I5 C1 violated — answered session but clarify run still awaiting_human', async () => {
    h = await buildHarness('running')
    const clarifyRun = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'clarify_x',
      status: 'awaiting_human', // ← stuck
    })
    const agentRun = await insertNodeRun(h.db, h.taskId, {
      nodeId: 'doc',
      status: 'awaiting_human',
    })
    await h.db.insert(clarifySessions).values({
      id: ulid(),
      taskId: h.taskId,
      clarifyNodeId: 'clarify_x',
      clarifyNodeRunId: clarifyRun,
      sourceAgentNodeId: 'doc',
      sourceAgentNodeRunId: agentRun,
      iterationIndex: 0,
      status: 'answered',
      questionsJson: '[]',
      answersJson: '[]',
      createdAt: Date.now() - 100,
    })

    const v = await checkInvariants(h.db, h.taskId)
    expect(v.some((x) => x.rule === 'C1')).toBe(true)
  })

  test('I6 T1 violated — task awaiting_review but no review run is awaiting_review', async () => {
    h = await buildHarness('awaiting_review')
    await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'done',
      finishedAt: Date.now(),
    })

    const v = await checkInvariants(h.db, h.taskId)
    expect(v.some((x) => x.rule === 'T1')).toBe(true)
  })

  test('I7 T1 satisfied — task awaiting_review + review run awaiting_review', async () => {
    h = await buildHarness('awaiting_review')
    await insertNodeRun(h.db, h.taskId, { nodeId: 'rev_1', status: 'awaiting_review' })

    const v = await checkInvariants(h.db, h.taskId)
    expect(v.some((x) => x.rule === 'T1')).toBe(false)
  })

  test('I8 T2 violated — task awaiting_human but no run is awaiting_human', async () => {
    h = await buildHarness('awaiting_human')
    await insertNodeRun(h.db, h.taskId, { nodeId: 'doc', status: 'running' })

    const v = await checkInvariants(h.db, h.taskId)
    expect(v.some((x) => x.rule === 'T2')).toBe(true)
  })

  test('I9 T3 violated — task done but output run failed', async () => {
    h = await buildHarness('done')
    await insertNodeRun(h.db, h.taskId, {
      nodeId: 'out_1',
      status: 'failed',
      finishedAt: Date.now(),
    })

    const v = await checkInvariants(h.db, h.taskId)
    expect(v.some((x) => x.rule === 'T3')).toBe(true)
  })

  test('I10 U1 violated — two awaiting_review rows at same (nodeId, iteration)', async () => {
    h = await buildHarness('awaiting_review')
    await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'awaiting_review',
      retryIndex: 0,
    })
    await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'awaiting_review',
      retryIndex: 1,
    })

    const v = await checkInvariants(h.db, h.taskId)
    expect(v.some((x) => x.rule === 'U1')).toBe(true)
  })

  test('I11 U1 satisfied — multiple historical rows, only one active', async () => {
    h = await buildHarness('awaiting_review')
    await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'canceled',
      retryIndex: 0,
      finishedAt: Date.now() - 100,
    })
    await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'failed',
      retryIndex: 1,
      finishedAt: Date.now() - 50,
    })
    await insertNodeRun(h.db, h.taskId, {
      nodeId: 'rev_1',
      status: 'awaiting_review',
      retryIndex: 2,
    })

    const v = await checkInvariants(h.db, h.taskId)
    expect(v.some((x) => x.rule === 'U1')).toBe(false)
  })
})

// Quiet unused import.
void inArray
