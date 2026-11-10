import { projectStoredTaskRepositoryMounts } from '../infrastructure/taskRepositorySurface'
import { bindWorkspaceExcludeProfile } from '@/modules/source-control/public/participants'
import { resolveTaskDriveConfig } from '../application/drive/taskDriveTypes'
import type { BoundRunTaskOptions } from './taskEngineRuntimeOptions'
import type {
  PreparedTaskDrive,
  TaskDrivePreparation,
  TaskRunPorts,
} from '../application/ports/taskRun'
import { collaboratorUserIdsOf } from '../domain/taskCollaborators'
import type { WrapperNodeKind } from '../domain/wrapperExecution'
import { runTask } from '../engine/task/runTask'
import { inspectReadonlyRepos } from '../engine/task/readonlyInspection'
import { createReadonlyInspectionPorts } from './commitPushBinding'
import { driveDagScope } from './taskDagScope'
import { buildNodeExecutionWorkgroupHooks } from './nodeExecution'
import type { TaskExecutionRuntimeComponents } from './taskExecutionComponents'
import type { TaskMechanicsState } from './taskMechanicsState'
import { runDynamicWorkflowGenerate } from '../engine/task/dynamicWorkflowGenerate'
import type { DynamicWorkflowGeneratePorts } from '../application/ports/dynamicWorkflowGenerate'
import { triggerPreflightIssue } from '@/services/execution/triggerPreflight'
import { runWithTaskExecutionContext } from '../application/taskExecutionContext'
import { createLogger, type Logger } from '@/util/log'
import type { SchedulerRuntimeTopology } from '../public/participants'
import {
  createTaskAgentResourceSession,
  type TaskAgentResourceSession,
} from '../infrastructure/taskExecutionResources'
import { withTaskReviewMutationLock } from '../infrastructure/reviewMutationQueue'

/**
 * RFC-408 — the task control plane's ports (`engine/task/runTask.ts`). Every value is read when the
 * control plane asks for it; the admission opens the task resource session the drive later consumes.
 */
export function createTaskRunPorts(
  opts: BoundRunTaskOptions,
  topology: SchedulerRuntimeTopology,
  runtimeComponents: TaskExecutionRuntimeComponents,
): TaskRunPorts<TaskAgentResourceSession> {
  const log = opts.log ?? createLogger('scheduler')
  return {
    taskId: opts.taskId,
    log,
    get settlementLog() {
      return createLogger('scheduler')
    },
    get execution() {
      return opts.executionContext
    },
    get signal() {
      return opts.signal
    },
    persistence: {
      get drive() {
        return opts.persistence.drive
      },
      get ownership() {
        return opts.persistence.ownership
      },
      get runtimeLifecycle() {
        return opts.persistence.runtimeLifecycle
      },
      get humanGateLifecycle() {
        return opts.persistence.humanGateLifecycle
      },
    },
    admission: {
      async admit(input) {
        const taskExecutionIdentity = opts.identityAccess
        const taskExecutionAdmission =
          await taskExecutionIdentity.delegatedRequests.forTaskExecution(input)
        if (taskExecutionAdmission === null) return null
        return createTaskAgentResourceSession(
          Object.freeze({
            authority: taskExecutionAdmission.authority,
            actor: taskExecutionAdmission.actor,
            resources: taskExecutionIdentity.taskExecutionResources,
          }),
          opts.taskAgentRuns.materialReferences,
        )
      },
    },
    workspace: {
      get ensureProfiles() {
        return opts.ensureWorkspaceProfiles === true
      },
      project: (task, rows) => projectStoredTaskRepositoryMounts(task, rows),
      ensureExcludeProfile: ({ workspaceRef, directChildMounts }) =>
        bindWorkspaceExcludeProfile(opts.workspaceExcludeProfiles, { workspaceRef }).ensure({
          directChildMounts,
        }),
    },
    rules: {
      triggerPreflightIssue,
    },
    get dynamicWorkflow() {
      return opts.dynamicWorkflow?.persistence
    },
    reviewMutation: {
      run: (fn) => withTaskReviewMutationLock(opts.taskId, fn),
    },
    prepare: (input) => prepareTaskDrive(opts, topology, runtimeComponents, log, input),
  }
}

/**
 * RFC-408 — assemble the execution state from the facts the control plane established, and the drive
 * over it: merge recovery, the three engine bodies, the production drive configuration and the
 * read-only member inspection. Moved verbatim from the orchestrator.
 */
function prepareTaskDrive(
  opts: BoundRunTaskOptions,
  topology: SchedulerRuntimeTopology,
  runtimeComponents: TaskExecutionRuntimeComponents,
  log: Logger,
  input: TaskDrivePreparation<TaskAgentResourceSession>,
): PreparedTaskDrive {
  const { taskId } = opts
  const {
    task,
    collaborators,
    admission: taskExecutionResources,
    definition,
    repos,
    triggerContext,
    inputsMap,
    scopeIndex,
    containerOf,
    topLevelIds,
  } = input
  const state: TaskMechanicsState = {
    task,
    taskId,
    definition,
    opts,
    taskExecutionResources,
    collaboratorUserIds: collaboratorUserIdsOf(collaborators),
    topology,
    // RFC-248: 组名**快照**（`tasks.repo_group_name`）——组被删除后仍能渲染，
    // 这正是 D8 存这一列的理由。
    repoGroupName: task.repoGroupName ?? null,
    log,
    inputsMap,
    triggerContext,
    // RFC-266: two independent daemon-wide pools (script nodes no longer queue
    // behind agent runs). Both come from the daemon-scoped registry, which
    // resizes the SAME instance when the setting changes — so a settings save
    // applies to this run, not just to the next launch.
    agentSem: opts.executionPermits.getNodePoolSemaphore(
      opts.processConcurrencyScope,
      'agent',
      opts.maxConcurrentNodes ?? 4,
      'seed-only',
    ),
    scriptSem: opts.executionPermits.getNodePoolSemaphore(
      opts.processConcurrencyScope,
      'script',
      opts.maxConcurrentScriptNodes ?? 4,
      'seed-only',
    ),
    // RFC-269: the third pool — one outbound HTTP request is a second-scale
    // step and holds no subprocess, so it gets its own (larger) budget.
    codeHostSem: opts.executionPermits.getNodePoolSemaphore(
      opts.processConcurrencyScope,
      'code-host',
      opts.maxConcurrentCodeHostCalls ?? 8,
      'seed-only',
    ),
    // RFC-098 B1 (audit S-9): the writer lock comes from the per-task
    // registry so HTTP rollback paths (clarify/review/cross-clarify) hold THE
    // SAME instance. gc happens in this function's finally only (see
    // taskWriteLocks.ts lifecycle doc).
    writeSem: opts.executionPermits.getTaskWriteSem(taskId),
    // RFC-266: from the per-task registry (same lifecycle rule as writeSem) so
    // PUT /api/config can resize a RUNNING task's fan-out. Before RFC-266 this
    // was a local `new Semaphore(...)` fed by a value nothing ever threaded.
    subprocessSem: opts.executionPermits.getTaskFanoutSem(
      taskId,
      opts.multiProcessSubprocessConcurrency ?? 4,
    ),
    containerOf,
    topLevelIds,
    wrapperScopes: Object.freeze({
      find: (wrapperId: string, kind: WrapperNodeKind) => scopeIndex.wrapper(wrapperId, kind),
    }),
    driveScope: (nestedState, args) =>
      driveDagScope(nestedState, args, runtimeComponents.wrapperRuntimeFactory),
    // RFC-066: thread per-repo metadata through every inner dispatch.
    repos,
    // RFC-193 D9: top-level scope canonical = the task worktree container.
    scopeRoot: task.worktreePath,
  }
  // RFC-410: the dynamic-workflow generation engine's ports (engine/task/dynamicWorkflowGenerate.ts).
  const dynamicWorkflowPorts = (): DynamicWorkflowGeneratePorts => {
    const dynamicWorkflow = opts.dynamicWorkflow
    if (dynamicWorkflow === undefined) {
      throw new Error('dynamic-workflow-operations-not-composed')
    }
    return {
      persistence: dynamicWorkflow.persistence,
      nodeRuns: opts.persistence.nodeRuns,
      validation: dynamicWorkflow.validation,
      rules: { triggerPreflightIssue },
      host: buildNodeExecutionWorkgroupHooks(state, runtimeComponents.wrapperRuntimeFactory),
    }
  }
  return {
    recoverBeforeScope: () =>
      runtimeComponents.mergeRecoveryFactory(state, log).recoverBeforeScope(),
    bodies: Object.freeze({
      dag: () =>
        driveDagScope(
          state,
          {
            scopeId: null,
            scopeIds: topLevelIds,
            containerRunId: null,
            iteration: 0,
            log,
          },
          runtimeComponents.wrapperRuntimeFactory,
        ),
      'workgroup-turns': () =>
        opts.workgroupTurns.drive({
          taskId,
          log,
          ...(opts.signal ? { signal: opts.signal } : {}),
          host: buildNodeExecutionWorkgroupHooks(state, runtimeComponents.wrapperRuntimeFactory),
        }),
      'dw-generate': () =>
        runDynamicWorkflowGenerate(dynamicWorkflowPorts(), {
          taskId,
          log,
          ...(opts.signal ? { signal: opts.signal } : {}),
        }),
    }),
    runtimeConfig: () => {
      const {
        taskId: _taskId,
        executionContext: _executionContext,
        signal: _signal,
        codeHostConnections: _codeHostConnections,
        codeHostRequests: _codeHostRequests,
        codeHostFetch: _codeHostFetch,
        repositoryPublicationTransport: _repositoryPublicationTransport,
        ...runtimeOptions
      } = opts
      return resolveTaskDriveConfig(runtimeOptions)
    },
    inspectReadonlyRepos: () => inspectReadonlyRepos(createReadonlyInspectionPorts(state), log),
  }
}

/**
 * TaskEngine 的驱动入口。
 *
 * RFC-359 W5-T19b —— 这里曾经是账本里最大的一处组合根占位：形参写 `RunTaskOptions`
 * （九个装配依赖全是可选），进门先连着九句
 * `if (opts.X === undefined) throw new Error('X-not-composed')`，再把自己收窄成
 * `BoundRunTaskOptions` 交给下面。那正是「装配未完成但已经可被调用」——类型层完全合法，
 * 缺口只在真的驱动到某个任务时才炸，而两个 provider 的 daemon 各自跑到它的时机不一样。
 *
 * 现在**形参直接是 `BoundRunTaskOptions`**：这些依赖是它的必填字段，「没装配」在装配处
 * 就编译不过，九句 throw 与那次自我收窄一起消失。三个调用点（PG / SQLite 两个 runtime
 * participants + 测试 topology）本来就逐个显式交齐这九项，一字未改。
 *
 * `RunTaskOptions` 那九格仍然可选：它是**更外层**的调用词汇（`runTask` / `runNode` /
 * 各路由的启动参数）在用，那些路径不经过本函数。
 * W12 同样在此生产契约要求 identityAccess；SQLite participant 与完整工厂向上传递此要求，
 * 外层 legacy options 保持可选，避免把完整装配约束扩散到尚未进入驱动的调用词汇。
 */
export async function driveTaskEngineApplication(
  opts: BoundRunTaskOptions,
  topology: SchedulerRuntimeTopology,
  runtimeComponents: TaskExecutionRuntimeComponents,
): Promise<void> {
  // RFC-098 B1: the per-task write-lock registry entry is gc'd here and ONLY
  // here (taskWriteLocks.ts lifecycle — an HTTP-side gc would split-brain the
  // mutex against our cached legacy mechanics writeSem reference).
  // RFC-266: the fan-out sub-pool registry entry follows the SAME rule and the
  // same reasoning (a split pool would run a task at double its configured
  // shard concurrency), so it is reclaimed in this one place too.
  try {
    // RFC-408: the task control plane runs in engine/task on ports bound inside the execution context.
    const run = () => runTask(createTaskRunPorts(opts, topology, runtimeComponents))
    if (opts.executionContext === undefined) {
      await run()
    } else {
      await runWithTaskExecutionContext(opts.executionContext, run)
    }
  } finally {
    opts.executionPermits.gcTaskWriteSem(opts.taskId)
    opts.executionPermits.gcTaskFanoutSem(opts.taskId)
  }
}
