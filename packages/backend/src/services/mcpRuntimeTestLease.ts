// Native-session single-writer leases for the MCP playground.

import { and, eq, isNull } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import {
  mcpRuntimeTestEvents,
  mcpRuntimeTestSessionLeases,
  mcpRuntimeTestSessions,
  mcpRuntimeTestTurns,
} from '@/db/schema'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import type { RuntimeKind } from '@/services/runtime/types'

export interface McpRuntimeTestLeaseToken {
  protocol: RuntimeKind
  runtimeSessionId: string
  testSessionId: string
  turnId: string
  leaseNonceDigest: string
}

export class McpRuntimeTestLeaseError extends Error {
  readonly code = 'mcp-test-session-conflict' as const

  constructor(readonly reason: string) {
    super('mcp-test-session-conflict')
    this.name = 'McpRuntimeTestLeaseError'
  }
}

interface LeaseInput extends McpRuntimeTestLeaseToken {
  leasedAt?: number
}

function fail(reason: string): never {
  throw new McpRuntimeTestLeaseError(reason)
}

function nonEmpty(value: string): void {
  if (value.length === 0) fail('invalid-input')
}

function validate(input: LeaseInput): number {
  nonEmpty(input.runtimeSessionId)
  nonEmpty(input.testSessionId)
  nonEmpty(input.turnId)
  nonEmpty(input.leaseNonceDigest)
  const leasedAt = input.leasedAt ?? Date.now()
  if (!Number.isSafeInteger(leasedAt) || leasedAt < 0) fail('invalid-input')
  return leasedAt
}

function assertLiveTurn(
  tx: DbTxSync,
  testSessionId: string,
  turnId: string,
  protocol: RuntimeKind,
): void {
  const session = tx
    .select({
      status: mcpRuntimeTestSessions.status,
      inFlightTurnId: mcpRuntimeTestSessions.inFlightTurnId,
      runtimeProtocol: mcpRuntimeTestSessions.runtimeProtocol,
    })
    .from(mcpRuntimeTestSessions)
    .where(eq(mcpRuntimeTestSessions.id, testSessionId))
    .get()
  const turn = tx
    .select({
      status: mcpRuntimeTestTurns.status,
      cancelRequestedAt: mcpRuntimeTestTurns.cancelRequestedAt,
    })
    .from(mcpRuntimeTestTurns)
    .where(
      and(eq(mcpRuntimeTestTurns.id, turnId), eq(mcpRuntimeTestTurns.sessionId, testSessionId)),
    )
    .get()
  if (
    session?.status !== 'active' ||
    session.inFlightTurnId !== turnId ||
    session.runtimeProtocol !== protocol ||
    turn?.status !== 'running' ||
    turn.cancelRequestedAt !== null
  ) {
    fail('turn-not-claimable')
  }
}

export function claimNewMcpRuntimeTestSessionLease(
  db: DbClient,
  input: LeaseInput,
): McpRuntimeTestLeaseToken {
  const leasedAt = validate(input)
  return dbTxSync(db, (tx) => {
    assertLiveTurn(tx, input.testSessionId, input.turnId, input.protocol)
    tx.insert(mcpRuntimeTestSessionLeases)
      .values({
        protocol: input.protocol,
        runtimeSessionId: input.runtimeSessionId,
        testSessionId: input.testSessionId,
        createdTurnId: input.turnId,
        currentTurnId: input.turnId,
        leaseTurnId: input.turnId,
        leaseAcquiredAt: leasedAt,
        leaseNonceDigest: input.leaseNonceDigest,
      })
      .run()
    return input
  })
}

export function preclaimMcpRuntimeTestSessionLease(
  db: DbClient,
  input: LeaseInput,
): McpRuntimeTestLeaseToken {
  const leasedAt = validate(input)
  return dbTxSync(db, (tx) => {
    assertLiveTurn(tx, input.testSessionId, input.turnId, input.protocol)
    const claimed = tx
      .update(mcpRuntimeTestSessionLeases)
      .set({
        currentTurnId: input.turnId,
        leaseTurnId: input.turnId,
        leaseAcquiredAt: leasedAt,
        leaseNonceDigest: input.leaseNonceDigest,
      })
      .where(
        and(
          eq(mcpRuntimeTestSessionLeases.protocol, input.protocol),
          eq(mcpRuntimeTestSessionLeases.runtimeSessionId, input.runtimeSessionId),
          eq(mcpRuntimeTestSessionLeases.testSessionId, input.testSessionId),
          isNull(mcpRuntimeTestSessionLeases.leaseTurnId),
          isNull(mcpRuntimeTestSessionLeases.leaseAcquiredAt),
          isNull(mcpRuntimeTestSessionLeases.leaseNonceDigest),
        ),
      )
      .returning({ id: mcpRuntimeTestSessionLeases.runtimeSessionId })
      .all()
    if (claimed.length !== 1) fail('lease-held-or-missing')
    return input
  })
}

/** Move one logical playground session to the replacement native id in-place. */
export function rotateMcpRuntimeTestSessionLease(
  db: DbClient,
  token: McpRuntimeTestLeaseToken,
  nextRuntimeSessionId: string,
): McpRuntimeTestLeaseToken {
  nonEmpty(nextRuntimeSessionId)
  if (nextRuntimeSessionId === token.runtimeSessionId) fail('invalid-input')

  return dbTxSync(db, (tx) => {
    assertLiveTurn(tx, token.testSessionId, token.turnId, token.protocol)
    const session = tx
      .select({
        runtimeSessionId: mcpRuntimeTestSessions.runtimeSessionId,
        nativeSessionState: mcpRuntimeTestSessions.nativeSessionState,
      })
      .from(mcpRuntimeTestSessions)
      .where(eq(mcpRuntimeTestSessions.id, token.testSessionId))
      .get()
    if (session?.runtimeSessionId !== token.runtimeSessionId) fail('session-mismatch')
    // A native id may rotate only after the explicit reset boundary has made
    // the outgoing resume pointer unusable. This prevents callers from using
    // the rotate helper as a generic repair for an unannounced identity drift.
    if (session.nativeSessionState !== 'unusable') fail('reset-not-pending')

    const rotated = tx
      .update(mcpRuntimeTestSessionLeases)
      .set({ runtimeSessionId: nextRuntimeSessionId })
      .where(
        and(
          eq(mcpRuntimeTestSessionLeases.protocol, token.protocol),
          eq(mcpRuntimeTestSessionLeases.runtimeSessionId, token.runtimeSessionId),
          eq(mcpRuntimeTestSessionLeases.testSessionId, token.testSessionId),
          eq(mcpRuntimeTestSessionLeases.leaseTurnId, token.turnId),
          eq(mcpRuntimeTestSessionLeases.leaseNonceDigest, token.leaseNonceDigest),
        ),
      )
      .returning({ id: mcpRuntimeTestSessionLeases.runtimeSessionId })
      .all()
    if (rotated.length !== 1) fail('lease-mismatch')

    const linked = tx
      .update(mcpRuntimeTestSessions)
      .set({ runtimeSessionId: nextRuntimeSessionId, nativeSessionState: 'ready' })
      .where(
        and(
          eq(mcpRuntimeTestSessions.id, token.testSessionId),
          eq(mcpRuntimeTestSessions.runtimeSessionId, token.runtimeSessionId),
        ),
      )
      .returning({ id: mcpRuntimeTestSessions.id })
      .all()
    if (linked.length !== 1) fail('session-mismatch')

    // The lease key, durable resume pointer, and current root evidence are one
    // identity transition. Keeping this retag in the same transaction avoids
    // a crash window where the SessionTree points at B while all root rows are
    // still stranded under A. Raw payloads retain the wire session ids.
    tx.update(mcpRuntimeTestEvents)
      .set({ sessionId: nextRuntimeSessionId })
      .where(
        and(
          eq(mcpRuntimeTestEvents.testSessionId, token.testSessionId),
          eq(mcpRuntimeTestEvents.sessionId, token.runtimeSessionId),
          isNull(mcpRuntimeTestEvents.parentSessionId),
        ),
      )
      .run()
    tx.update(mcpRuntimeTestEvents)
      .set({ parentSessionId: nextRuntimeSessionId })
      .where(
        and(
          eq(mcpRuntimeTestEvents.testSessionId, token.testSessionId),
          eq(mcpRuntimeTestEvents.parentSessionId, token.runtimeSessionId),
        ),
      )
      .run()

    return { ...token, runtimeSessionId: nextRuntimeSessionId }
  })
}

export function releaseMcpRuntimeTestSessionLease(
  db: DbClient,
  token: McpRuntimeTestLeaseToken,
): boolean {
  const released = db
    .update(mcpRuntimeTestSessionLeases)
    .set({ leaseTurnId: null, leaseAcquiredAt: null, leaseNonceDigest: null })
    .where(
      and(
        eq(mcpRuntimeTestSessionLeases.protocol, token.protocol),
        eq(mcpRuntimeTestSessionLeases.runtimeSessionId, token.runtimeSessionId),
        eq(mcpRuntimeTestSessionLeases.testSessionId, token.testSessionId),
        eq(mcpRuntimeTestSessionLeases.leaseTurnId, token.turnId),
        eq(mcpRuntimeTestSessionLeases.leaseNonceDigest, token.leaseNonceDigest),
      ),
    )
    .returning({ id: mcpRuntimeTestSessionLeases.runtimeSessionId })
    .all()
  return released.length === 1
}

/** Release a stranded holder only after the caller has reaped that turn's child. */
export function repairMcpRuntimeTestSessionLeaseAfterReap(
  db: DbClient,
  testSessionId: string,
  turnId: string,
  childReaped: true,
): boolean {
  if (childReaped !== true) fail('child-not-reaped')
  const lease = db
    .select()
    .from(mcpRuntimeTestSessionLeases)
    .where(
      and(
        eq(mcpRuntimeTestSessionLeases.testSessionId, testSessionId),
        eq(mcpRuntimeTestSessionLeases.leaseTurnId, turnId),
      ),
    )
    .get()
  if (lease === undefined || lease.leaseNonceDigest === null) return false
  return releaseMcpRuntimeTestSessionLease(db, {
    protocol: lease.protocol,
    runtimeSessionId: lease.runtimeSessionId,
    testSessionId,
    turnId,
    leaseNonceDigest: lease.leaseNonceDigest,
  })
}
