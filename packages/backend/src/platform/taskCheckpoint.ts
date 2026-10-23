/** Epoch-1 JSON values retain malformed historical maps without opening the DTO to arbitrary objects. */
export type TaskCheckpointJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly TaskCheckpointJsonValue[]
  | TaskCheckpointJsonObject

// A recursive Record alias produces TS2456; the interface preserves the same JSON value shape.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TaskCheckpointJsonObject extends Readonly<
  Record<string, TaskCheckpointJsonValue>
> {}

export interface TaskCheckpointRollbackRequest {
  readonly v: 1
  readonly runId: string
  readonly snapshots: TaskCheckpointJsonValue
}

/** A missing component is unrecorded; the empty string is a recorded clean tree. */
export interface TaskRepositoryCheckpoint {
  readonly mountPath: string
  readonly preSnapshot?: string
  readonly isolationBase?: string
  readonly nodeTree?: string
  readonly submodules?: TaskCheckpointJsonValue
}

export type TaskCheckpointComponent = Exclude<keyof TaskRepositoryCheckpoint, 'mountPath'>

export interface TaskPendingSubResolves {
  readonly mountPath: string
  readonly poolDirs: Readonly<Record<string, string>>
  readonly subBases: Readonly<Record<string, string>>
  readonly pendingSubResolves: readonly string[]
}

/** Per-mount refs retain the recorded empty-string marker. */
export function taskCheckpointRefs(
  checkpoints: readonly TaskRepositoryCheckpoint[],
  component: 'preSnapshot' | 'isolationBase' | 'nodeTree',
): Record<string, string> {
  return Object.fromEntries(
    checkpoints.flatMap((checkpoint) => {
      const value = checkpoint[component]
      return value === undefined ? [] : [[checkpoint.mountPath, value]]
    }),
  )
}

/** New attempts inherit historical pre-snapshots, never the previous isolation generation. */
export function inheritTaskPreSnapshots(
  checkpoints: readonly TaskRepositoryCheckpoint[],
): TaskRepositoryCheckpoint[] {
  return checkpoints.flatMap(({ mountPath, preSnapshot }) =>
    preSnapshot === undefined ? [] : [{ mountPath, preSnapshot }],
  )
}
