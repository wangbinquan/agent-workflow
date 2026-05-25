// RFC-061 PR-A T2 — KindHandler contracts (NodeKind × SignalKind).
//
// These interfaces declare the two-layer handler registry per
// design/RFC-061-execution-event-sourced/design.md §5. PR-A only ships
// the interface stubs + registry types; PR-B fills in the 9
// NodeKindHandler + 5 SignalKindHandler concrete implementations and
// wires them into the new taskActor.
//
// The `satisfies Record<...>` clauses on the registries force
// TypeScript to error out at compile time if any kind in the closed
// union lacks a handler — that exhaustiveness check is the structural
// guarantee that replaces today's "5 dispatchers each pick the current
// row with a different selector" pattern.

import { type NodeKind } from './schemas/workflow'
import { type Event, type Scope, type SignalKind } from './events'

/* ============================================================
 *  Shared types — actor refs, results, decisions
 * ============================================================ */

/**
 * Who or what is responsible for resolving a Suspension or owning an
 * Attempt. Encodes today's three sources of side-effect:
 *
 *   - 'system'         — scheduler-owned (retry-pending-auto autoResolve)
 *   - 'user'           — human in the loop (review / clarify / human-retry)
 *   - 'agent:<nodeId>' — another node in the same task graph (cross-clarify
 *                        rerun targets the upstream designer)
 *   - 'opencode:<sessionId>' — actor for attempt-subagent-* events
 */
export type ActorRef = 'system' | `user:${string}` | `agent:${string}` | `opencode:${string}`

/**
 * What a NodeKindHandler.dispatch returns. The taskActor inspects the
 * `kind` discriminator and writes the appropriate events.
 *
 * `suspend-direct` covers review / cross-clarify gate NodeKinds that have
 * no opencode subprocess — they read upstream output, then immediately
 * park the logical_run in `suspended` status awaiting a user decision.
 * The taskActor delegates to SIGNAL_KIND_HANDLERS[signalKind].onSuspend
 * to mint the suspension and any side-effect events (cross-clarify
 * cascades the questioner, etc.).
 */
export type DispatchResult =
  | { kind: 'spawn-attempt'; prompt: string; preSnapshot?: string }
  | { kind: 'virtual-done'; outputs: Record<string, string> }
  | { kind: 'enter-inner-scope'; innerScope: Scope }
  | { kind: 'enter-inner-scope-multi'; innerScopes: ReadonlyArray<Scope> }
  | {
      kind: 'suspend-direct'
      signalKind: SignalKind
      payload: unknown
      awaitsActor: ActorRef
    }
  | { kind: 'fail-direct'; errorMessage: string }
  | { kind: 'noop'; reason: string }

/**
 * What a NodeKindHandler.onAttemptFinished returns. Drives the taskActor's
 * next event-writing step.
 */
export type NodeDecision =
  | { kind: 'done'; outputs: Record<string, string> }
  | { kind: 'fail'; errorMessage: string }
  | {
      kind: 'suspend'
      signalKind: SignalKind
      payload: unknown
      awaitsActor: ActorRef
    }
  | { kind: 'request-retry-auto'; reason: string }
  | { kind: 'request-retry-human'; reason: string }

/* ============================================================
 *  PromptContext — output of buildPromptFromEvents (§10 of design.md)
 * ============================================================ */

/**
 * Aging-aware prompt sections passed to the NodeKindHandler.dispatch
 * implementation. Each SignalKindHandler.renderPromptSection contributes
 * one string; an empty string means "no relevant prior signal".
 */
export interface PromptContext {
  /** RFC-023 self-clarify Q&A history (post-baseline only) */
  selfClarifyQA: string
  /** RFC-056/059 cross-clarify designer feedback (post-baseline only) */
  externalFeedback: string
  /** RFC-005 reviewer feedback (post-baseline only, iterate/reject only) */
  reviewerFeedback: string
}

/* ============================================================
 *  Per-handler context bundles
 * ============================================================ */

export interface ReadyContext {
  scope: Scope
  events: ReadonlyArray<Event>
  /** Latest known status for each upstream node within the same loop/shard. */
  upstreamSummary: ReadonlyArray<{
    nodeId: string
    maxIter: number
    allDone: boolean
  }>
}

export interface DispatchContext<_K extends NodeKind> {
  scope: Scope
  /** Full event log for this task in chronological order */
  events: ReadonlyArray<Event>
  prompt: PromptContext
}

export interface AttemptContext {
  scope: Scope
  attemptId: string
  events: ReadonlyArray<Event>
}

export type AttemptResult =
  | { kind: 'success' }
  | { kind: 'envelope-fail'; reason: string }
  | { kind: 'crash'; exitCode?: number; errorMessage?: string }
  | { kind: 'timeout'; timeoutMs: number }
  | { kind: 'canceled'; reason?: string }

export interface InnerScopeCompletedContext {
  scope: Scope
  innerScope: Scope
  events: ReadonlyArray<Event>
}

/* ============================================================
 *  NodeKindHandler
 * ============================================================ */

export interface NodeKindHandler<K extends NodeKind> {
  readonly kind: K

  /**
   * Optional gate on dispatch. The default ("all upstream done AND
   * my.iter < max(upstream.iter)") is implemented in the scanner SQL;
   * this hook lets a NodeKind add extra preconditions (e.g.
   * wrapper-fanout: shard list non-empty).
   */
  readyCondition?(ctx: ReadyContext): boolean

  /**
   * Decide what to do next for this logical_run. Pure dispatch decision
   * — the taskActor writes the corresponding events afterward.
   */
  dispatch(ctx: DispatchContext<K>): Promise<DispatchResult>

  /**
   * Build the prompt context (aging-applied) for this node from the
   * event log. Defaults to the cross-cutting helper in
   * `promptFromEvents.ts`; only override if a NodeKind needs a custom
   * notion of "what counts as a fresh baseline".
   */
  buildPromptFromEvents?(events: ReadonlyArray<Event>, scope: Scope): PromptContext

  /**
   * Called after an Attempt finishes. Returns the next state transition;
   * the taskActor writes the resulting events.
   */
  onAttemptFinished(ctx: AttemptContext, result: AttemptResult): Promise<NodeDecision>

  /**
   * Called for wrapper-* NodeKinds when their inner scope completes
   * (every inner node reached terminal status). Non-wrapper kinds may
   * leave this undefined.
   */
  onInnerScopeCompleted?(ctx: InnerScopeCompletedContext): Promise<NodeDecision>
}

/* ============================================================
 *  SignalKindHandler
 * ============================================================ */

export interface SuspendContext<_K extends SignalKind> {
  scope: Scope
  events: ReadonlyArray<Event>
}

export interface ResolveContext<_K extends SignalKind> {
  scope: Scope
  suspensionId: string
  events: ReadonlyArray<Event>
}

export interface SuspensionRecord {
  id: string
  signalKind: SignalKind
  scope: Scope
  body: unknown
  createdAt: number
}

export interface ValidationResult {
  valid: boolean
  reason?: string
}

export type ResolveEffect = 'bump-iter' | 'no-bump'

export interface SignalKindHandler<K extends SignalKind> {
  readonly kind: K

  /**
   * Called when a NodeKindHandler returns `{ kind: 'suspend' }`. Returns
   * the events to write (typically [suspension-created] plus any
   * side-effect events such as cascading questioner mints).
   */
  onSuspend(ctx: SuspendContext<K>, body: unknown): Promise<ReadonlyArray<Event>>

  /** Validate the resolution payload (called before applyResolution). */
  validateResolution(payload: unknown): ValidationResult

  /**
   * Translate a user/system resolution into events. Typical shape: one
   * `suspension-resolved` event plus any side-effect events (e.g. a
   * review iterate writes `logical-run-iter-bumped` for the upstream
   * designer; a cross-clarify submit writes events for the cascading
   * questioner reruns).
   */
  applyResolution(ctx: ResolveContext<K>, payload: unknown): Promise<ReadonlyArray<Event>>

  /**
   * Auto-resolve hook. retry-pending-auto returns a non-null payload as
   * long as the retry budget allows; other kinds return null (waiting
   * for a user or external actor).
   */
  autoResolve?(suspension: SuspensionRecord): Promise<unknown | null>

  /**
   * Does resolving this signal bump the source logical_run's iter?
   *   - bump-iter: self-clarify / cross-clarify / review-iterate / retry-*
   *   - no-bump:   review-approve (stays at current iter, just promotes
   *                logical_run to done)
   *
   * Note: the discriminator between bump and no-bump for `review` depends
   * on the decision in the payload; SignalKindHandler.applyResolution
   * encodes that branching when writing events.
   */
  effectOnLogicalRun(): ResolveEffect | 'depends-on-payload'

  /**
   * Render the prompt-section contribution for this SignalKind based on
   * post-baseline `suspension-resolved` events. Called by
   * `buildPromptFromEvents`.
   */
  renderPromptSection(resolutions: ReadonlyArray<Event<'suspension-resolved'>>): string
}

/* ============================================================
 *  Registries
 *
 *  In PR-A these are intentionally `Partial<...>` — the structural
 *  registry types exist so backend services + tests can type against
 *  them, but no handlers are wired up yet. PR-B fills in the registry
 *  with 9 NodeKindHandler + 5 SignalKindHandler concrete entries; the
 *  registry types switch to `Record<...>` at that point and the
 *  `satisfies` clause hard-errors on a missing kind.
 * ============================================================ */

export type NodeKindHandlerRegistry = {
  [K in NodeKind]?: NodeKindHandler<K>
}

export type SignalKindHandlerRegistry = {
  [K in SignalKind]?: SignalKindHandler<K>
}

/**
 * Empty registry; populated in PR-B. Exported so PR-A tests can validate
 * the shape without depending on backend code.
 */
export const NODE_KIND_HANDLERS: NodeKindHandlerRegistry = {}

export const SIGNAL_KIND_HANDLERS: SignalKindHandlerRegistry = {}

/* ============================================================
 *  Re-exports for convenience
 * ============================================================ */
export type { NodeKind } from './schemas/workflow'
export type { SignalKind } from './events'
