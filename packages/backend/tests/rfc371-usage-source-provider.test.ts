// RFC-371: runtime source commit, projection commit and acknowledgement are distinct crash points.
import { expect, test } from 'bun:test'
import type {
  ObservationCapturedUsage,
  ObservationMeasurement,
  ObservationNativeCapture,
} from '@agent-workflow/shared'
import { nodeRunEvents, nodeRuns, tasks, taskExecutionObservationSources } from '../src/db/schema'
import { DrizzleNodeExecutionPersistence } from '../src/modules/task-execution/infrastructure/nodeExecutionPersistence'
import { composeObservationUsageSource } from '../src/modules/task-execution/composition/observationUsageSource'
import { createObservationInvocationStore } from '../src/modules/run-observability/infrastructure/invocationPersistence'
import { createUsageLedgerStore } from '../src/modules/run-observability/infrastructure/usageLedgerPersistence'
import { createUsageSourceProjection } from '../src/modules/run-observability/application/usageSourceProjection'
import { createUsageIngestion } from '../src/modules/run-observability/application/usageIngestion'
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
const completion = (
  nodeRunId = 'run',
  patch: Partial<ObservationNativeCapture> = {},
): ObservationCapturedUsage => ({
  invocationId: 'invocation-' + nodeRunId,
  measurements: [],
  diagnostics: [],
  capture: {
    contract: 'opencode-child-steps-v1',
    nativeSource: 'native-db',
    rootSessionId: 'native-root',
    state: 'complete',
    baseline: { kind: 'fresh', fingerprint: null },
    snapshotFingerprint: 'native-scan',
    observedAt: 200,
    scannedSessions: 1,
    scannedSteps: 0,
    issues: [],
    priorRevisions: [],
    ...patch,
  },
})

describeEachProvider('RFC-371 committed numeric source projection', (harness) => {
  async function fixture(hosted = false, nodeIds = ['run', 'other']) {
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
    for (const nodeRunId of nodeIds) {
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
        nativeCaptureContract: 'opencode-child-steps-v1',
        nativeCaptureSource: 'native-db',
        authority: hosted
          ? {
              kind: 'crewstation',
              sourceId: 'cs-installation',
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

  test('completion remains absent until every earlier numeric page commits, including a failed first projection', async () => {
    const f = await fixture()
    await f.writer.appendEvents({
      nodeRunId: 'run',
      events: [],
      observations: [evidence(), completion()],
    })
    const pending = await f.source.pending({ limit: 100 })
    expect(pending).toHaveLength(2)
    const fail = createUsageSourceProjection({
      ...f,
      store: {
        ...f.store,
        change: async () => {
          throw new Error('ledger unavailable')
        },
      },
    })
    await expect(fail()).rejects.toThrow('remains pending')
    expect(await f.store.captures(['invocation-run'])).toEqual([])
    expect(await f.source.pending({ limit: 100 })).toHaveLength(2)
    await f.project()
    expect((await f.store.records('task', { limit: 100 })).items).toHaveLength(1)
    expect(await f.store.captures(['invocation-run'])).toMatchObject([
      {
        sourceCursor: 'node-event:' + pending[1]!.id,
        priorRevisionGap: false,
        capture: { state: 'complete' },
      },
    ])
    expect(await f.store.cursor('local-node:run')).toBe('node-event:' + pending[1]!.id)
  })

  test('empty child capture commits and replays after a lost acknowledgement without inventing token records', async () => {
    const f = await fixture()
    await f.writer.appendEvents({ nodeRunId: 'run', events: [], observations: [completion()] })
    const failAck = createUsageSourceProjection({
      ...f,
      source: {
        ...f.source,
        acknowledge: async () => {
          throw new Error('ack unavailable')
        },
      },
    })
    await expect(failAck()).rejects.toThrow('remains pending')
    const proof = await f.store.captures(['invocation-run'])
    expect(proof[0]!.capture.state).toBe('complete')
    await f.project()
    expect(await f.store.captures(['invocation-run'])).toEqual(proof)
    expect((await f.store.records('task', { limit: 100 })).items).toEqual([])
    expect(await harness.db.select().from(nodeRunEvents).all()).toEqual([])
  })

  test('invalid final proof rolls back every numeric frame in the owner append transaction', async () => {
    const f = await fixture()
    await expect(
      f.writer.appendEvents({
        nodeRunId: 'run',
        events: [],
        observations: [evidence(), completion('run', { issues: ['native-scan-budget'] })],
      }),
    ).rejects.toThrow()
    expect(await f.source.pending({ limit: 100 })).toEqual([])
    expect(await f.store.captures(['invocation-run'])).toEqual([])
  })

  test('a resumed historical revision invalidates the earlier call in the same native root', async () => {
    const f = await fixture()
    await f.writer.appendEvents({
      nodeRunId: 'run',
      events: [],
      observations: [evidence(), completion()],
    })
    await f.project('run')
    expect((await f.store.captures(['invocation-run']))[0]!.priorRevisionGap).toBe(false)
    const before = { usage: measurement().usage, model: null }
    await f.writer.appendEvents({
      nodeRunId: 'other',
      events: [],
      observations: [
        completion('other', {
          state: 'partial',
          baseline: { kind: 'resume', fingerprint: 'before' },
          issues: ['native-prior-revision-gap'],
          priorRevisions: [
            {
              sessionId: 'child',
              stepId: 'old',
              before,
              after: { ...before, usage: { ...before.usage, input: '200' } },
            },
          ],
        }),
      ],
    })
    await f.project('other')
    const rows = await createUsageLedgerStore(harness.db).captures([
      'invocation-run',
      'invocation-other',
    ])
    expect(rows.every((row) => row.priorRevisionGap)).toBe(true)
    const original = rows.find((row) => row.invocationId === 'invocation-other')!.capture
    if (original.contract !== 'opencode-child-steps-v1')
      throw new Error('Original legacy source changed contract')
    expect(original.priorRevisions[0]).toMatchObject({
      before: { usage: { input: '100' } },
      after: { usage: { input: '200' } },
    })
    expect((await f.store.records('task', { limit: 100 })).items[0]!.contribution.input).toBe('100')
  })

  for (const change of ['during-resume', 'between-invocations', 'late-model'] as const)
    test(
      'a proven original owner receives ' + change + ' evidence without charging the resumer',
      async () => {
        const f = await fixture(),
          first = {
            ...measurement(),
            recordId: 'opencode:step:old',
            scope: {
              root: 'native-root',
              session: 'child',
              parentSession: 'native-root',
              ancestors: ['native-root'],
              turn: 'first',
              turnIndex: 0,
              level: 'request' as const,
            },
          }
        await f.writer.appendEvents({
          nodeRunId: 'run',
          events: [],
          observations: [{ ...evidence(), measurements: [first] }, completion()],
        })
        await f.project('run')
        const old = { usage: first.usage, model: null },
          updated = {
            usage: { ...first.usage, input: change === 'late-model' ? '100' : '200' },
            model: change === 'late-model' ? { provider: 'native', id: 'actual' } : null,
          }
        const finish = completion('other', {
          state: change === 'between-invocations' ? 'complete' : 'partial',
          baseline: { kind: 'resume', fingerprint: 'baseline' },
          issues: change === 'between-invocations' ? [] : ['native-prior-revision-gap'],
          baselineSteps: [
            {
              stepId: 'old',
              sessionId: 'child',
              parentSessionId: 'native-root',
              ancestors: ['native-root'],
              before: change === 'between-invocations' ? updated : old,
              after: updated,
              scopeChanged: false,
            },
          ],
        })
        await f.writer.appendEvents({ nodeRunId: 'other', events: [], observations: [finish] })
        await f.project('other')
        const records = (await f.store.records('task', { limit: 100 })).items
        expect(records).toHaveLength(1)
        expect(records[0]).toMatchObject({
          measurement: { invocationId: 'invocation-run', model: updated.model },
          observedRevision: 2,
          contribution: updated.usage,
          complete: true,
        })
        const captures = await f.store.captures(['invocation-run', 'invocation-other'])
        expect(captures.every((row) => !row.priorRevisionGap)).toBe(true)
        expect(
          captures.find((row) => row.invocationId === 'invocation-other')!.resolutions,
        ).toMatchObject([
          { stepId: 'old', status: 'resolved', invocationId: 'invocation-run', reason: 'revised' },
        ])
      },
    )

  test('an original numeric source projected later automatically resolves a retained historical gap', async () => {
    const f = await fixture(),
      first = {
        ...measurement(),
        recordId: 'opencode:step:old',
        scope: {
          root: 'native-root',
          session: 'child',
          parentSession: 'native-root',
          ancestors: ['native-root'],
          turn: 'first',
          turnIndex: 0,
          level: 'request' as const,
        },
      }
    await f.writer.appendEvents({
      nodeRunId: 'run',
      events: [],
      observations: [{ ...evidence(), measurements: [first] }, completion()],
    })
    const before = { usage: first.usage, model: null }
    await f.writer.appendEvents({
      nodeRunId: 'other',
      events: [],
      observations: [
        completion('other', {
          baseline: { kind: 'resume', fingerprint: 'baseline' },
          baselineSteps: [
            {
              stepId: 'old',
              sessionId: 'child',
              parentSessionId: 'native-root',
              ancestors: ['native-root'],
              before,
              after: { ...before, usage: { ...before.usage, input: '200' } },
              scopeChanged: false,
            },
          ],
        }),
      ],
    })
    await f.project('other')
    expect((await f.store.captures(['invocation-other']))[0]!.priorRevisionGap).toBe(true)
    await f.project('run')
    expect((await f.store.captures(['invocation-run']))[0]!.priorRevisionGap).toBe(true)
    await f.project()
    expect((await f.store.records('task', { limit: 100 })).items[0]!.contribution.input).toBe('200')
    expect(
      (await f.store.captures(['invocation-run', 'invocation-other'])).every(
        (row) => !row.priorRevisionGap,
      ),
    ).toBe(true)
  })

  for (const conflict of ['scope', 'model'] as const)
    test(
      'a historical ' + conflict + ' conflict retains the gap and original numbers',
      async () => {
        const f = await fixture(),
          first = {
            ...measurement(),
            recordId: 'opencode:step:old',
            model: { provider: 'provider', id: 'model-one' },
            scope: {
              root: 'native-root',
              session: 'child',
              parentSession: 'native-root',
              ancestors: ['native-root'],
              turn: 'first',
              turnIndex: 0,
              level: 'request' as const,
            },
          }
        await f.writer.appendEvents({
          nodeRunId: 'run',
          events: [],
          observations: [{ ...evidence(), measurements: [first] }, completion()],
        })
        await f.project('run')
        const before = { usage: first.usage, model: first.model }
        await f.writer.appendEvents({
          nodeRunId: 'other',
          events: [],
          observations: [
            completion('other', {
              baseline: { kind: 'resume', fingerprint: 'before' },
              baselineSteps: [
                {
                  stepId: 'old',
                  sessionId: 'child',
                  parentSessionId: 'native-root',
                  ancestors: ['native-root'],
                  before,
                  after: {
                    usage: { ...before.usage, input: '200' },
                    model: {
                      provider: 'provider',
                      id: conflict === 'model' ? 'model-two' : 'model-one',
                    },
                  },
                  scopeChanged: conflict === 'scope',
                },
              ],
            }),
          ],
        })
        await f.project('other')
        expect((await f.store.records('task', { limit: 100 })).items[0]!.contribution.input).toBe(
          '100',
        )
        expect(
          (await f.store.captures(['invocation-run', 'invocation-other'])).every(
            (row) => row.priorRevisionGap,
          ),
        ).toBe(true)
        expect((await f.store.captures(['invocation-other']))[0]!.resolutions[0]!.reason).toBe(
          'native-' + (conflict === 'scope' ? 'scope-changed' : 'model-conflict'),
        )
      },
    )

  test('an older repair cannot roll back a newer proven native snapshot', async () => {
    const f = await fixture(),
      first = {
        ...measurement(),
        recordId: 'opencode:step:old',
        scope: {
          root: 'native-root',
          session: 'child',
          parentSession: 'native-root',
          ancestors: ['native-root'],
          turn: 'first',
          turnIndex: 0,
          level: 'request' as const,
        },
      }
    await f.writer.appendEvents({
      nodeRunId: 'run',
      events: [],
      observations: [{ ...evidence(), measurements: [first] }, completion()],
    })
    await f.project('run')
    const before = { usage: first.usage, model: null }
    await f.writer.appendEvents({
      nodeRunId: 'other',
      events: [],
      observations: [
        completion('other', {
          baseline: { kind: 'resume', fingerprint: 'before' },
          baselineSteps: [
            {
              stepId: 'old',
              sessionId: 'child',
              parentSessionId: 'native-root',
              ancestors: ['native-root'],
              before,
              after: { ...before, usage: { ...before.usage, input: '200' } },
              scopeChanged: false,
            },
          ],
        }),
      ],
    })
    await f.project('other')
    const receipt = (await f.store.captures(['invocation-other']))[0]!
    const watermark = Number(receipt.sourceCursor.slice('node-event:'.length)) + 1
    const ingest = createUsageIngestion(f.store)
    await ingest.ingest({
      sourceId: 'local-node:run',
      expectedCursor: await ingest.cursor('local-node:run'),
      nextCursor: 'node-event:' + watermark,
      nativeSource: 'native-db',
      nativeWatermark: watermark,
      events: [
        {
          eventId: 'newer-native',
          measurement: {
            ...first,
            revision: 3,
            model: { provider: 'actual', id: 'later-model' },
            usage: { ...first.usage, input: '300' },
          },
        },
      ],
    })
    await ingest.repairCapture(receipt)
    const rows = (await f.store.records('task', { limit: 100 })).items
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      observedRevision: 3,
      nativeWatermark: watermark,
      measurement: { model: { provider: 'actual', id: 'later-model' } },
      contribution: { input: '300' },
    })
    expect((await f.store.captures(['invocation-other']))[0]!.priorRevisionGap).toBe(false)
  })

  test('historical repair waits for the original final revisions and completion marker before allocating a revision', async () => {
    const f = await fixture(),
      first = {
        ...measurement(),
        recordId: 'opencode:step:old',
        scope: {
          root: 'native-root',
          session: 'child',
          parentSession: 'native-root',
          ancestors: ['native-root'],
          turn: 'first',
          turnIndex: 0,
          level: 'request' as const,
        },
      }
    await f.writer.appendEvents({
      nodeRunId: 'run',
      events: [],
      observations: [{ ...evidence(), measurements: [first] }],
    })
    await f.project('run')
    await f.writer.appendEvents({
      nodeRunId: 'run',
      events: [],
      observations: [
        {
          ...evidence(),
          measurements: [{ ...first, revision: 2, usage: { ...first.usage, input: '150' } }],
        },
        completion(),
      ],
    })
    const before = { usage: { ...first.usage, input: '150' }, model: null }
    await f.writer.appendEvents({
      nodeRunId: 'other',
      events: [],
      observations: [
        completion('other', {
          baseline: { kind: 'resume', fingerprint: 'before' },
          baselineSteps: [
            {
              stepId: 'old',
              sessionId: 'child',
              parentSessionId: 'native-root',
              ancestors: ['native-root'],
              before,
              after: { ...before, usage: { ...before.usage, input: '200' } },
              scopeChanged: false,
            },
          ],
        }),
      ],
    })
    await f.project('other')
    expect((await f.store.records('task', { limit: 100 })).items[0]).toMatchObject({
      observedRevision: 1,
      contribution: { input: '100' },
    })
    expect((await f.store.captures(['invocation-other']))[0]!.resolutions[0]!.reason).toBe(
      'native-owner-pending',
    )
    await f.project('run')
    await f.project()
    expect(await f.source.pending({ limit: 100 })).toEqual([])
    expect((await f.store.records('task', { limit: 100 })).items[0]).toMatchObject({
      observedRevision: 3,
      contribution: { input: '200' },
    })
    expect(
      (await f.store.captures(['invocation-run', 'invocation-other'])).every(
        (row) => !row.priorRevisionGap,
      ),
    ).toBe(true)
  })

  test('an unchanged newer native snapshot still advances the watermark before an older revision arrives', async () => {
    const f = await fixture(),
      first = {
        ...measurement(),
        recordId: 'opencode:step:old',
        scope: {
          root: 'native-root',
          session: 'child',
          parentSession: 'native-root',
          ancestors: ['native-root'],
          turn: 'first',
          turnIndex: 0,
          level: 'request' as const,
        },
      }
    await f.writer.appendEvents({
      nodeRunId: 'run',
      events: [],
      observations: [{ ...evidence(), measurements: [first] }, completion()],
    })
    await f.project('run')
    const ingest = createUsageIngestion(f.store),
      before = { usage: first.usage, model: null }
    const proof = (input: string) =>
      completion('other', {
        baseline: { kind: 'resume', fingerprint: 'baseline' },
        baselineSteps: [
          {
            stepId: 'old',
            sessionId: 'child',
            parentSessionId: 'native-root',
            ancestors: ['native-root'],
            before,
            after: { ...before, usage: { ...before.usage, input } },
            scopeChanged: false,
          },
        ],
      }).capture!
    for (const [name, watermark, count] of [
      ['newer', 10, '100'],
      ['older', 5, '200'],
    ] as const) {
      await ingest.ingest({
        sourceId: 'local-node:' + name,
        expectedCursor: null,
        nextCursor: 'node-event:' + watermark,
        nativeSource: 'native-db',
        nativeWatermark: watermark,
        events: [],
        capture: { invocationId: 'invocation-' + name, taskId: 'task', capture: proof(count) },
      })
    }
    const rows = (await f.store.records('task', { limit: 100 })).items
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      observedRevision: 2,
      nativeWatermark: 10,
      contribution: { input: '100' },
    })
    expect(
      (await f.store.captures(['invocation-newer', 'invocation-older'])).every(
        (row) => !row.priorRevisionGap,
      ),
    ).toBe(true)
  })

  test('repair and proof commit fail atomically, then recover through the retained source', async () => {
    const f = await fixture(),
      first = {
        ...measurement(),
        recordId: 'opencode:step:old',
        scope: {
          root: 'native-root',
          session: 'child',
          parentSession: 'native-root',
          ancestors: ['native-root'],
          turn: 'first',
          turnIndex: 0,
          level: 'request' as const,
        },
      }
    await f.writer.appendEvents({
      nodeRunId: 'run',
      events: [],
      observations: [{ ...evidence(), measurements: [first] }, completion()],
    })
    await f.project('run')
    const before = { usage: first.usage, model: null }
    await f.writer.appendEvents({
      nodeRunId: 'other',
      events: [],
      observations: [
        completion('other', {
          baseline: { kind: 'resume', fingerprint: 'before' },
          baselineSteps: [
            {
              stepId: 'old',
              sessionId: 'child',
              parentSessionId: 'native-root',
              ancestors: ['native-root'],
              before,
              after: { ...before, usage: { ...before.usage, input: '200' } },
              scopeChanged: false,
            },
          ],
        }),
      ],
    })
    const failProof = createUsageSourceProjection({
      ...f,
      store: {
        ...f.store,
        change: (source, work) =>
          f.store.change(source, (scope) =>
            work({
              ...scope,
              commitCapture: async () => {
                throw new Error('proof unavailable')
              },
            }),
          ),
      },
    })
    await expect(failProof('other')).rejects.toThrow('remains pending')
    expect((await f.store.records('task', { limit: 100 })).items[0]!.contribution.input).toBe('100')
    expect(await f.store.captures(['invocation-other'])).toEqual([])
    expect(await f.store.cursor('local-node:other')).toBeNull()
    await f.project('other')
    expect((await f.store.records('task', { limit: 100 })).items[0]!.contribution.input).toBe('200')
    expect((await f.store.captures(['invocation-other']))[0]!.priorRevisionGap).toBe(false)
  })

  test('an incomplete scan does not turn an unvisited old step into a root-wide deletion gap', async () => {
    const f = await fixture(),
      first = {
        ...measurement(),
        recordId: 'opencode:step:old',
        scope: {
          root: 'native-root',
          session: 'child',
          parentSession: 'native-root',
          ancestors: ['native-root'],
          turn: 'first',
          turnIndex: 0,
          level: 'request' as const,
        },
      }
    await f.writer.appendEvents({
      nodeRunId: 'run',
      events: [],
      observations: [{ ...evidence(), measurements: [first] }, completion()],
    })
    await f.project('run')
    await f.writer.appendEvents({
      nodeRunId: 'other',
      events: [],
      observations: [
        completion('other', {
          state: 'partial',
          snapshotFingerprint: null,
          issues: ['native-scan-budget'],
          baseline: { kind: 'resume', fingerprint: 'baseline' },
          baselineSteps: [
            {
              stepId: 'old',
              sessionId: 'child',
              parentSessionId: 'native-root',
              ancestors: ['native-root'],
              before: { usage: first.usage, model: null },
              after: null,
              afterObserved: false,
              scopeChanged: false,
            },
          ],
        }),
      ],
    })
    await f.project('other')
    expect(
      (await f.store.captures(['invocation-run', 'invocation-other'])).every(
        (row) => !row.priorRevisionGap,
      ),
    ).toBe(true)
    expect((await f.store.captures(['invocation-other']))[0]!.capture.state).toBe('partial')
  })

  for (const lateOwner of [false, true])
    test(
      'unchanged imported baseline is not a gap and late owner reconciliation is ' + lateOwner,
      async () => {
        const f = await fixture(),
          old = {
            ...measurement(),
            recordId: 'opencode:step:old',
            scope: {
              root: 'native-root',
              session: 'child',
              parentSession: 'native-root',
              ancestors: ['native-root'],
              turn: 'first',
              turnIndex: 0,
              level: 'request' as const,
            },
          }
        if (lateOwner)
          await f.writer.appendEvents({
            nodeRunId: 'run',
            events: [],
            observations: [{ ...evidence(), measurements: [old] }, completion()],
          })
        const observed = { usage: { ...old.usage, input: '200' }, model: null }
        await f.writer.appendEvents({
          nodeRunId: 'other',
          events: [],
          observations: [
            evidence('other'),
            completion('other', {
              baseline: { kind: 'resume', fingerprint: 'baseline' },
              baselineSteps: [
                {
                  stepId: 'old',
                  sessionId: 'child',
                  parentSessionId: 'native-root',
                  ancestors: ['native-root'],
                  before: observed,
                  after: observed,
                  scopeChanged: false,
                },
              ],
            }),
          ],
        })
        await f.project('other')
        expect((await f.store.captures(['invocation-other']))[0]!.priorRevisionGap).toBe(false)
        expect(await f.store.pendingCaptureRepairs(1)).toHaveLength(1)
        if (lateOwner) await f.project('run')
        await f.project()
        const rows = (await f.store.records('task', { limit: 100 })).items
        expect(rows).toHaveLength(lateOwner ? 2 : 1)
        if (lateOwner)
          expect(
            rows.find((row) => row.measurement.invocationId === 'invocation-run')!.contribution
              .input,
          ).toBe('200')
        expect((await f.store.captures(['invocation-other']))[0]!.priorRevisionGap).toBe(false)
      },
    )

  test('unknown fields in an already-applied repair replay once while another owner arrives later', async () => {
    const f = await fixture(false, ['run', 'other', 'late'])
    const first = {
      ...measurement(),
      recordId: 'opencode:step:old',
      model: { provider: 'actual', id: 'model' },
      scope: {
        root: 'native-root',
        session: 'child',
        parentSession: 'native-root',
        ancestors: ['native-root'],
        turn: 'first',
        turnIndex: 0,
        level: 'request' as const,
      },
    }
    const late = {
      ...measurement('late'),
      recordId: 'opencode:step:later',
      scope: { ...first.scope, turn: 'late' },
    }
    await f.writer.appendEvents({
      nodeRunId: 'run',
      events: [],
      observations: [{ ...evidence(), measurements: [first] }, completion()],
    })
    await f.project('run')
    await f.writer.appendEvents({
      nodeRunId: 'late',
      events: [],
      observations: [{ ...evidence('late'), measurements: [late] }, completion('late')],
    })
    const before = { usage: first.usage, model: first.model },
      otherBefore = { usage: late.usage, model: null }
    await f.writer.appendEvents({
      nodeRunId: 'other',
      events: [],
      observations: [
        completion('other', {
          baseline: { kind: 'resume', fingerprint: 'baseline' },
          baselineSteps: [
            {
              stepId: 'old',
              sessionId: 'child',
              parentSessionId: 'native-root',
              ancestors: ['native-root'],
              before,
              after: { usage: { ...before.usage, input: null }, model: null },
              scopeChanged: false,
            },
            {
              stepId: 'later',
              sessionId: 'child',
              parentSessionId: 'native-root',
              ancestors: ['native-root'],
              before: otherBefore,
              after: { ...otherBefore, usage: { ...otherBefore.usage, input: '200' } },
              scopeChanged: false,
            },
          ],
        }),
      ],
    })
    await f.project('other')
    const ingest = createUsageIngestion(f.store)
    await ingest.repairCapture((await f.store.pendingCaptureRepairs(1))[0]!)
    await f.project('late')
    await f.project()
    const rows = (await f.store.records('task', { limit: 100 })).items
    expect(rows.find((row) => row.measurement.invocationId === 'invocation-run')).toMatchObject({
      observedRevision: 2,
      measurement: { model: first.model },
      contribution: first.usage,
      complete: false,
    })
    expect(
      rows.find((row) => row.measurement.invocationId === 'invocation-late')!.contribution.input,
    ).toBe('200')
    expect((await f.store.captures(['invocation-other']))[0]!.priorRevisionGap).toBe(false)
    expect(
      (await f.store.captures(['invocation-other']))[0]!.resolutions.filter((row) => row.previous),
    ).toHaveLength(2)
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
  test('an unrelated empty sweep never substitutes for the requested node original EOF', async () => {
    const f = await fixture()
    await f.write('run')
    let entered!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const project = createUsageSourceProjection({
      ...f,
      source: {
        ...f.source,
        async pending(input) {
          if (input.nodeRunId === 'other') {
            entered()
            await blocked
          }
          return f.source.pending(input)
        },
      },
    })
    const unrelated = project('other')
    await started
    const requested = project('run')
    release()
    expect(await unrelated).toBe(0)
    expect(await requested).toBe(1)
    expect(await project('run')).toBe(0)
    expect(await f.source.pending({ nodeRunId: 'run', limit: 10 })).toEqual([])
    expect((await f.store.records('task', { limit: 10 })).items).toHaveLength(1)
  })
  test('numeric-only model refinement keeps the original stdout and one projected contribution', async () => {
    const { writer, write, project, store, source } = await fixture()
    await write()
    await project()
    const corrected = {
      ...evidence(),
      measurements: [{ ...measurement('run', 2), model: { provider: 'native', id: 'actual' } }],
    }
    await writer.appendEvents({ nodeRunId: 'run', events: [], observations: [corrected] })
    expect((await harness.db.select().from(nodeRunEvents).all()).length).toBe(1)
    expect((await source.pending({ limit: 100 })).length).toBe(1)
    await project()
    const rows = (await store.records('task', { limit: 20 })).items
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      observedRevision: 2,
      contribution: { input: '100' },
      measurement: { model: { provider: 'native', id: 'actual' } },
      issues: [],
    })
    await writer.appendEvents({ nodeRunId: 'run', events: [], observations: [corrected] })
    await project()
    expect((await store.records('task', { limit: 20 })).items).toEqual(rows)
  })
})
