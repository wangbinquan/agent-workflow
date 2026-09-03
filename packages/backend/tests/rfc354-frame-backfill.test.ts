// RFC-354 T4 — the one-shot frame backfill for rows minted before frames existed.
//
// Locks (design §6 "backfill"):
//   • planner oracle: legacy nested-loop / fan-out / session-sub-row layouts map to
//     the generation row minted before them; framed rows are taken as-is (idempotent);
//     a nested row with no generation row before it is reported, not guessed;
//   • SQLite store end-to-end: node_runs + clarify_rounds get their frame, the
//     maintenance_state marker makes the next boot a no-op, `force` re-walks;
//   • `doctor --backfill-containers` refuses while the daemon runs.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb } from '../src/db/client'
import { clarifyRounds, maintenanceState, nodeRuns, tasks, workflows } from '../src/db/schema'
import { frameBackfillCommand } from '../src/cli/frameBackfill'
import { FRAME_BACKFILL_MARKER_KEY } from '../src/modules/task-execution/application/frameBackfillJob'
import { runFrameBackfillOnBoot } from '../src/modules/task-execution/composition/frameBackfill'
import {
  planFrameBackfill,
  type FrameBackfillRunRow,
} from '../src/modules/task-execution/domain/frameBackfill'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function row(
  id: string,
  nodeId: string,
  over: Partial<Omit<FrameBackfillRunRow, 'id' | 'nodeId'>> = {},
): FrameBackfillRunRow {
  return {
    id,
    nodeId,
    iteration: over.iteration ?? 0,
    parentNodeRunId: over.parentNodeRunId ?? null,
    containerRunId: over.containerRunId ?? null,
    scopePath: over.scopePath ?? '',
  }
}

// oloop ∋ iloop ∋ worker ; fw ∋ a (fan-out) ; root at the top.
const PARENT_OF: ReadonlyMap<string, string> = new Map([
  ['iloop', 'oloop'],
  ['worker', 'iloop'],
  ['a', 'fw'],
])

describe('RFC-354 T4 — planFrameBackfill (pure oracle)', () => {
  test('legacy nested loop: body rows hang off the LATEST generation row minted before them', () => {
    // Pre-354 layout of audit S-6: the outer loop re-used ONE row across its two
    // rounds, the inner loop minted one row per outer round, the worker ran only
    // in outer round 1 (inner rounds 0 and 1) — round 2 no-op'd.
    const plan = planFrameBackfill({
      parentOf: PARENT_OF,
      rows: [
        row('01O', 'oloop'),
        row('02I', 'iloop', { iteration: 0 }),
        row('03W', 'worker', { iteration: 0 }),
        row('04W', 'worker', { iteration: 1 }),
        row('05I', 'iloop', { iteration: 1 }),
        row('00R', 'root'),
      ],
    })
    expect(plan.unresolved).toEqual([])
    expect(plan.updates).toEqual([
      { id: '02I', containerRunId: '01O', scopePath: 'oloop:0' },
      { id: '03W', containerRunId: '02I', scopePath: 'oloop:0/iloop:0' },
      { id: '04W', containerRunId: '02I', scopePath: 'oloop:0/iloop:1' },
      { id: '05I', containerRunId: '01O', scopePath: 'oloop:1' },
    ])
  })

  test('a fan-out child hangs off its wrapper row; a session sub-row shares its parent frame', () => {
    const plan = planFrameBackfill({
      parentOf: PARENT_OF,
      rows: [
        row('01F', 'fw', { iteration: 2 }),
        row('02S', 'a', { parentNodeRunId: '01F', iteration: 2 }),
        row('03S', 'a', { parentNodeRunId: '01F', iteration: 2 }),
        row('04O', 'oloop'),
        row('05I', 'iloop'),
        row('06W', 'worker', { iteration: 0 }),
        // merge-resolve / commit-push session sub-row of the worker run
        row('07M', 'worker', { parentNodeRunId: '06W', iteration: 0 }),
        // a session sub-row of a TOP-scope run stays at the top scope (no update)
        row('08R', 'root'),
        row('09M', 'root', { parentNodeRunId: '08R' }),
      ],
    })
    expect(plan.unresolved).toEqual([])
    expect(plan.updates).toEqual([
      { id: '02S', containerRunId: '01F', scopePath: 'fw:2' },
      { id: '03S', containerRunId: '01F', scopePath: 'fw:2' },
      { id: '05I', containerRunId: '04O', scopePath: 'oloop:0' },
      { id: '06W', containerRunId: '05I', scopePath: 'oloop:0/iloop:0' },
      { id: '07M', containerRunId: '05I', scopePath: 'oloop:0/iloop:0' },
    ])
  })

  test('framed rows are taken as-is (idempotent) and serve as generations for later rows', () => {
    const plan = planFrameBackfill({
      parentOf: PARENT_OF,
      rows: [
        row('01O', 'oloop'),
        row('02I', 'iloop', { containerRunId: '01O', scopePath: 'oloop:0' }),
        row('03W', 'worker', { containerRunId: '02I', scopePath: 'oloop:0/iloop:0' }),
        // a legacy worker row minted after the framed generation row
        row('04W', 'worker', { iteration: 1 }),
      ],
    })
    expect(plan.updates).toEqual([
      { id: '04W', containerRunId: '02I', scopePath: 'oloop:0/iloop:1' },
    ])
    // Second pass over the backfilled result: nothing left to do.
    const again = planFrameBackfill({
      parentOf: PARENT_OF,
      rows: [
        row('01O', 'oloop'),
        row('02I', 'iloop', { containerRunId: '01O', scopePath: 'oloop:0' }),
        row('03W', 'worker', { containerRunId: '02I', scopePath: 'oloop:0/iloop:0' }),
        row('04W', 'worker', { iteration: 1, containerRunId: '02I', scopePath: 'oloop:0/iloop:1' }),
      ],
    })
    expect(again.updates).toEqual([])
  })

  test('a nested row with no generation row minted before it is reported, never guessed', () => {
    const plan = planFrameBackfill({
      parentOf: PARENT_OF,
      rows: [row('01W', 'worker'), row('02I', 'iloop'), row('03O', 'oloop')],
    })
    // worker had no iloop row before it; iloop had no oloop row before it.
    expect(plan.unresolved).toEqual(['01W', '02I'])
    expect(plan.updates).toEqual([])
  })
})

const DEFINITION: WorkflowDefinition = {
  $schema_version: 1,
  inputs: [],
  nodes: [
    { id: 'worker', kind: 'agent-single', agentName: 'worker' },
    {
      id: 'iloop',
      kind: 'wrapper-loop',
      nodeIds: ['worker'],
      maxIterations: 2,
      exitCondition: { kind: 'port-empty', nodeId: 'worker', portName: 'findings' },
      outputBindings: [],
    },
    {
      id: 'oloop',
      kind: 'wrapper-loop',
      nodeIds: ['iloop'],
      maxIterations: 2,
      exitCondition: { kind: 'port-empty', nodeId: 'worker', portName: 'findings' },
      outputBindings: [],
    },
  ] as unknown as WorkflowDefinition['nodes'],
  edges: [],
}

async function seedLegacyTask(db: ReturnType<typeof createInMemoryDb>) {
  const wfId = '01WF0000000000000000000000'
  const taskId = '01TASK00000000000000000000'
  await db.insert(workflows).values({
    id: wfId,
    name: 'nested',
    description: '',
    definition: JSON.stringify(DEFINITION),
    version: 1,
    schemaVersion: 1,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'nested',
    workflowId: wfId,
    workflowSnapshot: JSON.stringify(DEFINITION),
    repoPath: '/tmp',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'agent-workflow/nested',
    status: 'done',
    inputs: '{}',
    startedAt: Date.now(),
  })
  const legacy = [
    { id: '01O000000000000000000000000', nodeId: 'oloop', iteration: 0 },
    { id: '02I000000000000000000000000', nodeId: 'iloop', iteration: 0 },
    { id: '03W000000000000000000000000', nodeId: 'worker', iteration: 0 },
    { id: '04W000000000000000000000000', nodeId: 'worker', iteration: 1 },
    { id: '05I000000000000000000000000', nodeId: 'iloop', iteration: 1 },
  ]
  for (const r of legacy) {
    await db.insert(nodeRuns).values({
      id: r.id,
      taskId,
      nodeId: r.nodeId,
      status: 'done',
      retryIndex: 0,
      iteration: r.iteration,
      parentNodeRunId: null,
      // pre-354 rows: no frame, empty breadcrumb
      containerRunId: null,
      scopePath: '',
    })
  }
  // a self-clarify round whose park row is the round-0 worker run
  await db.insert(clarifyRounds).values({
    id: '01ROUND0000000000000000000',
    taskId,
    kind: 'self',
    askingNodeId: 'worker',
    askingNodeRunId: '03W000000000000000000000000',
    intermediaryNodeId: 'worker',
    intermediaryNodeRunId: '03W000000000000000000000000',
    targetConsumerNodeId: null,
    iteration: 0,
    questionsJson: '[]',
    answersJson: '[]',
    directive: 'continue',
    status: 'answered',
    answeredAt: Date.now(),
  })
  return { taskId }
}

describe('RFC-354 T4 — SQLite store end-to-end', () => {
  test('backfills node_runs + clarify_rounds frames, marks completion, force re-walks', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedLegacyTask(db)

    const first = await runFrameBackfillOnBoot({ provider: 'sqlite', db })
    expect(first.skipped).toBe(false)
    expect(first.tasks).toBe(1)
    expect(first.rowsUpdated).toBe(4)
    expect(first.roundsUpdated).toBe(1)
    expect(first.unreadableTasks).toEqual([])
    expect(first.unresolvedRows).toBe(0)

    const runs = await db
      .select({
        id: nodeRuns.id,
        containerRunId: nodeRuns.containerRunId,
        scopePath: nodeRuns.scopePath,
      })
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, taskId))
      .orderBy(nodeRuns.id)
    expect(runs).toEqual([
      { id: '01O000000000000000000000000', containerRunId: null, scopePath: '' },
      {
        id: '02I000000000000000000000000',
        containerRunId: '01O000000000000000000000000',
        scopePath: 'oloop:0',
      },
      {
        id: '03W000000000000000000000000',
        containerRunId: '02I000000000000000000000000',
        scopePath: 'oloop:0/iloop:0',
      },
      {
        id: '04W000000000000000000000000',
        containerRunId: '02I000000000000000000000000',
        scopePath: 'oloop:0/iloop:1',
      },
      {
        id: '05I000000000000000000000000',
        containerRunId: '01O000000000000000000000000',
        scopePath: 'oloop:1',
      },
    ])
    const round = await db
      .select({ containerRunId: clarifyRounds.containerRunId })
      .from(clarifyRounds)
      .where(eq(clarifyRounds.taskId, taskId))
    expect(round).toEqual([{ containerRunId: '02I000000000000000000000000' }])

    const marker = await db
      .select({ value: maintenanceState.value })
      .from(maintenanceState)
      .where(eq(maintenanceState.key, FRAME_BACKFILL_MARKER_KEY))
    expect(marker.length).toBe(1)
    expect(JSON.parse(marker[0]!.value)).toMatchObject({ tasks: 1, rowsUpdated: 4, roundsUpdated: 1 })

    // Next boot: the marker short-circuits the walk.
    const second = await runFrameBackfillOnBoot({ provider: 'sqlite', db })
    expect(second.skipped).toBe(true)

    // Manual re-run: walks again, finds nothing left to do (idempotent).
    const forced = await runFrameBackfillOnBoot({ provider: 'sqlite', db }, { force: true })
    expect(forced.skipped).toBe(false)
    expect(forced.tasks).toBe(1)
    expect(forced.rowsUpdated).toBe(0)
    expect(forced.roundsUpdated).toBe(0)
  })

  test('a task whose snapshot cannot be parsed is reported and left untouched', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedLegacyTask(db)
    await db.update(tasks).set({ workflowSnapshot: '{not json' }).where(eq(tasks.id, taskId))
    const report = await runFrameBackfillOnBoot({ provider: 'sqlite', db })
    expect(report.unreadableTasks).toEqual([taskId])
    expect(report.rowsUpdated).toBe(0)
    const framed = await db
      .select({ containerRunId: nodeRuns.containerRunId })
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, taskId))
    expect(framed.every((r) => r.containerRunId === null)).toBe(true)
  })
})

describe('RFC-354 T4 — doctor --backfill-containers', () => {
  test('refuses while the daemon is running', async () => {
    let opened = false
    const result = await frameBackfillCommand({
      daemonPid: () => process.pid,
      openDatabase: async () => {
        opened = true
        throw new Error('must not open the database')
      },
    })
    expect(result.status).toBe('daemon-running')
    expect(result.output).toContain('agent-workflow stop')
    expect(opened).toBe(false)
  })

  test('walks the database with force and reports counts', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedLegacyTask(db)
    let closed = false
    const result = await frameBackfillCommand({
      daemonPid: () => null,
      openDatabase: async () => ({
        database: { provider: 'sqlite', db },
        close: async () => {
          closed = true
        },
      }),
    })
    expect(result.status).toBe('ok')
    expect(result.output).toContain('1 task(s) walked, 4 node run(s) and 1 clarify round(s) updated')
    expect(closed).toBe(true)
  })
})
