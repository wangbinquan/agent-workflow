import {
  isSingleRootRepository,
  renderCallWorkgroupGoalTemplate,
  type StartTask,
  type TriggerContext,
  type WorkflowNode,
} from '@agent-workflow/shared'
import type { IsoHandle } from '@/platform/contracts/isolationWorkspace'
import type {
  ChildCallFrozenWorkflow,
  ChildCallFrozenWorkgroup,
  ChildCallNodeExecutionPorts,
} from '../../../../application/ports/childCallNodeExecution'
import { childCallRefusal } from '../../../../application/childCallErrors'
import { pickString } from '../../../../domain/nodeFields'

export function inheritedCallSpace({
  parentMounts,
  parentWorktreePath,
  branch,
  iso,
  childId,
}: {
  parentMounts: readonly string[]
  parentWorktreePath: string
  branch: string | null
  iso: IsoHandle
  childId: string
}) {
  // The synthesized 'inherited' space: the child's canonical IS this call
  // node's iso worktree(s); cleanup carries ZERO worktrees + no owned root
  // (borrowed semantics — the iso lifecycle stays with the parent).
  const primary = iso.repos[0]
  const singleRoot = isSingleRootRepository(parentMounts)
  return {
    kind: singleRoot ? ('single' as const) : ('multi' as const),
    spaceKind: 'inherited' as const,
    taskId: childId,
    worktreePath: singleRoot ? (primary?.isoWorktreePath ?? parentWorktreePath) : iso.containerPath,
    branch: branch ?? `agent-workflow/${childId}`,
    baseCommit: primary?.baseSnapshot ?? null,
    earlyError: null,
    resolvedSources: [],
    nodePaths: [],
    cleanup: {
      taskId: childId,
      ownedRoot: null,
      worktrees: [],
      state: 'owned' as const,
      report: null,
    },
    repos: iso.repos.map((r, i) => ({
      repoIndex: i,
      repoPath: r.repoPath,
      repoUrl: null,
      cachedRepoId: null,
      baseBranch: r.baseBranch,
      branch: branch ?? `agent-workflow/${childId}`,
      baseCommit: r.baseSnapshot ?? null,
      worktreePath: r.isoWorktreePath,
      worktreeDirName: r.mountPath,
      mountPath: r.mountPath,
      subdir: '',
      readonly: false,
      submoduleInitOk: true,
      submoduleInitError: null,
      hasSubmodules: false,
    })),
  }
}

/** The node's numeric `limits` only; anything else is ignored. */
function callLimits(node: WorkflowNode): { maxDurationMs?: number; maxTotalTokens?: number } {
  const raw = (node as unknown as Record<string, unknown>).limits
  if (typeof raw !== 'object' || raw === null) return {}
  const o = raw as { maxDurationMs?: unknown; maxTotalTokens?: unknown }
  return {
    ...(typeof o.maxDurationMs === 'number' ? { maxDurationMs: o.maxDurationMs } : {}),
    ...(typeof o.maxTotalTokens === 'number' ? { maxTotalTokens: o.maxTotalTokens } : {}),
  }
}

function childTaskName(taskName: string, node: WorkflowNode): string {
  const nodeTitle = pickString(node, 'title') ?? node.id
  return `${taskName} › ${nodeTitle}`.slice(0, 255)
}

/** L — assemble and fire the child launch through the executor facade. */
export async function launchCallChild(
  ports: ChildCallNodeExecutionPorts,
  args: {
    node: WorkflowNode
    nodeRunId: string
    childId: string
    frozen: ChildCallFrozenWorkflow
    inputs: Record<string, string>
    iso: IsoHandle
    childDepth: number
  },
): Promise<void> {
  const { task } = ports
  const { taskId } = task
  const { node, nodeRunId, childId, frozen, inputs, iso, childDepth } = args
  const frozenSnapshotJson = JSON.stringify(frozen.definition)

  // Child collaborators = the parent task's members (D11).
  const collaboratorUserIds = task.collaboratorUserIds

  const limits = callLimits(node)
  const childName = childTaskName(task.name, node)

  const space = inheritedCallSpace({
    parentMounts: task.repos.map((repo) => repo.mountPath),
    parentWorktreePath: task.worktreePath,
    branch: task.branch,
    iso,
    childId,
  })

  const payload: StartTask = {
    workflowId: frozen.id,
    name: childName,
    inputs,
    ...(collaboratorUserIds.length > 0 ? { collaboratorUserIds } : {}),
    ...limits,
    // publication belongs to the parent (D12): no workingBranch, no auto push.
    autoCommitPush: false,
  } as StartTask

  // RFC-285 B3 + RFC-347：closed delegated factory 取代伪造幽灵与
  // central inherited-Actor facade。owner 失活/缺行 → 子任务拒启（外层
  // catch 把 code 直通 failCallRow → 节点以 call-owner-inactive 失败）；
  // NULL owner legacy 行按 Q5 的 pure projection 放行（投影在绑定里）。
  const actor = await ports.children.resolveActor('call-workflow', nodeRunId)
  if (actor === null) {
    throw childCallRefusal(
      'call-owner-inactive',
      `task owner '${task.ownerUserId}' is not an active user; refusing to start call child`,
    )
  }
  await ports.children.launchWorkflow({
    actor,
    workflowId: frozen.id,
    frozenWorkflowVersion: frozen.version,
    payload,
    parentTaskId: taskId,
    parentNodeRunId: nodeRunId,
    invocationDepth: childDepth,
    materializedSpace: space,
    frozenSnapshotJson,
    refClosureJson: ports.closure.childClosureSubset(
      task.refClosureJson,
      frozen.definition,
      // RFC-271 T6e：子集裁剪要用**子工作流自己的 id** 当 source（v2 边键）。
      // 调用点本来就持有 frozen.id，此前只是没传进去。
      frozen.id,
    ),
  })
}

/**
 * RFC-243 §6.3 — bare goalTemplate expansion. {{port}} tokens read the
 * resolved upstream inputs; repo-shaped builtin tokens describe the CHILD's
 * workspace (the call-node iso); identity tokens describe the CALLER context.
 * Unknown tokens render '' (validator §5 already nudges at edit time). The
 * rendered string is LITERAL for the child — the workgroup prompt layer's
 * literal-render protection (2026-07-27) keeps embedded `{{…}}` inert.
 */
function renderCallGoal(
  template: string,
  inputs: Record<string, string>,
  triggerContext: TriggerContext | null,
  meta: {
    taskId: string
    nodeId: string
    iteration: number
    shardKey: string | null
    repos: ReadonlyArray<{ isoWorktreePath: string; mountPath: string; baseBranch: string }>
  },
): string {
  const primary = meta.repos[0]
  const builtins: Record<string, string> = {
    __repo_path__: primary?.isoWorktreePath ?? '',
    __base_branch__: primary?.baseBranch ?? '',
    __task_id__: meta.taskId,
    __node_id__: meta.nodeId,
    __iteration__: String(meta.iteration),
    __shard_key__: meta.shardKey ?? '',
    __repo_count__: String(meta.repos.length),
    __repo_names__: meta.repos.map((r) => r.mountPath || '(root)').join(', '),
    __repos__: meta.repos
      .map((r) => `- ${r.mountPath || '(root)'}: ${r.isoWorktreePath}`)
      .join('\n'),
  }
  const rendered = renderCallWorkgroupGoalTemplate({
    template,
    inputs,
    builtins,
    triggerContext,
  })
  if (!rendered.ok && rendered.code === 'trigger-context-missing') {
    throw childCallRefusal(
      'trigger-context-missing',
      'workgroup goal requires webhook trigger context',
    )
  }
  if (!rendered.ok) {
    throw childCallRefusal(
      'workflow-invalid',
      `workgroup goal contains an invalid template ref (${rendered.reason})`,
    )
  }
  return rendered.value
}

/** L (workgroup arm) — frozen-group launch through the RFC-243 frozen face. */
export async function launchCallWorkgroupChild(
  ports: ChildCallNodeExecutionPorts,
  args: {
    node: WorkflowNode
    nodeRunId: string
    childId: string
    frozenGroup: ChildCallFrozenWorkgroup
    inputs: Record<string, string>
    iso: IsoHandle
    childDepth: number
    iteration: number
    inheritedShardKey: string | null
  },
): Promise<void> {
  const { task } = ports
  const { taskId } = task
  const { node, nodeRunId, childId, frozenGroup, inputs, iso, childDepth } = args

  const goalTemplate = pickString(node, 'goalTemplate') ?? ''
  const goal = renderCallGoal(goalTemplate, inputs, ports.task.triggerContext, {
    taskId,
    nodeId: node.id,
    iteration: args.iteration,
    shardKey: args.inheritedShardKey,
    repos: iso.repos.map((r) => ({
      isoWorktreePath: r.isoWorktreePath,
      mountPath: r.mountPath,
      subdir: '',
      readonly: false,
      baseBranch: r.baseBranch,
    })),
  })

  const collaboratorUserIds = task.collaboratorUserIds

  const limits = callLimits(node)
  const childName = childTaskName(task.name, node)
  const space = inheritedCallSpace({
    parentMounts: task.repos.map((repo) => repo.mountPath),
    parentWorktreePath: task.worktreePath,
    branch: task.branch,
    iso,
    childId,
  })

  // RFC-285 B3 + RFC-347：本臂不消费 legacy projection，但同经 closed
  // delegated factory 做 owner preflight；失败经外层 catch 落
  // call-owner-inactive。
  const actor = await ports.children.resolveActor('call-workgroup', nodeRunId)
  if (actor === null) {
    throw childCallRefusal(
      'call-owner-inactive',
      `task owner '${task.ownerUserId}' is not an active user; refusing to start call child`,
    )
  }
  await ports.children.launchWorkgroup({
    actor,
    frozenGroup,
    goal,
    name: childName,
    collaboratorUserIds,
    ...limits,
    parentTaskId: taskId,
    parentNodeRunId: nodeRunId,
    invocationDepth: childDepth,
    materializedSpace: space,
  })
}
