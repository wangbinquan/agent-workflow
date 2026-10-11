// RFC-370 P01-P11: exercise actual provider composition, durable claims and driver ACKs.
// Ports outside this slice throw on use; no substitute claim, lifecycle or database is used.
import { afterEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { tasks, taskExecutionIntents, taskExecutionOwners, workflows } from '@/db/schema'
import {
  createProviderTaskExecutionModule,
  taskExecutionModule,
  type TaskExecutionModule,
} from '@/modules/task-execution/composition'
import {
  composePostgresqlTaskExecutionProviderRuntime,
  composeSqliteTaskExecutionProviderRuntime,
  type PostgresqlTaskExecutionProviderRuntimeDependencies,
  type SelectedTaskExecutionProviderRuntime,
  type SqliteTaskExecutionProviderRuntimeDependencies,
} from '@/modules/task-execution/composition/providerRuntime'
import {
  captureTaskDriveBinding,
  captureTaskExecutionProviderHostSelection,
  type TaskDriveBinding,
  type TaskExecutionProviderHostSelection,
} from '@/modules/task-execution/composition/taskDriveBinding'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { composeTaskCancellation } from '@/modules/task-execution/composition/taskCancellation'
import { createSqliteFusionEngineTaskOperations } from '@/modules/task-execution/infrastructure/fusionEngineTaskOperations'
import {
  activeTaskDriverController,
  awaitTaskDriverIdle,
  awaitTaskDriverReleasedSettled,
  clearTaskDriverLifecycleForTesting,
  isTaskDriverActive,
} from '@/modules/task-execution/infrastructure/taskDriverLifecycle'
import { taskOwnershipHostBinding } from '@/modules/task-execution/infrastructure/taskOwnershipPersistence'
import { taskEffectHostBinding } from '@/modules/task-execution/infrastructure/taskExecutionEffectPersistence'
import { DrizzleTaskExecutionIntentPersistence } from '@/modules/task-execution/infrastructure/taskExecutionIntentPersistence'
import {
  assertTaskExecutionContext,
  taskExecutionHostWriteCapture,
} from '@/modules/task-execution/application/taskExecutionContext'
import { createLogger } from '@/util/log'
import {
  createTaskDriveCoordinator,
  resumeTaskWithAtomicSideEffects,
  retryRepositoryPreparation,
  startTask,
  wakeHumanGateContinuation,
  type StartTaskDeps,
} from '@/services/task'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import {
  additionalTaskHostFixture,
  deferred,
  nextTurn,
  taskHostFixture,
} from './helpers/taskHostExecution'

const modules = new Set<TaskExecutionModule>()
afterEach(() => {
  clearTaskDriverLifecycleForTesting()
  for (const module of modules) module.resetForTesting()
  modules.clear()
})

/** Unexercised launch/resource collaborators must fail if composition tries to execute them. */
function unused<T>(name: string): T {
  return new Proxy(
    () => {
      throw new Error(`outside provider assembly test: ${name}`)
    },
    { get: (_target, key) => unused(`${name}.${String(key)}`) },
  ) as unknown as T
}

function providerGraph(
  harness: ProviderHarness,
  host?: TaskExecutionProviderHostSelection,
  runtimeOverrides: Record<string, unknown> = {},
  routesCalled: () => void = () => {},
): SelectedTaskExecutionProviderRuntime {
  const appHome = '/tmp/rfc370-task-provider-assembly'
  const runtime: SqliteTaskExecutionProviderRuntimeDependencies['runtime'] &
    PostgresqlTaskExecutionProviderRuntimeDependencies['runtime'] = {
    daemonGeneration: host?.daemonGeneration ?? 'native-provider-assembly',
    log: createLogger('rfc370-task-provider-assembly'),
    finalizeWorkspace: async () => {},
    taskRunBinding: { bind: unused('task runs') },
    observationInvocations: {
      accept: unused('observation invocation acceptance'),
      reconcile: unused('observation reconciliation'),
    },
    workspacePresence: unused('workspace presence'),
    runtimeSessionLeases: unused('runtime session leases'),
    memoryInjectionQueries: unused('memory injection queries'),
    runtimeRegistry: unused('runtime profiles'),
    nodeRunRuntime: unused('node run runtime'),
    taskDagCollaboration: unused('task DAG collaboration'),
    collaborationRuntime: unused('collaboration runtime'),
    workgroupTurns: unused('workgroup turns'),
    dynamicWorkflow: {
      persistence: unused('dynamic workflow persistence'),
      validationContext: unused('dynamic workflow validation'),
    },
    identityAccess: {
      delegatedRequests: unused('delegated requests'),
      taskExecutionResources: unused('task execution resources'),
    },
    repositoryPublicationTransport: unused('repository publication transport'),
    codeHostConnections: unused('code host connections'),
    processConcurrencyScope: harness.db,
    ...runtimeOverrides,
  }
  const routeWorkspace: PostgresqlTaskExecutionProviderRuntimeDependencies['routeWorkspace'] = {
    appHome,
    sourceContexts: unused('source contexts'),
    repositoryPreparation: {
      groupName: unused('repository group name'),
      legacy: {
        reclaim: unused('legacy repository reclaim'),
        prepare: unused('legacy repository prepare'),
        commit: unused('legacy repository commit'),
        cleanup: unused('legacy repository cleanup'),
      },
      prepareScratch: unused('scratch prepare'),
      restoreScratch: unused('scratch restore'),
      cleanupScratch: unused('scratch cleanup'),
      sourceSeal: unused('repository source seal'),
      sealedIdentity: unused('sealed repository identity'),
      snapshot: unused('repository snapshot'),
      nextAttempt: unused('repository next attempt'),
      effect: unused('repository preparation effect'),
    },
  }
  const routeLaunch: SqliteTaskExecutionProviderRuntimeDependencies['routeLaunch'] &
    PostgresqlTaskExecutionProviderRuntimeDependencies['routeLaunch'] = {
    configPath: `${appHome}/config.json`,
    agent: { resources: unused('agent resources'), integrity: unused('agent integrity') },
    workgroup: unused('workgroup resources'),
    coordinator: unused('root launch coordinator'),
    resourceAuthorityFor: unused('resource authority'),
    gitCommitIdentity: unused('git identity'),
    // SQLite consumes this within routeLaunch; PostgreSQL receives it at the root.
    routeWorkspace,
  }
  const routes: PostgresqlTaskExecutionProviderRuntimeDependencies['routes'] = () => {
    routesCalled()
    return {
      appHome,
      collaboration: unused('route collaboration'),
      owners: unused('owner identity queries'),
    }
  }
  const dependencies = {
    ...(host === undefined ? {} : { host }),
    runtime,
    routeLaunch,
    routes,
    rootResumeRuntime: unused<SqliteTaskExecutionProviderRuntimeDependencies['rootResumeRuntime']>(
      'root resume configuration',
    ),
    lifecycleRepair: {},
    fusion: { appHome },
  }
  const binding = harness.applicationBinding
  const graph =
    binding.provider === 'sqlite'
      ? composeSqliteTaskExecutionProviderRuntime(binding.db, {
          ...dependencies,
          repositoryPreparationRetry:
            unused<SqliteTaskExecutionProviderRuntimeDependencies['repositoryPreparationRetry']>(
              'repository retry',
            ),
        })
      : composePostgresqlTaskExecutionProviderRuntime(binding.db, {
          ...dependencies,
          routeWorkspace,
          workgroupTaskRoom: {
            collaboration: unused('workgroup room collaboration'),
          },
        })
  modules.add(graph.executionModule)
  return graph
}

async function selected(
  harness: ProviderHarness,
  options: Parameters<typeof taskHostFixture>[2] = {},
) {
  const h = await taskHostFixture(harness.db, `provider-${ulid()}`, {
    ...options,
    mode: harness.applicationBinding.provider === 'sqlite' ? 'direct' : 'provider',
  })
  modules.add(h.module)
  const selection: TaskExecutionProviderHostSelection = {
    daemonGeneration: `selected-${h.taskId}`,
    admission: h.host.admission,
    writes: h.binding,
  }
  const graph = providerGraph(harness, selection)
  if (graph.driveBinding === undefined) throw new Error('actual provider omitted selected binding')
  return { h, selection, graph, binding: graph.driveBinding }
}

function driveDeps(harness: ProviderHarness, binding: TaskDriveBinding): StartTaskDeps {
  return {
    db: harness.db as StartTaskDeps['db'],
    driveBinding: binding,
    appHome: '/tmp/rfc370-task-provider-assembly',
    binaryOverride: ['unused-runtime'],
    schedulerDriver: {
      drive: unused('scheduler'),
    },
  }
}

async function attach(binding: TaskDriveBinding, taskId: string, intentId: string) {
  const controller = new AbortController()
  const outcome = await binding.driverLifecycle.attach({ taskId, intentId, controller })
  if (outcome.kind !== 'attached') throw new Error('real provider driver failed to attach')
  assertTaskExecutionContext(outcome.attachment.execution)
  return { controller, execution: outcome.attachment.execution }
}

describeEachProvider('RFC-370 Task provider host assembly', (harness) => {
  test('P01 retains native provider identity, default return shape and PG installed slots', () => {
    const persistence = createTaskExecutionPersistence(harness.db)
    const module = createProviderTaskExecutionModule({
      daemonGeneration: 'native-slots',
      persistence,
    })
    modules.add(module)
    const sqlite = harness.applicationBinding.provider === 'sqlite'
    const graph = providerGraph(
      harness,
      undefined,
      sqlite ? {} : { persistence, executionModule: module },
    )
    expect(graph.executionModule).toBe(sqlite ? taskExecutionModule : module)
    if (!sqlite) expect(graph.persistence).toBe(persistence)
    expect(Object.hasOwn(graph, 'driveBinding')).toBe(false)
    expect(graph.executionModule.host).toBeUndefined()
  })

  test('P02/P05 constructs one selected pair without admission and keeps resource edits usable', async () => {
    const { h, graph, binding } = await selected(harness)
    expect(h.events).toEqual([])
    expect(binding.executionModule).toBe(graph.executionModule)
    expect(binding.persistence).toBe(graph.persistence)
    expect(graph.executionModule).not.toBe(taskExecutionModule)
    expect(graph.executionModule.host!.writes.port).toBe(h.binding.port)
    expect(taskOwnershipHostBinding(graph.persistence.ownership)).toBe(
      graph.executionModule.host!.writes,
    )
    expect(taskEffectHostBinding(graph.persistence.effects)).toBe(
      graph.executionModule.host!.writes,
    )
    expect(await harness.db.select().from(taskExecutionOwners)).toEqual([])
    await harness.db
      .update(workflows)
      .set({ name: 'resource remains editable' })
      .where(eq(workflows.id, `workflow-${h.taskId}`))
    expect((await harness.db.select().from(workflows))[0]?.name).toBe('resource remains editable')
    expect((await harness.db.select().from(taskExecutionIntents))[0]?.state).toBe('pending')
    expect(graph.participants.activity.isActive(h.taskId)).toBe(false)
    expect(h.events).toEqual([])
  })

  test('P03/P06 attaches and ACKs through the selected instance and actual provider context', async () => {
    const { h, graph, binding } = await selected(harness)
    const driver = await attach(binding, h.taskId, h.intentId)
    try {
      expect(driver.execution.persistence).toBe(graph.persistence)
      expect(driver.execution.token.daemonGeneration).toBe(`selected-${h.taskId}`)
      expect(driver.execution.legacyConnection).toBe(
        harness.applicationBinding.provider === 'sqlite' ? harness.db : undefined,
      )
      expect(taskExecutionHostWriteCapture(driver.execution)).toBeDefined()
      expect(graph.participants.activity.isActive(h.taskId)).toBe(true)
      expect(isTaskDriverActive(h.taskId)).toBe(false)
      expect(activeTaskDriverController(h.taskId, graph.executionModule)).toBe(driver.controller)
      expect(activeTaskDriverController(h.taskId)).toBeUndefined()
    } finally {
      await binding.driverLifecycle.releaseAndFinalize({
        taskId: h.taskId,
        controller: driver.controller,
      })
    }
    expect(h.completed).toBe(1)
    expect(graph.participants.activity.isActive(h.taskId)).toBe(false)
    expect((await harness.db.select().from(taskExecutionIntents))[0]?.state).toBe('completed')
    expect(graph.executionModule.host!.finalizations.snapshot()).toEqual([])
  })

  test.each([
    'daemonGeneration',
    'admission',
    'acquire',
    'writes',
    'port',
    'capture',
    'consumeNewWork',
    'consumeRecovery',
    'consumeIssuedAck',
    'transactionFor',
  ])('P04 rejects missing host %s before callbacks or SQL effects', async (field) => {
    const { h, selection } = await selected(harness)
    const admission = { ...selection.admission },
      port = { ...selection.writes.port }
    const writes = { ...selection.writes, port }
    const incomplete = { ...selection, admission, writes } as unknown as Record<string, unknown>
    const target =
      field === 'acquire'
        ? admission
        : ['capture', 'consumeNewWork', 'consumeRecovery', 'consumeIssuedAck'].includes(field)
          ? port
          : field === 'port' || field === 'transactionFor'
            ? writes
            : incomplete
    Reflect.deleteProperty(target, field)
    const recording = harness.recordStatements()
    let callbacks = 0
    try {
      expect(() =>
        providerGraph(
          harness,
          incomplete as unknown as TaskExecutionProviderHostSelection,
          {},
          () => callbacks++,
        ),
      ).toThrow('task-host-provider-selection-incomplete')
      expect(callbacks).toBe(0)
      expect(recording.statements).toEqual([])
      expect(h.events).toEqual([])
    } finally {
      recording.stop()
    }
  })

  test('P04 rejects PG selected overrides and retains the SQLite selected pair despite extra legacy fields', async () => {
    const { h, selection } = await selected(harness)
    const native = createTaskExecutionPersistence(harness.db)
    let callbacks = 0
    const run = () =>
      providerGraph(
        harness,
        selection,
        { persistence: native, executionModule: h.module },
        () => callbacks++,
      )
    if (harness.applicationBinding.provider === 'postgresql') {
      expect(run).toThrow('task-host-provider-overrides-incompatible')
      expect(callbacks).toBe(0)
    } else {
      const graph = run()
      const driver = await attach(graph.driveBinding!, h.taskId, h.intentId)
      try {
        expect(driver.execution.persistence).toBe(graph.persistence)
      } finally {
        await graph.driveBinding!.driverLifecycle.releaseAndFinalize({
          taskId: h.taskId,
          controller: driver.controller,
        })
      }
      expect(callbacks).toBe(1)
    }
  })

  test('P04 checks the PG process identity and preserves explicit SQLite process identity', async () => {
    const { h, selection } = await selected(harness)
    const run = () => providerGraph(harness, selection, { daemonGeneration: 'different-process' })
    if (harness.applicationBinding.provider === 'postgresql')
      expect(run).toThrow('task-host-daemon-generation-mismatch')
    else {
      const graph = run(),
        driver = await attach(graph.driveBinding!, h.taskId, h.intentId)
      try {
        expect(driver.execution.token.daemonGeneration).toBe(selection.daemonGeneration)
      } finally {
        await graph.driveBinding!.driverLifecycle.releaseAndFinalize({
          taskId: h.taskId,
          controller: driver.controller,
        })
      }
    }
  })

  test.each(['start', 'human', 'resume', 'repository-retry'] as const)(
    'P04/P07 rejects an incomplete %s short-lived binding before its first effect',
    async (entry) => {
      const { h, binding } = await selected(harness)
      const invalid = { ...binding, driverLifecycle: {} } as TaskDriveBinding
      const deps = driveDeps(harness, invalid),
        db = deps.db
      const recording = harness.recordStatements()
      try {
        const operation =
          entry === 'start'
            ? startTask({ workflowId: `workflow-${h.taskId}`, name: 'invalid' }, deps)
            : entry === 'human'
              ? wakeHumanGateContinuation(h.taskId, h.intentId, deps)
              : entry === 'resume'
                ? resumeTaskWithAtomicSideEffects(db, h.taskId, deps, unused('resume transaction'))
                : retryRepositoryPreparation(db, h.taskId, deps)
        await expect(operation).rejects.toThrow('task-drive-binding-incomplete')
        expect(recording.statements).toEqual([])
        expect(h.events).toEqual([])
      } finally {
        recording.stop()
      }
    },
  )

  test('P04 rejects explicit persistence or binding mismatch before configuration reads', async () => {
    const { binding } = await selected(harness)
    const deps = driveDeps(harness, binding)
    const native = createTaskExecutionPersistence(harness.db)
    const input = {
      deps,
      appHome: deps.appHome!,
      engineFailureMessage: 'test',
      failureReporter: { report: unused('failure report') },
      refreshLaunchConfig: unused('configuration refresh'),
    }
    expect(() => createTaskDriveCoordinator({ ...input, persistence: native })).toThrow(
      'task-drive-persistence-mismatch',
    )
    expect(() =>
      createTaskDriveCoordinator({ ...input, driveBinding: { ...binding, persistence: native } }),
    ).toThrow('task-drive-binding-mismatch')
    for (const field of ['executionModule', 'persistence', 'driverLifecycle'] as const) {
      const invalid = { ...binding }
      Reflect.deleteProperty(invalid, field)
      expect(() => captureTaskDriveBinding(invalid)).toThrow('task-drive-binding-incomplete')
    }
    for (const field of ['attach', 'releaseAndFinalize'] as const) {
      const lifecycle = { ...binding.driverLifecycle }
      Reflect.deleteProperty(lifecycle, field)
      expect(() => captureTaskDriveBinding({ ...binding, driverLifecycle: lifecycle })).toThrow(
        'task-drive-binding-incomplete',
      )
    }
    const providerBinding = harness.applicationBinding
    if (providerBinding.provider === 'sqlite')
      expect(() =>
        createSqliteFusionEngineTaskOperations({
          db: providerBinding.db,
          appHome: deps.appHome!,
          schedulerDriver: {
            drive: unused('fusion scheduler'),
            isTaskActive: unused('fusion activity'),
          },
          driveBinding: binding,
          startDeps: { driveBinding: { ...binding, persistence: native } },
        }),
      ).toThrow('task-drive-binding-mismatch')
    expect(() => captureTaskExecutionProviderHostSelection(null as never)).toThrow(
      'task-host-provider-selection-incomplete',
    )
    expect(() =>
      captureTaskExecutionProviderHostSelection({ daemonGeneration: ' ' } as never),
    ).toThrow('task-host-provider-selection-incomplete')
  })

  test('P06 keeps controller and idle waits isolated between actual provider module lifetimes', async () => {
    const one = await selected(harness)
    const two = providerGraph(harness, {
      ...one.selection,
      daemonGeneration: `other-${one.selection.daemonGeneration}`,
    })
    const driver = await attach(one.binding, one.h.taskId, one.h.intentId)
    let settled = false
    const waiting = awaitTaskDriverIdle(one.h.taskId, one.graph.executionModule).then(() => {
      settled = true
    })
    try {
      await awaitTaskDriverIdle(one.h.taskId, two.executionModule)
      await awaitTaskDriverReleasedSettled(one.h.taskId)
      await nextTurn()
      expect(settled).toBe(false)
      expect(activeTaskDriverController(one.h.taskId, two.executionModule)).toBeUndefined()
      expect(driver.controller.signal.aborted).toBe(false)
    } finally {
      await one.binding.driverLifecycle.releaseAndFinalize({
        taskId: one.h.taskId,
        controller: driver.controller,
      })
      await waiting
    }
    expect(settled).toBe(true)
    expect(one.h.completed).toBe(1)
  })

  test('P07 refreshes actual runtime configuration without replacing the captured execution binding', async () => {
    const { h, binding } = await selected(harness)
    const other = await additionalTaskHostFixture(h, `second-provider-${ulid()}`)
    let revision = 0
    const seen: { taskId: string; budget: number | undefined }[] = []
    const deps = driveDeps(harness, binding)
    deps.schedulerDriver = {
      ...deps.schedulerDriver,
      async drive(request) {
        assertTaskExecutionContext(request.executionContext)
        expect(request.executionContext.persistence).toBe(binding.persistence)
        expect(activeTaskDriverController(request.taskId, binding.executionModule)?.signal).toBe(
          request.signal,
        )
        seen.push({ taskId: request.taskId, budget: request.defaultNodeRetries })
      },
    }
    const coordinator = createTaskDriveCoordinator({
      deps,
      appHome: deps.appHome!,
      engineFailureMessage: 'test',
      failureReporter: { report: unused('failure report') },
      refreshLaunchConfig: () => ({
        defaultNodeRetries: ++revision,
        driveBinding: { ...binding, driverLifecycle: unused('replacement lifecycle') },
      }),
    })
    await coordinator.submit({
      taskId: h.taskId,
      intentId: h.intentId,
      completionMode: 'await-settle',
    })
    await coordinator.submit({
      taskId: other.taskId,
      intentId: other.intentId,
      completionMode: 'await-settle',
    })
    expect(seen).toEqual([
      { taskId: h.taskId, budget: 1 },
      { taskId: other.taskId, budget: 2 },
    ])
    expect(h.completed).toBe(2)
  })

  test('P08 waits for the selected owner ACK and deduplicates the exact durable gate successor', async () => {
    const { h, graph, binding } = await selected(harness)
    const old = await attach(binding, h.taskId, h.intentId)
    const successor = await new DrizzleTaskExecutionIntentPersistence(harness.db).submit({
      intentId: `successor-${h.taskId}`,
      admissionMode: 'successor-after-claimed',
      request: {
        taskId: h.taskId,
        kind: 'gate-continuation',
        source: 'internal',
        actorUserId: null,
        expectedTaskRevision: 1,
        scope: {
          executionLineageId: h.taskId,
          continuationSlotKey: `${h.taskId}:root:0`,
          slotPath: [
            { stableNodeKey: 'task-root', frozenOccurrenceKey: h.taskId, workflowRevision: 1 },
          ],
          operationGeneration: 0,
        },
        payload: { v: 1, event: 'resume' },
      },
    })
    const driven = deferred(),
      release = deferred()
    let drives = 0
    const deps = driveDeps(harness, binding)
    deps.schedulerDriver = {
      ...deps.schedulerDriver,
      async drive(request) {
        expect(request.executionContext?.intentId).toBe(successor.intentId)
        assertTaskExecutionContext(request.executionContext)
        expect(request.executionContext.persistence).toBe(graph.persistence)
        drives++
        driven.resolve()
        await release.promise
      },
    }
    try {
      await wakeHumanGateContinuation(h.taskId, successor.intentId, deps)
      await wakeHumanGateContinuation(h.taskId, successor.intentId, deps)
      await nextTurn()
      expect(drives).toBe(0)
      expect(h.completed).toBe(0)
      expect(old.controller.signal.aborted).toBe(false)
      await binding.driverLifecycle.releaseAndFinalize({
        taskId: h.taskId,
        controller: old.controller,
      })
      await driven.promise
      expect(h.completed).toBe(1)
      expect(drives).toBe(1)
    } finally {
      release.resolve()
      await awaitTaskDriverIdle(h.taskId, graph.executionModule)
    }
    expect(h.completed).toBe(2)
    expect(
      (
        await harness.db
          .select()
          .from(taskExecutionIntents)
          .where(eq(taskExecutionIntents.id, successor.intentId))
      )[0]?.state,
    ).toBe('completed')
  })

  test('P09 resume recognizes the selected active owner before continuation or rollback effects', async () => {
    const { h, graph, binding } = await selected(harness)
    const driver = await attach(binding, h.taskId, h.intentId)
    try {
      await expect(
        resumeTaskWithAtomicSideEffects(
          harness.db as StartTaskDeps['db'],
          h.taskId,
          driveDeps(harness, binding),
          unused('resume transaction'),
        ),
      ).rejects.toMatchObject({ code: 'task-not-resumable' })
      expect(activeTaskDriverController(h.taskId, graph.executionModule)).toBe(driver.controller)
      expect(driver.controller.signal.aborted).toBe(false)
      expect(await harness.db.select().from(taskExecutionIntents)).toHaveLength(1)
    } finally {
      await binding.driverLifecycle.releaseAndFinalize({
        taskId: h.taskId,
        controller: driver.controller,
      })
    }
  })

  test('P09 retains not-attached and terminal-won outcomes with the selected driver lifetime', async () => {
    const { h, graph, binding } = await selected(harness)
    const other = await additionalTaskHostFixture(h, `terminal-provider-${ulid()}`)
    await harness.db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, other.taskId))
    const deps = driveDeps(harness, binding)
    const coordinator = createTaskDriveCoordinator({
      deps,
      appHome: deps.appHome!,
      engineFailureMessage: 'test',
      failureReporter: { report: unused('failure report') },
      repositoryPreparation: { run: async () => ({ kind: 'terminal-won' }) },
    })
    expect(
      await coordinator.submit({
        taskId: other.taskId,
        intentId: other.intentId,
        completionMode: 'await-settle',
      }),
    ).toEqual({ kind: 'not-attached', taskId: other.taskId })
    expect(h.events).toEqual([])
    expect(
      await coordinator.submit({
        taskId: h.taskId,
        intentId: h.intentId,
        completionMode: 'await-settle',
      }),
    ).toEqual({ kind: 'settled', taskId: h.taskId })
    expect(h.completed).toBe(1)
    expect(graph.participants.activity.isActive(h.taskId)).toBe(false)
    expect(
      (
        await harness.db
          .select()
          .from(taskExecutionIntents)
          .where(eq(taskExecutionIntents.id, other.intentId))
      )[0]?.state,
    ).toBe('pending')
  })

  test('P10 selected fusion cancellation stops its actual driver and keeps terminal calls idempotent', async () => {
    const { h, graph, binding } = await selected(harness)
    const entered = deferred(),
      aborted = deferred()
    const deps = driveDeps(harness, binding)
    deps.schedulerDriver = {
      ...deps.schedulerDriver,
      async drive(request) {
        request.signal!.addEventListener('abort', () => aborted.resolve(), { once: true })
        entered.resolve()
        await aborted.promise
      },
    }
    const coordinator = createTaskDriveCoordinator({
      deps,
      appHome: deps.appHome!,
      engineFailureMessage: 'test',
      failureReporter: { report: unused('failure report') },
    })
    const driving = coordinator.submit({
      taskId: h.taskId,
      intentId: h.intentId,
      completionMode: 'await-settle',
    })
    await entered.promise
    try {
      await graph.fusion.cancel(h.taskId)
      await driving
      expect((await harness.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]?.status).toBe(
        'canceled',
      )
      expect(graph.participants.activity.isActive(h.taskId)).toBe(false)
      expect(h.completed).toBe(1)
      await graph.fusion.cancel(h.taskId)
      expect(h.completed).toBe(1)
    } finally {
      aborted.resolve()
      await driving
    }
  })

  test('P11 leaves authority loss and old admission ACK to the original Task/SO lifetime', async () => {
    const { h, graph, binding } = await selected(harness)
    const driver = await attach(binding, h.taskId, h.intentId)
    h.lose()
    await h.selected.context.drain(h.receipt)
    expect(driver.controller.signal.aborted).toBe(false)
    expect(h.completed).toBe(0)
    await binding.driverLifecycle.releaseAndFinalize({
      taskId: h.taskId,
      controller: driver.controller,
    })
    expect(h.completed).toBe(1)
    expect(graph.executionModule.host!.finalizations.snapshot()).toEqual([])
    const other = await additionalTaskHostFixture(h, `lost-provider-${ulid()}`)
    await expect(attach(binding, other.taskId, other.intentId)).rejects.toThrow()
    expect(
      (
        await harness.db
          .select()
          .from(taskExecutionIntents)
          .where(eq(taskExecutionIntents.id, other.intentId))
      )[0]?.state,
    ).toBe('pending')
    await harness.db
      .update(tasks)
      .set({ name: 'editable after authority loss' })
      .where(eq(tasks.id, other.taskId))
    expect((await harness.db.select().from(tasks).where(eq(tasks.id, other.taskId)))[0]?.name).toBe(
      'editable after authority loss',
    )
  })

  test('P10 selected cancellation captures the actual module and waits for its driver ACK', async () => {
    const { h, binding } = await selected(harness)
    const command = composeTaskCancellation(harness.db, binding)
    const driver = await attach(binding, h.taskId, h.intentId)
    // This command's stop waits for the real driver's ACK, so release only after its signal fires.
    const signal = deferred()
    driver.controller.signal.addEventListener('abort', () => signal.resolve(), { once: true })
    const canceling = command.cancel(h.taskId, { kind: 'user' })
    await signal.promise
    await binding.driverLifecycle.releaseAndFinalize({
      taskId: h.taskId,
      controller: driver.controller,
    })
    await canceling
    expect(driver.controller.signal.aborted).toBe(true)
    expect(h.completed).toBe(1)
  })

  test('P02 fixes original assembly callbacks and receivers without replacing the admission port', async () => {
    const { h, selection } = await selected(harness)
    const originalAdmission = selection.admission,
      originalWrites = selection.writes
    let acquisitions = 0,
      transactions = 0
    const admission = {
      acquire() {
        expect(this).toBe(admission)
        acquisitions++
        return originalAdmission.acquire()
      },
    }
    const writes = {
      port: originalWrites.port,
      transactionFor(tx: Parameters<typeof originalWrites.transactionFor>[0]) {
        expect(this).toBe(writes)
        transactions++
        return originalWrites.transactionFor(tx)
      },
    }
    const mutable = { ...selection, admission, writes }
    const graph = providerGraph(harness, mutable)
    admission.acquire = unused('replaced acquire')
    writes.transactionFor = unused('replaced transaction factory')
    mutable.admission = unused('replaced admission')
    mutable.writes = unused('replaced binding')
    expect(acquisitions).toBe(0)
    expect(transactions).toBe(0)
    const driver = await attach(graph.driveBinding!, h.taskId, h.intentId)
    try {
      expect(graph.executionModule.host!.writes.port).toBe(originalWrites.port)
      expect(acquisitions).toBe(1)
      expect(transactions).toBeGreaterThan(0)
    } finally {
      await graph.driveBinding!.driverLifecycle.releaseAndFinalize({
        taskId: h.taskId,
        controller: driver.controller,
      })
    }
    expect(h.completed).toBe(1)
  })
})
