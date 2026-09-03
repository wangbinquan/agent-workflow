import {
  DAEMON_RESTART_ERROR_SUMMARY,
  DAEMON_SHUTDOWN_ABORT_REASON,
  NODE_KIND_BEHAVIORS,
  WorkflowDefinitionSchema,
  DwStateSchema,
  exclusionPlanFor,
  isWorkgroupTask,
  migrateWorkflowDefinitionToLatest,
  parseTriggerContextJson,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import {
  createExecutionScopeIndex,
  InvalidExecutionScopeError,
  type ExecutionScopeIndex,
} from '../domain/executionScope'
import type { WrapperNodeKind } from '../domain/wrapperExecution'
import { bindWorkspaceExcludeParticipant } from '@/modules/source-control/composition'
import { resolveTaskDriveConfig } from '../application/drive/taskDriveTypes'
import type {
  BoundRunTaskOptions,
  RunTaskOptions,
} from '@/services/execution/taskEngineRuntimeOptions'
import { taskEngineOutcomeFromScope, type TaskScopeOutcome } from '../domain/taskEngine'
import { DagTaskEngine } from '../engine/task/dag/dagTaskEngine'
import { DynamicWorkflowTaskEngine } from '../engine/task/dynamicWorkflowTaskEngine'
import {
  ClosedTaskEngineRegistry,
  resolveTaskEngineSelection,
} from '../engine/task/taskEngineRegistry'
import { WorkgroupTaskEngine } from '../engine/task/workgroupTaskEngine'
import { inspectReadonlyRepos } from '@/services/scheduler'
import { runScope } from './taskDagScope'
import { buildNodeExecutionWorkgroupHooks } from './nodeExecution'
import type { TaskExecutionRuntimeComponents } from './taskExecutionComponents'
import { buildScopeUpstreams, findScopeCycle } from './taskDagGraph'
import type { TaskMechanicsState } from '@/services/execution/taskMechanicsState'
import { runDynamicWorkflowGenerate } from '@/services/dynamicWorkflowRunner'
import { triggerPreflightIssue } from '@/services/execution/triggerPreflight'
import { getNodePoolSemaphore } from '@/services/processNodeConcurrency'
import { getTaskFanoutSem, gcTaskFanoutSem } from '@/services/taskFanoutPools'
import {
  assertTaskExecutionContext,
  exactOwnerMatches,
  runWithTaskExecutionContext,
} from '@/services/taskExecutionParticipants'
import { getTaskWriteSem, gcTaskWriteSem } from '@/services/taskWriteLocks'
import { DW_ORCHESTRATOR_NODE_ID } from '@/services/orchestratorAgent'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'
import type { SchedulerRuntimeTopology } from '../public/participants'
import { createTaskExecutionResourceSession } from '@/services/execution/taskExecutionResources'
import { taskStopProjection, type TaskStopCause } from '../public/types'
import { withTaskReviewMutationLock } from '@/services/reviewMutationCoordinator'

function taskStopCauseFromUnknown(value: unknown): TaskStopCause | null {
  if (typeof value !== 'object' || value === null || !('kind' in value)) return null
  const candidate = value as TaskStopCause
  switch (candidate.kind) {
    case 'user':
    case 'daemon-shutdown':
      return candidate
    case 'parent-cascade':
      return typeof candidate.parentTaskId === 'string' ? candidate : null
    case 'webhook-terminal':
      return (candidate.terminal === 'closed' || candidate.terminal === 'merged') &&
        typeof candidate.deliveryId === 'string' &&
        Number.isInteger(candidate.streamRevision)
        ? candidate
        : null
    default:
      return null
  }
}

async function failRuntimeTask(
  opts: BoundRunTaskOptions,
  errorSummary: string,
  errorMessage: string,
  failedNodeId?: string,
): Promise<void> {
  const won = await opts.persistence.runtimeLifecycle.trySet({
    taskId: opts.taskId,
    to: 'failed',
    allowedFrom: ['pending', 'running'],
    extra: {
      finishedAt: Date.now(),
      errorSummary,
      errorMessage,
      ...(failedNodeId === undefined ? {} : { failedNodeId }),
    },
    ...(opts.executionContext === undefined ? {} : { executionContext: opts.executionContext }),
    now: Date.now(),
    reason: `failTask: ${errorSummary}`,
  })
  if (!won) {
    createLogger('scheduler').warn(
      'failTask write lost to a concurrent transition — respecting winner',
      { taskId: opts.taskId, errorSummary },
    )
  }
}

async function cancelRuntimeTask(
  opts: BoundRunTaskOptions,
  failedNodeId?: string,
  abortReason?: unknown,
): Promise<void> {
  await withTaskReviewMutationLock(opts.taskId, async () => {
    const now = Date.now()
    if (abortReason === DAEMON_SHUTDOWN_ABORT_REASON) {
      await opts.persistence.runtimeLifecycle.trySet({
        taskId: opts.taskId,
        to: 'interrupted',
        allowedFrom: ['running'],
        extra: {
          finishedAt: now,
          errorSummary: DAEMON_RESTART_ERROR_SUMMARY,
          errorMessage:
            'daemon shutdown interrupted this task; resume (or auto-resume) continues it',
          ...(failedNodeId === undefined ? {} : { failedNodeId }),
        },
        ...(opts.executionContext === undefined ? {} : { executionContext: opts.executionContext }),
        now,
        reason: 'cancelTaskRow-shutdown',
      })
      return
    }
    const structuredCause = taskStopCauseFromUnknown(abortReason)
    const projection = taskStopProjection(structuredCause ?? { kind: 'user' })
    const won = await opts.persistence.runtimeLifecycle.trySet({
      taskId: opts.taskId,
      to: 'canceled',
      allowedFrom: ['running'],
      extra: {
        finishedAt: now,
        errorSummary: projection.summary,
        errorMessage:
          structuredCause?.kind === 'webhook-terminal'
            ? `${projection.code}: delivery=${structuredCause.deliveryId} revision=${structuredCause.streamRevision}`
            : structuredCause?.kind === 'parent-cascade' && structuredCause.rootCause !== undefined
              ? `${projection.code}: parent=${structuredCause.parentTaskId} delivery=${structuredCause.rootCause.deliveryId} revision=${structuredCause.rootCause.streamRevision}`
              : projection.code,
        ...(failedNodeId === undefined ? {} : { failedNodeId }),
      },
      ...(opts.executionContext === undefined ? {} : { executionContext: opts.executionContext }),
      now,
      reason: 'cancelTaskRow',
    })
    if (!won) {
      createLogger('scheduler').warn(
        'cancelTaskRow lost to a concurrent transition — respecting winner',
        { taskId: opts.taskId },
      )
    }
  })
}

export async function driveTaskEngineApplication(
  opts: RunTaskOptions,
  topology: SchedulerRuntimeTopology,
  runtimeComponents: TaskExecutionRuntimeComponents,
): Promise<void> {
  if (opts.memoryInjectionQueries === undefined) {
    throw new Error('memory-injection-queries-not-composed')
  }
  if (opts.persistence === undefined) {
    throw new Error('task-execution-persistence-not-composed')
  }
  if (opts.runtimeSessionLeases === undefined) {
    throw new Error('runtime-session-leases-not-composed')
  }
  if (opts.runtimeRegistry === undefined) {
    throw new Error('runtime-registry-not-composed')
  }
  if (opts.taskDagCollaboration === undefined) {
    throw new Error('task-dag-collaboration-not-composed')
  }
  if (opts.collaborationRuntime === undefined) {
    throw new Error('collaboration-runtime-mechanics-not-composed')
  }
  if (opts.workgroupTurns === undefined) {
    throw new Error('workgroup-turns-not-composed')
  }
  if (opts.childLaunch === undefined) {
    throw new Error('child-execution-launch-not-composed')
  }
  if (opts.processConcurrencyScope === undefined) {
    throw new Error('task-execution-concurrency-scope-not-composed')
  }
  const boundOptions: BoundRunTaskOptions = {
    ...opts,
    memoryInjectionQueries: opts.memoryInjectionQueries,
    persistence: opts.persistence,
    runtimeSessionLeases: opts.runtimeSessionLeases,
    runtimeRegistry: opts.runtimeRegistry,
    taskDagCollaboration: opts.taskDagCollaboration,
    collaborationRuntime: opts.collaborationRuntime,
    workgroupTurns: opts.workgroupTurns,
    childLaunch: opts.childLaunch,
    processConcurrencyScope: opts.processConcurrencyScope,
  }
  // RFC-098 B1: the per-task write-lock registry entry is gc'd here and ONLY
  // here (taskWriteLocks.ts lifecycle — an HTTP-side gc would split-brain the
  // mutex against our cached legacy mechanics writeSem reference).
  // RFC-266: the fan-out sub-pool registry entry follows the SAME rule and the
  // same reasoning (a split pool would run a task at double its configured
  // shard concurrency), so it is reclaimed in this one place too.
  try {
    if (opts.executionContext === undefined) {
      await runTaskEngineOrchestratorInner(boundOptions, topology, runtimeComponents)
    } else {
      await runWithTaskExecutionContext(opts.executionContext, () =>
        runTaskEngineOrchestratorInner(boundOptions, topology, runtimeComponents),
      )
    }
  } finally {
    gcTaskWriteSem(opts.taskId)
    gcTaskFanoutSem(opts.taskId)
  }
}

async function runTaskEngineOrchestratorInner(
  opts: BoundRunTaskOptions,
  topology: SchedulerRuntimeTopology,
  runtimeComponents: TaskExecutionRuntimeComponents,
): Promise<void> {
  const log = opts.log ?? createLogger('scheduler')
  const { taskId } = opts

  // 1. Load one provider-owned task/repository snapshot.
  const driveSnapshot = await opts.persistence.drive.load(taskId)
  if (driveSnapshot === null) {
    log.error('runTask: task not found', { taskId })
    return
  }
  const { task, repositories: repoRows, collaborators } = driveSnapshot

  const durableOwner = await opts.persistence.ownership.read(taskId)
  if (opts.executionContext !== undefined) {
    assertTaskExecutionContext(opts.executionContext, taskId)
    if (durableOwner === null || !exactOwnerMatches(durableOwner, opts.executionContext.token)) {
      log.warn('runTask: durable owner no longer matches execution context', { taskId })
      return
    }
  } else if (durableOwner?.state === 'claimed') {
    // A production-owned task may never fall back to the pre-RFC-328 status
    // claim. Ownerless direct fixtures keep their historical test seam.
    log.error('runTask: durable owner requires exact execution context', { taskId })
    return
  }

  const taskExecutionIdentity = opts.identityAccess
  if (taskExecutionIdentity === undefined) {
    await failRuntimeTask(
      opts,
      'task execution authority unavailable',
      'identity-access-runtime-not-composed',
    )
    return
  }
  const taskExecutionAdmission = await taskExecutionIdentity.delegatedRequests.forTaskExecution({
    ownerUserId: task.ownerUserId,
    taskId,
  })
  if (taskExecutionAdmission === null) {
    await failRuntimeTask(
      opts,
      'task execution authority unavailable',
      'task-execution-owner-inactive',
    )
    return
  }
  const taskExecutionResources = createTaskExecutionResourceSession(
    Object.freeze({
      authority: taskExecutionAdmission.authority,
      actor: taskExecutionAdmission.actor,
      resources: taskExecutionIdentity.taskExecutionResources,
    }),
    opts.appHome,
  )

  // RFC-066 PR-B T9: load per-repo metadata once at the top so every runner
  // dispatch site can thread it through `templateMeta.repos` without an extra
  // round-trip. Single-repo tasks get a length-1 array mirroring the legacy
  // `tasks.*` columns (`worktreeDirName === ''` → `{{__repo_names__}}`
  // renders empty, byte-baseline). Defensive fallback handles the ultra-rare
  // case of a task row predating migration 0034's INSERT FROM backfill.
  const repos: TaskMechanicsState['repos'] =
    repoRows.length > 0
      ? repoRows.map((r) => ({
          repoIndex: r.repoIndex,
          repoPath: r.repoPath,
          worktreePath: r.worktreePath,
          worktreeDirName: r.worktreeDirName,
          // RFC-248: 真值来自 DB 列（migration 0131 已 backfill 存量行）。
          mountPath: r.mountPath,
          readonly: r.readonly,
          baseBranch: r.baseBranch,
          baseCommit: r.baseCommit,
        }))
      : [
          {
            repoIndex: 0,
            repoPath: task.repoPath,
            worktreePath: task.worktreePath,
            worktreeDirName: '',
            mountPath: '',
            readonly: false,
            baseBranch: task.baseBranch,
            baseCommit: task.baseCommit,
          },
        ]

  // RFC-308: resume/retry/recovery never trust a profile left by the prior
  // process or by an agent. Rebuild the exact per-worktree profile before any
  // runner can observe or mutate the workspace.
  if (
    repoRows.length > 0 &&
    (opts.ensureWorkspaceProfiles === true ||
      repoRows.some(
        (row) => row.workspaceProfileVersion !== 1 || row.workspaceProfileDigest === null,
      ))
  ) {
    try {
      const allMounts = repos.map((repo) => repo.mountPath)
      for (const repo of repos) {
        const receipt = await bindWorkspaceExcludeParticipant({
          worktreePath: repo.worktreePath,
          appHome: opts.appHome ?? Paths.root,
        }).ensure({ directChildMounts: exclusionPlanFor(repo.mountPath, allMounts) })
        const updated = await opts.persistence.drive.updateWorkspaceProfile({
          taskId,
          repoIndex: repo.repoIndex,
          version: receipt.version,
          digest: receipt.digest,
          ...(opts.executionContext === undefined
            ? {}
            : { executionContext: opts.executionContext }),
          now: Date.now(),
        })
        if (!updated) throw new Error(`task-repository-not-found:${taskId}:${repo.repoIndex}`)
      }
    } catch (error) {
      await failRuntimeTask(
        opts,
        'workspace-exclude-profile-failed',
        error instanceof Error ? error.message : String(error),
      )
      return
    }
  }

  // 2. Parse workflow snapshot.
  let definition: WorkflowDefinition
  try {
    const raw: unknown = JSON.parse(task.workflowSnapshot)
    definition = migrateWorkflowDefinitionToLatest(WorkflowDefinitionSchema.parse(raw))
  } catch (err) {
    await failRuntimeTask(opts, 'snapshot-invalid', (err as Error).message)
    return
  }

  // RFC-292: keep NULL, valid context and corrupt JSON distinct. Historical
  // flat RFC-269 rows are wrapped in memory by the shared decoder.
  const parsedTriggerContext = parseTriggerContextJson(task.triggerContextJson)
  const triggerIssue = triggerPreflightIssue({
    root: definition,
    closureJson: task.refClosureJson,
    source: parsedTriggerContext,
  })
  if (triggerIssue !== null) {
    await failRuntimeTask(opts, triggerIssue.code, triggerIssue.code)
    return
  }
  const triggerContext = parsedTriggerContext.kind === 'ok' ? parsedTriggerContext.value : null

  // 3. Mark running — CAS from 'pending' ONLY (RFC-097, audit S-8/S-14).
  // The unconditional write here used to revive canceled/done tasks and let a
  // second runTask take over a live one. CAS loss → another driver owns the
  // task (or it is terminal): log and step away without minting anything.
  const claimed = await opts.persistence.runtimeLifecycle.trySet({
    taskId,
    to: 'running',
    allowedFrom: ['pending'],
    ...(opts.executionContext !== undefined ? { executionContext: opts.executionContext } : {}),
    now: Date.now(),
    reason: 'runTask-start',
  })
  if (!claimed) {
    log.warn('runTask: task not claimable (not pending) — refusing to drive it', { taskId })
    return
  }

  // RFC-333 T7: a manual question may have been created while this task was
  // pending/failed/interrupted. The exact owner consumes its durable park
  // obligation immediately after claim, before any new node work can start.
  const initialManualPark = await opts.persistence.humanGateLifecycle.settleManualQuestionParks({
    taskId,
    ...(opts.executionContext === undefined ? {} : { token: opts.executionContext.token }),
    now: Date.now(),
  })
  if (initialManualPark.parked) {
    log.info('task parked for a durable manual question before drive', { taskId })
    return
  }

  // 4. Validate node kinds. RFC-146: positive membership in the behavior
  // table — an admitted kind is exactly a kind with a behavior row. RFC-334
  // independently closes the production executor registry over the same
  // NodeKind catalog, so admission cannot fall through to an agent default.
  for (const node of definition.nodes) {
    // Object.hasOwn (not `in`) — inherited keys must not pass the whitelist.
    if (!Object.hasOwn(NODE_KIND_BEHAVIORS, node.kind)) {
      await failRuntimeTask(
        opts,
        `scheduler does not yet support ${node.kind} nodes`,
        `node kind ${node.kind} unsupported`,
        node.id,
      )
      return
    }
  }

  // Defense in depth for legacy/imported snapshots that predate the validator
  // rule. Scheduler maps key by node id; allowing duplicates would silently
  // fold one node away and the later topological check would lie to the user
  // with an unrelated cycle error.
  const nodeIdCounts = new Map<string, number>()
  for (const node of definition.nodes) {
    nodeIdCounts.set(node.id, (nodeIdCounts.get(node.id) ?? 0) + 1)
  }
  const duplicateNode = [...nodeIdCounts].find(([, count]) => count > 1)
  if (duplicateNode !== undefined) {
    const [nodeId, count] = duplicateNode
    await failRuntimeTask(
      opts,
      'workflow-node-id-duplicate',
      `node id '${nodeId}' appears ${count} times; node ids must be unique`,
      nodeId,
    )
    return
  }

  // Wrapper containment is the coordinate system for recursive scheduling.
  // Launch validation normally guarantees a tree, but imported/historical
  // snapshots and direct DB callers can bypass it. Never execute against the
  // deterministic diagnostic fallback map when membership is ambiguous:
  // two wrappers could otherwise dispatch the same child concurrently.
  let scopeIndex: ExecutionScopeIndex
  try {
    scopeIndex = createExecutionScopeIndex(definition)
  } catch (error) {
    if (!(error instanceof InvalidExecutionScopeError)) throw error
    const containmentIssue = error.issue
    const failedNodeId =
      containmentIssue.code === 'wrapper-containment-cycle'
        ? containmentIssue.cycle[0]
        : containmentIssue.code === 'wrapper-child-multiple-parents'
          ? containmentIssue.childId
          : containmentIssue.wrapperId
    await failRuntimeTask(
      opts,
      'wrapper-containment-invalid',
      `${containmentIssue.code}: ${JSON.stringify(containmentIssue)}`,
      failedNodeId,
    )
    return
  }

  // RFC-248 D9: 多仓 + wrapper-git 的禁令**已解除**。RFC-066 当年禁它是因为
  // 包裹器只会对单一 worktree 取快照；现在它逐仓快照、逐仓 diff，并把每个仓的
  // 路径用挂载路径前缀化后合并成一个 `list<path>`（见 GitStrategy）。
  // 这里原本有一条 `multi-repo-wrapper-git-unsupported` 的纵深防御门，随禁令
  // 一并删除——留着它会让组任务永远跑不了平台的 Code → Audit → Fix 主链路。

  // 5. Direct child → wrapper map. Chained entries retain nested scope ancestry.
  const containerOf = new Map(scopeIndex.parentOf)
  const topLevelIds = new Set(scopeIndex.rootNodeIds)

  // 6. Pre-validate the same projected graph the runtime frontier will use.
  //    Raw-edge filtering misses cycles that cross a wrapper boundary.
  const topLevelNodes = definition.nodes.filter((n) => topLevelIds.has(n.id))
  const topLevelUpstreams = buildScopeUpstreams(definition, topLevelIds, null, containerOf)
  if (findScopeCycle(topLevelNodes, topLevelUpstreams) !== null) {
    await failRuntimeTask(opts, 'workflow has a cycle outside any loop wrapper', 'cycle detected')
    return
  }

  // 7. Inputs map from launcher form.
  const inputsMap: Record<string, string> = (() => {
    try {
      return JSON.parse(task.inputs) as Record<string, string>
    } catch {
      return {}
    }
  })()

  const state: TaskMechanicsState = {
    task,
    taskId,
    definition,
    opts,
    taskExecutionResources,
    collaboratorUserIds: [
      ...new Set(
        collaborators
          .filter((member) => member.role !== 'owner' && member.userId !== null)
          .map((member) => member.userId as string),
      ),
    ],
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
    agentSem: getNodePoolSemaphore(
      opts.processConcurrencyScope,
      'agent',
      opts.maxConcurrentNodes ?? 4,
      'seed-only',
    ),
    scriptSem: getNodePoolSemaphore(
      opts.processConcurrencyScope,
      'script',
      opts.maxConcurrentScriptNodes ?? 4,
      'seed-only',
    ),
    // RFC-269: the third pool — one outbound HTTP request is a second-scale
    // step and holds no subprocess, so it gets its own (larger) budget.
    codeHostSem: getNodePoolSemaphore(
      opts.processConcurrencyScope,
      'code-host',
      opts.maxConcurrentCodeHostCalls ?? 8,
      'seed-only',
    ),
    // RFC-098 B1 (audit S-9): the writer lock comes from the per-task
    // registry so HTTP rollback paths (clarify/review/cross-clarify) hold THE
    // SAME instance. gc happens in this function's finally only (see
    // taskWriteLocks.ts lifecycle doc).
    writeSem: getTaskWriteSem(taskId),
    // RFC-266: from the per-task registry (same lifecycle rule as writeSem) so
    // PUT /api/config can resize a RUNNING task's fan-out. Before RFC-266 this
    // was a local `new Semaphore(...)` fed by a value nothing ever threaded.
    subprocessSem: getTaskFanoutSem(taskId, opts.multiProcessSubprocessConcurrency ?? 4),
    containerOf,
    topLevelIds,
    wrapperScopes: Object.freeze({
      find: (wrapperId: string, kind: WrapperNodeKind) => scopeIndex.wrapper(wrapperId, kind),
    }),
    driveScope: (nestedState, args) =>
      runScope(nestedState, args, runtimeComponents.wrapperRuntimeFactory),
    // RFC-066: thread per-repo metadata through every inner dispatch.
    repos,
    // RFC-193 D9: top-level scope canonical = the task worktree container.
    scopeRoot: task.worktreePath,
  }

  // 8. Drive the top-level scope. Any thrown error must land the task in
  // `failed` rather than wedge it on `running`: runTask is fire-and-forget from
  // the HTTP/resume path, so an unhandled rejection (e.g. an illegal node_run
  // transition, or a DB error inside a sink/wrapper branch that — unlike the
  // agent path — has no local try/catch) would otherwise leave the task stuck
  // `running` and unresumable (resumeTask refuses `running`). See
  // scheduler-boundary-wrapper-resume-interrupted.test.ts.
  let result: TaskScopeOutcome
  try {
    // RFC-130 T3c2: recover any 'pending-merge' rows from a crash between
    // agent-success and merge-back BEFORE the scope runs (so the frontier only
    // sees merged rows). A no-op on a fresh run / non-isolated task.
    await runtimeComponents.mergeRecoveryFactory(state, log).recoverBeforeScope()
    // RFC-164: workgroup tasks are driven by the round engine, NEVER by the
    // DAG frontier (design §4). The host snapshot's nodes exist only as mint
    // anchors + clarify wiring; runScope/deriveFrontier must not see them.
    // RFC-167: dynamic_workflow workgroups are the exception — their dispatch
    // follows the dw phase. RFC-243 §1.2: the decision itself now lives in
    // the executor engine registry (resolveTaskEngine — same oracle, extracted
    // verbatim); this file keeps consuming it. RFC-217 T2: the phase lives in
    // workgroup_task_state (an unknown mode still routes to the turn engine,
    // which fails with its own precise config diagnostics).
    const dynamicWorkflowSnapshot =
      isWorkgroupTask(task) && opts.dynamicWorkflow !== undefined
        ? await opts.dynamicWorkflow.persistence.loadTask(taskId)
        : null
    const dynamicWorkflowPhase = (() => {
      if (dynamicWorkflowSnapshot?.dwStateJson == null) return null
      try {
        return DwStateSchema.parse(JSON.parse(dynamicWorkflowSnapshot.dwStateJson)).phase
      } catch {
        return null
      }
    })()
    const { engine, wgDispatch } = resolveTaskEngineSelection(task, dynamicWorkflowPhase)
    const dynamicWorkflowArgs = () => {
      const dynamicWorkflow = opts.dynamicWorkflow
      if (dynamicWorkflow === undefined) {
        throw new Error('dynamic-workflow-operations-not-composed')
      }
      return {
        persistence: dynamicWorkflow.persistence,
        nodeRuns: opts.persistence.nodeRuns,
        validationContext: dynamicWorkflow.validationContext,
      }
    }
    if (
      wgDispatch === 'dw-execute' &&
      definition.nodes.some((n) => n.id === DW_ORCHESTRATOR_NODE_ID)
    ) {
      // Fail-fast invariant (design §3): phase='executing' promises the
      // snapshot is the confirmed generated DAG. Running the generation host
      // snapshot through runScope would dispatch the orchestrator node as a
      // regular agent — refuse loudly instead.
      await failRuntimeTask(
        opts,
        'dw-phase-invariant',
        `task is phase='executing' but its snapshot still contains the generation host node`,
      )
      return
    }
    const registry = new ClosedTaskEngineRegistry({
      dag: new DagTaskEngine({
        driveTopLevel: async () =>
          taskEngineOutcomeFromScope(
            await runScope(
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
          ),
      }),
      'workgroup-turns': new WorkgroupTaskEngine({
        driveTurns: async () =>
          taskEngineOutcomeFromScope(
            await opts.workgroupTurns.drive({
              taskId,
              log,
              ...(opts.signal ? { signal: opts.signal } : {}),
              host: buildNodeExecutionWorkgroupHooks(
                state,
                runtimeComponents.wrapperRuntimeFactory,
              ),
            }),
          ),
      }),
      'dw-generate': new DynamicWorkflowTaskEngine({
        generate: async () =>
          taskEngineOutcomeFromScope(
            await runDynamicWorkflowGenerate({
              ...dynamicWorkflowArgs(),
              taskId,
              log,
              ...(opts.signal ? { signal: opts.signal } : {}),
              hooks: buildNodeExecutionWorkgroupHooks(
                state,
                runtimeComponents.wrapperRuntimeFactory,
              ),
            }),
          ),
      }),
    })
    if (opts.executionContext === undefined) {
      // Legacy ownerless fixtures retain their direct scheduler seam until the
      // test application is fully migrated to the RFC-332 coordinator.
      result =
        engine === 'dw-generate'
          ? await runDynamicWorkflowGenerate({
              ...dynamicWorkflowArgs(),
              taskId,
              log,
              ...(opts.signal ? { signal: opts.signal } : {}),
              hooks: buildNodeExecutionWorkgroupHooks(
                state,
                runtimeComponents.wrapperRuntimeFactory,
              ),
            })
          : engine === 'workgroup-turns'
            ? await opts.workgroupTurns.drive({
                taskId,
                log,
                ...(opts.signal ? { signal: opts.signal } : {}),
                host: buildNodeExecutionWorkgroupHooks(
                  state,
                  runtimeComponents.wrapperRuntimeFactory,
                ),
              })
            : await runScope(
                state,
                {
                  scopeId: null,
                  scopeIds: topLevelIds,
                  containerRunId: null,
                  iteration: 0,
                  log,
                },
                runtimeComponents.wrapperRuntimeFactory,
              )
    } else {
      const {
        taskId: _taskId,
        executionContext: _executionContext,
        signal: _signal,
        codeHostConnections: _codeHostConnections,
        codeHostFetch: _codeHostFetch,
        repositoryPublicationTransport: _repositoryPublicationTransport,
        ...runtimeOptions
      } = opts
      result = await registry.resolve(engine).drive({
        task: {
          taskId,
          workgroupId: task.workgroupId,
          workgroupConfigJson: task.workgroupConfigJson,
          dynamicWorkflowPhase,
        },
        execution: opts.executionContext,
        signal: opts.signal ?? new AbortController().signal,
        runtime: resolveTaskDriveConfig(runtimeOptions),
      })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('runTask: scope threw — failing task', { taskId, error: message })
    await failRuntimeTask(opts, 'scheduler error', message)
    return
  }

  if (result.kind === 'handoff') {
    log.info('task drive handed off to a pending human-gate continuation', { taskId })
    return
  }

  // RFC-248 AC-19（实现门 P1）：只读成员的脏检查必须在**每一条终态路径**上都
  // 跑一次，而不是搭在自动提交推送里——`maybeRunCommitPush` 只在
  // `task.autoCommitPush` 开启且顶层节点成功后触发，于是默认配置的任务、以及
  // 失败 / 取消的任务，`readonly_dirty_count` 永远是 NULL、详情页永远没有提示。
  // 放在这里：跑完节点、分派终态之前，done / failed / canceled / awaiting_* 全覆盖。
  //
  // 包 try/catch：这只是一条给人看的通报，绝不能因为它把任务收尾搞垮。
  try {
    await inspectReadonlyRepos(state, log)
  } catch (err) {
    log.warn('[rfc248/readonly-dirty] inspection failed (ignored)', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // A question can arrive after the frontier's last read. Consume the
  // obligation at the owner-held settle point before choosing any outcome.
  // Explicit cancellation keeps its existing precedence.
  if (result.kind !== 'canceled' && opts.signal?.aborted !== true) {
    const manualPark = await opts.persistence.humanGateLifecycle.settleManualQuestionParks({
      taskId,
      ...(opts.executionContext === undefined ? {} : { token: opts.executionContext.token }),
      now: Date.now(),
    })
    if (manualPark.parked) {
      log.info('task parked for a durable manual question at settle', { taskId })
      return
    }
  }

  if (result.kind === 'failed' && result.detail) {
    await failRuntimeTask(opts, result.detail.summary, result.detail.message, result.detail.nodeId)
    return
  }
  if (result.kind === 'canceled') {
    await cancelRuntimeTask(opts, result.detail?.nodeId, opts.signal?.reason)
    return
  }
  if (result.kind === 'awaiting_review') {
    // RFC-005: task pauses with status=awaiting_review until a decision lands
    // via REST. Decision handler will call resumeTask which re-enters here.
    // RFC-097: cancel wins — an abort that landed after runScope's last
    // signal check must not be overwritten by a park/terminal write.
    if (opts.signal?.aborted === true) {
      await cancelRuntimeTask(opts, undefined, opts.signal.reason)
      return
    }
    let parkedForReview = false
    while (true) {
      let manualQuestionPending = false
      const statusBeforeReviewPark = await opts.persistence.drive.findStatus(taskId)
      if (statusBeforeReviewPark === 'awaiting_human') {
        // RFC-333 parks a clarify as soon as its projection commits. If the
        // answer lands while this exact driver is still attached, the live
        // scope can consume the rerun and reach a later review gate without
        // resumeTask ever owning a second driver. Restore the canonical
        // running state before parking the new gate; otherwise workgroup
        // completion can be awaiting_confirmation forever while the task row
        // remains awaiting_human. This mirrors the done-settle path below.
        const unparked = await opts.persistence.humanGateLifecycle.trySetWhenNoManualQuestionParks({
          taskId,
          to: 'running',
          allowedFrom: ['awaiting_human'],
          ...(opts.executionContext !== undefined
            ? { executionContext: opts.executionContext }
            : {}),
          now: Date.now(),
          reason: 'active-clarify-released-before-review',
        })
        manualQuestionPending = unparked.kind === 'manual-question-pending'
      }
      if (!manualQuestionPending) {
        const parked = await opts.persistence.humanGateLifecycle.trySetWhenNoManualQuestionParks({
          taskId,
          to: 'awaiting_review',
          allowedFrom: ['running'],
          ...(opts.executionContext !== undefined
            ? { executionContext: opts.executionContext }
            : {}),
          now: Date.now(),
          reason: 'scope-awaiting-review',
        })
        manualQuestionPending = parked.kind === 'manual-question-pending'
        if (parked.kind === 'settled') parkedForReview = parked.won
      }
      if (!manualQuestionPending) {
        break
      }
      const manualPark = await opts.persistence.humanGateLifecycle.settleManualQuestionParks({
        taskId,
        ...(opts.executionContext === undefined ? {} : { token: opts.executionContext.token }),
        now: Date.now(),
      })
      if (manualPark.parked) {
        log.info('task review outcome yielded to a durable manual question', { taskId })
        return
      }
    }
    if (parkedForReview) {
      log.info('task awaiting human review', { taskId })
    } else {
      const parked = await opts.persistence.drive.findStatus(taskId)
      if (parked === 'awaiting_review') {
        // RFC-333: the review executor already committed TaskParkTx together
        // with the gate projection. Publish that committed status; do not issue
        // a second lifecycle write.
        log.info('task review gate already parked atomically', { taskId })
      } else {
        log.warn('awaiting_review write lost to a concurrent transition — respecting winner', {
          taskId,
        })
      }
    }
    return
  }
  if (result.kind === 'awaiting_human') {
    // RFC-023: an agent (or one or more agent-multi shard children) emitted a
    // <workflow-clarify> envelope. The clarify node_run is parked
    // awaiting_human; the source agent has no rerun row yet — that's
    // created when the user POSTs answers. Per design §7.3 awaiting_human
    // outranks awaiting_review on the task chip when both can fire at once.
    if (opts.signal?.aborted === true) {
      await cancelRuntimeTask(opts, undefined, opts.signal.reason)
      return
    }
    if (
      await opts.persistence.runtimeLifecycle.trySet({
        taskId,
        to: 'awaiting_human',
        allowedFrom: ['running'],
        ...(opts.executionContext !== undefined ? { executionContext: opts.executionContext } : {}),
        now: Date.now(),
        reason: 'scope-awaiting-human',
      })
    ) {
      log.info('task awaiting human clarification', { taskId })
    } else {
      const parked = await opts.persistence.drive.findStatus(taskId)
      if (parked === 'awaiting_human') {
        // RFC-333 T7: clarify creation already committed the node, round,
        // eager question snapshots and task park in one TaskParkTx.
        log.info('task clarify gate already parked atomically', { taskId })
      } else {
        log.warn('awaiting_human write lost to a concurrent transition — respecting winner', {
          taskId,
        })
      }
    }
    return
  }

  // 9. Done. RFC-097: cancel wins — final aborted check before the terminal
  // CAS; a cancelTask fallback racing us resolves by whoever's CAS lands
  // (from-sets are disjoint winners: done from=running vs canceled CAS).
  if (opts.signal?.aborted === true) {
    await cancelRuntimeTask(opts, undefined, opts.signal.reason)
    return
  }
  let completed = false
  while (true) {
    let manualQuestionPending = false
    const statusBeforeCompletion = await opts.persistence.drive.findStatus(taskId)
    if (
      statusBeforeCompletion === 'awaiting_review' ||
      statusBeforeCompletion === 'awaiting_human'
    ) {
      // A human decision can land while this exact driver is still attached.
      // resumeTask correctly refuses to attach a second driver in that
      // window; after this scope consumes the released rerun and derives
      // `done`, first apply the canonical unpark edge, then complete from
      // running. The scope outcome proves no review/clarify gate remains,
      // and the in-tx manual-question assertion closes the external
      // late-arrival path.
      const unparked = await opts.persistence.humanGateLifecycle.trySetWhenNoManualQuestionParks({
        taskId,
        to: 'running',
        allowedFrom: ['awaiting_review', 'awaiting_human'],
        ...(opts.executionContext !== undefined ? { executionContext: opts.executionContext } : {}),
        now: Date.now(),
        reason: 'active-human-gate-released-before-complete',
      })
      manualQuestionPending = unparked.kind === 'manual-question-pending'
    }
    if (!manualQuestionPending) {
      const settled = await opts.persistence.humanGateLifecycle.trySetWhenNoManualQuestionParks({
        taskId,
        to: 'done',
        allowedFrom: ['running'],
        extra: { finishedAt: Date.now() },
        ...(opts.executionContext !== undefined ? { executionContext: opts.executionContext } : {}),
        now: Date.now(),
        reason: 'task-done',
      })
      manualQuestionPending = settled.kind === 'manual-question-pending'
      if (settled.kind === 'settled') completed = settled.won
    }
    if (!manualQuestionPending) {
      break
    }
    const manualPark = await opts.persistence.humanGateLifecycle.settleManualQuestionParks({
      taskId,
      ...(opts.executionContext === undefined ? {} : { token: opts.executionContext.token }),
      now: Date.now(),
    })
    if (manualPark.parked) {
      log.info('task completion yielded to a durable manual question', { taskId })
      return
    }
    // The row was dispatched/confirmed between creation and settle. Its
    // obligation is now completed; retry the terminal CAS with the same
    // business outcome and a fresh in-transaction no-obligation check.
  }
  if (completed) {
    log.info('task done', { taskId })
  } else {
    log.warn('done write lost to a concurrent transition — respecting winner', { taskId })
  }
}
