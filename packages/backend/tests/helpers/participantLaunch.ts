// RFC-359 AC-1（plan §5hn 批次二 ⑧）—— 测试侧的**启动参与者**装配，和生产同形。
//
// 为什么需要它：`startAgentTask` / `startWorkgroupTask` 这两个 legacy 启动服务在门面退役后
// **生产零消费者**，但一批套件仍在直接调它们（端口值映射 / `sourceAgentName` / 校验矩阵 /
// ACL 门 / 删除竞态）。那些主题都还在，只是**入口换了**：生产现在走启动参与者的
// agent / workgroup 臂 → 根启动内核。这里给出与旧签名等价的调用面，让那些套件改一行 import
// 就能测到真正在跑的那条路。
//
// 装配逐格复刻 `server.ts` 的 `taskRouteLaunchDependencies`；两处刻意不同，各自写明理由。
import type { Actor } from '../../src/auth/actor'
import type { SecretBox } from '../../src/auth/secretBox'
import type { DbClient } from '../../src/db/client'
import type { StartAgentTask, StartWorkgroupTask, Task } from '@agent-workflow/shared'
import { composeIdentityAccess } from '../../src/modules/identity-access/composition'
import { composeAgentLaunchResourceOperations } from '../../src/modules/task-execution/composition/agentLaunchResources'
import { composeWorkgroupLaunchResourceOperations } from '../../src/modules/task-execution/composition/workgroupLaunchResources'
import { createSqliteTaskExecutionLaunchParticipant } from '../../src/modules/task-execution/composition/taskRouteLaunch'
import { createTaskExecutionPersistence } from '../../src/modules/task-execution/composition/taskExecutionPersistence'
import type { TaskExecutionLaunchParticipant } from '../../src/modules/task-execution/infrastructure/taskRouteLaunchOperations'
import type { TaskDriveCompletionMode } from '../../src/modules/task-execution/application/drive/taskDriveTypes'
import type { SchedulerDriverPort } from '../../src/modules/task-execution/public/commands'
import { composeDatabaseAgentResourceIntegrity } from '../../src/modules/resource-catalog/composition/agentResourceIntegrity'
import { composeResourceCatalogFor } from '../../src/modules/resource-catalog/composition/providerResourceCatalog'
import { composeTaskExecutionResourceBinding } from '../../src/modules/resource-catalog/composition/taskExecution'
import type { TaskExecutionResourceAuthority } from '../../src/services/execution/taskExecutionResources'
import { createTaskExecutionResourceBinding } from '../../src/services/execution/taskExecutionResources'
import { taskExecutionResourceDependencies } from '../../src/services/execution/taskExecutionResourceDependencies'
import { createTaskDriveCoordinator, type StartTaskDeps } from '../../src/services/task'

/**
 * 给一个**普通构造的 actor**（`buildActor({...})`）配一份任务执行鉴权句柄。
 *
 * 不能走 `directAuthority.authorityForLegacyProjection(actor)`——那一条按**对象同一性**
 * 认凭据边缘铸出来的 actor（`authorityByProjection.get(projection)`），测试里 `buildActor`
 * 造的 actor 不在那张表里，会当场抛 `foreign-legacy-actor-projection`。
 * 走 `contexts.fromAuthenticatedPrincipal`——与 `integrationTriggerResourceAuthority` 同一条路。
 */
export function testTaskExecutionResourceAuthority(
  db: DbClient,
  actor: Actor,
): TaskExecutionResourceAuthority {
  const identityAccess = composeIdentityAccess(db)
  const context = identityAccess.contexts.fromAuthenticatedPrincipal(
    { userId: actor.user.id, source: actor.source },
    'http',
  )
  return Object.freeze({
    actor,
    authority: context.authority,
    resources: createTaskExecutionResourceBinding(
      db,
      composeTaskExecutionResourceBinding(taskExecutionResourceDependencies),
    ),
  })
}

export interface TestLaunchParticipantInput {
  readonly db: DbClient
  readonly appHome: string
  readonly schedulerDriver: SchedulerDriverPort
  readonly configPath?: string
  readonly secretBox?: SecretBox
  /**
   * 旧调用面上的 `awaitScheduler: true` 在这里的对应物。缺省 `await-settle`：
   * 提交之后等驱动跑完再返回——那正是 `awaitScheduler` 当年的语义。
   */
  readonly completionMode?: TaskDriveCompletionMode
  /** `binaryOverride` 等运行期旋钮，原样进协调器的依赖束。 */
  readonly runConfig?: Omit<Partial<StartTaskDeps>, 'db' | 'schedulerDriver' | 'configPath'>
}

export function createTestTaskExecutionLaunchParticipant(
  input: TestLaunchParticipantInput,
): TaskExecutionLaunchParticipant {
  const configPath = input.configPath ?? `${input.appHome}/config.json`
  const resourceCatalog = composeResourceCatalogFor({ db: input.db })
  const integrity = composeDatabaseAgentResourceIntegrity({
    db: input.db,
    authorization: resourceCatalog.authorization,
  }).launch
  const persistence = createTaskExecutionPersistence(input.db)
  const completionMode = input.completionMode ?? 'await-settle'
  const drive = createTaskDriveCoordinator({
    deps: {
      db: input.db,
      schedulerDriver: input.schedulerDriver,
      configPath,
      ...input.runConfig,
    },
    appHome: input.appHome,
    engineFailureMessage: 'test launch participant drive threw',
    failureReporter: {
      async report({ taskId, error, execution }) {
        const now = Date.now()
        await persistence.runtimeLifecycle.trySet({
          taskId,
          to: 'failed',
          allowedFrom: ['pending', 'running'],
          extra: {
            finishedAt: now,
            errorSummary: 'task drive failed',
            errorMessage: error instanceof Error ? error.message : String(error),
          },
          executionContext: execution,
          now,
          reason: 'task-drive',
        })
      },
    },
  })
  return createSqliteTaskExecutionLaunchParticipant({
    db: input.db,
    configPath,
    gitCommitIdentity: composeIdentityAccess(input.db).getUserGitCommitIdentity,
    agent: { resources: composeAgentLaunchResourceOperations({ db: input.db }), integrity },
    workgroup: composeWorkgroupLaunchResourceOperations({ db: input.db, integrity }),
    routeWorkspace: {
      appHome: input.appHome,
      ...(input.secretBox === undefined ? {} : { secretBox: input.secretBox }),
    },
    // 参与者收的是请求上带来的 `resources`，这一格只被**路由包装**读——本 helper 不装路由，
    // 交一个会当场炸的实现比交一个静默走别的路的占位好。
    resourceAuthorityFor: () => {
      throw new Error('test launch participant does not compose the route wrapper')
    },
    coordinator: {
      submit: (request) => drive.submit({ ...request, completionMode }),
    },
  })
}

/** 旧 `startAgentTask(resources, actor, agentId, payload, deps, uploads)` 的等价调用面。 */
export async function launchAgentTaskViaParticipant(
  participant: TaskExecutionLaunchParticipant,
  db: DbClient,
  actor: Actor,
  agentId: string,
  payload: StartAgentTask,
): Promise<Task> {
  return await participant.launch({
    actor,
    target: { kind: 'agent', refId: agentId, payload },
    invoker: { type: 'user', launchKind: 'direct-json' },
    resources: testTaskExecutionResourceAuthority(db, actor),
  })
}

/** 旧 `startWorkgroupTask(db, actor, workgroupId, payload, deps)` 的等价调用面。 */
export async function launchWorkgroupTaskViaParticipant(
  participant: TaskExecutionLaunchParticipant,
  db: DbClient,
  actor: Actor,
  workgroupId: string,
  payload: StartWorkgroupTask,
): Promise<Task> {
  return await participant.launch({
    actor,
    target: { kind: 'workgroup', refId: workgroupId, payload },
    invoker: { type: 'user', launchKind: 'direct-json' },
    resources: testTaskExecutionResourceAuthority(db, actor),
  })
}
