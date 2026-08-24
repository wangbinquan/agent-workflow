import type {
  RepositoryCommitCandidateParticipant,
  RepositoryCommitPublicationParticipant,
  WorkspaceExcludeParticipant,
} from './public/participants'
import type { RepositoryPublishMode } from './public/types'
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
import type { RepositoryPublicationTransport } from './composition/repositoryPublicationTransport'
import {
  discardConflictMergeWorkspace,
  finishConflictMerge,
  inspectConflictMerge,
  prepareConflictMerge,
} from './application/conflictMerge'
import type { PlatformWorkspaceKind } from '@agent-workflow/shared'
import {
  canonicalRepositoryTransportBinding,
  normalizeGitLabRepositoryUrlPrefix,
  normalizeRepositoryTransportMappings,
  RepositoryTransportMappingV1Schema,
  type CodeHostProvider,
  type RepositoryTransportMappingV1,
} from '@agent-workflow/shared'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createSecretBoxFromKey, type SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import { codeHostConnections } from '@/db/schema'
import { RepositoryTransportCredentials } from './application/repositoryTransportCredentials'
import { SQLiteRepositoryTransportCredentialRepository } from './infrastructure/sqliteRepositoryTransportCredentialRepository'
import type { RepositoryTransportConnectionProjectionInput } from './ports/repositoryTransportCredentialRepository'
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

export {
  createRepositoryPublicationTransport,
  resolveRepositoryPublicationTransportFromKeyFile,
  type OpenRepositoryPublicationSessionResult,
  type RepositoryPublicationSession,
  type RepositoryPublicationSubject,
  type RepositoryPublicationTransport,
} from './composition/repositoryPublicationTransport'

export { cleanupOrphanedGitCredentialLeases } from './infrastructure/gitCredentialLease'

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
  db: DbClient,
  secretBox: SecretBox,
): RepositoryTransportCredentialModule {
  let bySecretBox = repositoryTransportModules.get(db)
  if (bySecretBox === undefined) {
    bySecretBox = new WeakMap<object, RepositoryTransportCredentialModule>()
    repositoryTransportModules.set(db, bySecretBox)
  }
  const cached = bySecretBox.get(secretBox)
  if (cached !== undefined) return cached
  const service = new RepositoryTransportCredentials(
    new SQLiteRepositoryTransportCredentialRepository(db),
    secretBox,
  )
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
  db: DbClient,
  keyFile: string,
): RepositoryTransportCredentials | null {
  try {
    return composeRepositoryTransportCredentials(db, createSecretBoxFromKey(readFileSync(keyFile)))
      .credentialSupply
  } catch {
    return null
  }
}

function parseTransportMappings(raw: string): RepositoryTransportMappingV1[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  const parsed = RepositoryTransportMappingV1Schema.array().max(32).safeParse(value)
  if (!parsed.success) return []
  const normalized = normalizeRepositoryTransportMappings(parsed.data)
  if (!normalized.ok) return []
  return normalized.value.map((mapping) => ({
    sshHost: mapping.sshHost,
    sshPort: mapping.sshPort,
    ...(mapping.sshPathPrefix === '' ? {} : { sshPathPrefix: mapping.sshPathPrefix }),
    httpBaseUrl: mapping.httpBaseUrl,
  }))
}

function parseAllowedBases(raw: string): string[] {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return []
    const normalized = normalizeGitLabRepositoryUrlPrefix(item)
    if (!normalized.ok) return []
    if (!out.includes(normalized.value)) out.push(normalized.value)
  }
  return out
}

function providerWebBase(provider: CodeHostProvider, apiBaseUrl: string): string | null {
  if (provider === 'gitlab') {
    return apiBaseUrl.endsWith('/api/v4') ? apiBaseUrl.slice(0, -'/api/v4'.length) : null
  }
  if (apiBaseUrl === 'https://api.github.com') return 'https://github.com'
  return apiBaseUrl.endsWith('/api/v3') ? apiBaseUrl.slice(0, -'/api/v3'.length) : null
}

/** Bootstrap coordinator: derive the source-control projection without plaintext. */
export function buildRepositoryTransportConnectionProjection(input: {
  readonly provider: CodeHostProvider
  readonly connectionGeneration: string
  readonly baseUrl: string
  readonly rejectUnauthorized: boolean
  readonly repositoryUrlPrefixesJson: string
  readonly transportMappingsJson: string
  readonly tokenEnc: string
  readonly tokenHint: string
  readonly updatedAt: number
  readonly updatedBy: string | null
}): RepositoryTransportConnectionProjectionInput {
  const transportMappings = parseTransportMappings(input.transportMappingsJson)
  const allowedHttpBaseUrls = parseAllowedBases(input.repositoryUrlPrefixesJson)
  const webBase = providerWebBase(input.provider, input.baseUrl)
  if (webBase !== null && !allowedHttpBaseUrls.includes(webBase)) allowedHttpBaseUrls.push(webBase)
  for (const mapping of transportMappings) {
    const normalized = normalizeGitLabRepositoryUrlPrefix(mapping.httpBaseUrl)
    if (normalized.ok && !allowedHttpBaseUrls.includes(normalized.value)) {
      allowedHttpBaseUrls.push(normalized.value)
    }
  }
  allowedHttpBaseUrls.sort()
  const canonical = canonicalRepositoryTransportBinding({
    version: 1,
    provider: input.provider,
    connectionGeneration: input.connectionGeneration,
    apiBaseUrl: input.baseUrl,
    rejectUnauthorized: input.rejectUnauthorized,
    transportMappings,
    allowedHttpBaseUrls,
  })
  if (canonical === null) {
    throw new Error(`invalid repository transport binding for ${input.provider}`)
  }
  return {
    provider: input.provider,
    connectionGeneration: input.connectionGeneration,
    endpointBindingDigest: createHash('sha256').update(canonical).digest('hex'),
    apiBaseUrl: input.baseUrl,
    rejectUnauthorized: input.rejectUnauthorized,
    transportMappings,
    allowedHttpBaseUrls,
    globalTokenEnc: input.tokenEnc,
    globalTokenHint: input.tokenHint,
    updatedAt: input.updatedAt,
    updatedBy: input.updatedBy,
  }
}

/** Upgrade/boot convergence for the migration's ciphertext-only initial projection. */
export function reconcileRepositoryTransportConnectionProjections(
  db: DbClient,
  participant: {
    synchronize(input: RepositoryTransportConnectionProjectionInput): void
    removeConnection(provider: CodeHostProvider): boolean
  },
): void {
  const rows = db.select().from(codeHostConnections).all()
  const present = new Set<CodeHostProvider>()
  for (const row of rows) {
    present.add(row.provider)
    participant.synchronize(buildRepositoryTransportConnectionProjection(row))
  }
  for (const provider of ['gitlab', 'github'] as const) {
    if (!present.has(provider)) participant.removeConnection(provider)
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
