import { rimrafDir } from './helpers/cleanup'
// RFC-092 §1.2 / §1.3 — 泄漏 pending 行的有界终结（对抗检视反例回归）。
// 设计依据：design/RFC-092-scheduler-p0-stopgap/design.md §1.2（行 id 一次性豁免）、
// §1.3（busy-loop 安全论证）、§5-10；调研：design/scheduler-audit-2026-06-10.md S-1。
//
// 为什么存在这条测试：RFC-092 初版「按 nodeId 对 pending 行整体放行」被对抗检视攻破——
// runOneNode 在 pendingExisting 复用点之前存在【不消费 pending 行】的早期失败 return
// （agent 缺失 / agent 被删 / 注入失败），nodeId 级放行会形成确定性零铸行热循环
// （每 tick ready → 失败 → pending 仍在 → 又 ready），scope 永不 quiescent。修订后的
// 豁免按【行 id】一次性生效：泄漏的 pending 行至多被重派一次，之后回到现行 stall 语义
// —— 有界退化，不是死循环、不是无界铸行。本文件两层锁定：
//   1. 纯函数层：dispatchedPendingRowIds 含行 id ⇒ 不 ready 不入桶；新铸行（新 id）
//      重新放行恰好一次。
//   2. 集成层：真实 runTask + 指向不存在 agent 的节点（runOneNode `agent-not-found`
//      早期 return，scheduler.ts getAgent===null 分支——位于 pendingExisting 复用点
//      之前、不铸行不消费行）+ 人工预铸 pending 行。若豁免被改回 nodeId 级（或被删），
//      runTask 将永不返回（测试超时翻红）；若改成失败路径也铸行，行数上界断言翻红。
//
// row()/def() 纯函数帮手复刻自 derive-frontier.test.ts；集成 harness 复刻自
// scheduler-clarify-dispatch.test.ts（createInMemoryDb + fixtures/mock-opencode.ts +
// 临时真实 git 仓）。

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import type { NodeKind } from '@agent-workflow/shared'
import { agents, nodeRuns, tasks, workflows } from '../src/db/schema'
import { deriveFrontier, runTask } from '../src/services/scheduler'
import { runGit } from '../src/util/git'

// 同毫秒内多次铸行时保证 id 单调（freshness 是纯 id-order）。
const ulid = monotonicFactory()

// ---------------------------------------------------------------------------
// 纯函数层
// ---------------------------------------------------------------------------

type Row = typeof nodeRuns.$inferSelect
type ScopeNode = WorkflowDefinition['nodes'][number]
const NONE: ReadonlySet<string> = new Set()

let seq = 0
function row(nodeId: string, status: string, over: Partial<Row> = {}): Row {
  seq += 1
  return {
    id: `01R${String(seq).padStart(4, '0')}`,
    nodeId,
    iteration: 0,
    status,
    parentNodeRunId: null,
    consumedUpstreamRunsJson: null,
    wrapperProgressJson: null,
    ...over,
  } as unknown as Row
}

function def(nodes: Array<{ id: string; kind: NodeKind }>): {
  definition: WorkflowDefinition
  scopeNodes: ScopeNode[]
  scopeIds: Set<string>
} {
  const definition = { nodes, edges: [] } as unknown as WorkflowDefinition
  return {
    definition,
    scopeNodes: nodes as unknown as ScopeNode[],
    scopeIds: new Set(nodes.map((n) => n.id)),
  }
}

const ups = (m: Record<string, string[]>): Map<string, string[]> => new Map(Object.entries(m))

describe('RFC-092 纯函数层 — 行 id 一次性豁免的有界退化', () => {
  test('pending 行 id ∈ dispatchedPendingRowIds → 不 ready、不入任何桶（有界退化 = 回到 stall 语义）', () => {
    const { definition, scopeNodes, scopeIds } = def([
      { id: 'in', kind: 'input' },
      { id: 'd', kind: 'agent-single' },
    ])
    const leaked = row('d', 'pending') // 派发过但未被消费的泄漏行
    const rows = [row('in', 'done'), leaked]
    const f = deriveFrontier(
      rows,
      definition,
      scopeNodes,
      scopeIds,
      0,
      ups({ d: ['in'] }),
      NONE,
      new Set(['d']), // 本调用已派发过
      NONE,
      NONE,
      new Set([leaked.id]), // 该行的一次性豁免已用掉
    )
    expect(f.ready).toEqual([])
    expect(f.pendingAnchors.size).toBe(0)
    expect(f.awaitingHuman).toEqual([])
    expect(f.awaitingReview).toEqual([])
    expect(f.failed).toEqual([])
    expect(f.exhausted).toEqual([])
    // 无桶 + 不 ready + allSettled=false ⇒ runScope 静默块落 stall 兜底（有限终结）。
    expect(f.allSettled).toBe(false)
  })

  test('同 rows 追加新 id 的 pending 行（out-of-band 新铸）→ 重新放行 ready 且 anchor 指向新行', () => {
    const { definition, scopeNodes, scopeIds } = def([
      { id: 'in', kind: 'input' },
      { id: 'd', kind: 'agent-single' },
    ])
    const leaked = row('d', 'pending')
    const fresh = row('d', 'pending') // 新铸行：新 ULID（更晚 id ⇒ latest）
    const rows = [row('in', 'done'), leaked, fresh]
    const f = deriveFrontier(
      rows,
      definition,
      scopeNodes,
      scopeIds,
      0,
      ups({ d: ['in'] }),
      NONE,
      new Set(['d']),
      NONE,
      NONE,
      new Set([leaked.id]), // 旧行已豁免过；新行不在集合内
    )
    expect(f.ready).toEqual(['d'])
    expect(f.pendingAnchors.get('d')).toBe(fresh.id)
  })
})

// ---------------------------------------------------------------------------
// 集成层（轻量）
// ---------------------------------------------------------------------------

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
  const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc092-leak-'))
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

function makeDef(agentName: string): WorkflowDefinition {
  return {
    $schema_version: 3,
    inputs: [{ kind: 'text', key: 'req', label: 'r' }],
    nodes: [
      { id: 'in1', kind: 'input', inputKey: 'req' } as WorkflowNode,
      { id: 'd', kind: 'agent-single', agentName } as WorkflowNode,
    ],
    edges: [
      {
        id: 'e_in',
        source: { nodeId: 'in1', portName: 'req' },
        target: { nodeId: 'd', portName: 'req' },
      },
    ],
  }
}

async function seedWorkflowAndTask(h: Harness, definition: WorkflowDefinition): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await h.db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
  })
  await h.db.insert(tasks).values({
    name: 'fixture-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: h.repoPath,
    worktreePath: h.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'pending',
    inputs: JSON.stringify({ req: 'go' }),
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

describe('RFC-092 集成层 — 泄漏 pending 行在真实 runTask 下有界终结', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('ghost agent（agent-not-found 早期 return 不消费 pending 行）：预铸 pending 行 → 任务有限步 failed，节点行数有上界、绝非无限铸行', async () => {
    // agents 表不 seed 'ghost' —— runOneNode 在 pendingExisting 复用点之前
    // `agent-not-found` 早期 return，预铸的 pending 行永远不被消费（泄漏行）。
    const taskId = await seedWorkflowAndTask(h, makeDef('ghost'))
    const preMintedId = ulid()
    await h.db.insert(nodeRuns).values({
      id: preMintedId,
      taskId,
      nodeId: 'd',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
    })

    // 行 id 一次性豁免下时序：tick1 派 in1；tick2 d ready（pending anchor 放行）→
    // 派发记账 anchor → agent-not-found 失败、行未消费；tick3 同行已豁免过 ⇒ 不再
    // ready、无桶 ⇒ quiescent → failed。若豁免退化为 nodeId 级，这里会热循环、
    // runTask 永不返回 ⇒ 测试超时翻红。
    await runTask({
      taskId,
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
    })

    const taskRow = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    expect(taskRow.status).toBe('failed')
    expect(taskRow.errorMessage ?? '').toContain('agent-not-found')

    // 行数上界：≤ 预铸 1 + 重派可能铸的 1（agent-not-found 早期 return 实际不铸行，
    // 现状恰为 1）。任何「失败路径开始铸行 / 无界铸行」的回归都会顶穿这个上界。
    const dRows = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.nodeId === 'd' && r.parentNodeRunId === null,
    )
    expect(dRows.length).toBeLessThanOrEqual(2)
    expect(dRows.length).toBe(1)
    // 泄漏行原样留存（未被消费、未被翻状态）—— 有界退化的物证。
    expect(dRows[0]!.id).toBe(preMintedId)
    expect(dRows[0]!.status).toBe('pending')
  }, 20000)

  test('对照：agent 存在时预铸 pending 行被恰好消费一次（pendingExisting 复用）→ 任务 done、零额外铸行', async () => {
    await h.db.insert(agents).values({
      id: ulid(),
      name: 'designer',
      description: 'test',
      outputs: JSON.stringify(['design']),
      permission: '{}',
      skills: '[]',
      frontmatterExtra: '{}',
      bodyMd: '',
    })
    const taskId = await seedWorkflowAndTask(h, makeDef('designer'))
    const preMintedId = ulid()
    await h.db.insert(nodeRuns).values({
      id: preMintedId,
      taskId,
      nodeId: 'd',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
    })

    await withEnv({ MOCK_OPENCODE_OUTPUTS: JSON.stringify({ design: 'ok' }) }, () =>
      runTask({
        taskId,
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: ['bun', 'run', MOCK_OPENCODE],
      }),
    )

    const taskRow = (await h.db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
    expect(taskRow.status).toBe('done')
    const dRows = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.nodeId === 'd' && r.parentNodeRunId === null,
    )
    // 预铸行被 runOneNode 的 pendingExisting 复用：同一行跑到 done，不重复铸行。
    expect(dRows.length).toBe(1)
    expect(dRows[0]!.id).toBe(preMintedId)
    expect(dRows[0]!.status).toBe('done')
  }, 20000)
})
