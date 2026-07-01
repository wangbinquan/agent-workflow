// RFC-130 — per-node isolated worktree lifecycle (design.md §2/§4/§5).
//
// Each agent node run executes in its OWN isolated git worktree, branched from a
// full snapshot of the canonical worktree taken at dispatch. On success the node's
// delta is 3-way merged back into the canonical worktree under the task write lock.
// This module owns the git mechanics (create / snapshot-final / merge-back / discard);
// the scheduler (services/scheduler.ts) owns the DB column writes + lock ordering
// so it can keep the writeSem critical sections tight (§7).
//
// Multi-repo (RFC-066): every canonical repo gets its OWN iso worktree; snapshot +
// merge-back are per-repo and independent (a conflict in one repo does not touch
// another — design.md §9).

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  commitTree,
  createIsolatedWorktree,
  deleteIsoRefs,
  isGitWorkTree,
  isoRefName,
  materializeTree,
  mergeTreeInMemory,
  removeWorktree,
  runGit,
  snapshotFullState,
} from '@/util/git'
import {
  buildMergeResolvePrompt,
  evaluateResolution,
  type MergeConflictEntry,
  parseConflictManifest,
  type ResolvedPathState,
} from '@/services/mergeAgent'
import type { Logger } from '@/util/log'

/** One canonical repo + its isolated mirror for a single node run. */
export interface IsoRepo {
  /** Source repo (for `git worktree add/remove` + ref ops). */
  repoPath: string
  /** Canonical worktree — snapshot source + merge-back target. */
  canonWorktreePath: string
  /** The isolated worktree — the node's opencode cwd. */
  isoWorktreePath: string
  /** '' for single-repo; the per-repo sub-dir name for multi-repo. */
  worktreeDirName: string
  baseBranch: string
  /** Full-state snapshot commit the iso branched from (merge base). */
  baseSnapshot: string
  /** Canonical HEAD when the iso was created (iso `reset --mixed` target). */
  taskBaseHead: string
}

export interface IsoHandle {
  taskId: string
  nodeRunId: string
  /** `{appHome}/iso/{taskId}/{nodeRunId}` — the GC/resume cleanup root (D14). */
  containerPath: string
  repos: IsoRepo[]
  /**
   * True when the canonical worktree is NOT a git repo, so isolation was skipped
   * and the node runs directly in the canonical worktree (no snapshot / merge-back
   * / discard). Real task worktrees are always `git worktree add`ed, so this only
   * triggers in mock harnesses that stub the worktree — it keeps those tests
   * running the pre-RFC-130 in-place path (merge_state stays NULL → golden-lock).
   */
  passthrough: boolean
}

/** A canonical repo as the scheduler knows it (subset of state.repos[]). */
export interface CanonRepo {
  repoPath: string
  worktreePath: string
  worktreeDirName: string
  baseBranch: string
}

/** Absolute iso worktree path — always OUTSIDE any canonical worktree (D14). */
export function isoWorktreePathFor(
  appHome: string,
  taskId: string,
  nodeRunId: string,
  worktreeDirName: string,
): string {
  const root = join(appHome, 'iso', taskId, nodeRunId)
  return worktreeDirName === '' ? root : join(root, worktreeDirName)
}

async function headOf(worktreePath: string): Promise<string> {
  const r = await runGit(worktreePath, ['rev-parse', 'HEAD'])
  return r.stdout.trim()
}
async function treeOf(repoPath: string, commit: string): Promise<string> {
  const r = await runGit(repoPath, ['rev-parse', `${commit}^{tree}`])
  return r.stdout.trim()
}

/**
 * Create the isolated worktree(s) for a node run (all repos). Snapshots each
 * canonical worktree's FULL state (incl. untracked), pins it as the base ref
 * (D26), and checks out an iso worktree with the accumulated changes UNSTAGED
 * (D23/D28). Does NOT touch the DB — the caller persists iso_base_snapshot(s) +
 * iso_worktree_path.
 */
export async function createNodeIso(opts: {
  appHome: string
  taskId: string
  nodeRunId: string
  canonRepos: CanonRepo[]
  submoduleMode?: 'auto' | 'always' | 'never'
  submoduleJobs?: number
  log?: Logger
}): Promise<IsoHandle> {
  // Passthrough fallback: if the canonical worktree isn't a git repo (only ever
  // true in mock test harnesses), skip isolation and run in place — the node's
  // writes go straight to the canonical worktree as they did pre-RFC-130.
  const primary = opts.canonRepos[0]
  if (primary === undefined || !(await isGitWorkTree(primary.worktreePath))) {
    opts.log?.warn('canonical worktree is not a git repo — skipping isolation (passthrough)', {
      worktreePath: primary?.worktreePath ?? '(none)',
    })
    return {
      taskId: opts.taskId,
      nodeRunId: opts.nodeRunId,
      containerPath: isoWorktreePathFor(opts.appHome, opts.taskId, opts.nodeRunId, ''),
      passthrough: true,
      repos: opts.canonRepos.map((r) => ({
        repoPath: r.repoPath,
        canonWorktreePath: r.worktreePath,
        isoWorktreePath: r.worktreePath, // run in place
        worktreeDirName: r.worktreeDirName,
        baseBranch: r.baseBranch,
        baseSnapshot: '',
        taskBaseHead: '',
      })),
    }
  }
  const repos: IsoRepo[] = []
  for (const r of opts.canonRepos) {
    const isoWorktreePath = isoWorktreePathFor(
      opts.appHome,
      opts.taskId,
      opts.nodeRunId,
      r.worktreeDirName,
    )
    const taskBaseHead = await headOf(r.worktreePath)
    const baseSnapshot = await snapshotFullState(r.worktreePath, {
      pinRef: isoRefName(opts.taskId, opts.nodeRunId, 'base'),
      log: opts.log,
    })
    // Run `git worktree add` from the CANONICAL worktree, not the source repo:
    // the base-snapshot commit was just created in the canonical worktree's
    // (shared) ODB, and `git worktree` ops work from any worktree of the set.
    // A real task worktree is a linked worktree of repoPath (shared ODB), so this
    // is equivalent there — but it also works when a test wires them as separate
    // repos (the snapshot lives only in the canonical worktree's ODB).
    await createIsolatedWorktree({
      repoPath: r.worktreePath,
      isoPath: isoWorktreePath,
      baseSnapshotCommit: baseSnapshot,
      taskBaseHead,
      ...(opts.submoduleMode !== undefined ? { submoduleMode: opts.submoduleMode } : {}),
      ...(opts.submoduleJobs !== undefined ? { submoduleJobs: opts.submoduleJobs } : {}),
    })
    repos.push({
      repoPath: r.repoPath,
      canonWorktreePath: r.worktreePath,
      isoWorktreePath,
      worktreeDirName: r.worktreeDirName,
      baseBranch: r.baseBranch,
      baseSnapshot,
      taskBaseHead,
    })
  }
  return {
    taskId: opts.taskId,
    nodeRunId: opts.nodeRunId,
    containerPath: isoWorktreePathFor(opts.appHome, opts.taskId, opts.nodeRunId, ''),
    passthrough: false,
    repos,
  }
}

/** Reconstruct an IsoHandle from persisted columns (resume / GC replay — D15). */
export function rebuildIsoHandle(opts: {
  appHome: string
  taskId: string
  nodeRunId: string
  canonRepos: CanonRepo[]
  baseSnapshots: Record<string, string>
  taskBaseHeads: Record<string, string>
}): IsoHandle {
  const repos: IsoRepo[] = opts.canonRepos.map((r) => ({
    repoPath: r.repoPath,
    canonWorktreePath: r.worktreePath,
    isoWorktreePath: isoWorktreePathFor(
      opts.appHome,
      opts.taskId,
      opts.nodeRunId,
      r.worktreeDirName,
    ),
    worktreeDirName: r.worktreeDirName,
    baseBranch: r.baseBranch,
    baseSnapshot: opts.baseSnapshots[r.worktreeDirName] ?? '',
    taskBaseHead: opts.taskBaseHeads[r.worktreeDirName] ?? '',
  }))
  return {
    taskId: opts.taskId,
    nodeRunId: opts.nodeRunId,
    containerPath: isoWorktreePathFor(opts.appHome, opts.taskId, opts.nodeRunId, ''),
    passthrough: false,
    repos,
  }
}

/**
 * Snapshot each iso worktree's FINAL state (the node's product) as a pinned
 * commit (D15/D26 `node` ref). Returns per-repo node_tree shas so the caller can
 * persist iso_node_tree(+_repos_json) BEFORE the merge-back (crash-replay, D15).
 */
export async function snapshotNodeIsoFinal(
  handle: IsoHandle,
  log?: Logger,
): Promise<Record<string, string>> {
  if (handle.passthrough) return {}
  const out: Record<string, string> = {}
  for (const r of handle.repos) {
    out[r.worktreeDirName] = await snapshotFullState(r.isoWorktreePath, {
      pinRef: isoRefName(handle.taskId, handle.nodeRunId, 'node'),
      log,
    })
  }
  return out
}

/**
 * One conflicted repo from a merge-back. Carries everything the merge agent
 * (§6) needs to build a resolve-iso and materialize a resolution WITHOUT going
 * back to the DB: the conflicted auto-merge tree, the raw merge-tree output (for
 * conflict-CLASS classification), and the merge base + canon refs.
 */
export interface MergeBackConflict {
  worktreeDirName: string
  /** Conflicted paths (back-compat with pre-PR-B callers). */
  paths: string[]
  /** Conflicted auto-merge tree OID — `commit-tree` this to seed resolve-iso (§6.2①). */
  mergedTree: string
  /** Raw `git merge-tree` stdout → parseConflictManifest for the 5-class manifest. */
  rawConflictOutput: string
  /** Merge base (iso baseSnapshot) — the commit-tree parent (§6.2①). */
  base: string
  /** git-ops dir = canonical worktree (shared ODB); the resolution's materialize target. */
  canonWorktreePath: string
  /** Canonical HEAD when the iso was created — materializeTree's taskBaseHead (§5.3). */
  taskBaseHead: string
}

export interface MergeBackResult {
  clean: boolean
  /** Per-repo conflicts (only repos that conflicted appear). */
  conflicts: MergeBackConflict[]
}

/**
 * Merge each repo's iso final tree back into its canonical worktree (design.md
 * §5). Per repo: snapshot canonical NOW (ours), 3-way merge-tree(base, ours,
 * node_tree). Clean → materialize into canonical (unstaged, HEAD unchanged).
 * Conflict → left for the caller (merge agent / awaiting_human, PR-B); canonical
 * for that repo is NOT touched (D27 — kept clean for sibling merge-backs).
 *
 * `nodeTrees` maps worktreeDirName → node_tree sha (from snapshotNodeIsoFinal, or
 * re-read from the persisted column on a replay).
 */
export async function mergeBackNodeIso(
  handle: IsoHandle,
  nodeTrees: Record<string, string>,
  log?: Logger,
): Promise<MergeBackResult> {
  if (handle.passthrough) return { clean: true, conflicts: [] }
  const conflicts: MergeBackResult['conflicts'] = []
  for (const r of handle.repos) {
    const theirs = nodeTrees[r.worktreeDirName]
    if (theirs === undefined) continue
    const ours = await snapshotFullState(r.canonWorktreePath, { log })
    const merge = await mergeTreeInMemory(r.canonWorktreePath, {
      base: r.baseSnapshot,
      ours,
      theirs,
    })
    if (merge.conflicts.length > 0) {
      conflicts.push({
        worktreeDirName: r.worktreeDirName,
        paths: merge.conflicts,
        mergedTree: merge.mergedTree,
        rawConflictOutput: merge.rawConflictOutput,
        base: r.baseSnapshot,
        canonWorktreePath: r.canonWorktreePath,
        taskBaseHead: r.taskBaseHead,
      })
      continue
    }
    const canonCurrentTree = await treeOf(r.canonWorktreePath, ours)
    await materializeTree(r.canonWorktreePath, {
      mergedTree: merge.mergedTree,
      canonCurrentTree,
      taskBaseHead: r.taskBaseHead,
    })
  }
  return { clean: conflicts.length === 0, conflicts }
}

/** Remove all iso worktrees + delete the base/node pin refs for a run (best-effort). */
export async function discardNodeIso(handle: IsoHandle, log?: Logger): Promise<void> {
  if (handle.passthrough) return // in-place run — the canonical worktree is NOT ours to remove
  for (const r of handle.repos) {
    try {
      await removeWorktree({
        repoPath: r.canonWorktreePath,
        worktreePath: r.isoWorktreePath,
        force: true,
      })
    } catch (err) {
      log?.warn('iso worktree remove failed (leaving for GC)', {
        isoWorktreePath: r.isoWorktreePath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    await deleteIsoRefs(r.canonWorktreePath, handle.taskId, handle.nodeRunId)
  }
}

// ---------------------------------------------------------------------------
// RFC-130 §6.2 — merge-agent conflict resolution (git orchestration).
// The scheduler injects `runAgent` (a runNode call that BYPASSES globalSem, §7)
// so this git-only orchestration stays unit-testable with a mock agent.
// ---------------------------------------------------------------------------

export interface ResolveConflictOutcome {
  resolved: boolean
  /** Manifest entries the framework could NOT confirm resolved (empty if resolved). */
  unresolved: MergeConflictEntry[]
  /**
   * The resolve-iso worktree. On SUCCESS it has been removed (null). On FAILURE
   * it is KEPT (D27/§6.3) so a human can finish the resolution there; the path is
   * returned for the awaiting_human detail + resume.
   */
  resolveIsoPath: string | null
}

/**
 * RFC-130 §6.2: try to auto-resolve ONE conflicted repo with the built-in merge
 * agent. Seeds a detached resolve-iso from the conflicted auto-merge tree (so
 * content conflicts carry markers), runs the agent there, then judges resolution
 * from the framework's OWN observation of the worktree (D6) — never the agent's
 * self-report. On success the resolution is materialized into the canonical
 * worktree and the resolve-iso removed; on failure the resolve-iso is preserved.
 *
 * `runAgent(prompt, cwd)` is injected by the scheduler and MUST dispatch the merge
 * agent WITHOUT acquiring globalSem (§7 deadlock avoidance). Setup failures
 * (commit-tree / worktree add) throw → caller treats as merge-failed; a failed
 * agent RUN resolves to `{ resolved: false }` with the iso kept.
 */
export async function resolveConflictWithAgent(
  conflict: MergeBackConflict,
  opts: {
    containerPath: string
    runAgent: (prompt: string, cwd: string) => Promise<void>
    log?: Logger
  },
): Promise<ResolveConflictOutcome> {
  const { containerPath, runAgent, log } = opts
  const repoGit = conflict.canonWorktreePath // shared-ODB git dir for worktree/commit ops
  // §6.2①: commit-tree the conflicted merged tree (worktree add needs a commit-ish),
  // then check it out detached — the working tree now carries the conflict markers.
  const cmt = await commitTree(repoGit, conflict.mergedTree, conflict.base, 'aw-conflict')
  const suffix = conflict.worktreeDirName === '' ? 'repo' : conflict.worktreeDirName
  const resolveIso = join(containerPath, `resolve-${suffix}`)
  await runGit(repoGit, ['worktree', 'add', '--detach', resolveIso, cmt])

  const manifest = parseConflictManifest(conflict.rawConflictOutput, conflict.worktreeDirName)
  let resolved = false
  let unresolved: MergeConflictEntry[] = manifest
  try {
    // §6.2②: run the merge agent in the resolve-iso (scheduler bypasses globalSem).
    await runAgent(buildMergeResolvePrompt({ manifest }), resolveIso)
    // §6.2③: framework self-check from observed worktree state.
    const states = gatherResolvedStates(resolveIso, manifest)
    const verdict = evaluateResolution(manifest, states)
    resolved = verdict.resolved
    unresolved = verdict.unresolved
  } catch (err) {
    log?.warn('merge agent run failed → treat as unresolved', {
      resolveIso,
      error: err instanceof Error ? err.message : String(err),
    })
    resolved = false
  }

  if (!resolved) {
    // §6.3: KEEP the resolve-iso (do NOT materialize markers into canon) — the
    // canonical worktree stays clean for sibling merge-backs; human resolves here.
    return { resolved: false, unresolved, resolveIsoPath: resolveIso }
  }
  // §6.2④: snapshot the resolution + materialize into the canonical worktree.
  const resolvedTree = await snapshotFullState(resolveIso, { log })
  const ours = await snapshotFullState(conflict.canonWorktreePath, { log })
  const canonCurrentTree = await treeOf(conflict.canonWorktreePath, ours)
  await materializeTree(conflict.canonWorktreePath, {
    mergedTree: resolvedTree,
    canonCurrentTree,
    taskBaseHead: conflict.taskBaseHead,
  })
  // §6.2⑤: discard the resolve-iso (resolution now lives in canon).
  await removeWorktree({ repoPath: repoGit, worktreePath: resolveIso, force: true }).catch(
    (err) => {
      log?.warn('resolve-iso remove failed (leaving for GC)', {
        resolveIso,
        error: err instanceof Error ? err.message : String(err),
      })
    },
  )
  return { resolved: true, unresolved: [], resolveIsoPath: null }
}

/** Read each manifest path's state from the resolve-iso worktree (§6.2③ inputs). */
function gatherResolvedStates(
  resolveIso: string,
  manifest: MergeConflictEntry[],
): ResolvedPathState[] {
  const out: ResolvedPathState[] = []
  for (const e of manifest) {
    const abs = join(resolveIso, e.path)
    if (!existsSync(abs)) {
      out.push({ worktreeDirName: e.worktreeDirName, path: e.path, present: false, content: null })
      continue
    }
    const buf = readFileSync(abs)
    // git's binary heuristic: a NUL byte ⟹ binary → no text markers to grep.
    const content = buf.includes(0) ? null : buf.toString('utf8')
    out.push({ worktreeDirName: e.worktreeDirName, path: e.path, present: true, content })
  }
  return out
}
