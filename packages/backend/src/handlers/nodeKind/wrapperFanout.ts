// RFC-061 PR-B — NodeKindHandler<'wrapper-fanout'>
//
// wrapper-fanout splits its `shardSource` list<T> input into N shards and
// runs the inner subgraph once per shard in parallel (each at a distinct
// shardKey). After all shards complete, an aggregator agent (defined by
// RFC-060 PR-C's `agent.role: 'aggregator'`) folds the per-shard outputs
// into the wrapper's outputs.
//
// Design.md §11.3: dispatch returns `enter-inner-scope-multi` with one
// Scope per shard. onInnerScopeCompleted is called for EACH shard scope;
// the wrapper aggregates when all shards have completed.
//
// Behavior contract preserved from scheduler.ts runFanoutWrapperNode:
//   - shard list pulled from upstream `shardSource` port (RFC-060 list<T>)
//   - shard keys are dedup'd + dictionary-ordered for deterministic
//     aggregation (matches RFC-055 sharding registry semantics)
//   - empty shard list → fail-direct ("nothing to fan-out")
//   - aggregator: if defined in workflow, dispatch sub-attempt via
//     readyCondition + spawn-attempt path; else direct join-and-done

import type {
  NodeKindHandler,
  DispatchContext,
  DispatchResult,
  AttemptContext,
  AttemptResult,
  NodeDecision,
  InnerScopeCompletedContext,
  ReadyContext,
  Scope,
} from '@agent-workflow/shared'
import type { WorkflowNode } from '@agent-workflow/shared'

export interface WrapperFanoutDispatchExtras {
  node: WorkflowNode
  /** Pull the upstream `shardSource` port value and split it. Returns the deduped shardKeys. */
  resolveShards: (scope: Scope) => Promise<ReadonlyArray<string>>
}

export interface WrapperFanoutInnerCompletedExtras {
  /** All shard scopes for this wrapper iter, in dictionary order. */
  allShardScopes: ReadonlyArray<Scope>
  /** Probe whether each shard has reached terminal status. */
  isShardComplete: (shardScope: Scope) => Promise<boolean>
  /** Aggregate per-shard outputs into wrapper outputs. */
  aggregateShardOutputs: (shardScopes: ReadonlyArray<Scope>) => Promise<Record<string, string>>
}

export interface WrapperFanoutReadyExtras {
  node: WorkflowNode
  /** Shard list non-empty check via cached upstream port read. */
  hasShards: (scope: Scope) => boolean
}

export interface WrapperFanoutDispatchContext
  extends DispatchContext<'wrapper-fanout'>, WrapperFanoutDispatchExtras {}

export interface WrapperFanoutInnerCompletedContext
  extends InnerScopeCompletedContext, WrapperFanoutInnerCompletedExtras {}

export interface WrapperFanoutReadyContext extends ReadyContext, WrapperFanoutReadyExtras {}

export const wrapperFanoutNodeKindHandler: NodeKindHandler<'wrapper-fanout'> = {
  kind: 'wrapper-fanout',

  readyCondition(ctx: ReadyContext): boolean {
    const extras = ctx as WrapperFanoutReadyContext
    // Defer until shard list is materialized at this scope. Without it,
    // dispatch would split an empty list and fail-direct prematurely.
    return extras.hasShards(ctx.scope)
  },

  async dispatch(ctx: DispatchContext<'wrapper-fanout'>): Promise<DispatchResult> {
    const extras = ctx as WrapperFanoutDispatchContext
    const shards = await extras.resolveShards(ctx.scope)
    if (shards.length === 0) {
      return {
        kind: 'fail-direct',
        errorMessage: `wrapper-fanout ${extras.node.id} got empty shard list at scope ${JSON.stringify(ctx.scope)}`,
      }
    }
    // Dedup + dictionary order (the resolver may already do this, but
    // we re-do here as a defensive normalization — matches
    // sharding registry's canonical ordering).
    const sortedShards = Array.from(new Set(shards)).sort()
    const innerScopes: Scope[] = sortedShards.map((shardKey) => ({
      nodeId: extras.node.id,
      loopIter: ctx.scope.loopIter,
      shardKey,
      iter: 0,
    }))
    return { kind: 'enter-inner-scope-multi', innerScopes }
  },

  async onAttemptFinished(_ctx: AttemptContext, _result: AttemptResult): Promise<NodeDecision> {
    throw new Error(
      'wrapper-fanout NodeKind has no direct attempts — onAttemptFinished must not be called',
    )
  },

  async onInnerScopeCompleted(ctx: InnerScopeCompletedContext): Promise<NodeDecision> {
    const extras = ctx as WrapperFanoutInnerCompletedContext
    // Aggregation only fires once ALL shards have reached terminal status.
    // If not, we return noop-via-fail-mapping; the taskActor will not
    // re-trigger until another `event-applied` for this scope.
    for (const s of extras.allShardScopes) {
      if (!(await extras.isShardComplete(s))) {
        return { kind: 'request-retry-auto', reason: 'fanout-waiting-shards' }
      }
    }
    const outputs = await extras.aggregateShardOutputs(extras.allShardScopes)
    return { kind: 'done', outputs }
  },
}
