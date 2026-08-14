// P-4-09: hourly worktree GC. Scans tasks whose status is terminal and
// applies the worktreeAutoGc thresholds:
//   - olderThanDays: skip if finishedAt is younger than threshold
//   - onlyMerged:    skip if the task branch is not merged into base
//                    (multi-repo: EVERY task_repos row must be merged — RFC-165
//                    D3 closed the "top-level mirror only" blindspot; scratch
//                    spaces ignore onlyMerged, age is their only threshold)
//
// RFC-165 (F8/R3-1): deletion is a TWO-PHASE tombstone, not check→delete —
//   1. CLAIM: conditional UPDATE stamps `workspace_pruning_at` with NULL
//      `workspace_prune_cause` (wins only if the task is still terminal and
//      unclaimed; a stale generic claim past PRUNING_LEASE_MS may be
//      re-claimed so a crashed delete retries).
//   2. DELETE the directory (multi-repo: per task_repos row, then the parent
//      container; scratch: plain recursive rm — the workspace IS the repo, no
//      `git worktree remove` / snapshot-ref dance applies).
//   3. FINALIZE: stamp `workspace_pruned_at` only after the delete succeeded.
// Every revive path (resume / retry / sync-workflow / lifecycle repair / boot
// auto-resume) CAS-es task status with `pruning IS NULL AND pruned IS NULL`
// (services/lifecycle.ts setTaskStatus revival gate), so the
// claim↔revive race has exactly one winner.
//
// Tasks themselves are NOT deleted — the row stays so users can see history;
// only the workspace directory on disk is removed. `space_kind='internal'`
// tasks (fusion) are NEVER candidates: their dirs feed the approval flow
// (RFC-165 R3-4).

import { and, eq, inArray, isNotNull, isNull, lt, ne, or } from 'drizzle-orm'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { TERMINAL_TASK_STATUSES, isTerminalTaskStatus } from '@agent-workflow/shared'
import type { Config, TaskStatus } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { nodeRuns, taskRepos, tasks } from '@/db/schema'
import { deleteSnapshotRefs, removeWorktree, runGit } from '@/util/git'
import { invalidateCallGraphIndex } from '@/services/structuralDiff/callGraph/expandService'
import { createLogger } from '@/util/log'
import { DAEMON_CADENCE } from './daemonCadence'

const log = createLogger('gc')

const HOUR_MS = 60 * 60 * 1000

/** RFC-165 (R3-1): a pruning claim older than this is considered crashed and
 *  may be re-claimed by a later GC tick to finish the delete. */
export const PRUNING_LEASE_MS = 30 * 60 * 1000

/** RFC-165 (F9): scratch-orphan dirs younger than this are never reaped even
 *  without a lease — belt-and-suspenders for a daemon that restarted mid-
 *  materialize (the in-process lease map died with the old process). */
export const SCRATCH_ORPHAN_MIN_AGE_MS = 24 * HOUR_MS

/**
 * RFC-165 (F9): in-process lease over spaces being materialized. startTask
 * registers BEFORE mkdir and releases in its finally AFTER the task row
 * committed (or the failure cleanup ran). The scratch orphan scan skips any
 * dir with an active lease — a slow materialize→insert window must not get
 * its workspace reaped from under it.
 */
export const materializingSpaces = new Map<string, { dir: string; startedAt: number }>()

// flag-audit W0（dedup-audit `task-terminal-status-set` 同项）：终态集合改引
// shared 单源——此前是无 satisfies 守卫的裸字面量拷贝，TASK_STATUS 扩枚举时
// GC 会静默漏收。

export interface GcRunResult {
  scanned: number
  removed: string[]
  skipped: number
}

export type ClaimedWorkspacePruneOutcome =
  | { kind: 'removed' }
  | { kind: 'finalized-missing' }
  | { kind: 'already-pruned' }
  | { kind: 'not-claimed' }
  | { kind: 'busy' }
  | { kind: 'failed'; error: string }

/** One daemon can wake the same durable claim from the lifecycle effect,
 * driver finally, and GC ticker. The DB stamp is the crash-safe inter-process
 * claim; this set closes the much shorter same-process duplicate-delete race. */
const workspacePrunesInFlight = new Set<string>()

/**
 * Phase-1 claim (RFC-165 F8): stamp `workspace_pruning_at` iff the task is
 * still terminal, not yet pruned, and has no source-specific claim provenance.
 * A NULL-cause claim may be re-taken past the lease. RFC-300's
 * `webhook-terminal` claims are resumed only by its dedicated recovery path.
 * Returns whether THIS caller owns the delete.
 */
async function claimWorkspacePrune(db: DbClient, taskId: string, now: number): Promise<boolean> {
  const updated = await db
    .update(tasks)
    .set({ workspacePruningAt: now })
    .where(
      and(
        eq(tasks.id, taskId),
        inArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
        isNull(tasks.workspacePruneCause),
        isNull(tasks.workspacePrunedAt),
        or(isNull(tasks.workspacePruningAt), lt(tasks.workspacePruningAt, now - PRUNING_LEASE_MS)),
      ),
    )
    .returning({ id: tasks.id })
  return updated.length === 1
}

/**
 * RFC-300/RFC-165 shared phase-2/3 primitive. The caller must already own a
 * durable `workspace_pruning_at` claim and prove that no task driver is using
 * the workspace. It re-reads the row, dispatches by the persisted space shape,
 * and stamps `workspace_pruned_at` only after physical deletion succeeds.
 *
 * A missing directory is a successful idempotent replay (daemon crashed after
 * delete but before finalize). Failures keep the claim so boot/ticker recovery
 * can resume after the lease; task history is never deleted.
 */
export async function finishClaimedWorkspacePrune(
  db: DbClient,
  taskId: string,
  now: number = Date.now(),
): Promise<ClaimedWorkspacePruneOutcome> {
  if (workspacePrunesInFlight.has(taskId)) return { kind: 'busy' }
  workspacePrunesInFlight.add(taskId)
  try {
    const t = (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]
    if (t === undefined || t.workspacePrunedAt !== null) return { kind: 'already-pruned' }
    if (t.workspacePruningAt === null || !isTerminalTaskStatus(t.status as TaskStatus)) {
      return { kind: 'not-claimed' }
    }
    const claimStamp = t.workspacePruningAt
    const workspaceExisted = t.worktreePath !== '' && existsSync(t.worktreePath)

    if (t.spaceKind === 'scratch') {
      if (workspaceExisted) {
        // Scratch owns its entire fresh Git repository; it has no linked
        // worktree registration or source-repository snapshot refs.
        rmSync(t.worktreePath, { recursive: true, force: true })
        invalidateCallGraphIndex(t.worktreePath)
      }
    } else if (t.repoCount > 1) {
      // Multi-repo workspaces remove each registered linked worktree before
      // the parent container. Snapshot refs are always replayed, even when a
      // crash already removed the directory but happened before ref cleanup.
      const rows = await db.select().from(taskRepos).where(eq(taskRepos.taskId, t.id))
      for (const r of rows) {
        if (r.worktreePath !== '' && existsSync(r.worktreePath)) {
          await removeWorktree({
            repoPath: r.repoPath,
            worktreePath: r.worktreePath,
            force: true,
          })
          invalidateCallGraphIndex(r.worktreePath)
        }
        await deleteSnapshotRefs(r.repoPath, t.id)
      }
      if (workspaceExisted) {
        rmSync(t.worktreePath, { recursive: true, force: true })
      }
    } else {
      if (workspaceExisted) {
        await removeWorktree({ repoPath: t.repoPath, worktreePath: t.worktreePath, force: true })
        invalidateCallGraphIndex(t.worktreePath)
      }
      // This must run when the worktree path is already absent too: that is
      // the crash window between `git worktree remove` and ref deletion.
      await deleteSnapshotRefs(t.repoPath, t.id)
    }

    const finalized = await db
      .update(tasks)
      .set({ workspacePrunedAt: now })
      .where(
        and(
          eq(tasks.id, taskId),
          eq(tasks.workspacePruningAt, claimStamp),
          isNull(tasks.workspacePrunedAt),
        ),
      )
      .returning({ id: tasks.id })
    if (finalized.length !== 1) return { kind: 'busy' }
    return workspaceExisted ? { kind: 'removed' } : { kind: 'finalized-missing' }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.warn('workspace prune failed (claim kept; lease expiry retries)', {
      taskId,
      error,
    })
    return { kind: 'failed', error }
  } finally {
    workspacePrunesInFlight.delete(taskId)
  }
}

/** Low-latency RFC-300 finalizer used by the terminal post-commit effect and
 * task-driver release. It refuses every non-Webhook/non-owning/non-target row
 * before entering the generic RFC-165 delete primitive. */
export async function finishClaimedWebhookWorkspacePrune(
  db: DbClient,
  taskId: string,
  now: number = Date.now(),
): Promise<ClaimedWorkspacePruneOutcome> {
  try {
    const eligible = (
      await db
        .select({ id: tasks.id })
        .from(tasks)
        .where(
          and(
            eq(tasks.id, taskId),
            inArray(tasks.status, ['done', 'canceled']),
            isNotNull(tasks.webhookTriggerId),
            inArray(tasks.spaceKind, ['remote', 'scratch']),
            isNotNull(tasks.workspacePruningAt),
            eq(tasks.workspacePruneCause, 'webhook-terminal'),
            isNull(tasks.workspacePrunedAt),
          ),
        )
        .limit(1)
    )[0]
    if (eligible === undefined) return { kind: 'not-claimed' }
    return await finishClaimedWorkspacePrune(db, taskId, now)
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    log.warn('webhook workspace prune eligibility check failed (claim kept)', {
      taskId,
      error,
    })
    return { kind: 'failed', error }
  }
}

export interface ClaimedWebhookWorkspacePruneResult {
  scanned: number
  removed: string[]
  skipped: number
  failed: string[]
}

/** Resume only claims that were created by RFC-300's exact lifecycle policy.
 * This never discovers unclaimed historical terminal rows, so turning the
 * setting on has no retroactive sweep. The explicit `webhook-terminal` cause
 * prevents a crashed RFC-165/iso GC stamp from being mistaken for user consent.
 * `staleOnly` is used by the periodic ticker; boot owns the singleton daemon
 * lock and may take over every claim. */
export async function runClaimedWebhookWorkspacePrunes(
  db: DbClient,
  options: {
    isTaskActive: (taskId: string) => boolean
    now?: number
    staleOnly?: boolean
  },
): Promise<ClaimedWebhookWorkspacePruneResult> {
  const now = options.now ?? Date.now()
  const rows = await db
    .select({
      id: tasks.id,
      workspacePruningAt: tasks.workspacePruningAt,
    })
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, ['done', 'canceled']),
        isNotNull(tasks.webhookTriggerId),
        inArray(tasks.spaceKind, ['remote', 'scratch']),
        isNotNull(tasks.workspacePruningAt),
        eq(tasks.workspacePruneCause, 'webhook-terminal'),
        isNull(tasks.workspacePrunedAt),
      ),
    )
  const result: ClaimedWebhookWorkspacePruneResult = {
    scanned: rows.length,
    removed: [],
    skipped: 0,
    failed: [],
  }
  for (const row of rows) {
    if (workspacePrunesInFlight.has(row.id)) {
      result.skipped += 1
      continue
    }
    if (options.isTaskActive(row.id)) {
      result.skipped += 1
      continue
    }
    const claimStamp = row.workspacePruningAt
    if (claimStamp === null) {
      result.skipped += 1
      continue
    }
    if (options.staleOnly === true && claimStamp >= now - PRUNING_LEASE_MS) {
      result.skipped += 1
      continue
    }

    // Take ownership of the persisted claim. Exact old-stamp CAS prevents a
    // concurrent boot/ticker/finalizer from believing it owns the same delete.
    const claimed = await db
      .update(tasks)
      .set({ workspacePruningAt: now })
      .where(
        and(
          eq(tasks.id, row.id),
          eq(tasks.workspacePruningAt, claimStamp),
          eq(tasks.workspacePruneCause, 'webhook-terminal'),
          isNull(tasks.workspacePrunedAt),
        ),
      )
      .returning({ id: tasks.id })
    if (claimed.length !== 1) {
      result.skipped += 1
      continue
    }
    const outcome = await finishClaimedWorkspacePrune(db, row.id, now)
    if (outcome.kind === 'removed' || outcome.kind === 'finalized-missing') {
      result.removed.push(row.id)
    } else if (outcome.kind === 'failed') {
      result.failed.push(row.id)
    } else {
      result.skipped += 1
    }
  }
  return result
}

export async function runWorktreeGc(
  db: DbClient,
  config: Pick<Config, 'worktreeAutoGc'>,
  now: number = Date.now(),
  isTaskActive: (taskId: string) => boolean = () => false,
): Promise<GcRunResult> {
  const gc = config.worktreeAutoGc
  if (!gc.enabled) return { scanned: 0, removed: [], skipped: 0 }

  const minAgeMs =
    typeof gc.olderThanDays === 'number' && gc.olderThanDays > 0
      ? gc.olderThanDays * 24 * HOUR_MS
      : 0
  const onlyMerged = gc.onlyMerged === true

  const candidates = await db
    .select()
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
        // RFC-165 (R3-4): internal (fusion) workspaces feed the approval flow
        // and are never GC candidates. Already-pruned rows have nothing to do.
        // RFC-243 §4.4: 'inherited' children do not own their workspace (it is
        // the parent's call-node iso) — nothing for THIS gc to prune.
        ne(tasks.spaceKind, 'internal'),
        ne(tasks.spaceKind, 'inherited'),
        // A non-NULL cause belongs to a source-specific cleanup protocol.
        // Generic GC must not even enter its legacy "directory already
        // missing" healing branch for those rows: a Webhook-terminal replay
        // may still need to delete snapshot refs before it may finalize the
        // tombstone.
        isNull(tasks.workspacePruneCause),
        isNull(tasks.workspacePrunedAt),
      ),
    )

  const result: GcRunResult = { scanned: candidates.length, removed: [], skipped: 0 }
  for (const t of candidates) {
    if (isTaskActive(t.id)) {
      result.skipped += 1
      continue
    }
    if (t.worktreePath === '' || !existsSync(t.worktreePath)) {
      // Legacy pre-tombstone GC (or manual rm) already took the dir — heal the
      // row forward so revive paths 410 instead of resurrecting a ghost
      // (R3-2-r4; boot reconcile does the same sweep once at startup).
      // Deliberately does NOT require workspacePruningAt to be null
      // (implementation-gate P2 fix): a daemon that died between deleting the
      // dir (phase 2) and stamping workspacePrunedAt (phase 3) leaves a
      // claimed row whose dir is gone — finalizing it here IS the crash
      // recovery; racing a live phase-3 stamp is idempotent (same tombstone).
      if (t.worktreePath !== '') {
        await db
          .update(tasks)
          .set({ workspacePrunedAt: now })
          .where(and(eq(tasks.id, t.id), isNull(tasks.workspacePrunedAt)))
      }
      result.skipped += 1
      continue
    }
    if (minAgeMs > 0) {
      const finished = t.finishedAt ?? t.startedAt
      if (now - finished < minAgeMs) {
        result.skipped += 1
        continue
      }
    }
    // RFC-165 (D3): merged-ness by space kind. Scratch has no base to merge
    // into — age is its only threshold. Multi-repo requires EVERY task_repos
    // row merged (checking only the repo-0 mirror could delete an unmerged
    // sibling; checking only the container path made multi-repo永 skip).
    if (onlyMerged && t.spaceKind !== 'scratch') {
      if (t.repoCount > 1) {
        const rows = await db.select().from(taskRepos).where(eq(taskRepos.taskId, t.id))
        let allMerged = rows.length > 0
        for (const r of rows) {
          if (!(await isMerged(r.worktreePath, r.baseBranch, r.branch))) {
            allMerged = false
            break
          }
        }
        if (!allMerged) {
          result.skipped += 1
          continue
        }
      } else if (!(await isMerged(t.worktreePath, t.baseBranch, t.branch))) {
        result.skipped += 1
        continue
      }
    }
    // Phase 1 — claim. Losing means a concurrent claimer owns it, the task
    // was revived (status left the terminal set), or it got pruned meanwhile.
    if (!(await claimWorkspacePrune(db, t.id, now))) {
      result.skipped += 1
      continue
    }
    const outcome = await finishClaimedWorkspacePrune(db, t.id, now)
    if (outcome.kind === 'removed' || outcome.kind === 'finalized-missing') {
      result.removed.push(t.id)
    } else {
      result.skipped += 1
    }
  }
  return result
}

async function isMerged(
  worktreePath: string,
  baseBranch: string,
  branch: string,
): Promise<boolean> {
  try {
    const r = await runGit(worktreePath, ['merge-base', '--is-ancestor', branch, baseBranch])
    return r.exitCode === 0
  } catch {
    return false
  }
}

/**
 * RFC-165 (R3-2-r4): one-shot boot reconcile — terminal tasks whose workspace
 * disappeared before the tombstone columns existed (old GC deleted dirs
 * without stamping anything) get `workspace_pruned_at` backfilled so every
 * revive path 410s deterministically instead of resurrecting a ghost.
 * Runs after migrations and BEFORE the HTTP server starts serving.
 */
export async function reconcileLegacyPrunedWorkspaces(db: DbClient): Promise<number> {
  const rows = await db
    .select({ id: tasks.id, worktreePath: tasks.worktreePath })
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
        isNull(tasks.workspacePrunedAt),
        isNull(tasks.workspacePruningAt),
        ne(tasks.worktreePath, ''),
      ),
    )
  const now = Date.now()
  let healed = 0
  for (const r of rows) {
    if (existsSync(r.worktreePath)) continue
    await db
      .update(tasks)
      .set({ workspacePrunedAt: now })
      .where(
        and(eq(tasks.id, r.id), isNull(tasks.workspacePruningAt), isNull(tasks.workspacePrunedAt)),
      )
    healed += 1
  }
  if (healed > 0) log.info('reconciled legacy pruned workspaces', { healed })
  return healed
}

/**
 * RFC-165 (F9): reap scratch dirs that no task row anchors — a crash between
 * materialize and INSERT leaves one behind. Two guards keep live launches
 * safe: the in-process `materializingSpaces` lease (registered before mkdir)
 * and a 24h age floor (covers a restart that wiped the lease map).
 */
export async function runScratchOrphanGc(
  db: DbClient,
  appHome: string,
  now: number = Date.now(),
): Promise<{ scanned: number; removed: string[] }> {
  const scratchRoot = join(appHome, 'scratch')
  if (!existsSync(scratchRoot)) return { scanned: 0, removed: [] }
  const dirs = readdirSync(scratchRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
  if (dirs.length === 0) return { scanned: 0, removed: [] }
  const rows = await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, dirs))
  const anchored = new Set(rows.map((r) => r.id))
  const leased = new Set([...materializingSpaces.keys()])
  const removed: string[] = []
  for (const name of dirs) {
    if (anchored.has(name) || leased.has(name)) continue
    const full = join(scratchRoot, name)
    try {
      const age = now - statSync(full).mtimeMs
      if (age < SCRATCH_ORPHAN_MIN_AGE_MS) continue
      rmSync(full, { recursive: true, force: true })
      removed.push(name)
    } catch (err) {
      log.warn('scratch orphan reap failed', {
        dir: name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { scanned: dirs.length, removed }
}

/**
 * RFC-222 (§6.4) — GC orphan TASK worktrees. Task worktrees live at
 * `worktrees/{repo-slug}/{task-id}`. When a task is hard-deleted (or the daemon
 * crashes between the delete transaction and the best-effort disk cleanup), the
 * worktree dir has no anchoring tasks row and becomes a reapable orphan. This is
 * the backstop that makes "delete row first, clean disk best-effort" safe
 * (Codex round-1 P1-8: runWorktreeGc only visits EXISTING task rows, so it never
 * reaped these). Mirrors runScratchOrphanGc, descending one extra repo-slug
 * level, and rmSync's the dir (the iso-GC precedent for git-worktree dirs).
 */
/**
 * RFC-287（三轮门并发面 Codex P1）—— 回收**半成品镜像目录** `repos/<hash>-<slug>.partial-<ULID>/`。
 *
 * 这些目录由 `gitRepoCache.ts` 的冷克隆产出：先克隆到 `.partial-<ULID>`，成功后再
 * 原子 rename 到 canonical 名。正常失败路径会删掉它，但**进程被 SIGKILL 时不会**
 * ——controller、timeout 与 finally 一起消失，目录就留在磁盘上。
 *
 * 关键事实：全仓对这个命名**只有一个生产者、零消费者**（`gitRepoCache.ts:820` 那一处
 * `join(cacheRoot, ...partial-${ulid()})`），此前没有任何扫描会碰它们。本 session 里
 * 就实测到真实 home 的 `repos/` 下攒了 13 个 `…-nope.partial-*`——那还只是测试留下的。
 *
 * 判据只能是**年龄**：目录名里没有 taskId 可锚，而一次冷克隆本身可以跑很久，按
 * 「有没有人在用」判会误删正在写入的那个。沿用 `SCRATCH_ORPHAN_MIN_AGE_MS`（24h）
 * ——远大于任何合理的克隆时长（`gitCloneTimeoutMs` 默认远小于它），所以到龄的一定是
 * 死掉的进程留下的。
 */
/**
 * 半成品目录的**结构化**判据：`<hash>-<slug>.partial-<ULID>`，ULID 锚在结尾。
 *
 * ⚠️ 不能用 `name.includes('.partial-')`（四轮门 Codex 实测的数据丢失级缺陷）：
 * `cacheSlug` 刻意保留点与横线（`shared/git-url.ts` 的 `[^A-Za-z0-9._-]`），所以
 * 一个名字里本来就带 `.partial-` 的**合法**仓库（`https://host/org/foo.partial-bar.git`）
 * 的 canonical 目录就叫 `<hash>-foo.partial-bar` —— 宽松判据会把这个**正在用的镜像**
 * 整个删掉，而 `cached_repos.local_path` 还指着它，连既存运行任务的工作树都跟着失效。
 * ULID 是 26 位 Crockford base32（无 I/L/O/U），锚定结尾即可把两者分开。
 */
const PARTIAL_CLONE_DIR = /\.partial-[0-9A-HJKMNP-TV-Z]{26}$/

export async function runPartialCloneGc(
  appHome: string,
  now: number = Date.now(),
  /**
   * 配置的克隆超时。年龄判据必须**大于**它：`gitCloneTimeoutMs` 无上限（schema 只要求
   * 正整数），运维完全可以给慢远端配 48h，那时一个**仍在写**的 partial 会跨过 24h
   * ——而顶层目录的 mtime 不随 `.git/objects/pack` 里的写入更新，看上去就是「陈旧」。
   * 删掉它会让那次克隆失败，连收尾的 rename 都找不到源目录（四轮门 Codex 实测）。
   */
  cloneTimeoutMs?: number,
): Promise<{ scanned: number; removed: string[] }> {
  const cacheRoot = join(appHome, 'repos')
  if (!existsSync(cacheRoot)) return { scanned: 0, removed: [] }
  const minAgeMs = Math.max(SCRATCH_ORPHAN_MIN_AGE_MS, 2 * (cloneTimeoutMs ?? 0))
  const removed: string[] = []
  let scanned = 0
  for (const e of readdirSync(cacheRoot, { withFileTypes: true })) {
    if (!e.isDirectory() || !PARTIAL_CLONE_DIR.test(e.name)) continue
    scanned += 1
    const dir = join(cacheRoot, e.name)
    try {
      if (now - statSync(dir).mtimeMs < minAgeMs) continue
      // `await rm` 而不是同步 `rmSync`：一个接近完整镜像体量的目录同步递归删除会把
      // Bun 的**单事件循环**冻住——取消请求、deadline timer、普通 API 全部排在它后面
      // （同文件的正常镜像删除早就因此改用 `await rm`，见 gitRepoCache 的删除路径；
      // 新 GC 一度把同一形态又引了回来）。
      await rm(dir, { recursive: true, force: true })
      removed.push(e.name)
    } catch (err) {
      log.warn('failed to remove an orphaned partial clone dir', {
        dir,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  if (removed.length > 0) log.info('reclaimed orphaned partial clone dirs', { removed })
  return { scanned, removed }
}

export async function runWorktreeOrphanGc(
  db: DbClient,
  appHome: string,
  now: number = Date.now(),
): Promise<{ scanned: number; removed: string[] }> {
  const worktreesRoot = join(appHome, 'worktrees')
  if (!existsSync(worktreesRoot)) return { scanned: 0, removed: [] }
  // Collect every {repo-slug}/{task-id} leaf and the task ids under it.
  const leaves: Array<{ taskId: string; path: string }> = []
  for (const slug of readdirSync(worktreesRoot, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue
    const slugDir = join(worktreesRoot, slug.name)
    for (const t of readdirSync(slugDir, { withFileTypes: true })) {
      if (t.isDirectory()) leaves.push({ taskId: t.name, path: join(slugDir, t.name) })
    }
  }
  if (leaves.length === 0) return { scanned: 0, removed: [] }
  const ids = [...new Set(leaves.map((l) => l.taskId))]
  const rows = await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, ids))
  const anchored = new Set(rows.map((r) => r.id))
  const leased = new Set([...materializingSpaces.keys()])
  const removed: string[] = []
  for (const leaf of leaves) {
    if (anchored.has(leaf.taskId) || leased.has(leaf.taskId)) continue
    try {
      const age = now - statSync(leaf.path).mtimeMs
      if (age < SCRATCH_ORPHAN_MIN_AGE_MS) continue
      rmSync(leaf.path, { recursive: true, force: true })
      removed.push(leaf.taskId)
    } catch (err) {
      log.warn('worktree orphan reap failed', {
        dir: leaf.path,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { scanned: leaves.length, removed }
}

/**
 * RFC-130 PR-E — GC orphan iso worktrees. A node run normally `discardNodeIso`s its
 * iso worktree on completion, but a crash between create + discard, a kept
 * conflict-human resolve-iso, or a daemon restart can leave `{appHome}/iso/{taskId}/*`
 * behind. For every TERMINAL task (and any iso dir with no task row — a deleted task),
 * ALL its iso worktrees are orphans (no active node run), so we remove the container
 * dir and prune the now-dangling `git worktree` registrations from the task's repo.
 * ACTIVE tasks are skipped (their iso worktrees may be in flight).
 *
 * RFC-165 (D1): deleting a row-anchored container now rides the SAME per-task
 * pruning claim as the workspace GC — a transient stamp on
 * `workspace_pruning_at` blocks every revive CAS for the few ms the delete
 * takes, closing the "query snapshot → task revived → new in-flight iso →
 * stale GC deletes it" race. Tasks whose workspace is already tombstoned
 * (`workspace_pruned_at` set) delete freely — no revival is possible.
 */
/** RFC-243 §4.4 — does any call row of `taskId` reference a child task that is
 *  non-terminal or interrupted (revivable)? Such a child's canonical workspace
 *  lives inside this task's iso container — the container must survive it. */
async function hasLiveOrRevivableChild(db: DbClient, taskId: string): Promise<boolean> {
  const callRows = await db
    .select({ childTaskId: nodeRuns.childTaskId })
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), isNotNull(nodeRuns.childTaskId)))
  const childIds = [...new Set(callRows.flatMap((r) => (r.childTaskId ? [r.childTaskId] : [])))]
  if (childIds.length === 0) return false
  const children = await db
    .select({ status: tasks.status })
    .from(tasks)
    .where(inArray(tasks.id, childIds))
  return children.some(
    (c) => !isTerminalTaskStatus(c.status as TaskStatus) || c.status === 'interrupted',
  )
}

export async function runIsoWorktreeGc(
  db: DbClient,
  appHome: string,
  isTaskActive: (taskId: string) => boolean = () => false,
): Promise<{ scanned: number; removed: string[] }> {
  const isoRoot = join(appHome, 'iso')
  if (!existsSync(isoRoot)) return { scanned: 0, removed: [] }
  const taskDirs = readdirSync(isoRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
  if (taskDirs.length === 0) return { scanned: 0, removed: [] }
  const rows = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      repoPath: tasks.repoPath,
      worktreePath: tasks.worktreePath,
      workspacePruningAt: tasks.workspacePruningAt,
      workspacePrunedAt: tasks.workspacePrunedAt,
    })
    .from(tasks)
    .where(inArray(tasks.id, taskDirs))
  const byId = new Map(rows.map((r) => [r.id, r]))
  const removed: string[] = []
  for (const taskId of taskDirs) {
    if (isTaskActive(taskId)) continue
    const t = byId.get(taskId)
    // Skip a task that still has a row and is NOT terminal — its iso may be in flight.
    if (t !== undefined && !isTerminalTaskStatus(t.status as TaskStatus)) {
      continue
    }
    // RFC-243 §4.4 (design-gate P0-2): two revivability carve-outs.
    // ① 'interrupted' is terminal BUT revivable — a daemon restart flips
    //    parent AND child to interrupted together; reaping the parent's iso
    //    here would delete the child's canonical workspace before resume.
    if (t !== undefined && t.status === 'interrupted') continue
    // ② A call row whose child task is non-terminal or interrupted still
    //    anchors a live/revivable child INSIDE this container.
    if (t !== undefined && (await hasLiveOrRevivableChild(db, taskId))) continue
    const containerRoot = join(isoRoot, taskId)
    // RFC-165 (D1): row-anchored + revivable → take the transient claim.
    // Tombstoned or row-less containers delete without ceremony.
    let claimStamp: number | null = null
    if (t !== undefined && t.workspacePrunedAt === null) {
      claimStamp = Date.now()
      const claimed = await db
        .update(tasks)
        .set({ workspacePruningAt: claimStamp })
        .where(
          and(
            eq(tasks.id, taskId),
            inArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
            isNull(tasks.workspacePruningAt),
            isNull(tasks.workspacePruneCause),
            isNull(tasks.workspacePrunedAt),
          ),
        )
        .returning({ id: tasks.id })
      if (claimed.length !== 1) {
        // Revived, being pruned by workspace GC, or racing another claimer —
        // leave the container for the next tick.
        continue
      }
    }
    try {
      rmSync(containerRoot, { recursive: true, force: true })
      // Prune the now-dangling worktree registrations from the task's repo/worktree.
      if (t !== undefined) {
        for (const wt of [t.worktreePath, t.repoPath]) {
          if (wt !== '' && existsSync(wt)) {
            await runGit(wt, ['worktree', 'prune']).catch(() => {})
          }
        }
      }
      removed.push(taskId)
    } catch (err) {
      log.warn('iso worktree GC failed', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      // Release the transient claim (CAS-scoped: only OUR stamp, and only if
      // the workspace GC didn't finalize a tombstone meanwhile).
      if (claimStamp !== null) {
        await db
          .update(tasks)
          .set({ workspacePruningAt: null })
          .where(
            and(
              eq(tasks.id, taskId),
              eq(tasks.workspacePruningAt, claimStamp),
              isNull(tasks.workspacePruneCause),
              isNull(tasks.workspacePrunedAt),
            ),
          )
      }
    }
  }
  return { scanned: taskDirs.length, removed }
}

/**
 * Start an hourly worktree-GC ticker. The supplied `loadConfig` is invoked
 * each tick so config changes take effect without daemon restart. `appHome` (when
 * given) also GCs orphan iso worktrees (RFC-130 PR-E) and orphan scratch dirs
 * (RFC-165 F9) each tick.
 */
export function startWorktreeGc(
  db: DbClient,
  // RFC-287：半成品目录的年龄阈值要随 `gitCloneTimeoutMs` 放大（无上限的配置项），
  // 所以这里比原来多读一个字段。仍是**窄投影**，不是整份 Config。
  loadConfig: () => Pick<Config, 'worktreeAutoGc' | 'gitCloneTimeoutMs'>,
  intervalMs: number = DAEMON_CADENCE.worktreeGc,
  appHome?: string,
  isTaskActive: (taskId: string) => boolean = () => false,
): { stop: () => void } {
  let running = false
  const handle = setInterval(() => {
    if (running) return
    running = true
    runClaimedWebhookWorkspacePrunes(db, { isTaskActive, staleOnly: true })
      .then(() => runWorktreeGc(db, loadConfig(), Date.now(), isTaskActive))
      .then(() => (appHome !== undefined ? runIsoWorktreeGc(db, appHome, isTaskActive) : undefined))
      .then(() => (appHome !== undefined ? runScratchOrphanGc(db, appHome) : undefined))
      // RFC-222 — sweep orphan task worktrees (deleted-task backstop, §6.4).
      .then(() => (appHome !== undefined ? runWorktreeOrphanGc(db, appHome) : undefined))
      // RFC-287：半成品镜像目录（SIGKILL 落在冷克隆中途时留下），此前无人回收。
      .then(async () => {
        if (appHome !== undefined) {
          await runPartialCloneGc(appHome, Date.now(), loadConfig().gitCloneTimeoutMs)
        }
      })
      .catch((err: unknown) => {
        log.error('runWorktreeGc failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => {
        running = false
      })
  }, intervalMs)
  return { stop: () => clearInterval(handle) }
}
