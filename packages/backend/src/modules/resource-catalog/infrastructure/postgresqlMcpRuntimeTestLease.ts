// PostgreSQL native-session single-writer leases for the MCP playground.

import { and, eq, isNull } from 'drizzle-orm'
import {
  mcpRuntimeTestEvents,
  mcpRuntimeTestSessionLeases,
  mcpRuntimeTestSessions,
  mcpRuntimeTestTurns,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  McpRuntimeTestLeaseError,
  type McpRuntimeTestLeaseOperations,
} from '../public/participants'
import type {
  McpRuntimeProtocol,
  McpRuntimeTestLeaseInput,
  McpRuntimeTestLeaseToken,
} from '../public/types'
import {
  runPostgresqlResourceCatalogTransaction,
  type PostgresqlResourceCatalogTransaction,
} from './postgresql/repositorySupport'

function fail(reason: string): never {
  throw new McpRuntimeTestLeaseError(reason)
}

function nonEmpty(value: string): void {
  if (value.length === 0) fail('invalid-input')
}

function validate(input: McpRuntimeTestLeaseInput): number {
  nonEmpty(input.runtimeSessionId)
  nonEmpty(input.testSessionId)
  nonEmpty(input.turnId)
  nonEmpty(input.leaseNonceDigest)
  const leasedAt = input.leasedAt ?? Date.now()
  if (!Number.isSafeInteger(leasedAt) || leasedAt < 0) fail('invalid-input')
  return leasedAt
}

async function assertLiveTurn(
  transaction: PostgresqlResourceCatalogTransaction,
  testSessionId: string,
  turnId: string,
  protocol: McpRuntimeProtocol,
): Promise<void> {
  const session = await transaction
    .select({
      status: mcpRuntimeTestSessions.status,
      inFlightTurnId: mcpRuntimeTestSessions.inFlightTurnId,
      runtimeProtocol: mcpRuntimeTestSessions.runtimeProtocol,
    })
    .from(mcpRuntimeTestSessions)
    .where(eq(mcpRuntimeTestSessions.id, testSessionId))
    .get()
  const turn = await transaction
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

async function claimNew(
  db: PostgresqlDatabaseClient,
  input: McpRuntimeTestLeaseInput,
): Promise<McpRuntimeTestLeaseToken> {
  const leasedAt = validate(input)
  return runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
    await assertLiveTurn(transaction, input.testSessionId, input.turnId, input.protocol)
    await transaction
      .insert(mcpRuntimeTestSessionLeases)
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

async function preclaim(
  db: PostgresqlDatabaseClient,
  input: McpRuntimeTestLeaseInput,
): Promise<McpRuntimeTestLeaseToken> {
  const leasedAt = validate(input)
  return runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
    await assertLiveTurn(transaction, input.testSessionId, input.turnId, input.protocol)
    const claimed = await transaction
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

async function rotate(
  db: PostgresqlDatabaseClient,
  token: McpRuntimeTestLeaseToken,
  nextRuntimeSessionId: string,
): Promise<McpRuntimeTestLeaseToken> {
  nonEmpty(nextRuntimeSessionId)
  if (nextRuntimeSessionId === token.runtimeSessionId) fail('invalid-input')

  return runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
    await assertLiveTurn(transaction, token.testSessionId, token.turnId, token.protocol)
    const session = await transaction
      .select({
        runtimeSessionId: mcpRuntimeTestSessions.runtimeSessionId,
        nativeSessionState: mcpRuntimeTestSessions.nativeSessionState,
      })
      .from(mcpRuntimeTestSessions)
      .where(eq(mcpRuntimeTestSessions.id, token.testSessionId))
      .get()
    if (session?.runtimeSessionId !== token.runtimeSessionId) fail('session-mismatch')
    if (session.nativeSessionState !== 'unusable') fail('reset-not-pending')

    const rotated = await transaction
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

    const linked = await transaction
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

    await transaction
      .update(mcpRuntimeTestEvents)
      .set({ sessionId: nextRuntimeSessionId })
      .where(
        and(
          eq(mcpRuntimeTestEvents.testSessionId, token.testSessionId),
          eq(mcpRuntimeTestEvents.sessionId, token.runtimeSessionId),
          isNull(mcpRuntimeTestEvents.parentSessionId),
        ),
      )
      .run()
    await transaction
      .update(mcpRuntimeTestEvents)
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

async function release(
  db: PostgresqlDatabaseClient,
  token: McpRuntimeTestLeaseToken,
): Promise<boolean> {
  return runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
    const released = await transaction
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
  })
}

async function repairAfterReap(
  db: PostgresqlDatabaseClient,
  testSessionId: string,
  turnId: string,
  childReaped: true,
): Promise<boolean> {
  if (childReaped !== true) fail('child-not-reaped')
  const lease = await db
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
  return release(db, {
    protocol: lease.protocol,
    runtimeSessionId: lease.runtimeSessionId,
    testSessionId,
    turnId,
    leaseNonceDigest: lease.leaseNonceDigest,
  })
}

export function createPostgresqlMcpRuntimeTestLeaseOperations(
  db: PostgresqlDatabaseClient,
): McpRuntimeTestLeaseOperations {
  return Object.freeze({
    claimNew: (input: McpRuntimeTestLeaseInput) => claimNew(db, input),
    preclaim: (input: McpRuntimeTestLeaseInput) => preclaim(db, input),
    rotate: (token: McpRuntimeTestLeaseToken, nextRuntimeSessionId: string) =>
      rotate(db, token, nextRuntimeSessionId),
    release: (token: McpRuntimeTestLeaseToken) => release(db, token),
    repairAfterReap: (testSessionId: string, turnId: string, childReaped: true) =>
      repairAfterReap(db, testSessionId, turnId, childReaped),
  })
}
