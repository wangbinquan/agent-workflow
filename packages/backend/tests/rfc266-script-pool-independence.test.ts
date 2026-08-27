// RFC-266 —— 脚本节点跑在**独立**的 daemon 池里，不与 agent 互相排队。
//
// 为什么这些测试存在：RFC-253 让脚本节点复用了 agent 分支的同一批原语，其中包括
// 那把全局信号量——脚本分支与 agent 分支取的是同一个 `globalSem`，于是 4 个多分钟
// 的审计 agent 占满名额时，一个秒级的脚本节点也得干等。用户报此为缺陷，RFC-266
// 拆成两个互不相干的池。
//
// 断言手法刻意**不用墙钟**：墙钟在负载高的 CI 上既会假红也会假绿。这里由测试
// 本身在**池外**占住某一个池的全部名额，再驱动一个只含另一类节点的任务——
// 独立 ⇒ 任务照常跑完；退回共享一池 ⇒ 任务永远拿不到名额，测试超时失败。
// 第三条反向锁住「脚本确实排在脚本池上」，防止有人把取闸整段删掉后前两条依然绿。

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTaskWithRealTestTopology as runTask } from './helpers/taskExecutionTestTopology'
import { getNodePoolSemaphore } from '../src/services/processNodeConcurrency'
import { canonicalizeWorkflowAgentIds } from './helpers/canonicalWorkflowFixture'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  cleanup: () => void
}
function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc266-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgent(db: DbClient, name: string): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
    name,
    description: 'test',
    outputs: JSON.stringify(['result']),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}

async function seedWorkflowAndTask(h: Harness, definition: WorkflowDefinition): Promise<string> {
  const canonicalDefinition = await canonicalizeWorkflowAgentIds(h.db, definition)
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: `wf-${workflowId}`,
    definition: JSON.stringify(canonicalDefinition),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    name: 'fixture-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(canonicalDefinition),
    repoPath: '/tmp/repo',
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

/** readonly ⇒ runs in place against the worktree: no iso, no writeSem, fast. */
function scriptOnlyDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'sc', kind: 'script', language: 'bash', script: 'echo ok', readonly: true },
    ] as unknown as WorkflowDefinition['nodes'],
    edges: [],
  }
}

function agentOnlyDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'ag', kind: 'agent-single', agentName: 'worker', promptTemplate: 'go' },
    ] as unknown as WorkflowDefinition['nodes'],
    edges: [],
  }
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

const statusOf = async (h: Harness, taskId: string): Promise<string | undefined> =>
  (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status

describe('RFC-266 script nodes run in their own daemon pool', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => {
    h.cleanup()
  })

  test('a FULL agent pool does not block a script node', async () => {
    // 池外占死 agent 池的唯一名额，全程不释放。
    const agentPool = getNodePoolSemaphore(h.db, 'agent', 1)
    const holdAgentSlot = await agentPool.acquire()
    try {
      const taskId = await seedWorkflowAndTask(h, scriptOnlyDef())
      await runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        maxConcurrentNodes: 1,
        maxConcurrentScriptNodes: 1,
      })
      expect(await statusOf(h, taskId)).toBe('done')
      expect(agentPool.available).toBe(0) // 名额确实一直被占着
    } finally {
      holdAgentSlot()
    }
  }, 30_000)

  test('a FULL script pool does not block an agent node', async () => {
    const scriptPool = getNodePoolSemaphore(h.db, 'script', 1)
    const holdScriptSlot = await scriptPool.acquire()
    try {
      await seedAgent(h.db, 'worker')
      const taskId = await seedWorkflowAndTask(h, agentOnlyDef())
      await withEnv(
        { MOCK_OPENCODE_DELAY_MS: '10', MOCK_OPENCODE_OUTPUTS: JSON.stringify({ result: 'ok' }) },
        () =>
          runTask({
            taskId,
            db: h.db,
            appHome: h.appHome,
            binaryOverride: ['bun', 'run', MOCK_OPENCODE],
            maxConcurrentNodes: 1,
            maxConcurrentScriptNodes: 1,
          }),
      )
      expect(await statusOf(h, taskId)).toBe('done')
      expect(scriptPool.available).toBe(0)
    } finally {
      holdScriptSlot()
    }
  }, 30_000)

  // 反向锁：脚本节点**确实**排在脚本池上。没有这一条，把取闸整段删掉（脚本
  // 完全不限流）也能让上面两条通过。
  test('a FULL script pool DOES block a script node until a slot frees', async () => {
    const scriptPool = getNodePoolSemaphore(h.db, 'script', 1)
    const holdScriptSlot = await scriptPool.acquire()
    const taskId = await seedWorkflowAndTask(h, scriptOnlyDef())
    const run = runTask({
      taskId,
      db: h.db,
      appHome: h.appHome,
      maxConcurrentNodes: 4,
      maxConcurrentScriptNodes: 1,
    })

    await Bun.sleep(400)
    // 名额没让出来，脚本必须还在排队 —— 任务不可能已经收尾。
    expect(await statusOf(h, taskId)).toBe('running')
    const queued = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    expect(queued.every((r) => r.status === 'pending')).toBe(true)

    holdScriptSlot() // 让出名额
    await run
    expect(await statusOf(h, taskId)).toBe('done')
  }, 30_000)
})
