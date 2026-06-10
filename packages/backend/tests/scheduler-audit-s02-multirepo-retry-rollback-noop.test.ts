// CURRENT-BEHAVIOR LOCK — design/scheduler-audit-2026-06-10.md S-2 (P0, WP-1)
//
// 当前缺陷行为（本文件全绿地锁定它）：
//   多仓任务（repoCount > 1）的「调度器进程内重试」回滚是静默 no-op——
//   失败尝试在各子仓写下的脏文件原封不动地喂给下一次重试，并残留进任务终态。
//
// 机制（已逐行核实，2026-06-10）：
//   - 快照写入是双轨的：单仓写 `preSnapshot` 列（scheduler.ts:1604-1605），
//     多仓写 `preSnapshotReposJson`、`preSnapshot` 保持 NULL（scheduler.ts:1606-1628）。
//   - 但重试回滚是单轨的：`readSnapshotForLatestRun`（scheduler.ts:3775-3794）只读
//     `preSnapshot` 单列 → 多仓行得到 ''；随后对 `task.worktreePath` 跑
//     `rollbackToSnapshot`（scheduler.ts:1528）——多仓时它是 plain-mkdir 的容器目录
//     （task.ts:558-560,677），不是 git 仓，`git reset --hard HEAD` 直接 128 失败，
//     DomainError 被 scheduler.ts:1529-1534 的 catch+warn 吞掉。N 个子仓一个都没回滚。
//   - 对照正确实现：resume 路径的 `rollbackNodeRunForResume`（task.ts:870-915）按
//     repoCount 分支读 `preSnapshotReposJson` 逐仓回滚（有
//     resume-multi-repo-rollback.test.ts 防护）。这是 RFC-066 移植时只改 resume
//     没改 scheduler 内重试的双轨漂移。
//
// 正确语义应是：fresh-session 重试开始前，每个子仓都被回滚到该节点行的 per-repo
//   pre-snapshot（含 sha='' 的子仓也要 reset --hard + clean -fd——单仓路径已经为同一
//   教训修过一次门控，见 scheduler.ts:1520-1525 注释与
//   scheduler-boundary-presnapshot-rollback-skip.test.ts）。
//
// 修复落点：WP-1（把 task.ts 的 rollbackNodeRunForResume 抽成共享函数，scheduler
//   重试路径改调它并直接传当前行；顺带消掉 S-13 的 readSnapshotForLatestRun fork）。
// 修复时本文件应翻红，按各断言旁的 [FLIP-ON-FIX] 注释翻转期望值后保留为回归防护。
//
// 测试形态：双子仓 in-memory DB + 直接铸 tasks/task_repos 行 + 自带 mini-mock
//   opencode（attempt 1 在两个子仓各写一个脏文件后 exit 1 且零文本事件——确保
//   decideEnvelopeFollowup 走 fresh-session 重试而非 same-session follow-up；
//   attempt 2 先落盘「重试起点的脏文件存在性清单」再输出合法 envelope 成功）。

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRuns, taskRepos, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// Self-contained mini-mock opencode (written into the per-test temp dir).
// Behavior:
//   attempt 1 (counter file says n === 1):
//     - writes 'partial-from-failed-attempt' to every absolute path in
//       S2_STRAY_PATHS (one per sub-repo worktree),
//     - exits 1 WITHOUT emitting any text event → exitCode!==0 + agentTextCount=0
//       means decideEnvelopeFollowup picks a FRESH-SESSION retry, which is the
//       only path that runs the scheduler's pre-retry rollback (scheduler.ts:1518).
//   attempt 2 (n >= 2):
//     - records `{ path, existsAtRetryStart }` for each stray path into
//       S2_MANIFEST_FILE — the observable proof of what the retry actually
//       inherited on disk at its start,
//     - emits a valid <workflow-output> envelope and exits 0.
const MINI_MOCK_SOURCE = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const env = process.env
const counterFile = env.S2_COUNTER_FILE
if (!counterFile) {
  process.stderr.write('S2_COUNTER_FILE unset\\n')
  process.exit(2)
}
let n = 0
if (existsSync(counterFile)) n = Number(readFileSync(counterFile, 'utf-8').trim()) || 0
n += 1
writeFileSync(counterFile, String(n))
const strayPaths = JSON.parse(env.S2_STRAY_PATHS ?? '[]')
if (n === 1) {
  for (const p of strayPaths) writeFileSync(p, 'partial-from-failed-attempt\\n')
  process.exit(1)
}
if (env.S2_MANIFEST_FILE) {
  writeFileSync(
    env.S2_MANIFEST_FILE,
    JSON.stringify(strayPaths.map((p) => ({ path: p, existsAtRetryStart: existsSync(p) }))),
  )
}
const envelope = '<workflow-output>\\n  <port name="summary">ok</port>\\n</workflow-output>'
process.stdout.write(
  JSON.stringify({ type: 'text', timestamp: Date.now(), part: { type: 'text', text: envelope } }) +
    '\\n',
)
process.exit(0)
`

interface Harness {
  db: DbClient
  appHome: string
  /** plain-mkdir container dir — mirrors task.ts:558-560 multi-repo layout */
  containerDir: string
  repoA: string
  repoB: string
  miniMockPath: string
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-s02-multirepo-'))
  // Production multi-repo layout: tasks.worktreePath is a PLAIN mkdir container
  // (task.ts:558-560); each repo is a git worktree in a sub-directory. Plain
  // `git init` sub-repos behave identically for stash/reset/clean purposes.
  const containerDir = join(appHome, 'worktrees', 'multi', 'container')
  mkdirSync(containerDir, { recursive: true })
  const repoA = join(containerDir, 'repo-a')
  const repoB = join(containerDir, 'repo-b')
  for (const repo of [repoA, repoB]) {
    mkdirSync(repo, { recursive: true })
    await runGit(repo, ['init', '-q', '-b', 'main'])
    await runGit(repo, ['config', 'user.email', 't@e.com'])
    await runGit(repo, ['config', 'user.name', 'T'])
    writeFileSync(join(repo, 'src.txt'), 'base\n')
    await runGit(repo, ['add', '.'])
    await runGit(repo, ['commit', '-q', '-m', 'init'])
  }
  const miniMockPath = join(appHome, 's2-mini-opencode.ts')
  writeFileSync(miniMockPath, MINI_MOCK_SOURCE)
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    containerDir,
    repoA,
    repoB,
    miniMockPath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedWriterAgent(db: DbClient, name: string): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(['summary']),
    readonly: false, // WRITER — pre-snapshot + retry rollback are in play
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

async function seedMultiRepoTask(h: Harness): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  const def: WorkflowDefinition = {
    $schema_version: 1,
    inputs: [],
    nodes: [
      {
        id: 'a1',
        kind: 'agent-single',
        agentName: 'fixer',
        retries: 1,
      } as unknown as WorkflowDefinition['nodes'][number],
    ],
    edges: [],
  }
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(def),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    // Legacy columns mirror task_repos[0] (RFC-066) — but worktreePath is the
    // CONTAINER dir, which is exactly what the broken single-track rollback
    // targets.
    repoPath: h.repoA,
    worktreePath: h.containerDir,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
    repoCount: 2,
  })
  await h.db.insert(taskRepos).values([
    {
      taskId,
      repoIndex: 0,
      repoPath: h.repoA,
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      worktreePath: h.repoA,
      worktreeDirName: 'repo-a',
    },
    {
      taskId,
      repoIndex: 1,
      repoPath: h.repoB,
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      worktreePath: h.repoB,
      worktreeDirName: 'repo-b',
    },
  ])
  return taskId
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      const p = prev[k]
      if (p === undefined) delete process.env[k]
      else process.env[k] = p
    }
  })
}

describe('S-2 multi-repo in-process retry rollback is a silent no-op (CURRENT-BEHAVIOR LOCK)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('failed writer attempt dirties both sub-repos; attempt 2 starts on the DIRTY trees and the strays survive into the done task', async () => {
    await seedWriterAgent(h.db, 'fixer')
    const taskId = await seedMultiRepoTask(h)

    const strayA = join(h.repoA, 'stray.txt')
    const strayB = join(h.repoB, 'stray.txt')
    const manifestFile = join(h.appHome, 's2-manifest.json')

    await withEnv(
      {
        S2_COUNTER_FILE: join(h.appHome, 's2-counter'),
        S2_STRAY_PATHS: JSON.stringify([strayA, strayB]),
        S2_MANIFEST_FILE: manifestFile,
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', h.miniMockPath],
        }),
    )

    // The retry (attempt 2) succeeded → task done. The defect is INVISIBLE at
    // the task level — that is precisely the "silent" part of S-2.
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    // Two attempts: retryIndex 0 failed, retryIndex 1 done.
    const runs = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId)))
      .filter((r) => r.nodeId === 'a1')
      .sort((a, b) => a.retryIndex - b.retryIndex)
    expect(runs.length).toBe(2)
    expect(runs[0]?.status).toBe('failed')
    expect(runs[1]?.status).toBe('done')

    // ── Dual-write evidence (scheduler.ts:1598-1629): the multi-repo branch
    // wrote `preSnapshotReposJson` and left `preSnapshot` NULL on BOTH rows.
    // `readSnapshotForLatestRun` (scheduler.ts:3793) reads ONLY `preSnapshot`
    // → '' → the single-track rollback had nothing repo-specific to apply.
    // These two assertions stay TRUE after the WP-1 fix (the fix changes the
    // READ side, not the write side) — do not flip them.
    for (const r of runs) {
      expect(r?.preSnapshot).toBeNull()
      expect(r?.preSnapshotReposJson).not.toBeNull()
      const map = JSON.parse(r!.preSnapshotReposJson!) as Record<string, string>
      expect(Object.keys(map).sort()).toEqual(['repo-a', 'repo-b'])
    }

    // The container dir is NOT a git repo (plain mkdir, task.ts:558-560) —
    // documents why `rollbackToSnapshot(task.worktreePath, '')` throws
    // `worktree-reset-failed` and gets swallowed by scheduler.ts:1529-1534.
    // Stays true after the fix (layout doesn't change).
    expect(existsSync(join(h.containerDir, '.git'))).toBe(false)

    // ── HEADLINE LOCK 1: the retry attempt STARTED on dirty trees. The
    // mini-mock recorded each stray's existence at attempt-2 start.
    // [FLIP-ON-FIX] WP-1: per-repo rollback must clear both strays BEFORE the
    // fresh-session retry → flip both to false.
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf-8')) as Array<{
      path: string
      existsAtRetryStart: boolean
    }>
    expect(manifest.length).toBe(2)
    expect(manifest.find((m) => m.path === strayA)?.existsAtRetryStart).toBe(true)
    expect(manifest.find((m) => m.path === strayB)?.existsAtRetryStart).toBe(true)

    // ── HEADLINE LOCK 2: the failed attempt's partial writes survive into the
    // DONE task's final trees (they would pollute any downstream git diff /
    // aggregation).
    // [FLIP-ON-FIX] WP-1: flip both to false (and note the fix must reset+clean
    // sub-repos even when their per-repo stash sha is '' — the clean-tree gate
    // lesson already learned once on the single-repo path, scheduler.ts:1520-1525).
    expect(existsSync(strayA)).toBe(true)
    expect(existsSync(strayB)).toBe(true)

    // Committed baseline files were never touched (the no-op rollback also
    // didn't corrupt anything) — sanity, stays true after the fix.
    expect(readFileSync(join(h.repoA, 'src.txt'), 'utf-8')).toBe('base\n')
    expect(readFileSync(join(h.repoB, 'src.txt'), 'utf-8')).toBe('base\n')
  })

  test('contrast oracle: the resume-path helper semantics this retry path SHOULD share (per-repo map rollback) are already exercised by resume-multi-repo-rollback.test.ts', () => {
    // Pure documentation assertion tying the two test files together so a
    // future WP-1 refactor finds both: the CORRECT per-repo implementation
    // lives in task.ts `rollbackNodeRunForResume` (task.ts:870-915) and is
    // locked by resume-multi-repo-rollback.test.ts; this file locks the broken
    // scheduler-internal twin. Source-level fork evidence (read-side single
    // column) is locked in scheduler-audit-s13-freshest-fork-source-guards.test.ts.
    const taskSrc = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'),
      'utf-8',
    )
    const schedulerSrc = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf-8',
    )
    // The correct helper exists and reads the per-repo map…
    expect(taskSrc.includes('async function rollbackNodeRunForResume(')).toBe(true)
    expect(taskSrc.includes('run.preSnapshotReposJson')).toBe(true)
    // …while the scheduler retry path still goes through the single-column
    // re-query helper instead of sharing it.
    // [FLIP-ON-FIX] WP-1: when the shared rollback lands, the scheduler should
    // stop calling readSnapshotForLatestRun here — flip to false / delete.
    expect(schedulerSrc.includes('await readSnapshotForLatestRun(db, taskId, node.id,')).toBe(true)
  })
})
