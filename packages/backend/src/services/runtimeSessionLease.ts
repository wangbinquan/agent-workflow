// Runtime-native conversation ownership and single-writer leases.
//
// This service deliberately knows nothing about executable bytes, runtime
// configuration, stores, or host isolation. It only prevents two node runs
// from writing the same native conversation concurrently.

import { and, eq, isNull, sql } from 'drizzle-orm'
import { TERMINAL_NODE_RUN_STATUSES } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { nodeRuns, runtimeSessionLeases } from '@/db/schema'
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
): number {
  if (orphanReapCompleted !== true) fail('invalid-input')
  let repaired = 0
  const held = db
    .select()
    .from(runtimeSessionLeases)
    .where(sql`${runtimeSessionLeases.leaseNodeRunId} IS NOT NULL`)
    .all()
  for (const lease of held) {
    if (lease.leaseNodeRunId === null || lease.leaseNonceDigest === null) continue
    const run = db
      .select({ status: nodeRuns.status })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, lease.leaseNodeRunId))
      .get()
    if (run === undefined || !TERMINAL.has(run.status)) continue
    if (
      releaseRuntimeSessionLease(db, {
        protocol: lease.protocol,
        sessionId: lease.sessionId,
        nodeRunId: lease.leaseNodeRunId,
        leaseNonceDigest: lease.leaseNonceDigest,
      })
    ) {
      repaired += 1
    }
  }
  return repaired
}
