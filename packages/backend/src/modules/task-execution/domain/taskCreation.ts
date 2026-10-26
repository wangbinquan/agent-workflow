import { isTaskWorkspaceUnbound, type TaskLaunchOrigin } from '@agent-workflow/shared'
import type { TaskCreationInput } from '../application/ports/taskCreation'
import { initialTaskExecutionGeneration } from '../application/ports/taskExecutionGenerations'
import type { TaskCreationSplit } from '../application/ports/taskSplit'
import { encodeRequestedSource, requestedSourceAtCreation } from './requestedSourceCodec'
import { taskBranch, type TaskRepositoryMount } from './taskRepository'
import { taskSubjectFromDefinition } from './taskSubject'
import { encodeWorkgroupLaunchConfig } from './workgroupLaunchConfigCodec'

export interface TaskLineageEntry {
  readonly stableNodeKey: string
  readonly frozenOccurrenceKey: string
  readonly workflowRevision: number | null
}

export interface TaskCreationParent {
  readonly id: string
  readonly rootTaskId: string | null
  readonly executionLineageId: string | null
  readonly lineageSlotPathJson: string | null
  readonly launchOrigin: TaskLaunchOrigin
}

export type TaskCreationLaunch =
  | { readonly kind: 'root'; readonly launchOrigin: TaskLaunchOrigin }
  | {
      readonly kind: 'child'
      readonly parent: TaskCreationParent
      readonly parentNodeRunId: string
      readonly continuationSlotKey: string | null
      readonly parentRunLineageSlotPathJson: string | null
    }

function parentLineage(
  raw: string | null,
  executionLineageId: string,
): readonly TaskLineageEntry[] {
  if (raw !== null) {
    try {
      const value: unknown = JSON.parse(raw)
      if (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every(
          (entry) =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof Reflect.get(entry, 'stableNodeKey') === 'string' &&
            typeof Reflect.get(entry, 'frozenOccurrenceKey') === 'string' &&
            (Reflect.get(entry, 'workflowRevision') === null ||
              typeof Reflect.get(entry, 'workflowRevision') === 'number'),
        )
      )
        return value.map((entry) => ({
          stableNodeKey: String(Reflect.get(entry, 'stableNodeKey')),
          frozenOccurrenceKey: String(Reflect.get(entry, 'frozenOccurrenceKey')),
          workflowRevision:
            typeof Reflect.get(entry, 'workflowRevision') === 'number'
              ? Reflect.get(entry, 'workflowRevision')
              : null,
        }))
    } catch {
      // Historical malformed paths retain the established root fallback.
    }
  }
  return [
    { stableNodeKey: 'task-root', frozenOccurrenceKey: executionLineageId, workflowRevision: null },
  ]
}

/** Shared by every creation participant and fixture; no database trigger is required. */
export function deriveTaskCreationLineage(
  taskId: string,
  workflowRevision: number | null,
  launch: TaskCreationLaunch,
) {
  const executionLineageId =
    launch.kind === 'root' ? taskId : (launch.parent.executionLineageId ?? launch.parent.id)
  const lineage: readonly TaskLineageEntry[] =
    launch.kind === 'root'
      ? [{ stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision }]
      : [
          ...parentLineage(
            launch.parentRunLineageSlotPathJson ?? launch.parent.lineageSlotPathJson,
            executionLineageId,
          ),
          {
            stableNodeKey: 'child-task',
            frozenOccurrenceKey:
              launch.continuationSlotKey ?? `legacy-call:${launch.parentNodeRunId}`,
            workflowRevision,
          },
        ]
  return {
    rootTaskId: launch.kind === 'root' ? taskId : (launch.parent.rootTaskId ?? launch.parent.id),
    executionLineageId,
    lineageSlotPathJson: JSON.stringify(lineage),
    launchOrigin: launch.kind === 'root' ? launch.launchOrigin : launch.parent.launchOrigin,
  }
}

/** Mount identity is assigned once from the task and mount path, never from its ordinal. */
export function taskMountAtCreation(taskId: string, mount: TaskRepositoryMount) {
  const { ordinal, worktreePath: _worktreePath, baseBranch, branch, ...values } = mount
  return {
    ...values,
    taskId,
    repoKey: mount.repoKey ?? `${taskId}:mount:${mount.mountPath}`,
    ordinal,
    baseBranch: baseBranch === '' ? null : baseBranch,
    branch: branch === '' ? null : branch,
    branchState:
      branch !== ''
        ? ('branch' as const)
        : mount.baseCommit
          ? ('detached' as const)
          : ('none' as const),
    schemaVersion: 1,
  }
}

/** A bound root with no explicit repositories is a real ordinal-0 mount, as in conversion. */
export function taskMountsAtCreation(
  taskId: string,
  workspace: TaskCreationInput['workspace'],
  repos: readonly TaskRepositoryMount[],
) {
  return (
    repos.length > 0 || isTaskWorkspaceUnbound(workspace.worktreePath)
      ? repos
      : [
          {
            ordinal: 0,
            mountPath: '',
            repoPath: workspace.repoPath,
            repoUrl: workspace.repoUrl ?? null,
            cachedRepoId: workspace.cachedRepoId ?? null,
            baseBranch: workspace.baseBranch,
            branch: workspace.branch,
            workingBranch: workspace.workingBranch ?? null,
            baseCommit: workspace.baseCommit,
            worktreePath: workspace.worktreePath,
            subdir: '',
            readonly: false,
            readonlyDirtyCount: null,
            workspaceProfileVersion: null,
            workspaceProfileDigest: null,
            hasSubmodules: null,
            submoduleInitOk: null,
            submoduleInitError: null,
          },
        ]
  ).map((mount) => taskMountAtCreation(taskId, mount))
}

export function splitTaskCreation(input: TaskCreationInput): TaskCreationSplit {
  const { parentNodeRunId, ...core } = input.core
  const { definitionOrigin, workflowVersion, workgroupConfigJson, ...definition } = input.definition
  const { sourceTerminationFence, sourceTerminationEffectRev, ...launch } = input.launchContext
  const workspace = input.workspace
  const lineage = deriveTaskCreationLineage(core.id, workflowVersion, input.launch)
  const source = requestedSourceAtCreation(workspace)
  const rawConfig =
    workgroupConfigJson == null
      ? null
      : (JSON.parse(workgroupConfigJson) as Record<string, unknown>)
  const subject = taskSubjectFromDefinition({
    subjectKind: input.subject.kind,
    sourceId: input.subject.sourceId,
    sourceName: input.subject.kind === 'agent' ? input.subject.sourceName : null,
  })
  return {
    task: {
      ...core,
      rootTaskId: lineage.rootTaskId,
      workspaceRootRef: isTaskWorkspaceUnbound(workspace.worktreePath)
        ? null
        : workspace.worktreePath,
      sourceTerminationFence: sourceTerminationFence ?? null,
      sourceTerminationEffectRev: sourceTerminationEffectRev ?? null,
    },
    definition: {
      ...definition,
      taskId: core.id,
      subjectKind: subject.kind,
      sourceId: subject.sourceId,
      sourceName: subject.kind === 'agent' ? subject.sourceName : null,
      sourceRevision: workflowVersion,
      definitionOrigin,
      engineKind:
        subject.kind !== 'workgroup'
          ? 'dag'
          : rawConfig?.mode === 'dynamic_workflow'
            ? 'dw-generate'
            : 'workgroup-turns',
      definitionRevision: 1,
      workgroupConfigJson: rawConfig === null ? null : encodeWorkgroupLaunchConfig(rawConfig),
    },
    launchContext: {
      ...launch,
      taskId: core.id,
      parentNodeRunId:
        input.launch.kind === 'child' ? input.launch.parentNodeRunId : (parentNodeRunId ?? null),
      sourceTerminationLaunchRev: launch.sourceTerminationLaunchRev ?? 0,
      executionLineageId: lineage.executionLineageId,
      lineageSlotPathJson: lineage.lineageSlotPathJson,
      launchOrigin: lineage.launchOrigin,
    },
    workspace: {
      taskId: core.id,
      repoGroupId: workspace.repoGroupId ?? null,
      repoGroupName: workspace.repoGroupName ?? null,
      gitUserName: workspace.gitUserName ?? null,
      gitUserEmail: workspace.gitUserEmail ?? null,
      autoCommitPush: workspace.autoCommitPush ?? false,
      spaceKind: workspace.spaceKind,
      workingBranch: workspace.workingBranch ?? null,
      requestedSource: encodeRequestedSource(source),
      taskBranch: workspace.branch || taskBranch(core.id, workspace.workingBranch),
    },
    mounts: taskMountsAtCreation(core.id, workspace, input.repos),
    generation: initialTaskExecutionGeneration(core.id, core.startedAt),
    workgroupState:
      rawConfig === null
        ? null
        : {
            taskId: core.id,
            runtimeConfigJson: workgroupConfigJson,
            configRevision: 1,
            updatedAt: core.startedAt,
          },
    lineage,
  }
}
