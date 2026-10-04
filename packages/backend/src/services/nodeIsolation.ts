// RFC-370: exact native compatibility exports; Task owns cleanup effects.
export {
  CanonicalWorktreeMissingError,
  isoKeyOf,
  isoWorktreePathFor,
  IsoWorkspaceBlockedError,
  chooseIsoWorkspaceKey,
  createNodeIso,
  rebuildIsoHandle,
  snapshotNodeIsoFinal,
  mergeBackNodeIso,
  undoPriorShardDeltaInIso,
  MergeAgentChildUnreapedError,
  resolveConflictWithAgent,
  completeHumanResolvedConflict,
  MAX_ISO_KEY_GENERATIONS,
  ISO_DISCARD_GIT_TIMEOUT_MS,
} from '@/platform/workspace/local/isolation'
export type {
  IsoRepo,
  IsoHandle,
  CanonRepo,
  IsoWorkspaceKeyChoice,
  MergeBackConflict,
  MergeBackResult,
  DiscardLock,
  ResolveConflictOutcome,
} from '@/platform/workspace/local/isolation'
export { discardNodeIso } from '@/modules/task-execution/public/participants'
