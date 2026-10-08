// RFC-371: Task and original System facts share complete reporting and numeric authority,
// while their durable source row IDs, visibility and execution attempts remain distinct.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { buildActor } from '@/auth/actor'
import {
  tasks,
  nodeRuns,
  taskExecutionObservationSources,
  systemAgentObservationSources,
} from '@/db/schema'
import type { ObservationMeasurement } from '@agent-workflow/shared'
import { composeSystemAgentObservations } from '@/modules/task-execution/composition/systemAgentObservations'
import { composeObservationUsageSource } from '@/modules/task-execution/composition/observationUsageSource'
import { composeLocalInvocationObservations } from '@/modules/run-observability/composition/localInvocations'
import { createObservationInvocationStore } from '@/modules/run-observability/infrastructure/invocationPersistence'
import { createUsageLedgerStore } from '@/modules/run-observability/infrastructure/usageLedgerPersistence'
import { createCompleteTaskObservationFacts } from '@/modules/task-execution/composition/taskObservationFacts'
import { describeEachProvider } from './helpers/eachProvider'

const actor = buildActor({
  source: 'session',
  user: {
    id: 'original-system-reader',
    username: 'reader',
    displayName: 'Reader',
    role: 'admin',
    status: 'active',
  },
})
function measurement(
  input: { invocationId: string; taskId: string; nodeRunId: string; agentId: string | null },
  recordId: string,
): ObservationMeasurement {
  return {
    schemaVersion: 1,
    invocationId: input.invocationId,
    taskId: input.taskId,
    nodeRunId: input.nodeRunId,
    agentId: input.agentId,
    recordId,
    revision: 1,
    occurredAt: 101,
    observedAt: 102,
    model: null,
    adapterVersion: 'original-system-stream-fixture',
    reporting: 'delta',
    inclusion: 'self',
    coverage: 'complete',
    validity: 'valid',
    basis: { kind: 'invocation' },
    usage: { input: '1', cacheRead: '2', cacheWrite: '3', output: '4' },
  }
}

describeEachProvider('RFC-371 original System source federation', (harness) => {
  test('equal Task/System integer source IDs cannot acknowledge or overwrite one another; all211 System records survive multiple scheduling pages', async () => {
    const db = harness.db
    await db.insert(tasks).values({
      id: 'task',
      name: 'Original task',
      workflowId: 'workflow',
      workflowSnapshot: '{}',
      repoPath: '/fixture',
      worktreePath: '/fixture',
      baseBranch: 'main',
      branch: 'fixture',
      status: 'done',
      inputs: '{}',
      startedAt: 100,
    })
    await db
      .insert(nodeRuns)
      .values({ id: 'z-original-run', taskId: 'task', nodeId: 'agent', status: 'done' })
    const invocations = createObservationInvocationStore(db)
    await invocations.accept({
      invocationId: 'original-task-call',
      taskId: 'task',
      nodeRunId: 'z-original-run',
      agentId: null,
      agentRevision: null,
      purpose: 'task',
      authority: { kind: 'local', runtime: null },
    })
    await db.insert(taskExecutionObservationSources).values({
      taskId: 'task',
      nodeRunId: 'z-original-run',
      evidenceJson: JSON.stringify({
        invocationId: 'original-task-call',
        measurements: [
          measurement(
            {
              invocationId: 'original-task-call',
              taskId: 'task',
              nodeRunId: 'z-original-run',
              agentId: null,
            },
            'original-task-step',
          ),
        ],
        diagnostics: [],
      }),
    })
    const source = composeObservationUsageSource(db),
      observations = composeLocalInvocationObservations(db, source)
    const run = await composeSystemAgentObservations({ db, observations }).open({
      feature: 'intent-builder',
      agentName: 'aw-intent-builder',
      protocol: 'opencode',
      startedAt: 100,
      demand: {
        kind: 'intent-turn',
        originalId: 'session',
        originalAttempt: 'turn',
        name: 'Original intent session',
        ownerUserId: actor.user.id,
      },
    })
    await run.accept({})
    await run.append(
      Array.from({ length: 211 }, (_, n) => ({
        invocationId: run.invocationId,
        measurements: [measurement(run, 'system-step-' + n)],
        diagnostics: [],
      })),
    )
    const taskSource = await db.select().from(taskExecutionObservationSources).get(),
      systemSource = await db.select().from(systemAgentObservationSources).get()
    expect(await createCompleteTaskObservationFacts(db).sourceBacklog([run.taskId])).toEqual([
      { taskId: run.taskId, retainedRecords: 211, pendingRecords: 211 },
    ])
    expect(taskSource!.id).toBe(systemSource!.id)
    expect(await observations.reconcile!(run.nodeRunId)).toBe(100)
    expect((await db.select().from(taskExecutionObservationSources).get())!.pending).toBe(true)
    await run.reconcile()
    expect(await createCompleteTaskObservationFacts(db).sourceBacklog([run.taskId])).toEqual([
      { taskId: run.taskId, retainedRecords: 211, pendingRecords: 0 },
    ])
    await observations.reconcile!('z-original-run')
    expect(
      await db
        .select()
        .from(systemAgentObservationSources)
        .where(eq(systemAgentObservationSources.pending, true)),
    ).toEqual([])
    const ledger = createUsageLedgerStore(db),
      rows = []
    let after: string | undefined
    for (;;) {
      const page = await ledger.records(run.taskId, { limit: 19, ...(after ? { after } : {}) })
      rows.push(...page.items)
      if (!page.nextCursor) break
      after = page.nextCursor
    }
    expect(rows).toHaveLength(211)
    expect(rows.every((row) => row.sourceId === 'system-agent:' + run.nodeRunId)).toBe(true)
    expect((await ledger.records('task', { limit: 19 })).items).toHaveLength(1)
    expect((await ledger.records('task', { limit: 19 })).items[0]!.sourceId).toBe(
      'local-node:z-original-run',
    )
  })

  test('mixed original facts reach EOF with readable names, every System retry and the original owner visibility', async () => {
    const db = harness.db,
      observations = composeLocalInvocationObservations(db, composeObservationUsageSource(db)),
      factory = composeSystemAgentObservations({ db, observations })
    const ids = []
    for (let n = 0; n < 42; n++) {
      const run = await factory.open({
        feature: 'memory-distiller',
        agentName: 'aw-memory-distiller',
        protocol: 'opencode',
        startedAt: 100 + n,
        demand: {
          kind: 'memory-distill',
          originalId: 'job-' + n,
          originalAttempt: '1:0',
          name: '记忆提取 ' + n,
          ownerUserId: actor.user.id,
          purpose: 'memory',
        },
      })
      await run.accept({})
      await run.settle('ok', 200 + n)
      ids.push(run.taskId)
    }
    const retry = await factory.open({
      feature: 'memory-distiller',
      agentName: 'aw-memory-distiller',
      protocol: 'opencode',
      startedAt: 175,
      demand: {
        kind: 'memory-distill',
        originalId: 'job-0',
        originalAttempt: '2:1',
        name: '记忆提取 0',
        ownerUserId: actor.user.id,
        purpose: 'memory',
      },
    })
    await retry.accept({})
    await retry.settle('ok', 200)
    const facts = createCompleteTaskObservationFacts(db),
      all = []
    let after: string | undefined
    for (;;) {
      const page = await facts.list({
        actor,
        query: { from: 100, to: 1000, timezone: 'UTC', limit: 5, ...(after ? { after } : {}) },
      })
      all.push(...page.items)
      if (!page.nextCursor) break
      after = page.nextCursor
    }
    expect(new Set(all.map((row) => row.id))).toEqual(new Set(ids))
    expect(all.every((row) => row.name.startsWith('记忆提取 '))).toBe(true)
    expect(
      (await facts.attemptPage!(ids[0]!, { limit: 10 })).items.map((row) => [
        row.nodeId,
        row.retryIndex,
        row.iteration,
      ]),
    ).toEqual([
      ['aw-memory-distiller', 1, 0],
      ['aw-memory-distiller', 2, 1],
    ])
    const stranger = {
      ...actor,
      user: { ...actor.user, id: 'stranger' },
      permissions: new Set(['tasks:read:own'] as const),
    }
    expect(await facts.get(stranger, ids[0]!)).toBeNull()
    expect(
      (
        await facts.list({
          actor: stranger,
          query: { from: 100, to: 1000, timezone: 'UTC', limit: 5 },
        })
      ).items,
    ).toEqual([])
  }, 30000)
})
