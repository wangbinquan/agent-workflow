import type { WorkflowNode } from '@agent-workflow/shared'
import type { OpenWrapperGeneration, WrapperNodeKind } from '../../domain/wrapperExecution'

/** Opaque handle: only the composition adapter can resolve it to physical worktrees. */
export interface WrapperWorkspaceScene {
  readonly key: symbol
  readonly kind: WrapperNodeKind
  readonly passthrough: boolean
}

export interface WrapperGitEntrySnapshot {
  readonly baselines: Readonly<Record<string, string>>
  readonly preDirtyByRepo: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly primaryMount: string
}

export type WrapperWorkspaceMergeResult =
  | { readonly kind: 'merged' }
  | { readonly kind: 'conflict-human'; readonly detail: string }
  | { readonly kind: 'merge-failed'; readonly message: string }

export interface WrapperWorkspacePort {
  open<K extends WrapperNodeKind>(
    generation: OpenWrapperGeneration<K>,
  ): Promise<WrapperWorkspaceScene>

  captureGitEntry(
    scene: WrapperWorkspaceScene,
    capturePreDirty: boolean,
  ): Promise<WrapperGitEntrySnapshot>

  changedFiles(
    scene: WrapperWorkspaceScene,
    baselines: Readonly<Record<string, string>>,
    preDirtyByRepo: Readonly<Record<string, Readonly<Record<string, string>>>>,
  ): Promise<readonly string[]>

  merge(input: {
    readonly scene: WrapperWorkspaceScene
    readonly runId: string
    readonly node: WorkflowNode
    readonly iteration: number
  }): Promise<WrapperWorkspaceMergeResult>
}
