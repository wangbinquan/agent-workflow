// RFC-083 — structural diff service. Mirrors getTaskDiff's task →
// (worktree, baseCommit) resolution + error codes (no-base-commit 409,
// worktree-missing 410) so the structural view degrades exactly like the
// textual diff. Single-repo computes directly; multi-repo merges per-repo
// results (status 'partial' when some repos are unusable).
//
// Scopes: 'task' (base_commit → worktree), 'node' (a write node's pre_snapshot
// → the next write node's pre_snapshot / worktree, single-repo)、以及
// 'wrapper'（`getWrapperStructuralDiff`，需要 `nodeRunId` query 参数）。
// RFC-317 T66 订正：原注释写着「'wrapper' is not yet wired and returns a typed
// 'structural-scope-unsupported'」——该分支早已接上（见下方 scope === 'wrapper'），
// 而 RFC-083 已 Done。这条尤其误导：它写在**文件头的 scope 说明**里，
// 是任何人想知道「支持哪几种 scope」时第一眼看的地方。
//
// RFC-370 §10 V16 — every read runs through the selected revision content and
// every persisted artifact through the selected artifact store, so a hosted
// task (a `cs-workspace:` volume) is analyzed in its volume. A terminal
// generation is served from the store first: no worktree read, no volume wake.

import { DomainError, NotFoundError, ValidationError } from '@/util/errors'
import {
  isSingleRootRepository,
  computeSummary,
  type StructuralDiff,
  type StructuralScope,
} from '@agent-workflow/shared'
import type {
  TaskCodeWorkspaceQueries,
  CodeWorkspaceTask,
} from '@/modules/task-execution/public/types'
import {
  composeLocalCodeReviewArtifacts,
  type CodeReviewArtifactStore,
  type StructuralDiffArtifactKey,
} from '@/modules/code-capability/public/participants'
import {
  composeLocalRepositoryRevisionContent,
  type RepositoryRevisionContent,
  type RepositoryRevisionContentFactory,
} from '@/modules/source-control/public/participants'
import { canonicalRepoKeys } from '@/services/repoLabels'
import { readWrapperGitBaseline } from '@/modules/task-execution/public/queries'
import { computeFromWorktree, computeBetweenRefs } from './gitBackend'
import { computeContentDigest } from './digest'
import { mergeStructuralDiffs } from './assemble'
import { resolveNodeScope, perRepoNodeRuns } from './refSelect'
import { isTerminalTaskStatus } from './store'
import {
  computeDeepStructuralDiff,
  DEEP_INDEXING_UNAVAILABLE,
  DeepUnavailableError,
  type ResolvedDeepConfig,
} from './deep/service'

/** Deep-mode request: try the external SCIP indexer, fall back to baseline. */
export interface DeepOpts {
  mode: 'baseline' | 'deep'
  deepCfg?: ResolvedDeepConfig
}

/** RFC-370 §10 V16 — what the code-review reads run against. */
export interface CodeReviewReads {
  readonly workspace: TaskCodeWorkspaceQueries
  /** The selected revision content; the native worktrees of this host when absent. */
  readonly content?: RepositoryRevisionContentFactory
  /** The selected artifact store; the appHome files when absent. */
  readonly artifacts?: CodeReviewArtifactStore
}

/** The bare workspace port keeps the standalone selections (direct callers, tests). */
export type CodeReviewReadInput = TaskCodeWorkspaceQueries | CodeReviewReads

export interface ResolvedCodeReviewReads {
  readonly workspace: TaskCodeWorkspaceQueries
  readonly content: RepositoryRevisionContentFactory
  readonly artifacts: CodeReviewArtifactStore
}

export function codeReviewReads(input: CodeReviewReadInput): ResolvedCodeReviewReads {
  if (!('workspace' in input)) {
    return {
      workspace: input,
      content: composeLocalRepositoryRevisionContent(),
      artifacts: composeLocalCodeReviewArtifacts(),
    }
  }
  return {
    workspace: input.workspace,
    content: input.content ?? composeLocalRepositoryRevisionContent(),
    artifacts: input.artifacts ?? composeLocalCodeReviewArtifacts(),
  }
}

/** The terminal generation of a task (its `finishedAt`); null while it runs. */
export function terminalGeneration(task: CodeWorkspaceTask): string | null {
  if (!isTerminalTaskStatus(task.status)) return null
  return task.finishedAt === undefined || task.finishedAt === null ? null : String(task.finishedAt)
}

/** The stored artifact of the task's generation, else whatever the store still
 *  holds for the scope (a store keyed by generation has nothing more). */
export async function readStoredTaskDiff(
  artifacts: CodeReviewArtifactStore,
  key: StructuralDiffArtifactKey,
): Promise<StructuralDiff | null> {
  if (key.generation !== null) {
    const exact = await artifacts.readStructuralDiff(key)
    if (exact !== null) return exact
  }
  return artifacts.readStructuralDiff({ ...key, generation: null })
}

/** A deep request that cannot index answers its baseline with the reason. */
function deepUnavailable(baseline: StructuralDiff): StructuralDiff {
  return { ...baseline, engine: 'baseline', degradedReason: DEEP_INDEXING_UNAVAILABLE }
}

/** Compute the baseline, then (if deep requested) try to upgrade its impact to
 *  precise SCIP-resolved callers — falling back to baseline on ANY failure. */
async function withDeep(
  deepOpts: DeepOpts | undefined,
  content: RepositoryRevisionContent,
  computeBaseline: () => Promise<StructuralDiff>,
  /** RFC-258 (impl-gate P1-2) — share the code-intel index cache per repo. */
  cacheScope?: { taskId: string; repoKey: string },
): Promise<StructuralDiff> {
  const baseline = await computeBaseline()
  if (deepOpts?.mode !== 'deep') return baseline
  // RFC-370 §10 V16: an indexer runs only where the content lives on this host.
  if (!content.capabilities.indexing) return deepUnavailable(baseline)
  try {
    return await computeDeepStructuralDiff({
      baseline,
      worktreePath: content.capabilities.indexRoot,
      deps: {
        deepCfg: deepOpts.deepCfg,
        snapshotDigest: () => content.snapshotDigest(),
        ...(cacheScope !== undefined ? { cacheScope } : {}),
      },
    })
  } catch (err) {
    const reason = err instanceof DeepUnavailableError ? err.reason : 'build-failed'
    return { ...baseline, engine: 'baseline', degradedReason: reason }
  }
}

/** A terminal generation's stored diff, when this request may be served by it. */
async function storedFirst(
  reads: ResolvedCodeReviewReads,
  key: StructuralDiffArtifactKey,
  content: RepositoryRevisionContent,
  deepOpts: DeepOpts | undefined,
): Promise<StructuralDiff | null> {
  if (key.generation === null) return null
  const deep = deepOpts?.mode === 'deep'
  // A deep request that can index computes; deep results are never stored.
  if (deep && content.capabilities.indexing) return null
  const stored = await reads.artifacts.readStructuralDiff(key)
  if (stored === null) return null
  return deep ? deepUnavailable(stored) : stored
}

export async function getTaskStructuralDiff(
  input: CodeReviewReadInput,
  taskId: string,
  scope: StructuralScope = 'task',
  nodeRunId?: string,
  deepOpts?: DeepOpts,
): Promise<StructuralDiff> {
  const reads = codeReviewReads(input)
  const task = await reads.workspace.findTask(taskId)
  if (task === null) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }

  if (scope === 'node') {
    return getNodeStructuralDiff(reads, task, nodeRunId, deepOpts)
  }
  if (scope === 'wrapper') {
    return getWrapperStructuralDiff(reads, task, nodeRunId, deepOpts)
  }

  const storeKey: StructuralDiffArtifactKey = {
    taskId,
    scope,
    generation: terminalGeneration(task),
  }
  const content = reads.content.bind(task.worktreePath)
  const stored = await storedFirst(reads, storeKey, content, deepOpts)
  if (stored !== null) return withContentDigest(stored)

  if (isSingleRootRepository(task.repos.map((repo) => repo.mountPath))) {
    if (task.baseCommit === null) {
      throw new DomainError(
        'task-no-base-commit',
        `task '${taskId}' has no base commit recorded; cannot compute structural diff`,
        409,
      )
    }
    if ((await content.presence()) !== 'git') {
      // Worktree GC'd OR no longer a git repo (source repo moved/deleted) —
      // serve the eager-persisted artifact if we have one, else a clean 410
      // (RFC-089 P1: `existsSync` alone let a broken worktree reach `git diff`
      // and 500; the git presence check collapses it to the same 410 as the
      // textual diff tab).
      const fallback = await readStoredTaskDiff(reads.artifacts, storeKey)
      if (fallback !== null) return withContentDigest(fallback)
      throw new DomainError(
        'task-worktree-missing',
        `worktree '${task.worktreePath}' is unavailable (missing or no longer a git repository); cannot compute structural diff`,
        410,
      )
    }
    const baseCommit = task.baseCommit
    const diff = withContentDigest(
      withEmptyHint(
        await withDeep(
          deepOpts,
          content,
          () =>
            computeFromWorktree({
              taskId,
              scope,
              worktreePath: task.worktreePath,
              fromRef: baseCommit,
              content,
            }),
          { taskId, repoKey: '' },
        ),
        task.spaceKind,
      ),
    )
    // Persist the BASELINE for terminal tasks so the view survives a later
    // worktree GC. Never persist a deep request's result (deep is on-demand).
    if (deepOpts?.mode !== 'deep' && isTerminalTaskStatus(task.status))
      void reads.artifacts.writeStructuralDiff(storeKey, diff)
    return diff
  }

  // Multi-repo: merge per-repo diffs, labeling files by repo dir.
  if ((await content.presence()) === 'absent') {
    const fallback = await readStoredTaskDiff(reads.artifacts, storeKey)
    if (fallback !== null) return withContentDigest(fallback)
    throw new DomainError(
      'task-worktree-missing',
      `worktree '${task.worktreePath}' does not exist; cannot compute structural diff`,
      410,
    )
  }
  const candidates = task.repos.filter((r) => r.baseCommit !== null && r.baseCommit !== '')
  // RFC-089 P1: a repo worktree dir can outlive its source repo, so existence
  // isn't enough — drop non-git ones as bad shards (mirrors getTaskDiff).
  const presence = await Promise.all(
    candidates.map((r) => reads.content.bind(r.worktreePath).presence()),
  )
  const usable = candidates.filter((_, i) => presence[i] === 'git')
  if (usable.length === 0) {
    throw new DomainError(
      'task-no-base-commit',
      `task '${taskId}' has no repo with a recorded base commit; cannot compute structural diff`,
      409,
    )
  }
  // RFC-239 — canonical labels are computed over the FULL repo list so the
  // text-diff markers and these structural prefixes agree per repo even when
  // the two paths filter different usable subsets.
  const allLabels = canonicalRepoKeys(task.repos)
  const labelOf = new Map(task.repos.map((r, i) => [r, allLabels[i] ?? 'repo']))
  const parts: Array<{ label: string; diff: StructuralDiff }> = []
  for (const repo of usable) {
    const diff = await computeFromWorktree({
      taskId,
      scope,
      worktreePath: repo.worktreePath,
      fromRef: repo.baseCommit as string,
      content: reads.content.bind(repo.worktreePath),
    })
    parts.push({ label: labelOf.get(repo) ?? 'repo', diff })
  }
  const merged = withContentDigest(
    withEmptyHint(
      mergeStructuralDiffs(
        {
          scope,
          taskId,
          fromRef: 'multi',
          toRef: 'WORKTREE',
          engine: 'baseline',
          status: usable.length === task.repos.length ? 'ok' : 'partial',
          // RFC-248: 前端拆前缀时用它，不自己猜 key 集合。
          repoKeys: allLabels,
        },
        parts,
      ),
      task.spaceKind,
    ),
  )
  if (isTerminalTaskStatus(task.status)) void reads.artifacts.writeStructuralDiff(storeKey, merged)
  return merged
}

/** RFC-239 — differentiate the "nothing here" states: a scratch-space task with
 *  no git-visible change reads very differently from a repo task that modified
 *  nothing (the former confused users into thinking the analysis broke). Only
 *  stamped when the diff is genuinely empty. */
function withEmptyHint(diff: StructuralDiff, spaceKind: string): StructuralDiff {
  if (diff.files.length > 0 || diff.dependencyChanges.length > 0) return diff
  return { ...diff, emptyHint: spaceKind === 'scratch' ? 'scratch-space' : 'no-changes' }
}

/** RFC-239 §3.6 — stamp the canonical content digest on every task-scope
 *  response (live or stored; pre-RFC-239 stored artifacts get it backfilled on
 *  read). The narrative freezes the digest it generated from; the frontend only
 *  ever compares those two backend-computed values. */
function withContentDigest(diff: StructuralDiff): StructuralDiff {
  if (diff.contentDigest !== undefined) return diff
  return { ...diff, contentDigest: computeContentDigest(diff) }
}

type ResolvedTask = CodeWorkspaceTask

/** RFC-370 §10 V16 — a per-node / per-wrapper diff of a terminal generation is
 *  stored too, so browsing nodes of a finished task never wakes its volume. */
function persistScoped(
  reads: ResolvedCodeReviewReads,
  key: StructuralDiffArtifactKey,
  diff: StructuralDiff,
  deepOpts: DeepOpts | undefined,
): StructuralDiff {
  if (key.generation !== null && deepOpts?.mode !== 'deep')
    void reads.artifacts.writeStructuralDiff(key, diff).catch(() => undefined)
  return diff
}

/** Per-node structural diff: what did this specific node run change? */
async function getNodeStructuralDiff(
  reads: ResolvedCodeReviewReads,
  task: ResolvedTask,
  nodeRunId: string | undefined,
  deepOpts?: DeepOpts,
): Promise<StructuralDiff> {
  if (nodeRunId === undefined || nodeRunId === '') {
    throw new ValidationError(
      'structural-node-run-required',
      `structural-diff scope 'node' requires a 'nodeRunId' query param`,
    )
  }
  const rows = await reads.workspace.listNodeRuns(task.id)
  const storeKey: StructuralDiffArtifactKey = {
    taskId: task.id,
    scope: 'node',
    nodeRunId,
    generation: terminalGeneration(task),
  }

  // RFC-089 P3 — multi-repo node scope: resolve + compute per repo (reusing the
  // single-repo resolveNodeScope over each repo's column via perRepoNodeRuns),
  // then merge. Wrapper structural scope still requires a single root repo;
  // this branch consumes the node's per-repository snapshots.
  if (!isSingleRootRepository(task.repos.map((repo) => repo.mountPath))) {
    if (!rows.some((r) => r.id === nodeRunId)) {
      throw new NotFoundError(
        'node-run-not-found',
        `node run '${nodeRunId}' not found in task '${task.id}'`,
      )
    }
    const stored = await storedFirst(
      reads,
      storeKey,
      reads.content.bind(task.worktreePath),
      deepOpts,
    )
    if (stored !== null) return stored
    const parts: Array<{ label: string; diff: StructuralDiff }> = []
    let hadSnapshot = false
    let hadError = false
    const nodeLabels = canonicalRepoKeys(task.repos)
    for (const [repoIdx, repo] of task.repos.entries()) {
      const res = resolveNodeScope(perRepoNodeRuns([...rows], repo.mountPath), nodeRunId)
      if (res.kind !== 'between' && res.kind !== 'to-worktree') continue // node didn't write this repo
      hadSnapshot = true
      const content = reads.content.bind(repo.worktreePath)
      if ((await content.presence()) !== 'git') {
        hadError = true
        continue
      }
      const label = nodeLabels[repoIdx] ?? 'repo'
      try {
        const diff = await withDeep(deepOpts, content, () =>
          res.kind === 'between'
            ? computeBetweenRefs({
                taskId: task.id,
                scope: 'node',
                nodeRunId,
                worktreePath: repo.worktreePath,
                fromRef: res.fromRef,
                toRef: res.toRef,
                content,
              })
            : computeFromWorktree({
                taskId: task.id,
                scope: 'node',
                nodeRunId,
                worktreePath: repo.worktreePath,
                fromRef: res.fromRef,
                content,
              }),
        )
        parts.push({ label, diff })
      } catch {
        hadError = true
      }
    }
    if (parts.length === 0) {
      // A snapshot existed somewhere but nothing computed → pruned; otherwise the
      // node simply wrote no repo → readonly. Mirrors the single-repo codes.
      return hadSnapshot
        ? emptyNodeDiff(task.id, nodeRunId, 'snapshot-pruned', 'pruned')
        : emptyNodeDiff(task.id, nodeRunId, 'readonly-node-no-snapshot')
    }
    const merged = mergeStructuralDiffs(
      {
        scope: 'node',
        taskId: task.id,
        nodeRunId,
        fromRef: 'multi',
        toRef: 'WORKTREE',
        engine: 'baseline',
        status: hadError ? 'partial' : 'ok',
      },
      parts,
    )
    return hadError ? merged : persistScoped(reads, storeKey, merged, deepOpts)
  }

  // Single root repository — unchanged.
  // A git-wrapper node selected in the per-node picker → use its recorded
  // baseline (the wrapper's diff is baseline → worktree, not a snapshot pair).
  const target = rows.find((r) => r.id === nodeRunId)
  if (target !== undefined && parseWrapperGitBaseline(target.wrapperProgressJson) !== null) {
    return getWrapperStructuralDiff(reads, task, nodeRunId, deepOpts)
  }

  const res = resolveNodeScope(perRepoNodeRuns(rows, ''), nodeRunId)
  if (res.kind === 'not-found') {
    throw new NotFoundError(
      'node-run-not-found',
      `node run '${nodeRunId}' not found in task '${task.id}'`,
    )
  }
  if (res.kind === 'readonly') {
    // Readonly / non-write node correctly contributes nothing.
    return emptyNodeDiff(task.id, nodeRunId, 'readonly-node-no-snapshot')
  }
  const worktreePath = task.worktreePath
  const content = reads.content.bind(worktreePath)
  const stored = await storedFirst(reads, storeKey, content, deepOpts)
  if (stored !== null) return stored
  if ((await content.presence()) !== 'git') {
    throw new DomainError(
      'task-worktree-missing',
      `worktree '${task.worktreePath}' is unavailable (missing or no longer a git repository); cannot compute structural diff`,
      410,
    )
  }
  const resolution = res
  try {
    const diff = await withDeep(deepOpts, content, () =>
      resolution.kind === 'between'
        ? computeBetweenRefs({
            taskId: task.id,
            scope: 'node',
            nodeRunId,
            worktreePath,
            fromRef: resolution.fromRef,
            toRef: resolution.toRef,
            content,
          })
        : computeFromWorktree({
            taskId: task.id,
            scope: 'node',
            nodeRunId,
            worktreePath,
            fromRef: resolution.fromRef,
            content,
          }),
    )
    return persistScoped(reads, storeKey, diff, deepOpts)
  } catch (error) {
    // An older task image cannot answer at all: that is not a pruned snapshot.
    if (error instanceof DomainError && error.status === 410) throw error
    // Snapshot objects pruned by a post-GC `git gc` — surface gracefully.
    return emptyNodeDiff(task.id, nodeRunId, 'snapshot-pruned', 'pruned')
  }
}

function emptyNodeDiff(
  taskId: string,
  nodeRunId: string,
  degradedReason: string,
  status: StructuralDiff['status'] = 'ok',
  scope: StructuralScope = 'node',
): StructuralDiff {
  return {
    scope,
    taskId,
    nodeRunId,
    fromRef: '',
    toRef: '',
    engine: 'baseline',
    status,
    degradedReason,
    files: [],
    dependencyChanges: [],
    impact: [],
    classEdges: [],
    summary: computeSummary([], []),
  }
}

/** wrapper-git baseline commit (the HEAD captured before the inner scope), or
 *  null when the node isn't a git wrapper / has no recorded baseline. */
export function parseWrapperGitBaseline(json: string | null): string | null {
  return readWrapperGitBaseline(json)
}

/** Per-wrapper structural diff: what did a git-wrapper's inner scope change?
 *  fromRef = the wrapper's recorded baseline commit; toRef = the worktree. */
async function getWrapperStructuralDiff(
  reads: ResolvedCodeReviewReads,
  task: ResolvedTask,
  nodeRunId: string | undefined,
  deepOpts?: DeepOpts,
): Promise<StructuralDiff> {
  if (nodeRunId === undefined || nodeRunId === '') {
    throw new ValidationError(
      'structural-node-run-required',
      `structural-diff scope 'wrapper' requires a 'nodeRunId' query param`,
    )
  }
  if (!isSingleRootRepository(task.repos.map((repo) => repo.mountPath))) {
    throw new ValidationError(
      'structural-wrapper-scope-multi-repo-unsupported',
      `per-wrapper structural diff is single-repo only in v1`,
    )
  }
  const row = await reads.workspace.findNodeRun(nodeRunId)
  if (row === null) {
    throw new NotFoundError(
      'node-run-not-found',
      `node run '${nodeRunId}' not found in task '${task.id}'`,
    )
  }
  const baseline = parseWrapperGitBaseline(row.wrapperProgressJson)
  if (baseline === null) {
    throw new ValidationError(
      'structural-wrapper-not-git',
      `node run '${nodeRunId}' is not a git-wrapper with a recorded baseline commit`,
    )
  }
  const worktreePath = task.worktreePath
  const content = reads.content.bind(worktreePath)
  const storeKey: StructuralDiffArtifactKey = {
    taskId: task.id,
    scope: 'wrapper',
    nodeRunId,
    generation: terminalGeneration(task),
  }
  const stored = await storedFirst(reads, storeKey, content, deepOpts)
  if (stored !== null) return stored
  if ((await content.presence()) !== 'git') {
    throw new DomainError(
      'task-worktree-missing',
      `worktree '${task.worktreePath}' is unavailable (missing or no longer a git repository); cannot compute structural diff`,
      410,
    )
  }
  try {
    const diff = await withDeep(deepOpts, content, () =>
      computeFromWorktree({
        taskId: task.id,
        scope: 'wrapper',
        nodeRunId,
        worktreePath,
        fromRef: baseline,
        content,
      }),
    )
    return persistScoped(reads, storeKey, diff, deepOpts)
  } catch (error) {
    if (error instanceof DomainError && error.status === 410) throw error
    return emptyNodeDiff(task.id, nodeRunId, 'snapshot-pruned', 'pruned', 'wrapper')
  }
}
