// RFC-061 PR-A T2 — aging-aware prompt-context builder (pure function).
//
// Today's `computeHistoryCutoff` + 3 consumerKind branches across 4 files
// collapses here into a single predicate: `fromIter >= baselineIter`,
// where `baselineIter` = max iter at which the same logical_run captured
// a valid `attempt-output-captured` event. Everything that happened at
// or after that baseline is "live"; everything before is aged out.
//
// This file is intentionally **dependency-free** beyond `events.ts` —
// it is consumed by both shared (tests) and backend (taskActor), so any
// IO / DB references would break the boundary. Concrete SignalKind
// renderers live in `handlers.ts` (interface) and PR-B's backend
// `handlers/signalKind/*.ts` (implementations).

import { type Event, type EventKind, type Scope, sameScopePrefix } from './events'
import { type PromptContext, type SignalKindHandlerRegistry } from './handlers'

/**
 * Find the highest `iter` at which the (nodeId, loopIter, shardKey)
 * scope captured a valid envelope output. -1 if no captured output
 * exists yet (first dispatch).
 *
 * Why `attempt-output-captured` and not `attempt-finished-success`?
 * A finished attempt may still have written zero ports (envelope-fail
 * triggers retry, not aging). The captured-output event is the precise
 * signal "ports were validated by RFC-049 and persisted to
 * node_outputs"; that's the only definition of "fresh enough to be
 * the new baseline" that the design.md §10 spec recognizes.
 */
export function computeBaselineIter(
  events: ReadonlyArray<Event>,
  scope: Pick<Scope, 'nodeId' | 'loopIter' | 'shardKey'>,
): number {
  let max = -1
  for (const e of events) {
    if (e.kind !== 'attempt-output-captured') continue
    if (!sameScopePrefix(e, scope)) continue
    if (e.iter === null) continue
    if (e.iter > max) max = e.iter
  }
  return max
}

/**
 * The set of EventKinds whose resolutions feed into the prompt context.
 * `retry-pending-*` is excluded — those are control-flow signals, not
 * user-visible feedback.
 */
const PROMPT_RELEVANT_SIGNAL_KINDS = new Set(['self-clarify', 'cross-clarify', 'review'])

/**
 * Find post-baseline suspension-resolved events for the given scope.
 * "Post-baseline" means: the suspension's source iter was strictly
 * greater than or equal to baselineIter. Older resolutions are
 * structurally aged out — design.md §10 §G7.
 */
export function selectFreshResolutions(
  events: ReadonlyArray<Event>,
  scope: Scope,
  baselineIter: number,
): ReadonlyArray<Event<'suspension-resolved'>> {
  const out: Array<Event<'suspension-resolved'>> = []
  for (const e of events) {
    if (e.kind !== 'suspension-resolved') continue
    if (!sameScopePrefix(e, scope)) continue
    if (e.iter === null) continue
    // The resolution's `iter` is the iter at which the suspension was
    // created. We keep it when iter >= baselineIter so that all signals
    // accrued since the last fresh output survive into the next
    // dispatch's prompt. baselineIter = -1 (no prior output yet) keeps
    // everything.
    if (e.iter < baselineIter) continue
    const payload = e.payload as { signalKind?: string }
    if (!payload?.signalKind || !PROMPT_RELEVANT_SIGNAL_KINDS.has(payload.signalKind)) {
      continue
    }
    out.push(e as Event<'suspension-resolved'>)
  }
  return out
}

/**
 * Build the aging-aware prompt context for one scope from an event log.
 * Pure function: no IO, no DB. Caller passes the SignalKindHandler
 * registry; PR-A passes a stub registry, PR-B passes the real one.
 *
 * The returned `PromptContext` is consumed by NodeKindHandler.dispatch
 * to render the agent prompt. Each section is an already-rendered
 * markdown block (or empty string).
 */
export function buildPromptFromEvents(
  events: ReadonlyArray<Event>,
  scope: Scope,
  registry: SignalKindHandlerRegistry,
): PromptContext {
  const baselineIter = computeBaselineIter(events, scope)
  const fresh = selectFreshResolutions(events, scope, baselineIter)

  // Group by signalKind for handler dispatch.
  const bySignal = new Map<string, Array<Event<'suspension-resolved'>>>()
  for (const e of fresh) {
    const payload = e.payload as { signalKind: string }
    const arr = bySignal.get(payload.signalKind) ?? []
    arr.push(e)
    bySignal.set(payload.signalKind, arr)
  }

  const selfClarifyHandler = registry['self-clarify']
  const crossClarifyHandler = registry['cross-clarify']
  const reviewHandler = registry['review']

  return {
    selfClarifyQA:
      selfClarifyHandler?.renderPromptSection(bySignal.get('self-clarify') ?? []) ?? '',
    externalFeedback:
      crossClarifyHandler?.renderPromptSection(bySignal.get('cross-clarify') ?? []) ?? '',
    reviewerFeedback: reviewHandler?.renderPromptSection(bySignal.get('review') ?? []) ?? '',
  }
}

/**
 * Smoke-test helper: returns the set of EventKinds that
 * `buildPromptFromEvents` actually consults. Tests use this to assert
 * the function is not silently widening its event surface.
 */
export const PROMPT_CONSUMED_EVENT_KINDS: ReadonlySet<EventKind> = new Set<EventKind>([
  'attempt-output-captured',
  'suspension-resolved',
])
