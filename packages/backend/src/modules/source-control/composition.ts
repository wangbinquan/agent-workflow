import type {
  RepositoryBackupPreparationParticipant,
  RepositoryCommitCandidateParticipant,
  RepositoryCommitPublicationParticipant,
  WorkspaceExcludeParticipant,
} from './public/participants'
import type { RepositoryOverviewQueries } from './public/queries'
import type { RepositoryPublicationTransport, RepositoryPublishMode } from './public/types'
import { ensureWorkspaceExcludeProfile } from './infrastructure/workspaceExcludeManager'
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
import { deriveChangeCandidate, stageCandidateTree } from './application/changeCandidate'
import { commitCandidate, pushCandidate } from './application/deliverCandidate'
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
import type { RepositoryWorkspaceStore } from './ports/repositoryWorkspaceStore'
import { ensureCredentialsSealed } from '@/services/repoCredentials'

export {
  createRepositoryPublicationTransport,
  resolveRepositoryPublicationTransportFromKeyFile,
} from './composition/repositoryPublicationTransport'
export {
  composePostgresqlWorkspaceMaintenanceCommand,
  composeSqliteWorkspaceMaintenanceCommand,
} from './composition/workspaceMaintenance'
export { buildRepositoryTransportConnectionProjection } from './application/repositoryTransportConnectionProjection'
export { composeSqliteRepositoryWorkspaceStore } from './infrastructure/sqliteRepositoryWorkspaceStore'
export { composePostgresqlRepositoryWorkspaceStore } from './infrastructure/postgresqlRepositoryWorkspaceStore'
export { SQLiteRepositoryTransportCredentialRepository } from './infrastructure/sqliteRepositoryTransportCredentialRepository'
export { PostgresqlRepositoryTransportCredentialRepository } from './infrastructure/postgresqlRepositoryTransportCredentialRepository'

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

/** RFC-308 temporary composition seam until RFC-294 W5 owns durable WorkspaceRef. */
export function bindWorkspaceExcludeParticipant(input: {
  worktreePath: string
  appHome?: string
}): WorkspaceExcludeParticipant {
  return {
    ensure: (request = {}) =>
      ensureWorkspaceExcludeProfile({
        ...input,
        directChildMounts: request.directChildMounts ?? [],
      }),
  }
}

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
}): RepositoryCommitCandidateParticipant & RepositoryCommitPublicationParticipant {
  const common = {
    repoPath: input.repoPath,
    configuredPatterns: input.configuredPatterns ?? [],
    ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
    ...(input.gitOptions !== undefined ? { gitOptions: input.gitOptions } : {}),
  }
  return {
    prepare: () => prepareRepositoryCommit(common),
    commitPrepared: (request: {
      message: string
      verification: 'normal' | 'artifact'
      authorName?: string | null
      authorEmail?: string | null
    }) => commitPreparedRepository({ ...common, ...request }),
    preview: () => readRepositoryCommitPreview(common),
    publish: (request: { baseSha: string; tipSha: string; mode: RepositoryPublishMode }) =>
      publishRepositoryCommit({ ...common, ...request }),
    resolvePushBase: (request: { remote: string; branch: string; fallbackRef: string }) =>
      resolvePushBase({
        repoPath: input.repoPath,
        ...request,
        ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
      }),
    classifyPath: (request: { path: string; directory?: boolean }) =>
      classifyRepositoryCommitPath({ ...common, ...request }),
    updateRef: (request: { ref: string; commitSha?: string }) =>
      updateRepositoryRef({
        repoPath: input.repoPath,
        ...request,
        ...(input.runGit !== undefined ? { runGit: input.runGit } : {}),
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
export function bindChangeCandidateParticipant(): {
  derive: typeof deriveChangeCandidate
} {
  return { derive: deriveChangeCandidate }
}

/**
 * RFC-310 PR-5 T59：candidate 发布链的 source-control 半（stage 重放 + durable
 * commit + exact-head CAS push）。结构同形注入 development-automation（同
 * changeCandidate 先例）；Mission 侧永不直接调 Git。
 */
export function bindCandidateDeliveryParticipant(
  input: { readonly publicationTransport?: RepositoryPublicationTransport } = {},
): {
  stage: typeof stageCandidateTree
  commit: typeof commitCandidate
  push: typeof pushCandidate
} {
  return {
    stage: stageCandidateTree,
    commit: commitCandidate,
    push: (request) =>
      pushCandidate({
        ...request,
        ...(input.publicationTransport === undefined
          ? {}
          : { publicationTransport: input.publicationTransport }),
      }),
  }
}

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

/** RFC-310 OS path binder for a durable, single-writer employee Case scene. */
export function bindEmployeeCaseWorkspaceParticipant(
  input: { readonly publicationTransport?: RepositoryPublicationTransport } = {},
): {
  materialize: typeof materializeEmployeeCaseWorkspace
  rematerialize: typeof rematerializeEmployeeCaseWorkspace
  fetchRemoteHead: typeof fetchEmployeeWorkspaceRemoteHead
  checkpoint: typeof checkpointEmployeeCaseWorkspace
  restore: typeof restoreEmployeeCaseWorkspace
  discard: typeof discardEmployeeCaseWorkspace
  resolveBaseline: typeof resolveEmployeeWorkspaceBaseline
  importCommit: typeof importEmployeeWorkspaceCommit
} {
  return {
    materialize: materializeEmployeeCaseWorkspace,
    rematerialize: rematerializeEmployeeCaseWorkspace,
    fetchRemoteHead: (request) =>
      fetchEmployeeWorkspaceRemoteHead({
        ...request,
        ...(input.publicationTransport === undefined
          ? {}
          : { publicationTransport: input.publicationTransport }),
      }),
    checkpoint: checkpointEmployeeCaseWorkspace,
    restore: restoreEmployeeCaseWorkspace,
    discard: discardEmployeeCaseWorkspace,
    resolveBaseline: resolveEmployeeWorkspaceBaseline,
    importCommit: importEmployeeWorkspaceCommit,
  }
}
