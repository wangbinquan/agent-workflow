// RFC-098 B3 (audit S-7) — loop/git wrapper provenance oracles.
//
// 锁定两组修复语义（survey §wp6c-loopgit 一节 + 对抗检视修订 #6）：
//
// 1. 后果链（stale → 重派 → 新 wrapper 代）：上游节点 rerun（这里用直接插入
//    更新代 done 行模拟 clarify 答复后的 rerun——freshness 机器只看行形态，
//    不关心铸行者）后，loop/git wrapper 的 done 行因 fresh-mint 时写入的
//    consumedUpstreamRunsJson 判 stale → 重派 → findResumableWrapperRun 视
//    done 为 terminal → 铸全新 wrapper 行：loop 从 iteration 0 整体重跑、git
//    重抓 baseline（progress.baseline 换成新 HEAD）。S-7 修复前 consumed 恒
//    NULL → 恒 fresh → 本文件第 1/2 用例的第二代 wrapper 行不会存在。
//
// 2. resume 不覆盖 consumed（修订 #6 语义锁）：loop/git wrapper 从
//    interrupted（daemon-restart 形态，仿 scheduler-boundary-wrapper-resume-
//    interrupted 的 seed 手法）复活续跑时，**不得**重算/覆盖写行上已有的
//    consumed——覆盖写会把停泊期间外部源 rerun 的事实永久掩盖（语义随调度
//    时序漂移）。哨兵 key 指向不存在的节点：isNodeRunFresh 对 absent 上游
//    恒 fresh，所以哨兵不会引发 stale 重派，但任何 resume 路径的覆盖写都会
//    把它抹成重算结果（'{}'），立刻翻红。
//
// 顺序保证：真实数据边 up → inner 由作用域投影提升为父作用域的 up → wrapper
// 依赖；不再添加一个 wrapper 根本不会读取、且 validator 会拒绝的伪排序边。
// wrapperExternalUpstreamSources 同样从这条真实跨作用域边提取 provenance，
// 确保调度顺序与 freshness 读取同一份结构语义。
//
// 确定性：本地 git init/commit、无网络、无 sleep；第二次 runTask 前直接把
// task 行翻回 pending（s18-s19 test 2 同款复刻，resumeTask 对 runTask 是
// fire-and-forget 无法确定性等待）。

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runTask } from '../src/services/scheduler'
import { decodeWrapperProgress } from '../src/services/wrapperProgress'
import { runGit } from '../src/util/git'

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

async function buildHarness(slug: string): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), `aw-rfc098-stale-${slug}-`))
  const repoPath = join(appHome, 'repo')
  const worktreePath = join(appHome, 'wt')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(worktreePath, { recursive: true })
  await runGit(worktreePath, ['init', '-q', '-b', 'main'])
  await runGit(worktreePath, ['config', 'user.email', 't@t.test'])
  await runGit(worktreePath, ['config', 'user.name', 't'])
  writeFileSync(join(worktreePath, 'base.txt'), 'baseline\n')
  await runGit(worktreePath, ['add', '.'])
  await runGit(worktreePath, ['commit', '-q', '-m', 'init'])
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    worktreePath,
    repoPath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedReadonlyAgent(db: DbClient, name: string, outputs: string[]): Promise<void> {
  await db.insert(agents).values({
    id: ulid(),
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

async function seedWorkflowAndTask(h: Harness, definition: WorkflowDefinition): Promise<string> {
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
    name: 'rfc098-stale-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: h.repoPath,
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: '{}',
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

/** 复刻 resumeTask 的 DB 侧动作后直接 await runTask（s18-s19 同款）。 */
async function resetTaskToPending(h: Harness, taskId: string): Promise<void> {
  await h.db
    .update(tasks)
    .set({
      status: 'pending',
      finishedAt: null,
      errorSummary: null,
      errorMessage: null,
      failedNodeId: null,
    })
    .where(eq(tasks.id, taskId))
}

/** 模拟上游 clarify rerun：为 nodeId 插入一行更新代 done 行（更大 ULID）+ 输出。 */
async function mintFresherUpstreamDone(
  h: Harness,
  taskId: string,
  nodeId: string,
  port: string,
  content: string,
): Promise<string> {
  const id = ulid()
  const now = Date.now()
  await h.db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    parentNodeRunId: null,
    shardKey: null,
    consumedUpstreamRunsJson: '{}',
    startedAt: now,
    finishedAt: now,
  })
  await h.db.insert(nodeRunOutputs).values({ nodeRunId: id, portName: port, content })
  return id
}

async function rowsOf(h: Harness, taskId: string, nodeId: string) {
  return h.db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
}

describe('RFC-098 B3 (S-7) — 上游 rerun 后 loop/git wrapper 判 stale 重派', () => {
  let h: Harness
  afterEach(() => h.cleanup())

  test('loop wrapper：第二次调度铸全新 wrapper 代，consumed 绑到上游新行', async () => {
    h = await buildHarness('loop')
    await seedReadonlyAgent(h.db, 'up-agent', ['doc'])
    await seedReadonlyAgent(h.db, 'auditor', ['doc', 'findings'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'up', kind: 'agent-single', agentName: 'up-agent' },
        { id: 'audit', kind: 'agent-single', agentName: 'auditor' },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['audit'],
          maxIterations: 2,
          exitCondition: { kind: 'port-empty', nodeId: 'audit', portName: 'findings' },
          outputBindings: [],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'up', portName: 'doc' },
          target: { nodeId: 'audit', portName: 'doc' },
        },
      ],
    }
    const taskId = await seedWorkflowAndTask(h, def)
    const env = { MOCK_OPENCODE_OUTPUTS: JSON.stringify({ doc: 'v1', findings: '' }) }
    const runOpts = {
      taskId,
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
    }

    // ---- run 1：consumed 绑到 up 的第一代 done 行。----
    await withEnv(env, () => runTask(runOpts))
    expect((await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe('done')
    const upRun1 = (await rowsOf(h, taskId, 'up')).find((r) => r.status === 'done')!
    const loopGen1 = await rowsOf(h, taskId, 'loop')
    expect(loopGen1.length).toBe(1)
    expect(loopGen1[0]?.status).toBe('done')
    expect(JSON.parse(loopGen1[0]?.consumedUpstreamRunsJson ?? 'null')).toEqual({
      up: upRun1.id,
    })

    // ---- 上游 rerun + resume。----
    const upRun2Id = await mintFresherUpstreamDone(h, taskId, 'up', 'doc', 'v2')
    await resetTaskToPending(h, taskId)
    await withEnv(env, () => runTask(runOpts))

    // ---- 后果链断言：done∧stale → 重派 → 全新 wrapper 代（done 是 terminal，
    // findResumableWrapperRun 不复用旧行），新代 consumed 绑到 up 的新行。----
    expect((await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe('done')
    const loopRows = await rowsOf(h, taskId, 'loop')
    expect(loopRows.length).toBe(2)
    const gen2 = loopRows.reduce((a, b) => (a.id > b.id ? a : b))
    expect(gen2.id).not.toBe(loopGen1[0]!.id)
    expect(gen2.status).toBe('done')
    expect(JSON.parse(gen2.consumedUpstreamRunsJson ?? 'null')).toEqual({ up: upRun2Id })
    // 第一代行原样保留（历史不可变）。
    const gen1After = loopRows.find((r) => r.id === loopGen1[0]!.id)!
    expect(JSON.parse(gen1After.consumedUpstreamRunsJson ?? 'null')).toEqual({ up: upRun1.id })
  }, 20000)

  test('git wrapper：第二次调度铸全新 wrapper 代并重抓 baseline（新 HEAD）', async () => {
    h = await buildHarness('git')
    await seedReadonlyAgent(h.db, 'up-agent', ['doc'])
    await seedReadonlyAgent(h.db, 'fixer', ['doc', 'summary'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'up', kind: 'agent-single', agentName: 'up-agent' },
        { id: 'fix', kind: 'agent-single', agentName: 'fixer' },
        { id: 'wg', kind: 'wrapper-git', nodeIds: ['fix'] },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'up', portName: 'doc' },
          target: { nodeId: 'fix', portName: 'doc' },
        },
      ],
    }
    const taskId = await seedWorkflowAndTask(h, def)
    const env = { MOCK_OPENCODE_OUTPUTS: JSON.stringify({ doc: 'v1', summary: 'ok' }) }
    const runOpts = {
      taskId,
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
    }

    // ---- run 1。----
    await withEnv(env, () => runTask(runOpts))
    expect((await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe('done')
    const head1 = (await runGit(h.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()
    const upRun1 = (await rowsOf(h, taskId, 'up')).find((r) => r.status === 'done')!
    const wgGen1 = (await rowsOf(h, taskId, 'wg'))[0]!
    expect(wgGen1.status).toBe('done')
    expect(JSON.parse(wgGen1.consumedUpstreamRunsJson ?? 'null')).toEqual({ up: upRun1.id })
    const prog1 = decodeWrapperProgress(wgGen1.wrapperProgressJson, () => {})
    expect((prog1 as { baseline?: string })?.baseline).toBe(head1)

    // ---- HEAD 推进（模拟两次运行之间 worktree 上的真实 commit）+ 上游 rerun。----
    writeFileSync(join(h.worktreePath, 'advanced.txt'), 'advance\n')
    await runGit(h.worktreePath, ['add', '.'])
    await runGit(h.worktreePath, ['commit', '-q', '-m', 'advance'])
    const head2 = (await runGit(h.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()
    expect(head2).not.toBe(head1)
    const upRun2Id = await mintFresherUpstreamDone(h, taskId, 'up', 'doc', 'v2')
    await resetTaskToPending(h, taskId)
    await withEnv(env, () => runTask(runOpts))

    // ---- 后果链断言：新 wrapper 代重抓 baseline = 新 HEAD（不是沿用旧
    // baseline——那会把代际间的真实 commit 误算进第二代 git_diff）。----
    expect((await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe('done')
    const wgRows = await rowsOf(h, taskId, 'wg')
    expect(wgRows.length).toBe(2)
    const gen2 = wgRows.reduce((a, b) => (a.id > b.id ? a : b))
    expect(gen2.id).not.toBe(wgGen1.id)
    expect(gen2.status).toBe('done')
    expect(JSON.parse(gen2.consumedUpstreamRunsJson ?? 'null')).toEqual({ up: upRun2Id })
    const prog2 = decodeWrapperProgress(gen2.wrapperProgressJson, () => {})
    expect((prog2 as { baseline?: string })?.baseline).toBe(head2)
  }, 20000)
})

describe('RFC-098 B3 修订#6 — resume 不覆盖 wrapper 行的 consumed', () => {
  let h: Harness
  afterEach(() => h.cleanup())

  // 哨兵：指向不存在节点的 consumed。absent 上游恒 fresh（freshness B1 同族）
  // → 不会引发 stale 重派；但 resume 路径任何"重算覆盖写"都会把它变成 '{}'。
  const SENTINEL = JSON.stringify({ __ghost_source__: '01GHOSTRUN' })

  async function seedInterruptedWrapper(
    taskId: string,
    nodeId: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const id = ulid()
    const now = Date.now()
    await h.db.insert(nodeRuns).values({
      id,
      taskId,
      nodeId,
      status: 'interrupted',
      retryIndex: 0,
      iteration: 0,
      parentNodeRunId: null,
      shardKey: null,
      consumedUpstreamRunsJson: SENTINEL,
      startedAt: now,
      finishedAt: now,
      ...extra,
    })
    return id
  }

  test('loop wrapper：interrupted 复活续跑后 consumed 原封不动（且不铸新行）', async () => {
    h = await buildHarness('resume-loop')
    await seedReadonlyAgent(h.db, 'auditor', ['findings'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'audit', kind: 'agent-single', agentName: 'auditor' },
        {
          id: 'loop',
          kind: 'wrapper-loop',
          nodeIds: ['audit'],
          maxIterations: 2,
          exitCondition: { kind: 'port-empty', nodeId: 'audit', portName: 'findings' },
          outputBindings: [],
        },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [],
    }
    const taskId = await seedWorkflowAndTask(h, def)
    const seededId = await seedInterruptedWrapper(taskId, 'loop')

    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ findings: '' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    expect((await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe('done')
    const loopRows = await rowsOf(h, taskId, 'loop')
    expect(loopRows.length).toBe(1) // 同行续跑，零新铸
    expect(loopRows[0]?.id).toBe(seededId)
    expect(loopRows[0]?.status).toBe('done')
    expect(loopRows[0]?.consumedUpstreamRunsJson).toBe(SENTINEL)
  })

  test('git wrapper：interrupted 复活续跑后 consumed 原封不动（baseline 沿用 progress）', async () => {
    h = await buildHarness('resume-git')
    await seedReadonlyAgent(h.db, 'fixer', ['summary'])
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'fix', kind: 'agent-single', agentName: 'fixer' },
        { id: 'wg', kind: 'wrapper-git', nodeIds: ['fix'] },
      ] as unknown as WorkflowDefinition['nodes'],
      edges: [],
    }
    const taskId = await seedWorkflowAndTask(h, def)
    const head = (await runGit(h.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()
    const seededId = await seedInterruptedWrapper(taskId, 'wg', {
      wrapperProgressJson: JSON.stringify({
        kind: 'git',
        baseline: head,
        preDirty: {},
        phase: 'inner-running',
      }),
    })

    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ summary: 'ok' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    expect((await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]?.status).toBe('done')
    const wgRows = await rowsOf(h, taskId, 'wg')
    expect(wgRows.length).toBe(1)
    expect(wgRows[0]?.id).toBe(seededId)
    expect(wgRows[0]?.status).toBe('done')
    expect(wgRows[0]?.consumedUpstreamRunsJson).toBe(SENTINEL)
    // baseline 沿用 progress（resume 不重抓——rfc040 闸的同款语义）。
    const prog = decodeWrapperProgress(wgRows[0]!.wrapperProgressJson, () => {})
    expect((prog as { baseline?: string })?.baseline).toBe(head)
  })
})
