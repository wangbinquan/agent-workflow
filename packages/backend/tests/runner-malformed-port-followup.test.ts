import { rimrafDir } from './helpers/cleanup'
// 损坏端口急修（2026-06-24）— runner 把「开了 <port> 但 </port> 闭合损坏」的信封
// 判为可重试 failed，而非静默 done+空端口。
//
// 为什么这条测试存在：用户报「agent 输出里闭合标签被污染成 `</|DSML|port>`（模型漏出
// special token），parseEnvelope 的 indexOf('</port>') 字面匹配失败 → 端口被吞成空串 →
// 节点 done → 下游文档审核节点拿到空输入、不产审核文档；且 agent 不重试」。
//
// 关键点：本测试用的 agent 端口**没有声明 outputKind**——这正是 RFC-049 端口校验
// 覆盖不到的缺口（runner 对 kind===undefined 直接 continue）。所以这里 failed 完全
// 由新的 malformed-port 守卫产生，证明修复对 string/markdown/无 kind 端口都生效。
//
// errorMessage 以 `envelope-port-malformed` 前缀收尾，decideEnvelopeFollowup
// (scheduler-envelope-followup-branch.test.ts) 据此前缀 + 本测试断言的 sessionId/agentText
// 触发同会话重试——两条测试合起来闭环「producer 失败 → 重试」。

import type { Agent } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runNode } from '../src/services/runner'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MOCK_OPENCODE = resolve(import.meta.dir, 'fixtures', 'mock-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  taskId: string
  cleanup: () => void
}

// Agent declares ONE text port with NO outputKind — the exact case RFC-049
// port-validation does not cover (so the malformed-port guard is the only thing
// that can fail it).
function makeAgent(): Agent {
  return {
    id: ulid(),
    name: 'test-agent',
    description: '',
    outputs: ['doc'],
    outputKinds: {},
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as Agent
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-malformed-port-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/repo',
    worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return {
    db,
    appHome,
    worktreePath,
    taskId,
    cleanup: () => rimrafDir(appHome),
  }
}

async function insertNodeRun(db: DbClient, taskId: string): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: 'n1',
    status: 'pending',
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
  })
  return id
}

function withEnv<T>(env: Record<string, string>, body: () => Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k]
    process.env[k] = env[k]
  }
  return body().finally(() => {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  })
}

describe('runner malformed-port guard', () => {
  let h: Harness

  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => {
    h.cleanup()
  })

  test('corrupted </port> close (</|DSML|port>) on a no-kind port → failed + envelope-port-malformed, nothing persisted', async () => {
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    // The agent emitted a valid <workflow-output> wrapper, but the port's close
    // tag is corrupted — exactly the user's `</|DSML|port>` report.
    const rawText = `<workflow-output>\n<port name="doc">report.md</|DSML|port>\n</workflow-output>`
    const result = await withEnv(
      {
        MOCK_OPENCODE_RAW_AGENT_TEXT: rawText,
        MOCK_OPENCODE_EVENTS: '[]',
        MOCK_OPENCODE_EMIT_SESSION_ID: '1',
        OPENCODE_TEST_HOME: join(h.appHome, 'no-home'),
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          nodeId: 'n1',
          agent: makeAgent(),
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
        }),
    )

    expect(result.status).toBe('failed')
    expect(result.errorMessage).toContain('envelope-port-malformed')
    expect(result.errorMessage).toContain('doc')
    // followup preconditions: clean exit captured a session + agent text, so
    // decideEnvelopeFollowup (tested separately) WILL drive a same-session retry.
    expect(result.exitCode).toBe(0)
    expect(result.sessionId).toBeDefined()

    const row = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)))[0]!
    expect(row.status).toBe('failed')
    // The malformed port must NOT have been persisted as a blank row — a ghost
    // empty row is exactly what made the downstream review node silently no-op.
    const outputs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, nodeRunId))
    expect(outputs).toHaveLength(0)
  })

  test('contrast: a well-formed envelope on the same no-kind port → done + persisted', async () => {
    const nodeRunId = await insertNodeRun(h.db, h.taskId)
    const rawText = `<workflow-output>\n<port name="doc">report.md</port>\n</workflow-output>`
    const result = await withEnv(
      {
        MOCK_OPENCODE_RAW_AGENT_TEXT: rawText,
        MOCK_OPENCODE_EVENTS: '[]',
        OPENCODE_TEST_HOME: join(h.appHome, 'no-home'),
      },
      () =>
        runNode({
          taskId: h.taskId,
          nodeRunId,
          nodeId: 'n1',
          agent: makeAgent(),
          inputs: {},
          worktreePath: h.worktreePath,
          templateMeta: { repoPath: '/tmp/repo', baseBranch: 'main', taskId: h.taskId },
          skills: [],
          appHome: h.appHome,
          opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
          db: h.db,
        }),
    )

    expect(result.status).toBe('done')
    const outputs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, nodeRunId))
    expect(outputs).toHaveLength(1)
    expect(outputs[0]!.portName).toBe('doc')
    expect(outputs[0]!.content).toBe('report.md')
  })
})
