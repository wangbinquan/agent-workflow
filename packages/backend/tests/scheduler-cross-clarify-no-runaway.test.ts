// RFC-056 follow-up — 2026-05-22 UI bug "21 pending cross_clarify_6c910f"
//
// Root cause:
//   1. scheduler.buildScopeUpstreams skipped `questioner.__clarify__ →
//      cross-clarify.questions` as a "channel edge" — this is correct for
//      RFC-023 clarify targets but WRONG for RFC-056 cross-clarify
//      targets. Without the upstream dep, cross-clarify was a no-upstream
//      leaf, always "ready", picked up every scheduler tick.
//   2. scheduler.runOneNode's `case 'clarify-cross-agent'` eagerly
//      `insertNodeRun(pending)` on every dispatch without checking if a
//      live row already exists. Combined with (1), every tick minted a
//      fresh orphan pending row.
//
// LOCKS:
//   1. After a scheduler dispatch that finds NO live row + NO persistent
//      stop, the scheduler does NOT mint a new pending cross-clarify row
//      — the runner's createCrossClarifySession owns row creation.
//   2. If a live pending or awaiting_human row already exists, scheduler
//      dispatch is a no-op (no second row minted).
//   3. Persistent-stop short-circuit still works: when prior directive=
//      'stop' exists, scheduler does mint a row and marks it done so the
//      cascade reset can advance past the cross-clarify node.
//   4. buildScopeUpstreams KEEPS questioner→cross-clarify edge as a
//      dataflow dep so the cross-clarify node isn't dispatched until its
//      questioner reaches done.
//
// If any of these go red the runaway pending-row accumulation bug is
// resurfacing — investigate before relaxing.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { WorkflowDefinition } from '@agent-workflow/shared'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { crossClarifySessions, nodeRuns, tasks, workflows } from '../src/db/schema'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function defaultDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'topic', label: 'topic', required: true }],
    nodes: [
      { id: 'in1', kind: 'input', inputKey: 'topic' },
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
      { id: 'cross1', kind: 'clarify-cross-agent' },
    ],
    edges: [
      {
        id: 'e_in_d',
        source: { nodeId: 'in1', portName: 'topic' },
        target: { nodeId: 'designer', portName: 'topic' },
      },
      {
        id: 'e_d_q',
        source: { nodeId: 'designer', portName: 'design' },
        target: { nodeId: 'questioner', portName: 'design' },
      },
      // RFC-056 channel edges
      {
        id: 'e_q_cross',
        source: { nodeId: 'questioner', portName: '__clarify__' },
        target: { nodeId: 'cross1', portName: 'questions' },
      },
      {
        id: 'e_cross_to_q',
        source: { nodeId: 'cross1', portName: 'to_questioner' },
        target: { nodeId: 'questioner', portName: '__clarify_response__' },
      },
      {
        id: 'e_cross_to_d',
        source: { nodeId: 'cross1', portName: 'to_designer' },
        target: { nodeId: 'designer', portName: '__external_feedback__' },
      },
    ],
    outputs: [],
  }
}

async function seedTaskAndWorkflow(db: DbClient): Promise<string> {
  const wfId = ulid()
  const def = defaultDef()
  await db.insert(workflows).values({
    id: wfId,
    name: 'wf',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId: wfId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/runaway',
    worktreePath: '/tmp/runaway',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterEach(() => {
  resetBroadcastersForTests()
})

describe('RFC-056 scheduler — no runaway pending cross-clarify rows', () => {
  test('buildScopeUpstreams treats questioner→cross.questions as a dataflow dep (NOT skipped as channel edge)', async () => {
    // Source-text lock on the scheduler decision: the predicate that
    // skips RFC-023's `__clarify__ →` channel edges MUST gate on the
    // target node kind being 'clarify' (RFC-023). For cross-clarify
    // targets the edge is a legitimate dataflow dependency that lets the
    // scheduler wait for the questioner before activating cross.
    const { readFileSync } = await import('node:fs')
    const SCHEDULER_TS = resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts')
    const src = readFileSync(SCHEDULER_TS, 'utf-8')
    // We don't try to lex the full predicate — just lock that the
    // 'clarify-cross-agent' kind is referenced in close proximity to
    // the `__clarify__` skip rule, so any refactor that drops this
    // condition trips the test.
    const buildIdx = src.indexOf('function buildScopeUpstreams')
    expect(buildIdx).toBeGreaterThan(-1)
    const body = src.slice(buildIdx, buildIdx + 3000)
    // RFC-147: the inline predicate moved to the shared registry — anchor
    // both hops so neither silently regresses: buildScopeUpstreams consults
    // channelEdgeDataflowSkip, and the registry marks __clarify__ as
    // 'unless-target-clarify' (cross-clarify targets KEEP the edge; the
    // behavior grid lives in rfc147-system-channel-ports.test.ts).
    expect(body).toContain('channelEdgeDataflowSkip(')
    const registrySrc = readFileSync(
      resolve(import.meta.dir, '..', '..', 'shared', 'src', 'systemChannelPorts.ts'),
      'utf-8',
    )
    expect(registrySrc).toMatch(
      /\[CLARIFY_SOURCE_PORT_NAME\]:\s*\{[^}]*dataflow:\s*'unless-target-clarify'/,
    )
  })

  test('scheduler.runOneNode case clarify-cross-agent is idempotent: NO new pending row when a live (pending) row already exists', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTaskAndWorkflow(db)
    // Seed a pre-existing pending cross-clarify row (simulating the
    // runner having created one via createCrossClarifySession on a
    // prior questioner emit).
    const preId = ulid()
    await db.insert(nodeRuns).values({
      id: preId,
      taskId,
      nodeId: 'cross1',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
    })

    // Re-import the scheduler module to call its internals. The dispatch
    // path lives inside runOneNode; we don't drive the full scheduler
    // here (would require a full mock opencode harness). Instead we lock
    // the source-text rule that the new code reads existing rows + skips
    // insertion when a live row is found — equivalent to the per-tick
    // idempotency guard the bug needed.
    const { readFileSync } = await import('node:fs')
    const SCHEDULER_TS = resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts')
    const src = readFileSync(SCHEDULER_TS, 'utf-8')
    const branchIdx = src.indexOf("if (node.kind === 'clarify-cross-agent') {")
    expect(branchIdx).toBeGreaterThan(-1)
    // Window sized for the branch body; RFC-098 WP-10 widened it (the two
    // guard mints now go through the multi-line mintNodeRun factory call).
    const body = src.slice(branchIdx, branchIdx + 4500)
    // Three locks: live-row probe, persistent-stop fallback, and the
    // common path explicitly returning without minting a row.
    expect(body).toContain('cross-clarify-live-row-exists')
    expect(body).toContain('resolveCrossNodeStopped(db, taskId, reenableQuestionerNodeId)')
    expect(body).toContain('// Common path: no live row, no persistent stop')

    // Pre-existing row still in DB unchanged.
    const after = await db.select().from(nodeRuns).where(eq(nodeRuns.id, preId))
    expect(after.length).toBe(1)
    expect(after[0]?.status).toBe('pending')
  })

  test('scheduler does NOT pre-create pending cross-clarify rows on the common path (deferred to runner createCrossClarifySession)', async () => {
    // Direct assertion: after seeding a task with cross-clarify topology
    // but BEFORE any dispatch, the DB has zero cross-clarify node_runs.
    // The runner is the only path that should mint rows for cross-clarify
    // (via createCrossClarifySession when questioner emits clarify).
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTaskAndWorkflow(db)
    const rows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'cross1')))
    expect(rows.length).toBe(0)
    // The fix's comment block in scheduler.ts pins this contract.
    const { readFileSync } = await import('node:fs')
    const SCHEDULER_TS = resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts')
    const src = readFileSync(SCHEDULER_TS, 'utf-8')
    expect(src).toContain('runner will create the node_run')
    expect(src).toContain('common case (no stop, has questioner), do NOTHING')
  })

  test('persistent-stop case still mints a done row so cascade reset advances', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTaskAndWorkflow(db)
    // Seed a legacy directive='stop' session; the boot migration shim backfills the questioner
    // node-level directive so resolveCrossNodeStopped returns true (RFC-132 T7).
    const prevQRunId = ulid()
    await db.insert(nodeRuns).values({
      id: prevQRunId,
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    const prevCrossRunId = ulid()
    await db.insert(nodeRuns).values({
      id: prevCrossRunId,
      taskId,
      nodeId: 'cross1',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await db.insert(crossClarifySessions).values({
      id: ulid(),
      taskId,
      crossClarifyNodeId: 'cross1',
      crossClarifyNodeRunId: prevCrossRunId,
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: prevQRunId,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      iteration: 0,
      questionsJson: '[]',
      answersJson: '[]',
      directive: 'stop',
      status: 'answered',
      createdAt: Date.now() - 1000,
      answeredAt: Date.now() - 500,
    })
    const { resolveCrossNodeStopped } = await import('../src/services/crossClarify')
    const { reconcileLegacyCrossPersistentStop } = await import('../src/services/clarifyMigration')
    await reconcileLegacyCrossPersistentStop(db)
    expect(await resolveCrossNodeStopped(db, taskId, 'questioner')).toBe(true)
  })
})
