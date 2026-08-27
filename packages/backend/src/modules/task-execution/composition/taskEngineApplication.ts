import {
  NODE_KIND_BEHAVIORS,
  WorkflowDefinitionSchema,
  analyzeWorkflowScopeTree,
  exclusionPlanFor,
  isWorkgroupTask,
  migrateWorkflowDefinitionToLatest,
  parseTriggerContextJson,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { and, asc, eq } from 'drizzle-orm'
import { taskRepos, tasks } from '@/db/schema'
import { bindWorkspaceExcludeParticipant } from '@/modules/source-control/composition'
import { resolveTaskDriveConfig } from '../application/drive/taskDriveTypes'
import type { RunTaskOptions } from '@/services/execution/taskEngineRuntimeOptions'
import { taskEngineOutcomeFromScope, type TaskScopeOutcome } from '../domain/taskEngine'
import { DagTaskEngine } from '../engine/task/dag/dagTaskEngine'
import { DynamicWorkflowTaskEngine } from '../engine/task/dynamicWorkflowTaskEngine'
import {
  ClosedTaskEngineRegistry,
  resolveTaskEngineSelection,
} from '../engine/task/taskEngineRegistry'
import { WorkgroupTaskEngine } from '../engine/task/workgroupTaskEngine'
import {
  buildWorkgroupHooks,
  cancelTaskRow,
  emitStatus,
  failTask,
  inspectReadonlyRepos,
  replayConflictHumanResolutions,
  replayPendingMerges,
} from '@/services/scheduler'
import { runScope } from './taskDagScope'
import { buildScopeUpstreams, findScopeCycle } from './taskDagGraph'
import type { LegacyTaskMechanicsState } from '@/services/execution/taskMechanicsState'
import { runDynamicWorkflowGenerate } from '@/services/dynamicWorkflowRunner'
import { triggerPreflightIssue } from '@/services/execution/triggerPreflight'
import { trySetTaskStatus } from '@/services/lifecycle'
import { getNodePoolSemaphore } from '@/services/processNodeConcurrency'
import { getTaskFanoutSem, gcTaskFanoutSem } from '@/services/taskFanoutPools'
import {
  assertTaskExecutionContext,
  exactOwnerMatches,
  runWithTaskExecutionContext,
  taskExecutionModule,
  withTaskExecutionMutation,
} from '@/services/taskExecutionParticipants'
import { getTaskWriteSem, gcTaskWriteSem } from '@/services/taskWriteLocks'
import { runWorkgroupEngine } from '@/services/workgroup/engine'
import { loadWorkgroupTaskState } from '@/services/workgroup/state'
import { DW_ORCHESTRATOR_NODE_ID } from '@/services/orchestratorAgent'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'
import type { SchedulerRuntimeTopology } from '@/modules/task-execution/public/topology'
import type { HumanGateOpenParticipant } from '../application/ports/humanGateOpenParticipant'
import {
  ManualQuestionParkRequired,
  assertNoManualQuestionParkObligationTx,
  settleManualQuestionParkObligations,
} from './humanGate'

export async function driveTaskEngineApplication(
  opts: RunTaskOptions,
  topology: SchedulerRuntimeTopology,
  humanGates: HumanGateOpenParticipant,
): Promise<void> {
  // RFC-098 B1: the per-task write-lock registry entry is gc'd here and ONLY
  // here (taskWriteLocks.ts lifecycle — an HTTP-side gc would split-brain the
  // mutex against our cached legacy mechanics writeSem reference).
  // RFC-266: the fan-out sub-pool registry entry follows the SAME rule and the
  // same reasoning (a split pool would run a task at double its configured
  // shard concurrency), so it is reclaimed in this one place too.
  try {
    if (opts.executionContext === undefined) {
      await runTaskEngineOrchestratorInner(opts, topology, humanGates)
    } else {
      await runWithTaskExecutionContext(opts.executionContext, () =>
        runTaskEngineOrchestratorInner(opts, topology, humanGates),
      )
    }
  } finally {
    gcTaskWriteSem(opts.taskId)
    gcTaskFanoutSem(opts.taskId)
  }
}

async function runTaskEngineOrchestratorInner(
  opts: RunTaskOptions,
  topology: SchedulerRuntimeTopology,
  humanGates: HumanGateOpenParticipant,
): Promise<void> {
  const log = opts.log ?? createLogger('scheduler')
  const { db, taskId } = opts

  // 1. Load task row.
  const taskRows = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  const task = taskRows[0]
  if (!task) {
    log.error('runTask: task not found', { taskId })
    return
  }

  const durableOwner = taskExecutionModule.ownership.read(db, taskId)
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

  // RFC-066 PR-B T9: load per-repo metadata once at the top so every runner
  // dispatch site can thread it through `templateMeta.repos` without an extra
  // round-trip. Single-repo tasks get a length-1 array mirroring the legacy
  // `tasks.*` columns (`worktreeDirName === ''` → `{{__repo_names__}}`
  // renders empty, byte-baseline). Defensive fallback handles the ultra-rare
  // case of a task row predating migration 0034's INSERT FROM backfill.
  const repoRows = await db
    .select()
    .from(taskRepos)
    .where(eq(taskRepos.taskId, taskId))
    .orderBy(asc(taskRepos.repoIndex))
  const repos: LegacyTaskMechanicsState['repos'] =
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
        withTaskExecutionMutation({
          db,
          taskId,
          run: (tx) =>
            tx
              .update(taskRepos)
              .set({
                workspaceProfileVersion: receipt.version,
                workspaceProfileDigest: receipt.digest,
              })
              .where(and(eq(taskRepos.taskId, taskId), eq(taskRepos.repoIndex, repo.repoIndex)))
              .run(),
        })
      }
    } catch (error) {
      await failTask(
        topology,
        db,
        taskId,
        'workspace-exclude-profile-failed',
        error instanceof Error ? error.message : String(error),
        undefined,
        opts.executionContext,
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
    await failTask(
      topology,
      db,
      taskId,
      'snapshot-invalid',
      (err as Error).message,
      undefined,
      opts.executionContext,
    )
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
    await failTask(
      topology,
      db,
      taskId,
      triggerIssue.code,
      triggerIssue.code,
      undefined,
      opts.executionContext,
    )
    return
  }
  const triggerContext = parsedTriggerContext.kind === 'ok' ? parsedTriggerContext.value : null

  // 3. Mark running — CAS from 'pending' ONLY (RFC-097, audit S-8/S-14).
  // The unconditional write here used to revive canceled/done tasks and let a
  // second runTask take over a live one. CAS loss → another driver owns the
  // task (or it is terminal): log and step away without minting anything.
  const claimed = await trySetTaskStatus({
    db,
    taskId,
    to: 'running',
    allowedFrom: ['pending'],
    ...(opts.executionContext !== undefined ? { executionContext: opts.executionContext } : {}),
    reason: 'runTask-start',
  })
  if (!claimed) {
    log.warn('runTask: task not claimable (not pending) — refusing to drive it', { taskId })
    return
  }
  await emitStatus(topology, taskId)

  // RFC-333 T7: a manual question may have been created while this task was
  // pending/failed/interrupted. The exact owner consumes its durable park
  // obligation immediately after claim, before any new node work can start.
  const initialManualPark = settleManualQuestionParkObligations({
    db,
    humanGates,
    taskId,
    ...(opts.executionContext === undefined ? {} : { executionContext: opts.executionContext }),
  })
  if (initialManualPark.parked) {
    await emitStatus(topology, taskId)
    log.info('task parked for a durable manual question before drive', { taskId })
    return
  }

  // 4. Validate node kinds. RFC-146: positive membership in the behavior
  // table — a kind the scheduler knows is exactly a kind with a behavior row.
  // (The historical negative enum listed 6 `!==` clauses and silently
  // admitted nothing new; now adding a NodeKind admits it here by
  // construction, and runOneNode's fall-through guard catches kinds the
  // dispatch switch doesn't actually handle yet.)
  for (const node of definition.nodes) {
    // Object.hasOwn (not `in`) — inherited keys must not pass the whitelist.
    if (!Object.hasOwn(NODE_KIND_BEHAVIORS, node.kind)) {
      await failTask(
        topology,
        db,
        taskId,
        `scheduler does not yet support ${node.kind} nodes`,
        `node kind ${node.kind} unsupported`,
        node.id,
        opts.executionContext,
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
    await failTask(
      topology,
      db,
      taskId,
      'workflow-node-id-duplicate',
      `node id '${nodeId}' appears ${count} times; node ids must be unique`,
      nodeId,
      opts.executionContext,
    )
    return
  }

  // Wrapper containment is the coordinate system for recursive scheduling.
  // Launch validation normally guarantees a tree, but imported/historical
  // snapshots and direct DB callers can bypass it. Never execute against the
  // deterministic diagnostic fallback map when membership is ambiguous:
  // two wrappers could otherwise dispatch the same child concurrently.
  const scopeTree = analyzeWorkflowScopeTree(definition)
  const containmentIssue = scopeTree.issues[0]
  if (containmentIssue !== undefined) {
    const failedNodeId =
      containmentIssue.code === 'wrapper-containment-cycle'
        ? containmentIssue.cycle[0]
        : containmentIssue.code === 'wrapper-child-multiple-parents'
          ? containmentIssue.childId
          : containmentIssue.wrapperId
    await failTask(
      topology,
      db,
      taskId,
      'wrapper-containment-invalid',
      `${containmentIssue.code}: ${JSON.stringify(containmentIssue)}`,
      failedNodeId,
      opts.executionContext,
    )
    return
  }

  // RFC-248 D9: 多仓 + wrapper-git 的禁令**已解除**。RFC-066 当年禁它是因为
  // 包裹器只会对单一 worktree 取快照；现在它逐仓快照、逐仓 diff，并把每个仓的
  // 路径用挂载路径前缀化后合并成一个 `list<path>`（见 runGitWrapperNode）。
  // 这里原本有一条 `multi-repo-wrapper-git-unsupported` 的纵深防御门，随禁令
  // 一并删除——留着它会让组任务永远跑不了平台的 Code → Audit → Fix 主链路。

  // 5. Direct child → wrapper map. Chained entries retain nested scope ancestry.
  const containerOf = scopeTree.parents
  const topLevelIds = new Set<string>()
  for (const n of definition.nodes) {
    if (!containerOf.has(n.id)) topLevelIds.add(n.id)
  }

  // 6. Pre-validate the same projected graph the runtime frontier will use.
  //    Raw-edge filtering misses cycles that cross a wrapper boundary.
  const topLevelNodes = definition.nodes.filter((n) => topLevelIds.has(n.id))
  const topLevelUpstreams = buildScopeUpstreams(definition, topLevelIds, null, containerOf)
  if (findScopeCycle(topLevelNodes, topLevelUpstreams) !== null) {
    await failTask(
      topology,
      db,
      taskId,
      'workflow has a cycle outside any loop wrapper',
      'cycle detected',
      undefined,
      opts.executionContext,
    )
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

  const state: LegacyTaskMechanicsState = {
    db,
    task,
    taskId,
    definition,
    opts,
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
    agentSem: getNodePoolSemaphore(db, 'agent', opts.maxConcurrentNodes ?? 4, 'seed-only'),
    scriptSem: getNodePoolSemaphore(db, 'script', opts.maxConcurrentScriptNodes ?? 4, 'seed-only'),
    // RFC-269: the third pool — one outbound HTTP request is a second-scale
    // step and holds no subprocess, so it gets its own (larger) budget.
    codeHostSem: getNodePoolSemaphore(
      db,
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
    driveScope: runScope,
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
    await replayPendingMerges(state, log)
    // RFC-130 §6.3 resume: complete any conflict-human node whose human resolved
    // its conflict in the preserved resolve-iso (flips 'merged' + releases
    // downstream; still-unresolved stays parked). No-op on a fresh run.
    await replayConflictHumanResolutions(state, log)
    // RFC-164: workgroup tasks are driven by the round engine, NEVER by the
    // DAG frontier (design §4). The host snapshot's nodes exist only as mint
    // anchors + clarify wiring; runScope/deriveFrontier must not see them.
    // RFC-167: dynamic_workflow workgroups are the exception — their dispatch
    // follows the dw phase. RFC-243 §1.2: the decision itself now lives in
    // the executor engine registry (resolveTaskEngine — same oracle, extracted
    // verbatim); this file keeps consuming it. RFC-217 T2: the phase lives in
    // workgroup_task_state (an unknown mode still routes to the turn engine,
    // which fails with its own precise config diagnostics).
    const dynamicWorkflowPhase = isWorkgroupTask(task)
      ? ((await loadWorkgroupTaskState(db, taskId)).dwState?.phase ?? null)
      : null
    const { engine, wgDispatch } = resolveTaskEngineSelection(task, dynamicWorkflowPhase)
    if (
      wgDispatch === 'dw-execute' &&
      definition.nodes.some((n) => n.id === DW_ORCHESTRATOR_NODE_ID)
    ) {
      // Fail-fast invariant (design §3): phase='executing' promises the
      // snapshot is the confirmed generated DAG. Running the generation host
      // snapshot through runScope would dispatch the orchestrator node as a
      // regular agent — refuse loudly instead.
      await failTask(
        topology,
        db,
        taskId,
        'dw-phase-invariant',
        `task is phase='executing' but its snapshot still contains the generation host node`,
        undefined,
        opts.executionContext,
      )
      return
    }
    const registry = new ClosedTaskEngineRegistry({
      dag: new DagTaskEngine({
        driveTopLevel: async () =>
          taskEngineOutcomeFromScope(
            await runScope(state, {
              scopeId: null,
              scopeIds: topLevelIds,
              iteration: 0,
              log,
            }),
          ),
      }),
      'workgroup-turns': new WorkgroupTaskEngine({
        driveTurns: async () =>
          taskEngineOutcomeFromScope(
            await runWorkgroupEngine({
              db,
              taskId,
              log,
              ...(opts.signal ? { signal: opts.signal } : {}),
              hooks: buildWorkgroupHooks(state),
            }),
          ),
      }),
      'dw-generate': new DynamicWorkflowTaskEngine({
        generate: async () =>
          taskEngineOutcomeFromScope(
            await runDynamicWorkflowGenerate({
              db,
              taskId,
              log,
              ...(opts.signal ? { signal: opts.signal } : {}),
              hooks: buildWorkgroupHooks(state),
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
              db,
              taskId,
              log,
              ...(opts.signal ? { signal: opts.signal } : {}),
              hooks: buildWorkgroupHooks(state),
            })
          : engine === 'workgroup-turns'
            ? await runWorkgroupEngine({
                db,
                taskId,
                log,
                ...(opts.signal ? { signal: opts.signal } : {}),
                hooks: buildWorkgroupHooks(state),
              })
            : await runScope(state, {
                scopeId: null,
                scopeIds: topLevelIds,
                iteration: 0,
                log,
              })
    } else {
      const {
        taskId: _taskId,
        db: _db,
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
    await failTask(
      topology,
      db,
      taskId,
      'scheduler error',
      message,
      undefined,
      opts.executionContext,
    )
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
    const manualPark = settleManualQuestionParkObligations({
      db,
      humanGates,
      taskId,
      ...(opts.executionContext === undefined ? {} : { executionContext: opts.executionContext }),
    })
    if (manualPark.parked) {
      await emitStatus(topology, taskId)
      log.info('task parked for a durable manual question at settle', { taskId })
      return
    }
  }

  if (result.kind === 'failed' && result.detail) {
    await failTask(
      topology,
      db,
      taskId,
      result.detail.summary,
      result.detail.message,
      result.detail.nodeId,
      opts.executionContext,
    )
    return
  }
  if (result.kind === 'canceled') {
    await cancelTaskRow(
      topology,
      db,
      taskId,
      result.detail?.nodeId,
      opts.signal?.reason,
      opts.executionContext,
    )
    return
  }
  if (result.kind === 'awaiting_review') {
    // RFC-005: task pauses with status=awaiting_review until a decision lands
    // via REST. Decision handler will call resumeTask which re-enters here.
    // RFC-097: cancel wins — an abort that landed after runScope's last
    // signal check must not be overwritten by a park/terminal write.
    if (opts.signal?.aborted === true) {
      await cancelTaskRow(
        topology,
        db,
        taskId,
        undefined,
        opts.signal.reason,
        opts.executionContext,
      )
      return
    }
    let parkedForReview = false
    while (true) {
      try {
        const statusBeforeReviewPark = db
          .select({ status: tasks.status })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .get()?.status
        if (statusBeforeReviewPark === 'awaiting_human') {
          // RFC-333 parks a clarify as soon as its projection commits. If the
          // answer lands while this exact driver is still attached, the live
          // scope can consume the rerun and reach a later review gate without
          // resumeTask ever owning a second driver. Restore the canonical
          // running state before parking the new gate; otherwise workgroup
          // completion can be awaiting_confirmation forever while the task row
          // remains awaiting_human. This mirrors the done-settle path below.
          const unparked = await trySetTaskStatus({
            db,
            taskId,
            to: 'running',
            allowedFrom: ['awaiting_human'],
            onTransitionTx: (tx) => assertNoManualQuestionParkObligationTx(tx, taskId, humanGates),
            ...(opts.executionContext !== undefined
              ? { executionContext: opts.executionContext }
              : {}),
            reason: 'active-clarify-released-before-review',
          })
          if (unparked) await emitStatus(topology, taskId)
        }
        parkedForReview = await trySetTaskStatus({
          db,
          taskId,
          to: 'awaiting_review',
          allowedFrom: ['running'],
          onTransitionTx: (tx) => assertNoManualQuestionParkObligationTx(tx, taskId, humanGates),
          ...(opts.executionContext !== undefined
            ? { executionContext: opts.executionContext }
            : {}),
          reason: 'scope-awaiting-review',
        })
        break
      } catch (error) {
        if (!(error instanceof ManualQuestionParkRequired)) throw error
        const manualPark = settleManualQuestionParkObligations({
          db,
          humanGates,
          taskId,
          ...(opts.executionContext === undefined
            ? {}
            : { executionContext: opts.executionContext }),
        })
        if (manualPark.parked) {
          await emitStatus(topology, taskId)
          log.info('task review outcome yielded to a durable manual question', { taskId })
          return
        }
      }
    }
    if (parkedForReview) {
      await emitStatus(topology, taskId)
      log.info('task awaiting human review', { taskId })
    } else {
      const parked = db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .get()
      if (parked?.status === 'awaiting_review') {
        // RFC-333: the review executor already committed TaskParkTx together
        // with the gate projection. Publish that committed status; do not issue
        // a second lifecycle write.
        await emitStatus(topology, taskId)
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
      await cancelTaskRow(
        topology,
        db,
        taskId,
        undefined,
        opts.signal.reason,
        opts.executionContext,
      )
      return
    }
    if (
      await trySetTaskStatus({
        db,
        taskId,
        to: 'awaiting_human',
        allowedFrom: ['running'],
        ...(opts.executionContext !== undefined ? { executionContext: opts.executionContext } : {}),
        reason: 'scope-awaiting-human',
      })
    ) {
      await emitStatus(topology, taskId)
      log.info('task awaiting human clarification', { taskId })
    } else {
      const parked = db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .get()
      if (parked?.status === 'awaiting_human') {
        // RFC-333 T7: clarify creation already committed the node, round,
        // eager question snapshots and task park in one TaskParkTx.
        await emitStatus(topology, taskId)
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
    await cancelTaskRow(topology, db, taskId, undefined, opts.signal.reason, opts.executionContext)
    return
  }
  let completed = false
  while (true) {
    try {
      const statusBeforeCompletion = db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .get()?.status
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
        const unparked = await trySetTaskStatus({
          db,
          taskId,
          to: 'running',
          allowedFrom: ['awaiting_review', 'awaiting_human'],
          onTransitionTx: (tx) => assertNoManualQuestionParkObligationTx(tx, taskId, humanGates),
          ...(opts.executionContext !== undefined
            ? { executionContext: opts.executionContext }
            : {}),
          reason: 'active-human-gate-released-before-complete',
        })
        if (unparked) await emitStatus(topology, taskId)
      }
      completed = await trySetTaskStatus({
        db,
        taskId,
        to: 'done',
        allowedFrom: ['running'],
        extra: { finishedAt: Date.now() },
        onTransitionTx: (tx) => assertNoManualQuestionParkObligationTx(tx, taskId, humanGates),
        ...(opts.executionContext !== undefined ? { executionContext: opts.executionContext } : {}),
        reason: 'task-done',
      })
      break
    } catch (error) {
      if (!(error instanceof ManualQuestionParkRequired)) throw error
      const manualPark = settleManualQuestionParkObligations({
        db,
        humanGates,
        taskId,
        ...(opts.executionContext === undefined ? {} : { executionContext: opts.executionContext }),
      })
      if (manualPark.parked) {
        await emitStatus(topology, taskId)
        log.info('task completion yielded to a durable manual question', { taskId })
        return
      }
      // The row was dispatched/confirmed between creation and settle. Its
      // obligation is now completed; retry the terminal CAS with the same
      // business outcome and a fresh in-transaction no-obligation check.
    }
  }
  if (completed) {
    await emitStatus(topology, taskId)
    log.info('task done', { taskId })
  } else {
    log.warn('done write lost to a concurrent transition — respecting winner', { taskId })
  }
}
