// RFC-061 PR-B — NodeKindHandler<'input'>
//
// Input nodes are workflow entry points: each input declares an `inputKey`
// and the per-task `inputsMap` (set on task launch) carries the value the
// user picked / typed / uploaded. Dispatching an input node = capture that
// value as `attempt-output-captured` (port name = inputKey) then mark the
// logical_run `done` — no opencode subprocess.
//
// Behavior contract preserved from scheduler.ts runOneNode (lines 958-975):
//   - missing inputKey → fail-direct with explicit message
//   - port name = inputKey (RFC-004; canvas edges resolve via this name)
//   - empty value tolerated (input may legitimately be optional)

import type {
  NodeKindHandler,
  DispatchContext,
  DispatchResult,
  AttemptContext,
  AttemptResult,
  NodeDecision,
} from '@agent-workflow/shared'
import type { WorkflowNode } from '@agent-workflow/shared'

/**
 * Per-task input map; the taskActor caches `inputsMap` for the running
 * task and injects it into DispatchContext when invoking input handlers.
 *
 * Kept as a separate interface (instead of widening DispatchContext) so
 * NodeKinds that don't need inputs stay agnostic.
 */
export interface InputDispatchExtras {
  inputsMap: Record<string, string>
  node: WorkflowNode
}

export interface InputDispatchContext extends DispatchContext<'input'>, InputDispatchExtras {}

export const inputNodeKindHandler: NodeKindHandler<'input'> = {
  kind: 'input',

  async dispatch(ctx: DispatchContext<'input'>): Promise<DispatchResult> {
    const extras = ctx as InputDispatchContext
    const inputKey = pickInputKey(extras.node)
    if (inputKey === null) {
      return {
        kind: 'fail-direct',
        errorMessage: `input node ${extras.node.id} missing inputKey`,
      }
    }
    const value = extras.inputsMap[inputKey] ?? ''
    return {
      kind: 'virtual-done',
      outputs: { [inputKey]: value },
    }
  },

  async onAttemptFinished(_ctx: AttemptContext, _result: AttemptResult): Promise<NodeDecision> {
    // Input nodes never spawn attempts; if the taskActor calls this it's
    // a bug — surface immediately rather than silently mis-routing.
    throw new Error('input NodeKind has no attempts — onAttemptFinished must not be called')
  },
}

function pickInputKey(node: WorkflowNode): string | null {
  const v = (node as Record<string, unknown>).inputKey
  return typeof v === 'string' && v.length > 0 ? v : null
}
