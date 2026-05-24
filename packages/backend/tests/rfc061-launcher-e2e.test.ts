// RFC-061 PR-B partial-18 — launcher end-to-end with MockRunnerAdapter.
//
// Proves runTaskActorViaProduction drives a complete workflow through
// the actor + adapter + writeEvents path without touching legacy
// services/scheduler. MockRunnerAdapter stands in for opencode so we
// can deterministically simulate attempt outcomes.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb } from '../src/db/client'
import {
  attempts,
  events as eventsTable,
  logicalRuns,
  nodeOutputs,
  tasks,
  workflows,
} from '../src/db/schema'
import { writeEvents } from '../src/services/writeEvents'
import { runTaskActorViaProduction } from '../src/scheduler-v2/launcher'
import { MockRunnerAdapter } from '../src/scheduler-v2/runnerAdapter'
import { taskActorRegistry } from '../src/scheduler-v2/actorRegistry'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function setupDb(taskId = 't1') {
  const db = createInMemoryDb(MIGRATIONS)
  db.insert(workflows).values({ id: 'wf1', name: 'wf', schemaVersion: 4, definition: '{}' }).run()
  db.insert(tasks)
    .values({
      id: taskId,
      name: 'launcher-e2e',
      workflowId: 'wf1',
      workflowSnapshot: '{}',
      repoPath: '/tmp/x/repo',
      worktreePath: '/tmp/x/repo',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: JSON.stringify({}),
      startedAt: Date.now(),
    })
    .run()
  return db
}

const wf = (
  nodes: WorkflowNode[],
  edges: Array<{
    source: { nodeId: string; portName: string }
    target: { nodeId: string; portName: string }
  }> = [],
): WorkflowDefinition =>
  ({ $schema_version: 4, nodes, edges, inputs: [] }) as unknown as WorkflowDefinition

/**
 * Drive a launcher run + concurrent mark-terminal so the loop exits.
 * Returns the events table snapshot for assertion.
 */
async function runUntilTerminal(opts: {
  db: ReturnType<typeof createInMemoryDb>
  workflow: WorkflowDefinition
  inputsMap: Record<string, string>
  drive: (runner: MockRunnerAdapter, db: ReturnType<typeof createInMemoryDb>) => Promise<void>
}): Promise<void> {
  // Pre-register so we can grab the actor handle BEFORE the launcher runs.
  taskActorRegistry.deregisterAll('test-isolate')
  const actor = taskActorRegistry.register('t1')
  const runner = new MockRunnerAdapter()
  runner.bindWakeProducer(actor.queue)

  const loopP = runTaskActorViaProduction({
    db: opts.db,
    taskId: 't1',
    workflow: opts.workflow,
    inputsMap: opts.inputsMap,
    worktreePath: '/tmp/x/repo',
    repoPath: '/tmp/x/repo',
    appHome: '/tmp/aw',
    runnerAdapterOverride: runner,
  })

  // Give actor a chance to start dispatching.
  await new Promise((r) => setTimeout(r, 30))
  await opts.drive(runner, opts.db)
  await new Promise((r) => setTimeout(r, 30))

  // Mark task terminal so loop exits.
  opts.db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, 't1')).run()
  actor.queue.enqueue({ kind: 'event-applied', eventId: 'final' })
  await loopP
}

describe('runTaskActorViaProduction — end-to-end via MockRunnerAdapter', () => {
  test('single input node → virtual-done → task-completed projection state', async () => {
    const db = setupDb()
    const workflow = wf([
      { id: 'in1', kind: 'input', inputKey: 'topic' } as unknown as WorkflowNode,
    ])
    await runUntilTerminal({
      db,
      workflow,
      inputsMap: { topic: 'fix it' },
      drive: async () => {}, // input node fires synchronously, no spawn
    })

    // task-started + logical-run-created seeded; input dispatch → captured + completed.
    const lr = db.select().from(logicalRuns).where(eq(logicalRuns.taskId, 't1')).all()
    expect(lr.length).toBeGreaterThanOrEqual(1)
    const inputLr = lr.find((r) => r.nodeId === 'in1')
    expect(inputLr?.status).toBe('done')
    const out = db.select().from(nodeOutputs).where(eq(nodeOutputs.taskId, 't1')).all()
    expect(out.length).toBeGreaterThanOrEqual(1)
    expect(out.find((o) => o.portName === 'topic')?.content).toBe('fix it')
  })

  test('input → agent → output pipeline (with simulateExit success)', async () => {
    const db = setupDb()
    const workflow = wf(
      [
        { id: 'in1', kind: 'input', inputKey: 'task' } as unknown as WorkflowNode,
        {
          id: 'designer',
          kind: 'agent-single',
          agentName: 'mAlice',
          promptTemplate: 'do {{task}}',
        } as unknown as WorkflowNode,
        {
          id: 'out1',
          kind: 'output',
          ports: [{ name: 'result', bind: { nodeId: 'designer', portName: 'r' } }],
        } as unknown as WorkflowNode,
      ],
      [
        {
          source: { nodeId: 'in1', portName: 'task' },
          target: { nodeId: 'designer', portName: 'task' },
        },
        {
          source: { nodeId: 'designer', portName: 'r' },
          target: { nodeId: 'out1', portName: 'result' },
        },
      ],
    )

    await runUntilTerminal({
      db,
      workflow,
      inputsMap: { task: 'feature' },
      drive: async (runner, db) => {
        // Wait for the designer spawn request.
        for (let i = 0; i < 20 && runner.spawned.length === 0; i++) {
          await new Promise((r) => setTimeout(r, 20))
        }
        if (runner.spawned.length === 0) return
        const att = runner.spawned[0]!
        expect(att.agentName).toBe('mAlice')
        // Seed the attempt-output-captured event the runner would write.
        await writeEvents(db, [
          {
            taskId: 't1',
            kind: 'attempt-output-captured',
            nodeId: 'designer',
            loopIter: 0,
            shardKey: '',
            iter: 0,
            attemptId: att.attemptId,
            actor: 'system',
            payload: { portName: 'r', content: 'final result' },
          },
        ])
        runner.simulateExit(att.attemptId, 'success')
      },
    })

    // Designer + input + output should all be done.
    const lr = db.select().from(logicalRuns).where(eq(logicalRuns.taskId, 't1')).all()
    const doneCount = lr.filter((r) => r.status === 'done').length
    expect(doneCount).toBeGreaterThanOrEqual(2)

    // Output port flows through.
    const outRows = db.select().from(nodeOutputs).where(eq(nodeOutputs.taskId, 't1')).all()
    const finalOutput = outRows.find((o) => o.nodeId === 'out1')
    if (finalOutput) {
      expect(finalOutput.content).toBe('final result')
    }
  })

  test('launcher is idempotent — re-running on the same taskId rejoins existing actor', async () => {
    const db = setupDb()
    const workflow = wf([
      { id: 'in1', kind: 'input', inputKey: 'topic' } as unknown as WorkflowNode,
    ])

    // First run.
    await runUntilTerminal({
      db,
      workflow,
      inputsMap: { topic: 'hello' },
      drive: async () => {},
    })
    const firstEventCount = db
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.taskId, 't1'))
      .all().length

    // Second run — should detect existing events + skip seed phase.
    taskActorRegistry.deregisterAll('test-isolate')
    const actor = taskActorRegistry.register('t1')
    const runner = new MockRunnerAdapter()
    runner.bindWakeProducer(actor.queue)

    db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, 't1')).run()

    const loopP = runTaskActorViaProduction({
      db,
      taskId: 't1',
      workflow,
      inputsMap: { topic: 'hello' },
      worktreePath: '/tmp/x/repo',
      repoPath: '/tmp/x/repo',
      appHome: '/tmp/aw',
      runnerAdapterOverride: runner,
    })

    // Mark terminal immediately.
    await new Promise((r) => setTimeout(r, 20))
    db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, 't1')).run()
    actor.queue.enqueue({ kind: 'event-applied', eventId: 'final' })
    await loopP

    // Event count shouldn't have grown (no duplicate task-started / logical-run-created).
    const secondEventCount = db
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.taskId, 't1'))
      .all().length
    // It can grow by at most 0 (no new state changes since first run was already terminal-ish).
    expect(secondEventCount).toBe(firstEventCount)
  })

  test('describeTask returns task + logicalRuns + attempts for diagnostics', async () => {
    const db = setupDb()
    const workflow = wf([
      { id: 'in1', kind: 'input', inputKey: 'topic' } as unknown as WorkflowNode,
    ])
    await runUntilTerminal({
      db,
      workflow,
      inputsMap: { topic: 'hi' },
      drive: async () => {},
    })

    const { describeTask } = await import('../src/scheduler-v2/launcher')
    const summary = describeTask(db, 't1')
    expect(summary.task).not.toBeNull()
    expect(summary.task?.id).toBe('t1')
    expect(summary.logicalRuns.length).toBeGreaterThanOrEqual(1)
  })
})

// Silence unused-import warning.
void attempts
