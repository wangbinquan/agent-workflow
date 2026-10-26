import { isSingleRootRepository } from '@agent-workflow/shared'
import type {
  TaskCheckpointComponent,
  TaskPendingSubResolves,
  TaskRepositoryCheckpoint,
  TaskCheckpointJsonValue,
} from '@/platform/taskCheckpoint'

/** Epoch-1 mapping shared by the live adapter, fixtures and the II-b converter. */
export const taskCheckpointColumns = [
  ['preSnapshot', 'preSnapshot', 'preSnapshotReposJson'],
  ['isolationBase', 'isoBaseSnapshot', 'isoBaseSnapshotReposJson'],
  ['nodeTree', 'isoNodeTree', 'isoNodeTreeReposJson'],
  ['submodules', 'isoSubmodulesJson', 'isoSubmodulesReposJson'],
] as const
export type TaskCheckpointColumns = Record<
  (typeof taskCheckpointColumns)[number][1 | 2],
  string | null
>
export type TaskCheckpointLayout = 'single-root' | 'mounts'

export function taskCheckpointLayout(mountPaths: readonly string[]): TaskCheckpointLayout {
  return isSingleRootRepository(mountPaths.length === 0 ? [''] : mountPaths)
    ? 'single-root'
    : 'mounts'
}

function json(value: TaskRepositoryCheckpoint['submodules']): string | null {
  return value == null ? null : typeof value === 'string' ? value : JSON.stringify(value)
}

/** SQL fixtures select the layout at execution time, after their mounts have been inserted. */
export function encodeTaskCheckpointColumns(
  checkpoints: readonly TaskRepositoryCheckpoint[],
  layout: TaskCheckpointLayout,
): TaskCheckpointColumns {
  const result = {} as TaskCheckpointColumns
  for (const [field, scalar, map] of taskCheckpointColumns) {
    const recorded = checkpoints.filter((checkpoint) => checkpoint[field] !== undefined)
    if (layout === 'single-root') {
      const value = recorded.find((checkpoint) => checkpoint.mountPath === '')?.[field]
      result[scalar] =
        field === 'submodules' ? json(value) : ((value as string | undefined) ?? null)
      result[map] = null
    } else {
      result[scalar] = null
      result[map] =
        recorded.length === 0
          ? null
          : JSON.stringify(
              Object.fromEntries(
                recorded.map((checkpoint) => {
                  const value = checkpoint[field]
                  return [
                    checkpoint.mountPath,
                    field === 'submodules' && typeof value === 'string' && value !== ''
                      ? JSON.parse(value)
                      : value,
                  ]
                }),
              ),
            )
    }
  }
  return result
}

export function encodeTaskCheckpoints(
  checkpoints: readonly TaskRepositoryCheckpoint[],
  mountPaths: readonly string[],
): TaskCheckpointColumns {
  return encodeTaskCheckpointColumns(checkpoints, taskCheckpointLayout(mountPaths))
}

/** Omitted components remain untouched; explicit undefined clears them; [] clears all. */
export function encodeTaskCheckpointPatch(
  checkpoints: readonly TaskRepositoryCheckpoint[],
  mountPaths: readonly string[],
  components?: readonly TaskCheckpointComponent[],
): Partial<TaskCheckpointColumns> {
  const layout =
    components !== undefined && mountPaths.length === 0
      ? 'mounts'
      : taskCheckpointLayout(mountPaths)
  const encoded = encodeTaskCheckpointColumns(checkpoints, layout)
  if (components !== undefined) {
    // An explicitly touched empty component keeps the epoch-1 empty-map bytes.
    return Object.fromEntries(
      taskCheckpointColumns.flatMap(([field, scalar, map]) =>
        components.includes(field)
          ? [
              [scalar, encoded[scalar]],
              [
                map,
                layout === 'mounts' && field === 'nodeTree' ? (encoded[map] ?? '{}') : encoded[map],
              ],
            ]
          : [],
      ),
    )
  }
  if (checkpoints.length === 0) return encoded
  const touched = new Set<string>(
    taskCheckpointColumns
      .filter(([field]) => checkpoints.some((checkpoint) => Object.hasOwn(checkpoint, field)))
      .flatMap(([, scalar, map]) => [scalar, map]),
  )
  return Object.fromEntries(Object.entries(encoded).filter(([column]) => touched.has(column)))
}

export function decodeTaskCheckpoints(
  row: object,
  mountPaths: readonly string[],
): TaskRepositoryCheckpoint[] {
  const single = taskCheckpointLayout(mountPaths) === 'single-root'
  const found = new Map<string, TaskRepositoryCheckpoint>()
  for (const [field, scalar, map] of taskCheckpointColumns) {
    const value: unknown = Reflect.get(row, single ? scalar : map)
    if (value === null || value === undefined) continue
    let entries: [string, unknown][]
    try {
      if (single) {
        entries = [['', field === 'submodules' && value !== '' ? JSON.parse(String(value)) : value]]
      } else {
        const parsed: unknown = JSON.parse(String(value))
        // Match parseIsoJsonMap: primitives are not maps; arrays retain their numeric keys.
        entries = parsed !== null && typeof parsed === 'object' ? Object.entries(parsed) : []
      }
    } catch {
      // Existing replay treats unreadable checkpoint JSON as unrecorded.
      continue
    }
    for (const [mountPath, cell] of entries) {
      if (cell === null || cell === undefined) continue
      const checkpoint = found.get(mountPath) ?? { mountPath }
      Object.assign(checkpoint, { [field]: cell })
      found.set(mountPath, checkpoint)
    }
  }
  return [...found.values()]
}

/** Storage columns are removed before a run crosses a business port. */
export function projectTaskCheckpoints<T extends object>(row: T, mountPaths: readonly string[]) {
  const projection = { ...row }
  for (const [, scalar, map] of taskCheckpointColumns) {
    Reflect.deleteProperty(projection, scalar)
    Reflect.deleteProperty(projection, map)
  }
  return {
    ...(projection as Omit<T, keyof TaskCheckpointColumns>),
    checkpoints: decodeTaskCheckpoints(row, mountPaths),
  }
}

export function taskCheckpointProjectionPatch<
  T extends {
    readonly checkpoints?: readonly TaskRepositoryCheckpoint[]
    readonly checkpointComponents?: readonly TaskCheckpointComponent[]
    readonly checkpointMountPaths?: readonly string[]
  },
>(values: T, mountPaths: readonly string[]) {
  const { checkpoints, checkpointComponents, checkpointMountPaths, ...rest } = values
  return {
    ...rest,
    ...(checkpoints === undefined
      ? {}
      : encodeTaskCheckpointPatch(
          checkpoints,
          checkpointMountPaths ?? mountPaths,
          checkpointComponents,
        )),
  }
}

/** Preserve the historical resume fallback and malformed-map no-op at the storage boundary. */
export function decodeTaskRollbackCheckpoints(
  row: { id: string; preSnapshot: string | null; preSnapshotReposJson: string | null },
  mountPaths: readonly string[],
) {
  const mapped = taskCheckpointLayout(mountPaths) === 'mounts' && row.preSnapshotReposJson !== null
  let checkpoints: TaskRepositoryCheckpoint[] = []
  let checkpointParseError: string | null = null
  let rawSnapshots: TaskCheckpointJsonValue = {}
  try {
    if (mapped) {
      const parsed: TaskCheckpointJsonValue = JSON.parse(row.preSnapshotReposJson!)
      rawSnapshots = parsed
      const snapshots =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      checkpoints = decodeTaskCheckpoints(
        { preSnapshotReposJson: JSON.stringify(snapshots) },
        mountPaths,
      )
    } else {
      checkpoints = decodeTaskCheckpoints(row, [''])
    }
  } catch (error) {
    checkpointParseError = error instanceof Error ? error.message : String(error)
  }
  return {
    id: row.id,
    checkpoints,
    checkpointScope: mapped ? ('mounts' as const) : ('workspace' as const),
    checkpointParseError,
    ...(mapped
      ? { checkpointRequest: { v: 1 as const, runId: row.id, snapshots: rawSnapshots } }
      : {}),
  }
}

/** Epoch-1 continuation and hosted context copied only the workspace scalar, never the mount map. */
export function decodeTaskCheckpointInheritance(row: {
  readonly preSnapshot: string | null
}): TaskRepositoryCheckpoint[] {
  return decodeTaskCheckpoints({ preSnapshot: row.preSnapshot }, [''])
}

/** Preserve the existing submodule map order when a conflict park adds pending resolutions. */
export function encodePendingSubResolves(
  row: Pick<TaskCheckpointColumns, 'isoSubmodulesJson' | 'isoSubmodulesReposJson'>,
  mountPaths: readonly string[],
  repos: readonly TaskPendingSubResolves[],
): Partial<TaskCheckpointColumns> {
  const withPending = (
    raw: string | null,
    repo: TaskPendingSubResolves | undefined,
  ): string | null => {
    if (repo === undefined) return raw
    let base: object = { poolDirs: repo.poolDirs, subBases: repo.subBases }
    if (raw !== null && raw !== '') {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object') base = parsed
      } catch {
        /* Reconstruct the topology from the live handle. */
      }
    }
    return JSON.stringify({ ...base, pendingSubResolves: repo.pendingSubResolves })
  }
  if (taskCheckpointLayout(mountPaths) === 'single-root') {
    return { isoSubmodulesJson: withPending(row.isoSubmodulesJson, repos[0]) }
  }
  let multi: Record<string, unknown> = {}
  if (row.isoSubmodulesReposJson !== null && row.isoSubmodulesReposJson !== '') {
    try {
      const parsed: unknown = JSON.parse(row.isoSubmodulesReposJson)
      if (parsed !== null && typeof parsed === 'object') multi = parsed as Record<string, unknown>
    } catch {
      /* Rebuild the map below. */
    }
  }
  for (const repo of repos) {
    const previous = multi[repo.mountPath]
    const next = withPending(previous === undefined ? null : JSON.stringify(previous), repo)
    if (next !== null) multi[repo.mountPath] = JSON.parse(next) as unknown
  }
  return { isoSubmodulesReposJson: JSON.stringify(multi) }
}
