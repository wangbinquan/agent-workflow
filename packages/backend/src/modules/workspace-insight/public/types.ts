// RFC-453 — workspace-insight's public types: the tasks route's surface and its query / result shapes, and the
// code-review artifact store the deployment selections name.

export type {
  ChangeNarrativeGenerating,
  ChangeNarrativeRuntimeSelection,
  CodeIntelQuery,
  FileContentResult,
  FileSymbolsQuery,
  StructuralDiffOptions,
  TaskFileContentQuery,
  TaskWorkspaceInsight,
} from '../application/ports/taskWorkspaceInsight'
export type {
  CodeReviewArtifactStore,
  StructuralDiffArtifactKey,
} from '../application/ports/codeReviewArtifacts'
export type { ResolvedDeepConfig } from '../domain/deep/deepIndexing'
export type { DeepIndexerOverrides } from '../domain/deep/indexers'
