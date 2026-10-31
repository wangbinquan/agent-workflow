// Neutral values shared by native workspace adapters and the execution kernel.

export interface IsoRepo {
  /** Source repo (for `git worktree add/remove` + ref ops). */
  repoPath: string
  /** Canonical worktree — snapshot source + merge-back target. */
  canonWorktreePath: string
  /** The isolated worktree — the node's opencode cwd. */
  isoWorktreePath: string
  /** '' for single-repo; the per-repo sub-dir name for multi-repo. */
  mountPath: string
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
  /**
   * RFC-210: submodule path → its HEAD when this iso was created. The merge base
   * for the per-submodule three-way merge at merge-back.
   *
   * Carried ON THE HANDLE rather than looked up on demand because this module is
   * git-only and never touches the DB — and merge-back, which is where the value
   * is needed, runs long after the iso worktree that could have been probed for
   * it. Empty for repos without submodules (the common case) and for passthrough.
   */
  subBases: Record<string, string>
  /**
   * RFC-210: shared object pool backing each submodule, keyed by submodule path.
   *
   * Per SUBMODULE, not per repo. Every submodule owns a separate module dir and
   * therefore a separate pool; a repo-level `poolDir` (what this used to be,
   * recording whichever submodule happened to be first) sent every subsequent
   * submodule's objects into a foreign pool, and merge-back then died on
   * `fatal: unable to read tree` for anything past the first one — i.e. any repo
   * with two submodules, and every nested case, which is the headline scenario.
   *
   * A path missing from this map is running degraded and must be skipped, not
   * silently pointed at some other submodule's pool: path-mode repos
   * deliberately get none (D11 — the host is the USER'S repo, and a pool there
   * accumulates platform objects/refs/commits that can never be cleaned up), and
   * mock harnesses have no git host at all.
   */
  poolDirs: Record<string, string>
  /**
   * RFC-210: submodule paths whose three-way merge conflicted and are still
   * unresolved. Written at merge-back (the conflict set is not knowable at iso
   * creation) and read back on resume.
   *
   * Non-empty MUST fail the human-resolve completion closed. A conflicted
   * submodule produces no parent-level resolve-iso — the gitlink is one tree
   * entry and the disagreement lives inside it — so the "no resolve-iso ⇒
   * re-probe the parent" path below would find the parent clean and declare the
   * whole repo resolved while the submodule conflict is still open.
   */
  pendingSubResolves: string[]
}

export interface IsoHandle {
  taskId: string
  /**
   * **物理 iso 键**——路径（`isoWorktreePathFor`）、pin ref（`isoRefName`）、池 ref
   * （`poolRefName`）与 effect 的 `resourceKeys` 都按它派生。
   *
   * ⚠️ 它**不一定等于 node_runs 的行 id**：RFC-210 round 6 P2 起，同一棵 iso 会跨
   * 重试复用原始行的键（D17），而 RFC-356 的代际自愈会在残留清不掉时把它推进成
   * `{原键}-2`。要 DB 身份请用 `dbNodeRunId`。
   */
  nodeRunId: string
  /**
   * **DB 身份**——真实存在的 `node_runs` 行 id。
   *
   * RFC-356 P0-1：凡是要落 effect 账本的地方（`createLocalEffectAttemptObserver`）
   * 必须用它。observer 的 `beforeAct()` 会 `readLineage({taskId, intentId, nodeRunId})`，
   * 而 sqlite / postgresql 两个实现都在查不到行时返回 null ⇒ 抛
   * `task-continuation-stale`；而 `discardNodeIso` 的 `beforeAct()` 在 `try` **之外**，
   * 调用点 `schedulerAssembly.ts` 的 `await spec.discardIso(handle)` 又是**裸 await**
   * ——喂给它一个合成键，异常会直接穿出 `runAssembly`，把节点打成
   * `scheduler-node-threw`。那会是一个比 issue #13 更早触发的 wedge。
   */
  dbNodeRunId: string
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

export interface CanonRepo {
  repoPath: string
  worktreePath: string
  mountPath: string
  baseBranch: string
}

export interface MergeBackConflict {
  mountPath: string
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

export interface DiscardLock {
  run<T>(fn: () => Promise<T>): Promise<T>
}
