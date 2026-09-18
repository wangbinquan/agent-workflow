// RFC-109 —— `syncWorkflow`：把工作流的最新定义换进任务的冻结快照并从断点继续。
//
// **RFC-359 AC-1（第 13 刀下）迁移记**：本套件此前钉的是 `services/task.ts` 的
// `syncTaskWorkflow`——sync 的**第二份实现**（160 行，终端是 `resumeKick` 的一段式准入），
// 只在 SQLite 上跑过。那一份已随本刀退役；这里改为驱动**两个引擎共用的那一份**
// （`taskRouteOperations.syncWorkflow`），并且走的是**生产装配**
// （`createEachProviderTaskExecution` 交出的 `provider.routes.tasks.syncWorkflow`），
// 两条泳道各自跑自己部署里真正会执行的那条路。原来的 AC 判据一条不少：
//   - 快照 + 版本在准入 CAS 内原子换掉，随后复活（AC-1）
//   - 六个非活跃状态都能同步；running / pending 拒绝（AC-3）
//   - 工作流被删 / 版本 TOCTOU / 定义非法 / 同定义 noop / 无工作树 / 并发，各自的错误码
//     （AC-8/9、Codex F5/F7）
//   - done 任务上新增的节点在同步后被派发（AC-2）
//   - `selectSyncRollbackTargets` 收 canceled 写节点但豁免 wrapper（F4）
//
// 顺带记一条**两侧本来就不同、合并后统一**的事实：退役那份走一段式准入（直接落 `pending`），
// 共用那份走两段式交棒（准入 CAS 落 `interrupted` 并打 `continuationHandoff` 标记，随后才交给
// 复活端口，由它 CAS 回 `pending`）。对外可见的终态仍是 `pending`——下面 AC-1 / AC-3 断的就是它。

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '../src/db/query'
import { nodeRuns, tasks, users, workflows } from '../src/db/schema'
import { selectSyncRollbackTargets, buildSyncRunSummary } from '../src/services/task'
import type { nodeRuns as nodeRunsTable } from '../src/db/schema'
import { runGit } from '../src/util/git'
import { describeEachProvider } from './helpers/eachProvider'
import { createEachProviderTaskExecution } from './helpers/eachProviderTaskExecution'
import {
  migrateWorkflowDefinitionToLatest,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@agent-workflow/shared'

const USER_ID = 'rfc109_user'

type TaskStatus =
  | 'pending'
  | 'running'
  | 'awaiting_review'
  | 'awaiting_human'
  | 'done'
  | 'failed'
  | 'canceled'
  | 'interrupted'

function defWith(
  nodes: WorkflowNode[],
  edges: WorkflowDefinition['edges'] = [],
): WorkflowDefinition {
  // input nodes must have their inputKey declared in workflow.inputs[]
  // (validator rule input-key-not-declared) — auto-derive so test defs stay valid.
  const inputs = nodes
    .filter((n) => n.kind === 'input')
    .map((n) => {
      const key = (n as unknown as { inputKey: string }).inputKey
      return { kind: 'text', key, label: key }
    })
  return { $schema_version: 4, inputs, nodes, edges } as unknown as WorkflowDefinition
}
function inputNode(id: string, inputKey: string = id): WorkflowNode {
  // input nodes dispatch via `inputKey` (scheduler.ts) — a node_run is minted
  // only when the key is present, so the AC-2 "new node dispatched" assertion
  // needs a real inputKey.
  return { id, kind: 'input', inputKey } as unknown as WorkflowNode
}

const DEF_A = defWith([inputNode('a')])

interface Fixture {
  readonly appHome: string
  readonly workflowId: string
  readonly taskId: string
  readonly cleanup: () => void
}

async function seedFixture(
  db: ProviderNeutralDatabase,
  status: TaskStatus,
  snapshot: WorkflowDefinition = DEF_A,
): Promise<Fixture> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc109-'))
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(repoPath, { recursive: true })
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 't@t.test'])
  await runGit(repoPath, ['config', 'user.name', 't'])
  writeFileSync(join(repoPath, 'README.md'), '# r\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'i'])

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, USER_ID))
    .limit(1)
  if (existing.length === 0) {
    await db.insert(users).values({
      id: USER_ID,
      username: USER_ID,
      displayName: USER_ID,
      role: 'admin',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    })
  }
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: `w-${workflowId}`,
    definition: JSON.stringify(DEF_A),
    version: 1,
  })
  const taskId = ulid()
  await db.insert(tasks).values({
    name: 't',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(snapshot),
    workflowVersion: 1,
    repoPath,
    worktreePath: repoPath,
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    status,
    inputs: '{}',
    ownerUserId: USER_ID,
    executionLineageId: taskId,
    startedAt: Date.now(),
    finishedAt: status === 'done' || status === 'failed' ? Date.now() : null,
  })
  return {
    appHome,
    workflowId,
    taskId,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}

/** Bump the live workflow to a new definition + version (mirrors a PUT). */
async function bumpWorkflow(
  db: ProviderNeutralDatabase,
  workflowId: string,
  definition: WorkflowDefinition,
  version: number,
): Promise<void> {
  await db
    .update(workflows)
    .set({ definition: JSON.stringify(definition), version })
    .where(eq(workflows.id, workflowId))
}

/** 生产装配：两条泳道各自跑自己部署里真正会执行的那份实现。 */
async function syncVia(
  harness: Parameters<Parameters<typeof describeEachProvider>[1]>[0],
  fixture: Fixture,
  expectedVersion: number,
  taskId?: string,
) {
  const execution = await createEachProviderTaskExecution(
    harness,
    { appHome: fixture.appHome, defaultNodeRetries: 0, binaryOverride: ['/usr/bin/env', 'true'] },
    USER_ID,
  )
  return await execution.provider.routes.tasks.syncWorkflow({
    actor: execution.actor,
    taskId: taskId ?? fixture.taskId,
    expectedVersion,
  })
}

/**
 * 有界等待一个**异步但确定**会发生的事实。复活是 fire-and-forget（生产上路由立刻返回），
 * 所以「新节点被派发」只能等；等不到就红，**不接受「重跑就过了」**。
 */
async function waitFor(
  predicate: () => Promise<boolean>,
  budgetMs = 15_000,
  stepMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn()
    return undefined
  } catch (err) {
    return (err as { code?: string }).code
  }
}

describeEachProvider('RFC-109 syncWorkflow —— 换定义 + 从断点继续', (harness) => {
  let f: Fixture | undefined
  afterEach(() => {
    f?.cleanup()
    f = undefined
  })

  test('AC-1: failed task — swaps snapshot + version atomically, flips pending', async () => {
    f = await seedFixture(harness.db, 'failed')
    const DEF_B = defWith([inputNode('a'), inputNode('b')])
    await bumpWorkflow(harness.db, f.workflowId, DEF_B, 2)

    const after = await syncVia(harness, f, 2)
    expect(after.status).toBe('pending')
    expect(after.workflowVersion).toBe(2)
    const row = (await harness.db.select().from(tasks).where(eq(tasks.id, f.taskId)))[0]!
    expect(JSON.parse(row.workflowSnapshot)).toEqual(migrateWorkflowDefinitionToLatest(DEF_B))
    expect(row.workflowVersion).toBe(2)
  })

  test('AC-3: each non-active status syncs (done/canceled/awaiting_review/awaiting_human/interrupted)', async () => {
    for (const status of [
      'done',
      'canceled',
      'awaiting_review',
      'awaiting_human',
      'interrupted',
    ] as const) {
      const ff = await seedFixture(harness.db, status)
      try {
        await bumpWorkflow(harness.db, ff.workflowId, defWith([inputNode('a'), inputNode('c')]), 2)
        const after = await syncVia(harness, ff, 2)
        expect(after.status, `status ${status} must sync`).toBe('pending')
      } finally {
        ff.cleanup()
      }
    }
  })

  test('AC-3: running and pending reject with task-not-syncable (scheduler holds the lock)', async () => {
    for (const status of ['running', 'pending'] as const) {
      const ff = await seedFixture(harness.db, status)
      try {
        await bumpWorkflow(harness.db, ff.workflowId, defWith([inputNode('a'), inputNode('c')]), 2)
        expect(await codeOf(() => syncVia(harness, ff, 2))).toBe('task-not-syncable')
      } finally {
        ff.cleanup()
      }
    }
  })

  test('AC-8: workflow deleted → workflow-deleted (defensive; RFC-285 起 workflow_id 是软链)', async () => {
    f = await seedFixture(harness.db, 'failed')
    await harness.db.delete(workflows).where(eq(workflows.id, f.workflowId))
    expect(await codeOf(() => syncVia(harness, f!, 1))).toBe('workflow-deleted')
  })

  test('F5: expectedVersion stale → workflow-sync-preview-stale (no swap)', async () => {
    f = await seedFixture(harness.db, 'failed')
    await bumpWorkflow(harness.db, f.workflowId, defWith([inputNode('a'), inputNode('b')]), 2)
    expect(await codeOf(() => syncVia(harness, f!, 1))).toBe('workflow-sync-preview-stale')
    const row = (await harness.db.select().from(tasks).where(eq(tasks.id, f.taskId)))[0]!
    expect(row.workflowVersion).toBe(1) // unchanged
    expect(row.status).toBe('failed')
  })

  test('F7: same definition (version bumped, content identical) → workflow-sync-noop, no status churn', async () => {
    f = await seedFixture(harness.db, 'done')
    await bumpWorkflow(harness.db, f.workflowId, DEF_A, 2) // identical content, new version
    expect(await codeOf(() => syncVia(harness, f!, 2))).toBe('workflow-sync-noop')
    const row = (await harness.db.select().from(tasks).where(eq(tasks.id, f.taskId)))[0]!
    expect(row.status).toBe('done') // not churned
  })

  test('RFC-292: latest definition introducing trigger dependency rejects before atomic swap', async () => {
    f = await seedFixture(harness.db, 'failed')
    const next: WorkflowDefinition = {
      $schema_version: 5,
      inputs: [],
      nodes: [
        {
          id: 'agent',
          kind: 'agent-single',
          agentName: 'fixture',
          promptTemplate: 'Handle {{trigger.webhook.comment_text}}',
        } as WorkflowNode,
      ],
      edges: [],
    }
    const finishedAt = Date.now() - 10
    await harness.db
      .update(tasks)
      .set({
        finishedAt,
        errorSummary: 'original-summary',
        errorMessage: 'original-detail',
        failedNodeId: 'a',
      })
      .where(eq(tasks.id, f.taskId))
    const before = (await harness.db.select().from(tasks).where(eq(tasks.id, f.taskId)))[0]!
    await bumpWorkflow(harness.db, f.workflowId, next, 2)

    expect(await codeOf(() => syncVia(harness, f!, 2))).toBe('trigger-context-missing')

    const after = (await harness.db.select().from(tasks).where(eq(tasks.id, f.taskId)))[0]!
    expect(after).toMatchObject({
      status: 'failed',
      workflowVersion: 1,
      workflowSnapshot: before.workflowSnapshot,
      refClosureJson: before.refClosureJson,
      finishedAt,
      errorSummary: 'original-summary',
      errorMessage: 'original-detail',
      failedNodeId: 'a',
    })
  })

  test('AC-8: invalid latest definition → workflow-invalid', async () => {
    f = await seedFixture(harness.db, 'failed')
    const INVALID = defWith(
      [inputNode('a')],
      [
        {
          id: 'e',
          source: { nodeId: 'ghost', portName: 'p' },
          target: { nodeId: 'a', portName: 'q' },
        },
      ],
    )
    await bumpWorkflow(harness.db, f.workflowId, INVALID, 2)
    expect(await codeOf(() => syncVia(harness, f!, 2))).toBe('workflow-invalid')
  })

  test('AC-10: worktree missing → worktree-missing', async () => {
    f = await seedFixture(harness.db, 'failed')
    await harness.db.update(tasks).set({ worktreePath: '' }).where(eq(tasks.id, f.taskId))
    await bumpWorkflow(harness.db, f.workflowId, defWith([inputNode('a'), inputNode('b')]), 2)
    expect(await codeOf(() => syncVia(harness, f!, 2))).toBe('worktree-missing')
  })

  test('AC-9: concurrent sync — second loses with task-not-syncable, no double swap', async () => {
    f = await seedFixture(harness.db, 'failed')
    await bumpWorkflow(harness.db, f.workflowId, defWith([inputNode('a'), inputNode('b')]), 2)
    await syncVia(harness, f, 2) // first wins → pending
    expect(await codeOf(() => syncVia(harness, f!, 2))).toBe('task-not-syncable')
  })

  test('task-not-found on unknown task', async () => {
    f = await seedFixture(harness.db, 'failed')
    expect(await codeOf(() => syncVia(harness, f!, 1, 'nope'))).toBe('task-not-found')
  })

  test('AC-2: a node added to a done task is dispatched after sync', async () => {
    f = await seedFixture(harness.db, 'done')
    // seed the original node as a completed run
    await harness.db.insert(nodeRuns).values({
      id: ulid(),
      taskId: f.taskId,
      nodeId: 'a',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'done',
    })
    const DEF_B = defWith([inputNode('a'), inputNode('b')])
    await bumpWorkflow(harness.db, f.workflowId, DEF_B, 2)

    await syncVia(harness, f, 2)
    // 同步的契约到「换完快照、交给复活」为止；派发是复活之后调度器读**新图**的结果，
    // 而复活在生产上是 fire-and-forget（路由立刻把任务行还给调用方）。所以这里有界地等它——
    // 等不到就是真的没派发，不是抖动。
    const dispatched = await waitFor(async () => {
      const runs = await harness.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, f!.taskId))
      return runs.some((r) => r.nodeId === 'b')
    })
    expect(dispatched, '新图里的节点 b 必须被派发').toBe(true)
  })
})

describe('RFC-109 selectSyncRollbackTargets (Codex F4)', () => {
  const row = (id: string, nodeId: string, status: string, parent: string | null = null) => ({
    id,
    nodeId,
    parentNodeRunId: parent,
    status,
  })

  test('adds canceled write nodes but spares wrapper-canceled revival rows', () => {
    const isWrapper = (n: string) => n === 'wrap'
    const runs = [
      row('01A', 'writer', 'canceled'), // write node → rolled back
      row('01B', 'wrap', 'canceled'), // wrapper revival → spared
      row('01C', 'other', 'failed'), // failed → rolled back
    ]
    const picked = selectSyncRollbackTargets(runs, ['failed', 'interrupted', 'canceled'], isWrapper)
    expect(picked.map((r) => r.nodeId).sort()).toEqual(['other', 'writer'])
  })

  test('resume status set ([failed,interrupted]) excludes canceled entirely', () => {
    const runs = [row('01A', 'w', 'canceled'), row('01B', 'x', 'failed')]
    const picked = selectSyncRollbackTargets(runs, ['failed', 'interrupted'], () => false)
    expect(picked.map((r) => r.nodeId)).toEqual(['x'])
  })

  test('child rows (parentNodeRunId set) never selected; freshest top-level per node wins', () => {
    const runs = [
      row('01A', 'n', 'failed'),
      row('01C', 'n', 'failed'), // newer id → wins
      row('01D', 'n', 'failed', '01A'), // child → ignored
    ]
    const picked = selectSyncRollbackTargets(runs, ['failed'], () => false)
    expect(picked).toHaveLength(1)
    expect(picked[0]!.id).toBe('01C')
  })
})

describe('RFC-109 buildSyncRunSummary — live wrapper state (Codex re-review P2)', () => {
  type Row = typeof nodeRunsTable.$inferSelect
  const wrun = (over: Partial<Row>): Row =>
    ({
      id: ulid(),
      taskId: 't',
      nodeId: 'w',
      parentNodeRunId: null,
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'done',
      wrapperProgressJson: null,
      ...over,
    }) as unknown as Row
  const live = (rows: Row[], nodeId: string) =>
    buildSyncRunSummary(rows).get(nodeId)?.hasLiveWrapperState ?? false

  test('terminal-breadcrumb wrappers (done/failed/exhausted + progress) are NOT live', () => {
    for (const status of ['done', 'failed', 'exhausted'] as const) {
      expect(live([wrun({ status, wrapperProgressJson: '{"iter":2}' })], 'w')).toBe(false)
    }
  })

  test('resumable wrappers with parked progress ARE live (awaiting/canceled/interrupted)', () => {
    for (const status of [
      'awaiting_human',
      'awaiting_review',
      'canceled',
      'interrupted',
    ] as const) {
      expect(live([wrun({ status, wrapperProgressJson: '{"iter":2}' })], 'w')).toBe(true)
    }
  })

  test('a non-terminal child row marks its parent wrapper live; a terminal child does not', () => {
    const parent = wrun({ id: '01P', nodeId: 'w', status: 'done', wrapperProgressJson: null })
    const liveChild = wrun({
      id: '01C',
      nodeId: 'inner',
      parentNodeRunId: '01P',
      status: 'running',
    })
    const doneChild = wrun({ id: '01D', nodeId: 'inner', parentNodeRunId: '01P', status: 'done' })
    expect(live([parent, liveChild], 'w')).toBe(true)
    expect(live([parent, doneChild], 'w')).toBe(false)
  })
})
