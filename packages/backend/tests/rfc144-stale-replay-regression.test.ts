// RFC-144 T4 — stale replay 回归（先红后绿）+ merge-failed 行为缺口补齐。
//
// 为什么这条测试存在（锁 design/RFC-144-merge-state-machine/design.md §7）：
// runTask 入口的 replayPendingMerges / replayConflictHumanResolutions 只按
// (taskId, merge_state) 捞行，而 retry/review 取代路径从不清理旧行的
// merge_state——被取代的 pending-merge 旧行会在下一次任务入口被重放，把
// **过期 delta 物化进主树**（RFC-144 落地前本文件的场景 A / mint 收口 /
// D19 用例为红）。修复 = mint 收口点（mintNodeRun 单事务 abandon+insert，
// D12）把前代行及其子行打到 'abandoned'，replay 天然不捞。
//
//   A. e2e：done+pending-merge 崩溃窗口行被 retryNode 取代 → 旧 delta 不得
//      物化进 canonical、旧行落 abandoned、新一代正常跑完（修复前：旧行被
//      replay 成 merged、produced.txt 幽灵出现在主树）。
//   B/C. mint 收口：mintNodeRun 铸后代行原子废弃同代前代 top-level 行 +
//      前代父行的子行闭包（(b) 支，fanout shard resume 双重应用的根）。
//   D19. abandon 是纯列写入：clarify 保留的 iso worktree 目录不得被删
//      （答后内联续跑复用它）。
//   MF. merge-failed 行为补齐（RFC-130 测试缺口 + isolating→merge-failed
//      新边）：agent 成功但 snapshot-pin/merge-back 抛错 → 行 merge-failed、
//      任务 fail-loud（而非 done+isolating 卡 blocked 桶）。
//   源码锁：mintNodeRun 必须在 dbTxSync 内先 abandon 再 insert（P1-1）；
//      taskQuestionDispatch 的同步 mint 同样接线。

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  createNodeIso,
  discardNodeIso,
  snapshotNodeIsoFinal,
  type CanonRepo,
} from '../src/services/nodeIsolation'
import { mintNodeRun } from '../src/services/nodeRunMint'
import { createOrRebuildWrapperIso, deriveFrontier, runTask } from '../src/services/scheduler'
import { transitionMergeState } from '../src/services/lifecycle'
import { retryNode } from '../src/services/task'
import { createLogger } from '../src/util/log'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const BACKEND_SRC = resolve(import.meta.dir, '..', 'src')

/** 定长补零 id：字典序 = 数值序（早于任何真 ulid），控制「谁是前代」。 */
const mkId = (n: number): string => String(n).padStart(26, '0')

interface Harness {
  db: DbClient
  appHome: string
  worktreePath: string
  cleanup: () => void
}

async function buildGitHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc144-stale-'))
  const worktreePath = join(appHome, 'wt')
  mkdirSync(worktreePath, { recursive: true })
  await runGit(worktreePath, ['init', '-q', '-b', 'main'])
  await runGit(worktreePath, ['config', 'user.email', 't@e.com'])
  await runGit(worktreePath, ['config', 'user.name', 'T'])
  writeFileSync(join(worktreePath, 'base.txt'), 'base\n')
  await runGit(worktreePath, ['add', '.'])
  await runGit(worktreePath, ['commit', '-q', '-m', 'init'])
  return {
    db: createInMemoryDb(MIGRATIONS),
    appHome,
    worktreePath,
    cleanup: () => rmSync(appHome, { recursive: true, force: true }),
  }
}

async function seedAgentWorkflowTask(
  h: Harness,
  status: 'pending' | 'interrupted',
): Promise<{ taskId: string }> {
  await h.db.insert(agents).values({
    id: ulid(),
    name: 'a',
    description: '',
    outputs: JSON.stringify(['summary']),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  const def: WorkflowDefinition = {
    $schema_version: 1,
    inputs: [],
    nodes: [{ id: 'A', kind: 'agent-single', agentName: 'a' }],
    edges: [],
  }
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(def),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await h.db.insert(tasks).values({
    id: taskId,
    name: 'fixture',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: h.worktreePath,
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status,
    inputs: '{}',
    startedAt: Date.now(),
  })
  return { taskId }
}

/** 伪造崩溃窗口：真 iso + 写入产物 + pin node_tree + 丢弃 iso —— 行上只剩 pin。 */
async function fabricateCrashWindowRow(h: Harness, taskId: string, runId: string): Promise<void> {
  const canonRepos: CanonRepo[] = [
    {
      repoPath: h.worktreePath,
      worktreePath: h.worktreePath,
      worktreeDirName: '',
      baseBranch: 'main',
    },
  ]
  const handle = await createNodeIso({ appHome: h.appHome, taskId, nodeRunId: runId, canonRepos })
  writeFileSync(join(handle.repos[0]!.isoWorktreePath, 'produced.txt'), 'stale generation\n')
  const nodeTrees = await snapshotNodeIsoFinal(handle)
  await discardNodeIso(handle)
  await h.db.insert(nodeRuns).values({
    id: runId,
    taskId,
    nodeId: 'A',
    status: 'done', // runner 写了 done…
    startedAt: Date.now() - 1000,
    isoBaseSnapshot: handle.repos[0]!.baseSnapshot,
    isoNodeTree: nodeTrees[''],
    mergeState: 'pending-merge', // …但 merge-back 没跑（daemon 崩溃）
  })
  await h.db.insert(nodeRunOutputs).values({ nodeRunId: runId, portName: 'summary', content: 'ok' })
}

function writeMockAgent(h: Harness, body: string): string {
  const mockPath = join(h.appHome, 'mock-opencode.ts')
  writeFileSync(
    mockPath,
    `// generated by rfc144-stale-replay-regression.test.ts
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function emit(text: string): void {
  process.stdout.write(
    JSON.stringify({ type: 'text', timestamp: Date.now(), part: { type: 'text', text } }) + '\\n',
  )
}
const envelope =
  '<workflow-output>\\n  <port name="summary">fresh ok</port>\\n</workflow-output>'
${body}
process.exit(0)
`,
  )
  return mockPath
}

async function waitForTerminalTask(
  db: DbClient,
  taskId: string,
): Promise<typeof tasks.$inferSelect> {
  for (let i = 0; i < 400; i++) {
    const t = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]
    if (t !== undefined && t.status !== 'pending' && t.status !== 'running') return t
    await Bun.sleep(25)
  }
  throw new Error(`task ${taskId} did not reach a terminal status within budget`)
}

describe('RFC-144 场景 A — retryNode 取代崩溃窗口行后，旧 delta 不得重放进主树', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildGitHarness()
  })
  afterEach(() => h.cleanup())

  test('旧 pending-merge 行 → abandoned；produced.txt 不出现在 canonical；新一代正常跑完', async () => {
    const { taskId } = await seedAgentWorkflowTask(h, 'interrupted')
    const staleId = mkId(1)
    await fabricateCrashWindowRow(h, taskId, staleId)
    expect(existsSync(join(h.worktreePath, 'produced.txt'))).toBe(false)

    // 用户对该节点 retryNode（interrupted 任务允许）——mint 新占位行 + 踢 runTask。
    const mockPath = writeMockAgent(
      h,
      `writeFileSync(join(process.cwd(), 'fresh.txt'), 'fresh generation\\n')
emit(envelope)`,
    )
    await retryNode(h.db, taskId, staleId, {
      cascade: true,
      deps: { db: h.db, appHome: h.appHome, opencodeCmd: ['bun', 'run', mockPath] },
    })
    const final = await waitForTerminalTask(h.db, taskId)
    expect(`${final.status}:${final.errorSummary ?? ''}`).toBe('done:')

    // 核心断言（修复前红）：被取代行的过期 delta 没有被入口 replay 物化。
    expect(existsSync(join(h.worktreePath, 'produced.txt'))).toBe(false)
    const stale = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, staleId)))[0]!
    expect(stale.mergeState).toBe('abandoned') // 修复前：replay 把它推成 'merged'
    expect(stale.status).toBe('done') // abandon 只动 merge_state，不碰 status

    // 新一代正常隔离 + 合并：fresh.txt 落入 canonical。
    expect(readFileSync(join(h.worktreePath, 'fresh.txt'), 'utf-8')).toBe('fresh generation\n')
    const rows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const freshDone = rows.filter(
      (r) => r.nodeId === 'A' && r.status === 'done' && r.id !== staleId,
    )
    expect(freshDone).toHaveLength(1)
    expect(freshDone[0]!.mergeState).toBe('merged')
  }, 30000)
})

describe('RFC-144 mint 收口 — mintNodeRun 原子废弃前代行及其子行', () => {
  let db: DbClient
  let taskId: string
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    const workflowId = ulid()
    await db.insert(workflows).values({
      id: workflowId,
      name: 'w',
      definition: JSON.stringify({ $schema_version: 2, inputs: [], nodes: [], edges: [] }),
    })
    taskId = ulid()
    await db.insert(tasks).values({
      name: 't',
      id: taskId,
      workflowId,
      workflowSnapshot: '{}',
      repoPath: '/nonexistent/rfc144/repo',
      worktreePath: '/nonexistent/rfc144/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
  })

  async function seedRow(opts: {
    id: string
    nodeId?: string
    mergeState?: string | null
    parentNodeRunId?: string | null
  }): Promise<void> {
    await db.insert(nodeRuns).values({
      id: opts.id,
      taskId,
      nodeId: opts.nodeId ?? 'W',
      iteration: 0,
      retryIndex: 0,
      status: 'done',
      mergeState: opts.mergeState ?? null,
      parentNodeRunId: opts.parentNodeRunId ?? null,
      startedAt: Date.now() - 10,
    })
  }

  test('场景 B/C：前代 top-level（conflict-human）+ 其 shard 子行（pending-merge）随 mint 废弃；他节点崩溃窗口行不动', async () => {
    await seedRow({ id: mkId(1), mergeState: 'conflict-human' }) // 前代 wrapper/agent 行
    await seedRow({ id: mkId(2), mergeState: 'pending-merge', parentNodeRunId: mkId(1) }) // 其 shard 子行
    await seedRow({ id: mkId(3), nodeId: 'other', mergeState: 'pending-merge' }) // 他节点合法崩溃窗口行

    await mintNodeRun(db, { taskId, nodeId: 'W', status: 'pending', cause: 'retry-node' })

    const stateOf = async (id: string): Promise<string | null> =>
      (await db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]!.mergeState
    expect(await stateOf(mkId(1))).toBe('abandoned') // 修复前：conflict-human 原样残留
    expect(await stateOf(mkId(2))).toBe('abandoned') // (b) 支：随父废弃
    expect(await stateOf(mkId(3))).toBe('pending-merge') // freshest 他节点行是合法 replay 对象
  })

  test('D19：abandon 是纯列写入——clarify 保留的 iso 目录不被删', async () => {
    const isoDir = mkdtempSync(join(tmpdir(), 'aw-rfc144-d19-'))
    try {
      await db.insert(nodeRuns).values({
        id: mkId(1),
        taskId,
        nodeId: 'W',
        iteration: 0,
        retryIndex: 0,
        status: 'done', // D19：<workflow-clarify> 回复行 done+isolating、iso 保留
        mergeState: 'isolating',
        isoWorktreePath: isoDir,
        parentNodeRunId: null,
        startedAt: Date.now() - 10,
      })
      await mintNodeRun(db, { taskId, nodeId: 'W', status: 'pending', cause: 'clarify-answer' })
      const row = (
        await db
          .select()
          .from(nodeRuns)
          .where(eq(nodeRuns.id, mkId(1)))
      )[0]!
      expect(row.mergeState).toBe('abandoned')
      expect(existsSync(isoDir)).toBe(true) // 目录原封不动（答后续跑还要用）
    } finally {
      rmSync(isoDir, { recursive: true, force: true })
    }
  })
})

describe('RFC-144 wrapper 同行复活的 iso 基（实现门 P2 第二半）', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildGitHarness()
  })
  afterEach(() => h.cleanup())

  function fakeSchedulerState(taskId: string): Parameters<typeof createOrRebuildWrapperIso>[0] {
    return {
      db: h.db,
      taskId,
      task: { repoCount: 1 },
      repos: [
        {
          repoPath: h.worktreePath,
          worktreePath: h.worktreePath,
          worktreeDirName: '',
          baseBranch: 'main',
        },
      ],
      opts: { appHome: h.appHome },
      log: createLogger('rfc144-test'),
    } as unknown as Parameters<typeof createOrRebuildWrapperIso>[0]
  }

  async function seedWrapperTaskRow(): Promise<{ taskId: string; runId: string }> {
    const { taskId } = await seedAgentWorkflowTask(h, 'pending')
    const runId = mkId(1)
    await h.db.insert(nodeRuns).values({
      id: runId,
      taskId,
      nodeId: 'lw',
      iteration: 0,
      retryIndex: 0,
      status: 'running',
      startedAt: Date.now(),
    })
    return { taskId, runId }
  }

  test('merged 再入：弃旧 iso、从当前 canonical 重建全新 base（旧 base 合并会复活被删文件）', async () => {
    const { taskId, runId } = await seedWrapperTaskRow()
    const state = fakeSchedulerState(taskId)
    // gen-1：创建 iso（NULL→isolating + 盖 base 列），随后走完整代到 merged。
    await createOrRebuildWrapperIso(state, runId, null)
    const gen1 = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]!
    expect(gen1.mergeState).toBe('isolating')
    const gen1Base = gen1.isoBaseSnapshot!
    await transitionMergeState({
      db: h.db,
      nodeRunId: runId,
      event: { kind: 'mark-pending-merge' },
    })
    await transitionMergeState({ db: h.db, nodeRunId: runId, event: { kind: 'mark-merged' } })
    // 旧代 git progress（PR-5 复核：必须随 reenter 原子清空，防崩溃窗口漏检）。
    await h.db
      .update(nodeRuns)
      .set({
        wrapperProgressJson: JSON.stringify({
          kind: 'git',
          baseline: gen1Base,
          preDirty: {},
          phase: 'inner-running',
        }),
      })
      .where(eq(nodeRuns.id, runId))
    // canonical 前进（gen-1 的 delta 已并入 canon 的等价物）。
    writeFileSync(join(h.worktreePath, 'gen1-output.txt'), 'merged into canon\n')
    await runGit(h.worktreePath, ['add', '.'])
    await runGit(h.worktreePath, ['commit', '-q', '-m', 'gen1 merged'])
    // 同行复活：merged 再入必须换新 base。
    const handle = await createOrRebuildWrapperIso(state, runId, {
      isoBaseSnapshot: gen1Base,
      isoBaseSnapshotReposJson: null,
    })
    const after = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]!
    expect(after.mergeState).toBe('isolating') // reenter-isolation 生效
    expect(after.isoBaseSnapshot).not.toBe(gen1Base) // base 列已重盖为新一代
    expect(after.wrapperProgressJson).toBeNull() // 旧代 baseline 随 reenter 原子清空
    expect(handle.passthrough).toBe(false)
    expect(handle.repos[0]!.baseSnapshot).toBe(after.isoBaseSnapshot!) // handle 与列同源
    // 新 base 含 canon 现态（gen-1 输出在新 iso 里可见 = 三路合并不会再把它当 ours 新增）。
    expect(existsSync(join(handle.repos[0]!.isoWorktreePath, 'gen1-output.txt'))).toBe(true)
  }, 30000)

  test('崩溃窗口恢复：reenter 清列后崩溃（旧 iso 目录残留）→ 容忍清理 + 全新重建，不 wedge', async () => {
    const { taskId, runId } = await seedWrapperTaskRow()
    const state = fakeSchedulerState(taskId)
    // gen-1 建 iso（目录真实落盘）。
    const gen1Handle = await createOrRebuildWrapperIso(state, runId, null)
    expect(existsSync(gen1Handle.repos[0]!.isoWorktreePath)).toBe(true)
    // 伪造「reenter CAS 已提交（列/progress 原子清空）、清理/重建前崩溃」的现场：
    // 行 isolating + 基列空 + 旧 iso 目录仍在派生路径上。
    await h.db
      .update(nodeRuns)
      .set({
        isoWorktreePath: null,
        isoBaseSnapshot: null,
        isoBaseSnapshotReposJson: null,
        wrapperProgressJson: null,
      })
      .where(eq(nodeRuns.id, runId))
    const crashed = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]!
    expect(crashed.mergeState).toBe('isolating')
    // 下次 resume：`git worktree add` 对既存目录硬失败——helper 必须先按派生
    // 路径容忍清理再重建（修复前：iso-worktree-add-failed → 任务每次 resume 都 wedge）。
    const handle = await createOrRebuildWrapperIso(state, runId, crashed)
    expect(handle.passthrough).toBe(false)
    expect(existsSync(handle.repos[0]!.isoWorktreePath)).toBe(true)
    const after = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]!
    expect(after.mergeState).toBe('isolating') // begin-isolation 自环重盖章
    expect(after.isoBaseSnapshot).not.toBeNull() // 基列已重新就位
    expect(handle.repos[0]!.baseSnapshot).toBe(after.isoBaseSnapshot!)
  }, 30000)

  test('源码顺序锁：merged 再入的 reenter CAS（夺权）先于任何销毁性清理', () => {
    const src = readFileSync(join(BACKEND_SRC, 'services', 'scheduler.ts'), 'utf-8')
    const fnStart = src.indexOf('export async function createOrRebuildWrapperIso(')
    const fnEnd = src.indexOf('async function mergeBackWrapperIso(', fnStart)
    const body = src.slice(fnStart, fnEnd)
    const casAt = body.indexOf("event: { kind: 'reenter-isolation' }")
    const discardAt = body.indexOf('discardNodeIso(')
    expect(casAt).toBeGreaterThan(-1)
    expect(discardAt).toBeGreaterThan(-1)
    // 并发败者必须在 CAS 处输掉并抛出、在任何 discard 之前——防止删掉赢家的新 iso。
    expect(casAt).toBeLessThan(discardAt)
  })

  test('conflict-human 再入：delta 未进 canon，保持旧 base rebuild（列不动）', async () => {
    const { taskId, runId } = await seedWrapperTaskRow()
    const state = fakeSchedulerState(taskId)
    await createOrRebuildWrapperIso(state, runId, null)
    const gen1 = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]!
    const gen1Base = gen1.isoBaseSnapshot!
    await transitionMergeState({
      db: h.db,
      nodeRunId: runId,
      event: { kind: 'mark-pending-merge' },
    })
    await transitionMergeState({
      db: h.db,
      nodeRunId: runId,
      event: { kind: 'park-conflict-human' },
    })
    const handle = await createOrRebuildWrapperIso(state, runId, {
      isoBaseSnapshot: gen1Base,
      isoBaseSnapshotReposJson: null,
    })
    const after = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]!
    expect(after.mergeState).toBe('isolating') // reenter-isolation 生效
    expect(after.isoBaseSnapshot).toBe(gen1Base) // 旧 base 保持（rebuild 不写列）
    expect(handle.repos[0]!.baseSnapshot).toBe(gen1Base)
  }, 30000)
})

describe('RFC-144 git wrapper merged 再入的 baseline（PR-4 复核 P2）', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildGitHarness()
  })
  afterEach(() => h.cleanup())

  test('再入代的 git_diff 不得把旧代已合并文件再报一遍（baseline 必须随新 iso 重捕）', async () => {
    // 旧代 baseline = gen1.txt 落 canon 之前的 HEAD。
    const oldBaseline = (await runGit(h.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()
    // 旧代 delta 已合并进 canonical 的等价物。
    writeFileSync(join(h.worktreePath, 'gen1.txt'), 'merged by prior generation\n')
    await runGit(h.worktreePath, ['add', '.'])
    await runGit(h.worktreePath, ['commit', '-q', '-m', 'gen1 merged'])

    // 工作流：git wrapper 包一个 agent；伪造「崩溃于 merge-back 内、入口 replay 已
    // 推成 merged、行被收割成 interrupted」后的复活现场。
    await h.db.insert(agents).values({
      id: ulid(),
      name: 'a',
      description: '',
      outputs: JSON.stringify(['summary']),
      permission: '{}',
      skills: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    const def: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [],
      nodes: [
        { id: 'gw', kind: 'wrapper-git', nodeIds: ['A'] },
        { id: 'A', kind: 'agent-single', agentName: 'a' },
      ],
      edges: [],
    } as unknown as WorkflowDefinition
    const workflowId = ulid()
    const taskId = ulid()
    await h.db.insert(workflows).values({
      id: workflowId,
      name: 'wf',
      definition: JSON.stringify(def),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    await h.db.insert(tasks).values({
      id: taskId,
      name: 'fixture',
      workflowId,
      workflowSnapshot: JSON.stringify(def),
      repoPath: h.worktreePath,
      worktreePath: h.worktreePath,
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'pending',
      inputs: '{}',
      startedAt: Date.now(),
    })
    await h.db.insert(nodeRuns).values({
      id: mkId(1),
      taskId,
      nodeId: 'gw',
      iteration: 0,
      retryIndex: 0,
      status: 'interrupted', // 收割后的可复活行（findResumableWrapperRun 同行续跑）
      mergeState: 'merged', // 入口 replay 已把旧代 pending-merge 推成 merged
      isoBaseSnapshot: oldBaseline, // 旧代 iso 基（merged 再入必须弃用）
      wrapperProgressJson: JSON.stringify({
        kind: 'git',
        baseline: oldBaseline, // 旧代 baseline —— 泄漏进新代即报旧文件
        preDirty: {},
        phase: 'inner-running',
      }),
      startedAt: Date.now() - 1000,
    })
    // PR-5 复核 P2：真实崩溃现场里旧代的 git_diff 输出行已落库（输出先写、
    // merge-back 后崩）——新代重写必须走 upsert，裸 insert 撞 (runId, port) 主键。
    await h.db.insert(nodeRunOutputs).values({
      nodeRunId: mkId(1),
      portName: 'git_diff',
      content: 'gen1.txt',
    })
    // inner agent 什么都不写——新代 git_diff 应为空。
    const mockPath = writeMockAgent(h, `emit(envelope)`)
    await runTask({ taskId, db: h.db, appHome: h.appHome, opencodeCmd: ['bun', 'run', mockPath] })

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    expect(t.status).toBe('done')
    const gwRow = (
      await h.db
        .select()
        .from(nodeRuns)
        .where(eq(nodeRuns.id, mkId(1)))
    )[0]!
    expect(gwRow.mergeState).toBe('merged') // 新代走完整链回到 merged
    const outs = await h.db
      .select()
      .from(nodeRunOutputs)
      .where(eq(nodeRunOutputs.nodeRunId, mkId(1)))
    const gitDiff = outs.find((o) => o.portName === 'git_diff')
    expect(gitDiff).toBeDefined()
    // 核心断言（修复前红）：旧代已合并的 gen1.txt 不得出现在新代 git_diff 里——
    // 旧输出行被 upsert 覆写为本代内容（inner 零写入 → 空）。
    expect(gitDiff!.content).not.toContain('gen1.txt')
    expect(gitDiff!.content).toBe('')
  }, 30000)
})

describe('RFC-144 merge-failed 行为补齐（RFC-130 缺口 + isolating→merge-failed 新边）', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildGitHarness()
  })
  afterEach(() => h.cleanup())

  test('agent 成功但 iso .git 被毁 → snapshot-pin 抛错 → 行 merge-failed、任务 fail-loud、canonical 零污染', async () => {
    const { taskId } = await seedAgentWorkflowTask(h, 'pending')
    // agent 在自己的 iso 里写产物、随后自毁 .git（模拟 iso 损坏），envelope 正常。
    const mockPath = writeMockAgent(
      h,
      `writeFileSync(join(process.cwd(), 'poison.txt'), 'never reaches canon\\n')
rmSync(join(process.cwd(), '.git'), { recursive: true, force: true })
emit(envelope)`,
    )
    await runTask({ taskId, db: h.db, appHome: h.appHome, opencodeCmd: ['bun', 'run', mockPath] })

    const t = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    expect(t.status).toBe('failed')
    const rows = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const runA = rows.find((r) => r.nodeId === 'A')!
    // snapshot-pin 阶段抛错：行还在 isolating —— isolating→merge-failed 边保住 fail-loud。
    expect(runA.mergeState).toBe('merge-failed')
    expect(existsSync(join(h.worktreePath, 'poison.txt'))).toBe(false)
  }, 30000)
})

describe('RFC-144 deriveFrontier — abandoned 分桶（穷举 switch 的新格）', () => {
  test('done+abandoned：不完成、不冒 awaitingHuman、不冒 failed——落 blocked（stale-done 桶）', () => {
    const def: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [
        { id: 'A', kind: 'agent-single', agentName: 'a' },
        { id: 'B', kind: 'agent-single', agentName: 'b' },
      ],
      edges: [
        {
          id: 'eAB',
          source: { nodeId: 'A', portName: 'summary' },
          target: { nodeId: 'B', portName: 'in' },
        },
      ],
    }
    const scopeNodes = def.nodes
    const scopeIds = new Set(['A', 'B'])
    const upstreamsOf = new Map([['B', ['A']]])
    const mkRow = (mergeState: string | null) =>
      ({
        id: 'r-A',
        taskId: 't',
        nodeId: 'A',
        status: 'done',
        cause: 'initial',
        retryIndex: 0,
        iteration: 0,
        shardKey: null,
        parentNodeRunId: null,
        reviewIteration: 0,
        consumedUpstreamRunsJson: null,
        mergeState,
      }) as unknown as Parameters<typeof deriveFrontier>[0][number]
    const empty = new Set<string>()
    const front = (mergeState: string | null) =>
      deriveFrontier(
        [mkRow(mergeState)],
        def,
        scopeNodes,
        scopeIds,
        0,
        upstreamsOf,
        empty,
        empty,
        empty,
      )

    const f = front('abandoned')
    expect(f.ready).not.toContain('B') // 被取代行不是 completion
    expect(f.awaitingHuman).not.toContain('A') // 不像 conflict-human 那样冒人工
    expect(f.failed).not.toContain('A') // 不像 merge-failed 那样冒失败
    expect(f.blocked.map((b) => b.nodeId)).toContain('A') // 与其他 stale-done 同桶
    // 对照组：settled 集两值照旧放行。
    expect(front('merged').ready).toContain('B')
    expect(front(null).ready).toContain('B')
  })
})

describe('RFC-144 源码锁 — mint 收口点的原子接线形态', () => {
  test('mintNodeRun：dbTxSync 内先 abandonSupersededMergeStates 再 insert（D12/P1-1）', () => {
    const src = readFileSync(join(BACKEND_SRC, 'services', 'nodeRunMint.ts'), 'utf-8')
    const txAt = src.indexOf('dbTxSync(')
    const abandonAt = src.indexOf('abandonSupersededMergeStates({', txAt)
    const insertAt = src.indexOf('.insert(nodeRuns)', abandonAt)
    expect(txAt).toBeGreaterThan(-1)
    expect(abandonAt).toBeGreaterThan(txAt)
    expect(insertAt).toBeGreaterThan(abandonAt)
  })

  test('taskQuestionDispatch：同步 tx 内 mint 前同参 abandon（RFC-120 原子 claim+mint 通道）', () => {
    const src = readFileSync(join(BACKEND_SRC, 'services', 'taskQuestionDispatch.ts'), 'utf-8')
    expect(src).toContain('abandonSupersededMergeStates(')
  })
})
