// RFC-359 AC-1（第 9 刀第 1 步）—— **retry 的回滚基线判据，两个引擎给同一个答案吗**。
//
// 为什么这条测试存在
// ------------------
// `retry` 这一对适配器唯一的双引擎对拍是 `rfc359-w7`，而它的 `seedTask` 默认
// `worktreePath: ''`——**没有工作树，git 一步都跑不到**，于是「节点的 `pre_snapshot` 已经
// 从对象库里消失」这个条件在那套合成种子下**构造不出来**。实测探针（plan 第 9 刀勘察第三次
// 收敛）：同样的形态在 SQLite 上 `no-throw`、任务被推成 `pending`，PG 上走到替身才炸——
// 两侧的回滚路径在对拍里**整体零覆盖**。
//
// 这条用真 git 工作树（`git init` + 一次提交 + 一个不存在的 sha）把那段路跑起来，
// 并且走的是**生产装配**（`createEachProviderTaskExecution` 交出的 `provider.taskRoutes`），
// 不是手搓依赖——两条 lane 上跑的正是各自部署里真正会执行的那份实现。
//
// 源码上可见的差异是「判据相对准入 CAS 的位置」：PG 在 CAS **之前**
// （`assertRollbackBaselinesPresent`），SQLite 在 CAS **之后**（先把任务 CAS 成 pending，
// 再由 `escalateSnapshotLost` 升级）。
//
// **实测答案：位置差异在这个场景下没有用户可见后果**——两条 lane 给出逐格相同的
// `(409 snapshot-lost, 任务 failed, errorSummary snapshot-lost)`。
// 变异实证三次，结论比「都绿」更具体：
//   · 把 PG 的 CAS 前置门（`assertRollbackBaselinesPresent`）整块注释掉 ⇒ **两条 lane 仍全绿**。
//     也就是说那道门在这条路径上**不是承重的**：后面的真回滚给出完全相同的升级。
//     合并时这一格**不需要产品判断**（两侧同答案），但也别把它当成「PG 独有的保护」而去 SQLite 侧补。
//   · 把 SQLite 的 `escalateSnapshotLost` 的 `errorSummary` 改成别的字符串 ⇒ SQLite lane 红；
//   · 把 PG 的 `escalateUnsafeContinuation` 的 `errorSummary` 改成别的字符串 ⇒ PostgreSQL lane 红。
//     后两条证明本条确实有预言力，不是「因为都没跑到所以都绿」。
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import {
  NODE_KIND_BEHAVIORS,
  nodeKindParticipatesInRetryCascade,
  type NodeKind,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, tasks, users, workflows } from '@/db/schema'
import { runGit } from '@/util/git'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { describeEachProvider } from './helpers/eachProvider'
import { minimalNodeOfKind } from './helpers/nodeKindFixtures'
import { createTaskExecutionTestTopology } from './helpers/taskExecutionTestTopology'
import { createEachProviderTaskExecution } from './helpers/eachProviderTaskExecution'

/** 良构但**任何对象库里都不存在**的 sha——被 gc 剪掉的快照的确定性替身。 */
const PRUNED_SNAPSHOT = 'deadbeef'.repeat(5)
const USER_ID = 'u_rfc359_w9'

interface Fixture {
  readonly appHome: string
  readonly repoPath: string
  readonly taskId: string
  readonly nodeRunId: string
  readonly cleanup: () => void
}

const DEFINITION: WorkflowDefinition = {
  $schema_version: 2,
  inputs: [],
  nodes: [
    { id: 'doc', kind: 'agent-single', agentName: 'doc', promptTemplate: '' } as WorkflowNode,
  ],
  edges: [],
}

/** `a → b` 两个 agent 节点：`b` 是 `a` 的下游，用来验级联。 */
const CASCADE_DEFINITION = {
  $schema_version: 2,
  inputs: [],
  nodes: [
    { id: 'a', kind: 'agent-single', agentName: 'a', promptTemplate: '' },
    { id: 'b', kind: 'agent-single', agentName: 'b', promptTemplate: '' },
  ],
  edges: [
    // `id` 是必填（`WorkflowEdgeSchema`）。少了它 PG 侧的 `definitionOf` 会当场 zod 拒绝，
    // 而 SQLite 侧不解析、照跑——这处**严格度差异**本身就值得记一笔，只是本用例要的是级联语义。
    {
      id: 'a-b',
      source: { nodeId: 'a', portName: 'result' },
      target: { nodeId: 'b', portName: 'input' },
    },
  ],
} as unknown as WorkflowDefinition

interface SeedOptions {
  readonly definition?: WorkflowDefinition
  readonly status?: 'canceled' | 'failed' | 'done'
  /** 不给就按原来的单节点形态铸一条带失效快照的 `doc` 行。 */
  readonly runs?: readonly {
    readonly nodeId: string
    readonly status: string
    /** 帧字段（loop / 评审轮 / 分片）——用来验重试铸出的新行有没有原样继承。 */
    readonly frame?: Readonly<{
      iteration?: number
      reviewIteration?: number
      shardKey?: string | null
    }>
  }[]
}

async function seedFixture(
  db: ProviderNeutralDatabase,
  options: SeedOptions = {},
): Promise<Fixture> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc359-w9-'))
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(repoPath, { recursive: true })
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 'w9@test.invalid'])
  await runGit(repoPath, ['config', 'user.name', 'w9'])
  writeFileSync(join(repoPath, 'README.md'), '# w9\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'init'])

  // 同一条用例可能建两个任务（跨任务那格），用户只该插一次。
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
  const definition = options.definition ?? DEFINITION
  const workflowId = ulid()
  await db
    .insert(workflows)
    .values({ id: workflowId, name: 'w9', definition: JSON.stringify(definition) })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 'w9',
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath,
    worktreePath: repoPath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    // 缺省用 `canceled` 而不是 `failed`：终态里选一个**与升级目标不同**的，这样「任务有没有
    // 被改坏」才看得出来（升级的目标是 failed）。
    status: (options.status ?? 'canceled') as 'canceled',
    inputs: '{}',
    startedAt: Date.now() - 1000,
    finishedAt: Date.now() - 500,
    ownerUserId: USER_ID,
    executionLineageId: taskId,
  })
  let nodeRunId = ''
  const seededRuns = options.runs ?? [{ nodeId: 'doc', status: 'failed' }]
  for (const run of seededRuns) {
    const id = ulid()
    if (nodeRunId === '') nodeRunId = id
    await db.insert(nodeRuns).values({
      id,
      taskId,
      nodeId: run.nodeId,
      status: run.status as 'failed',
      retryIndex: 0,
      iteration: run.frame?.iteration ?? 0,
      ...(run.frame?.reviewIteration === undefined
        ? {}
        : { reviewIteration: run.frame.reviewIteration }),
      ...(run.frame?.shardKey === undefined ? {} : { shardKey: run.frame.shardKey }),
      // 失效快照只在缺省形态里铸（那条用例要的就是它）；显式给 runs 的用例不带，
      // 免得回滚判据把级联那格挡在前面。
      ...(options.runs === undefined ? { preSnapshot: PRUNED_SNAPSHOT } : {}),
      startedAt: Date.now() - 900,
      finishedAt: Date.now() - 600,
      ...(run.status === 'failed' ? { errorMessage: 'boom' } : {}),
    })
  }
  return {
    appHome,
    repoPath,
    taskId,
    nodeRunId,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  }
}

/** `<节点>#<第几次尝试>:<状态>` 的有序拼串——比 id 稳，两侧可直接对拍。 */
async function runShape(db: ProviderNeutralDatabase, taskId: string): Promise<string> {
  const rows = await db
    .select({ nodeId: nodeRuns.nodeId, status: nodeRuns.status, retryIndex: nodeRuns.retryIndex })
    .from(nodeRuns)
    .where(eq(nodeRuns.taskId, taskId))
  return rows
    .map((row) => `${row.nodeId}#${row.retryIndex}:${row.status}`)
    .sort()
    .join(' | ')
}

/** 生产装配：两条 lane 各自跑自己部署里真正会执行的那份实现。 */
async function executionFor(
  harness: Parameters<Parameters<typeof describeEachProvider>[1]>[0],
  fixture: Fixture,
) {
  return await createEachProviderTaskExecution(
    harness,
    { appHome: fixture.appHome, defaultNodeRetries: 0 },
    USER_ID,
    {
      // SQLite 的路由壳在进 `retryNode` 之前就展开这个对象，缺省的桩一调用就炸——
      // 交一份真的进去，两条 lane 才跑的是各自部署里真正会执行的那份实现。
      // 二进制指向 `/usr/bin/env true`：本文件只验前置判据与落库形状，没有 agent 需要真跑。
      routeStartDepsFor: () => ({
        db: harness.db as unknown as DbClient,
        appHome: fixture.appHome,
        schedulerDriver: createTaskExecutionTestTopology({
          db: harness.db as unknown as DbClient,
          driver: 'real',
        }).schedulerDriver,
        taskRecoveryOperations: createTaskExecutionPersistence(harness.db).recoveryAdministration,
        binaryOverride: ['/usr/bin/env', 'true'],
      }),
    },
  )
}

describeEachProvider('RFC-359 W9 —— retry 撞上已丢的 pre_snapshot', (harness) => {
  let fixture: Fixture | undefined
  afterEach(() => {
    fixture?.cleanup()
    fixture = undefined
  })

  test('错误码与事后的任务状态', async () => {
    fixture = await seedFixture(harness.db)
    const execution = await executionFor(harness, fixture)
    let code = 'no-throw'
    try {
      await execution.provider.routes.tasks.retry({
        actor: execution.actor,
        taskId: fixture.taskId,
        nodeRunId: fixture.nodeRunId,
        cascade: false,
      })
    } catch (error) {
      const value =
        error !== null && typeof error === 'object' && 'code' in error
          ? Reflect.get(error, 'code')
          : null
      code = typeof value === 'string' ? value : `no-code:${String(error)}`
    }
    const after = (
      await harness.db.select().from(tasks).where(eq(tasks.id, fixture.taskId)).limit(1)
    )[0]

    expect({ code, status: after?.status, errorSummary: after?.errorSummary }).toEqual({
      code: 'snapshot-lost',
      status: 'failed',
      errorSummary: 'snapshot-lost',
    })
  })
})

describeEachProvider('RFC-359 W9 —— retry 的级联与尝试铸造', (harness) => {
  let fixture: Fixture | undefined
  afterEach(() => {
    fixture?.cleanup()
    fixture = undefined
  })

  // 级联是 retry 的核心语义（RFC-052 / RFC-053 PR-C：按 `NODE_KIND_BEHAVIORS[kind].retryCascade`
  // 给下游铸 placeholder）。两份实现各 485 / 259 行，谁也没跟谁比过这一格。
  test('级联重试之后，两个引擎落下同一组 node_run', async () => {
    fixture = await seedFixture(harness.db, {
      definition: CASCADE_DEFINITION,
      status: 'failed',
      runs: [
        { nodeId: 'a', status: 'failed' },
        { nodeId: 'b', status: 'done' },
      ],
    })
    const execution = await executionFor(harness, fixture)
    await execution.provider.routes.tasks.retry({
      actor: execution.actor,
      taskId: fixture.taskId,
      nodeRunId: fixture.nodeRunId,
      cascade: true,
    })

    const rows = await harness.db
      .select({
        nodeId: nodeRuns.nodeId,
        status: nodeRuns.status,
        retryIndex: nodeRuns.retryIndex,
      })
      .from(nodeRuns)
      .where(eq(nodeRuns.taskId, fixture.taskId))
    const shape = rows
      .map((row) => `${row.nodeId}#${row.retryIndex}:${row.status}`)
      .sort()
      .join(' | ')

    // 形状而不是 id：两侧铸的行 id 不同（ULID），但「哪个节点、第几次尝试、什么状态」必须一致。
    // 铸的是 `failed` 占位行而不是 `pending`：`retryNode` 的原文是「flip target + downstream
    // node_runs from done → failed so the resumer re-runs them，插一条 retry_index max+1 的新行」。
    // 两个引擎逐格相同。
    expect(shape, '级联重试后两个引擎落下的 node_run 组成不同').toBe(
      'a#0:failed | a#1:failed | b#0:done | b#1:failed',
    )
  })
})

// 三格的变异实证（各在不同侧、不同机制，证明本组确有预言力）：
//   · PG 的 `retryNodeIds` 忽略 `cascade:false` ⇒ 「不级联」那格红；
//   · SQLite 铸新尝试时把 `iteration` 写死 0 ⇒ 「帧继承」那格红；
//   · SQLite 的准入 CAS 不再清 `errorSummary` ⇒ 「任务收尾」那格红。
describeEachProvider('RFC-359 W9 —— retry 的不级联 / 帧继承 / 任务收尾', (harness) => {
  let fixture: Fixture | undefined
  afterEach(() => {
    fixture?.cleanup()
    fixture = undefined
  })

  test('cascade:false 只动被点的那个节点', async () => {
    fixture = await seedFixture(harness.db, {
      definition: CASCADE_DEFINITION,
      status: 'failed',
      runs: [
        { nodeId: 'a', status: 'failed' },
        { nodeId: 'b', status: 'done' },
      ],
    })
    const execution = await executionFor(harness, fixture)
    await execution.provider.routes.tasks.retry({
      actor: execution.actor,
      taskId: fixture.taskId,
      nodeRunId: fixture.nodeRunId,
      cascade: false,
    })
    expect(await runShape(harness.db, fixture.taskId), '不级联却动了下游').toBe(
      'a#0:failed | a#1:failed | b#0:done',
    )
  })

  // RFC-074 / RFC-052：铸出的尝试必须落在**同一个 loop / 评审轮 / 分片帧**里，
  // 否则调度器会把它当成另一帧的行，重跑落在错的上下文上。
  test('铸出的新尝试原样继承 loop / 评审轮 / 分片帧', async () => {
    fixture = await seedFixture(harness.db, {
      status: 'failed',
      runs: [
        {
          nodeId: 'doc',
          status: 'failed',
          frame: { iteration: 2, reviewIteration: 1, shardKey: 'shard-b' },
        },
      ],
    })
    const execution = await executionFor(harness, fixture)
    await execution.provider.routes.tasks.retry({
      actor: execution.actor,
      taskId: fixture.taskId,
      nodeRunId: fixture.nodeRunId,
      cascade: true,
    })
    const minted = (
      await harness.db
        .select({
          retryIndex: nodeRuns.retryIndex,
          iteration: nodeRuns.iteration,
          reviewIteration: nodeRuns.reviewIteration,
          shardKey: nodeRuns.shardKey,
        })
        .from(nodeRuns)
        .where(eq(nodeRuns.taskId, fixture.taskId))
    )
      .filter((row) => row.retryIndex === 1)
      .map((row) => ({
        iteration: row.iteration,
        reviewIteration: row.reviewIteration,
        shardKey: row.shardKey,
      }))
    expect(minted, '新尝试没有落在原来那一帧里').toEqual([
      { iteration: 2, reviewIteration: 1, shardKey: 'shard-b' },
    ])
  })

  test('重试之后任务回到 pending，且失败现场被清干净', async () => {
    fixture = await seedFixture(harness.db, {
      status: 'failed',
      runs: [{ nodeId: 'doc', status: 'failed' }],
    })
    await harness.db
      .update(tasks)
      .set({ errorSummary: 'boom', errorMessage: 'detail', failedNodeId: 'doc' })
      .where(eq(tasks.id, fixture.taskId))
    const execution = await executionFor(harness, fixture)
    await execution.provider.routes.tasks.retry({
      actor: execution.actor,
      taskId: fixture.taskId,
      nodeRunId: fixture.nodeRunId,
      cascade: true,
    })
    const after = (
      await harness.db.select().from(tasks).where(eq(tasks.id, fixture.taskId)).limit(1)
    )[0]
    expect({
      status: after?.status,
      errorSummary: after?.errorSummary,
      errorMessage: after?.errorMessage,
      failedNodeId: after?.failedNodeId,
      finishedAt: after?.finishedAt,
    }).toEqual({
      status: 'pending',
      errorSummary: null,
      errorMessage: null,
      failedNodeId: null,
      finishedAt: null,
    })
  })
})

// RFC-099 审计（2026-07-15）锁的那条门序：**校验 nodeRunId 归属必须早于准入 CAS**。
// 旧顺序先 CAS 再查 `runRow.taskId`，于是一个伪造 / 跨任务的 nodeRunId 会把一个已完成的
// 任务打成「没有调度器的 pending 僵尸」并抹掉它的完成元数据，然后才报 404。
// `retry-node-guard-order.test.ts` 在 SQLite 侧锁着它；这里是**两个引擎的对拍**——
// 门序在两份实现里各写了一遍，没有任何东西比较过它们。
// 变异实证（两半各验一次、分别落在两侧）：
//   · SQLite 的归属校验放宽成「只查存在」（`runRow.taskId !== taskId` 去掉）
//     ⇒ 「跨任务」那格红——证明这条锁的是**归属**而不只是存在；
//   · PG 的 `node-run-not-found` 换成别的码 ⇒ 两格都红——证明错误码那一半也在被断言。
describeEachProvider('RFC-359 W9 —— retry 的 nodeRunId 归属门早于 CAS', (harness) => {
  let fixture: Fixture | undefined
  afterEach(() => {
    fixture?.cleanup()
    fixture = undefined
  })

  test('伪造的 nodeRunId：404 且任务一个字段都没动', async () => {
    fixture = await seedFixture(harness.db, {
      status: 'done',
      runs: [{ nodeId: 'doc', status: 'done' }],
    })
    const before = (
      await harness.db.select().from(tasks).where(eq(tasks.id, fixture.taskId)).limit(1)
    )[0]
    const execution = await executionFor(harness, fixture)
    let code = 'no-throw'
    try {
      await execution.provider.routes.tasks.retry({
        actor: execution.actor,
        taskId: fixture.taskId,
        nodeRunId: 'no_such_node_run',
        cascade: true,
      })
    } catch (error) {
      const value =
        error !== null && typeof error === 'object' && 'code' in error
          ? Reflect.get(error, 'code')
          : null
      code = typeof value === 'string' ? value : `no-code:${String(error)}`
    }
    const after = (
      await harness.db.select().from(tasks).where(eq(tasks.id, fixture.taskId)).limit(1)
    )[0]

    expect(code).toBe('node-run-not-found')
    expect(
      {
        status: after?.status,
        finishedAt: after?.finishedAt,
        errorSummary: after?.errorSummary,
      },
      '被拒的重试改动了任务——门序退回了 CAS 在前的那一版',
    ).toEqual({
      status: before?.status,
      finishedAt: before?.finishedAt,
      errorSummary: before?.errorSummary,
    })
  })

  test('跨任务的 nodeRunId：同样 404 且两个任务都没动', async () => {
    fixture = await seedFixture(harness.db, {
      status: 'done',
      runs: [{ nodeId: 'doc', status: 'done' }],
    })
    const other = await seedFixture(harness.db, {
      status: 'failed',
      runs: [{ nodeId: 'doc', status: 'failed' }],
    })
    const execution = await executionFor(harness, fixture)
    let code = 'no-throw'
    try {
      await execution.provider.routes.tasks.retry({
        actor: execution.actor,
        taskId: fixture.taskId,
        // 别人任务里的行——归属门必须在 CAS 之前把它挡住。
        nodeRunId: other.nodeRunId,
        cascade: true,
      })
    } catch (error) {
      const value =
        error !== null && typeof error === 'object' && 'code' in error
          ? Reflect.get(error, 'code')
          : null
      code = typeof value === 'string' ? value : `no-code:${String(error)}`
    }
    const mine = (
      await harness.db.select().from(tasks).where(eq(tasks.id, fixture.taskId)).limit(1)
    )[0]
    const theirs = (
      await harness.db.select().from(tasks).where(eq(tasks.id, other.taskId)).limit(1)
    )[0]
    other.cleanup()

    expect(code).toBe('node-run-not-found')
    expect({ mine: mine?.status, theirs: theirs?.status }).toEqual({
      mine: 'done',
      theirs: 'failed',
    })
  })
})

// RFC-052 / RFC-053 T1d 的级联矩阵：**每种 NodeKind 在上游被重试时，要不要给它铸占位行**。
//
// 决策的单一事实源是 shared 的 `NODE_KIND_BEHAVIORS[kind].retryCascade`——SQLite 那份直接读它，
// PG 那份经 `nodeKindParticipatesInRetryCascade` 读它。所以这里要验的不是「表对不对」
//（`node-kind-behavior-table` 已经在验），而是**两份实现有没有都去查那张表、并按它办事**。
// `retry-cascade-kind-matrix.test.ts` 在 SQLite 侧逐 kind 锁着这件事；这一格是两个引擎的对拍，
// 节点形状与它共用 `tests/helpers/nodeKindFixtures.ts` 的同一份夹具，免得两边漂。
// 变异实证：让 PG 那份忽略共享表（级联时不再按 kind 跳过）⇒ 本格当场红。
describeEachProvider('RFC-359 W9 —— retry 级联的 kind 矩阵', (harness) => {
  const fixtures: Fixture[] = []
  afterEach(() => {
    for (const item of fixtures) item.cleanup()
    fixtures.length = 0
  })

  test('每种可构造的 NodeKind，两个引擎的铸/跳判断都与共享表一致', async () => {
    // `code-round` 由 `startCodeRoundTask` 合成、校验器拒绝出现在用户定义里，
    // 不可能是某个下游节点——夹具对它显式抛错，这里跳过。
    const kinds = (Object.keys(NODE_KIND_BEHAVIORS) as NodeKind[]).filter(
      (kind) => kind !== 'code-round',
    )
    expect(kinds.length, '矩阵抽空了 ⇒ 本格零预言力').toBeGreaterThanOrEqual(10)

    const observed: string[] = []
    const expected: string[] = []
    for (const kind of kinds) {
      const downId = `down_${kind.replace(/-/g, '_')}`
      const definition = {
        $schema_version: 5,
        inputs: [],
        nodes: [
          { id: 'agent_a', kind: 'agent-single', agentName: 'a', promptTemplate: '' },
          minimalNodeOfKind(downId, kind, 'agent_a'),
        ],
        edges: [
          {
            id: `agent_a-${downId}`,
            source: { nodeId: 'agent_a', portName: 'out' },
            target: { nodeId: downId, portName: 'in' },
          },
        ],
      } as unknown as WorkflowDefinition
      const fixture = await seedFixture(harness.db, {
        definition,
        status: 'failed',
        runs: [
          { nodeId: 'agent_a', status: 'failed' },
          { nodeId: downId, status: 'done' },
        ],
      })
      fixtures.push(fixture)
      const execution = await executionFor(harness, fixture)
      await execution.provider.routes.tasks.retry({
        actor: execution.actor,
        taskId: fixture.taskId,
        nodeRunId: fixture.nodeRunId,
        cascade: true,
      })
      const minted = (
        await harness.db
          .select({ nodeId: nodeRuns.nodeId, retryIndex: nodeRuns.retryIndex })
          .from(nodeRuns)
          .where(eq(nodeRuns.taskId, fixture.taskId))
      ).some((row) => row.nodeId === downId && row.retryIndex === 1)
      observed.push(`${kind}:${minted ? 'mint' : 'skip'}`)
      expected.push(`${kind}:${nodeKindParticipatesInRetryCascade(kind) ? 'mint' : 'skip'}`)
    }

    expect(observed, '某一侧的级联判断没有按共享表办事').toEqual(expected)
  })
})
