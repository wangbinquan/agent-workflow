// RFC-276 回归锁 —— readonly script 节点在真 git 工作区任务里必须正常收口。
//
// 为什么这条测试存在：commit 70deb522（RFC-276 retire hardening paths）把
// readonly script 从「贴 canonical 原地跑（merge_state 恒 NULL）」改成「一律建
// iso 工作区、成功后丢弃不合回」，但丢弃路径没有 settle merge_state——
// persistIsoBase 盖下的 'isolating' 永远留在 done 行上。deriveFrontier 的 D15
// settled 门（done 行只有 merge_state ∈ {NULL, merged} 才算完成）于是永远不放行，
// 任务以「scheduler stalled — blocked nodes: sc(done: stale-done-in-invocation-
// dedup) / no ready nodes in scope」收场。用户现场即 webhook 触发含 readonly
// script 的工作流（webhook 只是入口，任何真 git 工作区 + readonly script 都中）。
// 修复：新增 merge_state 事件 'discard-readonly'（isolating → merged，零 delta
// 直达代终点，不经 pending-merge 以免 entry replay 把只读写入合回 canonical），
// runOneScriptAttempt 在 done 落库前触发它。
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTaskWithRealTestTopology as runTask } from './helpers/taskExecutionTestTopology'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  cleanup: () => void
}

/** 真 git 仓 canonical 工作区 —— readonly 停滞只在非 passthrough iso 下触发。 */
function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc276-ro-script-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const git = (...args: string[]): void => {
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', '-C', worktreePath, ...args],
      { stdio: 'ignore' },
    )
  }
  git('init', '-b', 'main')
  writeFileSync(join(worktreePath, 'seed.txt'), 'seed\n')
  git('add', '.')
  git('commit', '-m', 'seed')
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

function scriptDef(readonly: boolean): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      {
        id: 'sc',
        kind: 'script',
        language: 'bash',
        script: 'echo artifact > artifact.txt && echo ok',
        readonly,
      },
    ] as unknown as WorkflowDefinition['nodes'],
    edges: [],
  }
}

async function seedWorkflowAndTask(h: Harness, definition: WorkflowDefinition): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: `wf-${workflowId}`,
    definition: JSON.stringify(definition),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    name: 'rfc276-readonly-script',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: h.worktreePath,
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

describe('RFC-276 regression · readonly script in a real git worktree settles instead of stalling', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => {
    h.cleanup()
  })

  test('readonly script → task done, merge_state merged, artifact NOT merged back', async () => {
    const taskId = await seedWorkflowAndTask(h, scriptDef(true))
    await runTask({
      taskId,
      db: h.db,
      appHome: h.appHome,
      maxConcurrentNodes: 1,
      maxConcurrentScriptNodes: 1,
    })
    const task = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    // 回归前：failed + 「scheduler stalled … no ready nodes in scope」。
    expect(task.status).toBe('done')
    expect(task.errorMessage ?? null).toBeNull()
    const run = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId)))[0]!
    expect(run.status).toBe('done')
    // done 行必须落在 settled 态（D15 门），且 readonly 的 delta 不得进 canonical。
    expect(run.mergeState).toBe('merged')
    expect(existsSync(join(h.worktreePath, 'artifact.txt'))).toBe(false)
  }, 30_000)

  test('non-readonly control · merge-back still lands the artifact and settles merged', async () => {
    const taskId = await seedWorkflowAndTask(h, scriptDef(false))
    await runTask({
      taskId,
      db: h.db,
      appHome: h.appHome,
      maxConcurrentNodes: 1,
      maxConcurrentScriptNodes: 1,
    })
    const task = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    expect(task.status).toBe('done')
    const run = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId)))[0]!
    expect(run.status).toBe('done')
    expect(run.mergeState).toBe('merged')
    expect(existsSync(join(h.worktreePath, 'artifact.txt'))).toBe(true)
  }, 30_000)
})
