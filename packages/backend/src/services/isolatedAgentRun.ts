// Exact RFC-188 compatibility; Task owns the single isolation policy assembly.
export {
  createIsoUnderLock,
  persistIsoBase,
  persistIsoNodeTree,
  mergeBackAndSettle,
  markMergeFailed,
} from '@/modules/task-execution/public/participants'
export type {
  IsolatedAgentRunBinding,
  WriteSemLike,
  MergeSettleOutcome,
} from '@/modules/task-execution/public/participants'
