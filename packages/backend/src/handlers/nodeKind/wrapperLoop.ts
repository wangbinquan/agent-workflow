// RFC-061 PR-B — NodeKindHandler<'wrapper-loop'>
//
// wrapper-loop runs its inner subgraph repeatedly until `exit_condition`
// fires or `max_iterations` is hit. Each iteration mints a fresh
// `loopIter` on inner-scope logical_runs so downstream consumers (and
// promptFromEvents aging) see distinct rounds.
//
// Design.md §11.2: dispatch sets innerScope.loopIter to the wrapper's
// `iter`. onInnerScopeCompleted evaluates the exit predicate:
//
//   - if shouldContinueLoop AND iter < max_iterations: bump-iter
//     (emit `logical-run-iter-bumped` for the wrapper itself; taskActor
//     re-dispatches at iter+1, which mints a fresh inner scope).
//   - else: terminal `done` with the wrapper's exit outputs (bound from
//     last inner iteration via the wrapper's `outputBindings`).

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

export type ExitConditionShape =
  | { kind: 'port-empty'; nodeId: string; portName: string }
  | { kind: 'port-equals'; nodeId: string; portName: string; value: string }
  | { kind: 'port-count-lt'; nodeId: string; portName: string; threshold: number }

export interface WrapperLoopDispatchExtras {
  node: WorkflowNode
}

export interface WrapperLoopInnerCompletedExtras {
  /**
   * Evaluate the wrapper's exit_condition against the inner scope just
   * finished. Returns true when the loop must STOP. Implementation reads
   * `node_outputs` for the referenced (nodeId, portName) at innerScope.
   */
  evaluateExitCondition: (innerScope: Scope) => Promise<boolean>
  /**
   * Read the wrapper's exit-time outputs by following its `outputBindings`
   * against the last inner iteration's port outputs.
   */
  readExitOutputs: (innerScope: Scope) => Promise<Record<string, string>>
  maxIterations: number
  /** The wrapper's current iter; promoted to innerScope.loopIter on dispatch. */
  currentIter: number
}

export interface WrapperLoopDispatchContext
  extends DispatchContext<'wrapper-loop'>, WrapperLoopDispatchExtras {}

export interface WrapperLoopInnerCompletedContext
  extends InnerScopeCompletedContext, WrapperLoopInnerCompletedExtras {}

export const wrapperLoopNodeKindHandler: NodeKindHandler<'wrapper-loop'> = {
  kind: 'wrapper-loop',

  async dispatch(ctx: DispatchContext<'wrapper-loop'>): Promise<DispatchResult> {
    const extras = ctx as WrapperLoopDispatchContext
    // Promote the wrapper's own iter to loopIter for inner nodes — that's
    // what makes inner-scope rows distinct across rounds without colliding
    // on logical_runs UNIQUE constraint.
    const innerScope: Scope = {
      nodeId: extras.node.id,
      loopIter: ctx.scope.iter,
      shardKey: ctx.scope.shardKey,
      iter: 0, // inner nodes start at iter=0; they may bump via clarify/review
    }
    return { kind: 'enter-inner-scope', innerScope }
  },

  async onAttemptFinished(_ctx: AttemptContext, _result: AttemptResult): Promise<NodeDecision> {
    throw new Error(
      'wrapper-loop NodeKind has no direct attempts — onAttemptFinished must not be called',
    )
  },

  async onInnerScopeCompleted(ctx: InnerScopeCompletedContext): Promise<NodeDecision> {
    const extras = ctx as WrapperLoopInnerCompletedContext
    const shouldExit = await extras.evaluateExitCondition(ctx.innerScope)
    const reachedMax = extras.currentIter + 1 >= extras.maxIterations
    if (shouldExit || reachedMax) {
      const outputs = await extras.readExitOutputs(ctx.innerScope)
      return { kind: 'done', outputs }
    }
    // Not done — signal the taskActor to bump the wrapper's iter; on
    // next ready scan the wrapper will re-dispatch at iter+1 and mint a
    // fresh inner scope with loopIter = new iter.
    return { kind: 'request-retry-auto', reason: 'loop-continue' }
  },
}

export function parseExitCondition(node: WorkflowNode): ExitConditionShape | null {
  const raw = (node as Record<string, unknown>).exitCondition
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>
  const kind = rec.kind
  if (typeof kind !== 'string') return null
  const nodeId = typeof rec.nodeId === 'string' ? rec.nodeId : ''
  const portName = typeof rec.portName === 'string' ? rec.portName : ''
  if (!nodeId || !portName) return null
  if (kind === 'port-empty') return { kind: 'port-empty', nodeId, portName }
  if (kind === 'port-equals' && typeof rec.value === 'string') {
    return { kind: 'port-equals', nodeId, portName, value: rec.value }
  }
  if (kind === 'port-count-lt' && typeof rec.threshold === 'number') {
    return { kind: 'port-count-lt', nodeId, portName, threshold: rec.threshold }
  }
  return null
}

export function parseMaxIterations(node: WorkflowNode): number {
  const v = (node as Record<string, unknown>).maxIterations
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v)
  return 10 // sensible default matching today's wrapper-loop fallback
}
