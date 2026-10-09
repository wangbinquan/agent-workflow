// RFC-370 N2: preparation and already-issued results reach their original SQL owners.
// Real provider transactions cover the mixed scheduler/wrapper paths; the finite source
// contract covers the large Agent/script coordinators without launching native processes.
import { afterEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, taskExecutionEffectAttempts, taskExecutionOwners } from '@/db/schema'
import {
  createTaskExecutionContext,
  runWithTaskExecutionContext,
} from '@/modules/task-execution/application/taskExecutionContext'
import {
  taskHostWorkCapture,
  taskHostWorkForToken,
} from '@/modules/task-execution/application/taskHostAdmission'
import {
  selectTaskNodeExecutionWrites,
  selectTaskNodeRunWrites,
} from '@/modules/task-execution/application/taskNodeWriteSelection'
import { resolveSchedulerRunRow } from '@/modules/task-execution/application/resolveSchedulerRunRow'
import { createProcessEffectAttemptObserver } from '@/modules/task-execution/application/processEffectObserver'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createWrapperRunLedger } from '@/modules/task-execution/composition/wrapperRunLifecycle'
import { createExecutionScopeIndex } from '@/modules/task-execution/domain/executionScope'
import { bindLocalAgentExecutionEffect } from '@/modules/task-execution/infrastructure/local/agentExecutionEffect'
import { createLocalProcessEffectProjection } from '@/modules/task-execution/infrastructure/local/processEffectProjection'
import type { TaskMechanicsState } from '@/services/execution/taskMechanicsState'
import { describeEachProvider } from './helpers/eachProvider'
import { taskHostFixture } from './helpers/taskHostExecution'

const modules: { resetForTesting(): void }[] = []
afterEach(() => {
  for (const module of modules) module.resetForTesting()
  modules.length = 0
})

async function callerFixture(
  db: ProviderNeutralDatabase,
  options: Parameters<typeof taskHostFixture>[2] = {},
) {
  const taskId = `node-callers-${ulid()}`
  const calls = { newWork: 0, issuedAck: 0 }
  const h = await taskHostFixture(db, taskId, {
    ...options,
    beforeNewWork() {
      calls.newWork++
      options.beforeNewWork?.()
    },
    beforeIssuedAck() {
      calls.issuedAck++
      options.beforeIssuedAck?.()
    },
  })
  modules.push(h.module)
  const claimed = await h.claim()
  h.module.claimGate.leave(claimed.permit)
  const work = taskHostWorkForToken(claimed.token)
  if (work === undefined) throw new Error('missing-original-caller-work')
  const context = createTaskExecutionContext({
    intentId: h.intentId,
    token: claimed.token,
    persistence: h.persistence,
    legacyConnection: db,
    compatibility: { db },
    hostWriteCapture: taskHostWorkCapture(work),
  })
  const runId = `01-${taskId}`
  await db.insert(nodeRuns).values({
    id: runId,
    taskId,
    nodeId: 'worker',
    status: 'running',
    envelopeNonce: 'original-envelope',
    consumedUpstreamRunsJson: '{"old":"source"}',
  })
  calls.newWork = 0
  calls.issuedAck = 0
  const rows = () =>
    db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId)).orderBy(nodeRuns.id)
  const owners = () =>
    db.select().from(taskExecutionOwners).where(eq(taskExecutionOwners.taskId, taskId))
  return { db, h, calls, context, runId, rows, owners }
}
type Fixture = Awaited<ReturnType<typeof callerFixture>>

async function resolve(f: Fixture, broadcasts: string[] = []) {
  return resolveSchedulerRunRow({
    lifecycle: selectTaskNodeRunWrites(f.h.persistence, 'preparation'),
    supersededLifecycle: selectTaskNodeRunWrites(f.h.persistence, 'issuedResults'),
    projections: selectTaskNodeExecutionWrites(f.h.persistence, 'preparation'),
    executionContext: f.context,
    taskId: f.h.taskId,
    nodeId: 'worker',
    containerRunId: null,
    iteration: 0,
    consumedUpstreamJson: '{"upstream":"received"}',
    rows: await f.rows(),
    inheritReviewIteration: true,
    clearAgentOverride: true,
    trackRetryIndex: true,
    broadcastPending: (id) => broadcasts.push(`pending:${id}`),
    broadcastCanceled: (id) => broadcasts.push(`canceled:${id}`),
  })
}

const fanoutDefinition: WorkflowDefinition = {
  $schema_version: 2,
  inputs: [],
  nodes: [{ id: 'fan', kind: 'wrapper-fanout', nodeIds: [] }],
  edges: [],
}
function wrapper(f: Fixture) {
  const scope = createExecutionScopeIndex(fanoutDefinition)
  const state = {
    taskId: f.h.taskId,
    definition: fanoutDefinition,
    containerOf: scope.parentOf,
    opts: { persistence: f.h.persistence, executionContext: f.context },
  } as unknown as TaskMechanicsState
  return {
    ledger: createWrapperRunLedger(state),
    request: {
      node: { id: 'fan', kind: 'wrapper-fanout' as const, nodeIds: [] },
      task: { taskId: f.h.taskId },
      scope: scope.wrapper('fan', 'wrapper-fanout'),
      containerRunId: null,
      iteration: 0,
      execution: {},
    },
  }
}

describeEachProvider('RFC-370 Task Node callers retain native transactions', (harness) => {
  test('native selection returns original ports and does not activate host writes', async () => {
    const native = createTaskExecutionPersistence(harness.db)
    expect(native.nodeWriteMode).toBeUndefined()
    expect(native.nodeWritePurposes).toBeUndefined()
    expect(selectTaskNodeRunWrites(native, 'preparation')).toBe(native.nodeRuns)
    expect(selectTaskNodeRunWrites(native, 'issuedResults')).toBe(native.nodeRuns)
    expect(selectTaskNodeExecutionWrites(native, 'preparation')).toBe(native.nodeExecution)
    expect(selectTaskNodeExecutionWrites(native, 'issuedResults')).toBe(native.nodeExecution)
  })

  test('selected callers receive the actual views, including an issued view without mint', async () => {
    const f = await callerFixture(harness.db)
    expect(f.h.persistence.nodeWriteMode).toBe('host-selected')
    const views = f.h.persistence.nodeWritePurposes!
    expect(selectTaskNodeRunWrites(f.h.persistence, 'preparation')).toBe(views.preparation.nodeRuns)
    expect(selectTaskNodeRunWrites(f.h.persistence, 'issuedResults')).toBe(
      views.issuedResults.nodeRuns,
    )
    expect('mint' in selectTaskNodeRunWrites(f.h.persistence, 'issuedResults')).toBe(false)
    expect(selectTaskNodeExecutionWrites(f.h.persistence, 'preparation')).toBe(
      views.preparation.nodeExecution,
    )
    expect(selectTaskNodeExecutionWrites(f.h.persistence, 'issuedResults')).toBe(
      views.issuedResults.nodeExecution,
    )
    const explicitViews = { ...f.h.persistence, nodeWriteMode: undefined }
    expect(selectTaskNodeRunWrites(explicitViews, 'issuedResults')).toBe(
      views.issuedResults.nodeRuns,
    )
    expect(selectTaskNodeExecutionWrites(explicitViews, 'preparation')).toBe(
      views.preparation.nodeExecution,
    )
    expect(f.calls).toEqual({ newWork: 0, issuedAck: 0 })
  })

  test('incomplete selected composition rejects before native SQL or row changes', async () => {
    const f = await callerFixture(harness.db)
    const before = { rows: await f.rows(), owners: await f.owners() }
    const incomplete = { ...f.h.persistence, nodeWritePurposes: undefined }
    const recording = harness.recordStatements()
    try {
      for (const purpose of ['preparation', 'issuedResults'] as const) {
        expect(() => selectTaskNodeRunWrites(incomplete, purpose)).toThrow(
          'task-node-write-purposes-not-composed',
        )
        expect(() => selectTaskNodeExecutionWrites(incomplete, purpose)).toThrow(
          'task-node-write-purposes-not-composed',
        )
      }
      expect(recording.statements).toEqual([])
    } finally {
      recording.stop()
    }
    expect({ rows: await f.rows(), owners: await f.owners() }).toEqual(before)
    expect(f.calls).toEqual({ newWork: 0, issuedAck: 0 })
  })

  test('pending-row adoption is preparation and keeps its original identity and fields', async () => {
    const f = await callerFixture(harness.db)
    await harness.db
      .update(nodeRuns)
      .set({ status: 'pending', retryIndex: 3, reviewIteration: 2 })
      .where(eq(nodeRuns.id, f.runId))
    const before = (await f.rows())[0]!
    const owners = await f.owners()
    const broadcasts: string[] = []
    const result = await resolve(f, broadcasts)
    expect(result).toMatchObject({ nodeRunId: f.runId, retryIndex: 3, adopted: false })
    expect(await f.rows()).toEqual([
      { ...before, consumedUpstreamRunsJson: '{"upstream":"received"}' },
    ])
    expect((await f.owners())[0]!.revision).toBe(owners[0]!.revision + 1)
    expect(f.calls).toEqual({ newWork: 1, issuedAck: 0 })
    expect(broadcasts).toEqual([`pending:${f.runId}`])
  })

  test('successor mint is preparation and inherits retry, review, frame and original inputs', async () => {
    const f = await callerFixture(harness.db)
    await harness.db
      .update(nodeRuns)
      .set({
        status: 'failed',
        retryIndex: 3,
        reviewIteration: 2,
        preSnapshot: 'original-snapshot',
        agentOverrideName: 'old override',
      })
      .where(eq(nodeRuns.id, f.runId))
    const before = (await f.rows())[0]!
    const owners = await f.owners()
    const broadcasts: string[] = []
    const result = await resolve(f, broadcasts)
    const rows = await f.rows()
    const next = rows.find((row) => row.id === result.nodeRunId)!
    expect(result.nodeRunId).not.toBe(f.runId)
    expect(result.retryIndex).toBe(4)
    expect(rows.find((row) => row.id === f.runId)).toEqual(before)
    expect(next).toMatchObject({
      taskId: f.h.taskId,
      nodeId: 'worker',
      status: 'pending',
      retryIndex: 4,
      reviewIteration: 2,
      containerRunId: null,
      iteration: 0,
      preSnapshot: 'original-snapshot',
      agentOverrideName: null,
      consumedUpstreamRunsJson: '{"upstream":"received"}',
      rerunCause: 'revival',
    })
    expect((await f.owners())[0]!.revision).toBe(owners[0]!.revision + 1)
    expect(f.calls).toEqual({ newWork: 1, issuedAck: 0 })
    expect(broadcasts).toEqual([`pending:${result.nodeRunId}`])
  })

  test('superseded pending result commits while loss blocks its new successor independently', async () => {
    const f = await callerFixture(harness.db)
    await harness.db.update(nodeRuns).set({ status: 'pending' }).where(eq(nodeRuns.id, f.runId))
    await harness.db
      .insert(nodeRuns)
      .values({ id: `02-${f.h.taskId}`, taskId: f.h.taskId, nodeId: 'worker', status: 'failed' })
    const before = await f.rows()
    const owners = await f.owners()
    const broadcasts: string[] = []
    f.h.lose()
    const recording = harness.recordStatements()
    try {
      await expect(resolve(f, broadcasts)).rejects.toThrow()
      expect(recording.statements.filter((s) => /^\s*commit\b/i.test(s.sql))).toHaveLength(1)
      expect(recording.statements.filter((s) => /^\s*rollback\b/i.test(s.sql))).toHaveLength(1)
    } finally {
      recording.stop()
    }
    const rows = await f.rows()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      ...before[0],
      status: 'canceled',
      finishedAt: expect.any(Number),
    })
    expect(rows[1]).toEqual(before[1])
    expect((await f.owners())[0]!.revision).toBe(owners[0]!.revision + 1)
    expect(f.calls).toEqual({ newWork: 1, issuedAck: 1 })
    expect(broadcasts).toEqual([`canceled:${f.runId}`])
  })

  test('failed superseded acknowledgement rolls back all rows and broadcasts before original retry', async () => {
    const rejection = new Error('original mixed scheduler acknowledgement failure')
    let fail = false
    const f = await callerFixture(harness.db, {
      beforeIssuedAck() {
        if (fail) throw rejection
      },
    })
    await harness.db.update(nodeRuns).set({ status: 'pending' }).where(eq(nodeRuns.id, f.runId))
    await harness.db
      .insert(nodeRuns)
      .values({ id: `02-${f.h.taskId}`, taskId: f.h.taskId, nodeId: 'worker', status: 'failed' })
    const before = { rows: await f.rows(), owners: await f.owners() }
    const broadcasts: string[] = []
    fail = true
    const recording = harness.recordStatements()
    try {
      await expect(resolve(f, broadcasts)).rejects.toBe(rejection)
      expect(recording.statements.some((s) => /^\s*rollback\b/i.test(s.sql))).toBe(true)
      expect(recording.statements.some((s) => /^\s*commit\b/i.test(s.sql))).toBe(false)
    } finally {
      recording.stop()
    }
    expect({ rows: await f.rows(), owners: await f.owners() }).toEqual(before)
    expect(broadcasts).toEqual([])
    expect(f.calls).toEqual({ newWork: 0, issuedAck: 1 })
    fail = false
    const result = await resolve(f, broadcasts)
    expect((await f.rows()).find((row) => row.id === f.runId)?.status).toBe('canceled')
    expect((await f.rows()).find((row) => row.id === result.nodeRunId)?.status).toBe('pending')
    expect((await f.owners())[0]!.revision).toBe(before.owners[0]!.revision + 2)
    expect(f.calls).toEqual({ newWork: 1, issuedAck: 2 })
    expect(broadcasts).toEqual([`canceled:${f.runId}`, `pending:${result.nodeRunId}`])
  })

  test('wrapper generation mint and mark-running each use preparation with the original frame', async () => {
    const f = await callerFixture(harness.db)
    const { ledger, request } = wrapper(f)
    const owners = await f.owners()
    const generation = await ledger.openGeneration('wrapper-fanout', request)
    expect(generation).toEqual({
      kind: 'wrapper-fanout',
      runId: expect.any(String),
      resumed: false,
      enteredRunning: true,
      previous: null,
    })
    expect((await f.rows()).find((row) => row.id === generation.runId)).toMatchObject({
      taskId: f.h.taskId,
      nodeId: 'fan',
      status: 'running',
      containerRunId: null,
      iteration: 0,
      rerunCause: 'wrapper-init',
    })
    expect(f.calls).toEqual({ newWork: 2, issuedAck: 0 })
    expect((await f.owners())[0]!.revision).toBe(owners[0]!.revision + 2)
  })

  test('wrapper resumption retains progress and loss rolls back its preparation', async () => {
    const f = await callerFixture(harness.db)
    const progress = '{"kind":"fanout","phase":"inner-running"}'
    await harness.db
      .update(nodeRuns)
      .set({ nodeId: 'fan', status: 'interrupted', wrapperProgressJson: progress })
      .where(eq(nodeRuns.id, f.runId))
    const { ledger, request } = wrapper(f)
    const generation = await ledger.openGeneration('wrapper-fanout', request)
    expect(generation.runId).toBe(f.runId)
    expect(generation.resumed).toBe(true)
    expect(generation.previous?.wrapperProgressJson).toBe(progress)
    expect((await f.rows())[0]!.wrapperProgressJson).toBe(progress)
    expect(f.calls).toEqual({ newWork: 1, issuedAck: 0 })
    await ledger.settle(generation, { rowStatus: 'interrupted', outcome: { kind: 'handoff' } })
    const before = { rows: await f.rows(), owners: await f.owners() }
    f.h.lose()
    await expect(ledger.openGeneration('wrapper-fanout', request)).rejects.toThrow()
    expect({ rows: await f.rows(), owners: await f.owners() }).toEqual(before)
    expect(f.calls).toEqual({ newWork: 2, issuedAck: 1 })
  })

  for (const status of ['interrupted', 'awaiting_human', 'awaiting_review'] as const) {
    test(`wrapper ${status} result settles after loss without preparing another generation`, async () => {
      const f = await callerFixture(harness.db)
      const progress = '{"kind":"fanout","phase":"inner-running"}'
      await harness.db
        .update(nodeRuns)
        .set({ nodeId: 'fan', wrapperProgressJson: progress })
        .where(eq(nodeRuns.id, f.runId))
      const owners = await f.owners()
      f.h.lose()
      const { ledger } = wrapper(f)
      const generation = {
        kind: 'wrapper-fanout' as const,
        runId: f.runId,
        resumed: true,
        enteredRunning: false,
        previous: null,
      }
      if (status === 'interrupted') {
        await ledger.settle(generation, { rowStatus: status, outcome: { kind: 'handoff' } })
      } else {
        await ledger.settle(generation, {
          rowStatus: status,
          outcome: { kind: status, summary: 'original parked result', message: status },
        })
      }
      expect((await f.rows())[0]).toMatchObject({
        id: f.runId,
        status,
        wrapperProgressJson: progress,
        finishedAt: null,
      })
      expect(f.calls).toEqual({ newWork: 0, issuedAck: 1 })
      expect((await f.owners())[0]!.revision).toBe(owners[0]!.revision + 1)
    })
  }

  for (const status of ['done', 'failed', 'canceled'] as const) {
    test(`wrapper ${status} result keeps terminal write and the distinct reuse cleanup`, async () => {
      const f = await callerFixture(harness.db)
      await harness.db
        .update(nodeRuns)
        .set({
          nodeId: 'fan',
          wrapperProgressJson: '{"kind":"fanout","reuseDisabled":true,"round":3}',
        })
        .where(eq(nodeRuns.id, f.runId))
      const owners = await f.owners()
      f.h.lose()
      const { ledger } = wrapper(f)
      await ledger.settle(
        {
          kind: 'wrapper-fanout',
          runId: f.runId,
          resumed: false,
          enteredRunning: true,
          previous: null,
        },
        {
          rowStatus: status,
          outcome: {
            kind: status === 'done' ? 'ok' : status,
            summary: 'original terminal result',
            message: status,
          },
        },
      )
      expect((await f.rows())[0]).toMatchObject({ status, finishedAt: expect.any(Number) })
      expect(JSON.parse((await f.rows())[0]!.wrapperProgressJson!)).toEqual({
        kind: 'fanout',
        round: 3,
      })
      expect(f.calls).toEqual({ newWork: 0, issuedAck: 2 })
      expect((await f.owners())[0]!.revision).toBe(owners[0]!.revision + 2)
    })
  }

  for (const managed of [false, true]) {
    test(`${managed ? 'managed' : 'unowned'} Agent receipt writes native fields once after dispatch loss`, async () => {
      const f = await callerFixture(harness.db)
      const owners = await f.owners()
      const binding = bindLocalAgentExecutionEffect({
        materialRef: 'material:original',
        command: () => ['fixture-runtime'],
        workingDirectory: () => '/original-workspace',
        environment: () => ({}),
        stdin: () => ({ mode: 'ignore' }),
        taskEffect: {
          persistence: f.h.persistence.effects,
          nodeExecution: () => selectTaskNodeExecutionWrites(f.h.persistence, 'issuedResults'),
          argv: ['fixture-runtime'],
          cwd: '/original-workspace',
          resourceKeys: [],
        },
        // Existing native fixture seam: no OS child and no substitute SQL persistence.
        runNative: async (request) => {
          await request.beforeSpawn?.()
          f.h.lose()
          await request.onSpawned?.({
            pid: 123,
            spawnedAt: 71,
            spawnBinaryPath: 'fixture-runtime',
            launchNonce: 'original-nonce',
          })
          return {
            outcome: 'ok',
            exitCode: 0,
            pid: 123,
            launchNonce: 'original-nonce',
            rawStdout: 'original output',
            stderrTail: '',
            durationMs: 1,
          }
        },
      })
      const observer = managed
        ? createProcessEffectAttemptObserver({
            persistence: f.h.persistence.effects,
            taskId: f.h.taskId,
            nodeRunId: f.runId,
            processKind: 'agent',
            projection: binding.projection!,
            context: f.context,
          })
        : undefined
      if (managed) expect(observer).toBeDefined()
      const result = await runWithTaskExecutionContext(f.context, () =>
        binding.effect.submit({
          executionRef: binding.executionRef,
          materialRef: binding.materialRef,
          workspaceRef: binding.workspaceRef,
          ...(observer === undefined ? {} : { beforeStart: () => observer.beforeSpawn() }),
          onStarted: (receipt) =>
            observer === undefined
              ? binding.recordLegacyTaskReceipt(receipt, f.runId)
              : observer.recordSpawnReceipt(receipt),
        }),
      )
      expect(result).toMatchObject({ outcome: 'ok', exitCode: 0, rawStdout: 'original output' })
      expect((await f.rows())[0]).toMatchObject({
        pid: 123,
        spawnBinaryPath: 'fixture-runtime',
        spawnLaunchNonce: 'original-nonce',
        envelopeNonce: 'original-envelope',
      })
      expect(f.calls).toEqual({ newWork: managed ? 1 : 0, issuedAck: 1 })
      expect((await f.owners())[0]!.revision).toBe(owners[0]!.revision + (managed ? 2 : 1))
      const attempts = await harness.db.select().from(taskExecutionEffectAttempts)
      expect(attempts).toHaveLength(managed ? 1 : 0)
      if (managed) expect(attempts[0]?.state).toBe('acting')
    })
  }

  test('managed script receipt stays with its effect owner and retains runtime parameters', async () => {
    const f = await callerFixture(harness.db)
    const owners = await f.owners()
    const projection = createLocalProcessEffectProjection({
      persistence: f.h.persistence.effects,
      processKind: 'script',
      argv: ['fixture-script'],
      cwd: '/original-workspace',
      resourceKeys: [],
    })
    const observer = createProcessEffectAttemptObserver({
      persistence: f.h.persistence.effects,
      taskId: f.h.taskId,
      nodeRunId: f.runId,
      processKind: 'script',
      projection,
      context: f.context,
    })!
    await observer.beforeSpawn()
    f.h.lose()
    await observer.recordSpawnReceipt(
      { pid: 124, spawnBinaryPath: 'fixture-script', launchNonce: 'script-nonce' },
      '{"original":"runtime"}',
    )
    expect((await f.rows())[0]).toMatchObject({
      pid: 124,
      spawnBinaryPath: 'fixture-script',
      spawnLaunchNonce: 'script-nonce',
      runtimeParamsJson: '{"original":"runtime"}',
    })
    expect(f.calls).toEqual({ newWork: 1, issuedAck: 1 })
    expect((await f.owners())[0]!.revision).toBe(owners[0]!.revision + 2)
  })
})

// Frozen from the independently reviewed original callers, before source wiring.
// Each tuple identifies a business operation, method and purpose, not a line number.
const originalCallerPurposes: readonly string[] = [
  'application/taskAgentRun.ts|runNode|patch|preparation',
  'application/taskAgentRun.ts|runNode|set|issuedResults',
  'application/taskAgentRun.ts|runNode|patch|preparation',
  'application/taskAgentRun.ts|runNode|transition|preparation',
  'application/taskAgentRun.ts|runNode|appendEvent|preparation',
  'application/taskAgentRun.ts|runNode|set|issuedResults',
  'application/taskAgentRun.ts|runNode|set|issuedResults',
  'application/taskAgentRun.ts|runNode|set|issuedResults',
  'application/taskAgentRun.ts|runNode/makeEventBuffer|appendEvents|issuedResults',
  'application/taskAgentRun.ts|runNode/flushSpanFacts|appendEvents|issuedResults',
  'application/taskAgentRun.ts|runNode/consumeInventoryPayload|patch|issuedResults',
  'application/taskAgentRun.ts|runNode/persistStderrLine|appendEvent|issuedResults',
  'application/taskAgentRun.ts|runNode|appendEvents|issuedResults',
  'application/taskAgentRun.ts|runNode|set|issuedResults',
  'application/taskAgentRun.ts|runNode|retagSessionEpochs|issuedResults',
  'application/taskAgentRun.ts|runNode|upsertOutputs|issuedResults',
  'application/taskAgentRun.ts|runNode|set|issuedResults',
  'application/taskAgentRun.ts|runNode|patch|issuedResults',
  'application/taskAgentRun.ts|runNode|set|issuedResults',
  'composition/nodeMechanics.ts|executeWorkgroupHostMechanics|setRunStatus|issuedResults',
  'composition/nodeMechanics.ts|executeWorkgroupHostMechanics/early/lateSuppress|setRunStatus|issuedResults',
  'composition/nodeMechanics.ts|resolveMergeConflicts/runAgent/sessionRunId|mintRun|preparation',
  'composition/nodeMechanics.ts|runCallWorkflowNode/resolvedCallRow|setRunStatus|preparation',
  'composition/nodeMechanics.ts|runCallWorkflowNode|transitionRunStatus|preparation',
  'composition/nodeMechanics.ts|runCallWorkflowNode|patch|preparation',
  'composition/nodeMechanics.ts|runCallWorkflowNode|patch|issuedResults',
  'composition/nodeMechanics.ts|runCallWorkflowNode/persistLedger|patch|issuedResults',
  'composition/nodeMechanics.ts|runCallWorkflowNode|upsertOutputs|issuedResults',
  'composition/nodeMechanics.ts|runCallWorkflowNode|setRunStatus|issuedResults',
  'composition/nodeMechanics.ts|failCallRow/ok|setRunStatus|issuedResults',
  'composition/nodeMechanics.ts|runCodeHostCallNode|setRunStatus|preparation',
  'composition/nodeMechanics.ts|runCodeHostCallNode/settle|setRunStatus|issuedResults',
  'composition/nodeMechanics.ts|runCodeHostCallNode|upsertOutputs|issuedResults',
  'composition/nodeMechanics.ts|runScriptNode|setRunStatus|issuedResults',
  'composition/nodeMechanics.ts|runScriptNode|mintRun|preparation',
  'composition/nodeMechanics.ts|runOneScriptAttempt|appendEvent|issuedResults',
  'composition/nodeMechanics.ts|runOneScriptAttempt|setRunStatus|issuedResults',
  'composition/nodeMechanics.ts|runOneScriptAttempt|setRunStatus|preparation',
  'composition/nodeMechanics.ts|runOneScriptAttempt/outcome|appendEvent|issuedResults',
  'composition/nodeMechanics.ts|runOneScriptAttempt/outcome|appendEvent|issuedResults',
  'composition/nodeMechanics.ts|runOneScriptAttempt|setRunStatus|issuedResults',
  'composition/nodeMechanics.ts|runOneScriptAttempt|appendEvent|issuedResults',
  'composition/nodeMechanics.ts|runOneScriptAttempt|setRunStatus|issuedResults',
  'composition/nodeMechanics.ts|runOneScriptAttempt|upsertOutputs|issuedResults',
  'composition/nodeMechanics.ts|runOneScriptAttempt|setRunStatus|issuedResults',
  'composition/nodeMechanics.ts|recordSkippedRun|patch|issuedResults',
  'composition/nodeMechanics.ts|recordSkippedRun|transitionRunStatus|issuedResults',
  'composition/nodeMechanics.ts|recordSkippedRun|transitionRunStatus|issuedResults',
  'composition/nodeMechanics.ts|recordSkippedRun|mintRun|preparation',
  'composition/nodeMechanics.ts|recordSkippedRun|transitionRunStatus|issuedResults',
  'composition/nodeMechanics.ts|runOutputNode/nrId|mintRun|preparation',
  'composition/nodeMechanics.ts|runInputNode/nrId|mintRun|preparation',
  'composition/nodeMechanics.ts|runCrossClarifyNode/failId|mintRun|preparation',
  'composition/nodeMechanics.ts|runCrossClarifyNode|setRunStatus|issuedResults',
  'composition/nodeMechanics.ts|runCrossClarifyNode/stopRunId|mintRun|preparation',
  'composition/nodeMechanics.ts|runCrossClarifyNode|setRunStatus|issuedResults',
  'composition/nodeMechanics.ts|runAgentSingleNode/prepareRetryAttempt|mintRun|preparation',
  'composition/nodeMechanics.ts|runAgentSingleNode/prepareRetryAttempt|appendEvent|preparation',
  'composition/nodeMechanics.ts|runAgentSingleNode/prepareRetryAttempt|appendEvent|preparation',
  'composition/nodeMechanics.ts|runAgentSingleNode/prepareRetryAttempt|appendEvent|preparation',
  'composition/nodeMechanics.ts|runAgentSingleNode/runOneAttempt|patch|issuedResults',
  'composition/nodeMechanics.ts|runAgentSingleNode/runOneAttempt|transitionRunStatus|issuedResults',
  'composition/wrapperMechanics.ts|createWrapperMechanicsPorts/data|patch|issuedResults',
  'composition/wrapperMechanics.ts|createWrapperMechanicsPorts/data/recordConsumed|patch|issuedResults',
  'composition/wrapperMechanics.ts|createWrapperMechanicsPorts/data/upsertOutput|upsertOutputs|issuedResults',
  'composition/wrapperMechanics.ts|dispatchFanoutShardAttempt|set|preparation',
  'composition/wrapperMechanics.ts|dispatchFanoutShardAttempt|patch|preparation',
  'composition/wrapperMechanics.ts|dispatchFanoutShardAttempt|mint|preparation',
  'composition/wrapperMechanics.ts|dispatchFanoutShardAttempt|set|issuedResults',
  'composition/wrapperMechanics.ts|dispatchFanoutAggregatorAttempt|set|preparation',
  'composition/wrapperMechanics.ts|dispatchFanoutAggregatorAttempt|mint|preparation',
  'composition/wrapperMechanics.ts|dispatchFanoutAggregatorAttempt|set|issuedResults',
  'composition/wrapperRunLifecycle.ts|settleTerminal|set|issuedResults',
  'composition/wrapperRunLifecycle.ts|createWrapperRunLedger/openGeneration|set|preparation',
  'composition/wrapperRunLifecycle.ts|createWrapperRunLedger/openGeneration/runId|mint|preparation',
  'composition/wrapperRunLifecycle.ts|createWrapperRunLedger/openGeneration|transition|preparation',
  'composition/wrapperRunLifecycle.ts|createWrapperRunLedger/settle|transition|issuedResults',
  'composition/wrapperRunLifecycle.ts|createWrapperRunLedger/settle|transition|issuedResults',
  'infrastructure/isolatedAgentRun.ts|persistPendingSubResolves|patch|issuedResults',
  'infrastructure/isolatedAgentRun.ts|persistPendingSubResolves|patch|issuedResults',
]

const callerFiles = [
  'application/taskAgentRun.ts',
  'composition/nodeMechanics.ts',
  'composition/wrapperMechanics.ts',
  'composition/wrapperRunLifecycle.ts',
  'infrastructure/isolatedAgentRun.ts',
  'composition/taskEngineApplication.ts',
] as const
function syntax(path: string) {
  const text = readFileSync(
    new URL(`../src/modules/task-execution/${path}`, import.meta.url),
    'utf8',
  )
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
}
function operation(node: ts.Node, source: ts.SourceFile): string {
  const names: string[] = []
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (
      (ts.isFunctionDeclaration(current) ||
        ts.isMethodDeclaration(current) ||
        ts.isVariableDeclaration(current)) &&
      current.name
    )
      names.push(current.name.getText(source))
  }
  return names.reverse().join('/')
}
function calls(source: ts.SourceFile): ts.CallExpression[] {
  const found: ts.CallExpression[] = []
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

test('all original 80 business actions retain their reviewed preparation or result purpose', () => {
  const actual: string[] = []
  const rawWrites: string[] = []
  for (const path of callerFiles) {
    const source = syntax(path)
    for (const call of calls(source)) {
      const expression = call.expression
      if (
        ts.isIdentifier(expression) &&
        ['setRunStatus', 'transitionRunStatus', 'mintRun'].includes(expression.text)
      ) {
        const purpose = call.arguments[2]
        expect(purpose && ts.isStringLiteral(purpose)).toBe(true)
        actual.push(
          `${path}|${operation(call, source)}|${expression.text}|${purpose && ts.isStringLiteral(purpose) ? purpose.text : 'missing'}`,
        )
      }
      if (!ts.isPropertyAccessExpression(expression)) continue
      if (
        /\.persistence\.(nodeRuns|nodeExecution)\.(patch|upsertOutputs|replaceOutputs|appendEvent|appendEvents|retagSessionEpochs|mint|transition|set)$/.test(
          expression.getText(source),
        )
      )
        rawWrites.push(`${path}:${expression.getText(source)}`)
      const receiver = expression.expression
      if (
        !ts.isCallExpression(receiver) ||
        !ts.isIdentifier(receiver.expression) ||
        !['selectTaskNodeRunWrites', 'selectTaskNodeExecutionWrites'].includes(
          receiver.expression.text,
        )
      )
        continue
      const purpose = receiver.arguments[1]
      if (!purpose || !ts.isStringLiteral(purpose)) continue // Three helper bodies forward their required purpose below.
      actual.push(`${path}|${operation(call, source)}|${expression.name.text}|${purpose.text}`)
    }
  }
  expect(originalCallerPurposes).toHaveLength(80)
  expect(actual.sort()).toEqual([...originalCallerPurposes].sort())
  expect(rawWrites).toEqual([])
}, 15_000)

test('mixed helpers, clarify events and forwarded receipts keep their explicit original purpose', () => {
  const source = syntax('composition/nodeMechanics.ts')
  const all = calls(source)
  const resolvers = all.filter(
    (call) => ts.isIdentifier(call.expression) && call.expression.text === 'resolveSchedulerRunRow',
  )
  expect(resolvers).toHaveLength(4)
  for (const [index, call] of resolvers.entries()) {
    const text = call.arguments[0]!.getText(source)
    const originalPersistence = index === 0 ? 'state.opts.persistence' : 'opts.persistence'
    expect(text).toContain(
      `lifecycle: selectTaskNodeRunWrites(${originalPersistence}, 'preparation')`,
    )
    expect(text).toContain(
      `supersededLifecycle: selectTaskNodeRunWrites(${originalPersistence}, 'issuedResults')`,
    )
    expect(text).toContain(
      `projections: selectTaskNodeExecutionWrites(${originalPersistence}, 'preparation')`,
    )
  }
  const clarify = all.filter(
    (call) =>
      ts.isIdentifier(call.expression) && call.expression.text === 'recordClarifyInlineEvent',
  )
  expect(clarify.map((call) => call.arguments[0]!.getText(source))).toEqual([
    "selectTaskNodeExecutionWrites(state.opts.persistence, 'preparation')",
    "selectTaskNodeExecutionWrites(state.opts.persistence, 'preparation')",
    "selectTaskNodeExecutionWrites(state.opts.persistence, 'issuedResults')",
  ])
  for (const helper of ['setRunStatus', 'transitionRunStatus', 'mintRun']) {
    const declaration = source.statements.find(
      (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === helper,
    )
    expect(declaration).toBeDefined()
    expect(declaration!.getText(source)).toContain(
      'selectTaskNodeRunWrites(state.opts.persistence, purpose)',
    )
  }
  const scriptReceipt = all.find(
    (call) =>
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === 'recordUnownedStart',
  )
  expect(scriptReceipt?.arguments[0]?.getText(source)).toContain(
    "persistence: selectTaskNodeExecutionWrites(opts.persistence, 'issuedResults')",
  )
  const agent = syntax('application/taskAgentRun.ts')
  const participant = calls(agent).find(
    (call) =>
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === 'bindExecutionParticipants',
  )
  expect(participant?.arguments[0]?.getText(agent)).toContain(
    "nodeExecution: () => selectTaskNodeExecutionWrites(opts.persistence, 'issuedResults')",
  )
  expect(agent.text).toContain('if (activeProcessEffect === undefined)')
  expect(agent.text).toContain('await activeProcessEffect.recordSpawnReceipt(receipt)')
  const engine = syntax('composition/taskEngineApplication.ts')
  expect(engine.text).toContain(
    "nodeRuns: selectTaskNodeRunWrites(opts.persistence, 'preparation')",
  )
}, 15_000)
