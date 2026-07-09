import { rimrafDir } from './helpers/cleanup'
// RFC-108 PR-C T6 (AR-15) + T7 (AR-17) — resume worktree-missing 410 pre-flight
// and cross-node-run all-or-nothing rollback.
//
// 为什么这条测试存在：
//   T6 — worktreeAutoGc 的候选集含 failed/interrupted（恰是 resumable 的状态），
//   开启 GC 时会删掉一个还要 resume 的任务的 worktree。此前 resumeTask 无 worktree
//   存在性前检：CAS 翻 pending → 对不存在的 cwd kick → 脏 500。现加 410 前检（在
//   ownership CAS 之前），任务保持 failed、不被错误复活。
//   T7 — resumeKick 的逐行回滚是「行内」fail-closed，但跨多个 node_run 行时，前一行
//   已 reset（且子进程已杀）后才在后一行发现 snapshot 被 gc-prune → 升级 snapshot-lost，
//   留下半回滚的 worktree。现加跨行 checkOnly 预检：任一行快照缺失则在动任何 worktree
//   之前升级，保证 all-or-nothing。
//
// 确定性：纯本地 git（init/commit/stash create/gc/reset），无网络/clone（同
// scheduler-audit-s11 不加 RUN_GIT_NETWORK 门控）。

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { getTask, resumeTask } from '../src/services/task'
import { gitStashSnapshot, runGit, snapshotRefName } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DEPS_CMD = ['/usr/bin/env', 'true']

interface Harness {
  db: DbClient
  appHome: string
  repoPath: string
  taskId: string
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc108-resume-'))
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(repoPath, { recursive: true })
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 't@t.test'])
  await runGit(repoPath, ['config', 'user.name', 't'])
  writeFileSync(join(repoPath, 'README.md'), '# r\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'i'])

  const db = createInMemoryDb(MIGRATIONS)
  const definition: WorkflowDefinition = {
    $schema_version: 2,
    inputs: [],
    nodes: [
      { id: 'a', kind: 'agent-single', agentName: 'a', promptTemplate: '' } as WorkflowNode,
      { id: 'b', kind: 'agent-single', agentName: 'b', promptTemplate: '' } as WorkflowNode,
    ],
    edges: [],
  }
  const workflowId = ulid()
  await db
    .insert(workflows)
    .values({ id: workflowId, name: 'w', definition: JSON.stringify(definition) })
  const taskId = ulid()
  await db.insert(tasks).values({
    name: 't',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath,
    worktreePath: repoPath,
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    status: 'failed',
    inputs: '{}',
    startedAt: Date.now(),
    finishedAt: Date.now(),
    errorSummary: 'boom',
  })
  return {
    db,
    appHome,
    repoPath,
    taskId,
    cleanup: () => rimrafDir(tmp),
  }
}

async function gcPruneNow(repoPath: string): Promise<void> {
  await runGit(repoPath, ['reflog', 'expire', '--expire=now', '--expire-unreachable=now', '--all'])
  await runGit(repoPath, ['gc', '--prune=now', '--quiet'])
}

async function insertFailedRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  id: string,
  preSnapshot: string | null,
): Promise<void> {
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
    status: 'failed',
    preSnapshot,
    startedAt: Date.now(),
    finishedAt: Date.now(),
  })
}

describe('RFC-108 T6 (AR-15) — resume worktree-missing 410 pre-flight', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('resume on a gc-reclaimed worktree → clean 410, task NOT flipped to pending', async () => {
    h = await buildHarness()
    // Simulate worktreeAutoGc reclaiming the worktree of a resumable task.
    rimrafDir(h.repoPath)

    let code: string | undefined
    let status: number | undefined
    try {
      await resumeTask(h.db, h.taskId, { db: h.db, appHome: h.appHome, opencodeCmd: DEPS_CMD })
    } catch (err) {
      code = (err as { code?: string }).code
      status = (err as { status?: number }).status
    }
    expect(code).toBe('task-worktree-missing')
    expect(status).toBe(410)
    // Critical: the 410 fires BEFORE the ownership CAS — the task is NOT
    // resurrected to pending; it stays failed.
    const t = await getTask(h.db, h.taskId)
    expect(t?.status).toBe('failed')
  })

  test('worktree dir present (even if not git-init) → no false 410 (existsSync gate)', async () => {
    // T6 targets the gc-reclaim case (dir DELETED); a present worktree dir must
    // not false-fire — many repair/resume paths use a present-but-bare stub dir.
    h = await buildHarness()
    rmSync(join(h.repoPath, '.git'), { recursive: true, force: true }) // dir still exists
    let code: string | undefined
    try {
      await resumeTask(h.db, h.taskId, { db: h.db, appHome: h.appHome, opencodeCmd: DEPS_CMD })
    } catch (err) {
      code = (err as { code?: string }).code
    }
    // NOT a worktree-missing 410 — the dir exists. (Resume proceeds to pending;
    // any later git failure is a separate path.)
    expect(code).not.toBe('task-worktree-missing')
    expect((await getTask(h.db, h.taskId))?.status).toBe('pending')
  })
})

describe('RFC-108 T7 (AR-17) — cross-node-run all-or-nothing rollback', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('a LATER row gc-pruned snapshot escalates BEFORE the earlier row is reset', async () => {
    h = await buildHarness()
    // Make a.txt tracked so stash-create captures its changes.
    writeFileSync(join(h.repoPath, 'a.txt'), 'base\n')
    await runGit(h.repoPath, ['add', '.'])
    await runGit(h.repoPath, ['commit', '-q', '-m', 'add a'])

    const runA = ulid()
    const runB = ulid()
    // Row A snapshot: PINNED so gc keeps it (RFC-098 snapshot pin).
    writeFileSync(join(h.repoPath, 'a.txt'), 'snapshot-A\n')
    const shaA = await gitStashSnapshot(h.repoPath, { pinRef: snapshotRefName(h.taskId, runA) })
    // Row B snapshot: UNPINNED → gc-bait.
    writeFileSync(join(h.repoPath, 'a.txt'), 'snapshot-B\n')
    const shaB = await gitStashSnapshot(h.repoPath)

    // The shared source-repo odb gets gc'd: shaA (pinned) survives, shaB pruned.
    await gcPruneNow(h.repoPath)

    // The failed attempt's leftover state on disk at resume time.
    writeFileSync(join(h.repoPath, 'a.txt'), 'FAILED-LEFTOVER\n')
    writeFileSync(join(h.repoPath, 'junk.txt'), 'untracked\n')

    await insertFailedRun(h.db, h.taskId, 'a', runA, shaA) // valid snapshot
    await insertFailedRun(h.db, h.taskId, 'b', runB, shaB) // gc-pruned snapshot

    let code: string | undefined
    try {
      await resumeTask(h.db, h.taskId, { db: h.db, appHome: h.appHome, opencodeCmd: DEPS_CMD })
    } catch (err) {
      code = (err as { code?: string }).code
    }
    expect(code).toBe('snapshot-lost')

    // Cross-row atomicity: row A's worktree was NOT reset to 'snapshot-A' — the
    // leftover survives because the pre-pass caught row B's missing snapshot
    // BEFORE touching anything.
    expect(readFileSync(join(h.repoPath, 'a.txt'), 'utf-8')).toBe('FAILED-LEFTOVER\n')
    expect(existsSync(join(h.repoPath, 'junk.txt'))).toBe(true)
    // Task ends failed (snapshot-lost), not stuck pending.
    const t = await getTask(h.db, h.taskId)
    expect(t?.status).toBe('failed')
    expect(t?.errorSummary).toBe('snapshot-lost')
  })

  test('all snapshots present → resume proceeds (rolls back, flips pending)', async () => {
    h = await buildHarness()
    writeFileSync(join(h.repoPath, 'a.txt'), 'base\n')
    await runGit(h.repoPath, ['add', '.'])
    await runGit(h.repoPath, ['commit', '-q', '-m', 'add a'])

    const runA = ulid()
    writeFileSync(join(h.repoPath, 'a.txt'), 'snapshot-A\n')
    const shaA = await gitStashSnapshot(h.repoPath, { pinRef: snapshotRefName(h.taskId, runA) })
    writeFileSync(join(h.repoPath, 'a.txt'), 'FAILED-LEFTOVER\n')
    await insertFailedRun(h.db, h.taskId, 'a', runA, shaA)

    const after = await resumeTask(h.db, h.taskId, {
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: DEPS_CMD,
    })
    expect(after.status).toBe('pending')
    // Row A WAS rolled back to its snapshot (no missing-snapshot escalation).
    expect(readFileSync(join(h.repoPath, 'a.txt'), 'utf-8')).toBe('snapshot-A\n')
  })
})
