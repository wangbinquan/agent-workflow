// RFC-349 compatibility facade. SQLite lifecycle mechanisms live in Task
// Execution infrastructure; provider-neutral callers consume composed
// TaskExecutionPersistence participants instead of importing database types.
export {
  ConcurrentNodeRunTransition,
  ConcurrentTaskTransition,
  TERMINAL_TASK_STATUSES,
  assertNodeRunSourceTerminationAdmission,
  cancelOpenNodeRuns,
  isTerminalTaskStatus,
  setNodeRunStatus,
  setNodeRunStatusTx,
  setTaskStatus,
  transitionNodeRunStatus,
  transitionNodeRunStatusTx,
  transitionTaskStatusByEvent,
  trySetTaskStatus,
  type HumanGateTaskTransition,
  type NodeRunStatusUpdateExtra,
  type TaskStatusUpdateExtra,
  type WorkspacePruneCause,
} from '@/platform/persistence/sqlite/taskLifecycle'
export {
  registerTerminalWorkspacePrunePolicy,
  resolveTerminalWorkspacePruneDecision,
  type TerminalWorkspacePruneDecision,
  type TerminalWorkspacePrunePolicy,
} from '@/platform/persistence/terminalWorkspacePrune'
