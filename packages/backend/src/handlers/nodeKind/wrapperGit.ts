// RFC-061 PR-B — NodeKindHandler<'wrapper-git'>
//
// wrapper-git takes a snapshot of the worktree HEAD before its inner scope
// runs, then on inner-scope completion composes the diff (commit-id range
// + working-tree changes including untracked) and exposes it as the
// `git_diff` output port (RFC-060 PR-D: list<path>).
//
// Design.md §11.1: dispatch returns `enter-inner-scope`; the taskActor
// writes `logical-run-created` events for inner nodes at innerScope.
// onInnerScopeCompleted reads back the inner scope's terminal state +
// computes the diff via a closure injected by the taskActor.

import type {
  NodeKindHandler,
  DispatchContext,
  DispatchResult,
  AttemptContext,
  AttemptResult,
  NodeDecision,
  InnerScopeCompletedContext,
  Scope,
} from '@agent-workflow/shared'
import type { WorkflowNode } from '@agent-workflow/shared'

export interface WrapperGitDispatchExtras {
  node: WorkflowNode
  /** Capture the worktree's current HEAD commit + dirty state token. */
  snapshotWorktree: (scope: Scope) => Promise<string>
}

export interface WrapperGitInnerCompletedExtras {
  /**
   * Compose the diff between the pre-snapshot and the worktree state now,
   * including uncommitted/untracked changes. Returns the serialized
   * `list<path>` representation per RFC-060.
   */
  computeDiffSinceSnapshot: (preSnapshot: string) => Promise<string>
  preSnapshot: string
}

export interface WrapperGitDispatchContext
  extends DispatchContext<'wrapper-git'>, WrapperGitDispatchExtras {}

export interface WrapperGitInnerCompletedContext
  extends InnerScopeCompletedContext, WrapperGitInnerCompletedExtras {}

export const wrapperGitNodeKindHandler: NodeKindHandler<'wrapper-git'> = {
  kind: 'wrapper-git',

  async dispatch(ctx: DispatchContext<'wrapper-git'>): Promise<DispatchResult> {
    const extras = ctx as WrapperGitDispatchContext
    // Inner scope inherits taskId + nodeId hierarchy from this wrapper.
    // The actual inner nodes are minted by the taskActor when it processes
    // `enter-inner-scope`.
    const innerScope: Scope = {
      nodeId: extras.node.id,
      loopIter: ctx.scope.loopIter,
      shardKey: ctx.scope.shardKey,
      iter: ctx.scope.iter,
    }
    // preSnapshot is opaque to the handler — we just return it as side
    // data for the taskActor to persist on the wrapper's first event.
    // Actual snapshot capture happens in the taskActor (so it can be
    // tested against a real worktree). The handler signals "enter scope".
    await extras.snapshotWorktree(ctx.scope)
    return { kind: 'enter-inner-scope', innerScope }
  },

  async onAttemptFinished(_ctx: AttemptContext, _result: AttemptResult): Promise<NodeDecision> {
    throw new Error(
      'wrapper-git NodeKind has no direct attempts — onAttemptFinished must not be called',
    )
  },

  async onInnerScopeCompleted(ctx: InnerScopeCompletedContext): Promise<NodeDecision> {
    const extras = ctx as WrapperGitInnerCompletedContext
    const gitDiff = await extras.computeDiffSinceSnapshot(extras.preSnapshot)
    return {
      kind: 'done',
      outputs: { git_diff: gitDiff },
    }
  },
}
