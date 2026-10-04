import type {
  RepositoryBackupPreparationParticipant,
  RepositoryCommitCandidateParticipant,
  RepositoryCommitPublicationParticipant,
} from './public/participants'
import type { RepositoryOverviewQueries } from './public/queries'
import type { RepositoryPublicationTransport, RepositoryPublishMode } from './public/types'
import {
  prepareRepositoryCommit,
  commitPreparedRepository,
  classifyRepositoryCommitPath,
  publishRepositoryCommit,
  readRepositoryCommitPreview,
  resolvePushBase,
  updateRepositoryRef,
  type RepositoryGit,
} from './application/repositoryCommit'
import { ensurePlatformWorkspaceDirectory } from './infrastructure/platformWorkspaceDirectory'
import { createFileRepositoryPreviewIndexPort } from './infrastructure/local/fileRepositoryPreviewIndex'
import type { RepositoryPreviewIndexPort } from './application/ports/repositoryPreviewIndex'
import type { RepositoryGitWorkspaceScope } from './application/ports/repositoryGitWorkspace'
import { requireRepositoryGitWorkspaceScope } from './composition/repositoryGitWorkspaces'
import {
  discardConflictMergeWorkspace,
  finishConflictMerge,
  inspectConflictMerge,
  prepareConflictMerge,
} from './application/conflictMerge'
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
import type { EmployeeCaseWorkspaceEffectsFactory } from './application/ports/employeeCaseWorkspaceEffects'
import { createFileEmployeeCaseWorkspaceEffectsFactory } from './infrastructure/local/fileEmployeeCaseWorkspaceEffects'
import type { RepositoryWorkspaceStore } from './ports/repositoryWorkspaceStore'
import { ensureCredentialsSealed } from '@/services/repoCredentials'

export {
  createRepositoryPublicationTransport,
  resolveRepositoryPublicationTransportFromKeyFile,
} from './composition/repositoryPublicationTransport'
export { composeWorkspaceMaintenanceCommand } from './composition/workspaceMaintenance'
export { createFileWorkspacePresenceQueries } from './infrastructure/local/fileWorkspacePresence'
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

export {
  classifyRepositoryPushFailure,
  type RepositoryPushFailureCode,
} from './domain/repositoryPushFailure'

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

/**
 * RFC-308 temporary path binder. Consumers receive operations bound to one
 * repository and one immutable settings slice; Git mechanics stay private to
 * source-control. RFC-294 W5 replaces the absolute-path binding with WorkspaceRef.
 */
export function bindRepositoryCommitParticipant(input: {
  repoPath: string
  configuredPatterns?: readonly string[]
  runGit?: RepositoryGit
  gitOptions?: Parameters<RepositoryGit>[2]
  previewIndex?: RepositoryPreviewIndexPort
  gitWorkspace?: RepositoryGitWorkspaceScope
  runNetworkGit?: RepositoryGit
}): RepositoryCommitCandidateParticipant & RepositoryCommitPublicationParticipant {
  const workspace = input.gitWorkspace
  if (workspace !== undefined) requireRepositoryGitWorkspaceScope(workspace)
  const runGit: RepositoryGit | undefined =
    workspace === undefined
      ? input.runGit
      : (_repoPath, args, options) => workspace.run(args, options)
  const common = {
    repoPath: input.repoPath,
    configuredPatterns: input.configuredPatterns ?? [],
    ...(runGit !== undefined ? { runGit } : {}),
    ...(input.gitOptions !== undefined ? { gitOptions: input.gitOptions } : {}),
  }
  const previewIndex: RepositoryPreviewIndexPort =
    workspace === undefined
      ? (input.previewIndex ?? createFileRepositoryPreviewIndexPort(common))
      : { withIndex: (operation) => workspace.withPreviewIndex(operation, common.gitOptions) }
  return {
    prepare: () => prepareRepositoryCommit(common),
    commitPrepared: (request: {
      message: string
      verification: 'normal' | 'artifact'
      authorName?: string | null
      authorEmail?: string | null
    }) => commitPreparedRepository({ ...common, ...request }),
    preview: () => readRepositoryCommitPreview({ ...common, previewIndex }),
    publish: (request: { baseSha: string; tipSha: string; mode: RepositoryPublishMode }) =>
      publishRepositoryCommit({
        ...common,
        ...request,
        ...(input.runNetworkGit === undefined ? {} : { runNetworkGit: input.runNetworkGit }),
      }),
    resolvePushBase: (request: { remote: string; branch: string; fallbackRef: string }) =>
      resolvePushBase({
        repoPath: input.repoPath,
        ...request,
        ...(workspace === undefined
          ? input.runGit !== undefined
            ? { runGit: input.runGit }
            : {}
          : { runGit }),
      }),
    classifyPath: (request: { path: string; directory?: boolean }) =>
      classifyRepositoryCommitPath({ ...common, ...request }),
    updateRef: (request: { ref: string; commitSha?: string }) =>
      updateRepositoryRef({
        repoPath: input.repoPath,
        ...request,
        ...(workspace === undefined
          ? input.runGit !== undefined
            ? { runGit: input.runGit }
            : {}
          : { runGit }),
        ...(input.gitOptions !== undefined ? { gitOptions: input.gitOptions } : {}),
      }),
  }
}

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
export function bindConflictMergeParticipant(): {
  prepare: typeof prepareConflictMerge
  inspect: typeof inspectConflictMerge
  finish: typeof finishConflictMerge
  discard: typeof discardConflictMergeWorkspace
} {
  return {
    prepare: prepareConflictMerge,
    inspect: inspectConflictMerge,
    finish: finishConflictMerge,
    discard: discardConflictMergeWorkspace,
  }
}

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
  const effects = input.effects ?? createFileEmployeeCaseWorkspaceEffectsFactory()
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

export type { EmployeeCaseWorkspaceEffectsFactory } from './application/ports/employeeCaseWorkspaceEffects'

export { createWorkspaceContentScope } from './infrastructure/workspaceContent'
export type {
  WorkspaceContentEffects,
  WorkspaceContentEffectsFactory,
} from './application/ports/workspaceContentEffects'
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
