// RFC-061 PR-B — NodeKindHandler<'agent-single'>
//
// agent-single is the canonical agent dispatch path: read upstream inputs,
// compose a prompt from `node.promptTemplate`, return `spawn-attempt` so
// the taskActor spawns one opencode subprocess. After the attempt exits,
// `onAttemptFinished` maps the AttemptResult to a NodeDecision.
//
// Behavior contract preserved from scheduler.ts runOneNode (lines 978+):
//   - missing agentName → fail-direct
//   - upstream port input resolution → readUpstreamPort closure on ctx
//   - promptTemplate substitution → {{port_name}} + {{__repo_path__}}
//     etc. handled in `composePrompt` (shared with existing runner.ts)
//   - clarify Q&A and review comments are folded in via PromptContext
//     (built by `buildPromptFromEvents` upstream of dispatch)
//
// onAttemptFinished mapping (single source of truth — matches RFC-042 / RFC-052):
//   - success    → done (with outputs parsed from attempt-output-captured)
//   - env-fail   → request-retry-auto (signal handler decides budget; if
//                  exhausted, escalates to request-retry-human)
//   - crash      → request-retry-auto
//   - timeout    → request-retry-auto
//   - canceled   → noop-ish → returned as a `fail` decision so the taskActor
//                  writes logical-run-canceled (cancel is a unidirectional
//                  state shift; we don't auto-retry canceled attempts)

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
import { eventScope } from '@agent-workflow/shared'

export interface UpstreamInput {
  portName: string
  content: string
}

export interface AgentSingleDispatchExtras {
  node: WorkflowNode
  /**
   * Read all upstream ports + their content at the current scope. Returns
   * the resolved bindings in topological order (matches today's
   * resolveUpstreamInputs ordering so prompt template substitution stays
   * deterministic).
   */
  resolveUpstreamInputs: (scope: Scope) => Promise<UpstreamInput[]>
  /** Repo worktree path; substituted as `{{__repo_path__}}` in prompt template. */
  repoPath: string
}

export interface AgentSingleDispatchContext
  extends DispatchContext<'agent-single'>, AgentSingleDispatchExtras {}

export const agentSingleNodeKindHandler: NodeKindHandler<'agent-single'> = {
  kind: 'agent-single',

  async dispatch(ctx: DispatchContext<'agent-single'>): Promise<DispatchResult> {
    const extras = ctx as AgentSingleDispatchContext
    const agentName = pickString(extras.node, 'agentName')
    if (agentName === null) {
      return {
        kind: 'fail-direct',
        errorMessage: `node ${extras.node.id} missing agentName`,
      }
    }

    const template = pickString(extras.node, 'promptTemplate') ?? ''
    const upstreams = await extras.resolveUpstreamInputs(ctx.scope)
    const prompt = composePrompt(template, upstreams, extras.repoPath, ctx.prompt)

    return { kind: 'spawn-attempt', prompt }
  },

  async onAttemptFinished(ctx: AttemptContext, result: AttemptResult): Promise<NodeDecision> {
    switch (result.kind) {
      case 'success': {
        // Pull every attempt-output-captured event for THIS attempt and
        // surface them as the node's outputs. The taskActor already wrote
        // these events from the runner's envelope parser; we just shape
        // them into a Record for downstream consumers.
        const outputs: Record<string, string> = {}
        for (const e of ctx.events) {
          if (e.kind !== 'attempt-output-captured') continue
          if (e.attemptId !== ctx.attemptId) continue
          const scope = eventScope(e)
          if (!scope) continue
          if (
            scope.nodeId !== ctx.scope.nodeId ||
            scope.loopIter !== ctx.scope.loopIter ||
            scope.shardKey !== ctx.scope.shardKey ||
            scope.iter !== ctx.scope.iter
          )
            continue
          const p = e.payload
          if (typeof p === 'object' && p !== null && 'portName' in p && 'content' in p) {
            outputs[(p as { portName: string }).portName] = (p as { content: string }).content
          }
        }
        return { kind: 'done', outputs }
      }
      case 'envelope-fail':
        return { kind: 'request-retry-auto', reason: `envelope-fail: ${result.reason}` }
      case 'crash':
        return {
          kind: 'request-retry-auto',
          reason: `crash exit=${result.exitCode ?? '?'}: ${result.errorMessage ?? ''}`,
        }
      case 'timeout':
        return { kind: 'request-retry-auto', reason: `timeout ${result.timeoutMs}ms` }
      case 'canceled':
        return { kind: 'fail', errorMessage: `attempt canceled: ${result.reason ?? ''}` }
    }
  },
}

/**
 * Compose the final prompt string from:
 *   - the template (with {{port_name}} placeholders)
 *   - upstream port outputs (substituted into placeholders)
 *   - aged-prompt sections (clarify Q&A / cross-clarify feedback / review)
 *   - {{__repo_path__}} substitution
 *
 * Exported for unit-test access; mirrors the prompt composition rules
 * documented in design/design.md §node-prompt.
 */
export function composePrompt(
  template: string,
  upstreams: ReadonlyArray<UpstreamInput>,
  repoPath: string,
  promptCtx: { selfClarifyQA: string; externalFeedback: string; reviewComments: string },
): string {
  let body = template
  for (const u of upstreams) {
    body = body.split(`{{${u.portName}}}`).join(u.content)
  }
  body = body.split('{{__repo_path__}}').join(repoPath)

  // Append signal context sections in deterministic order; each section
  // contributes only if non-empty (SignalKindHandler.renderPromptSection
  // returns '' when there's no relevant resolution).
  const sections: string[] = []
  if (promptCtx.selfClarifyQA) sections.push(promptCtx.selfClarifyQA)
  if (promptCtx.externalFeedback) sections.push(promptCtx.externalFeedback)
  if (promptCtx.reviewComments) sections.push(promptCtx.reviewComments)
  if (sections.length === 0) return body
  return `${body}\n\n${sections.join('\n\n')}`
}

function pickString(node: WorkflowNode, key: string): string | null {
  const v = (node as Record<string, unknown>)[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}
