// RFC-061 PR-B — shared event builder helpers for SignalKindHandlers.
//
// All 5 SignalKindHandlers mint the same basic event shapes (suspension-
// created, suspension-resolved, suspension-terminated, logical-run-iter-
// bumped). Hoist them here so each handler can stay focused on its
// kind-specific payload validation and prompt rendering logic.
//
// The builders return typed `Event<K>` objects; the taskActor's
// writeEvents (RFC-061 PR-A) takes them and persists with monotonic ULIDs.

import type { Event, EventPayload, Scope, SignalKind, ActorRef } from '@agent-workflow/shared'
import { encodeEventPayload } from '@agent-workflow/shared'
import { ulid } from 'ulid'

export interface EventBuilderContext {
  taskId: string
  scope: Scope
  ts: number
}

export function makeSuspensionCreatedEvent(
  ctx: EventBuilderContext,
  suspensionId: string,
  signalKind: SignalKind,
  awaitsActor: ActorRef,
  body: unknown,
): Event<'suspension-created'> {
  const id = `evt_${ulid()}`
  const payload: EventPayload<'suspension-created'> = {
    suspensionId,
    signalKind,
    awaitsActor,
    body,
  }
  encodeEventPayload('suspension-created', payload)
  return {
    id,
    taskId: ctx.taskId,
    ts: ctx.ts,
    kind: 'suspension-created',
    nodeId: ctx.scope.nodeId,
    loopIter: ctx.scope.loopIter,
    shardKey: ctx.scope.shardKey,
    iter: ctx.scope.iter,
    attemptId: null,
    parentEventId: null,
    actor: 'system',
    resolutionId: null,
    payload,
  }
}

export function makeSuspensionResolvedEvent(
  ctx: EventBuilderContext,
  suspensionId: string,
  signalKind: SignalKind,
  decision: unknown,
  resolutionId: string,
  resolverActor: ActorRef,
): Event<'suspension-resolved'> {
  const id = `evt_${ulid()}`
  const payload: EventPayload<'suspension-resolved'> = {
    suspensionId,
    signalKind,
    decision,
  }
  encodeEventPayload('suspension-resolved', payload)
  return {
    id,
    taskId: ctx.taskId,
    ts: ctx.ts,
    kind: 'suspension-resolved',
    nodeId: ctx.scope.nodeId,
    loopIter: ctx.scope.loopIter,
    shardKey: ctx.scope.shardKey,
    iter: ctx.scope.iter,
    attemptId: null,
    parentEventId: null,
    actor: resolverActor,
    resolutionId,
    payload,
  }
}

export function makeSuspensionTerminatedEvent(
  ctx: EventBuilderContext,
  suspensionId: string,
  reason: string,
  actor: ActorRef = 'system',
): Event<'suspension-terminated'> {
  const id = `evt_${ulid()}`
  const payload: EventPayload<'suspension-terminated'> = { suspensionId, reason }
  encodeEventPayload('suspension-terminated', payload)
  return {
    id,
    taskId: ctx.taskId,
    ts: ctx.ts,
    kind: 'suspension-terminated',
    nodeId: ctx.scope.nodeId,
    loopIter: ctx.scope.loopIter,
    shardKey: ctx.scope.shardKey,
    iter: ctx.scope.iter,
    attemptId: null,
    parentEventId: null,
    actor,
    resolutionId: null,
    payload,
  }
}

export function makeLogicalRunIterBumpedEvent(
  ctx: EventBuilderContext,
  targetScope: Scope,
  triggerEventId: string,
  triggerKind:
    | 'suspension-resolved'
    | 'attempt-finished-success'
    | 'attempt-finished-envelope-fail'
    | 'attempt-finished-crash'
    | 'attempt-finished-timeout'
    | 'logical-run-completed',
): Event<'logical-run-iter-bumped'> {
  const id = `evt_${ulid()}`
  const payload: EventPayload<'logical-run-iter-bumped'> = { triggerEventId, triggerKind }
  encodeEventPayload('logical-run-iter-bumped', payload)
  return {
    id,
    taskId: ctx.taskId,
    ts: ctx.ts,
    kind: 'logical-run-iter-bumped',
    nodeId: targetScope.nodeId,
    loopIter: targetScope.loopIter,
    shardKey: targetScope.shardKey,
    iter: targetScope.iter + 1,
    attemptId: null,
    parentEventId: null,
    actor: 'system',
    resolutionId: null,
    payload,
  }
}

export function inferTaskId(events: ReadonlyArray<Event>): string {
  const first = events[0]
  if (!first) {
    throw new Error(
      'cannot synthesize event without prior events context (taskId unknown — pass at least one task event)',
    )
  }
  return first.taskId
}

export function newSuspensionId(): string {
  return `sus_${ulid()}`
}

export function newResolutionId(): string {
  return `res_${ulid()}`
}
