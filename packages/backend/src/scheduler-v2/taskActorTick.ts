// RFC-061 PR-B — taskActor decision core (single-tick pure function).
//
// design.md §6 calls for a single actor per task that consumes wake events
// in order. The orchestration loop (wake queue + abort signal + opencode
// spawn) is wired up in a follow-up commit; this file is the pure
// decision core that the loop calls on each tick:
//
//   computeTickActions(events, workflow, scope) →
//       { eventsToWrite[], spawnRequests[] }
//
// Keeping the core pure makes it trivially testable without DB or
// subprocess. The orchestrator (or tests) handles persisting events +
// actually spawning processes; the core just produces the "what should
// happen next" decisions.
//
// Inputs:
//   - events: full chronological event log for this task (read from
//     events table, ordered by id)
//   - workflow: the workflow definition snapshot
//   - readyScopes: list of (scope, NodeKind) ready to dispatch (from §7
//     SQL on logical_runs projection)
//
// Outputs:
//   - eventsToWrite: events to append (writeEvents will sequence them)
//   - spawnRequests: spawn-attempt requests for the orchestrator to fire

import type {
  Event,
  Scope,
  EventPayload,
  NodeKind,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'
import { encodeEventPayload, eventScope } from '@agent-workflow/shared'
import { ulid } from 'ulid'

import {
  NODE_KIND_HANDLERS,
  SIGNAL_KIND_HANDLERS,
  type AgentSingleDispatchContext,
  type ClarifyCrossAgentDispatchContext,
  type InputDispatchContext,
  type OutputDispatchContext,
  type ReviewDispatchContext,
  type WrapperGitDispatchContext,
  type WrapperLoopDispatchContext,
  type WrapperFanoutDispatchContext,
  type UpstreamInput,
} from '../handlers'

import { buildPromptFromEvents } from '@agent-workflow/shared'

export interface ReadyScope {
  scope: Scope
  node: WorkflowNode
}

export interface SpawnRequest {
  scope: Scope
  attemptId: string
  prompt: string
  preSnapshot?: string
  agentName: string
}

export interface TickContext {
  taskId: string
  workflow: WorkflowDefinition
  events: ReadonlyArray<Event>
  /**
   * Ready scopes (per §7 ready-check SQL). Caller is responsible for
   * computing this; the tick core just dispatches the corresponding
   * handler for each one.
   */
  readyScopes: ReadonlyArray<ReadyScope>
  inputsMap: Record<string, string>
  repoPath: string
  /**
   * Read upstream port content at a given scope. Closure over projection
   * tables; tests inject a fixture map.
   */
  readUpstreamPort: (
    upstreamNodeId: string,
    portName: string,
    scope: Scope,
  ) => Promise<string | null>
  /**
   * Resolve all upstream input ports for an agent node at the given scope,
   * in topological order matching scheduler's resolveUpstreamInputs.
   */
  resolveUpstreamInputs: (nodeId: string, scope: Scope) => Promise<UpstreamInput[]>
}

export interface TickOutcome {
  eventsToWrite: ReadonlyArray<Event>
  spawnRequests: ReadonlyArray<SpawnRequest>
}

/**
 * Compute the next set of actions for a task tick. Pure-ish: the closures
 * on TickContext are the only IO; the function itself doesn't read or
 * write the events table. The orchestrator (or test) is responsible for
 * persisting eventsToWrite atomically and firing spawnRequests.
 */
export async function computeTickActions(ctx: TickContext): Promise<TickOutcome> {
  const eventsToWrite: Event[] = []
  const spawnRequests: SpawnRequest[] = []
  let tsCursor = Date.now()

  for (const { scope, node } of ctx.readyScopes) {
    const promptCtx = buildPromptFromEvents(ctx.events, scope, SIGNAL_KIND_HANDLERS)
    const dispatchResult = await dispatchOne(node, scope, ctx, promptCtx)

    switch (dispatchResult.kind) {
      case 'spawn-attempt': {
        const agentName = pickString(node, 'agentName') ?? ''
        const attemptId = `att_${ulid()}`
        spawnRequests.push({
          scope,
          attemptId,
          prompt: dispatchResult.prompt,
          ...(dispatchResult.preSnapshot !== undefined
            ? { preSnapshot: dispatchResult.preSnapshot }
            : {}),
          agentName,
        })
        eventsToWrite.push(
          makeAttemptStartedEvent(ctx.taskId, scope, attemptId, tsCursor++, {
            preSnapshot: dispatchResult.preSnapshot,
          }),
        )
        break
      }
      case 'virtual-done': {
        for (const [portName, content] of Object.entries(dispatchResult.outputs)) {
          eventsToWrite.push(
            makeAttemptOutputCapturedEvent(ctx.taskId, scope, null, tsCursor++, {
              portName,
              content,
            }),
          )
        }
        eventsToWrite.push(makeLogicalRunCompletedEvent(ctx.taskId, scope, tsCursor++))
        break
      }
      case 'enter-inner-scope': {
        eventsToWrite.push(
          makeLogicalRunCreatedEvent(ctx.taskId, dispatchResult.innerScope, tsCursor++),
        )
        break
      }
      case 'enter-inner-scope-multi': {
        for (const inner of dispatchResult.innerScopes) {
          eventsToWrite.push(makeLogicalRunCreatedEvent(ctx.taskId, inner, tsCursor++))
        }
        break
      }
      case 'suspend-direct': {
        const handler = SIGNAL_KIND_HANDLERS[dispatchResult.signalKind]
        const susEvents = await handler.onSuspend(
          { scope, events: ctx.events },
          dispatchResult.payload,
        )
        eventsToWrite.push(...susEvents)
        break
      }
      case 'fail-direct': {
        eventsToWrite.push(
          makeLogicalRunCanceledEvent(ctx.taskId, scope, tsCursor++, dispatchResult.errorMessage),
        )
        break
      }
      case 'noop':
        // Skip; the orchestrator's next ready scan will pick this up
        // when conditions change.
        break
    }
  }

  return { eventsToWrite, spawnRequests }
}

/* ============================================================
 *  dispatchOne — assemble per-kind DispatchContext and call handler
 * ============================================================ */

async function dispatchOne(
  node: WorkflowNode,
  scope: Scope,
  ctx: TickContext,
  promptCtx: { selfClarifyQA: string; externalFeedback: string; reviewerFeedback: string },
): Promise<Awaited<ReturnType<(typeof NODE_KIND_HANDLERS)[NodeKind]['dispatch']>>> {
  const baseCtx = { scope, events: ctx.events, prompt: promptCtx }

  switch (node.kind) {
    case 'input': {
      const handler = NODE_KIND_HANDLERS.input
      const dctx: InputDispatchContext = {
        ...baseCtx,
        node,
        inputsMap: ctx.inputsMap,
      }
      return await handler.dispatch(dctx)
    }
    case 'output': {
      const handler = NODE_KIND_HANDLERS.output
      const dctx: OutputDispatchContext = {
        ...baseCtx,
        node,
        readUpstreamPort: ctx.readUpstreamPort,
      }
      return await handler.dispatch(dctx)
    }
    case 'agent-single': {
      const handler = NODE_KIND_HANDLERS['agent-single']
      const dctx: AgentSingleDispatchContext = {
        ...baseCtx,
        node,
        repoPath: ctx.repoPath,
        resolveUpstreamInputs: (sc) => ctx.resolveUpstreamInputs(node.id, sc),
      }
      return await handler.dispatch(dctx)
    }
    case 'wrapper-git': {
      const handler = NODE_KIND_HANDLERS['wrapper-git']
      const dctx: WrapperGitDispatchContext = {
        ...baseCtx,
        node,
        // Real snapshot happens in orchestrator; pure-tick returns empty token.
        snapshotWorktree: async () => '',
      }
      return await handler.dispatch(dctx)
    }
    case 'wrapper-loop': {
      const handler = NODE_KIND_HANDLERS['wrapper-loop']
      const dctx: WrapperLoopDispatchContext = {
        ...baseCtx,
        node,
      }
      return await handler.dispatch(dctx)
    }
    case 'wrapper-fanout': {
      const handler = NODE_KIND_HANDLERS['wrapper-fanout']
      const dctx: WrapperFanoutDispatchContext = {
        ...baseCtx,
        node,
        // Default: read shardSource port content + split. Closure-injected
        // in production; tests can override via TickContext extension.
        resolveShards: async () => [],
      }
      return await handler.dispatch(dctx)
    }
    case 'review': {
      const handler = NODE_KIND_HANDLERS.review
      const dctx: ReviewDispatchContext = {
        ...baseCtx,
        node,
        readDocContent: async (sc) => {
          // Default closure: read the first bound input port of the review node.
          // Production orchestrator injects a smarter resolver.
          const bindings = (node as { docPort?: { nodeId: string; portName: string } }).docPort
          if (!bindings) return null
          const content = await ctx.readUpstreamPort(bindings.nodeId, bindings.portName, sc)
          if (content === null) return null
          return { nodeId: bindings.nodeId, portName: bindings.portName, content }
        },
      }
      return await handler.dispatch(dctx)
    }
    case 'clarify': {
      const handler = NODE_KIND_HANDLERS.clarify
      return await handler.dispatch(baseCtx)
    }
    case 'clarify-cross-agent': {
      const handler = NODE_KIND_HANDLERS['clarify-cross-agent']
      const dctx: ClarifyCrossAgentDispatchContext = {
        ...baseCtx,
        node,
        hasPersistentStop: (events, sc) => {
          // Look for prior cross-clarify resolutions at this node with directive='stop'.
          for (const e of events) {
            if (e.kind !== 'suspension-resolved') continue
            const s = eventScope(e)
            if (!s || s.nodeId !== sc.nodeId) continue
            const p = e.payload as {
              signalKind?: string
              decision?: { directive?: string }
            }
            if (p.signalKind === 'cross-clarify' && p.decision?.directive === 'stop') {
              return true
            }
          }
          return false
        },
        hasQuestioner: (n) => {
          // Defensive default: assume true. Production orchestrator
          // overrides via graph topology check.
          void n
          return true
        },
      }
      return await handler.dispatch(dctx)
    }
  }
}

/* ============================================================
 *  Event builders (local — shared with handlers but private to tick)
 * ============================================================ */

function makeAttemptStartedEvent(
  taskId: string,
  scope: Scope,
  attemptId: string,
  ts: number,
  extras: { preSnapshot?: string | undefined },
): Event<'attempt-started'> {
  const id = `evt_${ulid()}`
  const payload: EventPayload<'attempt-started'> = {
    ...(extras.preSnapshot !== undefined ? { preSnapshot: extras.preSnapshot } : {}),
  }
  encodeEventPayload('attempt-started', payload)
  return {
    id,
    taskId,
    ts,
    kind: 'attempt-started',
    nodeId: scope.nodeId,
    loopIter: scope.loopIter,
    shardKey: scope.shardKey,
    iter: scope.iter,
    attemptId,
    parentEventId: null,
    actor: 'system',
    resolutionId: null,
    payload,
  }
}

function makeAttemptOutputCapturedEvent(
  taskId: string,
  scope: Scope,
  attemptId: string | null,
  ts: number,
  body: { portName: string; content: string },
): Event<'attempt-output-captured'> {
  const id = `evt_${ulid()}`
  const payload: EventPayload<'attempt-output-captured'> = body
  encodeEventPayload('attempt-output-captured', payload)
  return {
    id,
    taskId,
    ts,
    kind: 'attempt-output-captured',
    nodeId: scope.nodeId,
    loopIter: scope.loopIter,
    shardKey: scope.shardKey,
    iter: scope.iter,
    attemptId,
    parentEventId: null,
    actor: 'system',
    resolutionId: null,
    payload,
  }
}

function makeLogicalRunCompletedEvent(
  taskId: string,
  scope: Scope,
  ts: number,
): Event<'logical-run-completed'> {
  const id = `evt_${ulid()}`
  const payload = {}
  encodeEventPayload('logical-run-completed', payload)
  return {
    id,
    taskId,
    ts,
    kind: 'logical-run-completed',
    nodeId: scope.nodeId,
    loopIter: scope.loopIter,
    shardKey: scope.shardKey,
    iter: scope.iter,
    attemptId: null,
    parentEventId: null,
    actor: 'system',
    resolutionId: null,
    payload,
  }
}

function makeLogicalRunCanceledEvent(
  taskId: string,
  scope: Scope,
  ts: number,
  reason: string,
): Event<'logical-run-canceled'> {
  const id = `evt_${ulid()}`
  const payload = { reason }
  encodeEventPayload('logical-run-canceled', payload)
  return {
    id,
    taskId,
    ts,
    kind: 'logical-run-canceled',
    nodeId: scope.nodeId,
    loopIter: scope.loopIter,
    shardKey: scope.shardKey,
    iter: scope.iter,
    attemptId: null,
    parentEventId: null,
    actor: 'system',
    resolutionId: null,
    payload,
  }
}

function makeLogicalRunCreatedEvent(
  taskId: string,
  scope: Scope,
  ts: number,
): Event<'logical-run-created'> {
  const id = `evt_${ulid()}`
  const payload = {}
  encodeEventPayload('logical-run-created', payload)
  return {
    id,
    taskId,
    ts,
    kind: 'logical-run-created',
    nodeId: scope.nodeId,
    loopIter: scope.loopIter,
    shardKey: scope.shardKey,
    iter: scope.iter,
    attemptId: null,
    parentEventId: null,
    actor: 'system',
    resolutionId: null,
    payload,
  }
}

function pickString(node: WorkflowNode, key: string): string | null {
  const v = (node as Record<string, unknown>)[key]
  return typeof v === 'string' && v.length > 0 ? v : null
}
