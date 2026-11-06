// RFC-453 — the workspace-insight composition entry (only the composition roots import it): the tasks route's
// surface, the code-review artifact store selections and their hosted sweep, the deep indexing binding, and the
// call-graph index invalidation the workspace maintenance runs after it rewrites a worktree.

export { invalidateCallGraphIndex } from './application/callGraph/callTargets'
export { composeLocalCodeReviewArtifacts } from './composition/codeReviewArtifacts'
export {
  composeCrewStationCodeReviewArtifacts,
  composeCrewStationCodeReviewObjectSweep,
} from './composition/crewstationCodeReviewArtifacts'
export { composeStructuralDeepIndexing } from './composition/structuralDeepIndexing'
export { composeTaskWorkspaceInsight } from './composition/taskWorkspaceInsight'
