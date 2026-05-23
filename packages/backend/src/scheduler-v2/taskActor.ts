// RFC-061 PR-B T9 — task actor main loop.
//
// design.md §6: one actor per task, consumes wake events in order,
// orchestrates everything. The pure-decision core (computeTickActions
// in taskActorTick.ts) does the per-NodeKind dispatch logic; the loop
// here is the runtime that:
//
//   1. Reads events for the task (chronological event log)
//   2. Runs scanReadyScopes + scanWrapperInnerCompletions
//   3. Calls computeTickActions on each ready scope
//   4. Calls writeEvents to persist outcomes + advance projections
//   5. Forwards spawnRequests to the RunnerAdapter
//   6. Handles attempt-exit wakes by invoking onAttemptFinished
//   7. Handles suspension auto-resolve (retry-pending-auto immediate fire)
//   8. Detects terminal task state, exits the loop
//
// The loop is async and abortable (AbortSignal). It runs until the
// queue closes or the task reaches terminal state.

import { asc, eq, isNull } from 'drizzle-orm'

import type { DbClient } from '../db/client'
import { events as eventsTable, logicalRuns, suspensions, tasks } from '../db/schema'
import { writeEvents, type NewEvent } from '../services/writeEvents'
import {
  type Event,
  type EventKind,
  type EventPayload,
  type RawEvent,
  RawEventSchema,
  decodeEvent,
  encodeEventPayload,
  type Scope,
  type WorkflowDefinition,
  type WorkflowNode,
  type SignalKind,
} from '@agent-workflow/shared'
import { ulid } from 'ulid'

import { NODE_KIND_HANDLERS, SIGNAL_KIND_HANDLERS } from '../handlers'
import type { UpstreamInput } from '../handlers'
import { computeTickActions, type TickContext, type ReadyScope } from './taskActorTick'
import { scanReadyScopes, scanWrapperInnerCompletions, type ReadyScanContext } from './readyScanner'
import type { RunnerAdapter } from './runnerAdapter'
import type { ActorState } from './actorRegistry'
import type { AttemptExitWake } from './wakeQueue'

export interface ActorRuntimeContext {
  db: DbClient
  taskId: string
  workflow: WorkflowDefinition
  inputsMap: Record<string, string>
  repoPath: string
  runner: RunnerAdapter
  /**
   * Read upstream port content from node_outputs at the given scope.
   * Closure injected so the actor stays test-friendly (mock can read
   * from a fixture map instead of the DB).
   */
  readUpstreamPort?: (
    upstreamNodeId: string,
    portName: string,
    scope: Scope,
  ) => Promise<string | null>
  /**
   * Resolve upstream input ports for an agent node. Same rationale as
   * readUpstreamPort — overrideable for tests.
   */
  resolveUpstreamInputs?: (nodeId: string, scope: Scope) => Promise<UpstreamInput[]>
}

/**
 * Run the actor loop until the queue closes / signal aborts / task
 * reaches terminal state.
 */
export async function runTaskActor(actor: ActorState, ctx: ActorRuntimeContext): Promise<void> {
  actor.running = true
  try {
    while (true) {
      const wake = await actor.queue.next()
      if (wake === null) break // queue closed
      if (ctx.runner === undefined) break // defensive — should never happen
      if (actor.abortController.signal.aborted) break
      actor.lastProcessedSeq = wake.seq
      actor.lastProcessedAt = Date.now()

      switch (wake.reason.kind) {
        case 'cancel':
          // Caller already aborted controller; just exit.
          return
        case 'attempt-exit':
          await handleAttemptExit(actor, ctx, wake.reason)
          break
        case 'timer':
          // For PR-B v1: timer wakes do nothing on their own; the
          // scan-and-dispatch step below already covers retry-backoff
          // because suspension-resolved events auto-fire bumps. Real
          // invariant-scan integration lands in a follow-up commit.
          break
        case 'event-applied':
          // event-applied wakes just trigger the scan-and-dispatch loop.
          // No-op handler here; loop body below does the work.
          break
      }

      // Run the scan/dispatch pass unless the actor was canceled mid-handler.
      if (actor.abortController.signal.aborted) break
      await scanAndDispatch(ctx)
      await processWrapperInnerCompletions(ctx)
      await autoResolveSuspensions(ctx)
      if (await isTaskTerminal(ctx)) break
    }
  } finally {
    actor.running = false
  }
}

/* ============================================================
 *  Loop steps
 * ============================================================ */

async function scanAndDispatch(ctx: ActorRuntimeContext): Promise<void> {
  const readyScopes = scanReadyScopes(toScanCtx(ctx))
  if (readyScopes.length === 0) return
  const tickEvents = await loadTaskEvents(ctx.db, ctx.taskId)
  const tickCtx = makeTickContext(ctx, tickEvents, readyScopes)
  const outcome = await computeTickActions(tickCtx)
  if (outcome.eventsToWrite.length > 0) {
    await writeEvents(ctx.db, outcome.eventsToWrite.map(toNewEvent))
  }
  for (const req of outcome.spawnRequests) {
    await ctx.runner.spawn(req)
  }
}

async function processWrapperInnerCompletions(ctx: ActorRuntimeContext): Promise<void> {
  const completions = scanWrapperInnerCompletions(toScanCtx(ctx))
  if (completions.length === 0) return
  const tickEvents = await loadTaskEvents(ctx.db, ctx.taskId)
  const newEvents: Event[] = []
  let tsCursor = Date.now()
  for (const c of completions) {
    const handler = NODE_KIND_HANDLERS[c.outerNode.kind as keyof typeof NODE_KIND_HANDLERS]
    if (!handler.onInnerScopeCompleted) continue
    // The handler decides whether the wrapper is done / needs to bump.
    // For PR-B v1 we pass minimal extras; the production adapters
    // (closures for git diff / loop exit eval / fanout aggregate) wire
    // in alongside the runner integration.
    const decision = await handler.onInnerScopeCompleted({
      scope: c.outerScope,
      innerScope: c.innerScopes[0]!, // representative; handler uses ctx data
      events: tickEvents,
    } as never)
    switch (decision.kind) {
      case 'done': {
        for (const [portName, content] of Object.entries(decision.outputs)) {
          newEvents.push(
            makeAttemptOutputCapturedEvent(ctx.taskId, c.outerScope, null, tsCursor++, {
              portName,
              content,
            }),
          )
        }
        newEvents.push(makeLogicalRunCompletedEvent(ctx.taskId, c.outerScope, tsCursor++))
        break
      }
      case 'fail':
        newEvents.push(
          makeLogicalRunCanceledEvent(ctx.taskId, c.outerScope, tsCursor++, decision.errorMessage),
        )
        break
      case 'request-retry-auto':
      case 'request-retry-human':
      case 'suspend':
        // wrapper handlers shouldn't return suspension/retry from
        // onInnerScopeCompleted in production; if a future handler
        // does, the SIGNAL_KIND_HANDLERS path applies.
        break
    }
  }
  if (newEvents.length > 0) {
    await writeEvents(ctx.db, newEvents.map(toNewEvent))
  }
}

async function autoResolveSuspensions(ctx: ActorRuntimeContext): Promise<void> {
  const openSuspensions = ctx.db
    .select()
    .from(suspensions)
    .where(isNull(suspensions.resolvedAt))
    .all() as Array<typeof suspensions.$inferSelect>

  for (const s of openSuspensions) {
    const sk = s.signalKind as SignalKind
    const handler = SIGNAL_KIND_HANDLERS[sk]
    if (!handler.autoResolve) continue
    const body = JSON.parse(s.payload) as unknown
    const resolution = await handler.autoResolve({
      id: s.id,
      signalKind: sk,
      scope: await scopeForLogicalRun(ctx.db, s.logicalRunId),
      body,
      createdAt: s.createdAt,
    })
    if (resolution === null) continue
    const tickEvents = await loadTaskEvents(ctx.db, ctx.taskId)
    const events = await handler.applyResolution(
      {
        scope: await scopeForLogicalRun(ctx.db, s.logicalRunId),
        suspensionId: s.id,
        events: tickEvents,
      } as never,
      resolution,
    )
    if (events.length > 0) {
      await writeEvents(ctx.db, events.map(toNewEvent))
    }
  }
}

async function handleAttemptExit(
  _actor: ActorState,
  ctx: ActorRuntimeContext,
  reason: AttemptExitWake,
): Promise<void> {
  const tickEvents = await loadTaskEvents(ctx.db, ctx.taskId)
  // Find the attempt's scope from prior attempt-started event in the log.
  let attemptScope: Scope | null = null
  for (const e of tickEvents) {
    if (e.kind !== 'attempt-started') continue
    if (e.attemptId !== reason.attemptId) continue
    if (e.nodeId === null || e.loopIter === null || e.shardKey === null || e.iter === null) continue
    attemptScope = { nodeId: e.nodeId, loopIter: e.loopIter, shardKey: e.shardKey, iter: e.iter }
    break
  }
  if (!attemptScope) {
    // No corresponding attempt-started — defensive: just write the
    // outcome event so the projection records it.
    await writeOutcomeEvent(ctx, reason, null)
    return
  }
  // Write the attempt-finished-* event first so projections update.
  await writeOutcomeEvent(ctx, reason, attemptScope)

  // Look up the node + invoke onAttemptFinished.
  const node = findNode(ctx.workflow, attemptScope.nodeId)
  if (!node) return
  const handler = NODE_KIND_HANDLERS[node.kind as keyof typeof NODE_KIND_HANDLERS]
  const decision = await handler.onAttemptFinished(
    { scope: attemptScope, attemptId: reason.attemptId, events: tickEvents },
    attemptResultFromWake(reason) as never,
  )

  const followups: Event[] = []
  let tsCursor = Date.now()
  switch (decision.kind) {
    case 'done': {
      // NodeKindHandler.onAttemptFinished('success') reads outputs from
      // pre-existing `attempt-output-captured` events the runner wrote
      // mid-attempt. Those events are already persisted, so we MUST NOT
      // re-emit them here — that would violate node_outputs' composite
      // PRIMARY KEY. Write only the logical-run-completed event.
      void decision.outputs
      followups.push(makeLogicalRunCompletedEvent(ctx.taskId, attemptScope, tsCursor++))
      break
    }
    case 'fail':
      followups.push(
        makeLogicalRunCanceledEvent(ctx.taskId, attemptScope, tsCursor++, decision.errorMessage),
      )
      break
    case 'suspend': {
      const sigHandler = SIGNAL_KIND_HANDLERS[decision.signalKind]
      const evs = await sigHandler.onSuspend(
        { scope: attemptScope, events: tickEvents } as never,
        decision.payload,
      )
      followups.push(...evs)
      break
    }
    case 'request-retry-auto': {
      const sigHandler = SIGNAL_KIND_HANDLERS['retry-pending-auto']
      const evs = await sigHandler.onSuspend({ scope: attemptScope, events: tickEvents } as never, {
        outcome: outcomeFromReason(reason),
        lastAttemptId: reason.attemptId,
        reason: reason.reason ?? decision.reason,
        remainingBudget: 3,
      })
      followups.push(...evs)
      break
    }
    case 'request-retry-human': {
      const sigHandler = SIGNAL_KIND_HANDLERS['retry-pending-human']
      const evs = await sigHandler.onSuspend({ scope: attemptScope, events: tickEvents } as never, {
        outcomes: [outcomeFromReason(reason)],
        attemptIds: [reason.attemptId],
        reason: reason.reason ?? decision.reason,
      })
      followups.push(...evs)
      break
    }
  }
  if (followups.length > 0) {
    await writeEvents(ctx.db, followups.map(toNewEvent))
  }
}

async function writeOutcomeEvent(
  ctx: ActorRuntimeContext,
  reason: AttemptExitWake,
  scope: Scope | null,
): Promise<void> {
  const now = Date.now()
  let payload: EventPayload<EventKind>
  let kind: EventKind
  switch (reason.outcome) {
    case 'success':
      kind = 'attempt-finished-success'
      payload = {} as EventPayload<'attempt-finished-success'>
      break
    case 'envelope-fail':
      kind = 'attempt-finished-envelope-fail'
      payload = { reason: reason.reason ?? '' } as EventPayload<'attempt-finished-envelope-fail'>
      break
    case 'crash':
      kind = 'attempt-finished-crash'
      payload = {
        ...(reason.exitCode !== undefined ? { exitCode: reason.exitCode } : {}),
        ...(reason.errorMessage !== undefined ? { errorMessage: reason.errorMessage } : {}),
      } as EventPayload<'attempt-finished-crash'>
      break
    case 'timeout':
      kind = 'attempt-finished-timeout'
      payload = { timeoutMs: 0 } as EventPayload<'attempt-finished-timeout'>
      break
    case 'canceled':
      kind = 'attempt-canceled'
      payload = {
        ...(reason.reason !== undefined ? { reason: reason.reason } : {}),
      } as EventPayload<'attempt-canceled'>
      break
  }
  const newEvent: NewEvent = {
    taskId: ctx.taskId,
    kind,
    payload,
    ...(scope !== null
      ? {
          nodeId: scope.nodeId,
          loopIter: scope.loopIter,
          shardKey: scope.shardKey,
          iter: scope.iter,
        }
      : {}),
    attemptId: reason.attemptId,
    actor: 'system',
    ts: now,
  }
  await writeEvents(ctx.db, [newEvent])
}

async function isTaskTerminal(ctx: ActorRuntimeContext): Promise<boolean> {
  const rows = ctx.db
    .select({ status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, ctx.taskId))
    .limit(1)
    .all()
  const status = rows[0]?.status
  return status === 'done' || status === 'failed' || status === 'canceled'
}

/* ============================================================
 *  Helpers
 * ============================================================ */

function toScanCtx(ctx: ActorRuntimeContext): ReadyScanContext {
  return { db: ctx.db, taskId: ctx.taskId, workflow: ctx.workflow }
}

function makeTickContext(
  ctx: ActorRuntimeContext,
  events: ReadonlyArray<Event>,
  readyScopes: ReadonlyArray<ReadyScope>,
): TickContext {
  return {
    taskId: ctx.taskId,
    workflow: ctx.workflow,
    events,
    readyScopes,
    inputsMap: ctx.inputsMap,
    repoPath: ctx.repoPath,
    readUpstreamPort: ctx.readUpstreamPort ?? (async () => null),
    resolveUpstreamInputs: ctx.resolveUpstreamInputs ?? (async () => []),
  }
}

async function loadTaskEvents(db: DbClient, taskId: string): Promise<Event[]> {
  const rows = db
    .select()
    .from(eventsTable)
    .where(eq(eventsTable.taskId, taskId))
    .orderBy(asc(eventsTable.id))
    .all() as Array<RawEvent>
  return rows.map((r) => decodeEvent(RawEventSchema.parse(r)))
}

async function scopeForLogicalRun(db: DbClient, logicalRunId: string): Promise<Scope> {
  const row = db
    .select({
      nodeId: logicalRuns.nodeId,
      loopIter: logicalRuns.loopIter,
      shardKey: logicalRuns.shardKey,
      iter: logicalRuns.iter,
    })
    .from(logicalRuns)
    .where(eq(logicalRuns.id, logicalRunId))
    .limit(1)
    .all()[0]
  if (!row) throw new Error(`logical_run ${logicalRunId} not found`)
  return {
    nodeId: row.nodeId,
    loopIter: row.loopIter,
    shardKey: row.shardKey,
    iter: row.iter,
  }
}

function findNode(workflow: WorkflowDefinition, nodeId: string): WorkflowNode | null {
  const nodes = (workflow as { nodes?: ReadonlyArray<WorkflowNode> }).nodes ?? []
  for (const n of nodes) {
    if (n.id === nodeId) return n
  }
  return null
}

function attemptResultFromWake(reason: AttemptExitWake): {
  kind: 'success' | 'envelope-fail' | 'crash' | 'timeout' | 'canceled'
  exitCode?: number
  errorMessage?: string
  reason?: string
  timeoutMs?: number
} {
  switch (reason.outcome) {
    case 'success':
      return { kind: 'success' }
    case 'envelope-fail':
      return { kind: 'envelope-fail', reason: reason.reason ?? '' } as {
        kind: 'envelope-fail'
        reason: string
      } as never
    case 'crash':
      return {
        kind: 'crash',
        ...(reason.exitCode !== undefined ? { exitCode: reason.exitCode } : {}),
        ...(reason.errorMessage !== undefined ? { errorMessage: reason.errorMessage } : {}),
      } as never
    case 'timeout':
      return { kind: 'timeout', timeoutMs: 0 } as never
    case 'canceled':
      return {
        kind: 'canceled',
        ...(reason.reason !== undefined ? { reason: reason.reason } : {}),
      } as never
  }
}

function outcomeFromReason(reason: AttemptExitWake): 'envelope-fail' | 'crash' | 'timeout' {
  if (reason.outcome === 'envelope-fail') return 'envelope-fail'
  if (reason.outcome === 'crash') return 'crash'
  if (reason.outcome === 'timeout') return 'timeout'
  return 'crash'
}

function toNewEvent(e: Event): NewEvent {
  return {
    id: e.id,
    taskId: e.taskId,
    ts: e.ts,
    kind: e.kind,
    nodeId: e.nodeId,
    loopIter: e.loopIter,
    shardKey: e.shardKey,
    iter: e.iter,
    attemptId: e.attemptId,
    parentEventId: e.parentEventId,
    actor: e.actor,
    resolutionId: e.resolutionId,
    payload: e.payload as EventPayload<EventKind>,
  }
}

/* ============================================================
 *  Local event builders (mirror taskActorTick.ts; kept local to
 *  taskActor for now — DRY consolidation in PR-B-followup)
 * ============================================================ */

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
