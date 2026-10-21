// `agent-workflow start` — daemon foreground entry.
import type { AuthRuntime } from '@/auth/application/authRuntime'
import type { RepositoryPublicationTransport } from '@/modules/source-control/public/types'
import type { TaskInputFiles } from '@/modules/task-execution/composition/crewstationTaskInputFiles'
import type { TaskRecoveryDeploymentSelection } from '@/modules/task-execution/composition/taskRecoverySelection'
import type { DatabaseBackupEffects } from '@/modules/system-operations/public/commands'
import type { HumanGateArtifactRecovery } from '@/modules/collaboration/public/commands'
import type { TaskArchivedEventsReader } from '@/modules/task-execution/public/types'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { CrewStationEventIngress } from '@/modules/integration/composition/crewstationEvents'
import type { ReviewArtifactSelection } from '@/modules/collaboration/composition'
import type { WorkspaceRollbackSnapshotInspector } from '@/modules/collaboration/composition'
import type { composeLocalRuntimeManagement } from '@/modules/task-execution/composition/localRuntimeManagement'
import type { WorkspacePresenceQueries } from '@/modules/source-control/public/queries'
import type { RepositoryPreparationEffectFactory } from '@/modules/source-control/composition'
import type { ScratchWorkspaceEffects } from '@/modules/source-control/composition'
import type { FusionWorkspaceEffects } from '@/modules/source-control/public/participants'
import type { WorkspaceMaintenanceFilesystem } from '@/modules/source-control/composition'
import { composeTaskLaunchConfiguration } from '@/modules/task-execution/composition/launchConfiguration'
import { type DevelopmentPurposeSelection } from '@/modules/development-automation/composition'
import type { composeLocalSystemAgentRunFamily } from '@/modules/task-execution/composition/localSystemAgentRunFamily'
import { type TaskRunRootSelection } from '@/modules/task-execution/composition/taskRunSelection'
import type { WorkspaceExcludeProfileFactory } from '@/modules/source-control/public/participants'
import type {
  WorkspaceUploadContentFactory,
  IsolationWorkspaceFactory,
  RepositoryGitWorkspaceFactory,
} from '@/modules/source-control/public/types'
import type { RepositoryCandidateEffectsFactory } from '@/modules/source-control/composition'
import {
  selectWorkspaceUploadContentFactory,
  selectIsolationWorkspaceFactory,
  selectRepositoryGitWorkspaceFactory,
} from '@/modules/source-control/public/participants'
import type {
  PortArtifactContentEffects,
  TaskRuntimeInventoryContent,
} from '@/modules/task-execution/public/types'
import type {
  NodeRunPromptContentEffects,
  TaskDeletionEffects,
} from '@/modules/task-execution/public/types'
import {
  type ActionWorkspaceEffects,
  type AutomationWorkspaceEffectsFactory,
} from '@/modules/development-automation/composition'
import type { ConflictMergeWorkspaceEffects } from '@/modules/source-control/public/types'
import type {
  RepositoryBaselineEffectsFactory,
  VerificationCommandEffectsFactory,
} from '@/modules/development-automation/composition'
import {
  composeApplicationConfigurationBinding,
  type ApplicationConfigurationBinding,
} from '@/modules/system-operations/composition/applicationConfiguration'
import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'
import { databaseProviderTraits } from '@/platform/persistence/providerTraits'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import { createSecretBox, type SecretBox } from '@/auth/secretBox'
import type { ExecutionAuthorityPort } from '@/modules/system-operations/public/participants'
import type { CredentialAdapterSelection } from '@/modules/identity-access/composition/authentication'
import { createExecutionExitRequests } from './executionActivation'
import { ensureTokenFile } from '@/auth/token'
import type { loadConfig } from '@/config'
import {
  type EvidenceDocumentCommands,
  type EvidenceArtifactPort,
  type AttemptContextStorePort,
} from '@/modules/development-automation/composition'
import type { createDevelopmentWorkspaceRepositoryPreparation } from '@/services/developmentDeliveryDeps'
import { DbSchemaDriftError, formatSchemaDifference } from '@/db/schemaAdmission'
import { IS_EMBEDDED } from '@/embed'
import { resolveMigrationsFolder } from '@/util/migrationsFolder'
import { type BootExecutionRecoveryFactory } from '@/modules/task-execution/composition/bootRecovery'
import type { DatabaseSourceWriteWindow } from '@/auth/application/authPersistence'
import { maybePreMigrationBackup } from '@/services/backupScheduler'
import {
  composeDaemonHostApplication,
  composeDaemonStartupLease,
  runDaemonStartupWithLease,
  type DaemonStartupLease,
  type DaemonStartupLeasePort,
  type DaemonDatabasePreOpenRecoveryPort,
  prepareDatabasePreOpenRecovery,
} from '@/modules/system-operations/composition'
import {
  prepareDaemonDatabaseProviderForBoot,
  type DaemonDatabaseInstallationPort,
} from '@/modules/system-operations/composition/daemonDatabase'
import type { composeLocalMcpDiagnostics } from '@/modules/resource-catalog/composition/localMcpDiagnostics'
import { type PluginInstallerPort } from '@/modules/resource-catalog/composition/pluginOperations'
import { detectGitCapabilities, mergeTreeGateError, MIN_GIT_VERSION } from '@/services/gitVersion'
import { configureLogger, createLogger, type LogLevel } from '@/util/log'
import { getRuntimeDriver } from '@/services/runtime'
import { Paths } from '@/util/paths'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type CustomObserverProgramFactory } from '@/modules/event-center/composition'
import {
  resolveDatabaseProviderRuntime,
  type ResolvedDatabaseProviderRuntime,
} from '@/platform/persistence/databaseProviderRuntime'
import { buildLogicalSchemaContract } from '@/platform/persistence/schemaContract'
import type { composeDatabaseMigrationModule } from '@/modules/system-operations/composition/databaseMigration'
import { createDatabaseMigrationDaemonAdmission } from '@/modules/system-operations/composition'
import {
  composeDaemonProviderBootstrap,
  type DaemonProviderBootstrap,
} from './daemonProviderBootstrap'
import type { DaemonProviderListenerRuntimeSession } from './daemonProviderRuntimeRouter'
import {
  describeDaemonProviderSessionFailure,
  type DaemonProviderSessionLifecycleInput,
} from './daemonProviderSession'
import { type SignalledDaemonRuntimeOwner } from './daemonProviderRuntimeHandles'
import type { MaintenanceWorkerEffectsDescriptor } from '@/platform/background/maintenanceWorkerEffects'
import type {
  EmployeeCaseWorkspaceEffectsFactory,
  RepositoryRemoteEffects,
  WorkspaceContentEffectsFactory,
} from '@/modules/source-control/composition'
import type {
  ResourcePackageSkillArtifactOwner,
  ResourcePackagePluginArtifactOwner,
  SkillPackageContentReader,
} from '@/modules/resource-catalog/composition/postgresqlResourcePackageCatalog'
import { selectDatabaseSchemaProvider } from '@/db/providerSchema'
import {
  composeFileRuntimeLegacyConfiguration,
  type RuntimeLegacyConfigurationPort,
} from '@/modules/runtime-management/composition/runtimeRegistry'
import type { MissionInputBlobPersistence } from '@/modules/development-automation/composition/missionInputUploads'
import type { TaskArchiveContentBinding } from '@/modules/task-execution/composition/taskArchiveMaintenance'
import type { IntentArtifactSelection } from '@/modules/intent/composition/apply'
import { type SkillContentBinding } from '@/modules/resource-catalog/composition/skillContentBinding'
import type {
  ProgramArtifactPort,
  EmployeeInputArtifactPort,
} from '@/modules/digital-employee/composition'
import type { ScriptFixtureProcess } from '@/modules/task-execution/composition/programTools'
import type { ActionWorkspaceEntries } from '@/modules/task-execution/composition/actionExecutionRunners'
import type { CodeReviewArtifactStore } from '@/modules/code-capability/public/participants'
import type { RepositoryRevisionContentFactory } from '@/modules/source-control/public/participants'
import type { EvidenceReadBinding } from '@/modules/development-automation/composition/evidenceReadBinding'
import {
  selectDaemonHostLifecycle,
  type DaemonHostLifecyclePort,
} from '@/modules/system-operations/composition/daemonHostLifecycle'
import type { DaemonRuntimeQueries } from '@/modules/system-operations/public/queries'
import {
  selectRepositoryWorkspaceReadQueries,
  type RepositoryWorkspaceReadQueries,
} from '@/modules/source-control/public/queries'

export interface StartOptions {
  port?: number
  host?: string
  /** Process-local preparation shared only by the development hot reloader. */
  developmentIntegrity?: { validatedDatabase?: string }
  configuration?: ApplicationConfigurationQueries
  applicationConfiguration?: ApplicationConfigurationBinding
  runtimeLegacyConfiguration?: RuntimeLegacyConfigurationPort
  databasePreOpenRecovery?: DaemonDatabasePreOpenRecoveryPort
  databaseInstallation?: DaemonDatabaseInstallationPort
  taskArchive?: TaskArchiveContentBinding
  skillContent?: SkillContentBinding
  employeePrograms?: ProgramArtifactPort
  /** RFC-370 §10 V19: where a program tool's contract fixture runs (hosted only). */
  programFixtureProcess?: ScriptFixtureProcess
  /** RFC-370 §10 V18: entry checks below a hosted action workspace (hosted only). */
  actionWorkspaceEntries?: ActionWorkspaceEntries
  /** RFC-370 §10 V16: code-review reads of hosted task volumes (hosted only). */
  repositoryRevisionContent?: RepositoryRevisionContentFactory
  /** RFC-370 §10 V16: code-review artifacts as object publications (hosted only). */
  codeReviewArtifacts?: CodeReviewArtifactStore
  employeeInputArtifacts?: EmployeeInputArtifactPort
  missionInputBlobs?: MissionInputBlobPersistence
  pluginInstaller?: PluginInstallerPort
  beforeEventObservationWrite?: (tx: ProviderNeutralDatabase) => Promise<void>
  humanGateArtifactRecovery?: HumanGateArtifactRecovery
  databaseBackup?: DatabaseBackupEffects
  archivedNodeEvents?: TaskArchivedEventsReader
  crewStationEvents?: CrewStationEventIngress
  intentArtifacts?: IntentArtifactSelection
  evidenceArtifacts?: EvidenceArtifactPort
  resourcePackageSkillArtifacts?: ResourcePackageSkillArtifactOwner
  resourcePackagePluginArtifacts?: ResourcePackagePluginArtifactOwner
  resourcePackageSkillContent?: SkillPackageContentReader
  workspaceContent?: WorkspaceContentEffectsFactory
  /** RFC-370 §10 V17: hosted repository remote reads; absent, local mirrors. */
  repositoryRemote?: RepositoryRemoteEffects
  workspaceUploads?: WorkspaceUploadContentFactory
  isolationWorkspaces?: IsolationWorkspaceFactory
  repositoryGitWorkspaces?: RepositoryGitWorkspaceFactory
  repositoryCandidateEffects?: RepositoryCandidateEffectsFactory
  workspaceReads?: RepositoryWorkspaceReadQueries
  employeeCaseWorkspaceEffects?: EmployeeCaseWorkspaceEffectsFactory
  repositoryBaselines?: RepositoryBaselineEffectsFactory
  verificationCommands?: VerificationCommandEffectsFactory
  customObserverPrograms?: CustomObserverProgramFactory
  bootExecutionRecovery?: BootExecutionRecoveryFactory
  automationWorkspaceEffects?: AutomationWorkspaceEffectsFactory
  actionWorkspaceEffects?: ActionWorkspaceEffects
  conflictMergeWorkspaceEffects?: ConflictMergeWorkspaceEffects
  taskDeletionEffects?: TaskDeletionEffects
  /** RFC-370 §9.2 V3 — hosted only: publication network Git in the task volume. */
  readonly repositoryPublicationTransport?: RepositoryPublicationTransport
  nodeRunPromptContentEffects?: NodeRunPromptContentEffects
  portArtifactContentEffects?: PortArtifactContentEffects
  runtimeInventoryContent?: TaskRuntimeInventoryContent
  taskRunSelection?: TaskRunRootSelection
  taskRecovery?: TaskRecoveryDeploymentSelection
  taskInputFiles?: TaskInputFiles
  readonly repositoryPreparationEffects?: RepositoryPreparationEffectFactory
  readonly scratchWorkspaceEffects?: ScratchWorkspaceEffects
  /** RFC-370 §10 V20 — hosted only: the fusion engine task's volume workspace. */
  readonly fusionWorkspaceEffects?: FusionWorkspaceEffects
  readonly workspaceMaintenanceFilesystem?: WorkspaceMaintenanceFilesystem
  readonly workspacePresence?: WorkspacePresenceQueries
  readonly initializeExecution?: (initialize: () => Promise<void>) => Promise<void>
  readonly recoveredExecutionTaskIds?: () => readonly string[]
  /** RFC-370 §9.2 V1 — deployment workers started with execution authority. */
  readonly hostedBackgroundOwners?: readonly SignalledDaemonRuntimeOwner[]
  readonly runtimeManagement?: typeof composeLocalRuntimeManagement
  readonly reviewArtifacts?: ReviewArtifactSelection
  readonly reviewRollbackSnapshots?: WorkspaceRollbackSnapshotInspector
  readonly systemAgentRunFamily?: typeof composeLocalSystemAgentRunFamily
  readonly mcpDiagnostics?: typeof composeLocalMcpDiagnostics
  readonly developmentPurposes?: DevelopmentPurposeSelection
  readonly developmentWorkspaceRepositoryPreparation?: ReturnType<
    typeof createDevelopmentWorkspaceRepositoryPreparation
  >
  workspaceExcludeProfiles?: WorkspaceExcludeProfileFactory
  maintenanceEffectsBootstrap?: MaintenanceWorkerEffectsDescriptor
  evidenceRead?: EvidenceReadBinding
  evidenceDocumentCommands?: EvidenceDocumentCommands
  attemptContext?: AttemptContextStorePort
  daemonHost?: DaemonHostLifecyclePort
  startupLease?: DaemonStartupLeasePort
  /** RFC-370 v2 H7 — the deployment's execution authority; standalone is always active. */
  executionAuthority?: ExecutionAuthorityPort
  /** RFC-370 v2 §3.6 — the deployment's credential mechanism; standalone sessions by default. */
  credentials?: CredentialAdapterSelection
  /** RFC-370 M0 — a platform-provided master key instead of the local secret.key file. */
  secretBox?: SecretBox
  /**
   * RFC-370 M0 — where git and agent runtimes execute. `remote` (a CrewStation
   * service slot) has neither on its host, so the local git and runtime probes
   * do not apply; the selected execution adapters own those dependencies.
   */
  executionHost?: 'local' | 'remote'
}

type DatabaseMigrationAdmission = Parameters<typeof composeDatabaseMigrationModule>[0]['admission']

/** RFC-359 W3-T16：两个 provider 的会话装配器共用的输入——`startCommand` 只准备这一份。 */
export interface DaemonProviderSessionComposeInput {
  readonly provider: ResolvedDatabaseProviderRuntime
  readonly lifecycle: DaemonProviderSessionLifecycleInput
  readonly config: ReturnType<typeof loadConfig>
  readonly configuration: ApplicationConfigurationQueries
  readonly applicationConfiguration: ApplicationConfigurationBinding
  readonly taskLaunchConfiguration: ReturnType<typeof composeTaskLaunchConfiguration>
  readonly runtimeLegacyConfiguration: RuntimeLegacyConfigurationPort
  readonly taskArchive?: TaskArchiveContentBinding
  readonly skillContent?: SkillContentBinding
  readonly employeePrograms?: ProgramArtifactPort
  readonly programFixtureProcess?: ScriptFixtureProcess
  readonly actionWorkspaceEntries?: ActionWorkspaceEntries
  readonly repositoryRevisionContent?: RepositoryRevisionContentFactory
  readonly codeReviewArtifacts?: CodeReviewArtifactStore
  readonly employeeInputArtifacts?: EmployeeInputArtifactPort
  readonly missionInputBlobs?: MissionInputBlobPersistence
  readonly pluginInstaller?: PluginInstallerPort
  readonly beforeEventObservationWrite?: (tx: ProviderNeutralDatabase) => Promise<void>
  readonly humanGateArtifactRecovery?: HumanGateArtifactRecovery
  readonly databaseBackup?: DatabaseBackupEffects
  readonly archivedNodeEvents?: TaskArchivedEventsReader
  readonly crewStationEvents?: CrewStationEventIngress
  readonly intentArtifacts?: IntentArtifactSelection
  readonly evidenceArtifacts?: EvidenceArtifactPort
  readonly resourcePackageSkillArtifacts?: ResourcePackageSkillArtifactOwner
  readonly resourcePackagePluginArtifacts?: ResourcePackagePluginArtifactOwner
  readonly resourcePackageSkillContent?: SkillPackageContentReader
  readonly workspaceContent?: WorkspaceContentEffectsFactory
  readonly repositoryRemote?: RepositoryRemoteEffects
  readonly workspaceUploads: WorkspaceUploadContentFactory
  readonly isolationWorkspaces: IsolationWorkspaceFactory
  readonly repositoryGitWorkspaces: RepositoryGitWorkspaceFactory
  readonly repositoryCandidateEffects?: RepositoryCandidateEffectsFactory
  readonly workspaceReads: RepositoryWorkspaceReadQueries
  readonly employeeCaseWorkspaceEffects?: EmployeeCaseWorkspaceEffectsFactory
  readonly repositoryBaselines?: RepositoryBaselineEffectsFactory
  readonly verificationCommands?: VerificationCommandEffectsFactory
  readonly customObserverPrograms?: CustomObserverProgramFactory
  readonly bootExecutionRecovery?: BootExecutionRecoveryFactory
  readonly automationWorkspaceEffects?: AutomationWorkspaceEffectsFactory
  readonly actionWorkspaceEffects?: ActionWorkspaceEffects
  readonly conflictMergeWorkspaceEffects?: ConflictMergeWorkspaceEffects
  readonly taskDeletionEffects?: TaskDeletionEffects
  readonly repositoryPublicationTransport?: RepositoryPublicationTransport
  readonly nodeRunPromptContentEffects?: NodeRunPromptContentEffects
  portArtifactContentEffects?: PortArtifactContentEffects
  runtimeInventoryContent?: TaskRuntimeInventoryContent
  readonly taskRunSelection?: TaskRunRootSelection
  readonly taskRecovery?: TaskRecoveryDeploymentSelection
  readonly taskInputFiles?: TaskInputFiles
  readonly repositoryPreparationEffects?: RepositoryPreparationEffectFactory
  readonly scratchWorkspaceEffects?: ScratchWorkspaceEffects
  /** RFC-370 §10 V20 — hosted only: the fusion engine task's volume workspace. */
  readonly fusionWorkspaceEffects?: FusionWorkspaceEffects
  readonly workspaceMaintenanceFilesystem?: WorkspaceMaintenanceFilesystem
  readonly workspacePresence?: WorkspacePresenceQueries
  readonly initializeExecution?: (initialize: () => Promise<void>) => Promise<void>
  readonly recoveredExecutionTaskIds?: () => readonly string[]
  readonly hostedBackgroundOwners?: readonly SignalledDaemonRuntimeOwner[]
  readonly runtimeManagement?: typeof composeLocalRuntimeManagement
  readonly reviewArtifacts?: ReviewArtifactSelection
  readonly reviewRollbackSnapshots?: WorkspaceRollbackSnapshotInspector
  readonly systemAgentRunFamily?: typeof composeLocalSystemAgentRunFamily
  readonly mcpDiagnostics?: typeof composeLocalMcpDiagnostics
  readonly developmentPurposes?: DevelopmentPurposeSelection
  readonly developmentWorkspaceRepositoryPreparation?: ReturnType<
    typeof createDevelopmentWorkspaceRepositoryPreparation
  >
  readonly workspaceExcludeProfiles?: WorkspaceExcludeProfileFactory
  readonly maintenanceEffectsBootstrap?: MaintenanceWorkerEffectsDescriptor
  readonly evidenceRead?: EvidenceReadBinding
  readonly evidenceDocumentCommands?: EvidenceDocumentCommands
  readonly attemptContext?: AttemptContextStorePort
  readonly daemonRuntime: DaemonRuntimeQueries
  readonly token: string
  readonly secretBox: SecretBox
  readonly executionAuthority?: ExecutionAuthorityPort
  readonly credentials?: CredentialAdapterSelection
  /** Reported when a background handle fails to start on activation. */
  readonly onExecutionActivationFailure?: (error: unknown) => void
  readonly dbVersion: number
  readonly migrationAdmission: DatabaseMigrationAdmission
  readonly sourceWriteWindow: DatabaseSourceWriteWindow
  readonly log: ReturnType<typeof createLogger>
  readonly lock: DaemonStartupLease
  readonly migrationsFolder: string
  readonly digitalEmployeeTypePackageDriftPolicy: 'draft-overlay' | 'reject'
}

export interface ComposedDaemonProviderSession {
  readonly application: {
    readonly core: {
      readonly authRuntime: Pick<AuthRuntime, 'isBootstrapRequired'>
    }
  }
  readonly session: DaemonProviderListenerRuntimeSession
}

export type DaemonProviderSessionComposer = (
  input: DaemonProviderSessionComposeInput,
) => Promise<ComposedDaemonProviderSession>

/**
 * RFC-359 W3-T14 —— 监听器与关机序列只有一份，两个 provider 共用。
 *
 * 此前 PostgreSQL 走这里的前身 `servePostgresqlDaemon`，SQLite 在 `startCommand` 尾部另有一段
 * 手写的 `Bun.serve` + `shutdown()`——后者在 `bootstrap.stop()` 之前显式做蒸馏 worker 回收、
 * after-commit 泵注销、webhook 终态控制停机与任务优雅关停，而 PG 把同样几步放在会话的关闭
 * 参与者里。合一后只剩会话那一种放法：`shutdown()` 只做「摘 daemon info → 停监听 →
 * `bootstrap.stop()` → 收控制口与锁 → exit」，provider 专属的收尾全部在各自会话的
 * `providerCloseParticipants` 里、两侧同一组 id。
 */
export async function serveDaemon(input: {
  readonly bootstrap: Pick<
    DaemonProviderBootstrap,
    'runBusinessRequest' | 'tryUpgrade' | 'fetch' | 'websocketHandlers' | 'stop'
  >
  readonly authRuntime: Pick<AuthRuntime, 'isBootstrapRequired'>
  readonly postReady?: () => Promise<void>
  readonly databaseProvider: DatabaseProvider
  readonly token: string
  readonly bindHost: string
  readonly bindPort: number
  readonly lock: DaemonStartupLease
  readonly daemonHost: DaemonHostLifecyclePort
  readonly log: ReturnType<typeof createLogger>
  readonly exitRequests?: (requestExit: (reason: string) => void) => void
}): Promise<never> {
  const server = Bun.serve({
    // Bun --hot otherwise aliases the HTTP and control listeners when both
    // request an ephemeral port. Keep this application's reload identity distinct.
    id: `agent-workflow-http:${input.bindHost}:${input.bindPort}`,
    port: input.bindPort,
    hostname: input.bindHost,
    idleTimeout: 255,
    async fetch(request: Request, bunServer): Promise<Response> {
      return await input.bootstrap.runBusinessRequest(request, async () => {
        const upgraded = await input.bootstrap.tryUpgrade(request, bunServer)
        if (upgraded === true) return undefined as unknown as Response
        if (upgraded === false) return await input.bootstrap.fetch(request)
        return upgraded
      })
    },
    websocket: input.bootstrap.websocketHandlers,
  })
  const baseUrl = `http://${server.hostname}:${server.port}/`
  input.log.info('listening', { url: baseUrl, databaseProvider: input.databaseProvider })

  const application = composeDaemonHostApplication({
    host: input.daemonHost,
    postReady: input.postReady,
    databaseProvider: input.databaseProvider,
    log: input.log,
    describeFailure: describeDaemonProviderSessionFailure,
    readyInfo: () => ({
      // This constructor always binds TCP; the Bun Server type also covers Unix sockets.
      host: server.hostname!,
      port: server.port!,
      url: baseUrl,
      startedAt: new Date().toISOString(),
    }),
    readBootstrapRequired: () => input.authRuntime.isBootstrapRequired(),
    readyBrowserUrl: (bootstrapRequired) =>
      readyBrowserUrl(baseUrl, input.token, bootstrapRequired),
    async stopListener() {
      await server.stop(true)
    },
    async stopApplication() {
      await input.bootstrap.stop()
    },
    releaseAuthority: () => input.lock.release(),
    releaseAuthorityOnExit: () => input.lock.releaseOnExit(),
    ...(input.exitRequests === undefined ? {} : { exitRequests: input.exitRequests }),
  })
  return await application.run()
}

const MAX_DEV_LOCK_HANDOFF_MS = 60_000

function devLockHandoffMs(): number {
  const raw = process.env.AGENT_WORKFLOW_DEV_LOCK_HANDOFF_MS
  if (raw === undefined) return 0
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return 0
  return Math.min(parsed, MAX_DEV_LOCK_HANDOFF_MS)
}

/**
 * Bun --watch keeps the old generation alive until its replacement is ready.
 * A daemon cannot become ready while the old generation owns the PID lock, so
 * waiting alone deadlocks. Dev daemons advertise handoff eligibility in their
 * authenticated loopback control file; the replacement asks that exact PID to
 * drain, then waits for its lock. Normal `start` daemons never opt in and retain
 * the fail-fast singleton contract.
 */

interface DbCorruptionFailure extends Error {
  readonly dbPath: string
  readonly checkErrors: readonly string[]
}

function isDbCorruptionFailure(error: unknown): error is DbCorruptionFailure {
  return (
    error instanceof Error &&
    error.name === 'DbCorruptionError' &&
    'dbPath' in error &&
    typeof error.dbPath === 'string' &&
    'checkErrors' in error &&
    Array.isArray(error.checkErrors) &&
    error.checkErrors.every((entry) => typeof entry === 'string')
  )
}

/** RFC-213 — human-facing fail-closed message: list backups + the restore command. */
function formatDbCorruptionGuidance(err: DbCorruptionFailure): string {
  const lines = [
    '',
    '✖ agent-workflow: database corruption detected — refusing to start.',
    `  db:          ${err.dbPath}`,
    `  quick_check: ${err.checkErrors.slice(0, 3).join('; ')}`,
    '',
  ]
  let backups: string[] = []
  try {
    backups = readdirSync(Paths.backupsDir)
      .filter((f) => f.endsWith('.tar.gz'))
      .map((f) => join(Paths.backupsDir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  } catch {
    /* no backups dir */
  }
  if (backups.length === 0) {
    lines.push(`  No backups found under ${Paths.backupsDir}.`)
    lines.push('  If you have a backup tarball elsewhere: agent-workflow restore <tarball>')
  } else {
    lines.push('  Available backups (newest first):')
    for (const b of backups.slice(0, 5)) lines.push(`    ${b}`)
    lines.push('')
    lines.push(`  Recover with: agent-workflow restore ${backups[0]}`)
  }
  lines.push('  (Last resort, unsafe: AGENT_WORKFLOW_SKIP_INTEGRITY_CHECK=1 agent-workflow start)')
  lines.push('')
  return lines.join('\n')
}

/** RFC-275 — actionable boot refusal before any route or scheduler starts. */
function formatDbSchemaDriftGuidance(err: DbSchemaDriftError): string {
  const lines = [
    '',
    '✖ agent-workflow: database schema drift detected — refusing to start.',
    `  db:    ${err.dbPath}`,
    `  stage: ${err.stage}`,
    '  differences:',
  ]
  for (const difference of err.differences.slice(0, 10)) {
    lines.push(`    - ${formatSchemaDifference(difference)}`)
  }
  if (err.totalDifferences > 10) {
    lines.push(`    - … and ${err.totalDifferences - 10} more`)
  }
  lines.push(
    '',
    '  Safe recovery options:',
    '    1. Restore a verified backup.',
    '    2. If this is a disposable development database, recreate it.',
    '    3. If the schema change is intentional, add a new forward migration.',
    '',
    '  Do not edit __drizzle_migrations or rewrite an already-applied migration.',
    '',
  )
  return lines.join('\n')
}

export async function startCommand(
  opts: StartOptions,
  composeSession: DaemonProviderSessionComposer,
): Promise<void> {
  // 1. Logger — must come before lock so failures land in stdout/file.
  configureLogger({
    level: (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info',
    logFile: Paths.daemonLog,
  })
  const log = createLogger('daemon')
  const digitalEmployeeTypePackageDriftPolicy: 'draft-overlay' | 'reject' =
    !IS_EMBEDDED &&
    devLockHandoffMs() > 0 &&
    process.env.AGENT_WORKFLOW_DEV_TYPE_PACKAGE_OVERLAY === '1'
      ? 'draft-overlay'
      : 'reject'

  // 2. The selected startup provider supplies exclusivity and release ACKs.
  const lock = await composeDaemonStartupLease({
    selected: opts.startupLease,
    local: () => ({
      lockPath: Paths.lock,
      controlPath: Paths.controlFile,
      maxWaitMs: devLockHandoffMs(),
      log,
    }),
  })
  await runDaemonStartupWithLease(lock, async () => {
    log.info('lock acquired', lock.diagnostics)
    const daemonHost = selectDaemonHostLifecycle(opts.daemonHost, {
      infoPath: Paths.daemonInfo,
      controlPath: Paths.controlFile,
      pid: process.pid,
      devWatch: devLockHandoffMs() > 0,
    })

    // 2.5 — RFC-213: resolve the migrations folder and apply a staged ("hot")
    // restore BEFORE anything reads state. We hold the lock (acquired above), so
    // exactly one process consumes it; the DB is not open yet. Impl-gate P2-12
    // (2026-07-22): this used to run AFTER loadConfig, so the config.json the
    // restore just brought back only took effect one restart later — moved ahead
    // of loadConfig so the applying boot already runs on the restored config.
    //
    // P-5-05: in the compiled single-binary, the .sql files + meta/_journal.json
    // live inside the executable. drizzle's migrator needs a filesystem path,
    // so we extract them once per start into ~/.agent-workflow/runtime/migrations
    // and point the migrator there.
    // `ms` is deliberate: this step is O(number of migrations) filesystem
    // writes and grows with every migration added. It once reached ~23.5s on a
    // Windows CI runner and blew the e2e harness's 30s daemon-ready budget
    // while being completely invisible in the logs — the duration is what makes
    // that trend observable before it breaks something again.
    const extractStartedAt = Date.now()
    const migrationsFolder = await resolveMigrationsFolder({
      // `force`: boot has always re-extracted unconditionally; keeping that keeps
      // an interrupted previous extraction from surviving into this boot.
      force: true,
      onExtracted: (count, dir) => {
        log.info('extracted embedded migrations', {
          count,
          ms: Date.now() - extractStartedAt,
          dir,
        })
      },
    })
    const logicalSchemaContract = buildLogicalSchemaContract()
    const preOpenRecovery = await prepareDatabasePreOpenRecovery({
      contract: logicalSchemaContract,
      migrationsFolder,
      recovery: opts.databasePreOpenRecovery,
    })
    const schemaHistory = preOpenRecovery.history
    // A failure inside applyPendingRestoreIfAny self-heals (impl-gate P1-1): the
    // staged dir is quarantined and the boot continues on the untouched DB. The
    // catch below only guards truly unexpected filesystem-level throws.
    {
      try {
        const applied = await preOpenRecovery.applyStagedRestore()
        if (applied) log.warn('staged restore applied on boot', { db: Paths.db })
      } catch (err) {
        await lock.release()
        console.error(
          `agent-workflow: staged restore failed unexpectedly — refusing to boot with an unknown DB state.\n` +
            `  ${err instanceof Error ? err.message : String(err)}\n` +
            `  The pre-restore safety backup (if taken) is under ${join(Paths.root, 'backups')}/.\n` +
            `  To abandon the staged restore and boot normally: rm -rf ${join(Paths.root, '.restore-pending')}`,
        )
        process.exit(1)
      }
    }

    // 3. Load config; honor logLevel if user set non-default in config.
    const applicationConfiguration =
      opts.applicationConfiguration ??
      composeApplicationConfigurationBinding({
        kind: 'file',
        configPath: Paths.config,
        ...(opts.configuration === undefined ? {} : { queries: opts.configuration }),
      })
    const configuration = applicationConfiguration.queries
    const taskLaunchConfiguration = composeTaskLaunchConfiguration(
      opts.applicationConfiguration !== undefined ||
        applicationConfiguration.synchronousQueries === undefined
        ? { kind: 'selected', queries: configuration }
        : { kind: 'local-sync', queries: applicationConfiguration.synchronousQueries },
    )
    const runtimeLegacyConfiguration =
      opts.runtimeLegacyConfiguration ?? composeFileRuntimeLegacyConfiguration(Paths.config)
    let config = await configuration.read()
    if (config.logLevel !== 'info') {
      configureLogger({ level: config.logLevel })
    }
    log.info('config loaded', {
      path: Paths.config,
      language: config.language,
      theme: config.theme,
    })

    // RFC-370 M0: a CrewStation service slot has no git and no agent runtime on
    // its host — execution and workspaces run in platform task containers — so
    // the local host probes below apply only where this process executes work.
    if ((opts.executionHost ?? 'local') === 'local') {
      // 4. git version probe — RFC-130 D7: every node run merge-backs via
      // `git merge-tree --write-tree` (git >= 2.38). On older git the daemon boots
      // fine and every task dies at merge-back (AFTER its agent already ran) with a
      // cryptic `merge-back-failed: git merge-tree: usage: ...` — refuse at boot
      // instead. Unlike optional agent runtimes, git is a platform dependency for
      // repository/worktree/snapshot/merge-back operations. Side effect: populate
      // the RFC-034 capability cache read by resolveSubmoduleParams.
      const gitCaps = await detectGitCapabilities()
      const gitGateError = mergeTreeGateError(gitCaps)
      if (gitGateError !== null) {
        log.error('git incompatible', {
          found: gitCaps.version?.raw ?? null,
          requiredMinimum: MIN_GIT_VERSION,
        })
        console.error(
          `agent-workflow: ${gitGateError}\n` +
            `  upgrade git to >= ${MIN_GIT_VERSION} and restart; the daemon's PATH must resolve the upgraded binary.`,
        )
        await lock.release()
        process.exit(1)
      }
      log.info('git probe ok', { version: gitCaps.version?.raw ?? null })

      // RFC-111 D10: claude-code is optional — probe it SOFT (warn only, NEVER
      // refuse to start) when it is the configured default. RFC-226 makes OpenCode
      // optional too, but deliberately does not probe it here at all: its
      // version/build admission belongs to explicit runtime validation and use.
      if (config.defaultRuntime === 'claude-code') {
        const ccDriver = getRuntimeDriver('claude-code')
        const claudeProbe = await ccDriver.probe(ccDriver.defaultBinary(config)[0]!)
        if (!claudeProbe.compatible) {
          log.warn('claude-code default runtime unavailable (nodes selecting it will fail)', {
            binary: claudeProbe.binary,
            found: claudeProbe.version,
            requiredMinimum: ccDriver.minVersion,
            reason: claudeProbe.incompatibleReason ?? 'not found',
          })
        } else {
          log.info('claude-code probe ok', {
            version: claudeProbe.version,
            binary: claudeProbe.binary,
          })
        }
      }
    } else {
      log.info('execution runs on the platform; local git and runtime probes skipped')
    }

    // Provider-independent bootstrap secrets are needed by either selected
    // composition. They are created before opening a client, but no owner module
    // receives them until its verified provider graph is composed below.
    const secretBox = opts.secretBox ?? createSecretBox(Paths.secretKeyFile)
    log.info('secret box ready', {
      keyFile: opts.secretBox === undefined ? Paths.secretKeyFile : 'deployment-provided',
    })
    const token = ensureTokenFile(Paths.tokenFile)
    log.info('token ready', { tokenFile: Paths.tokenFile })
    // RFC-370 v2 §3.2 — crash-only execution authority: leaving active, or a
    // background set that fails to activate, drains and exits non-zero so the
    // platform restarts this instance as standby. Standalone never loses it.
    const executionExit = createExecutionExitRequests()
    opts.executionAuthority?.onLost((state) => {
      log.warn('execution authority lost', { state: state.kind })
      executionExit.request(`execution-authority-${state.kind}`)
    })
    const dbVersion = existsSync(migrationsFolder)
      ? readdirSync(migrationsFolder).filter((file) => file.endsWith('.sql')).length
      : 0
    // 5. DB — resolve the verified live generation before opening any provider
    // client. The pointer is authoritative; config may supply mechanism settings
    // but cannot silently select a different database.
    const preparedDatabase = await prepareDaemonDatabaseProviderForBoot({
      configuration: applicationConfiguration.databaseConfiguration,
      installation: opts.databaseInstallation,
      file: {
        config: config.database,
        sqlitePath: Paths.db,
        generationPointerPath: Paths.databaseGenerationPointer,
        operationsRoot: Paths.databaseMigrationsDir,
        contract: logicalSchemaContract,
        history: schemaHistory,
        lockPath: Paths.lock,
        lock,
        sqliteOptions: {
          migrationsFolder,
          synchronous: config.sqliteSynchronous,
          pageCacheMib: config.sqlitePageCacheMib,
          mmapMib: config.sqliteMmapMib,
          slowQueryMs: config.sqliteSlowQueryMs,
          skipIntegrityCheck: process.env.AGENT_WORKFLOW_SKIP_INTEGRITY_CHECK === '1',
          developmentIntegrity: opts.developmentIntegrity,
        },
        beforeSqliteOpen: () =>
          maybePreMigrationBackup({
            appHome: Paths.root,
            dbPath: Paths.db,
            migrationsFolder,
            enabled: config.backupOnMigration,
          }).then(() => undefined),
      },
    }).catch(async (err: unknown) => {
      if (isDbCorruptionFailure(err)) {
        // RFC-213 fail-closed: never serve a corrupt DB. Print the available
        // backups + the exact restore command, then exit non-zero. The DB is
        // unwritable, so this does NOT record a recovery_event.
        await lock.release()
        process.stderr.write(formatDbCorruptionGuidance(err))
        process.exit(1)
      }
      if (err instanceof DbSchemaDriftError) {
        await lock.release()
        process.stderr.write(formatDbSchemaDriftGuidance(err))
        process.exit(1)
      }
      throw err
    })
    config = { ...config, database: preparedDatabase.databaseConfig }
    const databaseProvider = preparedDatabase.runtime

    // DB — open + apply migrations. dbVersion = number of SQL files in the
    // bundled migrations folder (== the highest version we've applied, since
    // openDb() applies all pending migrations on startup). The migrations folder
    // itself (and any staged restore) was already resolved/applied at step 2.5.

    // RFC-213/RFC-223: raw pre-migration safety backup BEFORE openDb applies
    // migrations. A pending migration without its rollback generation is fatal;
    // backupOnMigration=false is the operator's explicit opt-out.
    // RFC-359 W3-T16：这里没有 provider 执行分支——按 provider 查表取会话装配器，
    // bootstrap / resume / 监听全部走同一条中立序列（design §6 / §7 守卫 4）。
    const bindHost = opts.host ?? config.bindHost
    const bindPort = opts.port ?? config.bindPort ?? 0
    const lifecycle = Object.freeze({
      operationId: 'daemon-start',
      provider: databaseProvider.provider,
      generationId: databaseProvider.generation.payload.generationId,
    })
    const sessionInput = Object.freeze({
      taskDeletionEffects: opts.taskDeletionEffects,
      repositoryPublicationTransport: opts.repositoryPublicationTransport,
      nodeRunPromptContentEffects: opts.nodeRunPromptContentEffects,
      portArtifactContentEffects: opts.portArtifactContentEffects,
      runtimeInventoryContent: opts.runtimeInventoryContent,
      taskRunSelection: opts.taskRunSelection,
      taskRecovery: opts.taskRecovery,
      taskInputFiles: opts.taskInputFiles,
      repositoryPreparationEffects: opts.repositoryPreparationEffects,
      scratchWorkspaceEffects: opts.scratchWorkspaceEffects,
      fusionWorkspaceEffects: opts.fusionWorkspaceEffects,
      workspaceMaintenanceFilesystem: opts.workspaceMaintenanceFilesystem,
      workspacePresence: opts.workspacePresence,
      initializeExecution: opts.initializeExecution,
      recoveredExecutionTaskIds: opts.recoveredExecutionTaskIds,
      hostedBackgroundOwners: opts.hostedBackgroundOwners,
      systemAgentRunFamily: opts.systemAgentRunFamily,
      mcpDiagnostics: opts.mcpDiagnostics,
      developmentPurposes: opts.developmentPurposes,
      runtimeManagement: opts.runtimeManagement,
      reviewArtifacts: opts.reviewArtifacts,
      reviewRollbackSnapshots: opts.reviewRollbackSnapshots,
      developmentWorkspaceRepositoryPreparation: opts.developmentWorkspaceRepositoryPreparation,
      workspaceExcludeProfiles: opts.workspaceExcludeProfiles,
      automationWorkspaceEffects: opts.automationWorkspaceEffects,
      actionWorkspaceEffects: opts.actionWorkspaceEffects,
      conflictMergeWorkspaceEffects: opts.conflictMergeWorkspaceEffects,
      config,
      configuration,
      applicationConfiguration,
      taskLaunchConfiguration,
      runtimeLegacyConfiguration,
      taskArchive: opts.taskArchive,
      skillContent: opts.skillContent,
      employeePrograms: opts.employeePrograms,
      programFixtureProcess: opts.programFixtureProcess,
      actionWorkspaceEntries: opts.actionWorkspaceEntries,
      repositoryRevisionContent: opts.repositoryRevisionContent,
      codeReviewArtifacts: opts.codeReviewArtifacts,
      employeeInputArtifacts: opts.employeeInputArtifacts,
      missionInputBlobs: opts.missionInputBlobs,
      pluginInstaller: opts.pluginInstaller,
      beforeEventObservationWrite: opts.beforeEventObservationWrite,
      humanGateArtifactRecovery: opts.humanGateArtifactRecovery,
      databaseBackup: opts.databaseBackup,
      archivedNodeEvents: opts.archivedNodeEvents,
      crewStationEvents: opts.crewStationEvents,
      intentArtifacts: opts.intentArtifacts,
      evidenceArtifacts: opts.evidenceArtifacts,
      resourcePackageSkillArtifacts: opts.resourcePackageSkillArtifacts,
      resourcePackagePluginArtifacts: opts.resourcePackagePluginArtifacts,
      resourcePackageSkillContent: opts.resourcePackageSkillContent,
      workspaceContent: opts.workspaceContent,
      repositoryRemote: opts.repositoryRemote,
      workspaceUploads: selectWorkspaceUploadContentFactory(opts.workspaceUploads),
      isolationWorkspaces: selectIsolationWorkspaceFactory(opts.isolationWorkspaces),
      repositoryGitWorkspaces: selectRepositoryGitWorkspaceFactory(opts.repositoryGitWorkspaces),
      repositoryCandidateEffects: opts.repositoryCandidateEffects,
      workspaceReads: selectRepositoryWorkspaceReadQueries(opts.workspaceReads),
      employeeCaseWorkspaceEffects: opts.employeeCaseWorkspaceEffects,
      repositoryBaselines: opts.repositoryBaselines,
      verificationCommands: opts.verificationCommands,
      bootExecutionRecovery: opts.bootExecutionRecovery,
      customObserverPrograms: opts.customObserverPrograms,
      maintenanceEffectsBootstrap: opts.maintenanceEffectsBootstrap,
      evidenceRead: opts.evidenceRead,
      evidenceDocumentCommands: opts.evidenceDocumentCommands,
      attemptContext: opts.attemptContext,
      daemonRuntime: daemonHost,
      token,
      secretBox,
      ...(opts.executionAuthority === undefined
        ? {}
        : { executionAuthority: opts.executionAuthority }),
      ...(opts.credentials === undefined ? {} : { credentials: opts.credentials }),
      onExecutionActivationFailure(error: unknown) {
        log.error('background activation failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        executionExit.request('execution-activation-failed')
      },
      dbVersion,
      log,
      lock,
      migrationsFolder,
      digitalEmployeeTypePackageDriftPolicy,
    })
    const { initial, bootstrap: daemonProviderBootstrap } = await composeDaemonProviderBootstrap({
      initial: lifecycle,
      composeInitial: (bindings) =>
        composeSession({
          ...sessionInput,
          ...bindings,
          provider: databaseProvider,
          lifecycle,
        }),
      sessionFactory: {
        async create(lifecycleInput, bindings) {
          // 只有迁移目标才会被重新装配；源 provider（SQLite）在割接后退役，不能再被当作
          // 新会话的来源——判据取自 provider 特征表，不在这里写 provider 字面量。
          if (databaseProviderTraits(lifecycleInput.provider).migrationRole !== 'target') {
            throw new Error('provider-session-source-retired')
          }
          const nextConfig = await configuration.read()
          const nextProvider = resolveDatabaseProviderRuntime({
            config: nextConfig.database,
            sqlitePath: Paths.db,
            generationPointerPath: Paths.databaseGenerationPointer,
            operationsRoot: Paths.databaseMigrationsDir,
            contract: logicalSchemaContract,
          })
          if (
            nextProvider.provider !== lifecycleInput.provider ||
            nextProvider.generation.payload.generationId !== lifecycleInput.generationId
          ) {
            await nextProvider.close()
            throw new Error('daemon-provider-target-generation-mismatch')
          }
          return (
            await composeSession({
              ...sessionInput,
              ...bindings,
              config: nextConfig,
              provider: nextProvider,
              lifecycle: lifecycleInput,
            })
          ).session
        },
      },
      createMigrationAdmission: createDatabaseMigrationDaemonAdmission,
      // RFC-349 —— 表投影是**进程级**的：`createPostgresqlDatabaseClient` 一构造就把
      // 它改指到 PostgreSQL。割接失败时 current 会退回源 session，但投影不会自己退
      // 回来，于是整个 daemon 的每一条 SQLite 查询都会以
      // `no such table: agent_workflow.*` 收场。把选择权钉在**真正在服务的**那份
      // composition 上，成功与失败两条路径都对。
      onCurrentSelected: (session) => selectDatabaseSchemaProvider(session.provider),
    })
    await initial.session.resume(lifecycle)
    await serveDaemon({
      bootstrap: daemonProviderBootstrap,
      authRuntime: initial.application.core.authRuntime,
      postReady: () => initial.session.postReady?.() ?? Promise.resolve(),
      databaseProvider: databaseProvider.provider,
      token,
      bindHost,
      bindPort,
      lock,
      daemonHost,
      log,
      exitRequests: executionExit.subscribe,
    })
  })
}

export function readyBrowserUrl(
  baseUrl: string,
  token: string,
  bootstrapRequired: boolean,
): string {
  return bootstrapRequired ? `${baseUrl}?token=${token}` : baseUrl
}
