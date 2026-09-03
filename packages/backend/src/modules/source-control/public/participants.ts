import type { CodeHostProvider, RepositoryEndpointCandidate } from '@agent-workflow/shared'
import type {
  CommitPreparedResult,
  PrepareRepositoryCommitResult,
  RepositoryCommitPreviewResult,
  RepositoryPublishMode,
  RepositoryPublishResult,
  WorkspaceExcludeProfileReceipt,
  RepositoryTransportCredentialSelection,
} from './types'

export interface RepositoryTransportCredentialSelectionParticipant {
  select(input: {
    readonly subject:
      | { readonly kind: 'user'; readonly userId: string }
      | { readonly kind: 'system' }
    readonly provider: CodeHostProvider
  }): Promise<RepositoryTransportCredentialSelection>
}

/** Secret-free provider metadata query used by repository endpoint resolution. */
export interface RepositoryEndpointDiscoveryParticipant {
  discover(input: {
    readonly provider: CodeHostProvider
    readonly project: string
    readonly connectionGeneration: string
  }): Promise<RepositoryEndpointCandidate | null>
}

export interface RepositoryCredentialSealingReceipt {
  readonly sealed: number
  readonly linked: number
  readonly scrubbed: number
}

/** Backup-facing credential gate. Persistence and SecretBox ownership remain
 * inside source-control composition; callers receive only the closed action. */
export interface RepositoryBackupPreparationParticipant {
  prepare(input?: {
    readonly blockOnCredentialedPath?: boolean
  }): Promise<RepositoryCredentialSealingReceipt>
}

/** A worktree-bound participant; absolute paths never cross this interface. */
export interface WorkspaceExcludeParticipant {
  ensure(input?: { directChildMounts?: readonly string[] }): Promise<WorkspaceExcludeProfileReceipt>
}

/** Bound candidate/index/commit surface; no repository path crosses it. */
export interface RepositoryCommitCandidateParticipant {
  prepare(): Promise<PrepareRepositoryCommitResult>
  preview(): Promise<RepositoryCommitPreviewResult>
  commitPrepared(input: {
    message: string
    verification: 'normal' | 'artifact'
    authorName?: string | null
    authorEmail?: string | null
  }): Promise<CommitPreparedResult>
  classifyPath(input: {
    path: string
    directory?: boolean
  }): Promise<{ excluded: boolean; policyDigest: string }>
}

/** Bound ref/publication surface; every publish performs its own history scan. */
export interface RepositoryCommitPublicationParticipant {
  publish(input: {
    baseSha: string
    tipSha: string
    mode: RepositoryPublishMode
  }): Promise<RepositoryPublishResult>
  resolvePushBase(input: {
    remote: string
    branch: string
    fallbackRef: string
  }): Promise<string | null>
  updateRef(input: {
    ref: string
    commitSha?: string
  }): Promise<{ ok: true } | { ok: false; error: string }>
}

// ---------------------------------------------------------------------------
// RFC-352（RFC-294 W4-E2）—— repository / repository-group scope 的授权 participant。
//
// 由来：memory 的 scope Move 需要判定「这条记忆能不能挂到某个仓库 / 仓库组名下」，
// 而在此之前它是**直接 select `cachedRepos` / `repoGroups` 两张 source-control 的表**
// 来做的（`modules/memory/infrastructure/{sqlite,postgresql}*` 各一份）。那是跨 context
// 直读别人的表；RFC-294 `design.md:3441` 因此要求 source-control 提供这个 offered
// participant，`plan.md §8` 把它列为 W4-E2 的前置件。
//
// **行为逐字等于迁移前**：repo / repo_group scope 的管理权今天就是「仅 `resource-acl:bypass`」
// （RFC-248 / RFC-305）。这里不引入仓库属主委派——那是权限档位变更，须单独立项。
//
// 与 RFC-294 `design.md:3441` 的签名偏离（一条，故意）：文档写的是单方法
// `assertManageable(authority, target)`。这里拆成 `exists` + `canManage` 两个纯问题，
// 因为**错误的组装规则是 memory 的**，不是 source-control 的：memory 的 Move 对
// 「当前 scope」与「目标 scope」用不同的失败语义（`current` 侧且持 bypass 时容忍目标行已消失，
// 走清理路径），把 `side: 'current' | 'destination'` 这套词汇塞进 source-control 会让
// SC 学会 memory 的 Move 语义。拆成两问后 SC 只回答自己知道的事实，memory 保留它自己的
// NotFound / Forbidden 组装——两边的既有错误码与文案因此逐字不变。
// ---------------------------------------------------------------------------

// RFC-352 T9 —— 唯一 owner 工厂与两个 provider 的事实读取器经 public 暴露。
// memory 是 `memory → source-control` 这条 DAG offered 边上的合法消费者，但**必须经 public**：
// T8 落地时它直接 import 了 `application/` 与 `infrastructure/`，那是跨 context 深入内部，
// RFC-317 R2 当场入账。这里补齐 public 出口，把那 4 条边变回正常的 offered 消费。
export { createRepositoryScopeAuthorizationInTx } from '../application/repositoryScopeAuthorization'
export type { RepositoryScopeExistenceReads } from '../application/repositoryScopeAuthorization'
export {
  postgresqlRepositoryScopeExistenceReads,
  sqliteRepositoryScopeExistenceReads,
} from '../infrastructure/repositoryScopeAuthorization'

/** 一个仓库 scope 或仓库组 scope 的目标。 */
export interface RepositoryScopeTarget {
  readonly kind: 'repo' | 'repo_group'
  readonly id: string
}

/** 授权判定所需的最小主体投影——不接受完整 `Actor`，也不接受权限名字集合。 */
export interface RepositoryScopeSubject {
  readonly hasResourceAclBypass: boolean
}

export type RepositoryScopeMaybePromise<T> = T | Promise<T>

declare const repositoryScopeAuthorizationInTxBrand: unique symbol

/**
 * source-control 提供给 memory 的 repository/group scope 授权面。
 * `Transaction` 由各 provider 绑定，调用方必须在**同一个**事务里问这两件事。
 *
 * 带私有 brand 且只有唯一 owner 工厂（`createRepositoryScopeAuthorizationInTx`）——
 * 结构等价的对象铸不出这个类型，也无法被序列化后重建（RFC-294 capability-forge 守卫）。
 */
export interface RepositoryScopeAuthorizationInTx<Transaction> {
  readonly [repositoryScopeAuthorizationInTxBrand]: 'repository-scope-authorization'
  /** 目标仓库 / 仓库组的行是否还在。 */
  exists(
    transaction: Transaction,
    target: RepositoryScopeTarget,
  ): RepositoryScopeMaybePromise<boolean>
  /** 该主体能否管理这个 scope。今天的判据：仅 `resource-acl:bypass`。 */
  canManage(
    transaction: Transaction,
    subject: RepositoryScopeSubject,
    target: RepositoryScopeTarget,
  ): RepositoryScopeMaybePromise<boolean>
}
