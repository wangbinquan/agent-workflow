// RFC-061 PR-B — NodeKindHandler<'review'>
//
// review nodes are human-in-the-loop gates (RFC-005). They have no opencode
// subprocess: dispatch reads the upstream port content (the doc to review),
// archives it, then immediately suspends the logical_run with signalKind
// 'review' awaiting a user decision. When the user submits, the
// SignalKindHandler<'review'> applyResolution decides:
//
//   - approve  → suspension-resolved + logical-run-completed (no bump)
//   - iterate  → suspension-resolved + logical-run-iter-bumped on the
//                upstream designer node (cascade through the designer
//                graph so it reruns with reviewer feedback in prompt)
//   - reject   → suspension-resolved + logical-run-canceled
//
// Today's review.ts mints a doc_version row and stashes the doc bytes;
// RFC-061 instead writes those bytes to `node_outputs` via the upstream
// port + records the review session as a SignalKind suspension. The doc
// archival is therefore implicit in the event stream.

import type {
  NodeKindHandler,
  DispatchContext,
  DispatchResult,
  AttemptContext,
  AttemptResult,
  NodeDecision,
  ActorRef,
  Scope,
} from '@agent-workflow/shared'
import type { WorkflowNode } from '@agent-workflow/shared'

/** Body payload of a review suspension — what the user sees on the page. */
export interface ReviewSuspensionBody {
  docNodeId: string
  docPortName: string
  docContent: string
  /** Optional reviewer hint stored on the wrapping review node. */
  reviewerHint?: string
}

export interface ReviewDispatchExtras {
  node: WorkflowNode
  /** Read the bound upstream doc port the reviewer should review. */
  readDocContent: (scope: Scope) => Promise<{
    nodeId: string
    portName: string
    content: string
  } | null>
}

export interface ReviewDispatchContext extends DispatchContext<'review'>, ReviewDispatchExtras {}

export const reviewNodeKindHandler: NodeKindHandler<'review'> = {
  kind: 'review',

  async dispatch(ctx: DispatchContext<'review'>): Promise<DispatchResult> {
    const extras = ctx as ReviewDispatchContext
    const doc = await extras.readDocContent(ctx.scope)
    if (!doc) {
      return {
        kind: 'noop',
        reason: `review ${extras.node.id} upstream doc not ready at scope ${JSON.stringify(ctx.scope)}`,
      }
    }
    const reviewerHint = pickString(extras.node, 'reviewerHint') ?? undefined
    const body: ReviewSuspensionBody = {
      docNodeId: doc.nodeId,
      docPortName: doc.portName,
      docContent: doc.content,
      ...(reviewerHint !== undefined ? { reviewerHint } : {}),
    }
    const awaitsActor: ActorRef = 'user:'
    return {
      kind: 'suspend-direct',
      signalKind: 'review',
      payload: body,
      awaitsActor,
    }
  },

  async onAttemptFinished(_ctx: AttemptContext, _result: AttemptResult): Promise<NodeDecision> {
    throw new Error('review NodeKind has no direct attempts — onAttemptFinished must not be called')
  },
}

function pickString(node: WorkflowNode, key: string): string | null {
  const v = (node as Record<string, unknown>)[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}
