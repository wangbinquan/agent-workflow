// RFC-061 PR-B — NodeKindHandler<'output'>
//
// Output nodes are display-only sinks: no subprocess, no envelope. Each
// output declares `ports[]` bindings of the form
// `{ name, bind: { nodeId, portName } }`; dispatch reads each bound
// upstream port from `node_outputs` and writes a copy at the output node's
// own scope so the detail page reads outputs uniformly.
//
// Behavior contract preserved from scheduler.ts runOneNode (lines 815-838):
//   - bindings list may be empty (legitimate "placeholder output")
//   - each binding resolves to (taskId, bind.nodeId, currentLoopIter,
//     shardKey='', latest iter) → port content
//   - missing upstream port content (yet to land) → noop ('upstream-not-ready')
//
// The taskActor's ready-scan in §7 SQL already ensures all upstream nodes
// are done at this scope before dispatch fires, so missing content here
// indicates a genuine bug — we surface it explicitly rather than padding.

import type {
  NodeKindHandler,
  DispatchContext,
  DispatchResult,
  AttemptContext,
  AttemptResult,
  NodeDecision,
  Scope,
} from '@agent-workflow/shared'
import type { WorkflowNode } from '@agent-workflow/shared'

export interface OutputBinding {
  name: string
  bind: { nodeId: string; portName: string }
}

/**
 * Extras the taskActor passes through DispatchContext for output nodes.
 * `readUpstreamPort` is a closure over (db, taskId) so the handler stays
 * pure-ish — it queries projection rather than knowing about drizzle.
 */
export interface OutputDispatchExtras {
  node: WorkflowNode
  /** Read a port's content at the upstream node, given the current scope. */
  readUpstreamPort: (
    upstreamNodeId: string,
    portName: string,
    scope: Scope,
  ) => Promise<string | null>
}

export interface OutputDispatchContext extends DispatchContext<'output'>, OutputDispatchExtras {}

export const outputNodeKindHandler: NodeKindHandler<'output'> = {
  kind: 'output',

  async dispatch(ctx: DispatchContext<'output'>): Promise<DispatchResult> {
    const extras = ctx as OutputDispatchContext
    const bindings = readBindings(extras.node, 'ports')

    const outputs: Record<string, string> = {}
    for (const b of bindings) {
      const content = await extras.readUpstreamPort(b.bind.nodeId, b.bind.portName, ctx.scope)
      if (content === null) {
        return {
          kind: 'noop',
          reason: `output ${extras.node.id} upstream ${b.bind.nodeId}.${b.bind.portName} not ready`,
        }
      }
      outputs[b.name] = content
    }
    return { kind: 'virtual-done', outputs }
  },

  async onAttemptFinished(_ctx: AttemptContext, _result: AttemptResult): Promise<NodeDecision> {
    throw new Error('output NodeKind has no attempts — onAttemptFinished must not be called')
  },
}

export function readBindings(node: WorkflowNode, key: string): OutputBinding[] {
  const arr = (node as Record<string, unknown>)[key]
  if (!Array.isArray(arr)) return []
  const out: OutputBinding[] = []
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    if (typeof rec.name !== 'string') continue
    const bind = rec.bind
    if (typeof bind !== 'object' || bind === null) continue
    const br = bind as Record<string, unknown>
    if (typeof br.nodeId !== 'string' || typeof br.portName !== 'string') continue
    out.push({ name: rec.name, bind: { nodeId: br.nodeId, portName: br.portName } })
  }
  return out
}
