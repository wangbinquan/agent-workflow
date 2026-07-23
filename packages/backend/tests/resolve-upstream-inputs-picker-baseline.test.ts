// RFC-074 — `resolveUpstreamInputs` source-run picker (PR-A baseline → PR-B
// unified). `resolveUpstreamInputs` is the SINGLE place an agent node reads its
// upstream content AND the point where provenance (`consumed`) is captured.
//
// PR-A locked the OLD cci-blind `(iteration desc, retryIndex desc)` picker
// (with no status filter). PR-B (decision D10 / design §5.1) unified it with
// the freshness picker: among top-level DONE rows in the iteration window, pick
// the highest iteration then the freshest by isFresherNodeRun. The two
// assertions below FLIPPED — each audited here as a "corrected stale read", not
// a regression:
//   * PB1: cci-blind picked the higher-retry PRE-clarify row; now reads the
//     fresh clarify rerun.
//   * PB2: a pending higher-retry row shadowed real done content (→ empty); the
//     done-only filter now reads the real content.
// PB3 (iteration windowing) and PB4 (multi-source join + child exclusion) keep
// the same observable values. Every case also asserts the recorded `consumed`
// provenance map — the new return field driving read-time freshness.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { WorkflowEdge } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, nodeRunOutputs, tasks, workflows } from '../src/db/schema'
import { resolveUpstreamInputs } from '../src/services/scheduler'
import { createLogger } from '../src/util/log'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const log = createLogger('test-picker-baseline')

async function seedTask(db: DbClient): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const wfId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: wfId,
    name: 'pick',
    description: '',
    definition: '{}',
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'pick',
    workflowId: wfId,
    workflowSnapshot: '{}',
    repoPath: '/tmp',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'agent-workflow/pick',
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

let seq = 0
// Seed a top-level node_run plus one output port, returning the run id. `id` is
// passed explicitly so tests control ULID ordering deterministically.
async function seedRunWithOutput(
  db: DbClient,
  taskId: string,
  nodeId: string,
  fields: {
    id: string
    iteration?: number
    retryIndex?: number
    clarifyIteration?: number
    status?: string
    parentNodeRunId?: string | null
  },
  outputs: Record<string, string>,
): Promise<string> {
  await db.insert(nodeRuns).values({
    id: fields.id,
    taskId,
    nodeId,
    status: (fields.status ?? 'done') as 'done',
    retryIndex: fields.retryIndex ?? 0,
    iteration: fields.iteration ?? 0,
    parentNodeRunId: fields.parentNodeRunId ?? null,
  })
  for (const [portName, content] of Object.entries(outputs)) {
    await db.insert(nodeRunOutputs).values({ nodeRunId: fields.id, portName, content })
  }
  return fields.id
}

function edge(
  sourceNodeId: string,
  sourcePort: string,
  targetNodeId: string,
  targetPort: string,
): WorkflowEdge {
  seq += 1
  return {
    id: `e${seq}`,
    source: { nodeId: sourceNodeId, portName: sourcePort },
    target: { nodeId: targetNodeId, portName: targetPort },
  }
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-074 — resolveUpstreamInputs unified picker + consumed provenance', () => {
  // PB1 — THE HEADLINE LATENT BUG, now FIXED (design §5.1). Upstream has two
  // top-level done rows at the same iteration: a retry-storm row at the OLD
  // generation (cci=0, retry=5) and the post-clarify rerun (cci=1, retry=0).
  // The OLD picker sorted by retryIndex desc, IGNORED cci, and read the STALE
  // pre-clarify content. The unified picker uses isFresherNodeRun within the
  // iteration → reads the fresh clarify rerun, and records it as consumed.
  test('PB1: unified picker reads the fresh clarify rerun (corrected stale read)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    // gen0 retry-storm done row — LARGER retryIndex, but minted EARLIER (smaller id).
    await seedRunWithOutput(
      db,
      taskId,
      'designer',
      { id: '01A_STALE', iteration: 0, retryIndex: 5, clarifyIteration: 0, status: 'done' },
      { spec: 'STALE-pre-clarify' },
    )
    // gen1 clarify rerun — freshest generation, minted LATER (larger id).
    await seedRunWithOutput(
      db,
      taskId,
      'designer',
      { id: '01B_FRESH', iteration: 0, retryIndex: 0, clarifyIteration: 1, status: 'done' },
      { spec: 'FRESH-post-clarify' },
    )
    const { inputs, consumed } = await resolveUpstreamInputs(
      db,
      taskId,
      [edge('designer', 'spec', 'review', 'doc')],
      'review',
      0,
      log,
    )
    // FLIPPED vs PR-A baseline: the fresh clarify rerun wins (corrected read).
    expect(inputs.doc).toBe('FRESH-post-clarify')
    // Provenance records the actual run read — the fresh one.
    expect(consumed.designer).toBe('01B_FRESH')
  })

  // PB2 — done-only filter, now FIXED. A pending rerun (no output yet) at
  // higher retryIndex used to shadow the done row → empty input. The done-only
  // filter now skips the pending row and reads the real content.
  test('PB2: done-only filter reads real content (pending no longer shadows)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRunWithOutput(
      db,
      taskId,
      'designer',
      { id: '01DONE', iteration: 0, retryIndex: 0, status: 'done' },
      { spec: 'real-content' },
    )
    // Pending rerun, higher retryIndex, no outputs persisted yet.
    await seedRunWithOutput(
      db,
      taskId,
      'designer',
      { id: '01PEND', iteration: 0, retryIndex: 1, status: 'pending' },
      {},
    )
    const { inputs, consumed } = await resolveUpstreamInputs(
      db,
      taskId,
      [edge('designer', 'spec', 'review', 'doc')],
      'review',
      0,
      log,
    )
    // FLIPPED vs PR-A baseline: done row read, pending skipped (corrected read).
    expect(inputs.doc).toBe('real-content')
    expect(consumed.designer).toBe('01DONE')
  })

  // PB3 — iteration windowing. Rows with iteration > target are excluded; among
  // iteration <= target the highest iteration wins. Resolving at iter 0 must
  // NOT see iter 1's content; resolving at iter 1 sees iter 1.
  test('PB3: iteration windowing — iteration <= target, highest in-window wins', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRunWithOutput(
      db,
      taskId,
      'builder',
      { id: '01ITER0', iteration: 0, retryIndex: 0, status: 'done' },
      { out: 'ITER0' },
    )
    await seedRunWithOutput(
      db,
      taskId,
      'builder',
      { id: '01ITER1', iteration: 1, retryIndex: 0, status: 'done' },
      { out: 'ITER1' },
    )
    const e = [edge('builder', 'out', 'sink', 'in')]
    expect((await resolveUpstreamInputs(db, taskId, e, 'sink', 0, log)).inputs.in).toBe('ITER0')
    expect((await resolveUpstreamInputs(db, taskId, e, 'sink', 1, log)).inputs.in).toBe('ITER1')
  })

  // PB4 — multi-source join + child-row exclusion. Two upstream nodes feed the
  // same target port → contents joined with the framework separator; a child
  // (parentNodeRunId != null) shard row is excluded from top-level selection.
  test('PB4: two sources joined; child shard rows excluded from selection', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRunWithOutput(
      db,
      taskId,
      'a',
      { id: '01A', iteration: 0, status: 'done' },
      { o: 'AAA' },
    )
    await seedRunWithOutput(
      db,
      taskId,
      'b',
      { id: '01B', iteration: 0, status: 'done' },
      { o: 'BBB' },
    )
    // A child shard row under 'a' with a higher retryIndex — must be ignored
    // because parentNodeRunId != null (top-level filter).
    await seedRunWithOutput(
      db,
      taskId,
      'a',
      { id: '01ACHILD', iteration: 0, retryIndex: 9, status: 'done', parentNodeRunId: '01A' },
      { o: 'CHILD-should-not-win' },
    )
    const { inputs, consumed } = await resolveUpstreamInputs(
      db,
      taskId,
      [edge('a', 'o', 'sink', 'merged'), edge('b', 'o', 'sink', 'merged')],
      'sink',
      0,
      log,
    )
    expect(inputs.merged).toBe('AAA\n\n---\n\nBBB')
    // Both top-level parents recorded as consumed; the child shard row excluded.
    expect(consumed).toEqual({ a: '01A', b: '01B' })
  })

  // PB5 (B17) — clarify-only-no-output upstream. A questioner/agent that emitted
  // only <workflow-clarify> finishes `done` with NO output for the port. After
  // the answer, it reruns with real output. The freshest-done picker selects the
  // OUTPUT-bearing rerun (higher cci) and reads its content — it never reads the
  // clarify-only row, so a downstream review can't trip review-source-port-missing.
  test('PB5 (B17): clarify-only done row is passed over for the output-bearing rerun', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    // Clarify-only done row: no output for the port (the agent only asked).
    await seedRunWithOutput(
      db,
      taskId,
      'questioner',
      { id: '01CLARIFYONLY', iteration: 0, retryIndex: 0, clarifyIteration: 1, status: 'done' },
      {},
    )
    // Post-answer rerun: done WITH the real output, at a higher generation.
    await seedRunWithOutput(
      db,
      taskId,
      'questioner',
      { id: '01WITHOUTPUT', iteration: 0, retryIndex: 1, clarifyIteration: 2, status: 'done' },
      { spec: 'answered content' },
    )
    const { inputs, consumed } = await resolveUpstreamInputs(
      db,
      taskId,
      [edge('questioner', 'spec', 'review', 'doc')],
      'review',
      0,
      log,
    )
    expect(inputs.doc).toBe('answered content')
    expect(consumed.questioner).toBe('01WITHOUTPUT')
  })

  test('PB6: fanout boundary mirrors are never consumed as ordinary dataflow rows', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRunWithOutput(
      db,
      taskId,
      'source',
      { id: '01SOURCE', status: 'done' },
      { out: 'REAL-DATAFLOW' },
    )
    await seedRunWithOutput(
      db,
      taskId,
      'fan',
      { id: '01FAN', status: 'done' },
      { items: 'STRUCTURAL-MIRROR' },
    )
    const mirror = edge('fan', 'items', 'sink', 'item')
    mirror.boundary = 'wrapper-input'

    const { inputs, consumed } = await resolveUpstreamInputs(
      db,
      taskId,
      [edge('source', 'out', 'sink', 'normal'), mirror],
      'sink',
      0,
      log,
    )

    expect(inputs).toEqual({ normal: 'REAL-DATAFLOW' })
    expect(consumed).toEqual({ source: '01SOURCE' })
  })
})
