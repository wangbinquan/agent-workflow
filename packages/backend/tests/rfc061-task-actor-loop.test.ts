// RFC-061 PR-B T9 — taskActor main loop integration tests.
//
// Exercises the full loop end-to-end:
//   register actor → enqueue wake → run loop → assert projection state
//
// MockRunnerAdapter stands in for opencode; tests drive subprocess
// outcomes via runner.simulateExit. The loop's writeEvents +
// applyEvent path persists everything to an in-memory DB so we can
// assert against logical_runs / attempts / suspensions / node_outputs.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { attempts, logicalRuns, nodeOutputs, suspensions, tasks, workflows } from '../src/db/schema'
import { writeEvents } from '../src/services/writeEvents'
import { TaskActorRegistry } from '../src/scheduler-v2/actorRegistry'
import { runTaskActor } from '../src/scheduler-v2/taskActor'
import { MockRunnerAdapter } from '../src/scheduler-v2/runnerAdapter'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function setupDb(): DbClient {
  const db = createInMemoryDb(MIGRATIONS)
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
      name: 'rfc061-actor-loop-test',
      workflowId: 'wf1',
      workflowSnapshot: '{}',
      repoPath: '/tmp/aw-actor-test/repo',
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

function workflowWith(nodes: WorkflowNode[]): WorkflowDefinition {
  return {
    $schema_version: 4,
    nodes,
    edges: [],
    inputs: [],
  } as unknown as WorkflowDefinition
}

async function seedLogicalRun(db: DbClient, nodeId: string, iter = 0): Promise<void> {
  await writeEvents(db, [
    {
      taskId: 't1',
      kind: 'task-started',
      actor: 'system',
      payload: {},
    },
    {
      taskId: 't1',
      kind: 'logical-run-created',
      nodeId,
      loopIter: 0,
      shardKey: '',
      iter,
      actor: 'system',
      payload: {},
    },
  ])
}

describe('runTaskActor end-to-end', () => {
  test('input node: actor processes wake → virtual-done → logical_runs done', async () => {
    const db = setupDb()
    await seedLogicalRun(db, 'n1', 0)

    const reg = new TaskActorRegistry()
    const actor = reg.register('t1')
    const runner = new MockRunnerAdapter()
    runner.bindWakeProducer(actor.queue)

    const workflow = workflowWith([
      { id: 'n1', kind: 'input', inputKey: 'topic' } as unknown as WorkflowNode,
    ])

    // Mark the task terminal mid-loop by flipping tasks.status — the
    // actor stops checking only at isTaskTerminal so we mark it done
    // after the first scan-and-dispatch completes.
    const loopPromise = runTaskActor(actor, {
      db,
      taskId: 't1',
      workflow,
      inputsMap: { topic: 'hello' },
      repoPath: '/repo',
      runner,
    })

    // Kick the loop: enqueue an event-applied wake.
    actor.queue.enqueue({ kind: 'event-applied', eventId: 'seed' })
    // Give the loop a chance to run, then mark task terminal + cancel.
    await new Promise((resolve) => setTimeout(resolve, 50))
    db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, 't1')).run()
    actor.queue.enqueue({ kind: 'event-applied', eventId: 'wake-final' })
    await loopPromise

    const lr = db.select().from(logicalRuns).all()
    expect(lr).toHaveLength(1)
    expect(lr[0]!.status).toBe('done')

    const outputs = db.select().from(nodeOutputs).all()
    expect(outputs).toHaveLength(1)
    expect(outputs[0]!.content).toBe('hello')
  })

  test('agent-single node: actor spawns + processes attempt-exit success', async () => {
    const db = setupDb()
    await seedLogicalRun(db, 'designer', 0)

    const reg = new TaskActorRegistry()
    const actor = reg.register('t1')
    const runner = new MockRunnerAdapter()
    runner.bindWakeProducer(actor.queue)

    const workflow = workflowWith([
      {
        id: 'designer',
        kind: 'agent-single',
        agentName: 'mAlice',
        promptTemplate: 'do {{x}}',
      } as unknown as WorkflowNode,
    ])

    const loopPromise = runTaskActor(actor, {
      db,
      taskId: 't1',
      workflow,
      inputsMap: {},
      repoPath: '/repo',
      runner,
      resolveUpstreamInputs: async () => [{ portName: 'x', content: 'thing' }],
    })

    actor.queue.enqueue({ kind: 'event-applied', eventId: 'seed' })
    // Wait for actor to spawn an attempt.
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(runner.spawned.length).toBeGreaterThan(0)
    const att = runner.spawned[0]!
    expect(att.agentName).toBe('mAlice')
    expect(att.prompt).toContain('do thing')

    // Verify attempt row exists + status=running.
    const a = db.select().from(attempts).all()
    expect(a).toHaveLength(1)
    expect(a[0]!.outcome).toBeNull()

    // Simulate exit success.
    runner.simulateExit(att.attemptId, 'success')

    // Wait for actor to process the exit + write logical-run-completed.
    await new Promise((resolve) => setTimeout(resolve, 50))

    db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, 't1')).run()
    actor.queue.enqueue({ kind: 'event-applied', eventId: 'wake-final' })
    await loopPromise

    const a2 = db.select().from(attempts).all()
    expect(a2[0]!.outcome).toBe('success')
    const lr = db.select().from(logicalRuns).all()
    expect(lr[0]!.status).toBe('done')
  })

  test('actor exits when queue closes without further state changes', async () => {
    const db = setupDb()
    const reg = new TaskActorRegistry()
    const actor = reg.register('t1')
    const runner = new MockRunnerAdapter()
    runner.bindWakeProducer(actor.queue)

    const workflow = workflowWith([])
    const loopPromise = runTaskActor(actor, {
      db,
      taskId: 't1',
      workflow,
      inputsMap: {},
      repoPath: '/repo',
      runner,
    })
    // Close immediately — loop should exit with no work done.
    actor.queue.close()
    await loopPromise
    expect(actor.running).toBe(false)
  })

  test('actor cancel via deregister stops the loop', async () => {
    const db = setupDb()
    const reg = new TaskActorRegistry()
    const actor = reg.register('t1')
    const runner = new MockRunnerAdapter()
    runner.bindWakeProducer(actor.queue)

    const workflow = workflowWith([])
    const loopPromise = runTaskActor(actor, {
      db,
      taskId: 't1',
      workflow,
      inputsMap: {},
      repoPath: '/repo',
      runner,
    })
    reg.deregister('t1', 'test-cancel')
    await loopPromise
    expect(actor.running).toBe(false)
  })

  test('attempt-finished-envelope-fail triggers retry-pending-auto suspension', async () => {
    const db = setupDb()
    await seedLogicalRun(db, 'designer', 0)

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

    const loopPromise = runTaskActor(actor, {
      db,
      taskId: 't1',
      workflow,
      inputsMap: {},
      repoPath: '/repo',
      runner,
      resolveUpstreamInputs: async () => [],
    })
    actor.queue.enqueue({ kind: 'event-applied', eventId: 'seed' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(runner.spawned.length).toBeGreaterThan(0)
    runner.simulateExit(runner.spawned[0]!.attemptId, 'envelope-fail', { reason: 'no closing tag' })
    await new Promise((resolve) => setTimeout(resolve, 80))

    // retry-pending-auto suspension created; autoResolve fires immediately
    // (remainingBudget=3 in the loop's stub) → resolved + iter-bumped.
    const sus = db.select().from(suspensions).all()
    expect(sus.length).toBeGreaterThan(0)
    expect(sus[0]!.signalKind).toBe('retry-pending-auto')
    expect(sus[0]!.resolvedAt).not.toBeNull() // autoResolve already ran

    db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, 't1')).run()
    actor.queue.enqueue({ kind: 'event-applied', eventId: 'final' })
    await loopPromise
  })
})
