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

import { existsSync } from 'node:fs'
import { DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { isGitWorkTree } from '@/util/git'
import { computeSummary, type StructuralDiff, type StructuralScope } from '@agent-workflow/shared'
import type {
  CodeWorkspaceRead,
  CodeWorkspaceTask,
} from '@/modules/code-capability/application/ports/codeWorkspaceRead'
import { canonicalRepoKeys } from '@/services/repoLabels'
import { readWrapperGitBaseline } from '@/modules/task-execution/public/queries'
import { computeFromWorktree, computeBetweenRefs } from './gitBackend'
import { computeContentDigest } from './digest'
import { mergeStructuralDiffs } from './assemble'
import { resolveNodeScope, perRepoNodeRuns } from './refSelect'
import { readStoredDiff, writeStoredDiff, isTerminalTaskStatus } from './store'
import {
  computeDeepStructuralDiff,
  DeepUnavailableError,
  type ResolvedDeepConfig,
} from './deep/service'

/** Deep-mode request: try the external SCIP indexer, fall back to baseline. */
export interface DeepOpts {
  mode: 'baseline' | 'deep'
  deepCfg?: ResolvedDeepConfig
}

/** Compute the baseline, then (if deep requested) try to upgrade its impact to
 *  precise SCIP-resolved callers — falling back to baseline on ANY failure. */
async function withDeep(
  deepOpts: DeepOpts | undefined,
  worktreePath: string,
  computeBaseline: () => Promise<StructuralDiff>,
  /** RFC-258 (impl-gate P1-2) — share the code-intel index cache per repo. */
  cacheScope?: { taskId: string; repoKey: string },
): Promise<StructuralDiff> {
  const baseline = await computeBaseline()
  if (deepOpts?.mode !== 'deep') return baseline
  try {
    return await computeDeepStructuralDiff({
      baseline,
      worktreePath,
      deps: {
        deepCfg: deepOpts.deepCfg,
        ...(cacheScope !== undefined ? { cacheScope } : {}),
      },
    })
  } catch (err) {
    const reason = err instanceof DeepUnavailableError ? err.reason : 'build-failed'
    return { ...baseline, engine: 'baseline', degradedReason: reason }
  }
}

export async function getTaskStructuralDiff(
  workspace: CodeWorkspaceRead,
  taskId: string,
  scope: StructuralScope = 'task',
  nodeRunId?: string,
  deepOpts?: DeepOpts,
): Promise<StructuralDiff> {
  const task = await workspace.findTask(taskId)
  if (task === null) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }

  if (scope === 'node') {
    return getNodeStructuralDiff(workspace, task, nodeRunId, deepOpts)
  }
  if (scope === 'wrapper') {
    return getWrapperStructuralDiff(workspace, task, nodeRunId, deepOpts)
  }

  if (task.repoCount === 1) {
    if (task.baseCommit === null) {
      throw new DomainError(
        'task-no-base-commit',
        `task '${taskId}' has no base commit recorded; cannot compute structural diff`,
        409,
      )
    }
    if (!(await isGitWorkTree(task.worktreePath))) {
      // Worktree GC'd OR no longer a git repo (source repo moved/deleted) —
      // serve the eager-persisted artifact if we have one, else a clean 410
      // (RFC-089 P1: `existsSync` alone let a broken worktree reach `git diff`
      // and 500; `isGitWorkTree` collapses it to the same 410 as the textual
      // diff tab).
      const stored = await readStoredDiff(taskId, 'task')
      if (stored !== null) return withContentDigest(stored)
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
          task.worktreePath,
          () =>
            computeFromWorktree({
              taskId,
              scope,
              worktreePath: task.worktreePath,
              fromRef: baseCommit,
            }),
          { taskId, repoKey: '' },
        ),
        task.spaceKind,
      ),
    )
    // Persist the BASELINE for terminal tasks so the view survives a later
    // worktree GC. Never persist a deep request's result (deep is on-demand).
    if (deepOpts?.mode !== 'deep' && isTerminalTaskStatus(task.status)) void writeStoredDiff(diff)
    return diff
  }

  // Multi-repo: merge per-repo diffs, labeling files by repo dir.
  if (!existsSync(task.worktreePath)) {
    const stored = await readStoredDiff(taskId, 'task')
    if (stored !== null) return withContentDigest(stored)
    throw new DomainError(
      'task-worktree-missing',
      `worktree '${task.worktreePath}' does not exist; cannot compute structural diff`,
      410,
    )
  }
  const candidates = task.repos.filter(
    (r) => r.baseCommit !== null && r.baseCommit !== '' && existsSync(r.worktreePath),
  )
  // RFC-089 P1: a repo worktree dir can outlive its source repo, so existsSync
  // isn't enough — drop non-git ones as bad shards (mirrors getTaskDiff).
  const valid = await Promise.all(candidates.map((r) => isGitWorkTree(r.worktreePath)))
  const usable = candidates.filter((_, i) => valid[i])
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
  if (isTerminalTaskStatus(task.status)) void writeStoredDiff(merged)
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

/** Per-node structural diff: what did this specific node run change? */
async function getNodeStructuralDiff(
  workspace: CodeWorkspaceRead,
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
  const rows = await workspace.listNodeRuns(task.id)

  // RFC-089 P3 — multi-repo node scope: resolve + compute per repo (reusing the
  // single-repo resolveNodeScope over each repo's column via perRepoNodeRuns),
  // then merge. Multi-repo tasks have NO wrapper-git nodes (RFC-066 forbids
  // them), so there's no wrapper delegation in this branch.
  if (task.repoCount > 1) {
    if (!rows.some((r) => r.id === nodeRunId)) {
      throw new NotFoundError(
        'node-run-not-found',
        `node run '${nodeRunId}' not found in task '${task.id}'`,
      )
    }
    const parts: Array<{ label: string; diff: StructuralDiff }> = []
    let hadSnapshot = false
    let hadError = false
    const nodeLabels = canonicalRepoKeys(task.repos)
    for (const [repoIdx, repo] of task.repos.entries()) {
      const res = resolveNodeScope(perRepoNodeRuns([...rows], repo.worktreeDirName), nodeRunId)
      if (res.kind !== 'between' && res.kind !== 'to-worktree') continue // node didn't write this repo
      hadSnapshot = true
      if (!(await isGitWorkTree(repo.worktreePath))) {
        hadError = true
        continue
      }
      const label = nodeLabels[repoIdx] ?? 'repo'
      try {
        const diff = await withDeep(deepOpts, repo.worktreePath, () =>
          res.kind === 'between'
            ? computeBetweenRefs({
                taskId: task.id,
                scope: 'node',
                nodeRunId,
                worktreePath: repo.worktreePath,
                fromRef: res.fromRef,
                toRef: res.toRef,
              })
            : computeFromWorktree({
                taskId: task.id,
                scope: 'node',
                nodeRunId,
                worktreePath: repo.worktreePath,
                fromRef: res.fromRef,
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
    return mergeStructuralDiffs(
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
  }

  // Single-repo (repoCount === 1) — unchanged.
  // A git-wrapper node selected in the per-node picker → use its recorded
  // baseline (the wrapper's diff is baseline → worktree, not a snapshot pair).
  const target = rows.find((r) => r.id === nodeRunId)
  if (target !== undefined && parseWrapperGitBaseline(target.wrapperProgressJson) !== null) {
    return getWrapperStructuralDiff(workspace, task, nodeRunId, deepOpts)
  }

  const res = resolveNodeScope([...rows], nodeRunId)
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
  if (!(await isGitWorkTree(task.worktreePath))) {
    throw new DomainError(
      'task-worktree-missing',
      `worktree '${task.worktreePath}' is unavailable (missing or no longer a git repository); cannot compute structural diff`,
      410,
    )
  }
  const worktreePath = task.worktreePath
  const resolution = res
  try {
    return await withDeep(deepOpts, worktreePath, () =>
      resolution.kind === 'between'
        ? computeBetweenRefs({
            taskId: task.id,
            scope: 'node',
            nodeRunId,
            worktreePath,
            fromRef: resolution.fromRef,
            toRef: resolution.toRef,
          })
        : computeFromWorktree({
            taskId: task.id,
            scope: 'node',
            nodeRunId,
            worktreePath,
            fromRef: resolution.fromRef,
          }),
    )
  } catch {
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
  workspace: CodeWorkspaceRead,
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
  if (task.repoCount !== 1) {
    throw new ValidationError(
      'structural-wrapper-scope-multi-repo-unsupported',
      `per-wrapper structural diff is single-repo only in v1`,
    )
  }
  const row = await workspace.findNodeRun(nodeRunId)
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
  if (!(await isGitWorkTree(task.worktreePath))) {
    throw new DomainError(
      'task-worktree-missing',
      `worktree '${task.worktreePath}' is unavailable (missing or no longer a git repository); cannot compute structural diff`,
      410,
    )
  }
  const worktreePath = task.worktreePath
  try {
    return await withDeep(deepOpts, worktreePath, () =>
      computeFromWorktree({
        taskId: task.id,
        scope: 'wrapper',
        nodeRunId,
        worktreePath,
        fromRef: baseline,
      }),
    )
  } catch {
    return emptyNodeDiff(task.id, nodeRunId, 'snapshot-pruned', 'pruned', 'wrapper')
  }
}
