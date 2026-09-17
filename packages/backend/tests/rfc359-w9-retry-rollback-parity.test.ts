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

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, tasks, users, workflows } from '@/db/schema'
import { runGit } from '@/util/git'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { describeEachProvider } from './helpers/eachProvider'
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
  readonly runs?: readonly { readonly nodeId: string; readonly status: string }[]
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

  await db.insert(users).values({
    id: USER_ID,
    username: USER_ID,
    displayName: USER_ID,
    role: 'admin',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
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
      iteration: 0,
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
