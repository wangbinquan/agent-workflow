// RFC-359 W4-B2 —— MCP playground 原生会话的单写者租约：一份实现，两个 provider 共用。

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { and, eq, isNull } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  McpRuntimeTestLeaseError,
  type McpRuntimeTestLeaseOperations,
  type McpRuntimeTestLeaseInput,
  type McpRuntimeTestLeaseToken,
} from '../application/ports/mcpRuntimeTestLease'
import type { McpRuntimeProtocol } from '../application/ports/mcpRuntimeTestLease'
import {
  runResourceCatalogTransaction,
  type ResourceCatalogTransaction,
} from './resourceCatalogTransaction'

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
  transaction: ResourceCatalogTransaction,
  testSessionId: string,
  turnId: string,
  protocol: McpRuntimeProtocol,
): Promise<void> {
  const { mcpRuntimeTestSessions, mcpRuntimeTestTurns } = tablesOf(transaction)
  const session = await first(
    transaction
      .select({
        status: mcpRuntimeTestSessions.status,
        inFlightTurnId: mcpRuntimeTestSessions.inFlightTurnId,
        runtimeProtocol: mcpRuntimeTestSessions.runtimeProtocol,
      })
      .from(mcpRuntimeTestSessions)
      .where(eq(mcpRuntimeTestSessions.id, testSessionId)),
  )
  const turn = await first(
    transaction
      .select({
        status: mcpRuntimeTestTurns.status,
        cancelRequestedAt: mcpRuntimeTestTurns.cancelRequestedAt,
      })
      .from(mcpRuntimeTestTurns)
      .where(
        and(eq(mcpRuntimeTestTurns.id, turnId), eq(mcpRuntimeTestTurns.sessionId, testSessionId)),
      ),
  )
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
  db: PersistenceDb,
  input: McpRuntimeTestLeaseInput,
): Promise<McpRuntimeTestLeaseToken> {
  const leasedAt = validate(input)
  return runResourceCatalogTransaction(db, async (transaction) => {
    await assertLiveTurn(transaction, input.testSessionId, input.turnId, input.protocol)
    const { mcpRuntimeTestSessionLeases } = tablesOf(transaction)
    await insertOne(transaction, mcpRuntimeTestSessionLeases, {
      protocol: input.protocol,
      runtimeSessionId: input.runtimeSessionId,
      testSessionId: input.testSessionId,
      createdTurnId: input.turnId,
      currentTurnId: input.turnId,
      leaseTurnId: input.turnId,
      leaseAcquiredAt: leasedAt,
      leaseNonceDigest: input.leaseNonceDigest,
    })
    return input
  })
}

async function preclaim(
  db: PersistenceDb,
  input: McpRuntimeTestLeaseInput,
): Promise<McpRuntimeTestLeaseToken> {
  const leasedAt = validate(input)
  return runResourceCatalogTransaction(db, async (transaction) => {
    await assertLiveTurn(transaction, input.testSessionId, input.turnId, input.protocol)
    const { mcpRuntimeTestSessionLeases } = tablesOf(transaction)
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
    if (claimed.length !== 1) fail('lease-held-or-missing')
    return input
  })
}

async function rotate(
  db: PersistenceDb,
  token: McpRuntimeTestLeaseToken,
  nextRuntimeSessionId: string,
): Promise<McpRuntimeTestLeaseToken> {
  nonEmpty(nextRuntimeSessionId)
  if (nextRuntimeSessionId === token.runtimeSessionId) fail('invalid-input')

  return runResourceCatalogTransaction(db, async (transaction) => {
    await assertLiveTurn(transaction, token.testSessionId, token.turnId, token.protocol)
    const { mcpRuntimeTestSessions, mcpRuntimeTestSessionLeases, mcpRuntimeTestEvents } =
      tablesOf(transaction)
    const session = await first(
      transaction
        .select({
          runtimeSessionId: mcpRuntimeTestSessions.runtimeSessionId,
          nativeSessionState: mcpRuntimeTestSessions.nativeSessionState,
        })
        .from(mcpRuntimeTestSessions)
        .where(eq(mcpRuntimeTestSessions.id, token.testSessionId)),
    )
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
    await transaction
      .update(mcpRuntimeTestEvents)
      .set({ parentSessionId: nextRuntimeSessionId })
      .where(
        and(
          eq(mcpRuntimeTestEvents.testSessionId, token.testSessionId),
          eq(mcpRuntimeTestEvents.parentSessionId, token.runtimeSessionId),
        ),
      )
    return { ...token, runtimeSessionId: nextRuntimeSessionId }
  })
}

async function release(db: PersistenceDb, token: McpRuntimeTestLeaseToken): Promise<boolean> {
  return runResourceCatalogTransaction(db, async (transaction) => {
    const { mcpRuntimeTestSessionLeases } = tablesOf(transaction)
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
    return released.length === 1
  })
}

async function repairAfterReap(
  db: PersistenceDb,
  testSessionId: string,
  turnId: string,
  childReaped: true,
): Promise<boolean> {
  if (childReaped !== true) fail('child-not-reaped')
  const { mcpRuntimeTestSessionLeases } = tablesOf(db)
  const lease = await first(
    db
      .select()
      .from(mcpRuntimeTestSessionLeases)
      .where(
        and(
          eq(mcpRuntimeTestSessionLeases.testSessionId, testSessionId),
          eq(mcpRuntimeTestSessionLeases.leaseTurnId, turnId),
        ),
      ),
  )
  if (lease === undefined || lease.leaseNonceDigest === null) return false
  return release(db, {
    protocol: lease.protocol,
    runtimeSessionId: lease.runtimeSessionId,
    testSessionId,
    turnId,
    leaseNonceDigest: lease.leaseNonceDigest,
  })
}

export function createMcpRuntimeTestLeaseOperations(
  db: PersistenceDb,
  beforeWrite?: (tx: PersistenceDb) => Promise<void>,
): McpRuntimeTestLeaseOperations {
  const write = <T>(body: (tx: PersistenceDb) => Promise<T>): Promise<T> =>
    beforeWrite === undefined
      ? body(db)
      : runResourceCatalogTransaction(db, async (tx) => {
          await beforeWrite(tx)
          return body(tx)
        })
  return Object.freeze({
    claimNew: (input: McpRuntimeTestLeaseInput) => write((tx) => claimNew(tx, input)),
    preclaim: (input: McpRuntimeTestLeaseInput) => write((tx) => preclaim(tx, input)),
    rotate: (token: McpRuntimeTestLeaseToken, nextRuntimeSessionId: string) =>
      write((tx) => rotate(tx, token, nextRuntimeSessionId)),
    release: (token: McpRuntimeTestLeaseToken) => write((tx) => release(tx, token)),
    repairAfterReap: (testSessionId: string, turnId: string, childReaped: true) =>
      write((tx) => repairAfterReap(tx, testSessionId, turnId, childReaped)),
  })
}
