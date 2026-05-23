// RFC-061 PR-B — NodeKindHandler<'clarify'>
//
// clarify nodes (RFC-023) are graph-level "passthrough" gates. Their job
// is to act as a topology anchor when an upstream agent emits
// <workflow-clarify> envelope mid-attempt. The actual self-clarify
// suspension is created by the agent's attempt event flow (the runner's
// envelope parser triggers `suspension-created` with signalKind=self-clarify
// against the agent's logical_run, NOT against this clarify node).
//
// scheduler.ts:866-876 confirms today's behavior: the clarify node itself
// is a no-op pass — graph-level visit just marks done so downstream nodes
// (the answers→agent edge) can proceed once a self-clarify session is
// closed.
//
// RFC-061: dispatch returns `virtual-done` with no outputs. The actual
// clarify Q&A travels through the agent's events stream + SignalKindHandler.

import type {
  NodeKindHandler,
  DispatchContext,
  DispatchResult,
  AttemptContext,
  AttemptResult,
  NodeDecision,
} from '@agent-workflow/shared'

export const clarifyNodeKindHandler: NodeKindHandler<'clarify'> = {
  kind: 'clarify',

  async dispatch(_ctx: DispatchContext<'clarify'>): Promise<DispatchResult> {
    return { kind: 'virtual-done', outputs: {} }
  },

  async onAttemptFinished(_ctx: AttemptContext, _result: AttemptResult): Promise<NodeDecision> {
    throw new Error(
      'clarify NodeKind has no direct attempts — onAttemptFinished must not be called',
    )
  },
}
