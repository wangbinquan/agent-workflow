import type { WorkflowNode } from '@agent-workflow/shared'
import type { IsoHandle } from '@/platform/contracts/isolationWorkspace'
import type { OpenWrapperGeneration, WrapperNodeKind } from '../../domain/wrapperExecution'
import type { IsolationMechanicsPorts, IsolationScope } from './isolationMechanics'

/**
 * Opaque handle: only the engine's wrapper workspace (RFC-413, `engine/wrapper/wrapperWorkspace.ts`) resolves it to
 * physical worktrees; the composition's scope driver asks it through {@link WrapperWorkspaceScenes.resolve}.
 */
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

/** RFC-413 — the git surface of the scope a wrapper's isolated worktree was opened in. */
export type WrapperGitScope = Pick<IsolationScope, 'head' | 'changedFiles' | 'blobHashes'>

/** RFC-413 — what the engine's wrapper workspace runs on. */
export interface WrapperWorkspaceEnginePorts {
  readonly isolation: IsolationMechanicsPorts
  /** The scope the handle was opened in. */
  scopeOf(handle: IsoHandle): WrapperGitScope
}

/** RFC-413 — the workspace port and the resolver of its opened scenes. */
export interface WrapperWorkspaceScenes {
  readonly port: WrapperWorkspacePort
  resolve(scene: WrapperWorkspaceScene): {
    readonly handle: IsoHandle
    readonly kind: WrapperNodeKind
  }
}
