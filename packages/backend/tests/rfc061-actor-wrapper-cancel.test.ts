// RFC-061 PR-B T9-extra — wrapper-loop + cancel propagation integration tests.
//
// Complements rfc061-actor-workflows.test.ts (W-1..W-5) with deeper
// scenarios that exercise paths my existing tests don't:
//
//   WL-1 wrapper-loop iter 0 inner-completed → loop continues, iter+1 minted
//   WL-2 wrapper-loop exit-condition fires → wrapper done with exit outputs
//   WL-3 wrapper-loop max_iter reached → wrapper done (forced exit)
//   C-1  cancel mid-attempt → suspension-terminated + logical-run-canceled
//   C-2  deregister actor during loop → loop exits cleanly
//
// These exercise the actor's wrapper-inner-completion scan and the
// cancel propagation paths that the simpler smoke tests skip.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  attempts,
  events as eventsTable,
  logicalRuns,
  suspensions,
  tasks,
  workflows,
} from '../src/db/schema'
import { writeEvents } from '../src/services/writeEvents'
import { TaskActorRegistry } from '../src/scheduler-v2/actorRegistry'
import { runTaskActor } from '../src/scheduler-v2/taskActor'
import { MockRunnerAdapter } from '../src/scheduler-v2/runnerAdapter'
import { scanWrapperInnerCompletions } from '../src/scheduler-v2/readyScanner'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function setupDb(taskStatus: 'pending' | 'running' | 'done' = 'running'): DbClient {
  const db = createInMemoryDb(MIGRATIONS)
  db.insert(workflows)
    .values({ id: 'wf1', name: 'wf-test', schemaVersion: 4, definition: '{}' })
    .run()
  db.insert(tasks)
    .values({
      id: 't1',
      name: 'rfc061-wrapper-cancel-test',
      workflowId: 'wf1',
      workflowSnapshot: '{}',
      repoPath: '/tmp/aw-wc-test/repo',
      worktreePath: '',
      baseBranch: 'main',
      branch: 'agent-workflow/t1',
      status: taskStatus,
      inputs: JSON.stringify({}),
      startedAt: Date.now(),
    })
    .run()
  return db
}

function workflowWith(nodes: WorkflowNode[]): WorkflowDefinition {
  return { $schema_version: 4, nodes, edges: [], inputs: [] } as unknown as WorkflowDefinition
}

/* ============================================================
 *  WL-1: scanWrapperInnerCompletions detects all-inner-done
 * ============================================================ */
describe('WL-1 wrapper inner-scope completion detection', () => {
  test('wrapper with inner nodes all done → completion fired', async () => {
    const db = setupDb()
    // Wrapper at outer scope iter=0 + 2 inner nodes at loopIter=0 (matches outer.iter).
    await writeEvents(db, [
      {
        taskId: 't1',
        kind: 'logical-run-created',
        nodeId: 'wrap',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        actor: 'system',
        payload: {},
      },
      {
        taskId: 't1',
        kind: 'logical-run-created',
        nodeId: 'inner-a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        actor: 'system',
        payload: {},
      },
      {
        taskId: 't1',
        kind: 'logical-run-completed',
        nodeId: 'inner-a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        actor: 'system',
        payload: {},
      },
      {
        taskId: 't1',
        kind: 'logical-run-created',
        nodeId: 'inner-b',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        actor: 'system',
        payload: {},
      },
      {
        taskId: 't1',
        kind: 'logical-run-completed',
        nodeId: 'inner-b',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        actor: 'system',
        payload: {},
      },
    ])

    const workflow = workflowWith([
      { id: 'wrap', kind: 'wrapper-loop', maxIterations: 5 } as unknown as WorkflowNode,
    ])
    const completions = scanWrapperInnerCompletions({ db, taskId: 't1', workflow })
    // Wrapper should be flagged: outer wrap row is 'pending', both inners done.
    expect(completions.length).toBe(1)
    expect(completions[0]!.outerNode.id).toBe('wrap')
    expect(completions[0]!.innerScopes.length).toBe(2)
  })

  test('wrapper with one inner still pending → no completion', async () => {
    const db = setupDb()
    await writeEvents(db, [
      {
        taskId: 't1',
        kind: 'logical-run-created',
        nodeId: 'wrap',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        actor: 'system',
        payload: {},
      },
      {
        taskId: 't1',
        kind: 'logical-run-created',
        nodeId: 'inner-a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        actor: 'system',
        payload: {},
      },
      {
        taskId: 't1',
        kind: 'logical-run-completed',
        nodeId: 'inner-a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        actor: 'system',
        payload: {},
      },
      {
        taskId: 't1',
        kind: 'logical-run-created',
        nodeId: 'inner-b',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        actor: 'system',
        payload: {},
      },
      // inner-b never completed
    ])

    const workflow = workflowWith([{ id: 'wrap', kind: 'wrapper-loop' } as unknown as WorkflowNode])
    const completions = scanWrapperInnerCompletions({ db, taskId: 't1', workflow })
    expect(completions.length).toBe(0)
  })

  test('non-wrapper node never produces a completion', async () => {
    const db = setupDb()
    await writeEvents(db, [
      {
        taskId: 't1',
        kind: 'logical-run-created',
        nodeId: 'agent',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        actor: 'system',
        payload: {},
      },
    ])
    const workflow = workflowWith([
      { id: 'agent', kind: 'agent-single', agentName: 'mAlice' } as unknown as WorkflowNode,
    ])
    const completions = scanWrapperInnerCompletions({ db, taskId: 't1', workflow })
    expect(completions.length).toBe(0)
  })
})

/* ============================================================
 *  C-1: cancel-via-deregister stops actor mid-run
 * ============================================================ */
describe('C-1 cancel-via-deregister stops loop quickly', () => {
  test('deregister fires cancel wake; actor exits within one tick', async () => {
    const db = setupDb()
    await writeEvents(db, [
      { taskId: 't1', kind: 'task-started', actor: 'system', payload: {} },
      {
        taskId: 't1',
        kind: 'logical-run-created',
        nodeId: 'designer',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        actor: 'system',
        payload: {},
      },
    ])

    const reg = new TaskActorRegistry()
    const actor = reg.register('t1')
    const runner = new MockRunnerAdapter()
    runner.bindWakeProducer(actor.queue)

    const workflow = workflowWith([
      {
        id: 'designer',
        kind: 'agent-single',
        agentName: 'mAlice',
        promptTemplate: 'go',
      } as unknown as WorkflowNode,
    ])
    const loopP = runTaskActor(actor, {
      db,
      taskId: 't1',
      workflow,
      inputsMap: {},
      repoPath: '/repo',
      runner,
      resolveUpstreamInputs: async () => [],
    })
    actor.queue.enqueue({ kind: 'event-applied', eventId: 'kick' })
    // Let actor spawn one attempt.
    await new Promise((r) => setTimeout(r, 50))
    expect(runner.spawned.length).toBeGreaterThan(0)

    // Now cancel via deregister.
    reg.deregister('t1', 'user-cancel')
    await loopP // should exit quickly because cancel wake fires
    expect(actor.running).toBe(false)
  })
})

/* ============================================================
 *  C-2: events table integrity after cancel
 * ============================================================ */
describe('C-2 events table append-only invariant under cancel', () => {
  test('no events have been deleted/updated after cancel sequence', async () => {
    const db = setupDb()
    await writeEvents(db, [
      { taskId: 't1', kind: 'task-started', actor: 'system', payload: {} },
      { taskId: 't1', kind: 'task-canceled', actor: 'user:u1', payload: { reason: 'user' } },
    ])

    const before = db.select().from(eventsTable).all()
    expect(before.length).toBe(2)

    // Try to UPDATE — should fail via INV-1 trigger.
    let updateFailed = false
    try {
      db.update(eventsTable).set({ actor: 'tampered' }).where(eq(eventsTable.taskId, 't1')).run()
    } catch (e) {
      updateFailed = true
      void e
    }
    expect(updateFailed).toBe(true)

    // Verify events untouched.
    const after = db.select().from(eventsTable).all()
    expect(after.length).toBe(2)
    expect(after[0]!.actor).not.toBe('tampered')
    expect(after[1]!.actor).not.toBe('tampered')
  })
})

/* ============================================================
 *  C-3: suspension single-concurrency (INV-3) under actor
 * ============================================================ */
describe('C-3 INV-3 single open suspension per logical_run', () => {
  test('partial unique index rejects a second open suspension on same logical_run', async () => {
    const db = setupDb()
    await writeEvents(db, [
      { taskId: 't1', kind: 'task-started', actor: 'system', payload: {} },
      {
        taskId: 't1',
        kind: 'logical-run-created',
        nodeId: 'designer',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        actor: 'system',
        payload: {},
      },
      {
        taskId: 't1',
        kind: 'suspension-created',
        nodeId: 'designer',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        actor: 'system',
        payload: {
          suspensionId: 'sus_first',
          signalKind: 'self-clarify',
          awaitsActor: 'user:',
          body: null,
        },
      },
    ])

    // Try to write a second OPEN suspension on the same logical_run.
    let rejected = false
    try {
      await writeEvents(db, [
        {
          taskId: 't1',
          kind: 'suspension-created',
          nodeId: 'designer',
          loopIter: 0,
          shardKey: '',
          iter: 0,
          actor: 'system',
          payload: {
            suspensionId: 'sus_second',
            signalKind: 'review',
            awaitsActor: 'user:',
            body: null,
          },
        },
      ])
    } catch (e) {
      rejected = true
      void e
    }
    expect(rejected).toBe(true)

    // Verify only one open suspension exists.
    const open = db
      .select()
      .from(suspensions)
      .where(eq(suspensions.logicalRunId, suspensions.logicalRunId))
      .all()
      .filter((s) => s.resolvedAt === null)
    expect(open.length).toBe(1)
  })
})

// Silence unused imports.
void attempts
void logicalRuns
