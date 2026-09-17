// RFC-359 AC-1（plan §5hn 批次二 ⑦）—— webhook 触发的 TaskExecution 参与者，**照生产装配**。
//
// 为什么重写：这个 helper 原本自己调 `services/execution/executor.ts#startExecution`
// 拼了一份参与者——而那正是**启动参与者的第二份写法**（同一个 workflow / agent / workgroup
// 三分支 switch，只是终端转 `startTask` / `startAgentTask` / `startWorkgroupTask`）。
// 生产早已换成 `createTaskExecutionTriggerParticipant({ launches, cancellation })`
//（plan §5hn 批次二 ①②），于是这三条 webhook e2e 测的是一个**生产已经不用的形状**：
// 它能在生产坏掉的时候照样绿。
//
// 现在这里逐格复刻 `server.ts` 的 `taskRouteLaunchDependencies`，终端是同一台根启动内核。
// 形参一个字没动，三个调用点因此不必改。
import type { SecretBox } from '../../src/auth/secretBox'
import type { Actor } from '../../src/auth/actor'
import type { DbClient } from '../../src/db/client'
import type { SchedulerDriverPort } from '../../src/modules/task-execution/public/commands'
import { composeAgentLaunchResourceOperations } from '../../src/modules/task-execution/composition/agentLaunchResources'
import { composeWorkgroupLaunchResourceOperations } from '../../src/modules/task-execution/composition/workgroupLaunchResources'
import { composeDeferredRepositoryPreparation } from '../../src/modules/task-execution/composition/deferredRepositoryPreparation'
import { createSqliteTaskExecutionLaunchParticipant } from '../../src/modules/task-execution/composition/taskRouteLaunch'
import { createTaskExecutionTriggerParticipant } from '../../src/modules/task-execution/composition/triggerExecution'
import { createTaskExecutionPersistence } from '../../src/modules/task-execution/composition/taskExecutionPersistence'
import { composeDatabaseAgentResourceIntegrity } from '../../src/modules/resource-catalog/composition/agentResourceIntegrity'
import { composeResourceCatalogFor } from '../../src/modules/resource-catalog/composition/providerResourceCatalog'
import { composeSqliteRepositoryWorkspaceStore } from '../../src/modules/source-control/composition'
import type { WebhookTaskExecutionParticipant } from '../../src/modules/integration/composition/webhookDispatch'
import type { TaskExecutionResourceAuthority } from '../../src/services/execution/taskExecutionResources'
import type { ExecutionInvoker } from '../../src/services/execution/types'
import { resolveLaunchRuntimeConfig } from '../../src/services/launchRuntimeConfig'
import { cancelTask, createTaskDriveCoordinator } from '../../src/services/task'
import type { IntegrationTriggerIdentityAccess } from '../../src/server'
import { Paths } from '../../src/util/paths'

/** SQLite test composition for Integration's closed TaskExecution participant. */
export function createSqliteWebhookTaskExecutionParticipant(input: {
  readonly db: DbClient
  readonly configPath: string
  readonly secretBox: SecretBox
  readonly schedulerDriver: SchedulerDriverPort
  /** 与生产同源的身份面：`withIntegrationTriggerResources(db, identityAccess)` 的产物。 */
  readonly identityAccess: IntegrationTriggerIdentityAccess
}): WebhookTaskExecutionParticipant<TaskExecutionResourceAuthority, ExecutionInvoker> {
  const appHome = Paths.root
  const resourceCatalog = composeResourceCatalogFor({ db: input.db })
  const integrity = composeDatabaseAgentResourceIntegrity({
    db: input.db,
    authorization: resourceCatalog.authorization,
  }).launch
  const persistence = createTaskExecutionPersistence(input.db)
  const launchRuntime = resolveLaunchRuntimeConfig(input.configPath)
  const launchRuntimeKnobs = Object.freeze({
    ...(launchRuntime.cloneTimeoutMs === undefined
      ? {}
      : { cloneTimeoutMs: launchRuntime.cloneTimeoutMs }),
    ...(launchRuntime.gitBaselineSyncWindowMs === undefined
      ? {}
      : { gitBaselineSyncWindowMs: launchRuntime.gitBaselineSyncWindowMs }),
  })
  const launches = createSqliteTaskExecutionLaunchParticipant({
    db: input.db,
    configPath: input.configPath,
    gitCommitIdentity: input.identityAccess.getUserGitCommitIdentity,
    agent: {
      resources: composeAgentLaunchResourceOperations({ db: input.db }),
      integrity,
    },
    workgroup: composeWorkgroupLaunchResourceOperations({ db: input.db, integrity }),
    routeWorkspace: { appHome, secretBox: input.secretBox },
    // 参与者收的是请求上带来的 `resources`，这一格只被**路由包装**读——本 helper 不装路由。
    resourceAuthorityFor: (actor: Actor) =>
      Object.freeze({
        actor,
        authority: input.identityAccess.directAuthority.authorityForLegacyProjection(actor),
        resources: input.identityAccess.taskExecutionResources,
      }),
    coordinator: createTaskDriveCoordinator({
      // 运行期配置必须与生产取自同一处：`runtimeConfigOpts(deps)` 从 `deps` 上读十七个旋钮，
      // 只给 `{db, schedulerDriver, configPath}` 时它们全是 undefined（`20d4a6ce5` 的 e2e 红就是这么来的）。
      deps: {
        db: input.db,
        schedulerDriver: input.schedulerDriver,
        configPath: input.configPath,
        ...launchRuntime,
      },
      appHome,
      engineFailureMessage: 'webhook task drive threw',
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
          await persistence.intentTerminalization.terminalize({
            taskId,
            state: 'failed',
            failureCode: 'task-drive-failed',
            now,
            claimedOwnerEpoch: execution.token.epoch,
          })
        },
      },
      // RFC-287 G7：webhook 触发延后仓库准备，第 0 步由这台协调器推进。
      repositoryPreparation: composeDeferredRepositoryPreparation({
        db: input.db,
        appHome,
        repositoryWorkspace: composeSqliteRepositoryWorkspaceStore(input.db),
        secretBox: input.secretBox,
        ...launchRuntimeKnobs,
      }),
    }),
  })
  return createTaskExecutionTriggerParticipant({
    launches,
    cancellation: {
      async cancel(request) {
        await cancelTask(input.db, request.taskId)
      },
    },
  })
}
