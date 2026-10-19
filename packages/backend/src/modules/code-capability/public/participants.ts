// RFC-370 §10 V16 — the code-review artifact store the task Changes views
// persist to. Roots select the standalone or hosted store; services receive it.
export type {
  CodeReviewArtifactStore,
  StructuralDiffArtifactKey,
} from '../application/ports/codeReviewArtifacts'
export { composeLocalCodeReviewArtifacts } from '../composition/codeReviewArtifacts'
