// RFC-359 W8 —— `TaskExecutionRuntimeParticipants` 这一对的双引擎对拍**与不合一判定**。
//
// # 判定：这一对不是重复，是两台执行引擎（W8 只读对账结论）
//
// 行数比 129 : 154 ≈ 1.2 看着像「同一段逻辑抄了两遍」，逐方法拆开后不是。两侧都是**薄壳**，
// 真实现全在各自转发的目标里，把目标求和后是两套互不相干的引擎：
//
// | 参与者 | SQLite 侧转发到 | PostgreSQL 侧转发到 |
// |---|---|---|
// | `drive` | `composition/taskEngineApplication.driveTaskEngineApplication`（**同一份**）+ 现场 `createTaskDagCollaborationOperations(db)` + `sqliteChildExecutionLaunchOperations`（87 行） | 同一份 drive + bootstrap 注入的 `taskDagCollaboration` + `postgresqlChildExecutionLaunchOperations`（770 行） |
// | `children` | `services/task.ts` 的 `cancelTask`（232 行）/ `resumeTask` → `resumeKick`（245 行） | `postgresqlChildTaskLifecycleParticipant.ts`（774 行，自带 `cancelCascade` / `assertResumeAdmission` / `DefaultTaskDriveCoordinator`） |
// | `activity` | 进程级单例 `taskExecutionModule.runtimeRegistry`（经 `services/task.isTaskActive` + `taskDriverLifecycle.awaitTaskDriverReleasedSettled`），外加只在测试里用的 `testActiveControllers` 旁路 | **注入的** `executionModule.runtimeRegistry` |
//
// 只有 `drive` 的内核（`driveTaskEngineApplication` + `composeWrapperRuntime` +
// `composeExecutionMergeRecovery`）已经是一份实现，两侧薄壳的差别只是「谁来装配依赖」。
// `children` 与 `activity` 是真分叉，而且分叉不在这两个文件里：
//   · `cancelTask(db, …)` 的第一件事就是 `db.select(…).limit(1).all()[0]` —— bun:sqlite 的**同步**
//     读，在 PostgreSQL 客户端上返回 Promise，`[0]` 恒为 undefined、当场 `task-not-found`。
//     也就是说 SQLite 侧的 `children` **物理上跑不到 PostgreSQL 上**，反之亦然。
//   · 两侧 `activity` 读的是**两个不同的 registry 实例**：SQLite 读进程级单例，PG 读注入的那个。
// 合一这一对的前置条件是先合 `services/task.ts` 的 cancel / resume 引擎与
// `postgresqlChildTaskLifecycleParticipant.ts`——那是另一对、量级大一个数量级，且 `services/**`
// 不在本轮作业面内。**本轮判不合，只补对拍。**
//
// # 这份对拍覆盖什么
//
// 两个工厂各自在自己的引擎上真实构造，然后：
//   ① `activity` 的行为在两个引擎上对拍（未知任务 `isActive === false`；`awaitReleasedSettled`
//      在没有 driver 时立即 settle）——这是唯一一个两侧都能在同一段断言里驱动的参与者；
//   ② 端口面（`drive` / `children` / `activity` 的方法名与形参个数）两侧逐字相同；
//   ③ 上面那张分叉表以源码文本断言钉住——将来谁把这一对合一，必须先来删掉这些断言，
//      也就必须先正面处理 `children` 的两台引擎。
// `drive` / `children` 的行为**没有**双引擎对拍：它们各自只能在自己的引擎上跑（见上），
// 各自的覆盖由 `rfc349-*` / `rfc339-*` 等既有套件承担。

import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { TaskExecutionRuntimeParticipants } from '@/modules/task-execution/application/ports/taskExecutionRuntimeParticipants'
import { createSqliteTaskExecutionRuntimeParticipants } from '@/modules/task-execution/infrastructure/sqliteTaskExecutionRuntimeParticipants'
import {
  createPostgresqlTaskExecutionRuntimeParticipants,
  type PostgresqlTaskExecutionRuntimeDependencies,
} from '@/modules/task-execution/infrastructure/postgresqlTaskExecutionRuntimeParticipants'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createRuntimeSessionLeaseOperations } from '@/modules/task-execution/infrastructure/runtimeSessionLeaseOperations'
import { createCollaborationRuntimeMechanics } from '@/modules/collaboration/infrastructure/collaborationRuntimeMechanics'
import { createTaskDagCollaborationOperations } from '@/modules/collaboration/infrastructure/taskDagCollaborationOperations'
import { composeSqliteRuntimeRegistryOperations } from '@/platform/runtime-registry/composition'
import { describeEachProvider } from './helpers/eachProvider'
import { sqliteMemoryInjectionQueries } from './helpers/memoryInjection'
import { createTestRepositoryPublicationTransport } from './helpers/taskExecutionTestTopology'

const INFRASTRUCTURE = resolve(
  import.meta.dir,
  '..',
  'src',
  'modules',
  'task-execution',
  'infrastructure',
)

const read = (name: string): string => readFileSync(resolve(INFRASTRUCTURE, name), 'utf8')

/**
 * 只被工厂**存下来、不被本文件驱动**的依赖。两个工厂都只在构造时把它们收进闭包，
 * `activity` 一条也用不到；写成占位是为了让「构造这一步」本身也在两个引擎上跑一遍。
 */
function passthrough<T>(label: string): T {
  return new Proxy(
    {},
    {
      get() {
        throw new Error(`本对拍不驱动 '${label}'：它只是工厂闭包里的直传依赖`)
      },
    },
  ) as T
}

function sqliteParticipants(db: ProviderNeutralDatabase): TaskExecutionRuntimeParticipants {
  const client = db as unknown as DbClient
  const persistence = createTaskExecutionPersistence(db)
  return createSqliteTaskExecutionRuntimeParticipants({
    db: client,
    memoryInjectionQueries: sqliteMemoryInjectionQueries(client),
    collaborationRuntime: createCollaborationRuntimeMechanics(client),
    persistence,
    runtimeSessionLeases: createRuntimeSessionLeaseOperations(db),
    runtimeRegistry: composeSqliteRuntimeRegistryOperations(client),
    workgroupTurns: passthrough('workgroupTurns'),
    repositoryPublicationTransport: createTestRepositoryPublicationTransport(),
  })
}

function postgresqlParticipants(db: ProviderNeutralDatabase): TaskExecutionRuntimeParticipants {
  const client = db as unknown as PostgresqlDatabaseClient
  const dependencies: PostgresqlTaskExecutionRuntimeDependencies = {
    taskDagCollaboration: createTaskDagCollaborationOperations(db),
    collaborationRuntime: createCollaborationRuntimeMechanics(db),
    workgroupTurns: passthrough('workgroupTurns'),
    childLaunchWorkgroup: passthrough('childLaunchWorkgroup'),
    identityAccess: passthrough('identityAccess'),
    repositoryPublicationTransport: createTestRepositoryPublicationTransport(),
    codeHostConnections: passthrough('codeHostConnections'),
    processConcurrencyScope: {},
    daemonGeneration: `gen-${ulid()}`,
    finalizeWorkspace: async () => {},
    log: passthrough('log'),
  }
  return createPostgresqlTaskExecutionRuntimeParticipants(client, dependencies)
}

/** 按引擎取本引擎的那份适配器。`describeEachProvider` 有意不给 provider 名，只给能力矩阵。 */
function participantsFor(
  db: ProviderNeutralDatabase,
  isolation: 'exclusive' | 'read-committed',
): TaskExecutionRuntimeParticipants {
  return isolation === 'exclusive' ? sqliteParticipants(db) : postgresqlParticipants(db)
}

describeEachProvider('RFC-359 W8 —— runtime 参与者双引擎对拍', (harness) => {
  test('端口面两侧逐字相同：drive / children / activity 的方法名与形参个数', () => {
    const participants = participantsFor(harness.db, harness.capabilities.isolation)
    // 端口面三个参与者两侧都有；PostgreSQL 的工厂还**额外**回 `persistence` / `executionModule`
    // （`PostgresqlTaskExecutionRuntimeAggregate`），SQLite 的只回端口——两侧连返回形状都不同，
    // 这也是 W8 判不合的证据之一。
    const keys = Object.keys(participants).sort()
    expect(keys.filter((key) => ['activity', 'children', 'drive'].includes(key))).toEqual([
      'activity',
      'children',
      'drive',
    ])
    expect(keys.filter((key) => !['activity', 'children', 'drive'].includes(key))).toEqual(
      harness.capabilities.isolation === 'exclusive' ? [] : ['executionModule', 'persistence'],
    )
    expect(Object.isFrozen(participants)).toBe(true)
    expect(Object.keys(participants.drive)).toEqual(['drive'])
    expect(participants.drive.drive.length).toBe(2)
    expect(Object.keys(participants.children).sort()).toEqual(['cancel', 'resume'])
    expect(participants.children.cancel.length).toBe(1)
    expect(participants.children.resume.length).toBe(2)
    expect(Object.keys(participants.activity).sort()).toEqual(['awaitReleasedSettled', 'isActive'])
    expect(participants.activity.isActive.length).toBe(1)
    expect(participants.activity.awaitReleasedSettled.length).toBe(1)
  })

  test('activity：没有 driver 的任务 isActive 为 false，awaitReleasedSettled 立即 settle', async () => {
    const participants = participantsFor(harness.db, harness.capabilities.isolation)
    const unknown = `w8_runtime_${ulid()}`
    expect(participants.activity.isActive(unknown)).toBe(false)
    // 两个引擎上都不许挂住：没有在跑的 driver 时这条 await 必须立刻回来。
    await participants.activity.awaitReleasedSettled(unknown)
    expect(participants.activity.isActive(unknown)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 不合一判定的源码锚点（不进 describeEachProvider：与引擎无关，跑一遍就够）
// ---------------------------------------------------------------------------

test('W8 判不合 · children 是两台引擎：SQLite 转发 services/task，PostgreSQL 转发自己的参与者', () => {
  const sqlite = read('sqliteTaskExecutionRuntimeParticipants.ts')
  const postgresql = read('postgresqlTaskExecutionRuntimeParticipants.ts')

  // SQLite 的 cancel / resume 是 legacy services 引擎。
  expect(sqlite).toContain("import { cancelTask, isTaskActive, resumeTask } from '@/services/task'")
  expect(sqlite).toContain('await cancelTask(input.db,')
  expect(sqlite).toContain('await resumeTask(input.db,')

  // PostgreSQL 的 cancel / resume 是自己那 774 行的参与者。
  expect(postgresql).toContain('createPostgresqlChildTaskLifecycleParticipant')
  expect(postgresql).not.toContain("from '@/services/task'")

  // `cancelTask` 的准入预检是 bun:sqlite 的同步读——它在 PostgreSQL 客户端上跑不出正确结果，
  // 这一条就是「两侧 children 不能互换」的机械证据。
  const cancelTaskSource = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'task.ts'),
    'utf8',
  )
  const cancelBody = cancelTaskSource.slice(
    cancelTaskSource.indexOf('export async function cancelTask('),
  )
  expect(cancelBody.slice(0, 1_200)).toContain('.all()[0]')
})

test('W8 判不合 · activity 读的是两个不同的 registry：进程级单例 vs 注入的 executionModule', () => {
  const sqlite = read('sqliteTaskExecutionRuntimeParticipants.ts')
  const postgresql = read('postgresqlTaskExecutionRuntimeParticipants.ts')

  expect(sqlite).toContain('isActive: isTaskActive')
  expect(sqlite).toContain('awaitReleasedSettled: awaitTaskDriverReleasedSettled')
  // 那两个符号读的是 `taskExecutionModule` 这个进程级单例，不是构造时传进来的 registry。
  expect(read('taskDriverLifecycle.ts')).toContain(
    'taskExecutionModule.runtimeRegistry.awaitReleasedSettled(taskId)',
  )

  expect(postgresql).toContain('executionModule.runtimeRegistry.hasTask(taskId)')
  expect(postgresql).toContain('executionModule.runtimeRegistry.awaitReleasedSettled(taskId)')
})

test('W8 判不合 · drive 的内核已经是一份实现：两侧都调同一个 driveTaskEngineApplication', () => {
  const sqlite = read('sqliteTaskExecutionRuntimeParticipants.ts')
  const postgresql = read('postgresqlTaskExecutionRuntimeParticipants.ts')
  for (const source of [sqlite, postgresql]) {
    expect(source).toContain(
      "import { driveTaskEngineApplication } from '../composition/taskEngineApplication'",
    )
    expect(source).toContain('await driveTaskEngineApplication(')
    expect(source).toContain('wrapperRuntimeFactory: composeWrapperRuntime')
    expect(source).toContain('mergeRecoveryFactory: composeExecutionMergeRecovery')
  }
  // 差的只是 childLaunch：两侧各有一台子任务启动引擎（87 行 vs 770 行）。
  expect(sqlite).toContain('createSqliteChildExecutionLaunchOperations(input.db)')
  expect(postgresql).toContain('createPostgresqlChildExecutionLaunchOperations({')
})
