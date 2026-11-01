import {
  NODE_KIND_BEHAVIORS,
  WorkflowDefinitionSchema,
  DwStateSchema,
  exclusionPlanFor,
  migrateWorkflowDefinitionToLatest,
  parseTriggerContextJson,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import type { TaskRunPorts } from '../../application/ports/taskRun'
import { assertTaskExecutionContext } from '../../application/taskExecutionContext'
import {
  createExecutionScopeIndex,
  InvalidExecutionScopeError,
  type ExecutionScopeIndex,
} from '../../domain/executionScope'
import { DW_ORCHESTRATOR_NODE_ID } from '../../domain/dynamicWorkflowOrchestrator'
import { exactOwnerMatches } from '../../domain/ownership'
import { taskEngineOutcomeFromScope, type TaskScopeOutcome } from '../../domain/taskEngine'
import { buildScopeUpstreams, findScopeCycle } from '../scope/dagGraph'
import { DagTaskEngine } from './dag/dagTaskEngine'
import { DynamicWorkflowTaskEngine } from './dynamicWorkflowTaskEngine'
import { ClosedTaskEngineRegistry, resolveTaskEngineSelection } from './taskEngineRegistry'
import { failTaskRun, settleTaskScopeOutcome } from './taskSettlement'
import { WorkgroupTaskEngine } from './workgroupTaskEngine'

/**
 * RFC-408 — the task control plane (design §5.2): load and fence the task, admit its execution
 * authority, rebuild workspace profiles, parse and preflight the snapshot, claim it, validate the
 * graph, drive the selected engine and settle the outcome. Moved verbatim from
 * composition/taskEngineApplication.ts; the composition assembles the execution state through
 * `ports.prepare` and binds every other capability.
 */
export async function runTask<Admission>(ports: TaskRunPorts<Admission>): Promise<void> {
  const { log, taskId } = ports

  // 1. Load one provider-owned task/repository snapshot.
  const driveSnapshot = await ports.persistence.drive.load(taskId)
  if (driveSnapshot === null) {
    log.error('runTask: task not found', { taskId })
    return
  }
  const { task, repositories: repoRows, collaborators } = driveSnapshot

  const durableOwner = await ports.persistence.ownership.read(taskId)
  if (ports.execution !== undefined) {
    assertTaskExecutionContext(ports.execution, taskId)
    if (durableOwner === null || !exactOwnerMatches(durableOwner, ports.execution.token)) {
      log.warn('runTask: durable owner no longer matches execution context', { taskId })
      return
    }
  } else if (durableOwner?.state === 'claimed') {
    // A production-owned task may never fall back to the pre-RFC-328 status
    // claim. Ownerless direct fixtures keep their historical test seam.
    log.error('runTask: durable owner requires exact execution context', { taskId })
    return
  }

  // The binding admits the owner's execution authority and opens the task resource session.
  const admission = await ports.admission.admit({
    ownerUserId: task.ownerUserId,
    taskId,
  })
  if (admission === null) {
    await failTaskRun(
      ports,
      'task execution authority unavailable',
      'task-execution-owner-inactive',
    )
    return
  }

  const repos = ports.workspace.project(task, repoRows)

  // RFC-308: resume/retry/recovery never trust a profile left by the prior
  // process or by an agent. Rebuild the exact per-worktree profile before any
  // runner can observe or mutate the workspace.
  if (
    repoRows.length > 0 &&
    (ports.workspace.ensureProfiles ||
      repoRows.some(
        (row) => row.workspaceProfileVersion !== 1 || row.workspaceProfileDigest === null,
      ))
  ) {
    try {
      const allMounts = repos.map((repo) => repo.mountPath)
      for (const repo of repos) {
        const receipt = await ports.workspace.ensureExcludeProfile({
          workspaceRef: repo.worktreePath,
          directChildMounts: exclusionPlanFor(repo.mountPath, allMounts),
        })
        const updated = await ports.persistence.drive.updateWorkspaceProfile({
          taskId,
          repoIndex: repo.ordinal,
          version: receipt.version,
          digest: receipt.digest,
          ...(ports.execution === undefined ? {} : { executionContext: ports.execution }),
          now: Date.now(),
        })
        if (!updated) throw new Error(`task-repository-not-found:${taskId}:${repo.ordinal}`)
      }
    } catch (error) {
      await failTaskRun(
        ports,
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
    await failTaskRun(ports, 'snapshot-invalid', (err as Error).message)
    return
  }

  // RFC-292: keep NULL, valid context and corrupt JSON distinct. Historical
  // flat RFC-269 rows are wrapped in memory by the shared decoder.
  const parsedTriggerContext = parseTriggerContextJson(task.triggerContextJson)
  const triggerIssue = ports.rules.triggerPreflightIssue({
    root: definition,
    closureJson: task.refClosureJson,
    source: parsedTriggerContext,
  })
  if (triggerIssue !== null) {
    await failTaskRun(ports, triggerIssue.code, triggerIssue.code)
    return
  }
  const triggerContext = parsedTriggerContext.kind === 'ok' ? parsedTriggerContext.value : null

  // 3. Mark running — CAS from 'pending' ONLY (RFC-097, audit S-8/S-14).
  // The unconditional write here used to revive canceled/done tasks and let a
  // second runTask take over a live one. CAS loss → another driver owns the
  // task (or it is terminal): log and step away without minting anything.
  const claimed = await ports.persistence.runtimeLifecycle.trySet({
    taskId,
    to: 'running',
    allowedFrom: ['pending'],
    ...(ports.execution !== undefined ? { executionContext: ports.execution } : {}),
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
  const initialManualPark = await ports.persistence.humanGateLifecycle.settleManualQuestionParks({
    taskId,
    ...(ports.execution === undefined ? {} : { token: ports.execution.token }),
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
      await failTaskRun(
        ports,
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
    await failTaskRun(
      ports,
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
    await failTaskRun(
      ports,
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
    await failTaskRun(ports, 'workflow has a cycle outside any loop wrapper', 'cycle detected')
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

  // RFC-408: the binding assembles the execution state (pools, write lock, wrapper scopes, scope
  // driver) from these facts; the control plane keeps only the drive it hands back.
  const drive = ports.prepare({
    task,
    collaborators,
    admission,
    definition,
    repos,
    triggerContext,
    inputsMap,
    scopeIndex,
    containerOf,
    topLevelIds,
  })

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
    await drive.recoverBeforeScope()
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
      task.subject.kind === 'workgroup' && ports.dynamicWorkflow !== undefined
        ? await ports.dynamicWorkflow.loadTask(taskId)
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
    if (
      wgDispatch === 'dw-execute' &&
      definition.nodes.some((n) => n.id === DW_ORCHESTRATOR_NODE_ID)
    ) {
      // Fail-fast invariant (design §3): phase='executing' promises the
      // snapshot is the confirmed generated DAG. Running the generation host
      // snapshot through runScope would dispatch the orchestrator node as a
      // regular agent — refuse loudly instead.
      await failTaskRun(
        ports,
        'dw-phase-invariant',
        `task is phase='executing' but its snapshot still contains the generation host node`,
      )
      return
    }
    const registry = new ClosedTaskEngineRegistry({
      dag: new DagTaskEngine({
        driveTopLevel: async () => taskEngineOutcomeFromScope(await drive.bodies.dag()),
      }),
      'workgroup-turns': new WorkgroupTaskEngine({
        driveTurns: async () => taskEngineOutcomeFromScope(await drive.bodies['workgroup-turns']()),
      }),
      'dw-generate': new DynamicWorkflowTaskEngine({
        generate: async () => taskEngineOutcomeFromScope(await drive.bodies['dw-generate']()),
      }),
    })
    if (ports.execution === undefined) {
      // Legacy ownerless fixtures retain their direct scheduler seam until the
      // test application is fully migrated to the RFC-332 coordinator.
      result = await drive.bodies[engine]()
    } else {
      result = await registry.resolve(engine).drive({
        task: {
          taskId,
          workgroupId: task.workgroupId,
          workgroupConfig: task.workgroupConfig,
          dynamicWorkflowPhase,
        },
        execution: ports.execution,
        signal: ports.signal ?? new AbortController().signal,
        runtime: drive.runtimeConfig(),
      })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error('runTask: scope threw — failing task', { taskId, error: message })
    await failTaskRun(ports, 'scheduler error', message)
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
    await drive.inspectReadonlyRepos()
  } catch (err) {
    log.warn('[rfc248/readonly-dirty] inspection failed (ignored)', {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  await settleTaskScopeOutcome(ports, result)
}
