/** RFC-395 II-a: repository value projections are shared by execution and source-control. */
export {
  isTaskWorkspaceUnbound,
  taskRepositoryCount,
  taskBranch,
  taskRepositoryNodePaths,
  projectTaskRepositorySurface,
  type TaskRepositoryMount,
  type RequestedSource,
  type TaskRepositoryWorkspace,
  type TaskRepositoryPrimarySurface,
  type TaskRepositorySurfaceCompatibility,
} from '@/platform/taskRepository'
