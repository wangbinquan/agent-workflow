// RFC-061 PR-B — NodeKindHandler<'clarify-cross-agent'>
//
// clarify-cross-agent nodes (RFC-056 / RFC-059) gate a downstream questioner
// agent's <workflow-clarify> emissions through a human-mediated submit/reject
// flow before they reach the upstream designer agent. The cross-clarify
// node itself doesn't spawn a subprocess — the questioner does. When the
// questioner emits clarify, the runner creates a cross-clarify suspension
// against this node, awaiting user decision.
//
// Behavior contract preserved from scheduler.ts:878-955:
//   1. Persistent-stop short-circuit (RFC-056 patch-4): if a prior
//      directive='stop' resolution exists, mint a fresh `done` so
//      cascade reruns advance without parking again.
//   2. Missing-questioner runtime defense: validator should catch this,
//      but if no questioner wired, fail-direct.
//   3. Common path: virtual-done; the actual cross-clarify session is
//      created when the questioner emits clarify (signal flow, not
//      dispatch flow).

import type {
  NodeKindHandler,
  DispatchContext,
  DispatchResult,
  AttemptContext,
  AttemptResult,
  NodeDecision,
  Event,
  Scope,
} from '@agent-workflow/shared'
import type { WorkflowNode } from '@agent-workflow/shared'

export interface ClarifyCrossAgentDispatchExtras {
  node: WorkflowNode
  /**
   * Returns true if any prior cross-clarify resolution at this node has
   * directive='stop' (RFC-056 patch-4 persistent stop). Reads from events
   * stream — no DB access.
   */
  hasPersistentStop: (events: ReadonlyArray<Event>, scope: Scope) => boolean
  /** Is there a questioner agent edged into this cross-clarify node? */
  hasQuestioner: (node: WorkflowNode) => boolean
}

export interface ClarifyCrossAgentDispatchContext
  extends DispatchContext<'clarify-cross-agent'>, ClarifyCrossAgentDispatchExtras {}

export const clarifyCrossAgentNodeKindHandler: NodeKindHandler<'clarify-cross-agent'> = {
  kind: 'clarify-cross-agent',

  async dispatch(ctx: DispatchContext<'clarify-cross-agent'>): Promise<DispatchResult> {
    const extras = ctx as ClarifyCrossAgentDispatchContext

    // 2. Runtime defense: missing questioner.
    if (!extras.hasQuestioner(extras.node)) {
      return {
        kind: 'fail-direct',
        errorMessage: `clarify-cross-agent ${extras.node.id} has no questioner input wired`,
      }
    }

    // 1. Persistent-stop short-circuit.
    if (extras.hasPersistentStop(ctx.events, ctx.scope)) {
      return {
        kind: 'virtual-done',
        outputs: {}, // no port outputs from a stop short-circuit
      }
    }

    // 3. Common path: virtual-done. The actual suspension is created
    //    when the questioner emits clarify (signal flow on a different
    //    logical_run, owned by the questioner agent's dispatcher).
    return { kind: 'virtual-done', outputs: {} }
  },

  async onAttemptFinished(_ctx: AttemptContext, _result: AttemptResult): Promise<NodeDecision> {
    throw new Error(
      'clarify-cross-agent NodeKind has no direct attempts — onAttemptFinished must not be called',
    )
  },
}
