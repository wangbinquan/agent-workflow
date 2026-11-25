// RFC-453 — workspace-insight's public types: the code-review artifact store the deployment selections name. RFC-588: the
// task endpoints' surface (`TaskWorkspaceInsight`) and its query / result shapes left with the endpoints, which are this
// module's inbound binding now.

export type {
  CodeReviewArtifactStore,
  StructuralDiffArtifactKey,
} from '../application/ports/codeReviewArtifacts'
