import { rimrafDir } from './helpers/cleanup'
// CURRENT-BEHAVIOR LOCK — design/scheduler-audit-2026-06-10.md §⑥ 缺口3 (GC 把可恢复任务的 worktree 当垃圾)
//
// 当前缺陷行为（已对照 src/services/gc.ts:23-28 核实）：
//   `TERMINAL_STATUSES = ['done','failed','canceled','interrupted']` —— 其中
//   `failed` 和 `interrupted` 是 resumeTask 明确接受的可恢复状态
//   （task.ts:974-979 还包括 awaiting_review/awaiting_human，这两个不在 GC 集合里）。
//   小时级 GC 会把用户随后要 resume 的 worktree 从磁盘删掉；而 resumeTask
//   （task.ts:969 起）不做任何 worktree 存在性 / git 有效性检查就直接
//   rollbackNodeRunForResume + runTask。产品语义（cancel 保留 worktree、长期搁置后
//   恢复，见 S-11 爆炸半径一节）与该集合直接冲突。
//
// 另锁多仓盲区（缺口3 后半段）：多仓任务的 worktreePath 是普通 mkdir 容器目录而非
// git worktree，gc.ts:73 对它跑 `git worktree remove --force` 恒失败（util/git.ts:810-821
// 抛 worktree-remove-failed）→ 被 gc.ts:76-82 catch 计入 skipped → 容器目录与其中的
// 子仓 worktree 永久泄漏（确认走"恒失败泄漏"分支，不是"force 误删"分支）。
//
// 正确语义应是：GC 候选集要与"可恢复"语义对齐（至少 interrupted/failed 需要
// 年龄阈值之外的额外保护，或 resumeTask 必须先做存在性检查并给出可见错误）；
// 多仓任务需要按 task_repos 逐子仓 removeWorktree + 删容器目录。
//
// 修复归属：报告 ⑥-3 未划入既有 WP（多仓部分与 S-2/WP-1 的多仓回滚共享语境）。
// 修复时本文件应翻红，按各断言旁注释翻转期望值。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { runWorktreeGc } from '../src/services/gc'
import { createWorktree, runGit } from '../src/util/git'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAY_MS = 24 * 60 * 60 * 1000

interface Harness {
  db: DbClient
  appHome: string
  repoPath: string
  cleanup: () => void
}

// Real git repo in a temp dir (no network, no stash) — same harness shape as
// gc.test.ts so createWorktree/removeWorktree operate on genuine worktrees.
async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-gap3-gc-'))
  const repoPath = join(appHome, 'repo')
  await runGit(appHome, ['init', '-q', '-b', 'main', 'repo'])
  await runGit(repoPath, ['config', 'user.email', 'test@example.com'])
  await runGit(repoPath, ['config', 'user.name', 'Test'])
  await runGit(repoPath, ['commit', '--allow-empty', '-q', '-m', 'init'])
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    repoPath,
    cleanup: () => rimrafDir(appHome),
  }
}

async function seedTask(
  h: Harness,
  overrides: Partial<typeof tasks.$inferInsert>,
): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    name: 'fixture-task',
    id: taskId,
    workflowId,
    workflowSnapshot: '{}',
    repoPath: h.repoPath,
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'done',
    inputs: '{}',
    startedAt: Date.now() - 1000,
    finishedAt: Date.now() - 500,
    ...overrides,
  })
  return taskId
}

describe('gap3 — worktree GC candidate set vs resume semantics (current-behavior lock)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('candidate set is exactly {done,failed,canceled,interrupted}: paused/live statuses are not scanned, resumable terminals are', async () => {
    // Phase 1 — only non-candidates in the DB: nothing is scanned.
    for (const status of ['pending', 'running', 'awaiting_review', 'awaiting_human'] as const) {
      await seedTask(h, { status })
    }
    const r1 = await runWorktreeGc(h.db, { worktreeAutoGc: { enabled: true } })
    expect(r1.scanned).toBe(0)
    expect(r1.removed).toEqual([])

    // Phase 2 — add one task per TERMINAL_STATUSES member (worktreePath ''
    // keeps this DB-only: each is counted scanned, then skipped at gc.ts:54).
    // DEFECT LOCK: scanned === 4 pins 'interrupted' and 'failed' — both
    // resumable per resumeTask's gate (task.ts:974-979) — inside the GC
    // candidate set. After a fix that excludes resumable statuses (or guards
    // them further), this count drops — flip the expectation accordingly.
    for (const status of ['done', 'failed', 'canceled', 'interrupted'] as const) {
      await seedTask(h, { status })
    }
    const r2 = await runWorktreeGc(h.db, { worktreeAutoGc: { enabled: true } })
    expect(r2.scanned).toBe(4)
    expect(r2.skipped).toBe(4)
    expect(r2.removed).toEqual([])
  })

  test('an old interrupted/failed task loses its real worktree to GC — exactly what a later resumeTask would need', async () => {
    const longAgo = Date.now() - 10 * DAY_MS
    const seeded: Array<{ taskId: string; worktreePath: string }> = []
    for (const status of ['interrupted', 'failed'] as const) {
      const taskId = ulid()
      const wt = await createWorktree({ repoPath: h.repoPath, taskId, appHome: h.appHome })
      const workflowId = ulid()
      await h.db.insert(workflows).values({
        id: workflowId,
        name: 'wf',
        definition: '{}',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      await h.db.insert(tasks).values({
        name: 'fixture-task',
        id: taskId,
        workflowId,
        workflowSnapshot: '{}',
        repoPath: h.repoPath,
        worktreePath: wt.worktreePath,
        baseBranch: 'main',
        branch: wt.branch,
        status,
        inputs: '{}',
        startedAt: longAgo,
        finishedAt: longAgo,
      })
      seeded.push({ taskId, worktreePath: wt.worktreePath })
    }

    const r = await runWorktreeGc(h.db, { worktreeAutoGc: { enabled: true, olderThanDays: 1 } })

    // DEFECT LOCK: both resumable tasks' worktrees are removed from disk.
    // resumeTask performs no existence check before rollback + runTask
    // (task.ts:969ff), so a subsequent resume operates on a missing
    // directory. After a fix this should leave (at least) the interrupted
    // task's worktree alone — flip to expect it survives.
    expect(r.removed.sort()).toEqual(seeded.map((s) => s.taskId).sort())
    for (const s of seeded) {
      expect(existsSync(s.worktreePath)).toBe(false)
    }
  })

  test('multi-repo container dir: `git worktree remove` always fails → worktree leaks forever (skipped every pass)', async () => {
    // Multi-repo tasks set worktreePath to a PLAIN mkdir container directory
    // (task.ts RFC-066 path), not a git worktree. GC treats every task row
    // uniformly (gc.ts never reads repoCount).
    const container = join(h.appHome, 'multi-container')
    mkdirSync(join(container, 'repo-a'), { recursive: true })
    await seedTask(h, {
      status: 'interrupted',
      worktreePath: container,
      repoCount: 2,
      finishedAt: Date.now() - 10 * DAY_MS,
    })

    const r = await runWorktreeGc(h.db, { worktreeAutoGc: { enabled: true, olderThanDays: 1 } })

    // DEFECT LOCK: `git worktree remove --force <plain dir>` exits non-zero
    // (util/git.ts:813-820 throws worktree-remove-failed), gc catches and
    // counts it skipped — the container dir (and any per-repo worktrees
    // inside it) leak permanently, re-scanned and re-skipped every hour.
    // After a multi-repo-aware fix: expect removed to contain the task and
    // the container dir to be gone.
    expect(r.scanned).toBe(1)
    expect(r.removed).toEqual([])
    expect(r.skipped).toBe(1)
    expect(existsSync(container)).toBe(true)
    // The inner per-repo worktree dir leaks along with the container.
    expect(existsSync(join(container, 'repo-a'))).toBe(true)
  })
})
