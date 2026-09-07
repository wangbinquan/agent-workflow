// RFC-359 W8 —— `TaskRouteOperations` 两对适配器上**PostgreSQL 侧更弱**的能力缺口。
//
// W7 的对拍（`rfc359-w7-task-route-conformance.test.ts`）只驱动到各方法的**前置门**为止，
// 门后的语义没人对过。逐方法核对时照出三处 PG 侧欠账，全部是用户可见的功能差异：
//
//   ① `retry`   —— 缺 RFC-292 冻结 trigger 预检、缺 MR/PR 终结栅栏透传、缺被点行的
//                  `pre_snapshot` 回滚与 `snapshot-lost` 升级。三条的共同后果是
//                  **一个必须被拒绝的重试先把任务改坏了才拒绝**（或者干脆不拒绝）：
//                  任务状态被推走、每个受影响节点多出一条「queued for retry」的假尝试。
//   ② `syncWorkflow` —— 缺 `selectSyncRollbackTargets` 的 canceled 分支。用户取消了一个
//                  写节点、再 sync 工作流，SQLite 会把那次半截写回滚到节点开跑前的快照，
//                  PG 把**半截产物留在工作树里**让新定义在它上面继续跑。
//   ③ `delete`  —— 缺 RFC-311 P1-6 的父链 `branch_started_at` 重算。物化列永久停在
//                  被删子树的时间戳上，任务列表的默认视图（按物化列排序的快路径）与任一
//                  过滤视图（现算）从此行序不同且永不收敛。
//
// # 为什么 `children.resume` 在本文件里是**记录型空实现**
//
// 生产里 PG 的 `retry` / `syncWorkflow` 收尾都调 `children.resume`
// （`postgresqlChildTaskLifecycleParticipant.rollbackForResume`），它确实带一套
// **resume 选择器**的回滚兜底。那份兜底对下面每一条都够不着，所以把它换成空实现
// 不会把红「制造」出来：
//   · ② 的 canceled 行**不在** resume 选择器里（`selectResumeRollbackTargets` 只收
//     failed / interrupted），生产里同样不回滚；
//   · ① 的三条都是**交棒之前**就该发生的事——占位行与子任务取消发生在调 `children.resume`
//     之前，而前置门（trigger 预检、终结栅栏）按 SQLite 的口径必须落在准入 CAS 之前。
//     兜底再强也只能在任务已经被改坏之后才发言。
//   · ③ 根本不经过 resume。
// 换句话说：下面锁的全是 `postgresqlTaskRouteOperations.ts` 自己必须保证的 durable 状态
// 与副作用顺序。
//
// # 断言口径
//
// 一律用**用户能看见的东西**做判据，不用「有没有调某个函数」：任务行的状态字段、node_run
// 时间线里多没多出一条假尝试、工作树里的文件内容、物化排序列的值。
//
// # ⚠️ 覆盖面折扣：凡是靠 `pre_snapshot` 的判据，**只打存量行**
//
// 本文件里 ② / ③ / ⑤ 三组用例（以及 ① 的第三条 `snapshot-lost`）都要先给 node_run 种一个
// `pre_snapshot`。**当前生产路径不会产出这个值**：RFC-130 删掉了写入侧，
// `modules/task-execution/composition/nodeMechanics.ts:4106-4111` 写得很直白——
// 「the RFC-092/098 pre-snapshot (git stash create → pre_snapshot columns) is GONE …
// the pre_snapshot columns + rollbackNodeRunWorktrees stay in the schema as
// defense-in-depth but are no longer written here」。全仓复核过一遍：`src` 里剩下的
// `preSnapshot:` 站点全是**继承传递**（`row.preSnapshot` / `latest.preSnapshot`），
// `pre_snapshot_repos_json` 更是一个写入方都没有。
//
// 所以这几条判据锁的代码路径是活的、判据本身也是对的，但它们实际能影响到的只有
// **pre-RFC-130 的存量行**（迁移前建的任务）。写在这里是为了别让后来人以为它们覆盖了
// 今天的主路径——真要让它们回到主路径，得先有人把快照写入侧接回来。
//
// ⑥（续跑交棒的事件语义）不吃这条折扣：它走的是每一次 PostgreSQL 重试都会发生的事件面。

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'

import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { committedEvents, nodeRuns, tasks, users, workflows } from '@/db/schema'
import { composeOwnerIdentityQueries } from '@/modules/identity-access/composition/ownerIdentityQueries'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import {
  createTaskLifecycleDurableConsumerDefinitions,
  taskLifecycleCommittedEventCodec,
} from '@/modules/task-execution/application/taskLifecycleConsumers'
import { createSqliteTaskRouteOperations } from '@/modules/task-execution/infrastructure/sqliteTaskRouteOperations'
import { createDatabaseTaskLifecycleWsProjector } from '@/modules/task-execution/infrastructure/taskLifecycleWsProjection'
import {
  createPostgresqlTaskRouteOperations,
  type PostgresqlTaskRouteOperationsDependencies,
} from '@/modules/task-execution/infrastructure/postgresqlTaskRouteOperations'
import { createTaskExecutionReadModels } from '@/modules/task-execution/infrastructure/taskExecutionReadModels'
import type { TaskRouteOperations } from '@/modules/task-execution/public/taskRoutes'
import { storedEventFromRow } from '@/platform/events/committed/appendShared'
import { createCommittedEventDeliveryPersistence } from '@/platform/events/committed/deliveryPersistence'
import { createCommittedEventDispatcher } from '@/platform/events/committed/dispatcherWorker'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ChildTaskBudget } from '@/services/execution/childBudget'
import {
  resetTaskTerminalWatchersForTests,
  watchTaskTerminal,
  notifyTaskTerminal,
  type TerminalWatchResult,
} from '@/services/execution/executionWatch'
import {
  TASK_CHANNEL,
  TASKS_LIST_CHANNEL,
  resetBroadcastersForTests,
  taskBroadcaster,
  tasksListBroadcaster,
} from '@/ws/broadcaster'
import { gitStashSnapshot, runGit } from '@/util/git'
import { createLogger } from '@/util/log'
import type { TaskStatus, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import { createTaskExecutionTestTopology } from './helpers/taskExecutionTestTopology'
import { taskRecoveryOperations } from './helpers/taskRecoveryOperations'

const ulid = monotonicFactory()
const log = createLogger('test.rfc359-w8')

const OWNER = 'u_owner'
const WRITER = 'w'

let APP_HOME = ''
let PREVIOUS_HOME: string | undefined
/** 每个用例自己的临时目录（工作树 / 仓库），afterEach 统一回收。 */
const SCRATCH: string[] = []

beforeAll(() => {
  APP_HOME = mkdtempSync(join(tmpdir(), 'aw-rfc359-w8-'))
  PREVIOUS_HOME = process.env['AGENT_WORKFLOW_HOME']
  process.env['AGENT_WORKFLOW_HOME'] = APP_HOME
})

afterAll(() => {
  if (PREVIOUS_HOME === undefined) delete process.env['AGENT_WORKFLOW_HOME']
  else process.env['AGENT_WORKFLOW_HOME'] = PREVIOUS_HOME
  if (APP_HOME !== '') rmSync(APP_HOME, { recursive: true, force: true })
})

afterEach(() => {
  // ⑥ 的两条会往进程级的 watcher 注册表 / WS broadcaster 里挂东西；两个引擎跑同一份 body，
  // 不清干净会让第二遍读到第一遍的残留。
  resetTaskTerminalWatchersForTests()
  resetBroadcastersForTests()
  while (SCRATCH.length > 0) rmSync(SCRATCH.pop()!, { recursive: true, force: true })
})

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  SCRATCH.push(dir)
  return dir
}

function actorOf(id: string): Actor {
  return {
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
    source: 'session',
    permissions: new Set<string>(),
  } as unknown as Actor
}

// ─────────────────────────────────────────────────────────────────────────────
// 两个引擎各自装配它自己的生产实现
// ─────────────────────────────────────────────────────────────────────────────

/** `children.resume` / `children.cancel` 的调用留痕（见文件头的口径说明）。 */
interface ChildCalls {
  readonly resumed: string[]
  readonly canceled: string[]
}

/**
 * SQLite 的 `retryNode` / `syncWorkflow` 收尾会把任务交给 `createTaskDriveCoordinator`。
 * 前 5 条用例全部在交棒**之前**就抛掉了，所以它们用 `'real'` 驱动也不会真的起调度；
 * ①-frame / ②-wrapper 两条是**成功**的重试，交棒会真的落到调度器上——那时任务没有工作树、
 * 也没有 agent 行，跑起来只会在后台抛一堆与判据无关的错。这两条因此显式选 `'noop'`：
 * 准入 CAS 与占位行铸造（`admittedContinuation`）仍在 `submit` 里同步跑完，被换掉的只有
 * 之后那一脚后台 drive。PG 侧本来就用桩 `children.resume`，两侧对称。
 */
function sqliteOperations(
  db: ProviderNeutralDatabase,
  driver: 'real' | 'noop' = 'real',
): TaskRouteOperations {
  const client = db as unknown as DbClient
  const recovery = taskRecoveryOperations(client)
  const topology = createTaskExecutionTestTopology({ db: client, driver })
  return createSqliteTaskRouteOperations({
    db: client,
    collaboration: {} as never,
    recovery,
    startDepsFor: () =>
      ({
        db: client,
        schedulerDriver: topology.schedulerDriver,
        taskRecoveryOperations: recovery,
        appHome: APP_HOME,
        binaryOverride: ['/usr/bin/env', 'true'],
      }) as never,
    multipart: {} as never,
    resourceAuthorityFor: () => ({}) as never,
    assertWorkflowLaunchable: async () => {},
    appHome: APP_HOME,
  })
}

function postgresqlOperations(db: ProviderNeutralDatabase, calls: ChildCalls): TaskRouteOperations {
  const client = db as unknown as PostgresqlDatabaseClient
  const dependencies = {
    db: client,
    collaboration: {} as never,
    launch: {
      configPath: join(APP_HOME, 'config.json'),
      agent: {
        resources: { validateHostWorkflow: async () => ({ ok: true, issues: [] }) },
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
    persistence: createTaskExecutionPersistence(db),
    children: {
      async resume(input: { taskId: string }) {
        calls.resumed.push(input.taskId)
      },
      async cancel(input: { taskId: string }) {
        calls.canceled.push(input.taskId)
      },
    },
    activity: { isActive: () => false, awaitReleasedSettled: async () => {} },
    topology: {} as never,
    resumeRuntimeFor: () => ({}) as never,
    repositoryPreparationRetry: {
      async retry() {
        throw new Error('rfc359-w8 不驱动 repository preparation retry')
      },
    },
    users: {
      async lookup(ids: readonly string[]) {
        if (ids.length === 0) return []
        const rows = await db.select().from(users)
        return rows.filter((row) => ids.includes(row.id))
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

function operations(
  harness: ProviderHarness,
  calls: ChildCalls,
  driver: 'real' | 'noop' = 'real',
): TaskRouteOperations {
  return harness.capabilities.provider === 'postgresql'
    ? postgresqlOperations(harness.db, calls)
    : sqliteOperations(harness.db, driver)
}

// ─────────────────────────────────────────────────────────────────────────────
// 夹具
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 节点一律用 `input` kind：它能过静态校验而不需要种 agent 行（sync 的正向路径带
 * `validateWorkflowDef` 门），也不是 wrapper —— 回滚选择器的 wrapper 豁免分支不会被误触。
 * 与 `rfc109-sync-task-workflow.test.ts` 同形。
 */
function definition(extraNodeId?: string): WorkflowDefinition {
  const ids = extraNodeId === undefined ? [WRITER] : [WRITER, extraNodeId]
  const nodes: WorkflowNode[] = ids.map(
    (id) => ({ id, kind: 'input', inputKey: id }) as unknown as WorkflowNode,
  )
  return {
    $schema_version: 4,
    inputs: ids.map((id) => ({ kind: 'text', key: id, label: id })),
    nodes,
    edges: [],
  } as unknown as WorkflowDefinition
}

/**
 * ①-frame / ②-wrapper 两条要的是**带 wrapper 与级联边**的图，`definition()` 的纯 input 图
 * 给不出。节点 schema 是 passthrough 的（只要 `id` + `kind`），所以这里只写这两项。
 */
function graphDefinition(
  nodes: readonly Readonly<{ id: string; kind: string }>[],
  edges: readonly (readonly [string, string])[],
): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: nodes.map((node) => ({ id: node.id, kind: node.kind })),
    edges: edges.map(([source, target]) => ({
      id: `e_${source}_${target}`,
      source: { nodeId: source, portName: 'out' },
      target: { nodeId: target, portName: 'in' },
    })),
  } as unknown as WorkflowDefinition
}

async function seedUsers(db: ProviderNeutralDatabase): Promise<void> {
  const now = Date.now()
  await db
    .insert(users)
    .values([
      {
        id: OWNER,
        username: OWNER,
        displayName: OWNER,
        role: 'user' as const,
        status: 'active' as const,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .onConflictDoNothing()
}

async function seedWorkflow(
  db: ProviderNeutralDatabase,
  def: WorkflowDefinition = definition(),
): Promise<string> {
  const id = `wf_${ulid()}`
  await db.insert(workflows).values({
    id,
    name: 'rfc359-w8',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  return id
}

interface SeedTaskOptions {
  readonly workflowId?: string
  readonly snapshot?: WorkflowDefinition
  readonly status?: string
  readonly worktreePath?: string
  readonly repoPath?: string
  readonly triggerContextJson?: string | null
  readonly sourceTerminationFence?: 'closed' | 'merged' | null
  readonly parentTaskId?: string | null
  readonly startedAt?: number
  readonly branchStartedAt?: number
}

async function seedTask(
  db: ProviderNeutralDatabase,
  options: SeedTaskOptions = {},
): Promise<string> {
  const id = `t_${ulid()}`
  await seedUsers(db)
  const workflowId = options.workflowId ?? (await seedWorkflow(db))
  const startedAt = options.startedAt ?? Date.now()
  await db.insert(tasks).values({
    id,
    name: 'rfc359 w8 task',
    workflowId,
    workflowSnapshot: JSON.stringify(options.snapshot ?? definition()),
    workflowVersion: 1,
    repoPath: options.repoPath ?? '/tmp/aw-rfc359-w8-repo',
    worktreePath: options.worktreePath ?? '',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    baseCommit: null,
    status: (options.status ?? 'failed') as 'failed',
    inputs: '{}',
    startedAt,
    branchStartedAt: options.branchStartedAt ?? startedAt,
    finishedAt: startedAt + 1,
    ownerUserId: OWNER,
    repoCount: 1,
    spaceKind: 'local' as const,
    parentTaskId: options.parentTaskId ?? null,
    executionLineageId: id,
    ...(options.triggerContextJson === undefined
      ? {}
      : { triggerContextJson: options.triggerContextJson }),
    ...(options.sourceTerminationFence === undefined || options.sourceTerminationFence === null
      ? {}
      : { sourceTerminationFence: options.sourceTerminationFence }),
  })
  return id
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
    status: 'failed',
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

async function taskRow(db: ProviderNeutralDatabase, taskId: string) {
  return (await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1))[0]
}

/** 被拒绝的重试**不许**在时间线上留下假尝试；只有 retryNode 写这条 errorMessage。 */
async function retryPlaceholders(
  db: ProviderNeutralDatabase,
  taskId: string,
): Promise<readonly string[]> {
  const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  return rows.filter((row) => row.errorMessage === 'queued for retry').map((row) => row.nodeId)
}

/** 重试铸出的占位行（`retryNode` 是唯一写这条 errorMessage 的地方），按 nodeId 取一条。 */
async function retryPlaceholder(db: ProviderNeutralDatabase, taskId: string, nodeId: string) {
  const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  return rows.find((row) => row.nodeId === nodeId && row.errorMessage === 'queued for retry')
}

// ─────────────────────────────────────────────────────────────────────────────
// ⑥ 的夹具：把这次操作真正落库的 task-lifecycle 事件，按**生产的两条投递路径**放出去
// ─────────────────────────────────────────────────────────────────────────────

/** ⑥ 一次投递里，三个「只看状态值是不是终态」的消费面各自看到了什么。 */
interface LifecycleDelivery {
  /** 真实 `watchTaskTerminal` 的结算结果；`'not-woken'` = 一直没被唤醒。 */
  readonly woken: TerminalWatchResult | 'not-woken'
  /** 排队中的兄弟子任务是不是在这一窗口里被放行了。 */
  readonly siblingAdmitted: boolean
  /** 任务频道上收到的帧类型序列（`task.status` / `task.done` / `node.status`）。 */
  readonly taskFrames: readonly string[]
  /** 列表频道上收到的 `task.status` 的状态值序列。 */
  readonly listStatuses: readonly string[]
}

/**
 * 让「事件已经落库」变成「三个消费面已经看到」——**用生产自己的投递器**，不手抄消费者判据。
 *
 * · durable 面走 `createCommittedEventDispatcher` + `createTaskLifecycleDurableConsumerDefinitions`，
 *   与 daemon 里那套逐字同构（`cli/start.ts` 只是把 `notifyExecutionWatch` 接到
 *   `notifyTaskTerminal`、把 `notifyChildBudget` 接到子任务预算上，这里照抄那两行）。
 * · ephemeral 面（WS 投影器）走 `createDatabaseTaskLifecycleWsProjector`，喂的是同一批
 *   落库的信封。
 *
 * ⚠️ 为什么必须走 durable 投递、而不是「让 retry 别 publish」：`publishCommittedEventsAfterCommit`
 * 只是**即时**投影的一脚油门，durable consumer 的投递记录在事件行上，dispatcher / 恢复路径
 * 照样会送到。靠不发布来遮这件事，遮不住。
 */
async function deliverLifecycleEvents(
  db: ProviderNeutralDatabase,
  input: Readonly<{
    watchedTaskId: string
    budget: ChildTaskBudget
    watch: Promise<TerminalWatchResult>
    siblingAdmission: Promise<unknown>
  }>,
): Promise<LifecycleDelivery> {
  const taskFrames: string[] = []
  const listStatuses: string[] = []
  const offTask = taskBroadcaster.subscribe(TASK_CHANNEL(input.watchedTaskId), (message) => {
    taskFrames.push(message.type)
  })
  const offList = tasksListBroadcaster.subscribe(TASKS_LIST_CHANNEL, (message) => {
    if (message.type === 'task.status') listStatuses.push(message.status)
  })
  try {
    const dispatcher = createCommittedEventDispatcher({
      persistence: createCommittedEventDeliveryPersistence(db),
      workerId: 'rfc359-w8-lifecycle',
      codecs: taskLifecycleCommittedEventCodec,
      consumers: createTaskLifecycleDurableConsumerDefinitions({
        events: { async observe() {} } as never,
        async closeTerminalGates() {},
        // `cli/start.ts` 的两行，原样接过来。
        async notifyChildBudget(taskId, status: TaskStatus) {
          input.budget.onChildTaskStatus(taskId, status)
        },
        async notifyExecutionWatch(taskId, status: TaskStatus) {
          notifyTaskTerminal(taskId, status)
        },
        async nudgeWorkspacePrune() {},
      }),
    })
    await dispatcher.drain()

    const projector = createDatabaseTaskLifecycleWsProjector(db)
    const rows = await db
      .select()
      .from(committedEvents)
      .where(eq(committedEvents.aggregateId, input.watchedTaskId))
    for (const row of [...rows].sort((a, b) => a.aggregateSeq - b.aggregateSeq)) {
      await projector.handle(storedEventFromRow(row).envelope)
    }
  } finally {
    offTask()
    offList()
  }

  // `notifyTaskTerminal` 是**同步** resolve，`budget.scan()` 同理；两者都发生在上面已经
  // await 完的投递里。宏任务（setTimeout 0）排在所有微任务之后，所以这不是「等一会儿看看」
  // 的竞态睡眠，而是一个确定性的「微任务队列已排空」栅栏。
  const settled = <T>(promise: Promise<T>, fallback: T): Promise<T> =>
    Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), 0))])

  return {
    woken: await settled<TerminalWatchResult | 'not-woken'>(input.watch, 'not-woken'),
    siblingAdmitted:
      (await settled<'admitted' | 'queued'>(
        input.siblingAdmission.then(() => 'admitted' as const),
        'queued',
      )) === 'admitted',
    taskFrames,
    listStatuses,
  }
}

/** 真 git 仓库 + 一个「节点开跑前」的 stash 快照，工作树随后被写脏。 */
async function seedDirtyWorktree(): Promise<{ repoPath: string; snapshot: string }> {
  const root = scratchDir('aw-rfc359-w8-repo-')
  const repoPath = join(root, 'repo')
  mkdirSync(repoPath, { recursive: true })
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 'w8@example.test'])
  await runGit(repoPath, ['config', 'user.name', 'w8'])
  writeFileSync(join(repoPath, 'a.txt'), 'base\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'init'])

  // 节点开跑前的基线快照（生产里由 scheduler 在派发前拍下来存进 `pre_snapshot`）。
  writeFileSync(join(repoPath, 'a.txt'), 'baseline-before-node\n')
  const snapshot = await gitStashSnapshot(repoPath, { log })
  expect(snapshot).toMatch(/^[0-9a-f]{40}$/)

  // 节点跑了一半被取消，留下半截产物。
  writeFileSync(join(repoPath, 'a.txt'), 'half-written-by-canceled-node\n')
  writeFileSync(join(repoPath, 'leftover.txt'), 'partial\n')
  return { repoPath, snapshot }
}

// ═════════════════════════════════════════════════════════════════════════════
// ① retry —— 必须被拒绝的重试不得先把任务改坏
// ═════════════════════════════════════════════════════════════════════════════

describeEachProvider('RFC-359 W8 —— TaskRouteOperations 能力抬齐', (harness) => {
  const calls: ChildCalls = { resumed: [], canceled: [] }
  const ops = (driver: 'real' | 'noop' = 'real'): TaskRouteOperations =>
    operations(harness, calls, driver)

  test('① 冻结的 trigger context 损坏时，retry 在改动任何东西之前就拒绝', async () => {
    const db = harness.db
    const worktreePath = scratchDir('aw-rfc359-w8-wt-')
    const taskId = await seedTask(db, { worktreePath, triggerContextJson: 'not-json' })
    const runId = await seedRun(db, taskId, { nodeId: WRITER })

    const failed = await code(
      ops().retry({ actor: actorOf(OWNER), taskId, nodeRunId: runId, cascade: true }),
    )

    // RFC-292：损坏的冻结 trigger context 是权威拒绝理由（`assertFrozenTaskTriggerPreflight`）。
    expect(failed).toBe('trigger-context-invalid')
    const row = await taskRow(db, taskId)
    expect(row?.status).toBe('failed')
    expect(await retryPlaceholders(db, taskId)).toEqual([])
  })

  test('① MR/PR 终结栅栏立着时，retry 透传终结码且任务零变更', async () => {
    const db = harness.db
    const worktreePath = scratchDir('aw-rfc359-w8-wt-')
    const taskId = await seedTask(db, { worktreePath, sourceTerminationFence: 'closed' })
    const runId = await seedRun(db, taskId, { nodeId: WRITER })

    const failed = await code(
      ops().retry({ actor: actorOf(OWNER), taskId, nodeRunId: runId, cascade: true }),
    )

    expect(failed).toBe('task-source-terminal-closed')
    const row = await taskRow(db, taskId)
    expect(row?.status).toBe('failed')
    expect(await retryPlaceholders(db, taskId)).toEqual([])
  })

  test('① 被点行的 pre_snapshot 已被 gc 回收 → 409 snapshot-lost，任务落 failed，不留假尝试', async () => {
    const db = harness.db
    const worktreePath = scratchDir('aw-rfc359-w8-wt-')
    const taskId = await seedTask(db, { worktreePath })
    // 这个 sha 在任何 odb 里都不存在（工作树也不是 git 仓库）——等价于 gc 把它 prune 掉了。
    const runId = await seedRun(db, taskId, {
      nodeId: WRITER,
      preSnapshot: '0123456789abcdef0123456789abcdef01234567',
    })

    const failed = await code(
      ops().retry({ actor: actorOf(OWNER), taskId, nodeRunId: runId, cascade: true }),
    )

    // RFC-098 WP-9：承诺要恢复的基线已经永久消失，重试必须失败关闭，而不是在上一次
    // 失败尝试的残留写之上重跑。
    expect(failed).toBe('snapshot-lost')
    const row = await taskRow(db, taskId)
    expect(row?.status).toBe('failed')
    expect(row?.errorSummary).toBe('snapshot-lost')
    expect(await retryPlaceholders(db, taskId)).toEqual([])
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // ② syncWorkflow —— canceled 写节点的半截产物必须先回滚再让新定义接手
  // ═══════════════════════════════════════════════════════════════════════════

  test('② sync 之前把 canceled 写节点的半截产物回滚到它开跑前的快照', async () => {
    const db = harness.db
    const { repoPath, snapshot } = await seedDirtyWorktree()
    const workflowId = await seedWorkflow(db)
    const taskId = await seedTask(db, {
      workflowId,
      status: 'canceled',
      repoPath,
      worktreePath: repoPath,
    })
    await seedRun(db, taskId, { nodeId: WRITER, status: 'canceled', preSnapshot: snapshot })
    // 工作流被改过（多一个节点）并 bump 到 v2 —— sync 的正向前提。
    await db
      .update(workflows)
      .set({ definition: JSON.stringify(definition('w2')), version: 2 })
      .where(eq(workflows.id, workflowId))

    await ops().syncWorkflow({ actor: actorOf(OWNER), taskId, expectedVersion: 2 })

    // RFC-109 F4：canceled 的写节点在 RFC-095 下是可再派发的，新定义会在同一棵工作树上
    // 继续跑——所以它上一次被取消时写了一半的东西必须先回滚掉。
    expect(readFileSync(join(repoPath, 'a.txt'), 'utf8')).toBe('baseline-before-node\n')
    expect(existsSync(join(repoPath, 'leftover.txt'))).toBe(false)
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // ③ delete —— 父链的 branch_started_at 必须重算
  // ═══════════════════════════════════════════════════════════════════════════

  test('③ 删掉子任务后父链的 branch_started_at 回落到子树真实的 max(started_at)', async () => {
    const db = harness.db
    const parentStartedAt = 1_700_000_000_000
    const childStartedAt = parentStartedAt + 60_000
    const parentId = await seedTask(db, {
      status: 'done',
      startedAt: parentStartedAt,
      // 铸子任务时向上推进过（单调 MAX），所以物化列停在子任务的时刻。
      branchStartedAt: childStartedAt,
    })
    const childId = await seedTask(db, {
      status: 'done',
      startedAt: childStartedAt,
      branchStartedAt: childStartedAt,
      parentTaskId: parentId,
    })

    await ops().delete(childId)

    // RFC-311 P1-6：`branch_started_at` 是「子树 max(started_at)」的物化值。子树没了，
    // 它必须回落到父任务自己的 started_at；否则列表默认视图（按物化列排序的快路径）
    // 与任一过滤视图（现算）从此行序不同且永不收敛。
    const parent = await taskRow(db, parentId)
    expect(parent?.branchStartedAt).toBe(parentStartedAt)
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // ④ retry 的继承源 —— 按 RFC-354 的**帧**挑，不是按纯 id 序挑
  // ═══════════════════════════════════════════════════════════════════════════

  test('④ 嵌套 wrapper 下，级联占位行继承的是被点行**同帧**的上一次尝试', async () => {
    const db = harness.db
    const worktreePath = scratchDir('aw-rfc359-w8-wt-')
    // loop 里套 loop：内层 loop 在外层的每一轮各开一代（generation）。
    const snapshot = graphDefinition(
      [
        { id: 'L', kind: 'wrapper-loop' },
        { id: 'M', kind: 'wrapper-loop' },
        { id: 'A', kind: 'script' },
        { id: 'B', kind: 'script' },
      ],
      [['A', 'B']],
    )
    const taskId = await seedTask(db, { snapshot, worktreePath })

    // 外层 loop 的代际行（top-level：containerRunId = null）。
    const outer = await seedRun(db, taskId, { nodeId: 'L' })
    // 内层 loop 的两代：外层第 0 轮开出 gen0，第 1 轮开出 gen1。
    // （`wrapperRuns.findResumable` 正是按 `(containerRunId, iteration)` 这一对找代际的。）
    const gen0 = await seedRun(db, taskId, { nodeId: 'M', containerRunId: outer, iteration: 0 })
    const gen1 = await seedRun(db, taskId, { nodeId: 'M', containerRunId: outer, iteration: 1 })
    // 每一代内部各跑一轮 A → B。**两代的 iteration 都是 0**：能把它们分开的只有
    // containerRunId ——这正是「嵌套 wrapper 才照得出来」的原因，单层 loop 用 iteration
    // 就能区分，纯 id 序的挑法在那里恰好也能蒙对。
    const targetRun = await seedRun(db, taskId, { nodeId: 'A', containerRunId: gen0 })
    await seedRun(db, taskId, { nodeId: 'B', containerRunId: gen0, status: 'done' })
    await seedRun(db, taskId, { nodeId: 'A', containerRunId: gen1 })
    // 这一行 id 最大（seedRun 用 monotonic ulid，插入序即 id 序）：纯 id 序的挑法会选中它。
    await seedRun(db, taskId, { nodeId: 'B', containerRunId: gen1, status: 'done' })

    // 用户点的是**第一代**里的 A，级联到 B。
    await ops('noop').retry({
      actor: actorOf(OWNER),
      taskId,
      nodeRunId: targetRun,
      cascade: true,
    })

    // RFC-354：node_run 带 frame `(container_run_id, iteration)`，级联要重新武装的是
    // **用户正在重试的那一代**。占位行挂到 gen1 上等于对当前帧静默失效：调度器在
    // gen0 这一帧里看不到任何新的 B 行，级联什么也没做；而 gen1 那一代反倒被无端重开。
    const placeholderB = await retryPlaceholder(db, taskId, 'B')
    expect(placeholderB?.containerRunId).toBe(gen0)
    // 被点行自己的占位行一直是按 `target` 继承的，两个引擎本来就一致——一并钉住，
    // 免得将来有人「统一」成同一个挑法时把这一半也改坏。
    const placeholderA = await retryPlaceholder(db, taskId, 'A')
    expect(placeholderA?.containerRunId).toBe(gen0)
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // ⑤ retry 一个 canceled wrapper —— RFC-095 的**原地续跑**，不回滚工作树
  // ═══════════════════════════════════════════════════════════════════════════

  test('⑤ 重试被取消的 wrapper：工作树原样保留（续跑，不是重启），也不铸占位行', async () => {
    const db = harness.db
    const { repoPath, snapshot: preSnapshot } = await seedDirtyWorktree()
    const taskId = await seedTask(db, {
      snapshot: graphDefinition([{ id: 'W', kind: 'wrapper-loop' }], []),
      status: 'canceled',
      repoPath,
      worktreePath: repoPath,
    })
    const runId = await seedRun(db, taskId, { nodeId: 'W', status: 'canceled', preSnapshot })

    await ops('noop').retry({
      actor: actorOf(OWNER),
      taskId,
      nodeRunId: runId,
      cascade: true,
    })

    // RFC-095 design.md:43-48 —— 被取消的 top-level wrapper 行**就是**复活信号：
    // 复活「按持久化 progress 续跑（git baseline 保持 pre-inner）」，而不是重启。
    // 代际行被原地复用（`createWrapperRunLedger.openGeneration` 的 allowedFrom 含
    // 'canceled'），所以已完成的内层轮次在 DB 里仍然是 done——此时把工作树倒回
    // wrapper **开跑之前**的快照，等于把那些轮次的产物从磁盘上抹掉，只留下 DB 里的
    // 「已完成」。同一条豁免 `selectSyncRollbackTargets` 早已写死在 sync 那一侧
    // （services/task.ts:1380「rolling it back would undo completed inner work」）。
    // PG 侧的绿**不是**桩 `children.resume` 骗来的（口径见文件头）：生产里那一侧的回滚兜底
    // 是 `selectResumeRollbackTargets`，它只收 failed / interrupted
    // （postgresqlChildTaskLifecycleParticipant.ts），canceled 的 wrapper 行本来就不在选择器
    // 里，真实现同样不会回滚它。这条锁的是 SQLite 那一侧多出来的无条件回滚。
    expect(readFileSync(join(repoPath, 'a.txt'), 'utf8')).toBe('half-written-by-canceled-node\n')
    expect(existsSync(join(repoPath, 'leftover.txt'))).toBe(true)
    // 占位行会顶掉复活信号（它会成为该节点最新的行，wrapper ledger 于是找不到可续跑的
    // 代际、从 iteration 0 重开）——两个引擎本来就都不铸，一并钉住。
    expect(await retryPlaceholders(db, taskId)).toEqual([])
  })

  test('⑤ 被取消 wrapper 的 pre_snapshot 已被 gc 回收：照样复活，不升级成 snapshot-lost', async () => {
    const db = harness.db
    const { repoPath } = await seedDirtyWorktree()
    const taskId = await seedTask(db, {
      snapshot: graphDefinition([{ id: 'W', kind: 'wrapper-loop' }], []),
      status: 'canceled',
      repoPath,
      worktreePath: repoPath,
    })
    const runId = await seedRun(db, taskId, {
      nodeId: 'W',
      status: 'canceled',
      preSnapshot: '0123456789abcdef0123456789abcdef01234567',
    })

    const outcome = await code(
      ops('noop').retry({
        actor: actorOf(OWNER),
        taskId,
        nodeRunId: runId,
        cascade: true,
      }),
    )

    // RFC-098 WP-9 的 `snapshot-lost` 判据是「**承诺要恢复**的基线没了」。原地续跑的
    // wrapper 行从来不会被恢复到它的 pre_snapshot（上一条用例锁的就是这个），所以它的
    // 基线在不在与本次重试的安全性无关——拿它去拒绝，等于让一条早被 gc 掉的存量快照
    // 把一次合法的复活永久封死。
    expect(outcome).toBe('no-throw')
    const row = await taskRow(db, taskId)
    expect(row?.errorSummary).not.toBe('snapshot-lost')
    expect(readFileSync(join(repoPath, 'a.txt'), 'utf8')).toBe('half-written-by-canceled-node\n')
  })

  test('⑤ 豁免只给 canceled：interrupted 的 wrapper 丢了 pre_snapshot 仍然 409 snapshot-lost', async () => {
    const db = harness.db
    const { repoPath } = await seedDirtyWorktree()
    const taskId = await seedTask(db, {
      snapshot: graphDefinition([{ id: 'W', kind: 'wrapper-loop' }], []),
      status: 'interrupted',
      repoPath,
      worktreePath: repoPath,
    })
    const runId = await seedRun(db, taskId, {
      nodeId: 'W',
      status: 'interrupted',
      preSnapshot: '0123456789abcdef0123456789abcdef01234567',
    })

    const outcome = await code(
      ops('noop').retry({
        actor: actorOf(OWNER),
        taskId,
        nodeRunId: runId,
        cascade: true,
      }),
    )

    // `interrupted` 的行在**两个引擎**的 resume 选择器里都在（`selectResumeRollbackTargets`
    // 收 failed / interrupted），所以它照旧会被回滚——上一条的豁免只针对 canceled。
    // 把豁免放宽到 `wrapperRevivalTarget`（canceled ∪ interrupted）会当场让这条红：那等于
    // 在相反方向上重新开出一条双引擎分叉。
    expect(outcome).toBe('snapshot-lost')
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // ⑥ 续跑交棒的中转态不得被当成任务的结局
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // PG 的重试是两段式：第一段把任务 CAS 到一个**可 resume 的终态**（`interrupted`）并交棒，
  // 第二段 `children.resume` 的 `admitResume` 再 CAS 到 `pending`。中转态非终态不可
  // ——`pending` 不在 `RESUMABLE_TASK_STATUSES` 里，硬改会被 `assertResumeAdmission` 当场
  // 拒掉整条重试。于是「状态值是终态」与「任务真的结束了」在这一跳上分了家。
  //
  // 三个消费面只认前者，全都会在 PG 上把「重试进行中」谎报成「任务已结束」：
  //   · `task-execution-watch` → `notifyTaskTerminal` 唤醒 `watchTaskTerminal`。RFC-243 的
  //     父任务就等在这上面——它会拿着「子任务已结束」这个**从未发生**的结论往下走，而子任务
  //     马上回到 pending 继续跑；
  //   · `task-child-budget` → 把任务从计数里摘掉并重扫等待队列，窗口里多放行一个排队的
  //     兄弟子任务，突破本该生效的并发预算；
  //   · WS 投影器 → 多发一帧 `task.done{interrupted}`。
  // SQLite 的一段式直接落 `pending`，三条一条都不会发生。
  //
  // 判据两条，都用**用户能看见的东西**：父任务被没被唤醒、排队的兄弟被没被放行。

  /** 子任务处于 `awaiting_human`：可重试（在 RETRYABLE 集里）**且不是终态**——父任务因此还在等。 */
  async function seedAwaitedChild(db: ProviderNeutralDatabase, options: { preSnapshot?: string }) {
    const parentId = await seedTask(db, { status: 'running' })
    const callRunId = await seedRun(db, parentId, {
      nodeId: 'call',
      status: 'running',
      finishedAt: null,
    })
    const childId = await seedTask(db, {
      status: 'awaiting_human',
      snapshot: graphDefinition([{ id: WRITER, kind: 'script' }], []),
      worktreePath: scratchDir('aw-rfc359-w8-wt-'),
      parentTaskId: parentId,
    })
    await db.update(tasks).set({ parentNodeRunId: callRunId }).where(eq(tasks.id, childId))
    await db.update(nodeRuns).set({ childTaskId: childId }).where(eq(nodeRuns.id, callRunId))
    const runId = await seedRun(db, childId, {
      nodeId: WRITER,
      status: 'failed',
      ...(options.preSnapshot === undefined ? {} : { preSnapshot: options.preSnapshot }),
    })

    // 父任务的调用节点在等子任务走到终态（RFC-243 §1.4 的 `watchTaskTerminal`）。
    const abort = new AbortController()
    const watch = watchTaskTerminal(createTaskExecutionReadModels(db).statusProjection, childId, {
      signal: abort.signal,
      pollMs: 600_000, // 轮询兜底不参与判据：本用例只看事件驱动的那一路。
    })

    // 子任务并发预算已经打满（容量 1，这个子任务占着），另一处调用正排队等名额。
    const budget = new ChildTaskBudget(
      {
        async listCountedChildTaskIds() {
          return []
        },
      } as never,
      () => 1,
    )
    budget.onChildTaskStatus(childId, 'running')
    const siblingAdmission = budget.acquire([])

    return { parentId, childId, runId, watch, budget, siblingAdmission, abort }
  }

  test('⑥ 子任务被重试时，等它终态的父任务不得被唤醒（也不多放名额、不发 task.done）', async () => {
    const db = harness.db
    const fixture = await seedAwaitedChild(db, {})
    try {
      await ops('noop').retry({
        actor: actorOf(OWNER),
        taskId: fixture.childId,
        nodeRunId: fixture.runId,
        cascade: true,
      })
      const delivered = await deliverLifecycleEvents(db, {
        watchedTaskId: fixture.childId,
        budget: fixture.budget,
        watch: fixture.watch,
        siblingAdmission: fixture.siblingAdmission,
      })

      // ① 父任务：子任务正在被重试，不是结束了。被唤醒 = 父任务拿着一个从未发生的结局往下走。
      expect(delivered.woken).toBe('not-woken')
      // ② 并发预算：这个子任务的名额一直占着，排队的兄弟不得在窗口里被放行。
      expect(delivered.siblingAdmitted).toBe(false)
      // ③ WS：不许出现 `task.done`。`task.status` 照发——库里此刻确实是那个状态，任何重取
      //    都会读到它；把这一帧也捂住只会让 socket 与 API 互相打架。
      expect(delivered.taskFrames).not.toContain('task.done')
      expect(delivered.taskFrames).toContain('task.status')
      expect(delivered.listStatuses.length).toBeGreaterThan(0)
    } finally {
      fixture.abort.abort()
    }
  })

  test('⑥ 重试**真的失败**时，该发的终态照发：父任务必须被唤醒', async () => {
    const db = harness.db
    // 被点行承诺要恢复的基线已被 gc 回收 ⇒ 重试失败关闭并把任务升级成 failed。
    const fixture = await seedAwaitedChild(db, {
      preSnapshot: '0123456789abcdef0123456789abcdef01234567',
    })
    try {
      const outcome = await code(
        ops('noop').retry({
          actor: actorOf(OWNER),
          taskId: fixture.childId,
          nodeRunId: fixture.runId,
          cascade: true,
        }),
      )
      expect(outcome).toBe('snapshot-lost')
      const delivered = await deliverLifecycleEvents(db, {
        watchedTaskId: fixture.childId,
        budget: fixture.budget,
        watch: fixture.watch,
        siblingAdmission: fixture.siblingAdmission,
      })

      // 这才是任务真的结束了：父任务必须被唤醒（否则它会一直挂着等一个永远不来的终态），
      // 名额必须放掉，`task.done` 必须发。抑制机制**只**针对交棒那一跳——把它写成
      // 「重试期间一律不发终态」就是把眼睛蒙上，这条用例正是为了拦住那种写法。
      expect(delivered.woken).toEqual({ kind: 'terminal', status: 'failed' })
      expect(delivered.siblingAdmitted).toBe(true)
      expect(delivered.taskFrames).toContain('task.done')
    } finally {
      fixture.abort.abort()
    }
  })
})
