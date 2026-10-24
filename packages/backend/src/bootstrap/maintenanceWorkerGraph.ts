import { composeCrossContextClosure } from './crossContextClosure'
import { composeSourceControlTaskPorts } from '@/modules/task-execution/composition'
// RFC-389 — one passive in-thread graph; provider differences live in the adapter table.
import { join } from 'node:path'
import {
  composeWorkspacePreparationMaintenance,
  createWorkerWorkspaceMaintenanceCommand,
} from '@/modules/task-execution/composition/workspacePreparationMaintenance'
import { composeRepositoryPreparation } from '@/modules/source-control/composition/repositoryPreparation'
import { createTokenCallAudit } from '@/auth/composition'
import { openDb } from '@/db/client'
import { composeIntentApplyRecoveryScene } from '@/modules/intent/composition/applyMaintenance'
import { createAtomicApplyRecovery } from '@/platform/atomic-apply/convergence'
import type { AtomicApplyRecoveryScene } from '@/platform/contracts/atomicApply'
import { composeIntentMaintenanceCommandsForDatabase } from '@/modules/intent/composition/maintenance'
import { composeDevelopmentAutomationMaintenanceCommands } from '@/modules/development-automation/composition'
import { composeDigitalEmployeeMaintenanceCommands } from '@/modules/digital-employee/composition'
import { createDrizzleTaskArchiveMaintenanceCommand } from '@/modules/task-execution/composition/taskArchiveMaintenance'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { composePluginGenerationGcCommand } from '@/modules/resource-catalog/composition/pluginGenerationGc'
import { composeResourcePackageApplyMaintenance } from '@/modules/resource-catalog/composition/resourcePackageMaintenance'
import { composeWebhookDeliveryPersistenceFor } from '@/modules/integration/composition/webhookDelivery'
import { composeIntegrationMaintenanceCommands } from '@/modules/integration/composition/maintenance'
import { composeWorkspaceMaintenanceCommand } from '@/modules/source-control/composition/workspaceMaintenance'
import { createMaintenanceRunStore } from '@/platform/persistence/maintenanceRunStore'
import { createMaintenanceExecutionFence } from '@/modules/task-execution/composition/maintenanceExecutionFence'
import { createTaskNodeEventArchiveStore } from '@/modules/task-execution/composition'
import { composeRetentionSweepPhases } from './retentionSweepPhases'
import { checkpointSqliteWal } from '@/platform/persistence/sqlite/systemMaintenanceOperations'
import { createPostgresqlDatabaseOperationalAdapter } from '@/platform/persistence/databaseOperationalAdapter'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { buildLogicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { createPluginGenerationFilesystemGcPort } from '@/services/pluginGenerationGc'
import { invalidateCallGraphIndex } from '@/services/structuralDiff/callGraph/expandService'
import { createLogger } from '@/util/log'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  MaintenanceWorkerGraph,
  MaintenanceWorkerGraphFactory,
} from '@/platform/background/maintenanceWorkerRuntime'
import type { MaintenanceSystemOperations } from '@/platform/background/maintenanceJobRunner'
import type { EventsArchiveStore } from '@/platform/background/eventsArchiveStorePort'
import { composeMaintenanceSystemOperations } from '@/platform/background/maintenanceSystemOperations'

type GraphInput = Parameters<MaintenanceWorkerGraphFactory>[0]
type Request = GraphInput['request']
type AdapterInput<R extends Request> = Omit<GraphInput, 'request'> & { readonly request: R }
interface MaintenanceWorkerAdapter {
  readonly db: PersistenceDb
  readonly eventsArchiveStore: EventsArchiveStore
  readonly storage: MaintenanceSystemOperations['storage']
  readonly resourcePackageRecoveryScene: AtomicApplyRecoveryScene<'resource-package'>
  readonly busyDeferralCounter: MaintenanceWorkerGraph['busyDeferralCounter']
  close(): Promise<void>
}

const MAINTENANCE_WORKER_ADAPTERS = {
  postgresql({
    request: parsed,
    appHome,
    effects: workerEffects,
    registerConnectionClose,
  }: AdapterInput<Extract<Request, { database: unknown }>>): MaintenanceWorkerAdapter {
    // A dedicated small pool cannot consume the foreground pool or open db.sqlite.
    const runtime = createPostgresqlDatabaseRuntime({
      config: { ...parsed.database, poolMax: Math.min(2, parsed.database.poolMax) },
      generationId: parsed.generationId,
    })
    const close = () => runtime.close()
    registerConnectionClose(close)
    const db = createPostgresqlDatabaseClient(runtime, {
      beforeWrite: workerEffects?.databaseWrites?.assertHeld,
    })
    const operational = createPostgresqlDatabaseOperationalAdapter({
      runtime,
      contract: buildLogicalSchemaContract(),
    })
    const resourcePackageMaintenance = composeResourcePackageApplyMaintenance({
      db,
      appHome,
      pluginsDir: join(appHome, 'plugins'),
      artifacts: workerEffects?.resourcePackageRecovery,
      recoveryEffectsFactory: workerEffects?.resourcePackageRecoveryContent,
    })
    return {
      db,
      close,
      eventsArchiveStore: createTaskNodeEventArchiveStore(db),
      storage: Object.freeze({
        async run() {
          return (await operational.runStorageMaintenance()).counters
        },
      }),
      resourcePackageRecoveryScene: resourcePackageMaintenance.scene,
      busyDeferralCounter: 'postgresqlTransientDeferrals',
    }
  },
  sqlite({
    request: parsed,
    appHome,
    effects: workerEffects,
    observe,
    registerConnectionClose,
  }: AdapterInput<Extract<Request, { dbPath: string }>>): MaintenanceWorkerAdapter {
    const db = openDb({
      path: parsed.dbPath,
      migrationsFolder: parsed.migrationsFolder,
      skipMigrations: true,
      skipIntegrityCheck: true,
      journalMode: 'preserve',
      synchronous: parsed.sqlite.synchronous,
      pageCacheMib: parsed.sqlite.pageCacheMib,
      mmapMib: parsed.sqlite.mmapMib,
      busyTimeoutMs: parsed.sqlite.busyTimeoutMs,
      slowQueryMs: 0,
      observeStatementMs: observe.statement,
      observeTransactionMs: observe.transaction,
    })
    const close = async () => {
      ;(db as unknown as { $client: { close(): void } }).$client.close()
    }
    registerConnectionClose(close)
    const resourcePackageMaintenance = composeResourcePackageApplyMaintenance({
      db,
      appHome,
      pluginsDir: join(appHome, 'plugins'),
      artifacts: workerEffects?.resourcePackageRecovery,
      recoveryEffectsFactory: workerEffects?.resourcePackageRecoveryContent,
      // The main thread supplies active journal ids with each converge payload.
      activitySource: { activeApplyIds: () => [] },
      log: createLogger('intentMaintenance'),
    })
    return {
      db,
      close,
      eventsArchiveStore: createTaskNodeEventArchiveStore(db),
      storage: Object.freeze({
        async run() {
          checkpointSqliteWal(db)
          return { checkpointed: 1 }
        },
      }),
      resourcePackageRecoveryScene: resourcePackageMaintenance.scene,
      busyDeferralCounter: 'sqliteBusyDeferrals',
    }
  },
}

function selectMaintenanceWorkerAdapter(input: GraphInput): MaintenanceWorkerAdapter {
  const request = input.request
  return 'database' in request
    ? MAINTENANCE_WORKER_ADAPTERS.postgresql({ ...input, request })
    : MAINTENANCE_WORKER_ADAPTERS.sqlite({ ...input, request })
}

export const composeMaintenanceWorkerGraph: MaintenanceWorkerGraphFactory = async (input) => {
  const adapter = selectMaintenanceWorkerAdapter(input)
  const { db: client, resourcePackageRecoveryScene } = adapter
  const closure = composeCrossContextClosure(client)
  const { appHome, effects: workerEffects } = input
  const store = createMaintenanceRunStore(client)
  const integrationMaintenanceCommands = composeIntegrationMaintenanceCommands(
    composeWebhookDeliveryPersistenceFor(client),
  )
  const taskExecution = createTaskExecutionPersistence(client, {
    recoveryHumanGates: closure.collaborationReads.recovery,
  })
  const taskRecoveryOperations = taskExecution.recoveryAdministration
  const taskArchiveMaintenanceCommand = createDrizzleTaskArchiveMaintenanceCommand(
    client,
    closure.collaborationReads.archive,
    workerEffects?.taskArchive,
  )
  const workspaceMaintenanceCommand = createWorkerWorkspaceMaintenanceCommand(
    (isMaterializingTask) =>
      composeWorkspacePreparationMaintenance({
        db: client,
        appHome,
        repositoryPreparation: composeRepositoryPreparation({
          taskPorts: composeSourceControlTaskPorts(client),
          db: client,
          appHome,
          preparationEffects: workerEffects?.workspaceMaintenance?.preparation,
          scratchEffects: workerEffects?.workspaceMaintenance?.scratch,
        }),
        maintenance: composeWorkspaceMaintenanceCommand({
          ...composeSourceControlTaskPorts(client),
          filesystem: workerEffects?.workspaceMaintenance?.filesystem(isMaterializingTask),
          appHome,
          terminalMaintenance: taskExecution.terminalMaintenance,
          isMaterializingTask,
          invalidateWorkspacePath: invalidateCallGraphIndex,
        }),
      }),
  )
  const tokenCallAudit = createTokenCallAudit(client)
  const pluginGenerationGcCommand = composePluginGenerationGcCommand(
    client,
    workerEffects?.pluginGenerationGc ??
      createPluginGenerationFilesystemGcPort(join(appHome, 'plugins')),
  )
  const maintenanceExecutionFence = createMaintenanceExecutionFence(client)
  const developmentAutomationMaintenance = composeDevelopmentAutomationMaintenanceCommands(client)
  const digitalEmployeeMaintenance = composeDigitalEmployeeMaintenanceCommands(client)
  const systemOperations = composeMaintenanceSystemOperations({
    retentionPhases: composeRetentionSweepPhases(client),
    eventsArchiveStore: adapter.eventsArchiveStore,
    eventsArchiveContent: workerEffects?.eventsArchive,
    storage: adapter.storage,
    databaseBackups: workerEffects?.databaseBackups,
    objectPublications: workerEffects?.objectPublications,
    logsDir: join(appHome, 'logs'),
  })
  const intentMaintenanceCommands = composeIntentMaintenanceCommandsForDatabase({
    db: client,
    scratch: workerEffects?.intentScratch,
    appHome,
    log: createLogger('intentMaintenance'),
  })
  const atomicApply = createAtomicApplyRecovery([
    composeIntentApplyRecoveryScene({
      db: client,
      appHome,
      pluginsDir: join(appHome, 'plugins'),
      content: workerEffects?.intentArtifactContent,
      log: createLogger('intentMaintenance'),
    }),
    resourcePackageRecoveryScene,
  ])
  return Object.freeze({
    store,
    ownerCommands: Object.freeze({
      workspace: workspaceMaintenanceCommand,
      developmentAutomation: developmentAutomationMaintenance,
      digitalEmployee: digitalEmployeeMaintenance,
      intent: intentMaintenanceCommands,
      atomicApply,
      integration: integrationMaintenanceCommands,
      taskRecovery: taskRecoveryOperations,
      taskArchive: taskArchiveMaintenanceCommand,
      tokenAudit: tokenCallAudit,
      pluginGenerationGc: {
        command: pluginGenerationGcCommand,
        executionFence: maintenanceExecutionFence,
      },
      system: systemOperations,
    }),
    busyDeferralCounter: adapter.busyDeferralCounter,
    close: adapter.close,
  })
}
