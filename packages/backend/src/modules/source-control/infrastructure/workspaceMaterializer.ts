// RFC-363: existing Git/FS materialization and compensation, owned by Source Control.
// Task admission/row writes remain at the caller; this mechanism receives no DB client.
import type {
  PlannedDirectoryNode,
  PlannedRepo,
  GitCommitIdentity,
  StartTask,
} from '@agent-workflow/shared'
import {
  assignBranchNames,
  directChildren,
  exclusionPlanFor,
  PLATFORM_WORKSPACE_DIR,
  mountDepth,
  orderForMaterialize,
} from '@agent-workflow/shared'
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { ulid } from 'ulid'
import type { SecretBox } from '@/auth/secretBox'
import { unsealRepoUrl } from '@/services/repoCredentials'
import { materializingSpaces } from '@/services/gc'
import { listAvailableRefs, resolveCachedRepo } from '@/services/gitRepoCache'
import {
  findTrackedPathUnderMounts,
  cleanupCreatedWorktree,
  createWorktree,
  initScratchRepo,
  type WorktreeCleanupProvenance,
  type WorktreeLifecycleHookEvent,
} from '@/util/git'
import { bindWorkspaceExcludeParticipant } from './workspaceExcludeBinding'
import { isFileSchemeUrl, redactGitUrl } from '@agent-workflow/shared'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'
import { resolveRepoGroupLayout } from '@/services/repoGroup'
import type { RepositoryWorkspaceStore } from '../ports/repositoryWorkspaceStore'
const log = createLogger('task')

/** Physical source/options only. Legacy StartTask callers remain structurally compatible. */
export interface WorkspaceMaterializationRequest {
  readonly scratch?: boolean
  readonly repoUrl?: string
  readonly cachedRepoId?: string
  readonly ref?: string
  readonly repoGroupId?: string
  readonly sourceTaskId?: string
  readonly workingBranch?: string
}

export interface WorkspaceMaterializationDependencies {
  readonly secretBox?: SecretBox
  readonly cloneTimeoutMs?: number
  readonly internalSource?: { kind: 'local-path'; repoPath: string; baseBranch: string }
  readonly preResolvedSource?: ResolvedRepoSource
  /** Durable preparation uses the whole frozen set, never a partial refetch. */
  readonly preResolvedSources?: readonly ResolvedRepoSource[]
  readonly frozenLayout?: PlannedSpaceLayout | null
  readonly worktreeMaterializer?: typeof materializeWorktree
  readonly worktreeLifecycleHook?: (event: WorktreeLifecycleHookEvent) => void | Promise<void>
  readonly resumeExistingScratch?: boolean
  readonly gitCommitIdentity?: GitCommitIdentity | null
  readonly sourceTerminationLaunchSignal?: AbortSignal
  readonly workspaceCleanupHook?: (event: WorkspaceCleanupHookEvent) => void | Promise<void>
  readonly appHome: string
  readonly repositoryWorkspace: RepositoryWorkspaceStore
  readonly loadFrozenSpaceLayout: (sourceTaskId: string) => Promise<PlannedSpaceLayout>
}

/**
 * Create a worktree for a fresh task. Pulled out of `startTask` so the
 * multipart upload route can call it BEFORE the task row exists and write
 * uploaded files into the resulting directory.
 *
 * Returns `earlyError !== null` on failure with the worktree fields blank
 * (mirrors the failure path `startTask` baked in before this refactor).
 */
export async function materializeWorktree(opts: {
  /** Resolved local repoPath (cache dir for URL mode, user-supplied for path mode). */
  repoPath: string
  baseBranch: string | undefined
  taskId: string
  appHome: string
  /**
   * RFC-066: when provided, the worktree lands at this absolute path
   * instead of the default `{appHome}/worktrees/{repoSlug}/{taskId}` layout.
   * The multi-repo branch supplies per-repo paths under
   * `{appHome}/worktrees/multi/{taskId}/<basename>/`; the single-repo
   * branch leaves this undefined to inherit the legacy layout byte-for-byte.
   */
  overrideWorktreePath?: string
  /**
   * RFC-075: optional working branch (task-level, applied to this repo). When
   * set, createWorktree checks out this branch instead of the default
   * isolation branch; validation failures (`working-branch-*`) propagate as
   * thrown ValidationErrors (422 launch failure) rather than `earlyError`.
   */
  workingBranch?: string
  /** RFC-075/067: identity for the framework's merge commit on branch reuse. */
  gitUserName?: string | null
  gitUserEmail?: string | null
  /** RFC-248 D17: sparse 只检出该仓内子目录（非 cone）。 */
  sparseSubdir?: string
  /** RFC-248 D14: 显式分支名（同一源仓在组里出现多次时带序号）。 */
  branchName?: string
  /** RFC-199 deterministic create/post-add race seam; tests only. */
  lifecycleHook?: (event: WorktreeLifecycleHookEvent) => void | Promise<void>
  /** RFC-303 protected Webhook launch owner. */
  signal?: AbortSignal
}): Promise<{
  worktreePath: string
  branch: string
  baseCommit: string | null
  earlyError: string | null
  cleanup: WorktreeCleanupProvenance | null
  // RFC-034: surface submodule init outcome so caller can emit warning event.
  submoduleInitOk: boolean
  submoduleInitError: string | null
  hasSubmodules: boolean
}> {
  try {
    const wt = await createWorktree({
      repoPath: opts.repoPath,
      taskId: opts.taskId,
      ...(opts.baseBranch !== undefined ? { baseBranch: opts.baseBranch } : {}),
      appHome: opts.appHome,
      ...(opts.overrideWorktreePath !== undefined
        ? { overrideWorktreePath: opts.overrideWorktreePath }
        : {}),
      ...(opts.workingBranch !== undefined ? { workingBranch: opts.workingBranch } : {}),
      ...(opts.sparseSubdir !== undefined ? { sparseSubdir: opts.sparseSubdir } : {}),
      ...(opts.branchName !== undefined ? { branchName: opts.branchName } : {}),
      ...(opts.gitUserName != null ? { gitUserName: opts.gitUserName } : {}),
      ...(opts.gitUserEmail != null ? { gitUserEmail: opts.gitUserEmail } : {}),
      ...(opts.lifecycleHook !== undefined ? { lifecycleHook: opts.lifecycleHook } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    })
    return {
      worktreePath: wt.worktreePath,
      branch: wt.branch,
      baseCommit: wt.baseCommit,
      earlyError: null,
      cleanup: wt.cleanup,
      submoduleInitOk: wt.submoduleInitOk,
      submoduleInitError: wt.submoduleInitError,
      hasSubmodules: wt.hasSubmodules,
    }
  } catch (err) {
    // RFC-075: a user-requested working branch that can't be honored (invalid
    // name, in use, base fetch failed, merge conflict) is a hard launch
    // failure surfaced as 422 — let the typed error propagate instead of
    // degrading into a `failed` task row.
    if (err instanceof ConflictError && err.code === 'webhook-mr-launch-terminal') {
      throw err
    }
    if (
      err instanceof DomainError &&
      (err.code.startsWith('working-branch-') ||
        err.code === 'worktree-post-add-cleanup-incomplete')
    ) {
      throw err
    }
    return {
      worktreePath: '',
      branch: '',
      baseCommit: null,
      earlyError: err instanceof Error ? err.message : String(err),
      cleanup: null,
      submoduleInitOk: true,
      submoduleInitError: null,
      hasSubmodules: false,
    }
  }
}

export interface ResolvedRepoSource {
  repoPath: string
  baseBranch: string | undefined
  /** First concrete commit persisted by the preparation operation; display keeps baseBranch. */
  resolvedCommit?: string
  /** RAW source URL — may carry credentials. Redact before logging/persisting. */
  repoUrl: string | null
  /** RFC-204: the cached mirror this resolved to (deterministic ref key). */
  cachedRepoId: string | null
  /** RFC-068: path-mode opt-in fetch error message. null when feature was off or succeeded. */
  pathFetchError: string | null
  /** RFC-068: URL-mode FF warnings. Empty when nothing relevant. */
  ffWarnings: Array<{ branch: string; warning: string }>
}

/**
 * RFC-066: collapse a `StartTask` body into the canonical per-repo spec list
 * the rest of `startTask` walks. Legacy single-repo bodies (top-level
 * `repoPath` / `repoUrl` / `baseBranch` / `ref` fields) are converted to a
 * length-1 array so the downstream code path is uniform; v2 bodies that
 * already supplied `repos: [...]` pass through verbatim. `fetchBeforeLaunch`
 * is left on `input` (a single top-level flag covers every repo in a
 * multi-repo task by design — see RFC-068 §"多仓" interaction notes).
 */
/**
 * RFC-165: INTERNAL per-repo source spec — deliberately WIDER than the wire
 * `StartTaskRepo` (URL-only): path specs survive here for the framework's
 * internal local-path face (`deps.internalSource`, fusion, the test helper).
 * Nothing on any route constructs a path variant.
 */
export type RepoSourceSpec =
  | { repoUrl: string; ref?: string }
  /** RFC-204: reuse an existing mirror; the daemon resolves the real URL itself. */
  | { cachedRepoId: string; ref?: string }
  | { repoPath: string; baseBranch: string }

export function normalizeStartTaskRepos(
  input: StartTask | WorkspaceMaterializationRequest,
): RepoSourceSpec[] {
  // RFC-204: an entry is `repoUrl` XOR `cachedRepoId` (refineRepoSourceFields),
  // but both are optional on the wire type — narrow to the discriminated
  // RepoSourceSpec here so nothing downstream has to re-guess.
  const withRef = <T extends object>(base: T, ref: string | undefined): T & { ref?: string } =>
    ref !== undefined ? { ...base, ref } : base
  // RFC-248: wire 上的 `repos[]` 已退役（顶层键进 RETIRED_START_TASK_KEYS 硬拒）。
  // 多仓一律由 `repoGroupId` 表达，展平后的成员规格在 materializeSpace 里直接从
  // 布局产出，不经过这里。这里只剩「单仓 / 框架内部路径规格」两种形态。
  if (typeof input.cachedRepoId === 'string' && input.cachedRepoId.length > 0) {
    return [withRef({ cachedRepoId: input.cachedRepoId }, input.ref)]
  }
  if (typeof input.repoUrl === 'string' && input.repoUrl.length > 0) {
    return [{ repoUrl: input.repoUrl, ...(input.ref !== undefined ? { ref: input.ref } : {}) }]
  }
  // Schema guarantees a source (scratch handled before this call); an empty
  // list only appears for hand-built inputs — materializeSpace guards it.
  return []
}

export async function resolveRepoSourceSingleWithProvider(
  spec: RepoSourceSpec,
  input: StartTask | WorkspaceMaterializationRequest,
  deps: WorkspaceMaterializationDependencies,
): Promise<ResolvedRepoSource> {
  if ('repoPath' in spec && spec.repoPath.length > 0) {
    // RFC-165: internal local-path face only (deps.internalSource / fusion /
    // test helper) — the public wire is URL-only, and the RFC-068 path-mode
    // opt-in fetch retired with it (URL mirrors always auto-fetch + FF).
    return {
      repoPath: spec.repoPath,
      baseBranch: spec.baseBranch,
      repoUrl: null,
      cachedRepoId: null,
      pathFetchError: null,
      ffWarnings: [],
    }
  }
  // RFC-204: a reuse-by-id source. The wire no longer carries the credentialed
  // URL, so the daemon looks it up itself and it never round-trips through the
  // client. 404 (not 422) and the same not-found shape as everything else so a
  // probe can't distinguish "not yours" from "doesn't exist".
  let sourceUrl: string
  let sourceCachedRepoId: string | null = null
  const specCachedRepoId = (spec as { cachedRepoId?: unknown }).cachedRepoId
  if (typeof specCachedRepoId === 'string' && specCachedRepoId.length > 0) {
    const row = await deps.repositoryWorkspace.findCachedRepoById(specCachedRepoId)
    if (row === null) {
      throw new NotFoundError(
        'cached-repo-not-found',
        `cached repo '${specCachedRepoId}' not found`,
      )
    }
    const plain = unsealRepoUrl(row, deps.secretBox, deps.repositoryWorkspace)
    if (plain === null) {
      throw new DomainError(
        'cached-repo-credential-unavailable',
        `cached repo '${specCachedRepoId}' has no readable URL (sealed with a different secret.key?)`,
        409,
      )
    }
    sourceUrl = plain
    sourceCachedRepoId = row.id
  } else {
    // Value-based, not `'repoUrl' in spec`: internal-face callers hand us specs
    // that carry the key with an undefined value, which the key test accepts and
    // then explodes on `.length`.
    const specUrl = (spec as { repoUrl?: unknown }).repoUrl
    if (typeof specUrl !== 'string' || specUrl.length === 0) {
      throw new ValidationError('start-task-source-required', 'a repoUrl source is required')
    }
    sourceUrl = specUrl
  }
  // RFC-287 G5（design §10.7「第二轮门 P1-1 定音」）—— `file://` 的**唯一**启动拒绝点。
  //
  // 为什么必须在这里、而不是 schema 层：公开面自 RFC-204 起就**不传 URL、传
  // `cachedRepoId`**，schema 拦 `file://` 对存量镜像一个都拦不住。这一处在两条分支
  // 汇流之后（id 反查解封出的 plain URL / 直填的 repoUrl 都已归一到 `sourceUrl`）、
  // `resolveCachedRepo` 之前，因此一处同时覆盖：URL 直填、cachedRepoId 反查、仓库组
  // 成员、多仓循环、`sourceTaskId` 重放、webhook 命中存量缓存。
  //
  // 存量**不 grandfather**：行照样在、列表照样显示，只是不能再启动（proposal §7 的
  // 「存量可见不可运行」）。注册面（批量导入 / 仓库组保存）**刻意不拒**——它们直达
  // 镜像层、绕过本函数，design §10.7 明确划为不动面。
  //
  // 内部 local-path 面不受影响：`'repoPath' in spec` 那条在函数开头就早返回了，
  // 根本走不到这里（RFC-165 F4/F19 的既定非公开面）。
  if (isFileSchemeUrl(sourceUrl)) {
    throw new ValidationError(
      'repo-url-file-scheme-unsupported',
      'file:// repositories cannot be launched (local paths are not a supported remote)',
      { url: redactGitUrl(sourceUrl) },
    )
  }
  const appHome = deps.appHome
  // `spec` here is the url-or-id shape; read `ref` defensively for the same
  // reason as above (internal callers may carry the key with no value).
  const specRefRaw = (spec as { ref?: unknown }).ref
  const specRef = typeof specRefRaw === 'string' && specRefRaw.length > 0 ? specRefRaw : undefined
  const syncCandidates = [specRef].filter((s): s is string => typeof s === 'string')
  const resolved = await resolveCachedRepo(
    {
      store: deps.repositoryWorkspace,
      appHome,
      syncBranches: syncCandidates,
      secretBox: deps.secretBox,
      ...(deps.cloneTimeoutMs !== undefined ? { cloneTimeoutMs: deps.cloneTimeoutMs } : {}),
      ...(deps.sourceTerminationLaunchSignal !== undefined
        ? { signal: deps.sourceTerminationLaunchSignal }
        : {}),
    },
    { url: sourceUrl },
  )
  if (!resolved.fetchOk) {
    throw new DomainError(
      'repo-fetch-failed',
      `repository fetch failed for ${resolved.cached.urlRedacted}; refusing to launch from a stale cache`,
      502,
      {
        url: resolved.cached.urlRedacted,
        stderr: resolved.fetchError,
      },
    )
  }
  const baseBranch = specRef ?? resolved.cached.defaultBranch ?? undefined
  let ffWarnings: Array<{ branch: string; warning: string }> = resolved.ffOutcomes
    .filter((o) => o.warning !== null)
    .map((o) => ({ branch: o.branch, warning: o.warning as string }))
  if (
    !resolved.cold &&
    syncCandidates.length === 0 &&
    typeof resolved.cached.defaultBranch === 'string' &&
    resolved.cached.defaultBranch.length > 0
  ) {
    const second = await resolveCachedRepo(
      {
        store: deps.repositoryWorkspace,
        appHome,
        syncBranches: [resolved.cached.defaultBranch],
        fetchOnReuse: false,
        secretBox: deps.secretBox,
        ...(deps.sourceTerminationLaunchSignal !== undefined
          ? { signal: deps.sourceTerminationLaunchSignal }
          : {}),
      },
      { url: sourceUrl },
    )
    ffWarnings = ffWarnings.concat(
      second.ffOutcomes
        .filter((o) => o.warning !== null)
        .map((o) => ({ branch: o.branch, warning: o.warning as string })),
    )
  }
  return {
    repoPath: resolved.cached.localPath,
    baseBranch,
    repoUrl: sourceUrl,
    cachedRepoId: sourceCachedRepoId ?? resolved.cached.id,
    pathFetchError: null,
    ffWarnings,
  }
}

export interface MaterializedRepo {
  repoIndex: number
  repoPath: string
  repoUrl: string | null
  cachedRepoId: string | null
  baseBranch: string
  branch: string
  baseCommit: string | null
  worktreePath: string
  worktreeDirName: string
  /** RFC-248: 相对任务根的挂载路径；'' = 挂根。取代 worktreeDirName 成为规范 key。 */
  mountPath: string
  /** RFC-248 D17: '' = 整仓；否则该成员是 sparse 检出。 */
  subdir: string
  /** RFC-248 D11: 只读成员不快照 / 不进 diff / 不推送。 */
  readonly: boolean
  /** RFC-308: installed per-worktree platform exclude profile receipt. */
  workspaceProfileVersion?: 1 | null
  workspaceProfileDigest?: string | null
  submoduleInitOk: boolean
  submoduleInitError: string | null
  hasSubmodules: boolean
}

/**
 * RFC-165 (F3): the single space-materialization entry — one tagged result
 * covering scratch / single-repo / multi-repo launches. Guarantees:
 *   * resolve exactly once (a route-pre-resolved single source is reused
 *     verbatim, never re-fetched — RFC-107 D1-B) and materialize exactly
 *     once: the multipart route's failure handoff used to re-run BOTH;
 *   * the failure arm carries the per-repo partial state and has already
 *     completed its own cleanup (scratch dir removed); the caller mints ONE
 *     failed task row from it and never re-materializes;
 *   * scratch launches hold an in-process lease (`materializingSpaces`,
 *     keyed by taskId, registered BEFORE mkdir) that startTask's finally
 *     releases after the row committed — the scratch orphan scan skips
 *     leased dirs (F9).
 * Throws (ValidationError) only for the pre-existing 422 surfaces
 * (`repo-ref-not-found`) where no task row must be minted.
 */
export interface MaterializedSpace {
  kind: 'scratch' | 'single' | 'multi' | 'group'
  /** RFC-165: persisted `tasks.space_kind` value, decided at materialize time.
   *  RFC-243: 'inherited' = a child execution's synthesized space pointing into
   *  its parent's call-node iso (never produced by materializeSpace itself). */
  spaceKind: 'local' | 'remote' | 'scratch' | 'internal' | 'inherited'
  taskId: string
  /** Multi: the container dir; single: the worktree; scratch: the repo dir; '' on failure. */
  worktreePath: string
  branch: string
  baseCommit: string | null
  earlyError: string | null
  resolvedSources: ResolvedRepoSource[]
  repos: MaterializedRepo[]
  /** RFC-249: frozen canonical directory paths; empty for non-group legacy handoffs. */
  nodePaths: string[]
  /** Explicit ownership lease consumed by startTask or the multipart route. */
  cleanup: MaterializedSpaceCleanup
}

export interface WorkspaceCleanupHookEvent {
  stage: 'worktree-remove' | 'branch-restore' | 'owned-root-remove'
  taskId: string
  path: string
  repoPath?: string
  branch?: string
}

export interface WorkspaceCleanupFailure extends WorkspaceCleanupHookEvent {
  message: string
}

export interface WorkspaceCleanupReport {
  taskId: string
  complete: boolean
  failures: WorkspaceCleanupFailure[]
}

export interface MaterializedSpaceCleanup {
  taskId: string
  /** Scratch/multi/fusion ephemeral root only; never a URL cache or user source. */
  ownedRoot: string | null
  /** Exact provenance emitted by createWorktree; never inferred after the fact. */
  worktrees: WorktreeCleanupProvenance[]
  state: 'owned' | 'committed' | 'cleaned'
  report: WorkspaceCleanupReport | null
}

export function createMaterializedSpaceCleanup(
  taskId: string,
  ownedRoot: string | null,
  worktrees: WorktreeCleanupProvenance[] = [],
): MaterializedSpaceCleanup {
  return {
    taskId,
    ownedRoot,
    worktrees,
    state: 'owned',
    report: null,
  }
}

/**
 * Consume a materialization ownership lease after a launch failed before its
 * task row committed. Every Git ref mutation is CAS-safe in util/git.ts. The
 * report is cached on the lease so route + service double-catch is idempotent,
 * and an incomplete cleanup is surfaced rather than being logged as zero
 * residue. Shared repo/cache paths never appear as `ownedRoot`.
 */
export async function cleanupMaterializedSpaceLease(
  ledger: MaterializedSpaceCleanup,
  hook?: (event: WorkspaceCleanupHookEvent) => void | Promise<void>,
): Promise<WorkspaceCleanupReport> {
  if (ledger.report !== null) return ledger.report
  if (ledger.state === 'committed') {
    return { taskId: ledger.taskId, complete: true, failures: [] }
  }

  const failures: WorkspaceCleanupFailure[] = []
  let worktreeCleanupFailed = false
  for (const entry of [...ledger.worktrees].reverse()) {
    const result = await cleanupCreatedWorktree(entry, {
      beforeStage: async (stage) => {
        await hook?.({
          stage,
          taskId: ledger.taskId,
          path: entry.worktreePath,
          repoPath: entry.repoPath,
          branch: entry.branch,
        })
      },
    })
    if (!result.worktreeRemoved) worktreeCleanupFailed = true
    for (const failure of result.failures) {
      failures.push({
        stage: failure.stage,
        taskId: ledger.taskId,
        path: entry.worktreePath,
        repoPath: entry.repoPath,
        branch: entry.branch,
        message: failure.message,
      })
    }
  }

  // A multi container contains only launch-owned sibling worktrees. Never
  // recursively erase it when unregistering one of those worktrees failed.
  if (ledger.ownedRoot !== null && !worktreeCleanupFailed) {
    try {
      await hook?.({
        stage: 'owned-root-remove',
        taskId: ledger.taskId,
        path: ledger.ownedRoot,
      })
      await rm(ledger.ownedRoot, { recursive: true, force: true })
    } catch (error) {
      // mkdir can fail because an ancestor is a file. In that case rm also
      // reports ENOTDIR even though the launch-owned root never existed; this
      // is genuinely zero residue, not an incomplete cleanup. Any surviving
      // root remains a hard, structured failure.
      if (existsSync(ledger.ownedRoot)) {
        failures.push({
          stage: 'owned-root-remove',
          taskId: ledger.taskId,
          path: ledger.ownedRoot,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  const report: WorkspaceCleanupReport = {
    taskId: ledger.taskId,
    complete: failures.length === 0,
    failures,
  }
  ledger.state = 'cleaned'
  ledger.report = report
  if (!report.complete) {
    log.error('rfc199/start-task-cleanup-incomplete', { ...report })
  }
  return report
}

/** Multipart route cleanup before startTask accepts the ownership handoff. */
export async function cleanupMaterializedSpace(
  space: MaterializedSpace,
  hook?: (event: WorkspaceCleanupHookEvent) => void | Promise<void>,
): Promise<WorkspaceCleanupReport> {
  try {
    return await cleanupMaterializedSpaceLease(space.cleanup, hook)
  } finally {
    materializingSpaces.delete(space.taskId)
  }
}

/** Consume a successfully persisted materialization lease. Idempotent and
 * intentionally non-throwing so a committed task can never be rolled back by
 * post-commit workspace bookkeeping. */
export function commitMaterializedSpace(space: MaterializedSpace): void {
  if (space.cleanup.state === 'owned') space.cleanup.state = 'committed'
  materializingSpaces.delete(space.taskId)
}

export function withWorkspaceCleanupReport(error: unknown, report: WorkspaceCleanupReport): Error {
  if (report.complete) return error instanceof Error ? error : new Error(String(error))
  if (error instanceof DomainError) {
    const details =
      typeof error.details === 'object' && error.details !== null && !Array.isArray(error.details)
        ? { ...error.details, workspaceCleanup: report }
        : { causeDetails: error.details, workspaceCleanup: report }
    return new DomainError(error.code, error.message, error.status, details)
  }
  return new DomainError(
    'task-launch-cleanup-incomplete',
    error instanceof Error ? error.message : String(error),
    500,
    { workspaceCleanup: report },
  )
}

/**
 * RFC-248 H9 —— 从一个既有任务的**冻结** `task_repos` 快照重建布局（重启）。
 *
 * 与 `resolveRepoGroupLayout` 返回同构的 `PlannedRepo[]`，因此下游物化管线
 * 一行不用改。三条关键语义：
 *
 *  - **不读组定义**：源任务当初属于哪个组、那个组现在长什么样，都与这里无关。
 *    组可能被改布局、被加减成员、被删除；重启要的是「再跑一次刚才那个」。
 *  - **必须能按镜像 id 重放**：快照里没有 `cached_repo_id` 的行（RFC-204 之前
 *    的存量、或纯框架内部路径任务）无法安全重放——URL 是脱敏存的，拿它去 clone
 *    会带着 `***` 认证失败。这种情况直接 422，让调用方改用别的来源，而不是
 *    悄悄少物化一个仓。
 *  - **顺序按 repo_index**：与当初物化时一致，分支后缀（D14 同源多份）才对得上。
 */
export interface PlannedSpaceLayout {
  readonly repos: PlannedRepo[]
  readonly nodes: PlannedDirectoryNode[]
}

/**
 * Materialize explicit directories without following a symlink out of the
 * launch-owned group root. Missing segments are created one at a time so each
 * existing or newly-created component can be checked before descending.
 */
function ensureExplicitDirectoryNodes(groupRoot: string, nodePaths: readonly string[]): void {
  const rootStat = lstatSync(groupRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new ValidationError(
      'repo-group-directory-occupied',
      `repo group root '${groupRoot}' is not a real directory`,
      { nodePath: '', occupiedPath: groupRoot },
    )
  }
  const realRoot = realpathSync(groupRoot)

  for (const nodePath of [...nodePaths].sort(
    (a, b) => mountDepth(a) - mountDepth(b) || a.localeCompare(b),
  )) {
    let current = groupRoot
    for (const segment of nodePath.split('/').filter(Boolean)) {
      current = join(current, segment)
      if (existsSync(current)) {
        const stat = lstatSync(current)
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new ValidationError(
            'repo-group-directory-occupied',
            `directory node '${nodePath}' is occupied by a symlink or non-directory at '${current}'`,
            { nodePath, occupiedPath: current },
          )
        }
      } else {
        mkdirSync(current)
      }

      const actual = realpathSync(current)
      const fromRoot = relative(realRoot, actual)
      if (
        fromRoot === '..' ||
        fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
        isAbsolute(fromRoot)
      ) {
        throw new ValidationError(
          'repo-group-directory-occupied',
          `directory node '${nodePath}' resolves outside the repo group root`,
          { nodePath, occupiedPath: current },
        )
      }
    }
  }
}

/**
 * RFC-248 PR-3 —— 按仓库组的展平布局物化整个工作空间。
 *
 * 顺序约束是**硬的**（design §4.2）：
 *  1. 挂载深度升序建 worktree——内层要落进外层的工作树里，外层必须先在。
 *  2. 建完某一层之后、建下一层之前，给该层仓安装 per-worktree platform
 *     exclude profile。它必须先于内层 worktree，且绝不修改业务 `.gitignore`。
 *
 * 回收按挂载深度**倒序**（design §4.3）。实测（proposal E9）正序也不会坏账
 * ——git 会把内层注册标 `prunable` 并在后续 remove 时自愈——但倒序不依赖那条
 * 自愈行为，且让「删除失败」仍可归因到具体某个仓。
 */
async function materializeGroupSpace(opts: {
  planned: readonly PlannedRepo[]
  nodePaths: readonly string[]
  resolvedSources: ResolvedRepoSource[]
  taskId: string
  appHome: string
  workingBranch?: string | undefined
  gitUserName: string | null
  gitUserEmail: string | null
  signal?: AbortSignal
  lifecycleHook?: (event: WorktreeLifecycleHookEvent) => void | Promise<void>
  worktreeMaterializer?: typeof materializeWorktree
}): Promise<MaterializedSpace> {
  const { planned, nodePaths, resolvedSources, taskId, appHome } = opts
  // `resolvedSources` 与 `planned` **同序**（它是按 repoSpecs 逐个 resolve 出来
  // 的），但物化要按挂载深度重排。先把两者**配对**再排序——只排 planned、然后
  // 用重排后的下标去索引 resolvedSources 会张冠李戴：sparse 成员会拿到别的仓的
  // 源，症状是「子目录明明存在却报 sparse-empty」。
  const paired = planned.map((p, i) => ({ p, src: resolvedSources[i]! }))
  const ordered = orderForMaterialize(paired.map((x) => x.p))
  const orderedPairs = orderForMaterialize(
    paired.map((x, i) => ({ ...x, mountPath: x.p.mountPath, _i: i })),
  )
  const allMounts = ordered.map((p) => p.mountPath)
  const branchNames = assignBranchNames(ordered, taskId, opts.workingBranch)
  const rootMounted = allMounts.includes('')
  const groupRoot = join(appHome, 'worktrees', 'group', taskId)
  // RFC-308: every repo gets a profile, including leaves, because the canonical
  // `.agent-workflow/` root is always platform-reserved.

  const cleanup = createMaterializedSpaceCleanup(taskId, groupRoot)
  try {
    // 有仓挂根时根目录由它的 `worktree add` 自己创建——预先 mkdir 会让
    // `worktree add` 撞上「已存在」（proposal E7 显示空目录其实可以，但让 git
    // 自己建更贴近单仓 baseline）。
    if (!rootMounted) mkdirSync(groupRoot, { recursive: true })

    // ── 设计门二轮 H8：占用校验看 git tree，不是工作树 ──────────────────
    // sparse 只控制工作树、不删索引里的已跟踪路径，所以「工作树里没有那个目录」
    // 不代表该路径没被容器跟踪。先把冲突挡在建任何 worktree 之前。
    for (let i = 0; i < orderedPairs.length; i++) {
      const p = orderedPairs[i]!.p
      const kids = directChildren(p.mountPath, allMounts)
      const rels = [
        PLATFORM_WORKSPACE_DIR,
        ...kids.map((c) => (p.mountPath === '' ? c : c.slice(p.mountPath.length + 1))),
      ]
      const src = orderedPairs[i]!.src
      const ref = src.resolvedCommit ?? src.baseBranch ?? 'HEAD'
      const hit = await findTrackedPathUnderMounts(src.repoPath, ref, rels)
      if (hit !== null) {
        if (hit.mountRel === PLATFORM_WORKSPACE_DIR) {
          throw new ValidationError(
            'platform-workspace-root-occupied',
            `reserved platform workspace '${PLATFORM_WORKSPACE_DIR}' is already tracked at ref '${ref}' (${hit.trackedPath})`,
            { mountPath: p.mountPath, trackedPath: hit.trackedPath, ref },
          )
        }
        throw new ValidationError(
          'repo-group-mount-occupied',
          `mount path '${p.mountPath === '' ? hit.mountRel : `${p.mountPath}/${hit.mountRel}`}' is already tracked by the enclosing repo at ref '${ref}' (${hit.trackedPath})`,
          {
            mountPath: p.mountPath === '' ? hit.mountRel : `${p.mountPath}/${hit.mountRel}`,
            containerMountPath: p.mountPath,
            trackedPath: hit.trackedPath,
            ref,
          },
        )
      }
    }

    const repos: MaterializedRepo[] = []
    const byMount = new Map<string, MaterializedRepo>()
    let depth = -1
    for (let i = 0; i < orderedPairs.length; i++) {
      const p = orderedPairs[i]!.p
      const src = orderedPairs[i]!.src
      const d = mountDepth(p.mountPath)
      if (d !== depth) {
        // 进入新的一层：先给上一层 worktree 安装 platform profile。
        if (depth >= 0) await installExcludeProfilesForDepth(depth)
        depth = d
      }
      const abs = p.mountPath === '' ? groupRoot : join(groupRoot, p.mountPath)
      if (p.mountPath !== '') mkdirSync(join(abs, '..'), { recursive: true })
      const wt = await (opts.worktreeMaterializer ?? materializeWorktree)({
        repoPath: src.repoPath,
        baseBranch: src.resolvedCommit ?? src.baseBranch,
        taskId,
        appHome,
        overrideWorktreePath: abs,
        branchName: branchNames[i]!,
        ...(p.subdir !== '' ? { sparseSubdir: p.subdir } : {}),
        ...(opts.workingBranch !== undefined ? { workingBranch: opts.workingBranch } : {}),
        gitUserName: opts.gitUserName,
        gitUserEmail: opts.gitUserEmail,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(opts.lifecycleHook === undefined ? {} : { lifecycleHook: opts.lifecycleHook }),
      })
      if (wt.cleanup !== null) cleanup.worktrees.push(wt.cleanup)
      if (wt.earlyError !== null) {
        if (
          src.repoUrl !== null &&
          /worktree-base-invalid|cannot resolve base ref/i.test(wt.earlyError)
        ) {
          const available = await listAvailableRefs(src.repoPath, 10)
          throw new ValidationError(
            'repo-group-ref-not-found',
            `ref '${p.ref !== '' ? p.ref : '(default)'}' not found in ${redactGitUrl(src.repoUrl)}`,
            {
              url: redactGitUrl(src.repoUrl),
              ref: p.ref !== '' ? p.ref : null,
              availableRefs: available,
              mountPath: p.mountPath,
            },
          )
        }
        throw new ValidationError(
          'repo-group-materialize-failed',
          `mounting '${p.mountPath === '' ? '<root>' : p.mountPath}' failed: ${wt.earlyError}`,
          { mountPath: p.mountPath },
        )
      }
      // D17: sparse 成员检出后为空 ⇒ 用户指定的子目录在该 ref 上不存在。
      // 静默给一个空目录比报错糟糕得多——agent 会以为那个仓真的没内容。
      if (p.subdir !== '' && readdirSync(abs).filter((n) => n !== '.git').length === 0) {
        throw new ValidationError(
          'repo-group-sparse-empty',
          `subdir '${p.subdir}' does not exist at ref '${src.baseBranch ?? 'HEAD'}' for mount '${p.mountPath === '' ? '<root>' : p.mountPath}'`,
          { mountPath: p.mountPath, subdir: p.subdir },
        )
      }
      if (!wt.submoduleInitOk) {
        log.warn('[rfc034/submodule-init-failed] worktree submodule init failed', {
          taskId,
          worktreePath: wt.worktreePath,
          mountPath: p.mountPath,
          stderr: wt.submoduleInitError ?? '',
        })
      }
      const rec: MaterializedRepo = {
        repoIndex: i,
        repoPath: src.repoPath,
        repoUrl: src.repoUrl,
        cachedRepoId: src.cachedRepoId,
        baseBranch: src.baseBranch ?? '',
        branch: wt.branch,
        baseCommit: wt.baseCommit,
        worktreePath: wt.worktreePath,
        worktreeDirName: p.mountPath,
        mountPath: p.mountPath,
        subdir: p.subdir,
        readonly: p.readonly,
        workspaceProfileVersion: null,
        workspaceProfileDigest: null,
        submoduleInitOk: wt.submoduleInitOk,
        submoduleInitError: wt.submoduleInitError,
        hasSubmodules: wt.hasSubmodules,
      }
      repos.push(rec)
      byMount.set(p.mountPath, rec)
    }
    // Install the final depth's per-worktree profile too.
    if (depth >= 0) await installExcludeProfilesForDepth(depth)

    async function installExcludeProfilesForDepth(d: number): Promise<void> {
      for (const rec of repos) {
        if (mountDepth(rec.mountPath) !== d) continue
        const receipt = await bindWorkspaceExcludeParticipant({
          worktreePath: rec.worktreePath,
          appHome,
        }).ensure({ directChildMounts: exclusionPlanFor(rec.mountPath, allMounts) })
        rec.workspaceProfileVersion = receipt.version
        rec.workspaceProfileDigest = receipt.digest
      }
    }

    ensureExplicitDirectoryNodes(groupRoot, nodePaths)

    const head0 = repos[0]
    return {
      kind: 'group',
      spaceKind: resolvedSources.some((s) => s.repoUrl === null) ? 'local' : 'remote',
      taskId,
      // 有仓挂根时 cwd 就是那个仓的 worktree；否则是不属于任何仓的父目录。
      worktreePath: groupRoot,
      branch: head0?.branch ?? '',
      baseCommit: head0?.baseCommit ?? null,
      earlyError: null,
      resolvedSources,
      repos,
      nodePaths: [...nodePaths],
      cleanup,
    }
  } catch (error) {
    // lease 按创建顺序记录；统一 cleanup consumer 会自行倒序回收。
    // 这里不能再 reverse 一次，否则外层 worktree 会先被删除，内层
    // 注册随之变成 prunable，第二次 remove 就会误报清理不完整。
    const report = await cleanupMaterializedSpaceLease(cleanup)
    throw withWorkspaceCleanupReport(error, report)
  }
}

export async function materializeSpaceWithProvider(
  input: StartTask | WorkspaceMaterializationRequest,
  deps: WorkspaceMaterializationDependencies,
  /**
   * RFC-287 G7 第一刀：让调用方能**先定 id、后物化**。
   *
   * G7 要把仓库准备挪到任务行落库之后（启动接口不再同步阻塞到工作树就绪，失败
   * 也能留下记录）。那就要求任务行先落——而落行需要 id，id 却一直是在这里、在
   * 物化过程中才铸出来的。把它提成可选入参：不传 = 逐字维持旧行为（本函数自己
   * 铸），传了 = 用调用方给的那个。本刀**零行为变更**，只是把「谁铸 id」这个
   * 决定权交出去，为下一刀（占位落行 + runTask 第 0 步物化）让路。
   */
  presetTaskId?: string,
): Promise<MaterializedSpace> {
  const appHome = deps.appHome
  const taskId = presetTaskId ?? ulid()

  // RFC-165 (F4): the internal local-path face is mutually exclusive with
  // every public space field — a programming error, not user input, so the
  // assertion is loud and unconditional.
  if (deps.internalSource !== undefined) {
    const hasPublicSource =
      input.scratch === true ||
      (typeof input.repoUrl === 'string' && input.repoUrl.length > 0) ||
      (typeof input.repoGroupId === 'string' && input.repoGroupId.length > 0)
    if (hasPublicSource) {
      throw new ValidationError(
        'internal-source-conflict',
        'internalSource is mutually exclusive with scratch/repoUrl/repoGroupId',
      )
    }
  }

  // ---- scratch: the workspace IS a brand-new git repo (RFC-165 §3). ----
  if (input.scratch === true) {
    const scratchDir = join(appHome, 'scratch', taskId)
    const cleanup = createMaterializedSpaceCleanup(taskId, scratchDir)
    materializingSpaces.set(taskId, { dir: scratchDir, startedAt: Date.now() })
    const init = await initScratchRepo({
      dir: scratchDir,
      ...(deps.resumeExistingScratch === undefined
        ? {}
        : { resumeExisting: deps.resumeExistingScratch }),
      gitUserName: deps.gitCommitIdentity?.name ?? null,
      gitUserEmail: deps.gitCommitIdentity?.email ?? null,
      ...(deps.sourceTerminationLaunchSignal !== undefined
        ? { signal: deps.sourceTerminationLaunchSignal }
        : {}),
    })
    if (init.ok) {
      const profile = await bindWorkspaceExcludeParticipant({
        worktreePath: scratchDir,
        appHome,
      }).ensure()
      return {
        kind: 'scratch',
        spaceKind: 'scratch',
        taskId,
        worktreePath: scratchDir,
        branch: 'main',
        baseCommit: init.rootCommit,
        earlyError: null,
        resolvedSources: [],
        nodePaths: [],
        cleanup,
        repos: [
          {
            repoIndex: 0,
            repoPath: scratchDir,
            repoUrl: null,
            cachedRepoId: null,
            baseBranch: 'main',
            branch: 'main',
            baseCommit: init.rootCommit,
            worktreePath: scratchDir,
            worktreeDirName: '',
            mountPath: '',
            subdir: '',
            readonly: false,
            workspaceProfileVersion: profile.version,
            workspaceProfileDigest: profile.digest,
            submoduleInitOk: true,
            submoduleInitError: null,
            hasSubmodules: false,
          },
        ],
      }
    }
    // Cleanup ownership = the materializing layer (design F9). A failed rm is
    // not equivalent to a pruned workspace: surface the structured residue
    // and release the process-local lease so the orphan scanner can recover
    // the predictable scratch/{taskId} path on a later pass.
    const report = await cleanupMaterializedSpaceLease(cleanup, deps.workspaceCleanupHook)
    materializingSpaces.delete(taskId)
    if (!report.complete) {
      throw new DomainError(
        'scratch-materialize-cleanup-incomplete',
        `scratch workspace initialization failed and cleanup was incomplete: ${init.error}`,
        500,
        {
          taskId,
          path: scratchDir,
          materializeError: init.error,
          workspaceCleanup: report,
        },
      )
    }
    return {
      kind: 'scratch',
      spaceKind: 'scratch',
      taskId,
      worktreePath: '',
      branch: '',
      baseCommit: null,
      earlyError: init.error,
      resolvedSources: [],
      repos: [],
      nodePaths: [],
      cleanup,
    }
  }

  // RFC-248: 用仓库组启动时，成员规格由**展平后的布局**给出，而不是 wire 上的
  // `repos[]`。展平在 services/repoGroup.ts 里做（校验错误已在那里转成 422）。
  // RFC-248（实现门 P1）：展平出 0 个仓的组**不能启动**。它可能来自 force 删掉
  // 最后一个仓、或者一个空的子组。放行的后果不是报错而是更糟：服务端建出一个
  // 没有任何 `task_repos` 的组根目录、`repoCount` 记成 1，然后任务在一个**不是
  // git 仓库**的目录里跑——agent 的每一条 git 命令都会失败，而失败原因与真正的
  // 起因（组是空的）隔了十万八千里。
  const assertNonEmptyLayout = (layout: PlannedSpaceLayout, source: string): PlannedSpaceLayout => {
    if (layout.repos.length === 0) {
      throw new ValidationError(
        'repo-group-empty',
        `${source} flattens to zero repos; a task needs at least one repo to run in`,
      )
    }
    return layout
  }

  const groupLayout: PlannedSpaceLayout | null = await (async () => {
    if (deps.frozenLayout !== undefined)
      return deps.frozenLayout === null
        ? null
        : assertNonEmptyLayout(deps.frozenLayout, 'frozen preparation')
    if (typeof input.repoGroupId === 'string' && input.repoGroupId.length > 0) {
      const layout = await resolveRepoGroupLayout(deps.repositoryWorkspace, input.repoGroupId)
      return assertNonEmptyLayout(
        { repos: layout.repos, nodes: layout.nodes },
        `repo group ${input.repoGroupId}`,
      )
    }
    if (typeof input.sourceTaskId === 'string' && input.sourceTaskId.length > 0) {
      // RFC-249: replay BOTH frozen repos and explicit directories. Never read
      // the current repo-group definition, which may have changed or vanished.
      return assertNonEmptyLayout(
        await deps.loadFrozenSpaceLayout(input.sourceTaskId),
        `source task ${input.sourceTaskId}`,
      )
    }
    return null
  })()
  const groupPlanned = groupLayout?.repos ?? null

  const repoSpecs =
    deps.internalSource !== undefined
      ? [{ repoPath: deps.internalSource.repoPath, baseBranch: deps.internalSource.baseBranch }]
      : groupPlanned !== null
        ? // 组成员一律按 cachedRepoId 复用已导入的镜像；`ref` 为空 ⇒ 该仓默认分支。
          groupPlanned.map((p) => ({
            cachedRepoId: p.cachedRepoId,
            ...(p.ref !== '' ? { ref: p.ref } : {}),
          }))
        : normalizeStartTaskRepos(input)

  // RFC-066: per-repo source resolution. Each spec independently runs
  // path-mode opt-in fetch (RFC-068) or URL-mode FF; warnings collected per
  // repo and surfaced after materialization.
  if (deps.preResolvedSources !== undefined && deps.preResolvedSources.length !== repoSpecs.length)
    throw new Error('repository-preparation-source-count-mismatch')
  const resolvedSources: ResolvedRepoSource[] = []
  for (const [i, spec] of repoSpecs.entries()) {
    // RFC-107: reuse the route's pre-resolved source for the single repo so a
    // URL is cloned/resolved exactly once across the route → startTask handoff.
    const r =
      deps.preResolvedSources !== undefined
        ? deps.preResolvedSources[i]!
        : deps.preResolvedSource !== undefined && repoSpecs.length === 1 && i === 0
          ? deps.preResolvedSource
          : await resolveRepoSourceSingleWithProvider(spec, input, deps)
    if (r.pathFetchError !== null) {
      log.warn('rfc068/path-fetch-failed', {
        repoPath: r.repoPath,
        error: r.pathFetchError,
      })
    }
    if (r.ffWarnings.length > 0) {
      log.warn('rfc068/ff-warnings', {
        // RFC-204: r.repoUrl is the RAW source URL (spec.repoUrl / the resolved
        // mirror URL), not the redacted column — logging it verbatim leaked
        // userinfo/query credentials into the daemon log.
        repoUrl: r.repoUrl !== null ? redactGitUrl(r.repoUrl) : null,
        warnings: r.ffWarnings,
      })
    }
    resolvedSources.push(r)
  }

  // RFC-248: 仓库组路径。展平后**恰好一个成员且挂根**时落回单仓分支——
  // 那是「单仓是多仓的特例」这条产品判断的实现兑现（AC-10 要求路径 / `tasks.*`
  // 列 / cwd 与今天字节级一致），所以这里只在 >1 或非根挂载时才走组物化。
  if (groupPlanned !== null && groupLayout !== null) {
    const onlyRootRepo =
      groupPlanned.length === 1 &&
      groupPlanned[0]!.mountPath === '' &&
      groupPlanned[0]!.subdir === '' &&
      groupLayout.nodes.length === 1 &&
      groupLayout.nodes[0]!.path === ''
    if (!onlyRootRepo) {
      return await materializeGroupSpace({
        ...(deps.worktreeMaterializer === undefined
          ? {}
          : { worktreeMaterializer: deps.worktreeMaterializer }),
        planned: groupPlanned,
        nodePaths: groupLayout.nodes.map((node) => node.path),
        resolvedSources,
        taskId,
        appHome,
        ...(input.workingBranch !== undefined ? { workingBranch: input.workingBranch } : {}),
        ...(deps.worktreeLifecycleHook === undefined
          ? {}
          : { lifecycleHook: deps.worktreeLifecycleHook }),
        gitUserName: deps.gitCommitIdentity?.name ?? null,
        gitUserEmail: deps.gitCommitIdentity?.email ?? null,
        ...(deps.sourceTerminationLaunchSignal !== undefined
          ? { signal: deps.sourceTerminationLaunchSignal }
          : {}),
      })
    }
  }

  // RFC-066: single-path byte-baseline branch — pre-RFC-066 behavior
  // preserved bit-for-bit (RFC-165 moved it verbatim into materializeSpace).
  // The G1/G3 source guards in tests/source-text-rfc066-guards.test.ts pin
  // this comment so a future refactor cannot silently delete the branch.
  if (repoSpecs.length === 1) {
    const source = resolvedSources[0]!
    const selectedRef = source.resolvedCommit ?? source.baseBranch ?? 'HEAD'
    const occupied = await findTrackedPathUnderMounts(source.repoPath, selectedRef, [
      PLATFORM_WORKSPACE_DIR,
    ])
    if (occupied !== null) {
      throw new ValidationError(
        'platform-workspace-root-occupied',
        `reserved platform workspace '${PLATFORM_WORKSPACE_DIR}' is already tracked at ref '${selectedRef}' (${occupied.trackedPath})`,
        { mountPath: '', trackedPath: occupied.trackedPath, ref: selectedRef },
      )
    }
    const wt = await (deps.worktreeMaterializer ?? materializeWorktree)({
      repoPath: source.repoPath,
      baseBranch: source.resolvedCommit ?? source.baseBranch,
      taskId,
      appHome,
      ...(deps.worktreeLifecycleHook === undefined
        ? {}
        : { lifecycleHook: deps.worktreeLifecycleHook }),
      // RFC-075: working branch (task-level) + identity for the merge commit.
      ...(input.workingBranch !== undefined ? { workingBranch: input.workingBranch } : {}),
      gitUserName: deps.gitCommitIdentity?.name ?? null,
      gitUserEmail: deps.gitCommitIdentity?.email ?? null,
      ...(deps.sourceTerminationLaunchSignal !== undefined
        ? { signal: deps.sourceTerminationLaunchSignal }
        : {}),
    })

    if (wt.earlyError === null && !wt.submoduleInitOk) {
      log.warn('[rfc034/submodule-init-failed] worktree submodule init failed', {
        taskId,
        worktreePath: wt.worktreePath,
        stderr: wt.submoduleInitError ?? '',
      })
    }
    let workspaceProfileVersion: 1 | null = null
    let workspaceProfileDigest: string | null = null
    if (wt.earlyError === null) {
      const profile = await bindWorkspaceExcludeParticipant({
        worktreePath: wt.worktreePath,
        appHome,
      }).ensure()
      workspaceProfileVersion = profile.version
      workspaceProfileDigest = profile.digest
    }

    if (
      wt.earlyError !== null &&
      source.repoUrl !== null &&
      /worktree-base-invalid|cannot resolve base ref/i.test(wt.earlyError)
    ) {
      const available = await listAvailableRefs(source.repoPath, 10)
      throw new ValidationError(
        'repo-ref-not-found',
        `ref '${input.ref ?? source.baseBranch ?? '(default)'}' not found in ${redactGitUrl(source.repoUrl)}`,
        { url: redactGitUrl(source.repoUrl), ref: input.ref ?? null, availableRefs: available },
      )
    }
    const cleanup = createMaterializedSpaceCleanup(
      taskId,
      null,
      wt.cleanup === null ? [] : [wt.cleanup],
    )
    return {
      kind: 'single',
      spaceKind:
        deps.internalSource !== undefined
          ? 'internal'
          : source.repoUrl !== null
            ? 'remote'
            : 'local',
      taskId,
      worktreePath: wt.worktreePath,
      branch: wt.branch,
      baseCommit: wt.baseCommit,
      earlyError: wt.earlyError,
      resolvedSources,
      nodePaths: groupLayout?.nodes.map((node) => node.path) ?? [],
      cleanup,
      repos: [
        {
          repoIndex: 0,
          repoPath: source.repoPath,
          repoUrl: source.repoUrl,
          cachedRepoId: source.cachedRepoId,
          baseBranch: source.baseBranch ?? '',
          branch: wt.branch !== '' ? wt.branch : `agent-workflow/${taskId}`,
          baseCommit: wt.baseCommit,
          worktreePath: wt.worktreePath,
          worktreeDirName: '',
          mountPath: '',
          subdir: '',
          readonly: false,
          workspaceProfileVersion,
          workspaceProfileDigest,
          submoduleInitOk: wt.submoduleInitOk,
          submoduleInitError: wt.submoduleInitError,
          hasSubmodules: wt.hasSubmodules,
        },
      ],
    }
  }

  // RFC-248 T26: RFC-066 的多仓 materialize 分支（`worktrees/multi/{taskId}` +
  // basename 平铺 + `resolveMultiRepoDirName` 的 `-2`/`-3` 后缀）**已删除**。
  // wire 上的 `repos[]` 退役后（顶层键进 RETIRED_START_TASK_KEYS 硬拒），
  // `repoSpecs.length > 1` 已不可达——多仓一律经 `repoGroupId` 走上面的
  // `materializeGroupSpace`，它支持挂根、任意嵌套、sparse、只读与同仓多份，
  // 是旧分支的严格超集。
  //
  // 存量任务的 `tasks.worktree_path` 是绝对路径存量值，继续指向老 `multi/`
  // 目录即可；GC 按 `worktree_path` 删，天然覆盖，无需目录迁移。
  throw new ValidationError(
    'start-task-source-required',
    'multi-repo launches must use repoGroupId (RFC-248); the legacy repos[] path is retired',
  )
}
