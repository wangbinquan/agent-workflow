import {
  createExecutionPermitRegistry,
  neverPruneTerminalWorkspaces,
} from '@/modules/task-execution/composition'
import type {
  MaintenanceWorkerEffects,
  MaintenanceWorkerEffectsSelections,
} from './maintenanceWorkerEffects'
import { standaloneMaintenanceWorkerEffects } from './standaloneMaintenanceWorker'
import {
  composeMaintenanceJobBindings,
  type MaintenanceOwnerCommands,
} from './maintenanceJobBindings'
import {
  createContentMaintenance,
  createContentHolderQuery,
  createLocalFileContentTransport,
  contentExclusive,
} from '@/platform/content/composition'
import { persistenceSchema } from './persistenceSchema'
import { composeContentBackupHorizon } from '@/modules/system-operations/composition/contentRetention'
import { createActiveHistoryRestrictionProvider } from '@/modules/system-operations/composition/epochInstallation'
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
import { composeIntentApplyArtifactLifecycle } from '@/modules/intent/composition/apply'
import {
  composeLegacyIntentSkillArtifactCompat,
  createSkillContentLocationQuery,
} from '@/modules/resource-catalog/composition/intentApply'
import { createAtomicApplyRecovery } from '@/platform/atomic-apply/convergence'
import type { AtomicApplyRecoveryScene } from '@/platform/contracts/atomicApply'
import { composeIntentMaintenanceCommandsForDatabase } from '@/modules/intent/composition/maintenance'
import { composeDevelopmentAutomationMaintenanceCommands } from '@/modules/development-automation/composition'
import { composeDigitalEmployeeMaintenanceCommands } from '@/modules/digital-employee/composition'
import { createDrizzleTaskArchiveMaintenanceCommand } from '@/modules/task-execution/composition/taskArchiveMaintenance'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { composePluginGenerationGcCommand } from '@/modules/resource-catalog/composition/pluginGenerationGc'
import {
  composeResourcePackageApplyMaintenance,
  requireExclusiveRecoverySelection,
} from '@/modules/resource-catalog/composition/resourcePackageMaintenance'
import { composeSkillApplyRecoveryScene } from '@/modules/resource-catalog/composition/skillApplyMaintenance'
import { composeWebhookDeliveryPersistenceFor } from '@/modules/integration/composition/webhookDelivery'
import { composeIntegrationMaintenanceCommands } from '@/modules/integration/composition/maintenance'
import { composeWorkspaceMaintenanceCommand } from '@/modules/source-control/composition/workspaceMaintenance'
import { createFileWorkspacePresenceQueries } from '@/modules/source-control/composition/workspacePresence'
import { createMaintenanceRunStore } from '@/platform/persistence/maintenanceRunStore'
import { createMaintenanceExecutionFence } from '@/modules/task-execution/composition/maintenanceExecutionFence'
import { createTaskNodeEventArchiveStore } from '@/modules/task-execution/composition'
import { composeRetentionSweepPhases } from './retentionSweepPhases'
import { checkpointSqliteWal } from '@/platform/persistence/sqlite/systemMaintenanceOperations'
import { createPostgresqlDatabaseOperationalAdapter } from '@/platform/persistence/databaseOperationalAdapter'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { logicalSchemaContract, persistenceSchemaBinding } from '@/bootstrap/persistenceSchema'
import { createLogger, type Logger } from '@/platform/logging/logger'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  MaintenanceWorkerGraph,
  MaintenanceWorkerGraphFactory,
} from '@/platform/background/maintenanceWorkerRuntime'
import type { MaintenanceSystemOperations } from '@/modules/system-operations/composition'
import type { EventsArchiveStore } from '@/platform/background/eventsArchiveStorePort'
import { composeMaintenanceSystemOperations } from '@/modules/system-operations/composition'
import { createAgentExecutionQueries } from '@/modules/resource-catalog/composition'

type GraphInput = Parameters<MaintenanceWorkerGraphFactory<MaintenanceWorkerEffectsSelections>>[0]
type Request = GraphInput['request']
type AdapterInput<R extends Request> = Omit<GraphInput, 'request'> & { readonly request: R }
interface MaintenanceWorkerAdapter {
  readonly db: PersistenceDb
  readonly effects: MaintenanceWorkerEffects
  readonly eventsArchiveStore: EventsArchiveStore
  readonly storage: MaintenanceSystemOperations['storage']
  readonly contentMaintenance: ReturnType<typeof createContentMaintenance>
  readonly resourcePackageRecoveryScene: AtomicApplyRecoveryScene<'resource-package'>
  readonly busyDeferralCounter: MaintenanceWorkerGraph['busyDeferralCounter']
  close(): Promise<void>
}

/**
 * RFC-528 — the worker's one selection, made by each database adapter once its client is open: every family the effects
 * descriptor gives, or (not given; a standalone worker has no descriptor) the standalone profile's, built only when used.
 * Selecting both resource-package recovery forms is still the original conflict error, checked here where the choice is
 * made (RFC-525). The hosted-only families have no standalone counterpart: not given means none.
 */
function selectWorkerEffects(input: {
  readonly selected: GraphInput['effects']
  readonly db: PersistenceDb
  readonly appHome: string
  readonly log?: Logger
}): MaintenanceWorkerEffects {
  const { selected } = input
  const scope = { db: input.db, appHome: input.appHome, log: input.log }
  const standalone = standaloneMaintenanceWorkerEffects
  requireExclusiveRecoverySelection({
    artifacts: selected?.resourcePackageRecovery,
    recoveryEffectsFactory: selected?.resourcePackageRecoveryContent,
  })
  return Object.freeze({
    contentStore: selected?.contentStore ?? standalone.contentStore(scope),
    taskArchive: selected?.taskArchive ?? standalone.taskArchive(scope),
    resourcePackageRecovery:
      selected?.resourcePackageRecovery ??
      standalone.resourcePackageRecovery(scope, selected?.resourcePackageRecoveryContent),
    workspaceMaintenance: selected?.workspaceMaintenance ?? standalone.workspaceMaintenance(scope),
    pluginGenerationGc: selected?.pluginGenerationGc ?? standalone.pluginGenerationGc(scope),
    intentScratch: selected?.intentScratch ?? standalone.intentScratch(scope),
    intentArtifactContent:
      selected?.intentArtifactContent ?? standalone.intentArtifactContent(scope),
    databaseWrites: selected?.databaseWrites,
    eventsArchive: selected?.eventsArchive,
    databaseBackups: selected?.databaseBackups,
    objectPublications: selected?.objectPublications,
  })
}

function composeWorkerContentMaintenance(
  db: PersistenceDb,
  appHome: string,
  effects: MaintenanceWorkerEffects,
) {
  const local = effects.contentStore.policy.externalKind === 'local-file'
  return createContentMaintenance({
    db,
    horizon: composeContentBackupHorizon(db, appHome),
    hasHolders: createContentHolderQuery(persistenceSchema),
    exclusive: contentExclusive(appHome),
    ...(local
      ? {
          localFiles: createLocalFileContentTransport(join(appHome, 'content'), appHome),
          localOwners: [
            'collaboration-review',
            'skill-content',
            'task-execution',
            'code-history',
            'intent',
          ],
        }
      : {}),
  })
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
      liveSchema: persistenceSchemaBinding,
      beforeWrite: workerEffects?.databaseWrites?.assertHeld,
    })
    const effects = selectWorkerEffects({ selected: workerEffects, db, appHome })
    const operational = createPostgresqlDatabaseOperationalAdapter({
      runtime,
      contract: logicalSchemaContract,
      schemaHistory: persistenceSchemaBinding.history,
    })
    const resourcePackageMaintenance = composeResourcePackageApplyMaintenance({
      db,
      artifacts: effects.resourcePackageRecovery,
    })
    return {
      db,
      effects,
      close,
      contentMaintenance: composeWorkerContentMaintenance(db, appHome, effects),
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
    const resourcePackageLog = createLogger('intentMaintenance')
    const effects = selectWorkerEffects({
      selected: workerEffects,
      db,
      appHome,
      log: resourcePackageLog,
    })
    const resourcePackageMaintenance = composeResourcePackageApplyMaintenance({
      db,
      artifacts: effects.resourcePackageRecovery,
      // The main thread supplies active journal ids with each converge payload.
      activitySource: { activeApplyIds: () => [] },
      log: resourcePackageLog,
    })
    return {
      db,
      effects,
      close,
      contentMaintenance: composeWorkerContentMaintenance(db, appHome, effects),
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

export const composeMaintenanceWorkerGraph = async (
  input: GraphInput,
): Promise<MaintenanceWorkerGraph & { readonly ownerCommands: MaintenanceOwnerCommands }> => {
  const adapter = selectMaintenanceWorkerAdapter(input)
  // RFC-528: the effects the adapter selected once — the descriptor's families, or the standalone profile's.
  const { db: client, resourcePackageRecoveryScene, effects } = adapter
  // RFC-526: the worker has no deployment presence selection — the local file presence its task persistence and human-gate
  // closure used to build when none was given, in both deployments as before.
  const workspacePresence = createFileWorkspacePresenceQueries()
  const closure = composeCrossContextClosure(
    client,
    createExecutionPermitRegistry(),
    workspacePresence,
    neverPruneTerminalWorkspaces,
  )
  const { appHome } = input
  const store = createMaintenanceRunStore(client)
  const integrationMaintenanceCommands = composeIntegrationMaintenanceCommands(
    composeWebhookDeliveryPersistenceFor(client),
  )
  const taskExecution = createTaskExecutionPersistence(client, {
    humanGateOpen: closure.humanGateOpen,
    content: effects.contentStore,
    historyRestrictions: createActiveHistoryRestrictionProvider(),
    recoveryHumanGates: closure.collaborationReads.recovery,
    workspacePresence,
    // RFC-534: the worker is a separate realm the daemon's prune policy never reached, and its recovery only writes
    // `interrupted` — the named never-prune policy, as before.
    terminalWorkspacePrune: neverPruneTerminalWorkspaces,
  })
  const taskRecoveryOperations = taskExecution.recoveryAdministration
  const taskArchiveMaintenanceCommand = createDrizzleTaskArchiveMaintenanceCommand(
    client,
    closure.collaborationReads.archive,
    effects.taskArchive,
  )
  const workspaceMaintenanceCommand = createWorkerWorkspaceMaintenanceCommand(
    (isMaterializingTask) => {
      const preparationInput = {
        taskPorts: composeSourceControlTaskPorts(client),
        db: client,
        appHome,
      }
      return composeWorkspacePreparationMaintenance({
        db: client,
        appHome,
        repositoryPreparation: composeRepositoryPreparation({
          ...preparationInput,
          scratchEffects: effects.workspaceMaintenance.scratch,
          preparationEffects: effects.workspaceMaintenance.preparation,
        }),
        maintenance: composeWorkspaceMaintenanceCommand({
          ...composeSourceControlTaskPorts(client),
          filesystem: effects.workspaceMaintenance.filesystem(isMaterializingTask),
          terminalMaintenance: taskExecution.terminalMaintenance,
        }),
      })
    },
  )
  const tokenCallAudit = createTokenCallAudit(client)
  const pluginGenerationGcCommand = composePluginGenerationGcCommand(
    client,
    effects.pluginGenerationGc,
  )
  const maintenanceExecutionFence = createMaintenanceExecutionFence(client)
  const developmentAutomationMaintenance = composeDevelopmentAutomationMaintenanceCommands(client)
  const digitalEmployeeMaintenance = composeDigitalEmployeeMaintenanceCommands(client)
  const systemOperations = composeMaintenanceSystemOperations({
    retentionPhases: composeRetentionSweepPhases(client),
    eventsArchiveStore: adapter.eventsArchiveStore,
    eventsArchiveContent: effects.eventsArchive,
    storage: {
      async run() {
        return { ...(await adapter.storage.run()), ...(await adapter.contentMaintenance.run()) }
      },
    },
    databaseBackups: effects.databaseBackups,
    objectPublications: effects.objectPublications,
    logsDir: join(appHome, 'logs'),
  })
  const intentMaintenanceCommands = composeIntentMaintenanceCommandsForDatabase({
    db: client,
    // RFC-568: the Intent persistence takes Resource Catalog's agent read factory on every construction.
    createAgentExecutionQueries,
    scratch: effects.intentScratch,
    log: createLogger('intentMaintenance'),
  })
  const intentPluginsDir = join(appHome, 'plugins')
  // RFC-595: the artifact lifecycle takes Resource Catalog's skill content-location query from here, not from inside
  // Intent's composition.
  const atomicApply = createAtomicApplyRecovery([
    composeIntentApplyRecoveryScene({
      db: client,
      artifacts: composeIntentApplyArtifactLifecycle({
        db: client,
        appHome,
        pluginsDir: intentPluginsDir,
        content: effects.intentArtifactContent,
        legacySkillArtifacts: composeLegacyIntentSkillArtifactCompat(),
        skillContentLocations: createSkillContentLocationQuery(client),
      }),
      log: createLogger('intentMaintenance'),
    }),
    resourcePackageRecoveryScene,
    // RFC-401 T5：skill 写入场景（普通 CRUD 与 fusion 的技能写入）。
    composeSkillApplyRecoveryScene({
      db: client,
      appHome,
      log: createLogger('skillApplyMaintenance'),
    }),
  ])
  const ownerCommands = Object.freeze({
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
  })
  return Object.freeze({
    store,
    ownerCommands,
    handlers: composeMaintenanceJobBindings(ownerCommands),
    busyDeferralCounter: adapter.busyDeferralCounter,
    close: adapter.close,
  })
}
