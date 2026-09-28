// RFC-371: runtime source commit, projection commit and acknowledgement are distinct crash points.
import { expect, test } from 'bun:test'
import type { ObservationCapturedUsage, ObservationMeasurement } from '@agent-workflow/shared'
import { nodeRunEvents, nodeRuns, tasks, taskExecutionObservationSources } from '../src/db/schema'
import { DrizzleNodeExecutionPersistence } from '../src/modules/task-execution/infrastructure/nodeExecutionPersistence'
import { composeObservationUsageSource } from '../src/modules/task-execution/composition/observationUsageSource'
import { createObservationInvocationStore } from '../src/modules/run-observability/infrastructure/invocationPersistence'
import { createUsageLedgerStore } from '../src/modules/run-observability/infrastructure/usageLedgerPersistence'
import { createUsageSourceProjection } from '../src/modules/run-observability/application/usageSourceProjection'
import { describeEachProvider } from './helpers/eachProvider'

const measurement = (nodeRunId = 'run', revision = 1): ObservationMeasurement => ({
  schemaVersion: 1,
  invocationId: 'invocation-' + nodeRunId,
  recordId: 'step',
  revision,
  taskId: 'task',
  nodeRunId,
  agentId: 'agent',
  occurredAt: 100,
  observedAt: 101,
  model: null,
  adapterVersion: 'fixture-v1',
  reporting: 'delta',
  inclusion: 'self',
  coverage: 'complete',
  validity: 'valid',
  basis: { kind: 'invocation' },
  usage: { input: '100', output: '10', cacheRead: '0', cacheWrite: '0' },
})
const evidence = (nodeRunId = 'run'): ObservationCapturedUsage => ({
  invocationId: 'invocation-' + nodeRunId,
  measurements: [measurement(nodeRunId)],
  diagnostics: [],
})

describeEachProvider('RFC-371 committed numeric source projection', (harness) => {
  async function fixture(hosted = false) {
    const db = harness.db
    await db.insert(tasks).values({
      id: 'task',
      name: 'source fixture',
      workflowId: 'workflow',
      workflowSnapshot: '{}',
      repoPath: '/fixture',
      worktreePath: '/fixture',
      baseBranch: 'main',
      branch: 'task/fixture',
      status: 'running',
      inputs: '{}',
      startedAt: 100,
    })
    const invocations = createObservationInvocationStore(db)
    for (const nodeRunId of ['run', 'other']) {
      await db
        .insert(nodeRuns)
        .values({ id: nodeRunId, taskId: 'task', nodeId: nodeRunId, status: 'running' })
      await invocations.accept({
        invocationId: 'invocation-' + nodeRunId,
        taskId: 'task',
        nodeRunId,
        agentId: 'agent',
        agentRevision: 1,
        purpose: 'task',
        authority: hosted
          ? {
              kind: 'crewstation',
              projectId: 'project',
              taskId: 'cs-task',
              subtaskId: nodeRunId,
              executionResourceId: nodeRunId,
              executionGeneration: 1,
            }
          : { kind: 'local', runtime: null },
      })
    }
    const writer = new DrizzleNodeExecutionPersistence(db)
    const source = composeObservationUsageSource(db),
      store = createUsageLedgerStore(db)
    const write = (nodeRunId = 'run', observation = evidence(nodeRunId)) =>
      writer.appendEvents({
        nodeRunId,
        events: [{ ts: 100, kind: 'step_finish', payload: '{"tokens":100}', observation }],
      })
    return {
      source,
      store,
      invocations,
      writer,
      write,
      project: createUsageSourceProjection({ source, store, invocations }),
    }
  }

  test('invalid numeric source rolls back the raw event and the complete source batch', async () => {
    const f = await fixture()
    const invalid = { ...evidence(), measurements: [{ ...measurement(), revision: 0 }] }
    await expect(
      f.writer.appendEvents({
        nodeRunId: 'run',
        events: [
          { ts: 100, kind: 'text', payload: 'first', observation: evidence() },
          { ts: 100, kind: 'text', payload: 'second', observation: invalid },
        ],
      }),
    ).rejects.toThrow()
    expect(await harness.db.select().from(nodeRunEvents)).toEqual([])
    expect(await harness.db.select().from(taskExecutionObservationSources)).toEqual([])
    expect(await f.store.cursor('local-node:run')).toBeNull()
  })

  test('reopening after source commit projects retained evidence without reading runtime files', async () => {
    const f = await fixture()
    await f.write()
    expect((await f.store.records('task', { limit: 10 })).items).toEqual([])
    const project = createUsageSourceProjection({
      source: composeObservationUsageSource(harness.db),
      store: createUsageLedgerStore(harness.db),
      invocations: createObservationInvocationStore(harness.db),
    })
    expect(await project()).toBe(1)
    expect(await f.source.pending({ limit: 10 })).toEqual([])
    expect((await f.store.records('task', { limit: 10 })).items[0]?.contribution).toEqual(
      measurement().usage,
    )
    expect(await project()).toBe(0)
  })

  test('lost acknowledgement after ledger commit replays once and never adds a second contribution', async () => {
    const f = await fixture()
    await f.write()
    const failAck = createUsageSourceProjection({
      ...f,
      source: {
        ...f.source,
        acknowledge: async () => {
          throw new Error('ack interrupted')
        },
      },
    })
    await expect(failAck()).rejects.toThrow('remains pending')
    expect(await f.source.pending({ limit: 10 })).toHaveLength(1)
    expect(await f.project()).toBe(1)
    const records = (await f.store.records('task', { limit: 10 })).items
    expect(records).toHaveLength(1)
    expect(records[0]?.contribution.input).toBe('100')
    expect(await f.source.pending({ limit: 10 })).toEqual([])
    // A duplicate provider request in a later committed event also replaces the same meter.
    await f.write()
    await f.project()
    expect((await f.store.records('task', { limit: 10 })).items).toHaveLength(1)
  })

  test('ledger failure retains its source and does not prevent another node from projecting', async () => {
    const f = await fixture()
    await f.write()
    await f.write('other')
    const failOne = createUsageSourceProjection({
      ...f,
      store: {
        ...f.store,
        change: (sourceId, work) =>
          sourceId === 'local-node:run'
            ? Promise.reject(new Error('ledger interrupted'))
            : f.store.change(sourceId, work),
      },
    })
    expect(await failOne()).toBe(1)
    await expect(failOne()).rejects.toThrow('remains pending')
    expect((await f.source.pending({ limit: 10 })).map((row) => row.nodeRunId)).toEqual(['run'])
    expect(await f.store.cursor('local-node:run')).toBeNull()
    expect((await f.store.records('task', { limit: 10 })).items).toHaveLength(1)
    expect(await f.project()).toBe(1)
    expect((await f.store.records('task', { limit: 10 })).items).toHaveLength(2)
  })

  test('a mismatched invocation remains pending instead of being charged to the current task', async () => {
    const f = await fixture()
    await f.write('run', { ...evidence(), measurements: [{ ...measurement(), agentId: 'wrong' }] })
    await expect(f.project()).rejects.toThrow('remains pending')
    expect(await f.source.pending({ limit: 10 })).toHaveLength(1)
    expect((await f.store.records('task', { limit: 10 })).items).toEqual([])
  })

  test('five full failed source pages cannot starve the sixth healthy node', async () => {
    const f = await fixture()
    const ids = ['bad-0', 'bad-1', 'bad-2', 'bad-3', 'bad-4', 'zz-healthy']
    for (const nodeRunId of ids) {
      await harness.db
        .insert(nodeRuns)
        .values({ id: nodeRunId, taskId: 'task', nodeId: nodeRunId, status: 'running' })
      await f.invocations.accept({
        invocationId: 'invocation-' + nodeRunId,
        taskId: 'task',
        nodeRunId,
        agentId: 'agent',
        agentRevision: 1,
        purpose: 'task',
        authority: { kind: 'local', runtime: null },
      })
      const good = nodeRunId === 'zz-healthy'
      const observation = good
        ? evidence(nodeRunId)
        : {
            ...evidence(nodeRunId),
            measurements: [{ ...measurement(nodeRunId), agentId: 'wrong' }],
          }
      await f.writer.appendEvents({
        nodeRunId,
        events: Array.from({ length: good ? 1 : 100 }, () => ({
          ts: 100,
          kind: 'step_finish' as const,
          payload: 'source',
          observation,
        })),
      })
    }
    for (let cycle = 0; cycle < 2; cycle++) {
      if (cycle) await f.write('zz-healthy')
      for (let failedNode = 0; failedNode < 5; failedNode++)
        await expect(f.project()).rejects.toThrow('remains pending')
      expect(await f.project()).toBe(1)
      const records = (await f.store.records('task', { limit: 10 })).items
      expect(records).toHaveLength(1)
      expect(records[0]?.measurement.nodeRunId).toBe('zz-healthy')
      expect(await f.store.cursor('local-node:bad-0')).toBeNull()
    }
  })

  test('CS authority never consumes a local numeric duplicate', async () => {
    const f = await fixture(true)
    await f.write()
    expect(await f.project()).toBe(1)
    expect(await f.store.cursor('local-node:run')).toBeNull()
    expect((await f.store.records('task', { limit: 10 })).items).toEqual([])
  })

  test('two consumers converge when reading the same committed page', async () => {
    const f = await fixture()
    await f.write()
    const other = createUsageSourceProjection(f)
    await Promise.allSettled([f.project(), other()])
    await f.project()
    expect(await f.source.pending({ limit: 10 })).toEqual([])
    expect((await f.store.records('task', { limit: 10 })).items).toHaveLength(1)
  })
})
