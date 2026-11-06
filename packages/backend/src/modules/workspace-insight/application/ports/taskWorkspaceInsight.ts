// RFC-453 — what the tasks route reaches in workspace-insight: the structural diff overlay, the change narrative
// (read and trigger), a diff file's full text, a file's symbol table, identifier resolution and call-chain
// expansion. Results are the shared response types; queries are closed shapes. Authentication, the operator gate,
// the narrative member gate and the configuration reads stay in the route.

import type {
  CallTarget,
  ChangeNarrativeStatus,
  FileSymbolsResult,
  StructuralDiff,
  StructuralScope,
  SymbolResolution,
  Task,
} from '@agent-workflow/shared'
import type { ResolvedDeepConfig } from '../../domain/deep/deepIndexing'

/** Deep-mode request: try the external SCIP indexer, fall back to baseline. */
export interface StructuralDiffOptions {
  mode: 'baseline' | 'deep'
  deepCfg?: ResolvedDeepConfig
}

/** RFC-239 §3.5 — one side of a diff file (a renamed file's base side reads `basePath`). */
export interface TaskFileContentQuery {
  path: string
  side: 'base' | 'worktree'
  basePath?: string
  repo?: string
}

export interface FileContentResult {
  exists: boolean
  content?: string
  size?: number
}

export interface FileSymbolsQuery {
  path: string
  side: 'base' | 'worktree'
  /** Wire-form repo key ('.' = root repo, F-04); required for multi-repo. */
  repo?: string
}

export interface CodeIntelQuery {
  path: string
  side: 'base' | 'worktree'
  /** wire repo key ('.' = root); required for multi-repo tasks. */
  repo?: string
  /** 1-based click position. */
  line: number
  col: number
  /** The clicked identifier text (baseline's lookup key; deep's sanity net). */
  name: string
  mode: 'deep' | 'baseline'
}

/** RFC-239 — the narrative's runtime selection (`changeNarrativeRuntime` → `defaultRuntime`), read per request. */
export interface ChangeNarrativeRuntimeSelection {
  readonly runtimeName: string | null
  readonly defaultRuntime: string | null
}

export interface ChangeNarrativeGenerating {
  readonly status: 'generating'
  readonly startedAt: number
}

export interface TaskWorkspaceInsight {
  structuralDiff(
    taskId: string,
    scope: StructuralScope,
    nodeRunId: string | undefined,
    options: StructuralDiffOptions,
  ): Promise<StructuralDiff>
  /** null: nothing generated yet (the route answers 404). */
  changeNarrativeStatus(taskId: string): Promise<ChangeNarrativeStatus | null>
  /** Single-flighted per task; the caller has already passed the member gate. */
  triggerChangeNarrative(
    task: Task,
    runtime: ChangeNarrativeRuntimeSelection,
  ): Promise<ChangeNarrativeGenerating>
  fileContent(taskId: string, query: TaskFileContentQuery): Promise<FileContentResult>
  fileSymbols(taskId: string, query: FileSymbolsQuery): Promise<FileSymbolsResult>
  codeIntel(taskId: string, query: CodeIntelQuery): Promise<SymbolResolution>
  callTargets(taskId: string, methodRef: string): Promise<CallTarget[]>
}
