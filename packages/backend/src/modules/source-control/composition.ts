import type { RepositoryBackupPreparationParticipant } from './public/participants'
import type { RepositoryOverviewQueries } from './public/queries'
import type { RepositoryPublicationTransport } from './public/types'
import { ensurePlatformWorkspaceDirectory } from './infrastructure/platformWorkspaceDirectory'
import type { PlatformWorkspaceKind } from '@agent-workflow/shared'
import { type CodeHostProvider } from '@agent-workflow/shared'
import { readFileSync } from 'node:fs'
import { createSecretBoxFromKey, type SecretBox } from '@/auth/secretBox'
import { RepositoryTransportCredentials } from './application/repositoryTransportCredentials'
import type {
  RepositoryTransportConnectionProjectionInput,
  RepositoryTransportCredentialRepository,
} from './ports/repositoryTransportCredentialRepository'
import { buildRepositoryTransportConnectionProjection } from './application/repositoryTransportConnectionProjection'
import {
  checkpointEmployeeCaseWorkspace,
  discardEmployeeCaseWorkspace,
  importEmployeeWorkspaceCommit,
  fetchEmployeeWorkspaceRemoteHead,
  materializeEmployeeCaseWorkspace,
  rematerializeEmployeeCaseWorkspace,
  resolveEmployeeWorkspaceBaseline,
  restoreEmployeeCaseWorkspace,
} from './application/employeeCaseWorkspace'
import {
  EMPLOYEE_CASE_WORKSPACE_OPERATIONS,
  isEmployeeCaseWorkspaceOperationHost,
  type EmployeeCaseWorkspaceEffectsFactory,
} from './application/ports/employeeCaseWorkspaceOperations'
import { createFileEmployeeCaseWorkspaceEffectsFactory } from './infrastructure/local/fileEmployeeCaseWorkspaceEffects'
import type { RepositoryWorkspaceStore } from './ports/repositoryWorkspaceStore'
import { ensureCredentialsSealed } from '@/services/repoCredentials'

export {
  createRepositoryPublicationTransport,
  resolveRepositoryPublicationTransportFromKeyFile,
} from './composition/repositoryPublicationTransport'
// RFC-451：本地镜像缓存家族（批量导入的清理与归属、后台子模块保鲜、开发工作区仓库准备），供装配根取用。
export { batchOwnerUserId, startBatchImportGc } from './infrastructure/local/repositoryBatchImport'
export { startConfiguredSubmoduleRefreshLoop } from './infrastructure/local/repositoryMirrorAutoRefresh'
export {
  assertDevelopmentWorkspaceRepositoryFreshness,
  buildDevelopmentWorkspaceRepositoryPreparation,
  createDevelopmentWorkspaceRepositoryPreparation,
  type DevelopmentWorkspaceRepositoryPreparation,
} from './infrastructure/local/developmentWorkspaceRepositoryPreparation'
export { composeWorkspaceMaintenanceCommand } from './composition/workspaceMaintenance'
export { createFileWorkspacePresenceQueries } from './infrastructure/local/fileWorkspacePresence'
// RFC-431: the standalone profile's local selections (the hosted profile selects its own).
export { createFileWorkspaceUploadContentFactory } from './infrastructure/local/fileWorkspaceUploadContent'
export { createLocalIsolationWorkspaceFactory } from './infrastructure/local/localIsolationWorkspace'
export { createFileRepositoryGitWorkspaceFactory } from './infrastructure/local/fileRepositoryGitWorkspace'
export { createFileRepositoryWorkspaceReadQueries } from './infrastructure/local/fileRepositoryWorkspaceReadQueries'
export { createNodeWorkspaceMaintenanceFilesystem } from './infrastructure/nodeWorkspaceMaintenanceFilesystem'
export { createFileEmployeeCaseWorkspaceEffectsFactory } from './infrastructure/local/fileEmployeeCaseWorkspaceEffects'
export { composeLocalWorkspaceExcludeProfiles } from './composition/workspaceExcludeProfiles'
export { buildRepositoryTransportConnectionProjection } from './application/repositoryTransportConnectionProjection'
// RFC-359 W4-B6：仓库工作区存储只有一份；两个 bootstrap 与存量调用方仍经各自的具名绑定装配。
export {
  composeRepositoryWorkspaceStore,
  composeRepositoryWorkspaceStore as composeSqliteRepositoryWorkspaceStore,
  composeRepositoryWorkspaceStore as composePostgresqlRepositoryWorkspaceStore,
} from './infrastructure/repositoryWorkspaceStore'
// RFC-359 W4-B6：凭据仓库只有一份；两个 bootstrap 与存量调用方仍经各自的具名绑定装配。
export {
  DrizzleRepositoryTransportCredentialRepository,
  DrizzleRepositoryTransportCredentialRepository as SQLiteRepositoryTransportCredentialRepository,
  DrizzleRepositoryTransportCredentialRepository as PostgresqlRepositoryTransportCredentialRepository,
} from './infrastructure/repositoryTransportCredentialRepository'

export type { RepositoryTransportCredentialRepository } from './ports/repositoryTransportCredentialRepository'
export type { RepositoryWorkspaceStore } from './ports/repositoryWorkspaceStore'
/** The deployment's candidate selection (RFC-370 §9.2 V3): in-process step
 * effects, or a host running each whole use case in a remote volume. Only
 * daemon roots pass it through, so it stays off the public contract. */
export type {
  RepositoryCandidateEffectsFactory,
  RepositoryCandidateOperationHost,
} from './application/ports/repositoryCandidateOperations'
/** RFC-370: the deployment's preparation, scratch and maintenance filesystem
 * selections (local files or a hosted volume), passed through daemon roots. */
export type { RepositoryPreparationEffectFactory } from './application/ports/repositoryPreparationEffects'
export type { ScratchWorkspaceEffects } from './application/ports/scratchWorkspaceEffects'
// RFC-370 §10 V20: the standalone fusion engine workspace (`fusions/<id>/iter<n>/work`).
export { createFileFusionWorkspaceEffects } from './infrastructure/local/fileFusionWorkspaceEffects'
export type {
  WorkspaceGcTaskPort,
  TaskWorkspacePruneParticipant,
  CachedRepositoryTaskUsagePort,
  TaskRepositorySourceSealingPort,
  RepositoryWorkspaceTaskPorts,
} from './composition/required-ports'
export type { WorkspaceMaintenanceFilesystem } from './application/ports/workspaceMaintenance'

export interface RepositoryWorkspaceOperations {
  readonly backupPreparation: RepositoryBackupPreparationParticipant
  readonly overviewQueries: RepositoryOverviewQueries
}

/** Closed application surface shared by SQLite and PostgreSQL composition. */
export function composeRepositoryWorkspaceOperations(
  store: RepositoryWorkspaceStore,
  secretBox: SecretBox | undefined,
): RepositoryWorkspaceOperations {
  return Object.freeze({
    backupPreparation: Object.freeze({
      prepare: (input = {}) => ensureCredentialsSealed(store, secretBox, input),
    }),
    overviewQueries: Object.freeze({
      countCachedRepositories: () => store.countCachedRepos(),
    }),
  })
}

export type {
  OpenRepositoryPublicationSessionResult,
  RepositoryPublicationSession,
  RepositoryPublicationSubject,
  RepositoryPublicationTransport,
} from './public/types'

export { cleanupOrphanedGitCredentialLeases } from '@/util/gitCredentialLease'

export interface RepositoryTransportCredentialModule {
  readonly ownCredentials: RepositoryTransportCredentials
  readonly adminConnections: RepositoryTransportCredentials
  readonly credentialSelection: RepositoryTransportCredentials
  readonly credentialSupply: RepositoryTransportCredentials
}

const repositoryTransportModules = new WeakMap<
  object,
  WeakMap<object, RepositoryTransportCredentialModule>
>()

/** Bootstrap-owned RFC-321 source-control transport composition. */
export function composeRepositoryTransportCredentials(
  repository: RepositoryTransportCredentialRepository,
  secretBox: SecretBox,
): RepositoryTransportCredentialModule {
  let bySecretBox = repositoryTransportModules.get(repository)
  if (bySecretBox === undefined) {
    bySecretBox = new WeakMap<object, RepositoryTransportCredentialModule>()
    repositoryTransportModules.set(repository, bySecretBox)
  }
  const cached = bySecretBox.get(secretBox)
  if (cached !== undefined) return cached
  const service = new RepositoryTransportCredentials(repository, secretBox)
  const module = Object.freeze({
    ownCredentials: service,
    adminConnections: service,
    credentialSelection: service,
    credentialSupply: service,
  })
  bySecretBox.set(secretBox, module)
  return module
}

/** Scheduler/background composition. Missing or unreadable key material is a
 * fail-closed unavailable supply; this helper never creates a replacement key. */
export function resolveRepositoryTransportCredentialsFromKeyFile(
  repository: RepositoryTransportCredentialRepository,
  keyFile: string,
): RepositoryTransportCredentials | null {
  try {
    return composeRepositoryTransportCredentials(
      repository,
      createSecretBoxFromKey(readFileSync(keyFile)),
    ).credentialSupply
  } catch {
    return null
  }
}

/** Upgrade/boot convergence for the migration's ciphertext-only initial projection. */
export async function reconcileRepositoryTransportConnectionProjections(
  repository: RepositoryTransportCredentialRepository,
  participant: {
    synchronize(input: RepositoryTransportConnectionProjectionInput): Promise<void>
    removeConnection(provider: CodeHostProvider): Promise<boolean>
  },
): Promise<void> {
  const rows = await repository.listConfiguredConnections()
  const present = new Set<CodeHostProvider>()
  for (const row of rows) {
    present.add(row.provider)
    await participant.synchronize(buildRepositoryTransportConnectionProjection(row))
  }
  for (const provider of ['gitlab', 'github'] as const) {
    if (!present.has(provider)) await participant.removeConnection(provider)
  }
}

export { bindWorkspaceExcludeParticipant } from './infrastructure/workspaceExcludeBinding'

export { bindRepositoryCommitParticipant } from './composition/repositoryCommit'

/** RFC-308 composition-only path binding; absolute path never enters public DTOs. */
export function ensureBoundPlatformWorkspaceDirectory(input: {
  worktreePath: string
  kind: PlatformWorkspaceKind
  segments?: readonly string[]
}): string {
  return ensurePlatformWorkspaceDirectory(input)
}

/**
 * RFC-310 PR-4 T48 —— ChangeCandidate 派生的组装（development-automation 以
 * 结构同形端口接收；两模块互不 import 对方内部，同 requirementSource 先例）。
 */
export { bindChangeCandidateParticipant } from './composition/repositoryCandidate'

/**
 * RFC-310 PR-5 T59：candidate 发布链的 source-control 半（stage 重放 + durable
 * commit + exact-head CAS push）。结构同形注入 development-automation（同
 * changeCandidate 先例）；Mission 侧永不直接调 Git。
 */
export { bindCandidateDeliveryParticipant } from './composition/repositoryCandidate'

/**
 * RFC-310 PR-7b T77：conflict merge 的 source-control 半（prepare 保留
 * conflict markers 供 repair Agent、finish 只收冲突集并以平台身份产 merge
 * commit）。结构同形注入 development-automation；Mission 侧永不直接调 Git。
 */
export { bindConflictMergeParticipant } from './composition/conflictMerge'

type BoundEmployeeCaseOperation<F extends (...args: never[]) => unknown> = (
  request: Parameters<F>[0],
) => ReturnType<F>

/** A complete effects factory for a durable, single-writer employee Case scene. */
export function bindEmployeeCaseWorkspaceParticipant(
  input: {
    readonly publicationTransport?: RepositoryPublicationTransport
    readonly effects?: EmployeeCaseWorkspaceEffectsFactory
  } = {},
): {
  materialize: BoundEmployeeCaseOperation<typeof materializeEmployeeCaseWorkspace>
  rematerialize: BoundEmployeeCaseOperation<typeof rematerializeEmployeeCaseWorkspace>
  fetchRemoteHead: BoundEmployeeCaseOperation<typeof fetchEmployeeWorkspaceRemoteHead>
  checkpoint: BoundEmployeeCaseOperation<typeof checkpointEmployeeCaseWorkspace>
  restore: BoundEmployeeCaseOperation<typeof restoreEmployeeCaseWorkspace>
  discard: BoundEmployeeCaseOperation<typeof discardEmployeeCaseWorkspace>
  resolveBaseline: BoundEmployeeCaseOperation<typeof resolveEmployeeWorkspaceBaseline>
  importCommit: BoundEmployeeCaseOperation<typeof importEmployeeWorkspaceCommit>
} {
  const selected = input.effects ?? createFileEmployeeCaseWorkspaceEffectsFactory()
  // RFC-370 §9.2 V3: a hosted scene runs each whole use case in its volume,
  // fetching with the volume's own platform Git credentials.
  if (isEmployeeCaseWorkspaceOperationHost(selected)) {
    const operations = selected.operations as Partial<typeof selected.operations> | null
    if (
      operations === null ||
      typeof operations !== 'object' ||
      EMPLOYEE_CASE_WORKSPACE_OPERATIONS.some((name) => typeof operations[name] !== 'function')
    )
      throw new Error('employee-case-workspace-effects-incomplete')
    return selected.operations
  }
  const effects = selected
  return {
    materialize: (request) => materializeEmployeeCaseWorkspace(request, effects),
    rematerialize: (request) => rematerializeEmployeeCaseWorkspace(request, effects),
    fetchRemoteHead: (request) =>
      fetchEmployeeWorkspaceRemoteHead(
        {
          ...request,
          ...(input.publicationTransport === undefined
            ? {}
            : { publicationTransport: input.publicationTransport }),
        },
        effects,
      ),
    checkpoint: (request) => checkpointEmployeeCaseWorkspace(request, effects),
    restore: (request) => restoreEmployeeCaseWorkspace(request, effects),
    discard: (request) => discardEmployeeCaseWorkspace(request, effects),
    resolveBaseline: (request) => resolveEmployeeWorkspaceBaseline(request, effects),
    importCommit: (request) => importEmployeeWorkspaceCommit(request, effects),
  }
}

export type {
  EmployeeCaseWorkspaceEffectsFactory,
  EmployeeCaseWorkspaceOperationHost,
} from './application/ports/employeeCaseWorkspaceOperations'

export { createWorkspaceContentScope } from './infrastructure/workspaceContent'
/** The standalone workspace content (local files); hosted roots select their own. */
export {
  createFileWorkspaceContentEffects,
  createFileWorkspaceContentEffectsFactory,
} from './infrastructure/local/fileWorkspaceContentEffects'
export type {
  WorkspaceContentEffects,
  WorkspaceContentEffectsFactory,
} from './application/ports/workspaceContentEffects'
/** RFC-370 §10 V17: registered repositories' reads, registration and refresh. */
export { composeRepositoryMirrors } from './composition/repositoryMirrors'
/** RFC-447: repository-group management and the standalone URL import. */
export { composeRepositoryGroups, localRepositoryUrlImport } from './composition/repositoryGroups'
export {
  composeCachedRepositoryOperations,
  type CachedRepositorySettings,
} from './composition/cachedRepositoryOperations'
export type {
  RepositoryMirrors,
  RepositoryRemoteEffects,
} from './application/ports/repositoryMirrors'
// RFC-363 T4/T7 compatibility binding; launch adapters retire this path after durable cutover.
export {
  type WorkspaceMaterializationDependencies,
  materializeWorktree,
  type ResolvedRepoSource,
  type RepoSourceSpec,
  normalizeStartTaskRepos,
  resolveRepoSourceSingleWithProvider,
  type MaterializedRepo,
  type MaterializedSpace,
  type WorkspaceCleanupHookEvent,
  type WorkspaceCleanupFailure,
  type WorkspaceCleanupReport,
  type MaterializedSpaceCleanup,
  createMaterializedSpaceCleanup,
  cleanupMaterializedSpaceLease,
  cleanupMaterializedSpace,
  commitMaterializedSpace,
  withWorkspaceCleanupReport,
  type PlannedSpaceLayout,
  materializeSpaceWithProvider,
} from './infrastructure/workspaceMaterializer'

export { createGitTaskDeletionRepositoryEffects } from './infrastructure/local/gitTaskDeletionRepositoryEffects'

export { schemaContribution } from './composition/schema'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createRepositoryPreparationLookup } from './infrastructure/repositoryPreparationLookup'
import { composeRepositoryPreparationLookup as bindRepositoryPreparationLookup } from './application/adapters/task-execution-adapter'

export function composeRepositoryPreparationLookup(db: PersistenceDb) {
  return bindRepositoryPreparationLookup(createRepositoryPreparationLookup(db))
}

// RFC-399 B1: bootstrap's maintenance job table takes these handlers via composition.
export { createSourceControlMaintenanceJobHandlers } from './application/maintenanceJobs'
