// RFC-230 PR-2 — wrapper 收尾撞上外部合法终态时必须收敛，而不是把整条任务炸成
// `scheduler error`。
//
// 为什么这条测试存在（锁的是哪类回归）：
// 事故原文 `node_run <id> is terminal ('interrupted'); refuse to overwrite
// (wrapper-finalize)` —— markWrapperTerminal 假设自己是这一行唯一的写者。但用户
// 取消、诊断修复、孤儿回收都**有权**先把它落定；真相并不冲突，冲突的是这个假设。
// PR-1 根除了「孤儿回收器误判 wrapper 已死」这个源头，本文件锁的是第二道防线：
// 即使别的合法写者抢先，任务也要收敛到那个终态并留痕。
//
// 反向同样上锁：真正的数据不一致（例如已 done 又要写 failed）**仍然**大声抛出，
// 不许被这套收敛掩盖 —— 见文末的源码层断言。

import { readFileSync } from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { transitionNodeRunStatus } from '../src/services/lifecycle'
import { runTask } from '../src/services/scheduler'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')
const SCHEDULER_SRC = resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc230-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  return {
    db: createInMemoryDb(MIGRATIONS),
    appHome,
    worktreePath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgent(db: DbClient, name: string, outputs: string[]): Promise<void> {
  await db.insert(agents).values({
    id: `agent-${name}`,
    name,
    description: 'test',
    outputs: JSON.stringify(outputs),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

/** wrapper-fanout（无 aggregator）包一个 agent，单分片即可复现收尾竞态。 */
function fanoutDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'docs', label: 'docs' }],
    nodes: [
      { id: 'inp', kind: 'input', inputKey: 'docs' },
      {
        id: 'fan',
        kind: 'wrapper-fanout',
        nodeIds: ['inner'],
        inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
      },
      {
        id: 'inner',
        kind: 'agent-single',
        agentId: 'agent-worker',
        agentName: 'worker',
        promptTemplate: 'Process {{doc}}',
      },
    ] as unknown as WorkflowDefinition['nodes'],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'inp', portName: 'docs' },
        target: { nodeId: 'fan', portName: 'docs' },
      },
      {
        id: 'eB',
        source: { nodeId: 'fan', portName: 'docs' },
        target: { nodeId: 'inner', portName: 'doc' },
        boundary: 'wrapper-input',
      },
    ],
  }
}

async function seedTask(h: Harness, definition: WorkflowDefinition): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/repo',
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: JSON.stringify({ docs: 'a.md' }),
    startedAt: Date.now(),
  })
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

/**
 * 等 wrapper 行进入 running，然后像孤儿回收器 / 诊断修复那样把它翻成终态 ——
 * 走真实的 lifecycle 转移，不是直写。
 */
async function supersedeWrapperWhenRunning(
  db: DbClient,
  taskId: string,
  event: { kind: 'mark-interrupted' } | { kind: 'mark-canceled'; reason?: string },
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const rows = await db
      .select({ id: nodeRuns.id, status: nodeRuns.status })
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'fan')))
    const running = rows.find((r) => r.status === 'running')
    if (running !== undefined) {
      await transitionNodeRunStatus({ db, nodeRunId: running.id, event })
      return
    }
    await Bun.sleep(10)
  }
  throw new Error('wrapper row never reached running — fixture broken')
}

describe('RFC-230 — wrapper finalize 撞上外部终态', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => {
    h.cleanup()
  })

  test('外部翻成 interrupted：任务收敛到该终态，不产生 scheduler error', async () => {
    await seedAgent(h.db, 'worker', ['result'])
    const taskId = await seedTask(h, fanoutDef())
    const superseder = supersedeWrapperWhenRunning(h.db, taskId, { kind: 'mark-interrupted' })

    await withEnv(
      {
        MOCK_OPENCODE_DELAY_MS: '400',
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ result: 'ok' }),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          binaryOverride: ['bun', 'run', MOCK_OPENCODE],
        }),
    )
    await superseder

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    // 头号断言：这正是事故里那条任务级失败摘要，必须消失。
    expect(t?.errorSummary).not.toBe('scheduler error')
    expect(t?.errorMessage ?? '').not.toContain('refuse to overwrite')
    expect(t?.errorMessage).toBe('wrapper-superseded-interrupted')
    // 任务级映射必须明确：interrupted 抢先 → 任务收在 failed（同样可 resume），
    // 而不是假装 done 让被打断的工作绿色收场。
    expect(t?.status).toBe('failed')
    // wrapper 行保持外部写者落定的终态，没有被收尾覆盖。
    const fan = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'fan')))
    )[0]
    expect(fan?.status).toBe('interrupted')
  })

  test('外部翻成 canceled：任务收敛为 canceled', async () => {
    await seedAgent(h.db, 'worker', ['result'])
    const taskId = await seedTask(h, fanoutDef())
    const superseder = supersedeWrapperWhenRunning(h.db, taskId, {
      kind: 'mark-canceled',
      reason: 'user cancel',
    })

    await withEnv(
      {
        MOCK_OPENCODE_DELAY_MS: '400',
        MOCK_OPENCODE_OUTPUTS: JSON.stringify({ result: 'ok' }),
      },
      () =>
        runTask({
          taskId,
          db: h.db,
          appHome: h.appHome,
          binaryOverride: ['bun', 'run', MOCK_OPENCODE],
        }),
    )
    await superseder

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    expect(t?.status).toBe('canceled')
    expect(t?.errorSummary).not.toBe('scheduler error')
  })

  test('源码层兜底：只有 canceled / interrupted 会被收敛，其余非法转移仍原样抛出', () => {
    const src = readFileSync(SCHEDULER_SRC, 'utf8')
    const fn = src.slice(
      src.indexOf('async function supersedingWrapperOutcome'),
      src.indexOf('async function markWrapperTerminal'),
    )
    expect(fn.length).toBeGreaterThan(0)
    // 收敛集恰为两员。多一个成员（尤其 done / failed）就会把真正的数据不一致
    // 变成静默通过 —— 那是本 RFC 明确拒绝的方向。
    const statuses = [...fn.matchAll(/cur\.status === '([a-z_]+)'/g)].map((m) => m[1])
    expect(statuses.sort()).toEqual(['canceled', 'interrupted'])
    // 收敛路径必须原样抛出非收敛错误。
    expect(fn.includes('return null')).toBe(true)
    expect(src.includes('if (outcome === null) throw err')).toBe(true)
  })
})
