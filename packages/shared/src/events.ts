// RFC-061 PR-A T2 — event taxonomy: closed EventKind union + per-kind payload
// Zod schemas + scope helpers + encode/decode for the SQLite row format.
//
// Adding a new EventKind requires three coordinated changes — anything less
// won't compile / will fail Zod at runtime:
//
//   1. Add the literal to `EventKindSchema`'s enum array below.
//   2. Add a payload schema to `EVENT_PAYLOAD_SCHEMAS` (the
//      `satisfies Record<EventKind, ZodTypeAny>` clause forces this).
//   3. Add the literal to the migration's CHECK constraint on `events.kind`.
//
// The 25-member EventKind union spans five lifecycle phases per
// design/RFC-061-execution-event-sourced/design.md §3:
//   - task-level (7)        whole-task state transitions
//   - logical-run-level (4) per (taskId, nodeId, loopIter, shardKey, iter)
//   - attempt-level (9)     per opencode subprocess
//   - suspension-level (3)  Suspension/Resolution lifecycle
//   - invariant-level (2)   anomaly detector outputs (RFC-053 P-3 retained)

import { z } from 'zod'

/* ============================================================
 *  Scope — (nodeId, loopIter, shardKey, iter) coordinates
 * ============================================================ */

/**
 * Stable identity of a logical_run within a task. Composite of:
 *   nodeId × loopIter × shardKey × iter
 *
 * Sentinel encoding: shardKey === '' means "non-fanout scope". Matches the
 * SQLite `shard_key TEXT NOT NULL DEFAULT ''` storage convention so the
 * natural UNIQUE indexes fire correctly.
 */
export interface Scope {
  nodeId: string
  loopIter: number
  shardKey: string
  iter: number
}

export const ScopeSchema = z.object({
  nodeId: z.string().min(1),
  loopIter: z.number().int().nonnegative(),
  shardKey: z.string(), // '' = non-fanout sentinel
  iter: z.number().int().nonnegative(),
}) satisfies z.ZodType<Scope>

/* ============================================================
 *  EventKind — 25 closed kinds
 * ============================================================ */

export const EVENT_KINDS = [
  // task-level (7)
  'task-created',
  'task-started',
  'task-paused',
  'task-canceled',
  'task-completed',
  'task-failed',
  'task-resumed-after-daemon-restart',
  // logical-run-level (4)
  'logical-run-created',
  'logical-run-iter-bumped',
  'logical-run-completed',
  'logical-run-canceled',
  // attempt-level (9)
  'attempt-started',
  'attempt-finished-success',
  'attempt-finished-envelope-fail',
  'attempt-finished-crash',
  'attempt-finished-timeout',
  'attempt-canceled',
  'attempt-output-captured',
  'attempt-subagent-tool-use',
  'attempt-subagent-output',
  // suspension-level (3)
  'suspension-created',
  'suspension-resolved',
  'suspension-terminated',
  // invariant-level (2)
  'invariant-alert-detected',
  'invariant-alert-resolved',
] as const

export const EventKindSchema = z.enum(EVENT_KINDS)
export type EventKind = z.infer<typeof EventKindSchema>

/* ============================================================
 *  SignalKind — 6 closed kinds (mirrored in suspensions.signal_kind)
 *  Defined here (not handlers.ts) so the suspension event payloads
 *  can reference it without cyclic imports.
 * ============================================================ */

export const SIGNAL_KINDS = [
  'self-clarify',
  'cross-clarify',
  'review',
  'retry-pending-auto',
  'retry-pending-human',
  'await-external-data',
] as const

export const SignalKindSchema = z.enum(SIGNAL_KINDS)
export type SignalKind = z.infer<typeof SignalKindSchema>

/* ============================================================
 *  Per-kind payload Zod schemas
 *  `satisfies Record<EventKind, z.ZodTypeAny>` enforces exhaustiveness
 *  at compile time — missing any key fails `tsc`.
 * ============================================================ */

const TaskCreatedPayload = z.object({
  workflowId: z.string().min(1),
})

const NoPayload = z.object({}).strict()

const TaskFailedPayload = z.object({
  reason: z.string(),
  failedNodeId: z.string().optional(),
})

const TaskCanceledPayload = z.object({
  reason: z.string().optional(),
})

const TaskPausedPayload = z.object({
  reason: z.string().optional(),
})

const TaskResumedAfterDaemonRestartPayload = z.object({
  crashedAttemptCount: z.number().int().nonnegative(),
})

const LogicalRunCreatedPayload = NoPayload

const LogicalRunIterBumpedPayload = z.object({
  triggerEventId: z.string(),
  triggerKind: z.enum([
    'suspension-resolved',
    'attempt-finished-success',
    'attempt-finished-envelope-fail',
    'attempt-finished-crash',
    'attempt-finished-timeout',
    'logical-run-completed', // inner-scope wrap-up triggers outer iter bump
    'user-retry', // user clicked "Retry" on a failed/done logical_run
  ]),
})

const LogicalRunCompletedPayload = NoPayload

const LogicalRunCanceledPayload = z.object({
  reason: z.string().optional(),
})

const AttemptStartedPayload = z.object({
  pid: z.number().int().optional(),
  opencodeSessionId: z.string().optional(),
  preSnapshot: z.string().optional(),
})

const AttemptFinishedSuccessPayload = NoPayload

const AttemptFinishedEnvelopeFailPayload = z.object({
  reason: z.string(),
})

const AttemptFinishedCrashPayload = z.object({
  exitCode: z.number().int().optional(),
  errorMessage: z.string().optional(),
})

const AttemptFinishedTimeoutPayload = z.object({
  timeoutMs: z.number().int().positive(),
})

const AttemptCanceledPayload = z.object({
  reason: z.string().optional(),
})

const AttemptOutputCapturedPayload = z.object({
  portName: z.string().min(1),
  content: z.string(),
})

const AttemptSubagentToolUsePayload = z.object({
  toolName: z.string().min(1),
  sessionId: z.string().min(1),
  detail: z.unknown().optional(),
})

const AttemptSubagentOutputPayload = z.object({
  sessionId: z.string().min(1),
  content: z.string(),
})

const SuspensionCreatedPayload = z.object({
  suspensionId: z.string().min(1),
  signalKind: SignalKindSchema,
  awaitsActor: z.string().min(1),
  /** signal-kind-specific body; validated by SignalKindHandler.validatePayload */
  body: z.unknown(),
})

const SuspensionResolvedPayload = z.object({
  suspensionId: z.string().min(1),
  signalKind: SignalKindSchema,
  /** signal-kind-specific decision; validated by SignalKindHandler.validateResolution */
  decision: z.unknown(),
})

const SuspensionTerminatedPayload = z.object({
  suspensionId: z.string().min(1),
  reason: z.string().min(1),
})

const InvariantAlertDetectedPayload = z.object({
  rule: z.string().min(1),
  detail: z.unknown(),
})

const InvariantAlertResolvedPayload = z.object({
  rule: z.string().min(1),
  resolvedBy: z.string().optional(),
})

export const EVENT_PAYLOAD_SCHEMAS = {
  'task-created': TaskCreatedPayload,
  'task-started': NoPayload,
  'task-paused': TaskPausedPayload,
  'task-canceled': TaskCanceledPayload,
  'task-completed': NoPayload,
  'task-failed': TaskFailedPayload,
  'task-resumed-after-daemon-restart': TaskResumedAfterDaemonRestartPayload,

  'logical-run-created': LogicalRunCreatedPayload,
  'logical-run-iter-bumped': LogicalRunIterBumpedPayload,
  'logical-run-completed': LogicalRunCompletedPayload,
  'logical-run-canceled': LogicalRunCanceledPayload,

  'attempt-started': AttemptStartedPayload,
  'attempt-finished-success': AttemptFinishedSuccessPayload,
  'attempt-finished-envelope-fail': AttemptFinishedEnvelopeFailPayload,
  'attempt-finished-crash': AttemptFinishedCrashPayload,
  'attempt-finished-timeout': AttemptFinishedTimeoutPayload,
  'attempt-canceled': AttemptCanceledPayload,
  'attempt-output-captured': AttemptOutputCapturedPayload,
  'attempt-subagent-tool-use': AttemptSubagentToolUsePayload,
  'attempt-subagent-output': AttemptSubagentOutputPayload,

  'suspension-created': SuspensionCreatedPayload,
  'suspension-resolved': SuspensionResolvedPayload,
  'suspension-terminated': SuspensionTerminatedPayload,

  'invariant-alert-detected': InvariantAlertDetectedPayload,
  'invariant-alert-resolved': InvariantAlertResolvedPayload,
} satisfies Record<EventKind, z.ZodTypeAny>

export type EventPayload<K extends EventKind> = z.infer<(typeof EVENT_PAYLOAD_SCHEMAS)[K]>

/* ============================================================
 *  Raw event row (DB shape) + typed decoded events
 * ============================================================ */

/**
 * Raw event row as persisted in SQLite. `payload` is a JSON string; use
 * `decodeEvent` to validate it against the per-kind schema and produce a
 * typed `Event`.
 */
export const RawEventSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  ts: z.number().int(),
  kind: EventKindSchema,
  nodeId: z.string().nullable(),
  loopIter: z.number().int().nullable(),
  shardKey: z.string().nullable(),
  iter: z.number().int().nullable(),
  attemptId: z.string().nullable(),
  parentEventId: z.string().nullable(),
  actor: z.string().min(1),
  resolutionId: z.string().nullable(),
  payload: z.string(),
})

export type RawEvent = z.infer<typeof RawEventSchema>

/**
 * Decoded event with kind-specific payload. The compile-time mapped type
 * means `e.kind === 'task-created'` narrows `e.payload` to
 * `{ workflowId: string }` automatically.
 */
export type Event<K extends EventKind = EventKind> = {
  [k in K]: {
    id: string
    taskId: string
    ts: number
    kind: k
    nodeId: string | null
    loopIter: number | null
    shardKey: string | null
    iter: number | null
    attemptId: string | null
    parentEventId: string | null
    actor: string
    resolutionId: string | null
    payload: EventPayload<k>
  }
}[K]

/* ============================================================
 *  encode / decode
 * ============================================================ */

/** Validate and JSON-encode a payload for one specific EventKind. */
export function encodeEventPayload<K extends EventKind>(kind: K, payload: EventPayload<K>): string {
  const schema = EVENT_PAYLOAD_SCHEMAS[kind] as z.ZodType<EventPayload<K>>
  const parsed = schema.parse(payload)
  return JSON.stringify(parsed)
}

/** Decode a raw event row from SQLite. Throws ZodError on schema mismatch. */
export function decodeEvent(raw: RawEvent): Event {
  const validated = RawEventSchema.parse(raw)
  const schema = EVENT_PAYLOAD_SCHEMAS[validated.kind]
  const payload = schema.parse(JSON.parse(validated.payload))
  // The cast is sound because schema[kind] returns EventPayload<kind>.
  return { ...validated, payload } as Event
}

/* ============================================================
 *  Scope helpers
 * ============================================================ */

/**
 * Does this event belong to the given scope? Compares each scope field
 * including the '' sentinel for shardKey.
 *
 * Returns false on task-level events (whose scope fields are all null) —
 * scope-bound consumers should filter such events out first.
 */
export function sameScope(
  event: Pick<Event, 'nodeId' | 'loopIter' | 'shardKey' | 'iter'>,
  scope: Scope,
): boolean {
  return (
    event.nodeId === scope.nodeId &&
    event.loopIter === scope.loopIter &&
    (event.shardKey ?? '') === scope.shardKey &&
    event.iter === scope.iter
  )
}

/**
 * Does this event live within the same (nodeId, loopIter, shardKey)
 * scope-prefix as the given Scope, ignoring iter? Used by aging to find
 * all baseline candidates within a scope.
 */
export function sameScopePrefix(
  event: Pick<Event, 'nodeId' | 'loopIter' | 'shardKey'>,
  scope: Pick<Scope, 'nodeId' | 'loopIter' | 'shardKey'>,
): boolean {
  return (
    event.nodeId === scope.nodeId &&
    event.loopIter === scope.loopIter &&
    (event.shardKey ?? '') === scope.shardKey
  )
}

/**
 * True iff the event has a fully-bound scope (nodeId / loopIter / shardKey /
 * iter all non-null). Task-level events return false.
 */
export function hasFullScope(
  event: Pick<Event, 'nodeId' | 'loopIter' | 'shardKey' | 'iter'>,
): boolean {
  return (
    event.nodeId !== null &&
    event.loopIter !== null &&
    event.shardKey !== null &&
    event.iter !== null
  )
}

/**
 * Project an event's scope columns to a `Scope` value, or null if any
 * scope field is missing. Throws if the event has partial scope (an
 * impossible state — a bug somewhere).
 */
export function eventScope(
  event: Pick<Event, 'kind' | 'nodeId' | 'loopIter' | 'shardKey' | 'iter'>,
): Scope | null {
  if (
    event.nodeId === null &&
    event.loopIter === null &&
    event.shardKey === null &&
    event.iter === null
  ) {
    return null
  }
  if (!hasFullScope(event)) {
    throw new Error(
      `event ${event.kind} has partial scope: ${JSON.stringify({
        nodeId: event.nodeId,
        loopIter: event.loopIter,
        shardKey: event.shardKey,
        iter: event.iter,
      })}`,
    )
  }
  return {
    nodeId: event.nodeId!,
    loopIter: event.loopIter!,
    shardKey: event.shardKey!,
    iter: event.iter!,
  }
}
