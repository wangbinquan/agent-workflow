// RFC-359 W7 —— `TaskRouteOperations` / `TaskRouteLaunchOperations` 两对适配器的双引擎对拍。
//
// # 这一对**不合**（判定见文件末尾的账本注释，逐方法结论写在 plan.md 的 W7 段）
//
// 成对账本上它记着 `sqliteTaskRouteOperations.ts`(292) / `postgresqlTaskRouteOperations.ts`(2048)，
// 看上去是「薄壳 + 重写」的典型形态。逐方法核对后不是：
//
//   · SQLite 那 292 行**不是**实现，是一层转发；它背后的实现是 `services/task.ts`（7,742 行，
//     其中约 2,500 行服务本端口）+ `services/taskDelete.ts`(399) + `taskCollab.ts`(516)
//     + `platform/persistence/sqlite/taskLifecycleRepair.ts`(513)。那台机器带**模块级可变全局**
//     （`taskDriverRegistry` / `isTaskActive` / `materializingSpaces` / 列表的 in-flight 合流表）、
//     两处 `dbTxSync`，并且**自己驱动进程内 scheduler**（`createTaskDriveCoordinator` + 续跑意图）。
//   · PostgreSQL 那 2,048 行走的是**另一套执行架构**：命令一律委托给 `ChildTaskLifecycleParticipant`
//     / `ActiveTaskExecutionParticipant` / `SchedulerRuntimeTopology` 三个端口，事务是
//     `withPostgresqlSerializableTaskExecution`，事件走已提交事件出站。
//
// 两侧满足同一个 route-facing 接口，但**不是同一个算法的两份实现**，是两台执行引擎。合它等于
// 先把 `services/task.ts` 的调度耦合与同步事务面清掉——那是 W7 已记在案的结构性阻塞
// （「同步事务面是死代码清理的前置」），不是本轮能顺手做的事。
//
// 于是本文件按 `IntentApplyOperations` 的先例办：
//   · **A 段**＝两侧真正同义的公共子集，一份 body 在两个引擎上各跑一遍。这是「将来真合一时不许退化的」。
//   · **B 段**＝实测出来的分叉，逐条钉成显式断言。这是「合一会抹掉的」。
//   · **C 段**＝`TaskRouteLaunchOperations` 这一对里**可驱动**的那两个方法。它的 `launch`
//     两侧各是一整台启动机器（磁盘 + git worktree），对拍覆盖不到；判据型的
//     `uploadLimits` / `assertReplayVisible` 恰好是这一对唯一自带判据的部分。
//
// # B 段只收「架构不同」，不收「一侧更弱」
//
// 第一轮对拍照出的**弱侧欠账**已按强侧抬齐并搬进 A 段（改的都在
// `postgresqlTaskRouteOperations.ts` 内）：
//   · `assertNotBuiltin`：内置工作流在 PG 上可被手动执行 / 被 sync（判据缺口账本 01a / 01b）；
//   · `call-row-finalized`：父调用节点已终结的子任务在 PG 上仍可 retry（判据缺口账本 02）；
//   · `workflowName`：PG 的任务投影与列表投影**恒为 null**，详情页 / 列表 / sync 预览的工作流名
//     在 PG 部署上永远空白；
//   · `compareNodeRunsForTimeline`：PG 的 node_run 时间线不按评审轮锚点重排，评审行落在
//     「槽位首次打开」的时刻而不是它评审的内容之后；
//   · `events` 分页口径：PG 默认 1000 / 上限 5000，SQLite 默认 500 / 上限 1000——同一个
//     `GET /api/tasks/:id/runs/:runId/events` 在两个部署上回不同条数；
//   · 多仓 `diff`：一个可用 base commit 都没有时，SQLite 409 `task-no-base-commit`，
//     PG 回一个空 diff 假装成功。
// 判据同 W7 前例：分叉能不能只用「两侧都已有的东西」抹平。能，就是弱侧欠账，抬齐后进 A 段；
// 不能（要给一侧凭空造一套机制），才是 B 段。

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  docVersions,
  lifecycleAlerts,
  nodeRunEvents,
  nodeRunOutputs,
  nodeRuns,
  taskCollaborators,
  taskRepos,
  tasks,
  users,
  workflows,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { composeOwnerIdentityQueries } from '@/modules/identity-access/composition/ownerIdentityQueries'
import { createSqliteTaskRouteLaunchOperations } from '@/modules/task-execution/infrastructure/sqliteTaskRouteLaunchOperations'
import { createSqliteTaskRouteOperations } from '@/modules/task-execution/infrastructure/sqliteTaskRouteOperations'
import {
  createPostgresqlTaskRouteOperations,
  type PostgresqlTaskRouteOperationsDependencies,
} from '@/modules/task-execution/infrastructure/postgresqlTaskRouteOperations'
import { createPostgresqlTaskRouteLaunchOperations } from '@/modules/task-execution/infrastructure/postgresqlTaskRouteLaunchOperations'
import type {
  AgentRouteTaskLaunchOperations,
  WorkgroupRouteTaskLaunchOperations,
} from '@/modules/task-execution/public/commands'
import type { TaskRouteOperations } from '@/modules/task-execution/public/taskRoutes'
import { DEFAULT_UPLOAD_LIMITS } from '@/services/upload'
import {
  REPO_PREP_NODE_ID,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const ulid = monotonicFactory()

const WRITER = 'writer'
const REVIEW = 'rv'

let APP_HOME = ''
let PREVIOUS_HOME: string | undefined

beforeAll(() => {
  APP_HOME = mkdtempSync(join(tmpdir(), 'aw-rfc359-w7-taskroute-'))
  PREVIOUS_HOME = process.env['AGENT_WORKFLOW_HOME']
  process.env['AGENT_WORKFLOW_HOME'] = APP_HOME
})

afterAll(() => {
  if (PREVIOUS_HOME === undefined) delete process.env['AGENT_WORKFLOW_HOME']
  else process.env['AGENT_WORKFLOW_HOME'] = PREVIOUS_HOME
  if (APP_HOME !== '') rmSync(APP_HOME, { recursive: true, force: true })
})

// ─────────────────────────────────────────────────────────────────────────────
// actor 夹具
// ─────────────────────────────────────────────────────────────────────────────

function actorOf(
  id: string,
  permissions: readonly string[] = [],
  role: 'admin' | 'user' = 'user',
): Actor {
  return {
    user: {
      id,
      username: id,
      displayName: id,
      role,
      status: 'active',
    },
    source: 'session',
    permissions: new Set(permissions),
  } as unknown as Actor
}

const OWNER = 'u_owner'
const COLLABORATOR = 'u_collab'
const OBSERVER = 'u_observer'
const STRANGER = 'u_stranger'

// ─────────────────────────────────────────────────────────────────────────────
// 两个引擎各自装配它自己的生产实现（合一之前只能这么对拍）
// ─────────────────────────────────────────────────────────────────────────────

function unusedDependency(name: string): never {
  throw new Error(`rfc359-w7 对拍不驱动 ${name}`)
}

function sqliteOperations(db: ProviderNeutralDatabase): TaskRouteOperations {
  return createSqliteTaskRouteOperations({
    db: db as unknown as DbClient,
    collaboration: {} as never,
    recovery: {} as never,
    // SQLite 壳在调用 `retryNode` / `resumeTask` **之前**就展开这个对象，所以它不能抛；
    // 本对拍只驱动到前置门为止，门后的驱动依赖一个都用不到。
    startDepsFor: () => ({ db }) as never,
    multipart: {} as never,
    // 同上：壳在进入服务之前就展开依赖，所以这里给空对象而不是抛。
    resourceAuthorityFor: () => ({}) as never,
    assertWorkflowLaunchable: async () => unusedDependency('assertWorkflowLaunchable'),
    appHome: APP_HOME,
  })
}

/**
 * PostgreSQL 侧的**真实现**，只把本对拍不驱动的协作者换成替身：
 * 资源权威读的是同一张 `workflows` 表（生产里由 resource-catalog 提供），
 * 用户目录读的是同一张 `users` 表（生产里由 identity-access 提供）。
 */
function postgresqlOperations(db: ProviderNeutralDatabase): TaskRouteOperations {
  const client = db as unknown as PostgresqlDatabaseClient
  const dependencies = {
    db: client,
    collaboration: {} as never,
    launch: {
      configPath: join(APP_HOME, 'config.json'),
      agent: {
        resources: {
          validateHostWorkflow: async () => ({ ok: true, issues: [] }),
        },
      },
      resourceAuthorityFor: () =>
        ({
          resources: {
            async loadAuthorized(
              _authority: unknown,
              requests: readonly { kind: string; workflowId: string }[],
            ) {
              const request = requests[0]
              if (request === undefined) return []
              const rows = await db
                .select()
                .from(workflows)
                .where(eq(workflows.id, request.workflowId))
                .limit(1)
              const row = rows[0]
              if (row === undefined) {
                throw Object.assign(new Error('workflow-not-found'), {
                  code: 'workflow-not-found',
                })
              }
              return [
                {
                  kind: 'workflow-launch',
                  workflow: {
                    id: row.id,
                    name: row.name,
                    version: row.version,
                    definition: JSON.parse(row.definition) as WorkflowDefinition,
                  },
                },
              ]
            },
            async freezeCallClosure() {
              return null
            },
          },
        }) as never,
    },
    persistence: {} as never,
    children: {} as never,
    activity: {
      isActive: () => false,
      awaitReleasedSettled: async () => {},
    },
    topology: {} as never,
    resumeRuntimeFor: () => ({}) as never,
    repositoryPreparationRetry: {
      // B5：PG 侧 retry 对 `__repo_prep__` 行不做任何过期判定，整条转交给这个命令。
      async retry() {
        throw Object.assign(new Error('repository preparation retry invoked'), {
          code: 'rfc359-w7-repository-preparation-retry-called',
        })
      },
    },
    users: {
      async lookup(ids: readonly string[]) {
        if (ids.length === 0) return []
        const rows = await db.select().from(users)
        return rows
          .filter((row) => ids.includes(row.id))
          .map((row) => ({
            id: row.id,
            username: row.username,
            displayName: row.displayName,
            role: row.role,
            status: row.status,
          }))
      },
    },
    owners: composeOwnerIdentityQueries(db),
    membershipEvents: { committed: async () => {} },
    deletionEvents: { committed: async () => {} },
    repair: {} as never,
    appHome: APP_HOME,
  } as unknown as PostgresqlTaskRouteOperationsDependencies
  return createPostgresqlTaskRouteOperations(dependencies)
}

function operations(harness: ProviderHarness): TaskRouteOperations {
  return harness.capabilities.provider === 'postgresql'
    ? postgresqlOperations(harness.db)
    : sqliteOperations(harness.db)
}

/** `TaskRouteLaunchOperations` 这一对：两侧的 agent / workgroup 两条臂。 */
interface LaunchArms {
  readonly agent: AgentRouteTaskLaunchOperations
  readonly workgroup: WorkgroupRouteTaskLaunchOperations
}

function launchOperations(harness: ProviderHarness): LaunchArms {
  const configPath = join(APP_HOME, 'config.json')
  if (harness.capabilities.provider === 'postgresql') {
    return createPostgresqlTaskRouteLaunchOperations({
      db: harness.db as unknown as PostgresqlDatabaseClient,
      configPath,
    } as never)
  }
  return createSqliteTaskRouteLaunchOperations({
    db: harness.db as unknown as DbClient,
    configPath,
    executionFor: () => unusedDependency('executionFor'),
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

function definition(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: WRITER, kind: 'agent-single', agentName: 'agent-writer' } as WorkflowNode,
    { id: REVIEW, kind: 'review', title: 'Review' } as unknown as WorkflowNode,
  ]
  return {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges: [
      {
        id: 'e_writer_review',
        source: { nodeId: WRITER, portName: 'out' },
        target: { nodeId: REVIEW, portName: 'in' },
      },
    ],
    outputs: [],
  } as unknown as WorkflowDefinition
}

/** `tasks.owner_user_id` 在 SQLite 上带 FK，所以每个夹具先把这四个用户种好（幂等）。 */
async function seedUsers(db: ProviderNeutralDatabase): Promise<void> {
  const now = Date.now()
  await db
    .insert(users)
    .values(
      [OWNER, COLLABORATOR, OBSERVER, STRANGER].map((id) => ({
        id,
        username: id,
        displayName: id,
        role: 'user' as const,
        status: 'active' as const,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing()
}

async function seedWorkflow(
  db: ProviderNeutralDatabase,
  options: { builtin?: boolean; name?: string } = {},
): Promise<string> {
  const id = `wf_${ulid()}`
  await db.insert(workflows).values({
    id,
    name: options.name ?? 'rfc359-w7-taskroute',
    description: '',
    definition: JSON.stringify(definition()),
    version: 1,
    schemaVersion: 4,
    ...(options.builtin === true ? { builtin: true } : {}),
  })
  return id
}

interface SeedTaskOptions {
  readonly workflowId?: string
  readonly status?: string
  readonly ownerUserId?: string | null
  readonly startedAt?: number
  readonly parentTaskId?: string | null
  readonly parentNodeRunId?: string | null
  readonly spaceKind?: string
  readonly worktreePath?: string
  readonly baseCommit?: string | null
  readonly repoCount?: number
  readonly name?: string
}

async function seedTask(
  db: ProviderNeutralDatabase,
  options: SeedTaskOptions = {},
): Promise<string> {
  const id = `t_${ulid()}`
  await seedUsers(db)
  const workflowId = options.workflowId ?? (await seedWorkflow(db))
  await db.insert(tasks).values({
    id,
    name: options.name ?? 'rfc359 w7 task',
    workflowId,
    workflowSnapshot: JSON.stringify(definition()),
    workflowVersion: 1,
    repoPath: '/tmp/aw-rfc359-w7',
    worktreePath: options.worktreePath ?? '',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    baseCommit: options.baseCommit ?? null,
    status: (options.status ?? 'done') as 'done',
    inputs: '{}',
    startedAt: options.startedAt ?? Date.now(),
    ownerUserId: options.ownerUserId === undefined ? OWNER : options.ownerUserId,
    repoCount: options.repoCount ?? 1,
    spaceKind: (options.spaceKind ?? 'local') as 'local',
    parentTaskId: options.parentTaskId ?? null,
    parentNodeRunId: options.parentNodeRunId ?? null,
    executionLineageId: id,
  })
  return id
}

async function seedMembers(
  db: ProviderNeutralDatabase,
  taskId: string,
  rows: ReadonlyArray<{ userId: string; role: 'owner' | 'collaborator' | 'observer' }>,
): Promise<void> {
  if (rows.length === 0) return
  await db
    .insert(taskCollaborators)
    .values(rows.map((row) => ({ taskId, ...row, addedBy: OWNER, addedAt: Date.now() })))
}

async function seedRun(
  db: ProviderNeutralDatabase,
  taskId: string,
  values: Partial<typeof nodeRuns.$inferInsert> & { nodeId: string },
): Promise<string> {
  const id = `nr_${ulid()}`
  await db.insert(nodeRuns).values({
    id,
    taskId,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    ...values,
  } as typeof nodeRuns.$inferInsert)
  return id
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    const value =
      error !== null && typeof error === 'object' && 'code' in error
        ? Reflect.get(error, 'code')
        : null
    return typeof value === 'string' ? value : `no-code:${String(error)}`
  }
  return 'no-throw'
}

// ═════════════════════════════════════════════════════════════════════════════
// A 段 —— 两个引擎必须给出同一个答案
// ═════════════════════════════════════════════════════════════════════════════

describeEachProvider('rfc359-w7 task route · A 段公共契约', (harness) => {
  test('A1 get：未知任务回 null；仓库/目录节点/失败码按行投影', async () => {
    const ops = operations(harness)
    expect(await ops.get('t_missing')).toBeNull()

    const failedNode = 'writer'
    const taskId = await seedTask(harness.db, { status: 'failed', name: 'A1' })
    await harness.db
      .update(tasks)
      .set({ failedNodeId: failedNode, errorSummary: 'boom' })
      .where(eq(tasks.id, taskId))
    await seedRun(harness.db, taskId, {
      nodeId: failedNode,
      status: 'failed',
      failureCode: 'agent-nonzero-exit',
    })

    const task = await ops.get(taskId)
    expect(task).not.toBeNull()
    expect(task?.id).toBe(taskId)
    expect(task?.status).toBe('failed')
    expect(task?.failureCode).toBe('agent-nonzero-exit')
    // task_repos 为空时两侧都合成一条兜底 repo（legacy 行 / 准备失败的任务）。
    expect(task?.repos.length).toBe(1)
    expect(task?.repos[0]?.repoIndex).toBe(0)
    expect(task?.spaceNodes?.map((node) => node.path)).toEqual([''])
  })

  test('A2 get：workflowName 投影自 workflows 行（弱侧抬齐）', async () => {
    const ops = operations(harness)
    const workflowId = await seedWorkflow(harness.db, { name: 'named-workflow' })
    const taskId = await seedTask(harness.db, { workflowId })
    expect((await ops.get(taskId))?.workflowName).toBe('named-workflow')
    const summaries = await ops.list({ limit: 50 })
    expect(summaries.find((row) => row.id === taskId)?.workflowName).toBe('named-workflow')
  })

  test('A3 list：状态 / workflow / 父子 / 可见性筛选与 startedAt 倒序', async () => {
    const ops = operations(harness)
    const workflowId = await seedWorkflow(harness.db)
    const older = await seedTask(harness.db, { workflowId, startedAt: 1_000, status: 'done' })
    const newer = await seedTask(harness.db, { workflowId, startedAt: 2_000, status: 'failed' })
    const child = await seedTask(harness.db, {
      workflowId,
      startedAt: 1_500,
      parentTaskId: newer,
      ownerUserId: STRANGER,
    })

    const all = await ops.list({ workflowId })
    expect(all.map((row) => row.id)).toEqual([newer, child, older])

    expect((await ops.list({ workflowId, status: 'failed' })).map((row) => row.id)).toEqual([newer])
    expect((await ops.list({ workflowId, topLevelOnly: true })).map((row) => row.id)).toEqual([
      newer,
      older,
    ])
    expect((await ops.list({ workflowId, parentTaskId: newer })).map((row) => row.id)).toEqual([
      child,
    ])
    expect((await ops.list({ workflowId, limit: 1 })).map((row) => row.id)).toEqual([newer])

    // 可见性：'mine' = 自己拥有 ∪ 自己是成员；'shared' = 是成员但不是 owner。
    await seedMembers(harness.db, older, [{ userId: STRANGER, role: 'collaborator' }])
    const mine = await ops.list({
      workflowId,
      visibility: { actorUserId: STRANGER, scope: 'mine' },
    })
    expect(new Set(mine.map((row) => row.id))).toEqual(new Set([child, older]))
    const shared = await ops.list({
      workflowId,
      visibility: { actorUserId: STRANGER, scope: 'shared' },
    })
    expect(shared.map((row) => row.id)).toEqual([older])
  })

  test('A4 list：openAlertCount 只数未解决的告警', async () => {
    const ops = operations(harness)
    const workflowId = await seedWorkflow(harness.db)
    const taskId = await seedTask(harness.db, { workflowId })
    await harness.db.insert(lifecycleAlerts).values([
      {
        id: `al_${ulid()}`,
        taskId,
        rule: 'stuck',
        severity: 'warn',
        detail: '',
        detectedAt: 1,
        resolvedAt: null,
      },
      {
        id: `al_${ulid()}`,
        taskId,
        rule: 'stuck',
        severity: 'warn',
        detail: '',
        detectedAt: 2,
        resolvedAt: 5,
      },
    ])
    const summary = (await ops.list({ workflowId })).find((row) => row.id === taskId)
    expect(summary?.openAlertCount).toBe(1)
  })

  test('A5 listItems：owner 身份 + 本 actor 可见的直接子任务数', async () => {
    const ops = operations(harness)
    await seedUsers(harness.db)
    const workflowId = await seedWorkflow(harness.db)
    const parent = await seedTask(harness.db, { workflowId, startedAt: 3_000 })
    await seedTask(harness.db, { workflowId, startedAt: 2_000, parentTaskId: parent })
    await seedTask(harness.db, {
      workflowId,
      startedAt: 1_000,
      parentTaskId: parent,
      ownerUserId: STRANGER,
    })

    const unfiltered = await ops.listItems({ workflowId, topLevelOnly: true })
    const row = unfiltered.find((item) => item.id === parent)
    expect(row?.ownerUserId).toBe(OWNER)
    expect(row?.owner?.username).toBe(OWNER)
    expect(row?.childCount).toBe(2)

    const scoped = await ops.listItems({
      workflowId,
      topLevelOnly: true,
      visibility: { actorUserId: OWNER, scope: 'mine' },
    })
    expect(scoped.find((item) => item.id === parent)?.childCount).toBe(1)
  })

  test('A6 assertVisible：owner / 成员 / 观察者可见，陌生人 404', async () => {
    const ops = operations(harness)
    const taskId = await seedTask(harness.db)
    await seedMembers(harness.db, taskId, [
      { userId: COLLABORATOR, role: 'collaborator' },
      { userId: OBSERVER, role: 'observer' },
    ])
    expect(await code(ops.assertVisible(actorOf(OWNER), taskId))).toBe('no-throw')
    expect(await code(ops.assertVisible(actorOf(COLLABORATOR), taskId))).toBe('no-throw')
    // RFC-324：观察者被加进来就是为了看，所以可见性判据数**任意**成员行。
    expect(await code(ops.assertVisible(actorOf(OBSERVER), taskId))).toBe('no-throw')
    expect(await code(ops.assertVisible(actorOf(STRANGER), taskId))).toBe('task-not-found')
    expect(await code(ops.assertVisible(actorOf(STRANGER, ['tasks:read:all']), taskId))).toBe(
      'no-throw',
    )
  })

  test('A7 requireOperator：owner / collaborator / bypass 放行，observer 拒绝', async () => {
    const ops = operations(harness)
    const taskId = await seedTask(harness.db)
    await seedMembers(harness.db, taskId, [
      { userId: COLLABORATOR, role: 'collaborator' },
      { userId: OBSERVER, role: 'observer' },
    ])
    expect(await code(ops.requireOperator(actorOf(OWNER), taskId))).toBe('no-throw')
    expect(await code(ops.requireOperator(actorOf(COLLABORATOR), taskId))).toBe('no-throw')
    expect(
      await code(ops.requireOperator(actorOf(STRANGER, ['resource-acl:bypass']), taskId)),
    ).toBe('no-throw')
    // 观察者只读——两侧都拒（错误码不同，见 B 段）。
    expect(await code(ops.requireOperator(actorOf(OBSERVER), taskId))).not.toBe('no-throw')
    expect(await code(ops.requireOperator(actorOf(STRANGER), taskId))).not.toBe('no-throw')
  })

  test('A8 getMembers：owner 行不进列表，canManage / canOperate 分档', async () => {
    const ops = operations(harness)
    await seedUsers(harness.db)
    const taskId = await seedTask(harness.db)
    await seedMembers(harness.db, taskId, [
      { userId: OWNER, role: 'owner' },
      { userId: COLLABORATOR, role: 'collaborator' },
      { userId: OBSERVER, role: 'observer' },
    ])

    const asOwner = await ops.getMembers(actorOf(OWNER), taskId)
    expect(asOwner.taskId).toBe(taskId)
    expect(asOwner.ownerUserId).toBe(OWNER)
    expect(asOwner.owner?.username).toBe(OWNER)
    expect(asOwner.members.map((member) => [member.user.id, member.role]).sort()).toEqual([
      [COLLABORATOR, 'collaborator'],
      [OBSERVER, 'observer'],
    ])
    expect(asOwner.canManage).toBe(true)
    expect(asOwner.canOperate).toBe(true)

    const asCollaborator = await ops.getMembers(actorOf(COLLABORATOR), taskId)
    expect(asCollaborator.canManage).toBe(false)
    expect(asCollaborator.canOperate).toBe(true)

    const asObserver = await ops.getMembers(actorOf(OBSERVER), taskId)
    expect(asObserver.canManage).toBe(false)
    expect(asObserver.canOperate).toBe(false)

    expect(await code(ops.getMembers(actorOf(OWNER), 't_missing'))).toBe('task-not-found')
  })

  test('A9 assertReplayVisible：看不见与不存在同形（都 404）', async () => {
    const ops = operations(harness)
    const taskId = await seedTask(harness.db)
    expect(await code(ops.assertReplayVisible(actorOf(OWNER), taskId))).toBe('no-throw')
    expect(await code(ops.assertReplayVisible(actorOf(STRANGER), taskId))).toBe('task-not-found')
    expect(await code(ops.assertReplayVisible(actorOf(OWNER), 't_missing'))).toBe('task-not-found')
  })

  test('A10 events：跨任务的 node_run 一律 404；since 游标 + 上限口径一致', async () => {
    const ops = operations(harness)
    const taskId = await seedTask(harness.db)
    const otherTaskId = await seedTask(harness.db)
    const runId = await seedRun(harness.db, taskId, { nodeId: WRITER })
    await harness.db.insert(nodeRunEvents).values(
      [1, 2, 3].map((index) => ({
        id: index,
        nodeRunId: runId,
        ts: index,
        kind: 'text' as const,
        payload: JSON.stringify({ n: index }),
      })),
    )

    expect(await code(ops.events(otherTaskId, runId, {}))).toBe('node-run-not-found')
    expect(await code(ops.events(taskId, 'nr_missing', {}))).toBe('node-run-not-found')

    const page = await ops.events(taskId, runId, {})
    expect(page.events.map((event) => event.id)).toEqual([1, 2, 3])
    expect(page.cursor).toBe(3)
    expect(page.events[0]?.payload).toEqual({ n: 1 })

    const tail = await ops.events(taskId, runId, { since: 1, limit: 1 })
    expect(tail.events.map((event) => event.id)).toEqual([2])
    expect(tail.cursor).toBe(2)
  })

  test('A11 stdout：stderr 不进正文，顺序按 id 升序（弱侧抬齐后口径一致）', async () => {
    const ops = operations(harness)
    const taskId = await seedTask(harness.db)
    const runId = await seedRun(harness.db, taskId, { nodeId: WRITER })
    await harness.db.insert(nodeRunEvents).values([
      { id: 1, nodeRunId: runId, ts: 1, kind: 'text' as const, payload: 'alpha' },
      { id: 2, nodeRunId: runId, ts: 2, kind: 'stderr' as const, payload: 'noise' },
      { id: 3, nodeRunId: runId, ts: 3, kind: 'text' as const, payload: 'beta' },
    ])
    expect(await ops.stdout(taskId, runId)).toBe('alpha\nbeta')
    expect(await code(ops.stdout(taskId, 'nr_missing'))).toBe('node-run-not-found')
  })

  test('A12 nodeRuns：未知任务 404；未启动的行排最前；端口输出随行返回', async () => {
    const ops = operations(harness)
    expect(await code(ops.nodeRuns('t_missing'))).toBe('task-not-found')

    const taskId = await seedTask(harness.db)
    const started = await seedRun(harness.db, taskId, {
      nodeId: WRITER,
      startedAt: 5_000,
      finishedAt: 6_000,
    })
    const pending = await seedRun(harness.db, taskId, { nodeId: 'later', status: 'pending' })
    await harness.db.insert(nodeRunOutputs).values({
      nodeRunId: started,
      portName: 'out',
      content: 'value',
      kind: 'text',
    })

    const result = await ops.nodeRuns(taskId)
    expect(result.runs.map((run) => run.id)).toEqual([pending, started])
    expect(result.outputs).toEqual([
      { nodeRunId: started, port: 'out', value: 'value', kind: 'text' },
    ])
  })

  test('A13 nodeRuns：评审行按轮次锚点重排（弱侧抬齐）', async () => {
    const ops = operations(harness)
    const taskId = await seedTask(harness.db)
    // 评审槽位先开（started_at 很早），它评审的内容随后才产出。
    const reviewRun = await seedRun(harness.db, taskId, {
      nodeId: REVIEW,
      status: 'awaiting_review',
      startedAt: 1_000,
      reviewIteration: 0,
    })
    const writerRun = await seedRun(harness.db, taskId, {
      nodeId: WRITER,
      startedAt: 2_000,
      finishedAt: 3_000,
    })
    await harness.db.insert(docVersions).values({
      id: `dv_${ulid()}`,
      taskId,
      reviewNodeId: REVIEW,
      reviewNodeRunId: reviewRun,
      sourceNodeId: WRITER,
      sourcePortName: 'out',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: `reviews/${taskId}/v1.md`,
      commentsJson: '[]',
      decision: 'pending',
      createdAt: 4_000,
    })

    const result = await ops.nodeRuns(taskId)
    // RFC-078：评审行的时间线锚是它这一轮的内容时间，不是槽位首次打开的 started_at。
    expect(result.runs.map((run) => run.id)).toEqual([writerRun, reviewRun])
  })

  test('A14 diff：缺 base commit → 409；工作树不存在 → 410', async () => {
    const ops = operations(harness)
    const noBase = await seedTask(harness.db, { baseCommit: null, repoCount: 1 })
    expect(await code(ops.diff(noBase))).toBe('task-no-base-commit')

    const missing = await seedTask(harness.db, {
      baseCommit: 'deadbeef',
      repoCount: 1,
      worktreePath: join(APP_HOME, 'worktrees', 'nope'),
    })
    expect(await code(ops.diff(missing))).toBe('task-worktree-missing')

    expect(await code(ops.diff('t_missing'))).toBe('task-not-found')
  })

  test('A15 diff：多仓一个可用 base commit 都没有 → 409（弱侧抬齐）', async () => {
    const ops = operations(harness)
    const taskId = await seedTask(harness.db, {
      repoCount: 2,
      worktreePath: APP_HOME,
      baseCommit: null,
    })
    await harness.db.insert(taskRepos).values([0, 1].map((index) => repoRow(taskId, index)))
    expect(await code(ops.diff(taskId))).toBe('task-no-base-commit')
  })

  test('A16 assertManualExecutionAllowed：内置工作流 403 builtin-readonly（判据缺口 01a）', async () => {
    const ops = operations(harness)
    const builtinWorkflowId = await seedWorkflow(harness.db, { builtin: true })
    const builtinTask = await seedTask(harness.db, { workflowId: builtinWorkflowId })
    expect(await code(ops.assertManualExecutionAllowed(actorOf(OWNER), builtinTask))).toBe(
      'builtin-readonly',
    )

    const ordinaryTask = await seedTask(harness.db)
    expect(await code(ops.assertManualExecutionAllowed(actorOf(OWNER), ordinaryTask))).toBe(
      'no-throw',
    )
    // 任务不存在时两侧都不拦（路由随后自己 404）。
    expect(await code(ops.assertManualExecutionAllowed(actorOf(OWNER), 't_missing'))).toBe(
      'no-throw',
    )
  })

  test('A17 syncWorkflow：内置工作流 403 builtin-readonly（判据缺口 01b）', async () => {
    const ops = operations(harness)
    const builtinWorkflowId = await seedWorkflow(harness.db, { builtin: true })
    const taskId = await seedTask(harness.db, {
      workflowId: builtinWorkflowId,
      worktreePath: join(APP_HOME, 'wt', 'sync'),
    })
    expect(
      await code(ops.syncWorkflow({ actor: actorOf(OWNER), taskId, expectedVersion: 1 })),
    ).toBe('builtin-readonly')
  })

  test('A18 retry：父调用行已终结的子任务拒绝重试（判据缺口 02）', async () => {
    const ops = operations(harness)
    const parentTaskId = await seedTask(harness.db)
    const callRunId = await seedRun(harness.db, parentTaskId, {
      nodeId: 'call',
      status: 'done',
    })
    const childTaskId = await seedTask(harness.db, {
      parentTaskId,
      parentNodeRunId: callRunId,
      status: 'failed',
    })
    const childRunId = await seedRun(harness.db, childTaskId, {
      nodeId: WRITER,
      status: 'failed',
    })
    expect(
      await code(
        ops.retry({
          actor: actorOf(OWNER),
          taskId: childTaskId,
          nodeRunId: childRunId,
          cascade: false,
        }),
      ),
    ).toBe('call-row-finalized')
  })

  test('A19 delete：非终态 / 框架内部 / 非终态子任务 / 非终态父任务四道前置门', async () => {
    const ops = operations(harness)
    expect(await code(ops.delete('t_missing'))).toBe('task-not-found')

    const running = await seedTask(harness.db, { status: 'running' })
    expect(await code(ops.delete(running))).toBe('task-not-terminal')

    const internal = await seedTask(harness.db, { spaceKind: 'internal' })
    expect(await code(ops.delete(internal))).toBe('task-internal')

    const parent = await seedTask(harness.db)
    await seedTask(harness.db, { parentTaskId: parent, status: 'running' })
    expect(await code(ops.delete(parent))).toBe('task-has-active-children')

    const liveParent = await seedTask(harness.db, { status: 'running' })
    const child = await seedTask(harness.db, { parentTaskId: liveParent })
    expect(await code(ops.delete(child))).toBe('task-parent-active')
  })

  test('A20 events：缺省 500 条 / 上限 1000 条（弱侧抬齐）', async () => {
    const ops = operations(harness)
    const taskId = await seedTask(harness.db)
    const runId = await seedRun(harness.db, taskId, { nodeId: WRITER })
    const total = 1_200
    await harness.db.insert(nodeRunEvents).values(
      Array.from({ length: total }, (_unused, index) => ({
        id: index + 1,
        nodeRunId: runId,
        ts: index + 1,
        kind: 'text' as const,
        payload: `line-${index + 1}`,
      })),
    )

    // 缺省页：两侧都必须是 500（此前 PG 是 1000）。
    const first = await ops.events(taskId, runId, {})
    expect(first.events.length).toBe(500)
    expect(first.cursor).toBe(500)

    // 上限：调用方要 3000 条，两侧都只给 1000（此前 PG 上限是 5000，会一次给 1200 条）。
    const capped = await ops.events(taskId, runId, { limit: 3_000 })
    expect(capped.events.length).toBe(1_000)
    expect(capped.cursor).toBe(1_000)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// B 段 —— 实测分叉。**不是**弱侧欠账，是两台执行引擎结构不同的后果；钉住现状，
// 让将来任何一侧单方面改动都要先来改这里。
// ═════════════════════════════════════════════════════════════════════════════

describeEachProvider('rfc359-w7 task route · B 段实测分叉', (harness) => {
  // `harness` 只能在 test 体内读——describe 体里读会抛（库还没建）。
  const isPostgresql = (): boolean => harness.capabilities.provider === 'postgresql'

  test('B1 requireOperator 拒绝时的错误码不同（RFC-324 文案 vs 通用成员文案）', async () => {
    const ops = operations(harness)
    const taskId = await seedTask(harness.db)
    await seedMembers(harness.db, taskId, [{ userId: OBSERVER, role: 'observer' }])
    // SQLite 走 `requireTaskOperator`（RFC-324 的观察者只读文案）；PG 是自带的通用文案。
    // 前端按 code 选提示语，所以这条分叉是用户可见的。
    expect(await code(ops.requireOperator(actorOf(OBSERVER), taskId))).toBe(
      isPostgresql() ? 'not-task-member' : 'task-observer-read-only',
    )
  })

  test('B2 任务不存在时的可见性门：SQLite 静默放行，PG 404', async () => {
    const ops = operations(harness)
    // SQLite 壳先取 `taskAccessRow`，取不到就**不判**（路由随后自己 404）；
    // PG 直接问 `canViewTask` / `requireTaskRow`，不存在即 404。两侧最终 HTTP 状态相同，
    // 但抛点不同——把断言错在方法层面的调用方会看到不一样的行为。
    expect(await code(ops.assertVisible(actorOf(STRANGER), 't_missing'))).toBe(
      isPostgresql() ? 'task-not-found' : 'no-throw',
    )
    expect(await code(ops.requireOperator(actorOf(STRANGER), 't_missing'))).toBe(
      isPostgresql() ? 'task-not-found' : 'no-throw',
    )
  })

  test('B3 assertManualExecutionAllowed：PG 额外要求工作流当前可见/仍在', async () => {
    const ops = operations(harness)
    const workflowId = await seedWorkflow(harness.db)
    const taskId = await seedTask(harness.db, { workflowId })
    await harness.db.delete(workflows).where(eq(workflows.id, workflowId))
    // RFC-285 起 `tasks.workflow_id` 是软链：SQLite 的 `getWorkflow` 回 null ⇒ 不拦；
    // PG 的 `loadVisibleWorkflow` 走资源权威，工作流不在就抛。
    expect(await code(ops.assertManualExecutionAllowed(actorOf(OWNER), taskId))).toBe(
      isPostgresql() ? 'workflow-not-found' : 'no-throw',
    )
  })

  test('B4 syncWorkflow 的工作区判据：PG 还认 workspace_pruned_at', async () => {
    const ops = operations(harness)
    const taskId = await seedTask(harness.db, {
      worktreePath: join(APP_HOME, 'wt', 'pruned'),
    })
    await harness.db
      .update(tasks)
      .set({ workspacePrunedAt: Date.now() })
      .where(eq(tasks.id, taskId))
    // SQLite 只判 `worktreePath === ''`，一个已回收（pruned）但路径还在的任务会**穿过**这道门
    // 继续往下走（要到 resumeKick 才撞上）；PG 在前置门就 409 `worktree-missing`。
    const outcome = await code(
      ops.syncWorkflow({ actor: actorOf(OWNER), taskId, expectedVersion: 1 }),
    )
    if (isPostgresql()) expect(outcome).toBe('worktree-missing')
    else expect(outcome).not.toBe('worktree-missing')
  })

  test('B5 retry 一条过期的仓库准备行：SQLite 拒，PG 直接转交准备重试命令', async () => {
    const ops = operations(harness)
    const taskId = await seedTask(harness.db, { status: 'failed' })
    const stale = await seedRun(harness.db, taskId, {
      nodeId: REPO_PREP_NODE_ID,
      status: 'failed',
      retryIndex: 0,
    })
    await seedRun(harness.db, taskId, {
      nodeId: REPO_PREP_NODE_ID,
      status: 'done',
      retryIndex: 1,
    })
    const outcome = await code(
      ops.retry({ actor: actorOf(OWNER), taskId, nodeRunId: stale, cascade: false }),
    )
    if (isPostgresql()) {
      // PG 的 route 层不看被点的是哪一行，整条重试转交给 `RepositoryPreparationRetryCommand`
      // （它自己只认**最新**那一行）——于是点一条早已被取代的准备行也会照跑。
      expect(outcome).toBe('rfc359-w7-repository-preparation-retry-called')
    } else {
      expect(outcome).toBe('repo-prep-superseded')
    }
  })

  test('B6 任务行投影的严格度：PG 用 TaskSchema.parse，SQLite 原样投出', async () => {
    const ops = operations(harness)
    const taskId = await seedTask(harness.db)
    // `space_kind` 是 legacy 行 / 手工修复可能带上的枚举外值。PG 侧的投影是
    // `TaskSchema.parse(...)`，遇到它整条详情 500；SQLite 侧 `rowToTask` 不解析，原样上线。
    await harness.db
      .update(tasks)
      .set({ spaceKind: 'isolated' as 'local' })
      .where(eq(tasks.id, taskId))
    const outcome = await code(ops.get(taskId))
    if (isPostgresql()) expect(outcome).not.toBe('no-throw')
    else expect(outcome).toBe('no-throw')
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// C 段 —— `TaskRouteLaunchOperations` 这一对。
//
// 这一对的 `launch` **驱不动**：它两侧各自要一整台启动机器（SQLite = `startExecution` →
// `startTask` / `startAgentTask` / `startWorkgroupTask` 加工作区物化 + git worktree；
// PG = `createPostgresqlRootTaskLaunchKernel` 的 `createRootLaunch`），落到磁盘和 git 上，
// 不是一个对拍能覆盖的面。端口上**判据型**的两个方法可以，而它们恰好就是这一对唯一自带
// 判据的部分——其余全是转发。
// ═════════════════════════════════════════════════════════════════════════════

describeEachProvider('rfc359-w7 task route launch · C 段可驱动面', (harness) => {
  test('C1 uploadLimits：两侧同一份配置解析（缺配置回同一组缺省值）', async () => {
    const launch = launchOperations(harness)
    expect(launch.agent.uploadLimits()).toEqual({ ...DEFAULT_UPLOAD_LIMITS })
  })

  test('C2 assertReplayVisible：owner / 成员 / tasks:read:all 放行，其余与不存在同形 404', async () => {
    const launch = launchOperations(harness)
    const taskId = await seedTask(harness.db)
    await seedMembers(harness.db, taskId, [{ userId: OBSERVER, role: 'observer' }])

    for (const arm of [launch.agent, launch.workgroup]) {
      expect(await code(arm.assertReplayVisible(actorOf(OWNER), taskId))).toBe('no-throw')
      // RFC-324 观察者也能看见 —— 重放读的是任务冻结的 `task_repos` 构成，判据同可见性。
      expect(await code(arm.assertReplayVisible(actorOf(OBSERVER), taskId))).toBe('no-throw')
      expect(
        await code(arm.assertReplayVisible(actorOf(STRANGER, ['tasks:read:all']), taskId)),
      ).toBe('no-throw')
      // RFC-248 H9：不可见与不存在同形，调用方不能靠错误码区分。
      expect(await code(arm.assertReplayVisible(actorOf(STRANGER), taskId))).toBe('task-not-found')
      expect(await code(arm.assertReplayVisible(actorOf(OWNER), 't_missing'))).toBe(
        'task-not-found',
      )
    }
  })
})

function repoRow(taskId: string, index: number): typeof taskRepos.$inferInsert {
  return {
    taskId,
    repoIndex: index,
    repoPath: `/tmp/aw-rfc359-w7/repo-${index}`,
    repoUrl: null,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    worktreePath: join(APP_HOME, 'worktrees', taskId, `repo-${index}`),
    worktreeDirName: `repo-${index}`,
    mountPath: index === 0 ? '' : `repo-${index}`,
    subdir: '',
    readonly: false,
    baseCommit: null,
  }
}
