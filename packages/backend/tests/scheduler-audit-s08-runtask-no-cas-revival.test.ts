import { rimrafDir } from './helpers/cleanup'
// REGRESSION GUARD — RFC-097 (audit S-8 / WP-4): runTask 入口状态 CAS。
//
// 历史缺陷（本文件前身以 CURRENT-BEHAVIOR LOCK 形态锁定过）：runTask 入口
// 没有任何状态 CAS / 防重入检查——"Mark running" 是一条无条件
// `db.update(tasks).set({ status: 'running' })`，导致：
//   1. 已 canceled 的任务被直接复活并跑到 done（终态不设防）；
//   2. 已 done 的任务被重新进入、重新铸 node_runs 跑一遍；
//   3. status='running'（语义上已有另一个调度器实例持有）的任务被静默接管
//      ——这正是 S-8 "并发 resume/retry 起两个调度器双写同一 worktree" 的入口面。
//
// RFC-097 修复（services/scheduler.ts runTask "3. Mark running"）：
//   `trySetTaskStatus({ to: 'running', allowedFrom: ['pending'] })`，
//   CAS 失败（终态 / 已 running / 任意非 pending）→ log + return，
//   不铸任何 node_runs、不覆写 finishedAt / errorSummary。
//
// 本文件即原 FLIP 指引的落地：断言全部翻转为「状态保持原值 / 零新铸
// node_runs / runTask 拒绝执行」。任何 refactor 把 runTask 入口的 CAS 拿掉
// （或放宽 allowedFrom），这里会立刻翻红。
// 末尾的 positive control（pending 任务正常跑到 done）证明零行断言不是
// 因 harness 失效而空洞为绿。
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
    cleanup: () => rimrafDir(appHome),
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
  status: 'pending' | 'canceled' | 'done' | 'running',
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

describe('RFC-097 guard: runTask entry CAS (allowedFrom={pending}) — no revival, no takeover', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('canceled task stays canceled — runTask refuses, zero node_runs minted', async () => {
    const staleFinishedAt = Date.now() - 60_000
    const taskId = await seedTaskWithStatus(h, 'canceled', {
      finishedAt: staleFinishedAt,
      errorSummary: 'canceled',
    })

    await invokeRunTask(h, taskId)

    const row = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    // 终态设防：runTask 入口 CAS from={pending} 失败 → log + return。
    expect(row?.status).toBe('canceled')
    // 终结写没有重新发生：finishedAt / errorSummary 保持取消时代原值。
    expect(row?.finishedAt).toBe(staleFinishedAt)
    expect(row?.errorSummary).toBe('canceled')

    // 被拒绝的调用不得铸任何 node_runs（含 input/output 虚拟行）。
    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    expect(runs.length).toBe(0)
  })

  test('done (terminal) task is not re-entered — finishedAt untouched, zero node_runs minted', async () => {
    const staleFinishedAt = 1_000 // 远古时间戳：任何覆写都会暴露
    const taskId = await seedTaskWithStatus(h, 'done', { finishedAt: staleFinishedAt })

    await invokeRunTask(h, taskId)

    const row = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(row?.status).toBe('done')
    expect(row?.finishedAt).toBe(staleFinishedAt)

    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    expect(runs.length).toBe(0)
  })

  test('running task (owned by another scheduler) — second runTask is a no-op', async () => {
    // 直接 insert status='running' 的任务行：模拟另一个调度器实例已持有。
    // runTask 入口 CAS from={pending} 看到 'running' 即失败返回，不接管。
    const taskId = await seedTaskWithStatus(h, 'running')

    await invokeRunTask(h, taskId)

    const row = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    // 状态仍归第一实例所有；本次调用零副作用（不翻状态、不终结）。
    expect(row?.status).toBe('running')
    expect(row?.finishedAt).toBeNull()

    // 第二实例不再独立铸整套行——"同一节点铸两份行"的入口面已封死。
    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    expect(runs.length).toBe(0)
  })

  test('positive control: pending task is claimed and driven to done (2 virtual node_runs)', async () => {
    // 证明上面三条的"零行 / 状态不变"不是 harness 失效的空洞绿：
    // 同一 harness 下合法的 pending 任务必须照常被认领并跑完。
    const taskId = await seedTaskWithStatus(h, 'pending')

    await invokeRunTask(h, taskId)

    const row = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(row?.status).toBe('done')
    expect(row?.finishedAt ?? 0).toBeGreaterThan(0)

    const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    // 最小 in→out 工作流恰好铸 2 行虚拟 node_runs（input + output 各 1，均 done）。
    expect(runs.length).toBe(2)
    expect(runs.map((r) => r.nodeId).sort()).toEqual(['in', 'out'])
    expect(runs.every((r) => r.status === 'done')).toBe(true)
  })
})
