// Native-session single-writer leases for the MCP playground.

import { and, eq, isNull } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import {
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

function assertLiveTurn(tx: DbTxSync, testSessionId: string, turnId: string): void {
  const session = tx
    .select({
      status: mcpRuntimeTestSessions.status,
      inFlightTurnId: mcpRuntimeTestSessions.inFlightTurnId,
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
    assertLiveTurn(tx, input.testSessionId, input.turnId)
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
    assertLiveTurn(tx, input.testSessionId, input.turnId)
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
