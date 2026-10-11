// RFC-370: resource recovery keeps the original boot and periodic kernels,
// consumes the selected purpose in each original write atom, and carries no
// admitted Task context. Actual SQLite/PostgreSQL persistence and host receipts
// are used; original H/L source fixtures, cases and budgets remain unchanged.
import { afterEach, expect, spyOn, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { DAEMON_RESTART_ERROR_SUMMARY, DEFAULT_CONFIG } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  committedEvents,
  nodeRuns,
  recoveryEvents,
  runtimeSessionLeases,
  taskExecutionEffectAttempts,
  taskExecutionEffects,
  taskExecutionIntents,
  taskExecutionLineageOperationRecords,
  tasks,
  workflows,
} from '@/db/schema'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { composeTaskExecutionProviderBackground } from '@/modules/task-execution/composition/providerBackground'
import type { TaskRecoveryWritePurposes } from '@/modules/task-execution/application/ports/taskRecoveryWritePurposes'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import { runTaskExecutionBootRecovery } from '@/modules/task-execution/composition/bootRecovery'
import { createLocalBootExecutionRecovery } from '@/modules/task-execution/infrastructure/local/bootExecutionRecovery'
import { createTaskHostWriteContextAdapter } from '@/modules/task-execution/infrastructure/hostExecutionWriteContext'
import type { TaskHostWriteBinding } from '@/modules/task-execution/infrastructure/hostExecutionWriteTransaction'
import type {
  TaskHostWriteContext,
  TaskHostWriteTransaction,
} from '@/modules/task-execution/application/ports/taskHostWriteContext'
import { currentTaskExecutionContext } from '@/modules/task-execution/application/taskExecutionContext'
import { selectTaskPeriodicRecoveryWrites } from '@/modules/task-execution/application/taskRecoveryWriteSelection'
import { createRuntimeSessionLeaseOperations } from '@/modules/task-execution/infrastructure/runtimeSessionLeaseOperations'
import { composeHostExecutionWriteContext } from '@/modules/system-operations/composition/hostExecutionWriteContext'
import { createExclusiveDaemonLockProof } from '@/modules/task-execution/domain/ownership'
import { buildCodeHostRecoveryDescriptor } from '@/modules/task-execution/domain/codeHostRecovery'
import { canonicalJson, type LineageSlot } from '@/modules/task-execution/domain/executionIntent'
import { operationFamilyKey, requestHash } from '@/modules/task-execution/domain/executionEffect'
import {
  databaseTransactionIsActive,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import { registerAfterCommitEventPump } from '@/platform/events/committed/runtime'
import { recordRecoveryEvent, recoveryCountersSnapshot } from '@/services/recovery'
import { DAEMON_CADENCE } from '@/services/daemonCadence'
import { describeEachProvider } from './helpers/eachProvider'
import { deferred, nextTurn, seedTaskHostIntent } from './helpers/taskHostExecution'
import {
  scheduledTaskRuntime,
  taskExecutionResourceBinding,
} from './helpers/integrationTriggerResourceBinding'
import { inverseTaskResourceRecoverySelections } from './helpers/taskResourceRecoveryStatementInverse'
import originalSources from './fixtures/rfc370-task-resource-recovery-original-sources.json'

const modules: { resetForTesting(): void }[] = []
afterEach(() => {
  registerAfterCommitEventPump(null)
  for (const module of modules) module.resetForTesting()
  modules.length = 0
})

test('R17 finite recovery inverse preserves the exact preceding H and L source oracles', () => {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  expect(originalSources.files).toHaveLength(3)
  for (const original of originalSources.files) {
    const text = readFileSync(new URL(`../../../${original.path}`, import.meta.url), 'utf8')
    const source = (content: string) =>
      ts.createSourceFile(original.path, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const restored = inverseTaskResourceRecoverySelections(source(text)).text
    expect(Buffer.byteLength(restored)).toBe(original.bytes)
    expect(sha(restored)).toBe(original.sha256)
    for (const edit of original.inverseEdits) {
      if (edit.introduced.length === 0) continue
      const changed = text.slice(0, edit.start) + '!' + text.slice(edit.start + 1)
      expect(() => inverseTaskResourceRecoverySelections(source(changed))).toThrow(
        'resource-recovery inverse unreviewed fragment',
      )
    }
    const untouched = text + '\n// unrelated source change must survive\n'
    expect(inverseTaskResourceRecoverySelections(source(untouched)).text).toBe(
      restored + '\n// unrelated source change must survive\n',
    )
  }
})
const SNAPSHOT = '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}'
type Purpose = 'boot' | 'periodic'

async function seedTask(db: ProviderNeutralDatabase, taskId = `resource-${ulid()}`) {
  const slotPath: readonly LineageSlot[] = [
    { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: 1 },
  ]
  await db.insert(workflows).values({
    id: `workflow-${taskId}`,
    name: taskId,
    description: '',
    definition: SNAPSHOT,
    version: 1,
    schemaVersion: 2,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: taskId,
    workflowId: `workflow-${taskId}`,
    workflowSnapshot: SNAPSHOT,
    workflowVersion: 1,
    repoPath: '/tmp/repo',
    worktreePath: `/tmp/worktree/${taskId}`,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: 100,
    executionLineageId: taskId,
    lineageSlotPathJson: canonicalJson(slotPath),
  })
  const intentId = `intent-${taskId}`
  await seedTaskHostIntent(db, taskId, intentId)
  return { taskId, intentId, slotPath }
}

async function fixture(db: ProviderNeutralDatabase) {
  const task = await seedTask(db)
  let current = true
  const selected = composeHostExecutionWriteContext(db)
  const grant = Object.freeze({
    generation: `resource-host-${task.taskId}`,
    reference: Object.freeze({}),
    current: () => current,
  })
  const receipt = await selected.context.prepare({
    context: grant,
    holder: `resource-holder-${task.taskId}`,
    expiresAt: Date.now() + 60_000,
  })
  const original = createTaskHostWriteContextAdapter(selected)
  const originalPort = original.port
  const transactions = new WeakMap<TaskHostWriteTransaction, DatabaseTransaction>()
  const calls: { purpose: Purpose; transaction: DatabaseTransaction }[] = []
  const controls: {
    before?: (purpose: Purpose, transaction: DatabaseTransaction) => Promise<void>
  } = {}
  const consume = async (
    purpose: Purpose,
    transaction: TaskHostWriteTransaction,
    writeReceipt: Parameters<TaskHostWriteContext['consumeRecovery']>[1],
  ) => {
    const tx = transactions.get(transaction)!
    expect(databaseTransactionIsActive(tx)).toBe(true)
    calls.push({ purpose, transaction: tx })
    await controls.before?.(purpose, tx)
    await (purpose === 'boot'
      ? originalPort.consumeRecovery.call(originalPort, transaction, writeReceipt)
      : originalPort.consumeNewWork.call(originalPort, transaction, writeReceipt))
  }
  const port: TaskHostWriteContext = {
    capture(input) {
      expect(this).toBe(port)
      return originalPort.capture.call(originalPort, input)
    },
    consumeRecovery(tx, writeReceipt) {
      expect(this).toBe(port)
      return consume('boot', tx, writeReceipt)
    },
    consumeNewWork(tx, writeReceipt) {
      expect(this).toBe(port)
      return consume('periodic', tx, writeReceipt)
    },
    consumeIssuedAck() {
      throw new Error('resource recovery borrowed an issued Task ACK')
    },
  }
  const binding: TaskHostWriteBinding = {
    port,
    transactionFor(tx) {
      expect(this).toBe(binding)
      const reference = original.transactionFor.call(original, tx)
      transactions.set(reference, tx)
      return reference
    },
  }
  const native = createTaskExecutionPersistence(db)
  const persistence = createTaskExecutionPersistence(db, { hostWrites: binding })
  const lockProof = createExclusiveDaemonLockProof({
    daemonGeneration: grant.generation,
    acquiredAt: Date.now(),
    lockReceiptDigest: 'e'.repeat(64),
  })
  const row = () => db.select().from(tasks).where(eq(tasks.id, task.taskId)).get()
  const intents = () =>
    db.select().from(taskExecutionIntents).where(eq(taskExecutionIntents.taskId, task.taskId)).all()
  const events = () =>
    db.select().from(committedEvents).where(eq(committedEvents.aggregateId, task.taskId)).all()
  const boot = () => persistence.recoveryWritePurposes!.boot(grant)
  const periodic = () => persistence.recoveryWritePurposes!.periodic(grant)
  async function crash() {
    const module = createProviderTaskExecutionModule({
      daemonGeneration: `old-daemon-${task.taskId}`,
      persistence: native,
    })
    modules.push(module)
    const claimed = await module.claimPersisted({ intentId: task.intentId, now: Date.now() })
    module.claimGate.leave(claimed.permit)
    const nodeRunId = `run-${task.taskId}`
    await db.insert(nodeRuns).values({
      id: nodeRunId,
      taskId: task.taskId,
      nodeId: 'worker',
      status: 'running',
      retryIndex: 0,
      iteration: 0,
      startedAt: 100,
    })
    return { nodeRunId, token: claimed.token }
  }
  return {
    ...task,
    db,
    grant,
    receipt,
    selected,
    binding,
    port,
    calls,
    controls,
    native,
    persistence,
    lockProof,
    row,
    intents,
    events,
    boot,
    periodic,
    crash,
    activate: () => selected.context.activate(receipt),
    lose: () => {
      current = false
    },
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
const processEvidence = { orphanReaperCompleted: true } as const

function background(f: Fixture) {
  const module = createProviderTaskExecutionModule({
    daemonGeneration: `background-${f.taskId}`,
    persistence: f.persistence,
  })
  modules.push(module)
  const scheduled = scheduledTaskRuntime(f.db)
  const identity = composeIdentityAccess(f.db)
  const runtime = {
    module,
    recovery: f.persistence.recoveryAdministration,
    recoveryWriteMode: 'host-selected' as const,
    recoveryWritePurposes: f.persistence.recoveryWritePurposes!,
    taskHasDriver: () => false,
    buildScheduleLaunch: () => async () => {
      throw new Error('unexpected schedule launch')
    },
    autoResume: {
      async run() {
        return { resumed: [], skipped: [] }
      },
    },
    lifecycleRepair: {
      async run() {
        return { repaired: [], skipped: [] }
      },
    },
  }
  const dependencies = {
    configuration: { read: async () => DEFAULT_CONFIG },
    scheduled: {
      operations: scheduled.operations,
      identityAccess: {
        delegatedRequests: identity.delegatedRequests,
        integrationTriggerResources: scheduled.integrationTriggerResources,
        taskExecutionResources: taskExecutionResourceBinding(f.db),
      },
    },
  }
  return { module, runtime, dependencies, control: composeTaskExecutionProviderBackground(runtime) }
}

type TimeoutSpy = ReturnType<typeof spyOn<typeof globalThis, 'setTimeout'>>
function firePeriodic(timeout: TimeoutSpy) {
  const index = timeout.mock.calls.findIndex(
    (args) => args[1] === DAEMON_CADENCE.orphanReconcileSupervisory,
  )
  const args = timeout.mock.calls[index]
  const result = timeout.mock.results[index]
  if (args === undefined || result === undefined || result.type !== 'return')
    throw new Error('missing periodic timer')
  clearTimeout(result.value)
  const [handler, , ...rest] = args
  if (typeof handler !== 'function') throw new Error('unexpected timer handler')
  Reflect.apply(handler, undefined, rest)
}

async function seedPeriodicOrphan(f: Fixture) {
  const nodeRunId = `periodic-${f.taskId}`
  await f.db.insert(nodeRuns).values({
    id: nodeRunId,
    taskId: f.taskId,
    nodeId: 'worker',
    status: 'running',
    startedAt: 100,
  })
  return nodeRunId
}

async function seedCodeHostEffect(f: Fixture, crashed: Awaited<ReturnType<Fixture['crash']>>) {
  const candidateId = `cancel-${f.taskId}`
  const pathJson = canonicalJson(f.slotPath)
  const descriptorJson = JSON.stringify(
    buildCodeHostRecoveryDescriptor(
      {
        provider: 'gitlab',
        action: 'pipeline.cancel',
        candidateId,
        method: 'POST',
        pathname: '/projects/group%2Frepo/pipelines/31/cancel',
        query: {},
        baseUrl: 'https://gitlab.example/api/v4',
        connectionGeneration: 'connection-1',
      },
      crashed.nodeRunId,
    ),
  )
  return f.native.effects.prepareAndAcquire({
    token: crashed.token,
    intentId: f.intentId,
    operationKey: `${f.taskId}:pipeline.cancel`,
    executionLineageId: f.taskId,
    operationFamilyKey: operationFamilyKey({
      executionLineageId: f.taskId,
      slotPath: f.slotPath,
      effectKind: 'code-host-mutation',
      stableActionOrdinal: 'pipeline.cancel',
    }),
    operationGeneration: 0,
    kind: 'code-host-mutation',
    requestHash: requestHash({ provider: 'gitlab', action: 'pipeline.cancel' }),
    slotPathJson: pathJson,
    slotPathDigest: requestHash(pathJson),
    candidateId: `${candidateId}:t1`,
    recoveryClass: 'R-STATE',
    recoveryDescriptorJson: descriptorJson,
    classifierVersion: 'rfc328-codehost-matrix-v1',
    transportPolicyVersion: 'rfc328-codehost-transport-v1',
    retryAuthority: 'none',
    resourceKeys: [`code-host:gitlab:${f.taskId}`],
    now: Date.now(),
  })
}

async function recoveryRows(f: Fixture) {
  return {
    owner: await f.native.ownership.read(f.taskId),
    task: await f.row(),
    intents: await f.intents(),
    attempts: await f.db
      .select()
      .from(taskExecutionEffectAttempts)
      .where(eq(taskExecutionEffectAttempts.intentId, f.intentId))
      .all(),
    effects: await f.db
      .select()
      .from(taskExecutionEffects)
      .where(eq(taskExecutionEffects.taskId, f.taskId))
      .all(),
    decisions: await f.db
      .select()
      .from(taskExecutionLineageOperationRecords)
      .where(eq(taskExecutionLineageOperationRecords.executionLineageId, f.taskId))
      .all(),
    runs: await f.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, f.taskId)).all(),
  }
}

describeEachProvider('RFC-370 Task resource recovery writes', (harness) => {
  test('R01 local boot keeps all four real steps without admitted Task work', async () => {
    const f = await fixture(harness.db)
    await f.crash()
    expect(currentTaskExecutionContext()).toBeUndefined()
    const report = await runTaskExecutionBootRecovery({
      persistence: f.persistence,
      recoveryGrant: f.grant,
      get runtimeSessionLeases(): never {
        throw new Error('selected boot used native lease fallback')
      },
      lockProof: f.lockProof,
      log: { info() {}, warn() {} },
    })
    expect(report.revokedTaskIds).toEqual([f.taskId])
    expect(report.reap).toEqual({ tasks: 1, runs: 1 })
    expect(report.repairedRuntimeLeases).toBe(0)
    expect(report.finalization).toEqual({
      releasedTaskIds: [f.taskId],
      outcomeUnknownTaskIds: [],
      recoveredProcessEffectIds: [],
      recoveredCodeHostEffectIds: [],
      retryAuthorizedCodeHostEffectIds: [],
    })
    expect((await f.native.ownership.read(f.taskId))?.state).toBe('released')
    expect(await f.row()).toMatchObject({ status: 'interrupted' })
    expect((await f.intents())[0]).toMatchObject({
      state: 'failed',
      failureCode: DAEMON_RESTART_ERROR_SUMMARY,
    })
    expect(f.calls.map((call) => call.purpose)).toEqual(Array(7).fill('boot'))
    expect(new Set(f.calls.map((call) => call.transaction)).size).toBe(7)
    expect(f.calls.every((call) => !databaseTransactionIsActive(call.transaction))).toBe(true)
    expect(currentTaskExecutionContext()).toBeUndefined()
  })

  test('R02 rejected boot CAS and lifecycle preserve complete original rows and events', async () => {
    const f = await fixture(harness.db)
    await f.crash()
    const boot = f.boot()
    const before = await recoveryRows(f)
    const error = new Error('resource write rejected')
    f.controls.before = async () => {
      throw error
    }
    await expect(boot.recovery.prepare({ lockProof: f.lockProof })).rejects.toBe(error)
    expect(await recoveryRows(f)).toEqual(before)
    f.controls.before = undefined
    await boot.recovery.prepare({ lockProof: f.lockProof })
    const revoked = await recoveryRows(f)
    const priorEvents = await f.events()
    f.controls.before = async () => {
      throw error
    }
    await expect(
      boot.operations.interruptBootOrphanTask({
        taskId: f.taskId,
        from: 'running',
        now: Date.now(),
        failureCode: 'rejected',
        errorMessage: 'original guard must roll back',
      }),
    ).rejects.toBe(error)
    expect(await recoveryRows(f)).toEqual(revoked)
    expect(await f.events()).toEqual(priorEvents)
  })

  test('R03 boot host wait precedes commit and original event publication', async () => {
    const f = await fixture(harness.db)
    const boot = f.boot()
    const entered = deferred(),
      release = deferred()
    let published = 0
    f.controls.before = async (_, tx) => {
      expect((await tx.select().from(tasks).where(eq(tasks.id, f.taskId)).get())?.status).toBe(
        'interrupted',
      )
      entered.resolve()
      await release.promise
    }
    registerAfterCommitEventPump({
      async publishNow(refs) {
        published++
        expect(refs).toHaveLength(1)
        expect(f.calls.every((call) => !databaseTransactionIsActive(call.transaction))).toBe(true)
        expect((await f.row())?.status).toBe('interrupted')
      },
      nudge() {},
    })
    const pending = boot.operations.interruptBootOrphanTask({
      taskId: f.taskId,
      from: 'running',
      now: Date.now(),
      failureCode: 'boot-test',
      errorMessage: 'original event ordering',
    })
    const observed = pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    try {
      await Promise.race([
        entered.promise,
        observed.then(() => {
          throw new Error('write settled before host wait')
        }),
      ])
      await nextTurn()
      expect(published).toBe(0)
      release.resolve()
      expect(await pending).toBe(true)
      expect(published).toBe(1)
      expect(await f.events()).toHaveLength(1)
    } finally {
      release.resolve()
      await observed
    }
  })

  test('R04 original node catch false rolls back the selected transition', async () => {
    const f = await fixture(harness.db)
    const runId = `node-${f.taskId}`
    await f.db
      .insert(nodeRuns)
      .values({ id: runId, taskId: f.taskId, nodeId: 'worker', status: 'running' })
    const before = await f.db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)).get()
    f.controls.before = async () => {
      throw new Error('node host rejection')
    }
    expect(await f.boot().operations.interruptNodeRun({ nodeRunId: runId, now: Date.now() })).toBe(
      false,
    )
    expect(await f.db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)).get()).toEqual(before)
  })

  test('R05 lease repair commits per original serializable release or discard', async () => {
    const f = await fixture(harness.db)
    for (const suffix of ['a', 'b']) {
      const runId = `lease-run-${suffix}-${f.taskId}`,
        sessionId = `session-${suffix}-${f.taskId}`
      await f.db.insert(nodeRuns).values({
        id: runId,
        taskId: f.taskId,
        nodeId: 'worker',
        status: 'interrupted',
        opencodeSessionId: sessionId,
      })
      await f.db.insert(runtimeSessionLeases).values({
        protocol: 'opencode',
        sessionId,
        taskId: f.taskId,
        nodeId: 'worker',
        createdNodeRunId: runId,
        leaseNodeRunId: runId,
        leaseNonceDigest: `nonce-${suffix}`,
        leasedAt: 100,
        resetPending: suffix === 'b',
      })
    }
    const rows = async (tx: ProviderNeutralDatabase | DatabaseTransaction = f.db) => ({
      leases: await tx
        .select()
        .from(runtimeSessionLeases)
        .orderBy(runtimeSessionLeases.sessionId)
        .all(),
      runs: await tx
        .select()
        .from(nodeRuns)
        .where(eq(nodeRuns.taskId, f.taskId))
        .orderBy(nodeRuns.id)
        .all(),
    })
    const boot = f.boot()
    let first: Awaited<ReturnType<typeof rows>> | undefined
    const error = new Error('second lease rejected')
    f.controls.before = async (_, tx) => {
      if (f.calls.length === 1) first = await rows(tx)
      else throw error
    }
    await expect(boot.runtimeSessionLeases.repairAfterOrphanReap()).rejects.toBe(error)
    expect(first).toBeDefined()
    expect(await rows()).toEqual(first!)
    expect(new Set(f.calls.map((call) => call.transaction)).size).toBe(2)
    f.controls.before = undefined
    expect(await boot.runtimeSessionLeases.repairAfterOrphanReap()).toBe(1)
    expect(
      await f.db
        .select()
        .from(runtimeSessionLeases)
        .where(eq(runtimeSessionLeases.taskId, f.taskId))
        .all(),
    ).toMatchObject([{ leaseNodeRunId: null, leaseNonceDigest: null }])
    expect(
      (await rows()).runs.find((run) => run.id.startsWith('lease-run-b'))?.opencodeSessionId,
    ).toBeNull()
    expect(await boot.runtimeSessionLeases.repairAfterOrphanReap()).toBe(0)
  })

  test('R06 periodic uses only active work and cannot mutate while draining', async () => {
    const f = await fixture(harness.db)
    await f.activate()
    const periodic = f.periodic()
    expect(currentTaskExecutionContext()).toBeUndefined()
    expect(
      await periodic.interruptPeriodicTaskIfIdle({
        taskId: f.taskId,
        now: Date.now(),
        failureCode: 'periodic-test',
      }),
    ).toBe(true)
    expect((await f.row())?.status).toBe('interrupted')
    expect(f.calls.map((call) => call.purpose)).toEqual(['periodic'])
    const next = await seedTask(f.db)
    await f.selected.context.drain(f.receipt)
    f.lose()
    await expect(
      periodic.interruptPeriodicTaskIfIdle({
        taskId: next.taskId,
        now: Date.now(),
        failureCode: 'after-loss',
      }),
    ).rejects.toThrow('host-execution-write-context-unavailable')
    expect((await f.db.select().from(tasks).where(eq(tasks.id, next.taskId)).get())?.status).toBe(
      'running',
    )
    expect(currentTaskExecutionContext()).toBeUndefined()
    expect(
      await f.native.runtimeLifecycle.trySet({
        taskId: next.taskId,
        to: 'interrupted',
        allowedFrom: ['running'],
        extra: { errorSummary: 'manual-resource-control' },
        now: Date.now(),
        reason: 'manual-control',
      }),
    ).toBe(true)
    expect((await f.db.select().from(tasks).where(eq(tasks.id, next.taskId)).get())?.status).toBe(
      'interrupted',
    )
  })

  test('R07 capture retains original port methods mapper and native receiver', async () => {
    const f = await fixture(harness.db)
    const boot = f.boot()
    const wrong = () => {
      throw new Error('late replacement used')
    }
    f.binding.transactionFor = wrong
    f.port.capture = wrong
    f.port.consumeRecovery = wrong
    f.persistence.runtimeLifecycle.trySet = wrong
    expect(
      await boot.operations.interruptBootOrphanTask({
        taskId: f.taskId,
        from: 'running',
        now: Date.now(),
        failureCode: 'captured',
        errorMessage: 'captured original methods',
      }),
    ).toBe(true)
    expect((await f.row())?.status).toBe('interrupted')
    expect(f.calls.map((call) => call.purpose)).toEqual(['boot'])
  })

  test('R08 missing selected grant or family is rejected before native recovery', async () => {
    const f = await fixture(harness.db)
    const input = {
      persistence: f.persistence,
      runtimeSessionLeases: createRuntimeSessionLeaseOperations(f.db),
      lockProof: f.lockProof,
      log: { info() {}, warn() {} },
    }
    expect(() => createLocalBootExecutionRecovery(input)).toThrow(
      'task-recovery-write-selection-incomplete',
    )
    expect(() =>
      createLocalBootExecutionRecovery({
        ...input,
        persistence: { ...f.persistence, recoveryWritePurposes: undefined },
        recoveryGrant: f.grant,
      }),
    ).toThrow('task-recovery-write-selection-incomplete')
    expect(() => selectTaskPeriodicRecoveryWrites(f.persistence, undefined)).toThrow(
      'task-recovery-write-selection-incomplete',
    )
    expect(() =>
      createLocalBootExecutionRecovery({ ...input, persistence: f.native, recoveryGrant: f.grant }),
    ).toThrow('task-recovery-write-selection-incomplete')
    expect(f.calls).toEqual([])
    expect((await f.row())?.status).toBe('running')
  })

  test('R09 boot recovery cannot use an active grant or publish a partial state', async () => {
    const f = await fixture(harness.db)
    await f.crash()
    const before = await recoveryRows(f)
    await f.activate()
    await expect(f.boot().recovery.prepare({ lockProof: f.lockProof })).rejects.toThrow(
      'host-execution-write-context-unavailable',
    )
    expect(await recoveryRows(f)).toEqual(before)
  })

  test('R10 code host probes stay outside the original write atoms and roll back after loss', async () => {
    const f = await fixture(harness.db)
    const crashed = await f.crash()
    await seedCodeHostEffect(f, crashed)
    const boot = f.boot()
    await boot.recovery.prepare({ lockProof: f.lockProof })
    await f.db.update(tasks).set({ status: 'interrupted' }).where(eq(tasks.id, f.taskId)).run()
    await f.db
      .update(nodeRuns)
      .set({ status: 'interrupted' })
      .where(eq(nodeRuns.id, crashed.nodeRunId))
      .run()
    const before = await recoveryRows(f)
    let probes = 0
    await expect(
      boot.recovery.finalize({
        lockProof: f.lockProof,
        processEvidence,
        codeHostProbe: async () => {
          probes++
          expect(databaseTransactionIsActive(f.db)).toBe(false)
          f.lose()
          return {
            kind: 'applied',
            proofCode: 'pipeline-canceled',
            responseStatus: 200,
            responseBody: '{"status":"canceled"}',
          }
        },
      }),
    ).rejects.toThrow('host-execution-write-context-unavailable')
    expect(probes).toBe(1)
    expect(await recoveryRows(f)).toEqual(before)
    expect(f.calls.map((call) => call.purpose)).toEqual(['boot', 'boot', 'boot'])
  })

  test('R11 outcome unknown and replay decisions roll back as one original closure', async () => {
    const f = await fixture(harness.db)
    const crashed = await f.crash()
    await seedCodeHostEffect(f, crashed)
    const boot = f.boot()
    await boot.recovery.prepare({ lockProof: f.lockProof })
    await f.db.update(tasks).set({ status: 'interrupted' }).where(eq(tasks.id, f.taskId)).run()
    await f.db
      .update(nodeRuns)
      .set({ status: 'interrupted' })
      .where(eq(nodeRuns.id, crashed.nodeRunId))
      .run()
    const before = await recoveryRows(f)
    const error = new Error('outcome closure host rejection')
    f.controls.before = async () => {
      if (f.calls.length === 4) throw error
    }
    const finalize = () =>
      boot.recovery.finalize({
        lockProof: f.lockProof,
        processEvidence,
        codeHostProbe: async () => ({
          kind: 'unknown',
          proofCode: 'unavailable',
          responseStatus: null,
          responseBody: '',
        }),
      })
    await expect(finalize()).rejects.toBe(error)
    expect(await recoveryRows(f)).toEqual(before)
    f.controls.before = undefined
    expect((await finalize()).outcomeUnknownTaskIds).toEqual([f.taskId])
    expect((await f.native.ownership.read(f.taskId))?.state).toBe('released')
    expect((await f.intents())[0]?.state).toBe('failed')
    expect((await recoveryRows(f)).effects[0]?.state).toBe('outcome-unknown')
    expect(
      (await recoveryRows(f)).decisions.some((row) => row.decisionState === 'requires-actor'),
    ).toBe(true)
  })

  test('R12 recovered release rejects atomically and the same purpose can retry', async () => {
    const f = await fixture(harness.db)
    await f.crash()
    const boot = f.boot()
    await boot.recovery.prepare({ lockProof: f.lockProof })
    await f.db.update(tasks).set({ status: 'interrupted' }).where(eq(tasks.id, f.taskId)).run()
    await f.db
      .update(nodeRuns)
      .set({ status: 'interrupted' })
      .where(eq(nodeRuns.taskId, f.taskId))
      .run()
    const before = await recoveryRows(f)
    const error = new Error('release host rejection')
    f.controls.before = async () => {
      if (f.calls.length === 4) throw error
    }
    await expect(boot.recovery.finalize({ lockProof: f.lockProof, processEvidence })).rejects.toBe(
      error,
    )
    expect(await recoveryRows(f)).toEqual(before)
    f.controls.before = undefined
    expect(
      (await boot.recovery.finalize({ lockProof: f.lockProof, processEvidence })).releasedTaskIds,
    ).toEqual([f.taskId])
    expect((await f.intents())[0]?.state).toBe('failed')
    expect((await f.native.ownership.read(f.taskId))?.state).toBe('released')
  })

  test('R13 recovery event uses its own atom and preserves best effort service behavior', async () => {
    const f = await fixture(harness.db)
    const boot = f.boot()
    const beforeCounter = recoveryCountersSnapshot()['boot-reap'] ?? 0
    f.controls.before = async () => {
      throw new Error('event host rejection')
    }
    await recordRecoveryEvent(boot.operations, {
      taskId: f.taskId,
      kind: 'boot-reap',
      reason: 'still best effort',
    })
    expect(
      await f.db.select().from(recoveryEvents).where(eq(recoveryEvents.taskId, f.taskId)).all(),
    ).toEqual([])
    f.controls.before = undefined
    await recordRecoveryEvent(boot.operations, {
      taskId: f.taskId,
      kind: 'boot-reap',
      reason: 'retry succeeds',
    })
    expect(
      await f.db.select().from(recoveryEvents).where(eq(recoveryEvents.taskId, f.taskId)).all(),
    ).toMatchObject([{ reason: 'retry succeeds', kind: 'boot-reap' }])
    expect(f.calls.map((call) => call.purpose)).toEqual(['boot', 'boot'])
    expect(recoveryCountersSnapshot()['boot-reap']).toBe(beforeCounter + 2)
  })

  test('R14 background captures the recovery family and grant before its startup read', async () => {
    const f = await fixture(harness.db)
    const nodeRunId = await seedPeriodicOrphan(f)
    await f.activate()
    const b = background(f)
    const entered = deferred(),
      release = deferred()
    let selections = 0
    const original = b.runtime.recoveryWritePurposes
    const family: TaskRecoveryWritePurposes = {
      boot: original.boot.bind(original),
      periodic(grant) {
        expect(this).toBe(family)
        expect(grant).toBe(f.grant)
        selections++
        return original.periodic.call(original, grant)
      },
    }
    b.runtime.recoveryWritePurposes = family
    const authority = { current: () => true, recoveryGrant: f.grant }
    const timeout = spyOn(globalThis, 'setTimeout')
    let clock: ReturnType<typeof spyOn<typeof Date, 'now'>> | undefined
    const start = b.control.startAuthority(
      {
        ...b.dependencies,
        configuration: {
          async read() {
            entered.resolve()
            await release.promise
            return { ...DEFAULT_CONFIG, autoResumeOnBoot: false, periodicOrphanReconcileMs: 1 }
          },
        },
      },
      authority,
    )
    const observed = start.then(
      (handle) => ({ handle }),
      (error: unknown) => ({ error }),
    )
    try {
      await Promise.race([
        entered.promise,
        observed.then(() => {
          throw new Error('startup settled before selected read')
        }),
      ])
      expect(selections).toBe(1)
      const wrong = () => {
        throw new Error('late family replacement used')
      }
      family.periodic = wrong
      b.runtime.recoveryWritePurposes = { boot: wrong, periodic: wrong }
      authority.recoveryGrant = { ...f.grant, reference: {} }
      authority.current = wrong
      release.resolve()
      await start
      clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 1_000)
      firePeriodic(timeout)
      await b.control.awaitIdle()
      expect(
        (await f.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).get())?.status,
      ).toBe('interrupted')
      expect((await f.row())?.status).toBe('interrupted')
      expect(f.calls.map((call) => call.purpose)).toEqual([
        'periodic',
        'periodic',
        'periodic',
        'periodic',
      ])
      expect(selections).toBe(1)
      expect(currentTaskExecutionContext()).toBeUndefined()
    } finally {
      release.resolve()
      await observed
      await b.control.stop()
      clock?.mockRestore()
      timeout.mockRestore()
    }
  })

  test('R15 incomplete selected background has no startup reads loops or native fallback', async () => {
    const f = await fixture(harness.db)
    const b = background(f)
    let reads = 0
    const dependencies = {
      ...b.dependencies,
      configuration: {
        async read() {
          reads++
          return DEFAULT_CONFIG
        },
      },
    }
    const timeout = spyOn(globalThis, 'setTimeout')
    try {
      await expect(b.control.startAuthority(dependencies, { current: () => true })).rejects.toThrow(
        'task-recovery-write-selection-incomplete',
      )
      await expect(b.control.start(dependencies)).rejects.toThrow(
        'task-recovery-write-selection-incomplete',
      )
      expect(reads).toBe(0)
      expect(timeout).not.toHaveBeenCalled()
      expect(b.module.claimGate.isPaused).toBe(false)
      expect(f.calls).toEqual([])
      expect((await f.row())?.status).toBe('running')
    } finally {
      await b.control.stop()
      timeout.mockRestore()
    }
  })

  test('R16 an in flight periodic read drains and its original node catch rolls back after loss', async () => {
    const f = await fixture(harness.db)
    const nodeRunId = await seedPeriodicOrphan(f)
    await f.activate()
    const b = background(f)
    const entered = deferred(),
      release = deferred()
    const original = b.runtime.recoveryWritePurposes
    b.runtime.recoveryWritePurposes = {
      boot: original.boot.bind(original),
      periodic(grant) {
        const operations = original.periodic.call(original, grant)
        return {
          ...operations,
          async listPeriodicReconcileCandidates(before) {
            const result = await operations.listPeriodicReconcileCandidates.call(operations, before)
            entered.resolve()
            await release.promise
            return result
          },
        }
      },
    }
    const timeout = spyOn(globalThis, 'setTimeout')
    let clock: ReturnType<typeof spyOn<typeof Date, 'now'>> | undefined
    try {
      const lifetime = await b.control.startAuthority(
        {
          ...b.dependencies,
          configuration: {
            read: async () => ({
              ...DEFAULT_CONFIG,
              autoResumeOnBoot: false,
              periodicOrphanReconcileMs: 1,
            }),
          },
        },
        { current: f.grant.current, recoveryGrant: f.grant },
      )
      clock = spyOn(Date, 'now').mockReturnValue(Date.now() + 1_000)
      firePeriodic(timeout)
      const idle = b.control.awaitIdle()
      const observedIdle = idle.then(
        () => undefined,
        (error: unknown) => {
          throw error
        },
      )
      await Promise.race([
        entered.promise,
        observedIdle.then(() => {
          throw new Error('tick settled before selected read')
        }),
      ])
      await f.selected.context.drain(f.receipt)
      f.lose()
      let drained = false
      const quiesce = lifetime.quiesceAuthorityLoss().then(() => {
        drained = true
      })
      await nextTurn()
      expect(drained).toBe(false)
      await expect(
        b.control.startAuthority(b.dependencies, { current: () => true, recoveryGrant: f.grant }),
      ).rejects.toThrow('task-provider-execution-authority-drain-pending')
      release.resolve()
      await idle
      await quiesce
      await lifetime.drain()
      expect(drained).toBe(true)
      expect((await f.row())?.status).toBe('running')
      expect(
        (await f.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).get())?.status,
      ).toBe('running')
      expect(f.calls.map((call) => call.purpose)).toEqual(['periodic'])
      expect(await f.events()).toEqual([])
      expect(currentTaskExecutionContext()).toBeUndefined()
    } finally {
      release.resolve()
      await b.control.stop()
      clock?.mockRestore()
      timeout.mockRestore()
    }
  })
})
