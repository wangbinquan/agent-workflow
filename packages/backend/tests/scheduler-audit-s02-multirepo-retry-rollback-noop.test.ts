import { rimrafDir } from './helpers/cleanup'
// RFC-092 REGRESSION LOCK — design/scheduler-audit-2026-06-10.md S-2 (P0, WP-1)
// 修复：RFC-092（design/RFC-092-scheduler-p0-stopgap/design.md §2）。
// （此文件由修复前的 CURRENT-BEHAVIOR LOCK 按头部 FLIP 指引翻转而来。）
//
// 修复后的正确语义（本文件全绿地锁定它）：
//   多仓任务（repoCount > 1）的「调度器进程内重试」回滚逐子仓生效——
//   fresh-session 重试开始前，每个子仓都被回滚到该节点行的 per-repo pre-snapshot
//   （含 sha='' 的子仓也 reset --hard + clean -fd），失败尝试写下的脏文件
//   既不进下一次重试的起点，也不残留进任务终态。
//
// 机制（RFC-092 实现）：
//   - 快照写入仍是双轨的：单仓写 `preSnapshot` 列，多仓写 `preSnapshotReposJson`、
//     `preSnapshot` 保持 NULL（写入侧未动——本文件的双轨写入证据断言原样保留）。
//   - 回滚收敛进共享 `rollbackNodeRunWorktrees`（services/nodeRollback.ts）：
//     scheduler 重试路径携带进程内 `lastFreshSnapshot`（最后一次 fresh-session
//     尝试写入的快照）调它，`resetOnEmptySnapshot: true`。多仓硬闸保证容器目录
//     （plain-mkdir，task.ts 多仓布局）绝不挨任何 git 命令，每个子仓独立
//     reset --hard + clean -fd + stash apply。
//   - 旧的单轨 `readSnapshotForLatestRun`（只读 `preSnapshot` 单列 +
//     desc(retryIndex) 排序）已整个删除——源码面守卫见
//     scheduler-audit-s13-freshest-fork-source-guards.test.ts。
//   - 共享函数本体的逐 case 单测见 rfc092-node-rollback.test.ts；单仓 followup
//     链的基线选择（S-2b）见 rfc092-followup-chain-rollback.test.ts。
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
//       means decideEnvelopeFollowup picks a FRESH-SESSION retry — the only
//       attempt shape that runs the scheduler's pre-retry rollback.
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
    cleanup: () => rimrafDir(appHome),
  }
}

async function seedWriterAgent(db: DbClient, name: string): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(['summary']),
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

describe('S-2 multi-repo in-process retry rollback rolls each sub-repo back (RFC-092 REGRESSION LOCK)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('failed writer attempt dirties both sub-repos; attempt 2 starts on CLEAN trees and no stray survives into the done task', async () => {
    await seedWriterAgent(h.db, 'fixer')
    const taskId = await seedMultiRepoTask(h)

    const strayA = join(h.repoA, 'stray.txt')
    const strayB = join(h.repoB, 'stray.txt')
    const manifestFile = join(h.appHome, 's2-manifest.json')

    await withEnv(
      {
        S2_COUNTER_FILE: join(h.appHome, 's2-counter'),
        // RFC-130: RELATIVE stray names → the mock writes them to its cwd (the
        // ISOLATED worktree), so a failed attempt's partial writes live in the iso
        // and are discarded on the fresh-session retry — they NEVER reach the
        // canonical sub-repos (I-5). (Pre-RFC-130 these were absolute canonical
        // paths cleaned by the pre-snapshot rollback, which the iso model removes.)
        S2_STRAY_PATHS: JSON.stringify(['stray.txt']),
        S2_MANIFEST_FILE: manifestFile,
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', h.miniMockPath],
          // RFC-115: retry budget via runTask opts (was node.retries: 1).
          defaultNodeRetries: 1,
        }),
    )

    // The retry (attempt 2) succeeded → task done (unchanged by the fix; the
    // observable difference is what the retry inherited on disk, below).
    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('done')

    // Two attempts: retryIndex 0 failed, retryIndex 1 done.
    const runs = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId)))
      .filter((r) => r.nodeId === 'a1')
      .sort((a, b) => a.retryIndex - b.retryIndex)
    expect(runs.length).toBe(2)
    expect(runs[0]?.status).toBe('failed')
    expect(runs[1]?.status).toBe('done')

    // ── RFC-130: the iso model no longer writes pre-snapshot columns — a failed
    // attempt ran entirely in its ISO (never touched the canonical sub-repos), so
    // there is nothing to roll back. Both columns stay NULL on both rows.
    for (const r of runs) {
      expect(r?.preSnapshot).toBeNull()
      expect(r?.preSnapshotReposJson).toBeNull()
    }

    // The container dir is a PLAIN mkdir (task.ts multi-repo layout), not a git
    // repo — unchanged by RFC-130 (the iso worktrees live under {appHome}/iso).
    expect(existsSync(join(h.containerDir, '.git'))).toBe(false)

    // ── HEADLINE LOCK 1 (RFC-130 I-5): the retry attempt started on a CLEAN iso
    // (re-branched from the canonical sub-repos). The failed attempt's stray, which
    // it wrote to its OWN iso cwd, did NOT exist when the fresh retry started.
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf-8')) as Array<{
      path: string
      existsAtRetryStart: boolean
    }>
    expect(manifest.length).toBe(1)
    expect(manifest[0]?.existsAtRetryStart).toBe(false)

    // ── HEADLINE LOCK 2 (RFC-130 I-5): the failed attempt's partial write NEVER
    // reached the canonical sub-repos — it lived in the discarded iso. The
    // committed baseline is intact; the failed attempt was zero-pollution.
    expect(existsSync(strayA)).toBe(false)
    expect(existsSync(strayB)).toBe(false)
    expect(readFileSync(join(h.repoA, 'src.txt'), 'utf-8')).toBe('base\n')
    expect(readFileSync(join(h.repoB, 'src.txt'), 'utf-8')).toBe('base\n')
  })

  test('contrast oracle: retry path and resume path now share ONE rollback authority (services/nodeRollback.ts)', () => {
    // Source-text companion tying the rollback call sites together (the
    // behavioral nets are this file + resume-multi-repo-rollback.test.ts +
    // rfc092-node-rollback.test.ts; the fork-deletion source guards live in
    // scheduler-audit-s13-freshest-fork-source-guards.test.ts).
    const taskSrc = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'),
      'utf-8',
    )
    const schedulerSrc = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf-8',
    )
    const rollbackSrc = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'nodeRollback.ts'),
      'utf-8',
    )
    // The resume thin shell keeps its historical shape (PB-G4 of
    // source-text-rfc066-pr-b-guards.test.ts) and delegates to the shared
    // function…
    expect(taskSrc.includes('async function rollbackNodeRunForResume(')).toBe(true)
    expect(taskSrc.includes('await rollbackNodeRunWorktrees(')).toBe(true)
    // …the per-repo map read lives in the shared authority…
    expect(rollbackSrc.includes('preSnapshotReposJson')).toBe(true)
    // …RFC-130 SUPERSEDES the scheduler retry-rollback: the fresh-session retry no
    // longer rolls the canonical worktree back (it never wrote it) — it DISCARDS
    // the failed iso and re-branches a fresh one. So the scheduler's runOneNode
    // path uses discardNodeIso + createNodeIso, NOT rollbackNodeRunWorktrees. The
    // resume path (task.ts) keeps the rollback authority as defense-in-depth (D10).
    expect(schedulerSrc.includes('discardNodeIso(')).toBe(true)
    expect(schedulerSrc.includes('createNodeIso(')).toBe(true)
    expect(schedulerSrc.includes('await readSnapshotForLatestRun(')).toBe(false)
  })
})
