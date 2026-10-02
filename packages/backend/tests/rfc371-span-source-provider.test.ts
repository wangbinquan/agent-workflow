import { expect, test } from 'bun:test'
import { AcceptObservationInvocationSchema, type ObservationSpanFact } from '@agent-workflow/shared'
import { tasks, nodeRuns, taskExecutionObservationSources, nodeRunEvents } from '../src/db/schema'
import { DrizzleNodeExecutionPersistence } from '../src/modules/task-execution/infrastructure/nodeExecutionPersistence'
import { createObservationSpanSources } from '../src/modules/task-execution/infrastructure/observationSpanSources'
import { composeObservationUsageSource } from '../src/modules/task-execution/composition/observationUsageSource'
import { createObservationInvocationStore } from '../src/modules/run-observability/infrastructure/invocationPersistence'
import { composeLocalInvocationObservations } from '../src/modules/run-observability/composition/localInvocations'
import { composeTaskObservations } from '../src/modules/run-observability/composition/taskObservations'
import { createTaskObservationFacts } from '../src/modules/task-execution/composition/taskObservationFacts'
import { buildActor } from '../src/auth/actor'
import { describeEachProvider } from './helpers/eachProvider'

// Fresh acceptance uses the request contract; persisted responses may retain legacy null source IDs.
const acceptance = AcceptObservationInvocationSchema.parse({
  invocationId: 'call',
  taskId: 'task',
  nodeRunId: 'run',
  agentId: 'agent',
  agentRevision: 1,
  purpose: 'task',
  authority: { kind: 'local', runtime: null },
  spanCaptureContract: 'runtime-span-facts-v1',
  spanCaptureSource: 'source',
})
const fact = (id: number): ObservationSpanFact => ({
  schemaVersion: 1,
  invocationId: 'call',
  spanKey: 'span-' + id,
  scope: {
    sourceNamespace: 'source',
    rootSessionId: 'root',
    nativeSessionId: 'root',
    parentNativeSessionId: null,
    ancestors: [],
    callId: 'tool-' + id,
    kind: 'tool',
  },
  label: 'Read',
  parentCallId: null,
  model: null,
  measurementRecordId: null,
  state: { startedAt: 10, endedAt: 20, nativeObservedAt: 20, status: 'success' },
  capturedAt: 21,
})
const actor = buildActor({
  user: { id: 'admin', username: 'admin', displayName: 'Admin', role: 'admin', status: 'active' },
  source: 'session',
})

describeEachProvider('RFC-371 retained span source cursors', (harness) => {
  async function fixture() {
    await harness.db
      .insert(tasks)
      .values({
        id: 'task',
        name: 'span source',
        workflowId: 'workflow',
        workflowSnapshot: '{}',
        repoPath: '/fixture',
        worktreePath: '/fixture',
        baseBranch: 'main',
        branch: 'task/fixture',
        status: 'running',
        inputs: '{}',
        startedAt: 1,
      })
      .run()
    await harness.db
      .insert(nodeRuns)
      .values({ id: 'run', taskId: 'task', nodeId: 'node', status: 'running', startedAt: 1 })
      .run()
    const store = createObservationInvocationStore(harness.db, () => 1)
    await store.accept(acceptance)
    const writer = new DrizzleNodeExecutionPersistence(harness.db),
      source = composeObservationUsageSource(harness.db)
    return {
      writer,
      source,
      read: createObservationSpanSources(harness.db),
      participant: composeLocalInvocationObservations(harness.db, source),
    }
  }
  const page = {
    taskId: 'task',
    carrierInvocationIds: ['call'],
    sourceNamespace: 'source',
    scopeHash: 'scope',
    limit: 200,
  }
  test('150+150 frames continue inside the second frame and survive numeric ACK without a ledger record', async () => {
    const f = await fixture()
    await f.writer.appendEvents({
      nodeRunId: 'run',
      events: [],
      observations: [
        {
          invocationId: 'call',
          measurements: [],
          diagnostics: [],
          spanFacts: Array.from({ length: 150 }, (_, i) => fact(i)),
        },
        {
          invocationId: 'call',
          measurements: [],
          diagnostics: [],
          spanFacts: Array.from({ length: 150 }, (_, i) => fact(i + 150)),
        },
      ],
    })
    expect(await f.participant.reconcile?.('run')).toBe(2)
    expect(await f.source.pending({ nodeRunId: 'run', limit: 10 })).toEqual([])
    const first = await f.read(page)
    expect(first.records).toHaveLength(200)
    expect(JSON.parse(first.nextCursor!)[5]).toBe(50)
    const second = await f.read({ ...page, after: first.nextCursor })
    expect(second.records).toHaveLength(100)
    expect(second.nextCursor).toBeNull()
    expect(
      new Set(
        [...first.records, ...second.records].map((record) =>
          record.type === 'fact' ? record.fact.spanKey : 'unexpected',
        ),
      ).size,
    ).toBe(300)
    const queries = composeTaskObservations({
      db: harness.db,
      taskSource: createTaskObservationFacts,
    })
    const visible = await queries.spans!(actor, 'task', { nodeRunId: 'run', limit: 200 })
    expect(visible!.spans).toHaveLength(200)
    expect(visible!.spans.every((span) => span.usage === null && span.cost === null)).toBe(true)
    expect(
      (await queries.spans!(actor, 'task', {
        nodeRunId: 'run',
        limit: 200,
        after: visible!.nextCursor,
      }))!.spans,
    ).toHaveLength(100)
  })
  test('a full page ending at a new frame index zero does not skip it; watermark excludes later commits', async () => {
    const f = await fixture()
    await f.writer.appendEvents({
      nodeRunId: 'run',
      events: [],
      observations: [
        {
          invocationId: 'call',
          measurements: [],
          diagnostics: [],
          spanFacts: Array.from({ length: 200 }, (_, i) => fact(i)),
        },
        { invocationId: 'call', measurements: [], diagnostics: [], spanFacts: [fact(200)] },
      ],
    })
    const first = await f.read(page)
    expect(JSON.parse(first.nextCursor!)[5]).toBe(0)
    await f.writer.appendEvents({
      nodeRunId: 'run',
      events: [],
      observations: [
        { invocationId: 'call', measurements: [], diagnostics: [], spanFacts: [fact(201)] },
      ],
    })
    const second = await f.read({ ...page, after: first.nextCursor })
    expect(second.records).toHaveLength(1)
    expect(second.records[0]).toMatchObject({ type: 'fact', fact: { spanKey: 'span-200' } })
    await expect(
      f.read({ ...page, scopeHash: 'changed', after: first.nextCursor }),
    ).rejects.toThrow('changed scope')
  })
  test('empty and malformed rows consume the scan budget and continue; invalid trace keeps the original numeric rollback', async () => {
    const f = await fixture()
    for (let i = 0; i < 201; i++)
      await harness.db
        .insert(taskExecutionObservationSources)
        .values({
          taskId: 'task',
          nodeRunId: 'run',
          evidenceJson:
            i === 0
              ? '{'
              : JSON.stringify({ invocationId: 'call', measurements: [], diagnostics: [] }),
        })
        .run()
    await f.writer.appendEvents({
      nodeRunId: 'run',
      events: [],
      observations: [
        { invocationId: 'call', measurements: [], diagnostics: [], spanFacts: [fact(1)] },
      ],
    })
    const first = await f.read(page)
    expect(first.records).toEqual([])
    expect(first.scannedSources).toBe(200)
    expect(first.issues).toContain('span-source-malformed')
    expect(first.nextCursor).not.toBeNull()
    expect((await f.read({ ...page, after: first.nextCursor })).records).toHaveLength(1)
    const before = await harness.db.select().from(nodeRunEvents)
    await expect(
      f.writer.appendEvents({
        nodeRunId: 'run',
        events: [
          {
            ts: 100,
            kind: 'text',
            payload: 'fixture',
            observation: {
              invocationId: 'call',
              measurements: [{ revision: 0 } as never],
              diagnostics: [],
              spanFacts: [fact(2)],
            },
          },
        ],
      }),
    ).rejects.toThrow()
    expect(await harness.db.select().from(nodeRunEvents)).toEqual(before)
  })
})
