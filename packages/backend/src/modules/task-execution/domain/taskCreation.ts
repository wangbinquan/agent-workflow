import type { TaskLaunchOrigin } from '@agent-workflow/shared'

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
