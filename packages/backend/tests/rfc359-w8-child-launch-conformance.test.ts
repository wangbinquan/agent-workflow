// RFC-359 W8-A —— `ChildExecutionLaunchOperations` 的**双引擎对拍**。
//
// 这一对**不是**一份实现被抄了两遍，对拍就是用来把这一点钉住的证据（判定与逐条差额见
// `design/RFC-359-.../` 与本波报告）：
//
//   · PostgreSQL 侧 `postgresqlChildExecutionLaunchOperations.ts`（770 行）是一台**只做子任务**
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
import { nodeRuns, tasks, users, workflows } from '@/db/schema'
import { agentLaunchResourceIntegrityParticipantBrand } from '@/modules/resource-catalog/domain/participantBrands'
import { createProviderTaskExecutionModule } from '@/modules/task-execution/composition'
import { createPostgresqlTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
// 两侧实现各值 import 一条：这一对的对拍见证判据就锁在这里（`rfc359-w5-provider-pair-conformance`），
// 走 composition 的再导出会让这份对拍在账本里看不见。
import { createPostgresqlChildExecutionLaunchOperations } from '@/modules/task-execution/infrastructure/postgresqlChildExecutionLaunchOperations'
import { createSqliteChildExecutionLaunchOperations } from '@/modules/task-execution/infrastructure/sqliteChildExecutionLaunchOperations'
import type {
  ChildExecutionLaunchOperations,
  ChildWorkflowLaunchRequest,
} from '@/modules/task-execution/application/ports/childExecutionLaunchOperations'
import type {
  SchedulerDriverPort,
  TaskExecutionTopologyLogger,
} from '@/modules/task-execution/application/ports/taskExecutionTopology'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { DbClient } from '@/db/client'
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

interface SeedOverrides {
  readonly parentStatus?: TaskStatus
  readonly parentRunStatus?: NodeRunStatus
  readonly parentRunTaskId?: string
  readonly parentRunChildTaskId?: string | null
  readonly parentInvocationDepth?: number
  readonly parentOwnerUserId?: string | null
  readonly gitUserName?: string | null
  readonly gitUserEmail?: string | null
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
      rootTaskId: parent.id,
      executionLineageId: parent.id,
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
    runtime: { runConfig: { appHome: '/app-home' }, actorUserId: OWNER_ID },
    schedulerDriver: driver,
    workflowId: CHILD_WORKFLOW_ID,
    frozenWorkflowVersion: 1,
    payload: overrides.payload ?? childPayload,
    frozenSnapshotJson: overrides.frozenSnapshotJson ?? JSON.stringify(LATEST_DEFINITION),
    refClosureJson: null,
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

function operationsFor(harness: ProviderHarness): LaunchTarget {
  if (harness.capabilities.isolation === 'exclusive') {
    return {
      operations: createSqliteChildExecutionLaunchOperations(harness.db as unknown as DbClient),
      async settle() {},
    }
  }
  const db = harness.db as unknown as PostgresqlDatabaseClient
  const persistence = createPostgresqlTaskExecutionPersistence(db)
  let finalized = false
  const operations = createPostgresqlChildExecutionLaunchOperations({
    db,
    persistence,
    executionModule: createProviderTaskExecutionModule({
      daemonGeneration: 'daemon-rfc359-w8',
      persistence,
    }),
    async finalizeWorkspace() {
      finalized = true
    },
    log: logger(),
    workgroup: {
      async loadExistingAgentIds() {
        throw new Error('workgroup resources are not used by workflow launch')
      },
      async ensureHostWorkflow() {
        throw new Error('workgroup resources are not used by workflow launch')
      },
      integrity: {
        [agentLaunchResourceIntegrityParticipantBrand]:
          'agent-launch-resource-integrity-participant',
        async assertUsable() {
          throw new Error('workgroup resources are not used by workflow launch')
        },
      },
    },
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

describeEachProvider('RFC-359 W8-A child execution launch', (harness: ProviderHarness) => {
  // 正向对照：合法的一次子启动在两个引擎上都把子任务铸出来。没有它，下面那一排「都拒」
  // 的断言可以被一个「什么都拒」的实现全部满足。
  test('a well-formed child launch mints the child on both engines', async () => {
    await seed(harness.db)
    expect(await launchError(harness)).toBeNull()
    expect(await childExists(harness.db)).toBe(true)
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
