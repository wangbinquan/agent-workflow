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
  buildSalvageTree,
  commitTree,
  createIsolatedWorktree,
  deleteIsoRefs,
  gitCommitExists,
  hasDirtySubmoduleContent,
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
  type MergeConflictManifest,
  parseConflictManifest,
  type ResolvedPathState,
} from '@/services/mergeAgent'
import { repoRelForcedPaths } from '@/services/portArtifacts'
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
  /**
   * RFC-193 K1 必达：this repo's repo-relative force-include roster (archived
   * path-port source files so far in this task). EVERY full-state snapshot of
   * this repo (base / final / ours / conflict-resolve) carries it — gitignored
   * port files must survive all three hops of the propagation chain
   * (producer final → canonical materialize → consumer base), and add -A
   * drops them at each hop (design §4.5).
   */
  forcedRepoRelPaths: string[]
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
  /**
   * RFC-193 K1：container-relative force-include roster (forcedPortPathsForTask
   * 的产出，调用方聚合——本模块保持 git-only、不查 DB)。Split per-repo onto
   * IsoRepo.forcedRepoRelPaths; the BASE snapshot below already carries it so
   * a downstream iso checks out the gitignored port files of its upstreams.
   */
  forcedContainerPaths?: string[]
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
        forcedRepoRelPaths: [],
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
    const forcedRepoRelPaths = repoRelForcedPaths(opts.forcedContainerPaths, r.worktreeDirName)
    const taskBaseHead = await headOf(r.worktreePath)
    const baseSnapshot = await snapshotFullState(r.worktreePath, {
      pinRef: isoRefName(opts.taskId, opts.nodeRunId, 'base'),
      log: opts.log,
      forceIncludePaths: forcedRepoRelPaths,
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
      forcedRepoRelPaths,
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
  /** RFC-193 K1（同 createNodeIso）：resume 路径的快照同样要带清单。 */
  forcedContainerPaths?: string[]
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
    forcedRepoRelPaths: repoRelForcedPaths(opts.forcedContainerPaths, r.worktreeDirName),
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
  /**
   * RFC-193 K1：EXTRA container-relative force-include paths unioned onto the
   * handle roster — the producing node's own just-emitted port files
   * (RunResult.portFilePaths, not yet in the DB-aggregated roster) and the
   * wrapper-final re-aggregation (inner nodes archived DURING the wrapper's
   * lifetime; the wrapper handle is the one long-lived exception, §4.5).
   */
  extraForcedContainerPaths?: string[],
): Promise<Record<string, string>> {
  if (handle.passthrough) return {}
  const out: Record<string, string> = {}
  for (const r of handle.repos) {
    // RFC-130 D22: fail LOUD if the node left uncommitted content INSIDE a submodule
    // — the tree snapshot captures only the gitlink commit, so those edits would be
    // silently dropped on merge-back. The node fails (merge-failed) with a clear
    // message instead of losing work.
    if (await hasDirtySubmoduleContent(r.isoWorktreePath)) {
      throw new Error(
        `submodule-dirty-content: node ${handle.nodeRunId} left uncommitted content inside a ` +
          `submodule of '${r.worktreeDirName || 'repo'}'; the tree snapshot captures only the ` +
          `gitlink commit, so those edits cannot merge back. Commit the submodule changes inside ` +
          `the agent (or avoid editing submodule working trees).`,
      )
    }
    out[r.worktreeDirName] = await snapshotFullState(r.isoWorktreePath, {
      pinRef: isoRefName(handle.taskId, handle.nodeRunId, 'node'),
      log,
      forceIncludePaths: [
        ...r.forcedRepoRelPaths,
        ...repoRelForcedPaths(extraForcedContainerPaths, r.worktreeDirName),
      ],
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
  /**
   * RFC-187 §4-2 — cleanly-merged paths ALREADY materialized into canonical
   * despite this repo's conflict (per-path salvage; empty when the salvage
   * failed closed on an exotic conflict class or nothing clean differed).
   * The conflicted paths above remain withheld for the merge agent / human.
   */
  salvagedPaths: string[]
  /** RFC-193 K1：carried from IsoRepo so the resolve-flow snapshots (§6.2①/④)
   *  keep force-including the task's gitignored port files. */
  forcedRepoRelPaths: string[]
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
    const ours = await snapshotFullState(r.canonWorktreePath, {
      log,
      forceIncludePaths: r.forcedRepoRelPaths,
    })
    const merge = await mergeTreeInMemory(r.canonWorktreePath, {
      base: r.baseSnapshot,
      ours,
      theirs,
    })
    if (merge.conflicts.length > 0) {
      // RFC-187 §4-2 — per-path salvage: land the cleanly-merged paths NOW
      // (mergedTree with each conflicted path reverted to `ours`), withholding
      // ONLY the conflicted ones. Idempotent on replay: a re-run's `ours`
      // already contains the salvage, so the re-merge is clean on those paths
      // and the salvage tree equals ours (landedPaths=[] → materialize
      // skipped). buildSalvageTree fails closed (null) on directory-entry
      // conflict classes — that repo keeps today's withhold-everything shape.
      //
      // Codex impl-gate P1: ONLY the pure tree CONSTRUCTION is fail-open —
      // it has not touched canonical, so falling back to withhold-all is
      // truthful. materializeTree failures PROPAGATE (same as the clean-path
      // materialize below): it mutates canonical with no rollback, so a
      // swallowed mid-mutation error would leave canonical partially changed
      // while claiming the delta was withheld.
      let salvage: { tree: string; landedPaths: string[] } | null = null
      try {
        salvage = await buildSalvageTree(r.canonWorktreePath, {
          mergedTree: merge.mergedTree,
          ours,
          conflicts: merge.conflicts,
        })
      } catch (err) {
        log?.warn('salvage tree construction failed (falling back to withhold-all)', {
          worktreeDirName: r.worktreeDirName,
          error: err instanceof Error ? err.message : String(err),
        })
      }
      let salvagedPaths: string[] = []
      if (salvage !== null && salvage.landedPaths.length > 0) {
        const canonCurrentTree = await treeOf(r.canonWorktreePath, ours)
        await materializeTree(r.canonWorktreePath, {
          mergedTree: salvage.tree,
          canonCurrentTree,
          taskBaseHead: r.taskBaseHead,
        })
        salvagedPaths = salvage.landedPaths
      }
      conflicts.push({
        worktreeDirName: r.worktreeDirName,
        paths: merge.conflicts,
        mergedTree: merge.mergedTree,
        rawConflictOutput: merge.rawConflictOutput,
        base: r.baseSnapshot,
        canonWorktreePath: r.canonWorktreePath,
        taskBaseHead: r.taskBaseHead,
        salvagedPaths,
        forcedRepoRelPaths: r.forcedRepoRelPaths,
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

/**
 * RFC-130 §8.3 D9 (T14): before a fan-out shard is RE-RUN to REPLACE a prior merged
 * attempt, undo that prior delta INSIDE THE ISO WORKTREE — so the agent starts from
 * the pre-shard state and its output cleanly REPLACES (not superimposes on) the prior
 * output. Called AFTER createNodeIso (iso checked out from canon, which still carries
 * the prior delta) and BEFORE the agent runs.
 *
 * Why the ISO (not canon, not the post-run node tree):
 *  - Canon-safe / failure-safe (Codex impl-gate P1, AC-6): the iso is isolated, so a
 *    failed/canceled rerun leaves canon — and the prior merged delta — untouched.
 *    Canon changes only at merge-back, after success.
 *  - Correct for IDENTICAL re-output (Codex impl-gate P2): because we undo BEFORE the
 *    agent writes, a file the agent later RE-PRODUCES with identical bytes survives
 *    (it reappears as the agent's own write on the clean base), whereas a post-run
 *    tree-reverse could not tell "inherited prior file" from "agent re-wrote it" and
 *    would wrongly drop it.
 *  - Sibling-safe: the undo is a 3-way merge (base = prior node_tree, ours = iso now
 *    == canon-at-dispatch, theirs = prior base_snapshot); base→ours carries unrelated
 *    sibling deltas already in canon, base→theirs removes only the prior shard delta.
 *
 * At undo time the iso content EQUALS the prior node_tree (+ any sibling deltas), so
 * the 3-way merge is unambiguous. The merge base for the eventual merge-back stays the
 * iso's own base_snapshot (canon-at-dispatch, which HAS the prior delta) — that is what
 * lets the merge-back drop prior files the agent didn't reproduce.
 *
 * FAIL-OPEN: a pruned prior snapshot (unpinned after discardNodeIso) or a reverse
 * conflict returns false (no change) → pre-T14 superimposition, never destructive.
 * Returns true iff the iso worktree was rewritten. The caller MUST hold no canon lock
 * (this only touches the private iso worktree).
 */
export async function undoPriorShardDeltaInIso(
  isoWorktreePath: string,
  priorNodeCommit: string | undefined,
  priorBaseCommit: string | undefined,
  log?: Logger,
  /** RFC-193 K1：shard 重跑的 undo 快照同样携带该 repo 的必达清单。 */
  forcedRepoRelPaths?: string[],
): Promise<boolean> {
  if (priorNodeCommit === undefined || priorBaseCommit === undefined) return false
  if (!(await isGitWorkTree(isoWorktreePath))) return false
  if (
    !(await gitCommitExists(isoWorktreePath, priorNodeCommit)) ||
    !(await gitCommitExists(isoWorktreePath, priorBaseCommit))
  ) {
    log?.warn('T14 iso-undo: prior shard snapshot pruned — superimposition fallback', {
      priorNodeCommit,
      priorBaseCommit,
    })
    return false
  }
  const isoCurrent = await snapshotFullState(isoWorktreePath, {
    log,
    ...(forcedRepoRelPaths !== undefined ? { forceIncludePaths: forcedRepoRelPaths } : {}),
  })
  const rev = await mergeTreeInMemory(isoWorktreePath, {
    base: priorNodeCommit,
    ours: isoCurrent,
    theirs: priorBaseCommit,
  })
  if (rev.conflicts.length > 0) {
    log?.warn('T14 iso-undo: reverse-merge conflicted — superimposition fallback', {
      conflicts: rev.conflicts,
    })
    return false
  }
  const canonCurrentTree = await treeOf(isoWorktreePath, isoCurrent)
  const taskBaseHead = await headOf(isoWorktreePath)
  await materializeTree(isoWorktreePath, {
    mergedTree: rev.mergedTree,
    canonCurrentTree,
    taskBaseHead,
  })
  return true
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
    runAgent: (prompt: string, cwd: string, manifest: MergeConflictManifest) => Promise<void>
    log?: Logger
  },
): Promise<ResolveConflictOutcome> {
  const { containerPath, runAgent, log } = opts
  const repoGit = conflict.canonWorktreePath // shared-ODB git dir for worktree/commit ops
  // §6.2①: commit-tree the conflicted merged tree (worktree add needs a commit-ish),
  // then check it out detached — the working tree now carries the conflict markers.
  // The commit's PARENT is canonical-at-conflict (`ours`), NOT the node base: this
  // pins `ours-at-conflict` in git so a §6.3 RESUME can recover it via
  // `git rev-parse HEAD^` and use it as the re-merge base — WITHOUT a new DB column.
  // (Merging the human's resolution back against the node base instead would spuriously
  // re-conflict on the very region both sides touched.) We hold writeSem across §6.2,
  // so this `ours` equals the `ours` the materialize below re-snapshots.
  const oursAtConflict = await snapshotFullState(repoGit, {
    log,
    forceIncludePaths: conflict.forcedRepoRelPaths,
  })
  const cmt = await commitTree(repoGit, conflict.mergedTree, oursAtConflict, 'aw-conflict')
  const suffix = conflict.worktreeDirName === '' ? 'repo' : conflict.worktreeDirName
  const resolveIso = join(containerPath, `resolve-${suffix}`)
  // A stale resolve-iso (crash mid-resolution) would make `worktree add` fail;
  // remove it first (best-effort), then fail LOUD if the add still fails — running
  // the agent against a missing/stale worktree would mis-judge resolution (Codex P2).
  if (existsSync(resolveIso)) {
    await removeWorktree({ repoPath: repoGit, worktreePath: resolveIso, force: true }).catch(
      () => {},
    )
  }
  const add = await runGit(repoGit, ['worktree', 'add', '--detach', resolveIso, cmt])
  if (add.exitCode !== 0) {
    throw new Error(`merge-resolve setup failed: worktree add ${resolveIso}: ${add.stderr.trim()}`)
  }

  const manifest = parseConflictManifest(conflict.rawConflictOutput, conflict.worktreeDirName)
  // Fail closed on UNRECOGNIZED conflict classes (Codex P1): git may report a class
  // the classifier does not model (rename/rename, file/directory, …) — its path is
  // in `conflict.paths` but absent from `manifest`, so the agent is never told and
  // evaluateResolution can't judge it. Any such path makes the whole resolution
  // UNRESOLVED so we never materialize an unhandled conflict into canonical. (The
  // synthetic entry's `type` is only used for the detail message.)
  const manifestPaths = new Set(manifest.map((e) => e.path))
  const unhandled: MergeConflictEntry[] = conflict.paths
    .filter((p) => !manifestPaths.has(p))
    .map((p) => ({ worktreeDirName: conflict.worktreeDirName, path: p, type: 'content' }))
  let resolved = false
  let unresolved: MergeConflictEntry[] = [...manifest, ...unhandled]
  try {
    // §6.2②: run the merge agent in the resolve-iso (scheduler bypasses globalSem).
    await runAgent(buildMergeResolvePrompt({ manifest }), resolveIso, manifest)
    // §6.2③: framework self-check from observed worktree state.
    const states = gatherResolvedStates(resolveIso, manifest)
    const verdict = evaluateResolution(manifest, states)
    resolved = verdict.resolved && unhandled.length === 0
    unresolved = [...verdict.unresolved, ...unhandled]
    if (unhandled.length > 0) {
      log?.warn('merge-back: unrecognized conflict class(es) → fail closed (unresolved)', {
        resolveIso,
        unhandled: unhandled.map((e) => e.path),
      })
    }
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
  const resolvedTree = await snapshotFullState(resolveIso, {
    log,
    forceIncludePaths: conflict.forcedRepoRelPaths,
  })
  const ours = await snapshotFullState(conflict.canonWorktreePath, {
    log,
    forceIncludePaths: conflict.forcedRepoRelPaths,
  })
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

/**
 * RFC-130 §6.3 resume — complete a conflict-human node whose human has resolved
 * the conflict in the preserved resolve-iso worktree(s). Per repo (multi-repo
 * independent): re-derive the conflict manifest against CURRENT canonical, verify
 * the human left no unresolved path (§6.2③ per-path self-check, D6 — NOT the
 * agent's self-report), then re-merge the human's resolution against the current
 * canonical (siblings may have advanced it) and materialize on a clean re-merge.
 * A repo whose resolve-iso is missing / still-conflicting / has residual markers
 * stays unresolved → the caller keeps it parked (awaiting_human another round).
 *
 * `nodeTrees` maps worktreeDirName → the node's persisted final tree (iso_node_tree).
 */
export async function completeHumanResolvedConflict(
  handle: IsoHandle,
  nodeTrees: Record<string, string>,
  log?: Logger,
): Promise<{ allResolved: boolean; unresolvedRepos: string[] }> {
  if (handle.passthrough) return { allResolved: true, unresolvedRepos: [] }
  const unresolved: string[] = []
  for (const r of handle.repos) {
    const nodeTree = nodeTrees[r.worktreeDirName]
    const suffix = r.worktreeDirName === '' ? 'repo' : r.worktreeDirName
    const resolveIso = join(handle.containerPath, `resolve-${suffix}`)
    // No recorded delta for this repo — FAIL CLOSED (Codex impl-gate P2):
    // every repo of a real run gets a snapshot commit (even a no-op delta),
    // so a missing iso_node_tree entry at conflict-human resume means the
    // recovery data was lost, not that the repo had nothing to merge.
    // Treating it as resolved would advance merge_state without ever merging
    // a final tree.
    if (nodeTree === undefined) {
      unresolved.push(r.worktreeDirName)
      continue
    }
    // RFC-187 (design-gate P1-9 precondition) — a repo WITHOUT a resolve-iso is
    // NOT automatically unresolved: in a multi-repo conflict, the repos that
    // merged clean at conflict time materialized immediately and never got a
    // resolve-iso — the old unconditional `unresolved.push` here wedged such a
    // task parked FOREVER even after the human resolved the one真正 conflicted
    // repo. Re-probe against CURRENT canonical: clean ⇒ (re-)materialize — a
    // byte-identical no-op when the delta already landed — and count it
    // resolved; a genuine conflict (resolve-iso GC'd / deleted by hand) stays
    // parked, exactly the old behavior for the truly-conflicted repo.
    if (!existsSync(resolveIso) || !(await isGitWorkTree(resolveIso))) {
      const ours = await snapshotFullState(r.canonWorktreePath, {
        log,
        forceIncludePaths: r.forcedRepoRelPaths,
      })
      const probe = await mergeTreeInMemory(r.canonWorktreePath, {
        base: r.baseSnapshot,
        ours,
        theirs: nodeTree,
      })
      if (probe.conflicts.length > 0) {
        unresolved.push(r.worktreeDirName)
        continue
      }
      const canonCurrentTree = await treeOf(r.canonWorktreePath, ours)
      await materializeTree(r.canonWorktreePath, {
        mergedTree: probe.mergedTree,
        canonCurrentTree,
        taskBaseHead: r.taskBaseHead,
      })
      continue
    }
    // ours-at-conflict = the resolve-iso commit's PARENT — pinned in §6.2① exactly
    // so resume can recover it here (no DB column) as the correct re-merge base.
    const oursAtConflict = (await runGit(resolveIso, ['rev-parse', 'HEAD^'])).stdout.trim()
    // §6.2③ — reconstruct the ORIGINAL conflict (node base vs node_tree over
    // ours-at-conflict) and confirm the human decided EVERY conflicted path (content:
    // no residual markers; silent classes: a definite keep/delete/side; unrecognized
    // class → fail closed). Never trust the agent's word (D6).
    const probe = await mergeTreeInMemory(r.canonWorktreePath, {
      base: r.baseSnapshot,
      ours: oursAtConflict,
      theirs: nodeTree,
    })
    const manifest = parseConflictManifest(probe.rawConflictOutput, r.worktreeDirName)
    const states = gatherResolvedStates(resolveIso, manifest)
    const manifestPaths = new Set(manifest.map((e) => e.path))
    const unhandled = probe.conflicts.filter((p) => !manifestPaths.has(p))
    if (!evaluateResolution(manifest, states).resolved || unhandled.length > 0) {
      unresolved.push(r.worktreeDirName)
      continue
    }
    // §6.3 — re-merge the human's resolution against the CURRENT canonical, based at
    // ours-at-conflict so ONLY a post-conflict sibling advance INTO the same region
    // re-conflicts (not the region the human just reconciled).
    const resolvedTree = await snapshotFullState(resolveIso, {
      log,
      forceIncludePaths: r.forcedRepoRelPaths,
    })
    const ours = await snapshotFullState(r.canonWorktreePath, {
      log,
      forceIncludePaths: r.forcedRepoRelPaths,
    })
    const merge = await mergeTreeInMemory(r.canonWorktreePath, {
      base: oursAtConflict,
      ours,
      theirs: resolvedTree,
    })
    if (merge.conflicts.length > 0) {
      unresolved.push(r.worktreeDirName)
      continue
    }
    const canonCurrentTree = await treeOf(r.canonWorktreePath, ours)
    await materializeTree(r.canonWorktreePath, {
      mergedTree: merge.mergedTree,
      canonCurrentTree,
      taskBaseHead: r.taskBaseHead,
    })
    // resolved — discard the resolve-iso.
    await removeWorktree({
      repoPath: r.canonWorktreePath,
      worktreePath: resolveIso,
      force: true,
    }).catch((err) => {
      log?.warn('resolve-iso remove failed after human resolution (leaving for GC)', {
        resolveIso,
        error: err instanceof Error ? err.message : String(err),
      })
    })
  }
  return { allResolved: unresolved.length === 0, unresolvedRepos: unresolved }
}
