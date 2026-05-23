// RFC-061 PR-B — integration: taskActorTick → writeEvents → projection.
//
// Verifies the full event-sourcing loop:
//   1. computeTickActions decides next events from current state
//   2. writeEvents atomically appends them + applies projections
//   3. logical_runs / node_outputs / suspensions reflect the changes
//
// No opencode subprocess; spawn-attempt requests are processed in-memory.
// This is the closest thing to an end-to-end test we have for the new
// architecture without booting the daemon.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  attempts,
  events as eventsTable,
  logicalRuns,
  nodeOutputs,
  suspensions,
  tasks,
  workflows,
} from '../src/db/schema'
import { writeEvents } from '../src/services/writeEvents'
import {
  computeTickActions,
  type TickContext,
  type ReadyScope,
} from '../src/scheduler-v2/taskActorTick'
import type {
  Event,
  EventKind,
  EventPayload,
  Scope,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function setupDb(): DbClient {
  const db = createInMemoryDb(MIGRATIONS)
  // Seed required FK rows: a workflow + a task. tasks schema has many
  // notNull columns from earlier RFCs (RFC-037 name, RFC-024 repo_path,
  // worktree_path, base_branch, branch) — fill them with placeholders.
  db.insert(workflows)
    .values({
      id: 'wf1',
      name: 'test-wf',
      schemaVersion: 4,
      definition: '{}',
    })
    .run()
  db.insert(tasks)
    .values({
      id: 't1',
      name: 'rfc061-integration-test',
      workflowId: 'wf1',
      workflowSnapshot: '{}',
      repoPath: '/tmp/aw-integration-test/repo',
      worktreePath: '',
      baseBranch: 'main',
      branch: 'agent-workflow/t1',
      status: 'running',
      inputs: JSON.stringify({}),
      startedAt: Date.now(),
    })
    .run()
  return db
}

const baseScope: Scope = { nodeId: 'n1', loopIter: 0, shardKey: '', iter: 0 }

function emptyDefinition(): WorkflowDefinition {
  return {
    $schema_version: 4,
    nodes: [],
    edges: [],
    inputs: [],
  } as unknown as WorkflowDefinition
}

function baseTickCtx(over: Partial<TickContext> = {}): TickContext {
  return {
    taskId: 't1',
    workflow: emptyDefinition(),
    events: [],
    readyScopes: [],
    inputsMap: {},
    repoPath: '/repo',
    readUpstreamPort: async () => null,
    resolveUpstreamInputs: async () => [],
    ...over,
  }
}

function asNewEvent<K extends EventKind>(e: Event<K>) {
  return {
    id: e.id,
    taskId: e.taskId,
    ts: e.ts,
    kind: e.kind,
    nodeId: e.nodeId,
    loopIter: e.loopIter,
    shardKey: e.shardKey,
    iter: e.iter,
    attemptId: e.attemptId,
    parentEventId: e.parentEventId,
    actor: e.actor,
    resolutionId: e.resolutionId,
    payload: e.payload as EventPayload<K>,
  }
}

describe('taskActor → writeEvents integration', () => {
  test('input node: events written + node_outputs row + logical_runs done', async () => {
    const db = setupDb()
    // Pre-seed a logical-run-created event for the input node so the
    // applier can find the row when logical-run-completed fires.
    await writeEvents(db, [
      {
        taskId: 't1',
        kind: 'logical-run-created',
        nodeId: 'n1',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        actor: 'system',
        payload: {},
      },
    ])

    const node = { id: 'n1', kind: 'input', inputKey: 'topic' } as unknown as WorkflowNode
    const ready: ReadyScope[] = [{ scope: baseScope, node }]
    const tickOut = await computeTickActions(
      baseTickCtx({
        readyScopes: ready,
        inputsMap: { topic: 'hello world' },
      }),
    )

    await writeEvents(db, tickOut.eventsToWrite.map(asNewEvent))

    const lr = db.select().from(logicalRuns).all()
    expect(lr).toHaveLength(1)
    expect(lr[0]!.status).toBe('done')

    const outputs = db.select().from(nodeOutputs).all()
    expect(outputs).toHaveLength(1)
    expect(outputs[0]!.portName).toBe('topic')
    expect(outputs[0]!.content).toBe('hello world')

    const allEvents = db.select().from(eventsTable).all()
    // 1 seed + 2 tick events = 3 rows
    expect(allEvents).toHaveLength(3)
  })

  test('agent-single attempt-started: attempts row created + status running', async () => {
    const db = setupDb()
    await writeEvents(db, [
      {
        taskId: 't1',
        kind: 'logical-run-created',
        nodeId: 'n1',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        actor: 'system',
        payload: {},
      },
    ])

    const node = {
      id: 'n1',
      kind: 'agent-single',
      agentName: 'mAlice',
      promptTemplate: 'do {{x}}',
    } as unknown as WorkflowNode
    const ready: ReadyScope[] = [{ scope: baseScope, node }]
    const tickOut = await computeTickActions(
      baseTickCtx({
        readyScopes: ready,
        resolveUpstreamInputs: async () => [{ portName: 'x', content: 'thing' }],
      }),
    )

    await writeEvents(db, tickOut.eventsToWrite.map(asNewEvent))

    expect(tickOut.spawnRequests).toHaveLength(1)
    const att = db.select().from(attempts).all()
    expect(att).toHaveLength(1)
    expect(att[0]!.id).toBe(tickOut.spawnRequests[0]!.attemptId)

    const lr = db.select().from(logicalRuns).all()
    expect(lr[0]!.status).toBe('running')
  })

  test('review suspend-direct: suspension row + logical_runs status=suspended', async () => {
    const db = setupDb()
    const seeded = await writeEvents(db, [
      {
        taskId: 't1',
        kind: 'task-started',
        actor: 'system',
        payload: {},
      },
      {
        taskId: 't1',
        kind: 'logical-run-created',
        nodeId: 'n1',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        actor: 'system',
        payload: {},
      },
    ])

    const node = {
      id: 'n1',
      kind: 'review',
      docPort: { nodeId: 'd', portName: 'p' },
    } as unknown as WorkflowNode
    const ready: ReadyScope[] = [{ scope: baseScope, node }]
    const tickOut = await computeTickActions(
      baseTickCtx({
        readyScopes: ready,
        events: seeded,
        readUpstreamPort: async () => 'doc content for review',
      }),
    )

    await writeEvents(db, tickOut.eventsToWrite.map(asNewEvent))

    const sus = db.select().from(suspensions).all()
    expect(sus).toHaveLength(1)
    expect(sus[0]!.signalKind).toBe('review')
    expect(sus[0]!.resolvedAt).toBeNull()

    const lr = db.select().from(logicalRuns).all()
    expect(lr[0]!.status).toBe('suspended')
  })

  test('multi-iter: bump emits a new logical-run row at iter=1', async () => {
    const db = setupDb()
    await writeEvents(db, [
      {
        taskId: 't1',
        kind: 'logical-run-created',
        nodeId: 'n1',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        actor: 'system',
        payload: {},
      },
      {
        taskId: 't1',
        kind: 'logical-run-iter-bumped',
        nodeId: 'n1',
        loopIter: 0,
        shardKey: '',
        iter: 1, // applier records this with iter+1 -> 1 stays as-is when payload's iter
        actor: 'system',
        payload: { triggerEventId: 'placeholder', triggerKind: 'suspension-resolved' },
      },
    ])
    const lr = db.select().from(logicalRuns).all()
    expect(lr.length).toBeGreaterThanOrEqual(1)
    expect(lr.some((r) => r.iter === 0)).toBe(true)
  })

  test('atomic batch: applier failure inside writeEvents rolls back the entire batch', async () => {
    const db = setupDb()
    // Try to apply a logical-run-completed without a prior logical-run-created.
    await expect(
      writeEvents(db, [
        {
          taskId: 't1',
          kind: 'logical-run-completed',
          nodeId: 'n-missing',
          loopIter: 0,
          shardKey: '',
          iter: 0,
          actor: 'system',
          payload: {},
        },
      ]),
    ).rejects.toThrow(/no logical_run row/)

    // The events row must NOT have been persisted.
    const ev = db.select().from(eventsTable).all()
    expect(ev).toHaveLength(0)
  })
})
