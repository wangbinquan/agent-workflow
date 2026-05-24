// RFC-061 PR-B — ProductionRunnerAdapter tests.
//
// The adapter is now FULLY implemented (partial-15 onward); these tests
// verify the contract: spawn returns immediately (fire-and-forget) and
// the spawn lifecycle eventually writes events for the actor to
// consume via wakeForEvents.
//
// Real opencode subprocess testing happens in dedicated runner-v2
// integration tests with opencode binary fixtures; here we just verify
// the construction + error-path event emission for missing agent.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb } from '../src/db/client'
import { events as eventsTable, tasks, workflows } from '../src/db/schema'
import {
  ProductionRunnerAdapter,
  createProductionRunnerAdapter,
} from '../src/scheduler-v2/runnerAdapterProduction'
import { WakeQueue } from '../src/scheduler-v2/wakeQueue'
import { TaskActorRegistry } from '../src/scheduler-v2/actorRegistry'
import type { SpawnRequest } from '../src/scheduler-v2/taskActorTick'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function makeAdapter(opts?: { taskId?: string }): {
  adapter: ProductionRunnerAdapter
  db: ReturnType<typeof createInMemoryDb>
} {
  const db = createInMemoryDb(MIGRATIONS)
  db.insert(workflows).values({ id: 'wf1', name: 'wf', schemaVersion: 4, definition: '{}' }).run()
  db.insert(tasks)
    .values({
      id: opts?.taskId ?? 't1',
      name: 'pra-test',
      workflowId: 'wf1',
      workflowSnapshot: '{}',
      repoPath: '/tmp/x/repo',
      worktreePath: '/tmp/x/repo',
      baseBranch: 'main',
      branch: 'agent-workflow/t1',
      status: 'running',
      inputs: JSON.stringify({}),
      startedAt: Date.now(),
    })
    .run()
  const queue = new WakeQueue(opts?.taskId ?? 't1')
  const adapter = createProductionRunnerAdapter({
    db,
    taskId: opts?.taskId ?? 't1',
    worktreePath: '/tmp/x/repo',
    appHome: '/tmp/aw',
    wakeProducer: queue,
  })
  return { adapter, db }
}

describe('ProductionRunnerAdapter', () => {
  test('implements RunnerAdapter interface (spawn + cancel)', () => {
    const { adapter } = makeAdapter()
    expect(typeof adapter.spawn).toBe('function')
    expect(typeof adapter.cancel).toBe('function')
  })

  test('factory returns a ProductionRunnerAdapter instance', () => {
    const { adapter } = makeAdapter()
    expect(adapter).toBeInstanceOf(ProductionRunnerAdapter)
  })

  test('spawn with unknown agent emits attempt-finished-crash with agent-not-found', async () => {
    const reg = new TaskActorRegistry()
    const actor = reg.register('t1')
    const db = createInMemoryDb(MIGRATIONS)
    db.insert(workflows).values({ id: 'wf1', name: 'wf', schemaVersion: 4, definition: '{}' }).run()
    db.insert(tasks)
      .values({
        id: 't1',
        name: 'pra-noagent',
        workflowId: 'wf1',
        workflowSnapshot: '{}',
        repoPath: '/tmp/x/repo',
        worktreePath: '/tmp/x/repo',
        baseBranch: 'main',
        branch: 'agent-workflow/t1',
        status: 'running',
        inputs: JSON.stringify({}),
        startedAt: Date.now(),
      })
      .run()
    const adapter = createProductionRunnerAdapter({
      db,
      taskId: 't1',
      worktreePath: '/tmp/x/repo',
      appHome: '/tmp/aw',
      wakeProducer: actor.queue,
    })

    const req: SpawnRequest = {
      scope: { nodeId: 'designer', loopIter: 0, shardKey: '', iter: 0 },
      attemptId: 'att_x',
      prompt: 'do it',
      agentName: 'nonexistent_agent',
    }
    // spawn returns immediately (fire-and-forget); the catch path emits crash.
    await adapter.spawn(req)
    // Give the microtask a chance to fire.
    await new Promise((r) => setTimeout(r, 50))

    const ev = db.select().from(eventsTable).all()
    const crash = ev.find((e) => e.kind === 'attempt-finished-crash')
    expect(crash).toBeDefined()
    expect(crash?.attemptId).toBe('att_x')

    reg.deregisterAll('test-cleanup')
  })

  test('cancel on unknown attempt is a no-op', async () => {
    const { adapter } = makeAdapter()
    // Should not throw.
    await adapter.cancel('att_nonexistent', 'test')
  })
})
