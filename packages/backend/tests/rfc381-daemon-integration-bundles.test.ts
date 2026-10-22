// RFC-381: one passive session graph owns all integration state; MR termination stops the selected driver and cleanup failures never stall its stream.
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { createProviderHttpCompositionFixture } from './helpers/providerHttpComposition'
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import {
  createProviderTaskExecutionModule,
  taskExecutionModule,
} from '@/modules/task-execution/composition'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { composeWorkspaceMaintenanceCommand } from '@/modules/source-control/composition/workspaceMaintenance'
import type { WorkspaceMaintenanceFilesystem } from '@/modules/source-control/composition'
import { composeWebhookTerminalWorkspacePrunePolicy } from '@/modules/integration/composition/terminalWorkspaceCleanup'
import { registerTerminalWorkspacePrunePolicy } from '@/services/lifecycle'
import { collaborationCommittedEventCatalogJson } from '@/modules/collaboration/public/events'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { describeEachProvider } from './helpers/eachProvider'
import { integrationBundleFixture } from './helpers/daemonIntegrationBundles'
import { createSecretBoxFromKey } from '@/auth/secretBox'

const homes: string[] = []
function home() {
  const dir = mkdtempSync(join(tmpdir(), 'rfc381-bundles-'))
  homes.push(dir)
  return dir
}
afterEach(() => {
  registerTerminalWorkspacePrunePolicy(null)
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true })
})

async function seed(db: PersistenceDb) {
  const id = 'rfc381-mr-task'
  const slot = JSON.stringify([
    { stableNodeKey: 'task-root', frozenOccurrenceKey: id, workflowRevision: 1 },
  ])
  const { tasks, taskExecutionIntents, webhookMrControlEffects } = tablesOf(db)
  await insertOne(db, tasks, {
    id,
    name: id,
    workflowId: 'rfc381-wf',
    workflowSnapshot: '{"$schema_version":5,"inputs":[],"nodes":[],"edges":[]}',
    workflowVersion: 1,
    repoPath: '/rfc381/repo',
    worktreePath: '/rfc381/worktree',
    baseBranch: 'main',
    branch: id,
    status: 'running',
    inputs: '{}',
    startedAt: 1,
    runningSince: 1,
    executionLineageId: id,
    lineageSlotPathJson: slot,
    spaceKind: 'remote',
    webhookTriggerId: 'rfc381-trigger',
    sourceTerminationBinding: 'rfc381-binding',
    sourceTerminationLaunchRev: 1,
  })
  await insertOne(db, taskExecutionIntents, {
    id: 'rfc381-intent',
    taskId: id,
    kind: 'launch',
    state: 'pending',
    source: 'rest',
    requestHash: 'rfc381-hash',
    payloadJson: '{}',
    executionLineageId: id,
    continuationSlotKey: `${id}:root`,
    slotPathJson: slot,
    operationGeneration: 0,
    expectedTaskRevision: 1,
    createdAt: 1,
    updatedAt: 1,
  })
  await insertOne(db, webhookMrControlEffects, {
    id: 'rfc381-close',
    deliveryId: 'rfc381-delivery',
    endpointId: 'rfc381-endpoint',
    streamKey: 'mr:1',
    binding: 'rfc381-binding',
    revision: 2,
    observedEventType: 'mr_closed',
    kind: 'fence-closed',
    status: 'pending',
    nextAttemptAt: 1,
    createdAt: 1,
    updatedAt: 1,
  })
  return id
}

describeEachProvider('RFC-381 daemon integration bundles', (harness) => {
  test('all members are frozen, construction performs no SQL/timers, and sessions have separate state', async () => {
    const dir = home()
    const recording = harness.recordStatements()
    const timeout = spyOn(globalThis, 'setTimeout').mockImplementation((() => {
      throw new Error('composition timer')
    }) as unknown as typeof setTimeout)
    const interval = spyOn(globalThis, 'setInterval').mockImplementation(() => {
      throw new Error('composition interval')
    })
    let sessions: ReturnType<typeof integrationBundleFixture>[] = []
    try {
      sessions = [
        integrationBundleFixture(harness.db, dir),
        integrationBundleFixture(harness.db, dir),
      ]
      await Promise.resolve()
      expect(recording.statements).toHaveLength(0)
      for (const session of sessions) {
        for (const bundle of [
          session.scheduledTaskModules,
          session.integrationModules,
          session.fusionModules,
        ])
          expect(Object.isFrozen(bundle)).toBe(true)
        expect(Object.keys(session.scheduledTaskModules).sort()).toEqual([
          'resourceSnapshots',
          'scheduledTaskRuntime',
        ])
        expect(Object.keys(session.fusionModules).sort()).toEqual(['fusionOperations'])
        expect(Object.keys(session.integrationModules).sort()).toEqual(
          [
            'webhookTerminalControl',
            'webhookDispatcher',
            'webhookDeliveryPersistence',
            'webhookDeliveryRuntime',
            'webhookIngressPersistence',
            'webhookEndpointService',
            'webhookTriggerService',
            'eventAutomationWorkIntents',
            'eventAutomationContexts',
            'taskAutomationWorkStart',
            'employeeAutomationWorkStart',
            'eventCenter',
            'developmentApprovalGateway',
            'developmentToolConnections',
            'crewStationEvents',
            'finalizeClaimedWorkspace',
          ].sort(),
        )
        expect(session.integrationModules.webhookIngressPersistence).toBe(
          session.integrationModules.webhookDeliveryRuntime,
        )
        expect(session.fusionModules).not.toHaveProperty('launchConfiguration')
      }
      for (const member of [
        'webhookTerminalControl',
        'webhookDispatcher',
        'eventCenter',
        'eventAutomationContexts',
      ] as const)
        expect(sessions[0]!.integrationModules[member]).not.toBe(
          sessions[1]!.integrationModules[member],
        )
    } finally {
      timeout.mockRestore()
      interval.mockRestore()
      recording.stop()
      await Promise.all(sessions.map((s) => s.integrationModules.webhookTerminalControl.stop()))
    }
    const module = sessions[0]!.integrationModules.eventCenter
    await module.initialize()
    const { eventTypeCatalog } = tablesOf(harness.db)
    // The fifth package was absent from the old HTTP fallback. Its internal facts are
    // persisted but intentionally excluded from the public authoring catalog.
    const registered = await harness.db.select().from(eventTypeCatalog)
    const types = JSON.parse(collaborationCommittedEventCatalogJson).eventTypes as {
      eventTypeId: string
    }[]
    expect(types.length).toBeGreaterThan(0)
    for (const type of types)
      expect(registered).toContainEqual(
        expect.objectContaining({ eventTypeId: type.eventTypeId, catalogVisibility: 'internal' }),
      )
  })

  test('HTTP uses the injected session services, runtime and fusion persistence', async () => {
    const binding = harness.applicationBinding
    const dir = home(),
      token = 'x'.repeat(64)
    const graph = integrationBundleFixture(binding.db, dir)
    await graph.integrationModules.eventCenter.initialize()
    const endpointReads = spyOn(
      graph.integrationModules.webhookEndpointService.administration,
      'list',
    )
    const scheduleReads = spyOn(
      graph.scheduledTaskModules.scheduledTaskRuntime.operations.persistence,
      'list',
    )
    const fusionReads = spyOn(graph.fusionModules.fusionOperations.persistence, 'listSummaries')
    const eventReads = spyOn(graph.integrationModules.eventCenter.queries.catalog, 'catalogJson')
    const composition = await createProviderHttpCompositionFixture(harness, {
      appHome: dir,
      token,
      dbVersion: 1,
      secretBox: createSecretBoxFromKey(Buffer.alloc(32, 17)),
    })
    const http = composition.compose({
      scheduledTasks: graph.scheduledTaskModules,
      integration: graph.integrationModules,
      fusion: graph.fusionModules,
    })
    try {
      const app = http.app
      for (const path of [
        '/api/webhook-endpoints',
        '/api/scheduled-tasks',
        '/api/fusions',
        '/api/event-center/catalog',
      ]) {
        const response = await app.request(path, { headers: { authorization: `Bearer ${token}` } })
        expect(response.status, await response.clone().text()).toBe(200)
      }
      for (const call of [endpointReads, scheduleReads, fusionReads, eventReads])
        expect(call).toHaveBeenCalled()
    } finally {
      endpointReads.mockRestore()
      scheduleReads.mockRestore()
      fusionReads.mockRestore()
      eventReads.mockRestore()
      await composition.dispose()
      await graph.integrationModules.webhookTerminalControl.stop()
    }
  })

  test('MR close requests stop on the session registry and waits for released before succeeding', async () => {
    const taskId = await seed(harness.db)
    const persistence = createTaskExecutionPersistence(harness.db)
    const executionModule =
      harness.applicationBinding.provider === 'sqlite'
        ? taskExecutionModule
        : createProviderTaskExecutionModule({ daemonGeneration: 'rfc381-private', persistence })
    const claimed = await executionModule.claim({ db: harness.db, intentId: 'rfc381-intent' })
    const controller = new AbortController()
    expect(executionModule.runtimeRegistry.tryAttach({ ...claimed, controller })).toBe('attached')
    executionModule.claimGate.leave(claimed.permit)
    const stop = spyOn(executionModule.runtimeRegistry, 'requestStop')
    const stopped = Promise.withResolvers<void>()
    controller.signal.addEventListener(
      'abort',
      () => {
        // A driver releases after handling the abort, not synchronously inside requestStop.
        setTimeout(() => {
          executionModule.runtimeRegistry.release({
            token: claimed.token,
            controller,
            result: { kind: 'released' },
          })
          executionModule.runtimeRegistry.settle(claimed.token)
          stopped.resolve()
        }, 0)
      },
      { once: true },
    )
    const graph = integrationBundleFixture(harness.db, home(), {
      runtimeRegistry: executionModule.runtimeRegistry,
    })
    const recording = harness.recordStatements()
    try {
      // No heartbeat runs. Reconciliation can finish only if the selected registry is used.
      await graph.integrationModules.webhookTerminalControl.reconcileOnBoot()
      expect(controller.signal.aborted).toBe(true)
      await stopped.promise
      expect(stop).toHaveBeenCalled()
      const { tasks, webhookMrControlEffects, webhookMrControlTargets } = tablesOf(harness.db)
      expect((await harness.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe(
        'canceled',
      )
      expect((await harness.db.select().from(webhookMrControlEffects))[0]).toMatchObject({
        status: 'succeeded',
        lastError: null,
      })
      // PostgreSQL qualifies the table with its schema ("agent_workflow"."..."); SQLite does not.
      const receipts = recording.statements.filter((statement) =>
        /^insert into (?:["`]?\w+["`]?\.)?["`]?webhook_mr_control_targets["`]?\s/.test(
          statement.sql.toLowerCase(),
        ),
      )
      // The first sweep durably acknowledges the released driver. The worker's existing
      // second fixed-point sweep then records that no active owner remains.
      expect(receipts[0]?.values).toContain('released')
      expect((await harness.db.select().from(webhookMrControlTargets))[0]).toMatchObject({
        releaseOutcome: 'no-active-owner',
        error: null,
      })
    } finally {
      recording.stop()
      stop.mockRestore()
      executionModule.runtimeRegistry.release({
        token: claimed.token,
        controller,
        result: { kind: 'released' },
      })
      executionModule.runtimeRegistry.settle(claimed.token)
      await graph.integrationModules.webhookTerminalControl.stop()
    }
  })

  test('cleanup failure keeps the claim, completes the MR job and lets the next same-stream effect run', async () => {
    const taskId = await seed(harness.db)
    const persistence = createTaskExecutionPersistence(harness.db)
    let fail = true
    const filesystem: WorkspaceMaintenanceFilesystem = {
      exists: () => true,
      isMaterializingTask: () => false,
      removeWorkspace: async () => {
        if (fail) throw new Error('rfc381-cleanup-failure')
        return true
      },
      removeIsoContainer: async () => true,
      isMerged: async () => false,
      listScratchDirectories: () => [],
      listWorktreeLeaves: () => [],
      listIsoTaskIds: () => [],
      removeAgedPath: async () => false,
      runPartialCloneGc: async () => ({ scanned: 0, removed: 0 }),
    }
    const workspaceMaintenance = composeWorkspaceMaintenanceCommand({
      db: harness.db,
      appHome: home(),
      terminalMaintenance: persistence.terminalMaintenance,
      filesystem,
      isMaterializingTask: () => false,
      invalidateWorkspacePath() {},
    })
    registerTerminalWorkspacePrunePolicy(
      composeWebhookTerminalWorkspacePrunePolicy({ db: harness.db, enabled: () => true }),
    )
    const graph = integrationBundleFixture(harness.db, home(), { workspaceMaintenance })
    const { webhookMrControlEffects, tasks } = tablesOf(harness.db)
    await insertOne(harness.db, webhookMrControlEffects, {
      id: 'rfc381-reopen',
      deliveryId: 'rfc381-reopened',
      endpointId: 'rfc381-endpoint',
      streamKey: 'mr:1',
      binding: 'rfc381-binding',
      revision: 3,
      observedEventType: 'mr_opened',
      kind: 'clear-closed',
      status: 'pending',
      nextAttemptAt: 1,
      createdAt: 2,
      updatedAt: 2,
    })
    try {
      await graph.integrationModules.webhookTerminalControl.reconcileOnBoot()
      const effects = await harness.db.select().from(webhookMrControlEffects)
      expect(effects).toHaveLength(2)
      expect(effects.every((e) => e.status === 'succeeded' && e.lastError === null)).toBe(true)
      const row = (await harness.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
      expect(row.workspacePruningAt).not.toBeNull()
      expect(row.workspacePrunedAt).toBeNull()
      expect(row.sourceTerminationEffectRev).toBe(3)
      expect(
        await persistence.terminalMaintenance.listRecoverable({
          operation: 'workspace-gc',
          rootTaskId: taskId,
        }),
      ).toHaveLength(1)
      fail = false
      await workspaceMaintenance.finalizeClaimedWorkspace(taskId)
      expect(
        (await harness.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.workspacePrunedAt,
      ).not.toBeNull()
    } finally {
      await graph.integrationModules.webhookTerminalControl.stop()
    }
  })
})
