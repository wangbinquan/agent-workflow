import { taskRepositoryNodePaths } from '@/platform/taskRepository'
import type { SourceRow, TargetRow } from '@/platform/persistence/migration/conversion/types'
import { text } from './values'

export function taskSpaceNodes(
  taskId: string,
  mounts: readonly TargetRow[],
  explicit: readonly SourceRow[],
): readonly { row: TargetRow; origin: SourceRow | null }[] {
  const existing = new Set(explicit.map((row) => text(row, 'node_path').toLowerCase()))
  const paths = taskRepositoryNodePaths(
    mounts.map((row) => row.mount_path as string),
    explicit.map((row) => text(row, 'node_path')),
  )
  return [
    ...explicit.map((origin) => ({ row: origin.values, origin })),
    ...paths
      .filter((path) => !existing.has(path.toLowerCase()))
      .map((node_path) => ({
        row: { task_id: taskId, node_path, schema_version: 1 },
        origin: null,
      })),
  ]
}
