import { createWorkspacePreparationJournal } from '@/modules/task-execution/infrastructure/workspacePreparationJournal'
// RFC-359 W8-A —— `ChildExecutionLaunchOperations` 的**双引擎对拍**。
//
// 这一对**不是**一份实现被抄了两遍，对拍就是用来把这一点钉住的证据（判定与逐条差额见
// `design/RFC-359-.../` 与本波报告）：
//
//   · PostgreSQL 侧 `childExecutionLaunchOperations.ts`（770 行）是一台**只做子任务**
//     的铸造机：自带 parent 快照 / 准入门 / tasks·task_repos·task_space_nodes·task_collaborators·
//     task_execution_intents·workgroup_task_state 的一次性插入 / branchStartedAt 上冒 /
//     committed event / 自己的 drive coordinator。
//   · SQLite 侧 `sqliteChildExecutionLaunchOperations.ts` 只有 87 行，转发给
//     `services/execution/executor.ts` 的 `startExecution`（194 行，五种 invoker 的统一分派）→
//     `services/task.ts` 的 `startTaskImpl`（约 960 行的**通用**启动引擎，同时服务 root / 定时 /
//     webhook / 事件 / agent / 工作组启动），工作组那支再经
//     `resource-catalog/.../legacy/workgroup/launch.ts` 的 `startWorkgroupTaskFromFrozen`。
//
// 于是两侧**各自缺着对方整整一类能力**，这份对拍最初逐条测出来的就是那些缺口：
//   ① PG 有、SQLite 没有：5 道亲子准入门（判据缺口 12）——错配的 parent node_run / 子任务预留 /
//      调用深度 / actor 在 SQLite 上照样把子任务铸出来；
//   ② SQLite 有、PG 没有：对**冻结定义**跑的启动门（`migrateWorkflowDefinitionToLatest`
//      + 输入校验）——冻结定义声明了必填输入而 payload 没给时，SQLite 拒启动，PG 的子任务
//      铸造机根本不看 inputs，照铸。
//
// **RFC-359 W8-A 收敛后（本文件当前形态）**：两个方向都已按强侧抬齐，这份对拍从「见证分叉」
// 翻面成「钉住合一」——每一道门现在都是**双引擎同码同判**的断言：
//   · 5 道准入门抽成 `modules/task-execution/domain/childLaunchAdmission.ts` 的一份中立判定
//     （`childLaunchAdmissionIssue`），两侧各自在自己的铸行事务内读行、调它、翻成 ConflictError；
//     判定顺序也在那一份里定死，多条同时不成立时两侧报同一个 code。
//   · PG 的 `prepareWorkflowSubject` 补上 `migrateWorkflowDefinitionToLatest` + 冻结定义的
//     `assertWorkflowLaunchInputs`，缺必填输入两侧一律 `workflow-inputs-invalid`。
//   · payload/frozen 不匹配的错误码统一到既有的 `execution-ref-mismatch`（启动门面与 PG 路由
//     启动早就用它；`child-workflow-id-mismatch` 只此一处、无任何前端 / e2e / i18n 依赖）。
//
// 两侧共有的那几道（parent 不存在 / 非 running / git 身份快照残缺 / parent node_run 不存在）也
// 一并锁住，免得将来任一侧悄悄少一道。

import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { eq } from 'drizzle-orm'

import {
  WORKFLOW_SCHEMA_VERSION,
  type NodeRunStatus,
  type StartTask,
  type TaskStatus,
} from '@agent-workflow/shared'

import { buildActor } from '@/auth/actor'
import type { ProviderNeutralDatabase } from '@/db/query'
import {
  nodeRuns,
  taskCollaborators,
  taskExecutionIntents,
  taskRepos,
  taskSpaceNodes,
  tasks,
  users,
  workflows,
} from '@/db/schema'
import { agentLaunchResourceIntegrityParticipantBrand } from '@/modules/resource-catalog/domain/participantBrands'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
// 两侧实现各值 import 一条：这一对的对拍见证判据就锁在这里（`rfc359-w5-provider-pair-conformance`），
// 走 composition 的再导出会让这份对拍在账本里看不见。
import { createChildExecutionLaunchOperations } from '@/modules/task-execution/infrastructure/childExecutionLaunchOperations'
import {
  createDatabaseTaskDriverLifecyclePort,
  createTaskDriverLifecyclePort,
} from '@/modules/task-execution/infrastructure/taskDriverLifecycle'
import type {
  ChildExecutionLaunchOperations,
  ChildWorkflowLaunchRequest,
} from '@/modules/task-execution/application/ports/childExecutionLaunchOperations'
import type {
  SchedulerDriverPort,
  TaskExecutionTopologyLogger,
} from '@/modules/task-execution/application/ports/taskExecutionTopology'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { MaterializedSpace } from '@/services/task'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'

const NOW = 1_788_278_400_000
const PARENT_TASK_ID = 'parent-task-0001'
const PARENT_RUN_ID = 'parent-run-0001'
const CHILD_TASK_ID = 'child-task-0001'
const CHILD_WORKFLOW_ID = 'child-workflow-01'
const OWNER_ID = 'owner-1'

const LATEST_DEFINITION = {
  $schema_version: WORKFLOW_SCHEMA_VERSION,
  inputs: [],
  nodes: [],
  edges: [],
}

function logger(): TaskExecutionTopologyLogger {
  const log: TaskExecutionTopologyLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return log
    },
  }
  return log
}

function schedulerDriver(calls: string[]): SchedulerDriverPort {
  return {
    async drive(input) {
      calls.push(input.taskId)
    },
    async cancelChild() {},
    async resumeChild() {},
    isTaskActive() {
      return false
    },
  }
}

function inheritedSpace(taskId: string): MaterializedSpace {
  const worktreePath = mkdtempSync(join(tmpdir(), 'aw-rfc359-w8-child-'))
  const branch = `agent-workflow/${taskId}`
  return {
    kind: 'single',
    spaceKind: 'inherited',
    taskId,
    worktreePath,
    branch,
    baseCommit: null,
    earlyError: null,
    resolvedSources: [
      {
        repoPath: worktreePath,
        baseBranch: 'main',
        repoUrl: null,
        cachedRepoId: null,
        pathFetchError: null,
        ffWarnings: [],
      },
    ],
    repos: [
      {
        repoIndex: 0,
        repoPath: worktreePath,
        repoUrl: null,
        cachedRepoId: null,
        baseBranch: 'main',
        branch,
        baseCommit: null,
        worktreePath,
        worktreeDirName: '',
        mountPath: '',
        subdir: '',
        readonly: false,
        submoduleInitOk: true,
        submoduleInitError: null,
        hasSubmodules: false,
      },
    ],
    nodePaths: [],
    cleanup: { taskId, ownedRoot: null, worktrees: [], state: 'owned', report: null },
  }
}

const actor = buildActor({
  user: {
    id: OWNER_ID,
    username: 'owner',
    displayName: 'Owner',
    role: 'admin',
    status: 'active',
  },
  source: 'session',
})

const childPayload: StartTask = {
  workflowId: CHILD_WORKFLOW_ID,
  name: 'child',
  inputs: {},
  autoCommitPush: false,
}

/**
 * 父行**落库那一份**触发上下文：故意不带 `contract`。
 * 运行期那一份（调度器把触发定义解析出来后补上 `contract` 再交给子启动）见 `RUNTIME_TRIGGER_CONTEXT`。
 */
const PARENT_STORED_TRIGGER_CONTEXT = {
  trigger: { webhook: { event_type: 'note' } },
}

/** 调度器交下来的运行期那一份——比父行那一列多一个 `contract` 块。 */
const RUNTIME_TRIGGER_CONTEXT = {
  trigger: { webhook: { event_type: 'note' } },
  contract: {
    namespace: 'webhook',
    definitionRef: { id: 'code-host.webhook.note', revision: 1 },
    availableFields: ['event_type'],
  },
}

interface SeedOverrides {
  readonly parentStatus?: TaskStatus
  readonly parentRunStatus?: NodeRunStatus
  readonly parentRunTaskId?: string
  readonly parentRunChildTaskId?: string | null
  readonly parentInvocationDepth?: number
  readonly parentOwnerUserId?: string | null
  readonly gitUserName?: string | null
  readonly gitUserEmail?: string | null
  readonly parentTriggerContextJson?: string
}

async function seed(db: ProviderNeutralDatabase, overrides: SeedOverrides = {}): Promise<void> {
  await db.insert(users).values({
    id: OWNER_ID,
    username: 'owner',
    displayName: 'Owner',
    role: 'admin',
    createdAt: NOW,
    updatedAt: NOW,
  })
  await db.insert(workflows).values({
    id: CHILD_WORKFLOW_ID,
    name: 'child-workflow',
    definition: JSON.stringify(LATEST_DEFINITION),
  })
  const parentRunTaskId = overrides.parentRunTaskId ?? PARENT_TASK_ID
  const extraParents: readonly { readonly id: string; readonly status: TaskStatus }[] =
    parentRunTaskId === PARENT_TASK_ID ? [] : [{ id: parentRunTaskId, status: 'running' as const }]
  for (const parent of [
    { id: PARENT_TASK_ID, status: overrides.parentStatus ?? ('running' as const) },
    ...extraParents,
  ]) {
    await db.insert(tasks).values({
      id: parent.id,
      name: parent.id,
      workflowId: CHILD_WORKFLOW_ID,
      workflowSnapshot: JSON.stringify(LATEST_DEFINITION),
      workflowVersion: 1,
      repoPath: '/tmp/never-read',
      worktreePath: '/tmp/never-read',
      baseBranch: 'main',
      branch: `agent-workflow/${parent.id}`,
      status: parent.status,
      inputs: '{}',
      startedAt: NOW,
      runningMs: 0,
      ownerUserId:
        overrides.parentOwnerUserId === undefined ? OWNER_ID : overrides.parentOwnerUserId,
      launchOrigin: 'manual',
      catalogVisibility: 'public',
      invocationDepth: overrides.parentInvocationDepth ?? 0,
      gitUserName: overrides.gitUserName ?? null,
      gitUserEmail: overrides.gitUserEmail ?? null,
      ...(overrides.parentTriggerContextJson === undefined
        ? {}
        : { triggerContextJson: overrides.parentTriggerContextJson }),
      rootTaskId: parent.id,
      executionLineageId: parent.id,
      // **必须显式写**（RFC-359 AC-1，plan §5hn 批次二 ⑤ 实撞）：这一列留空时两个引擎的父行
      // 状态就不一样了——SQLite 有 `rfc328_tasks_lineage_after_insert` 触发器（迁移 0210，
      // 注释自陈是「给不走生产工厂的直写 SQL / 测试兜底」）会按 `workflow_version` 把它补上，
      // **PostgreSQL 一个触发器都没有**。于是子任务继承到的根槽一侧是 `workflowRevision: 1`、
      // 另一侧是 `null`，而那根本不是子启动的行为差，是夹具被单侧触发器骗了。
      // 生产写入方全都显式写这三列（`rfc359-w7-task-insert-lineage-completeness` 逐站点锁着），
      // 夹具也照生产形状写。
      lineageSlotPathJson: JSON.stringify([
        {
          stableNodeKey: 'task-root',
          frozenOccurrenceKey: parent.id,
          workflowRevision: 1,
        },
      ]),
    })
  }
  await db.insert(nodeRuns).values({
    id: PARENT_RUN_ID,
    taskId: parentRunTaskId,
    nodeId: 'call-node',
    status: overrides.parentRunStatus ?? 'running',
    retryIndex: 0,
    iteration: 0,
    startedAt: NOW,
    childTaskId:
      overrides.parentRunChildTaskId === undefined ? CHILD_TASK_ID : overrides.parentRunChildTaskId,
    continuationSlotKey: 'call:node-1',
    operationGeneration: 0,
  })
}

interface LaunchOverrides {
  readonly triggerContext?: Record<string, unknown>
  readonly invocationDepth?: number
  readonly frozenSnapshotJson?: string
  readonly actorUserId?: string
  readonly payload?: StartTask
}

function workflowRequest(
  driver: SchedulerDriverPort,
  overrides: LaunchOverrides = {},
): ChildWorkflowLaunchRequest {
  return {
    actor:
      overrides.actorUserId === undefined
        ? actor
        : buildActor({
            user: {
              id: overrides.actorUserId,
              username: overrides.actorUserId,
              displayName: overrides.actorUserId,
              role: 'admin',
              status: 'active',
            },
            source: 'session',
          }),
    parentTaskId: PARENT_TASK_ID,
    parentNodeRunId: PARENT_RUN_ID,
    invocationDepth: overrides.invocationDepth ?? 1,
    materializedSpace: inheritedSpace(CHILD_TASK_ID),
    runtime: {
      runConfig: { appHome: '/app-home' },
      actorUserId: OWNER_ID,
      ...(overrides.triggerContext === undefined
        ? {}
        : { triggerContext: overrides.triggerContext as never }),
    },
    schedulerDriver: driver,
    workflowId: CHILD_WORKFLOW_ID,
    frozenWorkflowVersion: 1,
    payload: overrides.payload ?? childPayload,
    frozenSnapshotJson: overrides.frozenSnapshotJson ?? JSON.stringify(LATEST_DEFINITION),
    refClosureJson: null,
  }
}

/** 工作流子启动不碰工作组资源面——碰了就该当场炸，而不是静默走一条别的路。 */
function unusedWorkgroupResources() {
  const refuse = () => {
    throw new Error('workgroup resources are not used by workflow launch')
  }
  return {
    async loadExistingAgentIds(): Promise<readonly string[]> {
      return refuse()
    },
    async ensureHostWorkflow(): Promise<void> {
      return refuse()
    },
    integrity: {
      [agentLaunchResourceIntegrityParticipantBrand]:
        'agent-launch-resource-integrity-participant' as const,
      async assertUsable(): Promise<void> {
        return refuse()
      },
    },
  }
}

interface LaunchTarget {
  readonly operations: ChildExecutionLaunchOperations
  /**
   * 等后台 drive 走完。两侧的 coordinator 都是 `completionMode: 'background'`（提交后不 await），
   * PostgreSQL 上那条悬着的收尾事务会和下一个用例 `beforeEach` 的 `truncate … cascade` 撞成
   * `40P01 deadlock detected`——实测过。收尾的最后一步是 `finalizeWorkspace`，拿它当信号。
   */
  settle(): Promise<void>
}

/**
 * RFC-359 AC-1（plan §5hn 批次二 ⑤）—— **这一对已经合一**：两个 lane 造的是**同一台**
 * 铸造机，只有装配方交进去的驱动生命周期端口不同（SQLite 绑进程级单例的
 * `claim({ db, intentId })` 并带 `legacyConnection`；PG 绑实例的 `claimPersisted({ intentId })`）。
 * 这两条拼法本来就并存于 `taskDriverLifecycle.ts`，两个组合根各取各的。
 *
 * 于是这份对拍的本分也换了（与批次二 ④ 记的同一条规律）：合并前它见证「两侧是不是同一个判断」，
 * 合并后它锁「将来别再分叉」——想证明它还活着，变异必须只动**一侧**（见本文件行级比对那条
 * 用例的 plan 记录：单侧把 `catalogVisibility` 写死 / 把 `task_repos.working_branch` 改掉，都当场红）。
 */
function operationsFor(harness: ProviderHarness): LaunchTarget {
  const db = harness.db as unknown as PostgresqlDatabaseClient
  const persistence = createTaskExecutionPersistence(db)
  let finalized = false
  if (harness.capabilities.isolation === 'exclusive') {
    return {
      operations: createChildExecutionLaunchOperations({
        db,
        persistence,
        // SQLite 组合根那一条（`taskExecutionRuntimeParticipants.ts` 逐字同形）。
        lifecycle: createDatabaseTaskDriverLifecyclePort({
          db,
          log: logger(),
          async finalizeWorkspace() {
            finalized = true
          },
        }),
        workgroup: unusedWorkgroupResources(),
      }),
      async settle() {
        for (let attempt = 0; attempt < 200 && !finalized; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      },
    }
  }
  const executionModule = createProviderTaskExecutionModule({
    daemonGeneration: 'daemon-rfc359-w8',
    persistence,
  })
  const operations = createChildExecutionLaunchOperations({
    db,
    persistence,
    // RFC-359 AC-1（plan §5hn 批次二 ⑤）：铸造机改收**端口**。PG 这一侧绑实例的
    // `claimPersisted({ intentId })`；SQLite 组合根绑进程级单例的 `claim({ db, intentId })`
    // 并带 `legacyConnection`——两条拼法本来就并存于 `taskDriverLifecycle.ts`。
    lifecycle: createTaskDriverLifecyclePort({
      db,
      module: executionModule,
      claim: (intentId) => executionModule.claimPersisted({ intentId }),
      persistence,
      log: logger(),
      async finalizeWorkspace() {
        finalized = true
      },
    }),
    workgroup: unusedWorkgroupResources(),
  })
  return {
    operations,
    async settle() {
      for (let attempt = 0; attempt < 200 && !finalized; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    },
  }
}

async function childExists(db: ProviderNeutralDatabase): Promise<boolean> {
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, CHILD_TASK_ID))
    .limit(1)
  return rows[0] !== undefined
}

async function launchError(
  harness: ProviderHarness,
  overrides: LaunchOverrides = {},
): Promise<string | null> {
  const calls: string[] = []
  const target = operationsFor(harness)
  try {
    await target.operations.launchWorkflow(workflowRequest(schedulerDriver(calls), overrides))
    await target.settle()
    return null
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : (error as Error).name
  }
}

/**
 * 逐次必然不同的那几格：墙钟，以及 `inheritedSpace()` 每 lane 各建一个临时目录带来的路径 / 分支。
 * 其余整行都比——拒绝清单而不是允许清单（允许清单只护得住想得到的字段）。
 */
const VOLATILE_CHILD_COLUMNS = new Set([
  'createdAt',
  'updatedAt',
  'startedAt',
  'finishedAt',
  'branchStartedAt',
  'claimedAt',
  'completedAt',
  'addedAt',
  'repoPath',
  'worktreePath',
  'branch',
])

function comparableRows(rows: readonly Record<string, unknown>[]): unknown[] {
  return rows.map((row) => {
    const comparable: Record<string, unknown> = {}
    for (const key of Object.keys(row).sort()) {
      if (VOLATILE_CHILD_COLUMNS.has(key)) continue
      comparable[key] = row[key]
    }
    return comparable
  })
}

/** 子任务那一行 + PG 铸造机显式写的每一张卫星表。少写一张也要红。 */
async function childRows(db: ProviderNeutralDatabase): Promise<Record<string, unknown>> {
  const [task, repos, spaceNodes, collaborators, intents] = await Promise.all([
    db.select().from(tasks).where(eq(tasks.id, CHILD_TASK_ID)),
    db.select().from(taskRepos).where(eq(taskRepos.taskId, CHILD_TASK_ID)),
    db.select().from(taskSpaceNodes).where(eq(taskSpaceNodes.taskId, CHILD_TASK_ID)),
    db.select().from(taskCollaborators).where(eq(taskCollaborators.taskId, CHILD_TASK_ID)),
    db.select().from(taskExecutionIntents).where(eq(taskExecutionIntents.taskId, CHILD_TASK_ID)),
  ])
  return {
    task: comparableRows(task as unknown as Record<string, unknown>[]),
    repos: comparableRows(repos as unknown as Record<string, unknown>[]),
    spaceNodes: comparableRows(spaceNodes as unknown as Record<string, unknown>[]),
    collaborators: comparableRows(collaborators as unknown as Record<string, unknown>[]),
    // 意图行的 id 是本次铸造现生成的 ULID，两 lane 天然不同；其余整行都比。
    intents: comparableRows(intents as unknown as Record<string, unknown>[]).map((row) => {
      const { id: _id, ...rest } = row as Record<string, unknown>
      return rest
    }),
  }
}

/**
 * 等两侧的执行意图都走到终态再读。
 *
 * **不是可有可无的等待**：两侧的 coordinator 都是 `completionMode: 'background'`，
 * `state` / `completedAt` 因此取决于「读的那一刻收尾跑完没有」。实测（plan §5hn 批次二 ⑤）
 * PG 的 `settle()` 会等 `finalizeWorkspace`，SQLite 那侧没有这个钩子，读到的是 `claimed`
 * ——**差的是几百毫秒，不是行为**（探针连读五次：SQLite 第二次就翻到 `completed`）。
 * 把 `state` 也拉进拒绝清单能让判据变绿，但那会把「有一侧真的不收尾」这类缺陷一起盖掉；
 * 等到终态再比才是既诚实又能比的那一种。
 */
async function settledChildRows(db: ProviderNeutralDatabase): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await db
      .select({ state: taskExecutionIntents.state })
      .from(taskExecutionIntents)
      .where(eq(taskExecutionIntents.taskId, CHILD_TASK_ID))
    if (rows.length > 0 && rows.every((row) => row.state !== 'claimed')) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return await childRows(db)
}

const mintedChildRows = new Map<string, Record<string, unknown>>()

describeEachProvider('RFC-359 W8-A child execution launch', (harness: ProviderHarness) => {
  // 正向对照：合法的一次子启动在两个引擎上都把子任务铸出来。没有它，下面那一排「都拒」
  // 的断言可以被一个「什么都拒」的实现全部满足。
  test('a well-formed child launch mints the child on both engines', async () => {
    await seed(harness.db)
    expect(await launchError(harness)).toBeNull()
    expect(await childExists(harness.db)).toBe(true)
    const preparation = await createWorkspacePreparationJournal(harness.db).forTask(CHILD_TASK_ID)
    expect(preparation).toMatchObject({
      state: 'admitted',
      lane: 'pre-materialized',
      operationRef: null,
    })
    expect(JSON.parse(preparation!.artifactJson!).artifact).toMatchObject({
      kind: 'call',
      ownerRef: PARENT_RUN_ID,
    })
  })

  // RFC-359 AC-1（plan §5hn 批次二 ⑤）—— **落库那几行**也要比，不能只比「铸出来了没有」。
  //
  // 为什么这条测试存在：上面那条正向对照只断言 `childExists === true`。批次二 ④ 已经用变异
  // 实证过同一个坑的另一面（`tests/helpers/taskRowParity.ts` 头注释）：**「存在」与「一样」
  // 差着整整一类缺陷**——两侧都把子任务铸出来、但 `catalog_visibility` / `invocation_depth` /
  // `root_task_id` / 卫星表少写一张，这条对拍一个字都不会红。合并这一对之前先把行钉住。
  test('一次合法的子启动：两个引擎落出的子任务行与卫星行逐字相同', async () => {
    await seed(harness.db)
    expect(await launchError(harness)).toBeNull()

    mintedChildRows.set(harness.capabilities.provider, await settledChildRows(harness.db))
    if (mintedChildRows.size < 2) return
    expect(
      mintedChildRows.get('postgresql'),
      '两个引擎铸出来的子任务行 / 卫星行不一致（plan §5hn 批次二 ⑤）',
    ).toEqual(mintedChildRows.get('sqlite'))
  })

  // RFC-359 AC-1（plan §5hn 批次二 ⑤）—— 触发上下文取**运行期那一份**，不是父行那一列。
  //
  // 为什么这条测试存在：合一这一对时 `rfc243-call-workflow` 的「child task atomically inherits
  // nested context」当场红了，追下去是一条真缺陷——PG 的铸造机写的是 `parent.triggerContextJson`
  //（**落库时**那一份），而调度器在运行期会把触发定义解析出来的 `contract`
  //（`namespace` / `definitionRef` / `availableFields`）补上去再交下来。抄父行那一列，
  // 子任务就丢掉整个 `contract` 块，子 agent prompt 里 `{{event_type}}` 这类字段随之展不开。
  // 合并前这条只在 SQLite 那侧成立，**PostgreSQL 一直在抄父行**。
  //
  // 夹具刻意把两者错开：父行存的那份**没有** `contract`，运行期那份有。断言「子行拿到的是
  // 运行期那份」，于是「抄父行」这个实现当场红——两个引擎同码同判，将来也不会有一侧偷偷抄回去。
  test('子任务继承的是**运行期**触发上下文（含 contract），不是父行那一列', async () => {
    await seed(harness.db, {
      parentTriggerContextJson: JSON.stringify(PARENT_STORED_TRIGGER_CONTEXT),
    })
    expect(await launchError(harness, { triggerContext: RUNTIME_TRIGGER_CONTEXT })).toBeNull()
    const row = (
      await harness.db
        .select({ triggerContextJson: tasks.triggerContextJson })
        .from(tasks)
        .where(eq(tasks.id, CHILD_TASK_ID))
        .limit(1)
    )[0]
    expect(
      row?.triggerContextJson === undefined || row.triggerContextJson === null
        ? null
        : (JSON.parse(row.triggerContextJson) as unknown),
      '子任务必须拿到补过 contract 的那一份——抄父行会把 contract 整块丢掉',
    ).toEqual(RUNTIME_TRIGGER_CONTEXT)
  })

  // 两侧共有的准入：父任务不存在。
  test('a missing parent task is rejected on both engines', async () => {
    await seed(harness.db)
    await harness.db.delete(nodeRuns).where(eq(nodeRuns.id, PARENT_RUN_ID))
    await harness.db.delete(tasks).where(eq(tasks.id, PARENT_TASK_ID))
    expect(await launchError(harness)).toBe('parent-task-not-found')
    expect(await childExists(harness.db)).toBe(false)
  })

  // 两侧共有的准入：父任务已离开 running。
  test('a non-running parent task is rejected on both engines', async () => {
    await seed(harness.db, { parentStatus: 'done' })
    expect(await launchError(harness)).toBe('parent-task-not-running')
    expect(await childExists(harness.db)).toBe(false)
  })

  // 两侧共有的准入：父任务的 Git 身份快照只剩一半。
  test('an incomplete parent git identity snapshot is rejected on both engines', async () => {
    await seed(harness.db, { gitUserName: 'Owner', gitUserEmail: null })
    expect(await launchError(harness)).toBe('git-identity-snapshot-invalid')
    expect(await childExists(harness.db)).toBe(false)
  })

  // 两侧共有的准入：发起调用的那条 node_run 不存在。SQLite 侧此前把它当「历史遗留行」
  // 静默兜底（`legacy-call:` 占位 + operationGeneration 归零）并照铸子任务。
  test('a missing parent node_run is rejected on both engines', async () => {
    await seed(harness.db)
    await harness.db.delete(nodeRuns).where(eq(nodeRuns.id, PARENT_RUN_ID))
    expect(await launchError(harness)).toBe('parent-node-run-not-found')
    expect(await childExists(harness.db)).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // ① 判据缺口 12（已销账）：5 道亲子准入门，现在两侧共用
  //    `domain/childLaunchAdmission.ts` 的同一份判定，同码同判。
  //    抬齐前 SQLite 上这五种情况一律**照铸子任务**（子任务起来、跑起来、改仓库），
  //    抬齐后与 PG 一样在铸行事务里 409 且不留任何行。
  // ---------------------------------------------------------------------------
  const admissionGaps: readonly {
    readonly name: string
    readonly code: string
    readonly seedOverrides: SeedOverrides
    readonly launchOverrides: LaunchOverrides
  }[] = [
    {
      name: 'a parent node_run owned by another task',
      code: 'parent-node-run-task-mismatch',
      seedOverrides: { parentRunTaskId: 'other-parent-001' },
      launchOverrides: {},
    },
    {
      name: 'a parent node_run that is no longer running',
      code: 'parent-node-run-not-running',
      seedOverrides: { parentRunStatus: 'done' },
      launchOverrides: {},
    },
    {
      name: 'a parent node_run that reserved a different child task',
      code: 'child-task-reservation-mismatch',
      seedOverrides: { parentRunChildTaskId: 'some-other-child' },
      launchOverrides: {},
    },
    {
      name: 'a child invocation depth that does not follow the parent',
      code: 'child-invocation-depth-mismatch',
      seedOverrides: {},
      launchOverrides: { invocationDepth: 5 },
    },
    {
      name: 'a launch actor that is not the parent owner',
      code: 'child-launch-actor-mismatch',
      seedOverrides: {},
      launchOverrides: { actorUserId: 'someone-else' },
    },
  ]

  for (const gap of admissionGaps) {
    test(`parent admission — ${gap.name}`, async () => {
      await seed(harness.db, gap.seedOverrides)
      expect(await launchError(harness, gap.launchOverrides)).toBe(gap.code)
      expect(await childExists(harness.db)).toBe(false)
    })
  }

  // 准入判定的**顺序**也是合同的一部分：多条门同时不成立时两个引擎必须报同一条。
  // 中立判定里排在前面的那条（node_run 归属）胜出，深度错配不得抢先。
  test('parent admission reports the first failing gate identically on both engines', async () => {
    await seed(harness.db, { parentRunTaskId: 'other-parent-001' })
    expect(await launchError(harness, { invocationDepth: 5 })).toBe('parent-node-run-task-mismatch')
    expect(await childExists(harness.db)).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // ② 反向缺口（已抬齐）：冻结定义的输入门。PG 的 `prepareWorkflowSubject` 此前既不
  //    `migrateWorkflowDefinitionToLatest`、也根本不看 `inputs[]`，缺必填输入照铸；
  //    现在两侧同走 `assertWorkflowLaunchInputs`，同码 `workflow-inputs-invalid`。
  // ---------------------------------------------------------------------------
  test('a frozen definition with an unsatisfied required input is rejected on both engines', async () => {
    await seed(harness.db)
    const frozenSnapshotJson = JSON.stringify({
      ...LATEST_DEFINITION,
      inputs: [{ kind: 'text', key: 'needed', label: 'Needed', required: true }],
    })
    expect(await launchError(harness, { frozenSnapshotJson })).toBe('workflow-inputs-invalid')
    expect(await childExists(harness.db)).toBe(false)
  })

  // 同一道门的正向：必填输入给齐了就照常铸。
  test('a satisfied required input still launches on both engines', async () => {
    await seed(harness.db)
    const frozenSnapshotJson = JSON.stringify({
      ...LATEST_DEFINITION,
      inputs: [{ kind: 'text', key: 'needed', label: 'Needed', required: true }],
    })
    const code = await launchError(harness, {
      frozenSnapshotJson,
      payload: { ...childPayload, inputs: { needed: 'given' } },
    })
    expect(code).toBeNull()
    expect(await childExists(harness.db)).toBe(true)
  })

  // 读不出来的冻结定义：两侧同码。PG 此前是裸 `WorkflowDefinitionSchema.parse`，
  // 抛的是没有 `code` 的 ZodError（500 形态）。
  test('an unreadable frozen definition is rejected on both engines', async () => {
    await seed(harness.db)
    expect(await launchError(harness, { frozenSnapshotJson: '{"nodes": "not-a-list"}' })).toBe(
      'workflow-call-ref-missing',
    )
    expect(await childExists(harness.db)).toBe(false)
  })

  // payload 的 workflowId 与冻结的 workflow 不一致 —— 统一到既有的 `execution-ref-mismatch`。
  test('a payload/frozen workflow mismatch is rejected on both engines with one code', async () => {
    await seed(harness.db)
    const code = await launchError(harness, {
      payload: { ...childPayload, workflowId: 'another-workflow' },
    })
    expect(code).toBe('execution-ref-mismatch')
    expect(await childExists(harness.db)).toBe(false)
  })
})
