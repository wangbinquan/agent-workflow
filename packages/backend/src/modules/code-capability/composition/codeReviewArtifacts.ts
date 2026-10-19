// RFC-370 §10 V16 — the standalone selection of the code-review artifact store
// (the appHome files). The hosted selection is `crewstationCodeReviewArtifacts.ts`.
export { createFileCodeReviewArtifactStore as composeLocalCodeReviewArtifacts } from '../infrastructure/local/fileCodeReviewArtifacts'
