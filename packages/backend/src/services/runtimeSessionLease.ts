// Runtime-native conversation ownership and single-writer leases.
//
// This service deliberately knows nothing about executable bytes, runtime
// configuration, stores, or host isolation. It only prevents two node runs
// from writing the same native conversation concurrently.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { TERMINAL_NODE_RUN_STATUSES } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { nodeRunEvents, nodeRuns, runtimeSessionLeases } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import type { RuntimeKind } from '@/services/runtime/types'

export type RuntimeSessionLease = typeof runtimeSessionLeases.$inferSelect

export class RuntimeSessionLeaseError extends Error {
  readonly code = 'runtime-session-conflict' as const

  constructor(readonly reason: string) {
    super('runtime-session-conflict')
    this.name = 'RuntimeSessionLeaseError'
  }
}

export interface RuntimeSessionLeaseToken {
  protocol: RuntimeKind
  sessionId: string
  nodeRunId: string
  leaseNonceDigest: string
}

interface SessionOwnerInput {
  protocol: RuntimeKind
  sessionId: string
  taskId: string
  nodeId: string
  currentNodeRunId: string
  leaseNonceDigest: string
  leasedAt?: number
}

const TERMINAL = new Set<string>(TERMINAL_NODE_RUN_STATUSES)

function fail(reason: string): never {
  throw new RuntimeSessionLeaseError(reason)
}

function nonEmpty(value: string): void {
  if (value.length === 0) fail('invalid-input')
}

function leaseTime(value: number | undefined): number {
  const result = value ?? Date.now()
  if (!Number.isSafeInteger(result) || result < 0) fail('invalid-input')
  return result
}

function validate(input: SessionOwnerInput): void {
  nonEmpty(input.sessionId)
  nonEmpty(input.taskId)
  nonEmpty(input.nodeId)
  nonEmpty(input.currentNodeRunId)
  nonEmpty(input.leaseNonceDigest)
}

function constraintViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /runtime_session_leases|SQLITE_CONSTRAINT|UNIQUE constraint failed/i.test(message)
}

export function getRuntimeSessionLease(
  db: DbClient,
  protocol: RuntimeKind,
  sessionId: string,
): RuntimeSessionLease | undefined {
  nonEmpty(sessionId)
  return db
    .select()
    .from(runtimeSessionLeases)
    .where(
      and(
        eq(runtimeSessionLeases.protocol, protocol),
        eq(runtimeSessionLeases.sessionId, sessionId),
      ),
    )
    .get()
}

export function claimNewRuntimeSession(
  db: DbClient,
  input: SessionOwnerInput,
): RuntimeSessionLeaseToken {
  validate(input)
  const leasedAt = leaseTime(input.leasedAt)
  try {
    return dbTxSync(db, (tx) => {
      const run = tx
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .where(
          and(
            eq(nodeRuns.id, input.currentNodeRunId),
            eq(nodeRuns.taskId, input.taskId),
            eq(nodeRuns.nodeId, input.nodeId),
            eq(nodeRuns.status, 'running'),
            isNull(nodeRuns.opencodeSessionId),
          ),
        )
        .get()
      if (run === undefined) fail('run-not-claimable')

      tx.insert(runtimeSessionLeases)
        .values({
          protocol: input.protocol,
          sessionId: input.sessionId,
          taskId: input.taskId,
          nodeId: input.nodeId,
          createdNodeRunId: input.currentNodeRunId,
          leaseNodeRunId: input.currentNodeRunId,
          leaseNonceDigest: input.leaseNonceDigest,
          leasedAt,
          resetPending: false,
        })
        .run()
      tx.update(nodeRuns)
        .set({ opencodeSessionId: input.sessionId })
        .where(eq(nodeRuns.id, input.currentNodeRunId))
        .run()
      return {
        protocol: input.protocol,
        sessionId: input.sessionId,
        nodeRunId: input.currentNodeRunId,
        leaseNonceDigest: input.leaseNonceDigest,
      }
    })
  } catch (error) {
    if (error instanceof RuntimeSessionLeaseError) throw error
    if (constraintViolation(error)) fail('owner-conflict')
    throw error
  }
}

export function preclaimRuntimeSessionResume(
  db: DbClient,
  input: SessionOwnerInput,
): RuntimeSessionLeaseToken {
  validate(input)
  const leasedAt = leaseTime(input.leasedAt)
  return dbTxSync(db, (tx) => {
    const owner = tx
      .select()
      .from(runtimeSessionLeases)
      .where(
        and(
          eq(runtimeSessionLeases.protocol, input.protocol),
          eq(runtimeSessionLeases.sessionId, input.sessionId),
        ),
      )
      .get()
    if (owner === undefined) fail('owner-missing')
    if (owner.taskId !== input.taskId || owner.nodeId !== input.nodeId) fail('owner-mismatch')
    if (owner.resetPending) fail('reset-pending')

    const run = tx
      .select({ id: nodeRuns.id })
      .from(nodeRuns)
      .where(
        and(
          eq(nodeRuns.id, input.currentNodeRunId),
          eq(nodeRuns.taskId, input.taskId),
          eq(nodeRuns.nodeId, input.nodeId),
          eq(nodeRuns.status, 'running'),
          isNull(nodeRuns.opencodeSessionId),
        ),
      )
      .get()
    if (run === undefined) fail('run-not-claimable')

    const claimed = tx
      .update(runtimeSessionLeases)
      .set({
        leaseNodeRunId: input.currentNodeRunId,
        leaseNonceDigest: input.leaseNonceDigest,
        leasedAt,
        resetPending: false,
      })
      .where(
        and(
          eq(runtimeSessionLeases.protocol, input.protocol),
          eq(runtimeSessionLeases.sessionId, input.sessionId),
          isNull(runtimeSessionLeases.leaseNodeRunId),
          isNull(runtimeSessionLeases.leaseNonceDigest),
          isNull(runtimeSessionLeases.leasedAt),
        ),
      )
      .returning({ sessionId: runtimeSessionLeases.sessionId })
      .all()
    if (claimed.length !== 1) fail('lease-held')
    return {
      protocol: input.protocol,
      sessionId: input.sessionId,
      nodeRunId: input.currentNodeRunId,
      leaseNonceDigest: input.leaseNonceDigest,
    }
  })
}

export function confirmRuntimeSessionResume(
  db: DbClient,
  token: RuntimeSessionLeaseToken,
): boolean {
  return dbTxSync(db, (tx) => {
    const owner = tx
      .select({ taskId: runtimeSessionLeases.taskId, nodeId: runtimeSessionLeases.nodeId })
      .from(runtimeSessionLeases)
      .where(
        and(
          eq(runtimeSessionLeases.protocol, token.protocol),
          eq(runtimeSessionLeases.sessionId, token.sessionId),
          eq(runtimeSessionLeases.leaseNodeRunId, token.nodeRunId),
          eq(runtimeSessionLeases.leaseNonceDigest, token.leaseNonceDigest),
        ),
      )
      .get()
    if (owner === undefined) fail('lease-mismatch')
    const linked = tx
      .update(nodeRuns)
      .set({ opencodeSessionId: token.sessionId })
      .where(
        and(
          eq(nodeRuns.id, token.nodeRunId),
          eq(nodeRuns.taskId, owner.taskId),
          eq(nodeRuns.nodeId, owner.nodeId),
          eq(nodeRuns.status, 'running'),
          isNull(nodeRuns.opencodeSessionId),
        ),
      )
      .returning({ id: nodeRuns.id })
      .all()
    return linked.length === 1
  })
}

/**
 * Atomically move a running writer from a runtime-declared outgoing
 * conversation to the replacement native id observed after that boundary.
 * The outgoing owner row is removed: a reset supersedes that native
 * conversation, so leaving a neutral row would incorrectly make it resumable.
 */
export function rotateRuntimeSessionLease(
  db: DbClient,
  token: RuntimeSessionLeaseToken,
  nextSessionId: string,
): RuntimeSessionLeaseToken {
  nonEmpty(token.sessionId)
  nonEmpty(token.nodeRunId)
  nonEmpty(token.leaseNonceDigest)
  nonEmpty(nextSessionId)
  if (nextSessionId === token.sessionId) fail('invalid-input')

  try {
    return dbTxSync(db, (tx) => {
      const outgoing = tx
        .select()
        .from(runtimeSessionLeases)
        .where(
          and(
            eq(runtimeSessionLeases.protocol, token.protocol),
            eq(runtimeSessionLeases.sessionId, token.sessionId),
            eq(runtimeSessionLeases.leaseNodeRunId, token.nodeRunId),
            eq(runtimeSessionLeases.leaseNonceDigest, token.leaseNonceDigest),
          ),
        )
        .get()
      if (outgoing === undefined || outgoing.leasedAt === null || !outgoing.resetPending) {
        fail('lease-mismatch')
      }

      const run = tx
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .where(
          and(
            eq(nodeRuns.id, token.nodeRunId),
            eq(nodeRuns.taskId, outgoing.taskId),
            eq(nodeRuns.nodeId, outgoing.nodeId),
            eq(nodeRuns.status, 'running'),
            isNull(nodeRuns.opencodeSessionId),
          ),
        )
        .get()
      if (run === undefined) fail('run-not-claimable')

      const collision = tx
        .select({ sessionId: runtimeSessionLeases.sessionId })
        .from(runtimeSessionLeases)
        .where(
          and(
            eq(runtimeSessionLeases.protocol, token.protocol),
            eq(runtimeSessionLeases.sessionId, nextSessionId),
          ),
        )
        .get()
      if (collision !== undefined) fail('owner-conflict')

      tx.delete(runtimeSessionLeases)
        .where(
          and(
            eq(runtimeSessionLeases.protocol, token.protocol),
            eq(runtimeSessionLeases.sessionId, token.sessionId),
            eq(runtimeSessionLeases.leaseNodeRunId, token.nodeRunId),
            eq(runtimeSessionLeases.leaseNonceDigest, token.leaseNonceDigest),
          ),
        )
        .run()
      tx.insert(runtimeSessionLeases)
        .values({
          protocol: token.protocol,
          sessionId: nextSessionId,
          taskId: outgoing.taskId,
          nodeId: outgoing.nodeId,
          createdNodeRunId: outgoing.createdNodeRunId,
          leaseNodeRunId: token.nodeRunId,
          leaseNonceDigest: token.leaseNonceDigest,
          leasedAt: outgoing.leasedAt,
          resetPending: false,
        })
        .run()
      const linked = tx
        .update(nodeRuns)
        .set({ opencodeSessionId: nextSessionId })
        .where(and(eq(nodeRuns.id, token.nodeRunId), isNull(nodeRuns.opencodeSessionId)))
        .returning({ id: nodeRuns.id })
        .all()
      if (linked.length !== 1) fail('run-not-claimable')

      // A resumed clarification/retry is the same logical conversation. Move
      // prior rounds owned by A onto B too, otherwise the SessionTree's native
      // id join drops every pre-reset sibling once the current run points at B.
      const lineageRunIds = tx
        .select({ id: nodeRuns.id })
        .from(nodeRuns)
        .where(
          and(
            eq(nodeRuns.taskId, outgoing.taskId),
            eq(nodeRuns.nodeId, outgoing.nodeId),
            eq(nodeRuns.opencodeSessionId, token.sessionId),
          ),
        )
        .all()
        .map((row) => row.id)
      if (lineageRunIds.length > 0) {
        tx.update(nodeRuns)
          .set({ opencodeSessionId: nextSessionId })
          .where(inArray(nodeRuns.id, lineageRunIds))
          .run()
      }

      // SessionTree has one root bucket per logical node run. Retag the
      // already-persisted root epoch inside the same transaction so a legal
      // native reset does not strand pre-reset events under an orphan bucket;
      // each raw payload still preserves its wire session_id for forensics.
      tx.update(nodeRunEvents)
        .set({ sessionId: nextSessionId })
        .where(
          and(
            inArray(nodeRunEvents.nodeRunId, [token.nodeRunId, ...lineageRunIds]),
            eq(nodeRunEvents.sessionId, token.sessionId),
            isNull(nodeRunEvents.parentSessionId),
          ),
        )
        .run()
      tx.update(nodeRunEvents)
        .set({ parentSessionId: nextSessionId })
        .where(
          and(
            inArray(nodeRunEvents.nodeRunId, [token.nodeRunId, ...lineageRunIds]),
            eq(nodeRunEvents.parentSessionId, token.sessionId),
          ),
        )
        .run()

      return { ...token, sessionId: nextSessionId }
    })
  } catch (error) {
    if (error instanceof RuntimeSessionLeaseError) throw error
    if (constraintViolation(error)) fail('owner-conflict')
    throw error
  }
}

/**
 * Invalidate the resume pointer as soon as the runtime announces a reset.
 * The outgoing lease remains held until a replacement id is observed (and is
 * then atomically rotated) or normal reaping releases it. A crash between the
 * boundary and replacement can therefore never advertise the stale id.
 */
export function markRuntimeSessionResetPending(
  db: DbClient,
  token: RuntimeSessionLeaseToken,
): boolean {
  return dbTxSync(db, (tx) => {
    const held = tx
      .select({
        sessionId: runtimeSessionLeases.sessionId,
        resetPending: runtimeSessionLeases.resetPending,
      })
      .from(runtimeSessionLeases)
      .where(
        and(
          eq(runtimeSessionLeases.protocol, token.protocol),
          eq(runtimeSessionLeases.sessionId, token.sessionId),
          eq(runtimeSessionLeases.leaseNodeRunId, token.nodeRunId),
          eq(runtimeSessionLeases.leaseNonceDigest, token.leaseNonceDigest),
        ),
      )
      .get()
    if (held === undefined) fail('lease-mismatch')
    if (held.resetPending) return true
    const fenced = tx
      .update(runtimeSessionLeases)
      .set({ resetPending: true })
      .where(
        and(
          eq(runtimeSessionLeases.protocol, token.protocol),
          eq(runtimeSessionLeases.sessionId, token.sessionId),
          eq(runtimeSessionLeases.leaseNodeRunId, token.nodeRunId),
          eq(runtimeSessionLeases.leaseNonceDigest, token.leaseNonceDigest),
          eq(runtimeSessionLeases.resetPending, false),
        ),
      )
      .returning({ sessionId: runtimeSessionLeases.sessionId })
      .all()
    if (fenced.length !== 1) fail('lease-mismatch')
    const cleared = tx
      .update(nodeRuns)
      .set({ opencodeSessionId: null })
      .where(and(eq(nodeRuns.id, token.nodeRunId), eq(nodeRuns.opencodeSessionId, token.sessionId)))
      .returning({ id: nodeRuns.id })
      .all()
    return cleared.length === 1
  })
}

/** Remove a reset-invalidated outgoing owner after the child is proven reaped. */
export function discardRuntimeSessionLease(db: DbClient, token: RuntimeSessionLeaseToken): boolean {
  return dbTxSync(db, (tx) => {
    const held = tx
      .select({ sessionId: runtimeSessionLeases.sessionId })
      .from(runtimeSessionLeases)
      .where(
        and(
          eq(runtimeSessionLeases.protocol, token.protocol),
          eq(runtimeSessionLeases.sessionId, token.sessionId),
          eq(runtimeSessionLeases.leaseNodeRunId, token.nodeRunId),
          eq(runtimeSessionLeases.leaseNonceDigest, token.leaseNonceDigest),
        ),
      )
      .get()
    if (held === undefined) return false
    // A protocol contradiction invalidates both representations together.
    // This is intentionally idempotent with markRuntimeSessionResetPending.
    tx.update(nodeRuns)
      .set({ opencodeSessionId: null })
      .where(and(eq(nodeRuns.id, token.nodeRunId), eq(nodeRuns.opencodeSessionId, token.sessionId)))
      .run()
    const discarded = tx
      .delete(runtimeSessionLeases)
      .where(
        and(
          eq(runtimeSessionLeases.protocol, token.protocol),
          eq(runtimeSessionLeases.sessionId, token.sessionId),
          eq(runtimeSessionLeases.leaseNodeRunId, token.nodeRunId),
          eq(runtimeSessionLeases.leaseNonceDigest, token.leaseNonceDigest),
        ),
      )
      .returning({ sessionId: runtimeSessionLeases.sessionId })
      .all()
    return discarded.length === 1
  })
}

export function releaseRuntimeSessionLease(db: DbClient, token: RuntimeSessionLeaseToken): boolean {
  const released = db
    .update(runtimeSessionLeases)
    .set({ leaseNodeRunId: null, leaseNonceDigest: null, leasedAt: null })
    .where(
      and(
        eq(runtimeSessionLeases.protocol, token.protocol),
        eq(runtimeSessionLeases.sessionId, token.sessionId),
        eq(runtimeSessionLeases.leaseNodeRunId, token.nodeRunId),
        eq(runtimeSessionLeases.leaseNonceDigest, token.leaseNonceDigest),
        eq(runtimeSessionLeases.resetPending, false),
      ),
    )
    .returning({ sessionId: runtimeSessionLeases.sessionId })
    .all()
  return released.length === 1
}

/** Called only after boot orphan reaping has killed or rejected every live child. */
export function repairRuntimeSessionLeasesAfterOrphanReap(
  db: DbClient,
  orphanReapCompleted: true,
  nodeRunId?: string,
): number {
  if (orphanReapCompleted !== true) fail('invalid-input')
  let repaired = 0
  const held = db
    .select()
    .from(runtimeSessionLeases)
    .where(
      nodeRunId === undefined
        ? sql`${runtimeSessionLeases.leaseNodeRunId} IS NOT NULL`
        : eq(runtimeSessionLeases.leaseNodeRunId, nodeRunId),
    )
    .all()
  for (const lease of held) {
    if (lease.leaseNodeRunId === null || lease.leaseNonceDigest === null) continue
    const run = db
      .select({
        status: nodeRuns.status,
        sessionId: nodeRuns.opencodeSessionId,
        failureCode: nodeRuns.failureCode,
      })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, lease.leaseNodeRunId))
      .get()
    if (run === undefined || !TERMINAL.has(run.status)) continue
    const token = {
      protocol: lease.protocol,
      sessionId: lease.sessionId,
      nodeRunId: lease.leaseNodeRunId,
      leaseNonceDigest: lease.leaseNonceDigest,
    }
    // A terminal run whose durable resume pointer no longer names the held
    // id crossed a reset boundary and died before rotation completed. Delete
    // that invalidated owner instead of neutralizing it into a resumable row.
    const repairedLease =
      run.failureCode !== 'runtime-session-identity-invalid' &&
      !lease.resetPending &&
      run.sessionId === lease.sessionId
        ? releaseRuntimeSessionLease(db, token)
        : discardRuntimeSessionLease(db, token)
    if (repairedLease) {
      repaired += 1
    }
  }
  return repaired
}
