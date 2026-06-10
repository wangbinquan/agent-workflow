// CURRENT-BEHAVIOR LOCK — design/scheduler-audit-2026-06-10.md S-8 (WP-4)
//
// 当前缺陷行为：runTask 入口没有任何状态 CAS / 防重入检查——
// services/scheduler.ts:261-262 的 "3. Mark running" 是一条无条件
// `db.update(tasks).set({ status: 'running' })`。后果（本文件逐条锁定）：
//   1. 已 canceled 的任务被直接复活并跑到 done（终态不设防）；
//   2. 已 done 的任务被重新进入、重新铸 node_runs 跑一遍（无终态守卫）；
//   3. status='running'（语义上已有另一个调度器实例持有）的任务被静默接管
//      ——这正是 S-8 "并发 resume/retry 起两个调度器双写同一 worktree" 的入口面。
//
// 正确语义：runTask 仅应接受 pending（或显式列入转移表的可恢复态）；
// 非法 from-状态应拒绝执行（no-op / 409），running 应视为已有实例持有而拒绝
// 二次进入（结合 activeTasks 注册表）。
//
// 修复落点：WP-4（shared nextTaskStatus 转移表 + transitionTaskStatus CAS +
// resumeTask/retryNode/runTask 入口 activeTasks 拒绝）。
// 修复时本文件应翻红：把各断言翻转为「状态保持原值 / 不铸任何 node_runs /
// runTask 拒绝执行」（见每条断言旁的 FLIP 注释）。
//
// 工作流刻意取最小形态 input → output（零 agent 节点，opencode 不会真被
// spawn），因此本测试只行使 runTask 的入口路径 + frontier 终结路径，确定性 100%。

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'
import { runGit } from '../src/util/git'

// 同毫秒多次 ulid() 的随机分量可逆序；monotonicFactory 保证后铸 id 恒更大
// （先例与理由见 scheduler-clarify-dispatch.test.ts:33-40）。
const ulid = monotonicFactory()

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  repoPath: string
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-audit-s08-'))
  const repoPath = join(appHome, 'repo')
  const worktreePath = join(appHome, 'wt')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(worktreePath, { recursive: true })
  await runGit(repoPath, ['init', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 't@t.test'])
  await runGit(repoPath, ['config', 'user.name', 't'])
  writeFileSync(join(repoPath, 'README.md'), '# r\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-m', 'init'])
  await runGit(worktreePath, ['init', '-b', 'main'])
  await runGit(worktreePath, ['config', 'user.email', 't@t.test'])
  await runGit(worktreePath, ['config', 'user.name', 't'])
  writeFileSync(join(worktreePath, 'r.md'), '# r\n')
  await runGit(worktreePath, ['add', '.'])
  await runGit(worktreePath, ['commit', '-m', 'init'])
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    repoPath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

/** 最小 input → output 工作流：零 agent 节点，frontier 直接走虚拟行到 done。 */
function minimalDef(): WorkflowDefinition {
  return {
    $schema_version: 3,
    inputs: [{ kind: 'text', key: 'req', label: 'r' }],
    nodes: [
      { id: 'in', kind: 'input', inputKey: 'req' } as WorkflowNode,
      { id: 'out', kind: 'output', ports: [] } as WorkflowNode,
    ],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'in', portName: 'req' },
        target: { nodeId: 'out', portName: 'final' },
      },
    ],
  }
}

async function seedTaskWithStatus(
  h: Harness,
  status: 'canceled' | 'done' | 'running',
  extra: Partial<typeof tasks.$inferInsert> = {},
): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  const def = minimalDef()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(def),
  })
  await h.db.insert(tasks).values({
    id: taskId,
    name: 'audit-s08-task',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: h.repoPath,
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status,
    inputs: JSON.stringify({ req: 'hello' }),
    startedAt: Date.now(),
    ...extra,
  })
  return taskId
}

async function invokeRunTask(h: Harness, taskId: string): Promise<void> {
  await runTask({
    taskId,
    db: h.db,
    appHome: h.appHome,
    opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
  })
}

describe('S-8 lock: runTask entry has no status CAS / no re-entry guard (scheduler.ts:261-262)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('canceled task is silently revived and driven to done', async () => {
    const staleFinishedAt = Date.now() - 60_000
    const taskId = await seedTaskWithStatus(h, 'canceled', {
      finishedAt: staleFinishedAt,
      errorSummary: 'canceled',
    })

    await invokeRunTask(h, taskId)

    const row = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    // FLIP (WP-4): 修复后应为 'canceled'（runTask 拒绝非 pending/可恢复态）。
    expect(row?.status).toBe('done')
    // 终结写确实重新发生过：finishedAt 被覆写为新值。
    // FLIP (WP-4): 修复后应保持 staleFinishedAt 原值。
    expect(row?.finishedAt ?? 0).toBeGreaterThan(staleFinishedAt)
    // 盲写的另一面：done 写点（scheduler.ts:403）只 set status+finishedAt，
    // 复活后的"done"任务仍背着取消时代的 errorSummary——状态与错误字段失配。
    expect(row?.errorSummary).toBe('canceled')

    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    // 最小 in→out 工作流恰好铸 2 行虚拟 node_runs（input + output 各 1，均 done）。
    // FLIP (WP-4): 修复后应为 0（被拒绝的调用不得铸任何 node_runs）。
    expect(runs.length).toBe(2)
    expect(runs.map((r) => r.nodeId).sort()).toEqual(['in', 'out'])
    expect(runs.every((r) => r.status === 'done')).toBe(true)
  })

  test('done (terminal) task is re-entered and fully re-run — fresh node_runs minted', async () => {
    const staleFinishedAt = 1_000 // 远古时间戳，证明终结写发生过一次新的
    const taskId = await seedTaskWithStatus(h, 'done', { finishedAt: staleFinishedAt })

    await invokeRunTask(h, taskId)

    const row = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(row?.status).toBe('done')
    // FLIP (WP-4): 修复后 finishedAt 应保持 staleFinishedAt（任务根本不该重跑）。
    expect(row?.finishedAt ?? 0).toBeGreaterThan(staleFinishedAt)

    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    // seed 时该任务没有任何历史 node_runs，这 2 行全是本次重入新铸的
    // （in + out 各 1）。FLIP (WP-4): 修复后应为 0——done 任务不得被重新调度。
    expect(runs.length).toBe(2)
    expect(runs.map((r) => r.nodeId).sort()).toEqual(['in', 'out'])
  })

  test('running task (semantically owned by another scheduler) is taken over without any re-entry check', async () => {
    const taskId = await seedTaskWithStatus(h, 'running')

    // 第二个 runTask 调用照单全收——这就是 S-8 双调度器双写 worktree 的入口面。
    await invokeRunTask(h, taskId)

    const row = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    // FLIP (WP-4): 修复后 status 应保持 'running' 且本次调用不产生任何行
    //（入口以 activeTasks/CAS 识别"已有实例持有"并拒绝）。
    expect(row?.status).toBe('done')

    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    // 第二实例独立铸了整套行（in + out 各 1）——若真有另一实例在跑，
    // 这就是"同一节点铸两份行"的爆炸半径起点。
    // FLIP (WP-4): 修复后应为 0。
    expect(runs.length).toBe(2)
    expect(runs.map((r) => r.nodeId).sort()).toEqual(['in', 'out'])
  })
})
