// RFC-238 — transactional OpenCode playground owner/lease adapter.
//
// This table is intentionally independent from task/node ownership. Every
// transition also validates the live playground turn so an ACK can never
// authorize a model prompt for a canceled, ended, or different turn.

import { and, eq, isNull } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import {
  mcpRuntimeTestSessions,
  mcpRuntimeTestTurns,
  opencodeMcpTestSessionOwners,
} from '@/db/schema'
import { dbTxSync, type DbTxSync } from '@/db/txSync'

export type McpRuntimeTestOwner = typeof opencodeMcpTestSessionOwners.$inferSelect

export class McpRuntimeTestOwnerError extends Error {
  readonly code = 'execution-identity-control-failed' as const

  constructor(readonly reason: string) {
    super('execution-identity-control-failed')
    this.name = 'McpRuntimeTestOwnerError'
  }
}

export interface McpRuntimeTestOwnerImmutable {
  testSessionId: string
  createdTurnId: string
  identityDigest: string
  runtimeBinaryDigest: string
  sessionContractDigest: string
  sessionStoreKey: string
  protocolCodec: string
}

export interface McpRuntimeTestLeaseToken {
  runtimeSessionId: string
  testSessionId: string
  turnId: string
  leaseNonceDigest: string
}

function fail(reason: string): never {
  throw new McpRuntimeTestOwnerError(reason)
}

function nonEmpty(value: string): void {
  if (value.length === 0) fail('invalid-input')
}

function validateImmutable(value: McpRuntimeTestOwnerImmutable): void {
  nonEmpty(value.testSessionId)
  nonEmpty(value.createdTurnId)
  nonEmpty(value.identityDigest)
  nonEmpty(value.runtimeBinaryDigest)
  nonEmpty(value.sessionContractDigest)
  nonEmpty(value.sessionStoreKey)
  nonEmpty(value.protocolCodec)
}

function immutableMatches(
  owner: McpRuntimeTestOwner,
  expected: McpRuntimeTestOwnerImmutable,
): boolean {
  return (
    owner.testSessionId === expected.testSessionId &&
    owner.createdTurnId === expected.createdTurnId &&
    owner.identityDigest === expected.identityDigest &&
    owner.runtimeBinaryDigest === expected.runtimeBinaryDigest &&
    owner.sessionContractDigest === expected.sessionContractDigest &&
    owner.sessionStoreKey === expected.sessionStoreKey &&
    owner.protocolCodec === expected.protocolCodec
  )
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

export function getMcpRuntimeTestOwner(
  db: DbClient,
  testSessionId: string,
): McpRuntimeTestOwner | undefined {
  nonEmpty(testSessionId)
  return db
    .select()
    .from(opencodeMcpTestSessionOwners)
    .where(eq(opencodeMcpTestSessionOwners.testSessionId, testSessionId))
    .get()
}

export function preclaimMcpRuntimeTestResume(
  db: DbClient,
  input: McpRuntimeTestOwnerImmutable & {
    runtimeSessionId: string
    turnId: string
    leaseNonceDigest: string
    leasedAt?: number
  },
): McpRuntimeTestOwner {
  validateImmutable(input)
  nonEmpty(input.runtimeSessionId)
  nonEmpty(input.turnId)
  nonEmpty(input.leaseNonceDigest)
  const leasedAt = input.leasedAt ?? Date.now()
  if (!Number.isSafeInteger(leasedAt) || leasedAt < 0) fail('invalid-input')

  return dbTxSync(db, (tx) => {
    assertLiveTurn(tx, input.testSessionId, input.turnId)
    const owner = tx
      .select()
      .from(opencodeMcpTestSessionOwners)
      .where(eq(opencodeMcpTestSessionOwners.runtimeSessionId, input.runtimeSessionId))
      .get()
    if (owner === undefined) fail('owner-missing')
    if (!immutableMatches(owner, input)) fail('owner-mismatch')
    if (
      owner.leaseTurnId !== null ||
      owner.leaseAcquiredAt !== null ||
      owner.leaseNonceDigest !== null
    ) {
      fail('lease-held')
    }
    const claimed = tx
      .update(opencodeMcpTestSessionOwners)
      .set({
        leaseTurnId: input.turnId,
        leaseAcquiredAt: leasedAt,
        leaseNonceDigest: input.leaseNonceDigest,
      })
      .where(
        and(
          eq(opencodeMcpTestSessionOwners.runtimeSessionId, input.runtimeSessionId),
          isNull(opencodeMcpTestSessionOwners.leaseTurnId),
          isNull(opencodeMcpTestSessionOwners.leaseAcquiredAt),
          isNull(opencodeMcpTestSessionOwners.leaseNonceDigest),
        ),
      )
      .returning({ id: opencodeMcpTestSessionOwners.runtimeSessionId })
      .all()
    if (claimed.length !== 1) fail('lease-held')
    return {
      ...owner,
      leaseTurnId: input.turnId,
      leaseAcquiredAt: leasedAt,
      leaseNonceDigest: input.leaseNonceDigest,
    }
  })
}

export function claimNewMcpRuntimeTestSession(
  db: DbClient,
  input: McpRuntimeTestOwnerImmutable & {
    runtimeSessionId: string
    turnId: string
    projectId: string
    reportedVersion: string | null
    leaseNonceDigest: string
    leasedAt?: number
  },
): McpRuntimeTestLeaseToken {
  validateImmutable(input)
  nonEmpty(input.runtimeSessionId)
  nonEmpty(input.turnId)
  nonEmpty(input.projectId)
  nonEmpty(input.leaseNonceDigest)
  const leasedAt = input.leasedAt ?? Date.now()
  if (!Number.isSafeInteger(leasedAt) || leasedAt < 0) fail('invalid-input')

  return dbTxSync(db, (tx) => {
    assertLiveTurn(tx, input.testSessionId, input.turnId)
    const session = tx
      .select()
      .from(mcpRuntimeTestSessions)
      .where(eq(mcpRuntimeTestSessions.id, input.testSessionId))
      .get()
    if (
      session === undefined ||
      session.runtimeSessionId !== null ||
      session.runtimeBinaryDigest !== input.runtimeBinaryDigest ||
      session.sessionContractDigest !== input.sessionContractDigest
    ) {
      fail('session-mismatch')
    }
    tx.insert(opencodeMcpTestSessionOwners)
      .values({
        runtimeSessionId: input.runtimeSessionId,
        testSessionId: input.testSessionId,
        createdTurnId: input.createdTurnId,
        currentTurnId: input.turnId,
        identityDigest: input.identityDigest,
        runtimeBinaryDigest: input.runtimeBinaryDigest,
        sessionContractDigest: input.sessionContractDigest,
        sessionStoreKey: input.sessionStoreKey,
        projectId: input.projectId,
        protocolCodec: input.protocolCodec,
        reportedVersion: input.reportedVersion,
        leaseTurnId: input.turnId,
        leaseAcquiredAt: leasedAt,
        leaseNonceDigest: input.leaseNonceDigest,
      })
      .run()
    tx.update(mcpRuntimeTestSessions)
      .set({
        runtimeSessionId: input.runtimeSessionId,
        nativeSessionState: 'ready',
      })
      .where(eq(mcpRuntimeTestSessions.id, input.testSessionId))
      .run()
    return {
      runtimeSessionId: input.runtimeSessionId,
      testSessionId: input.testSessionId,
      turnId: input.turnId,
      leaseNonceDigest: input.leaseNonceDigest,
    }
  })
}

export function confirmMcpRuntimeTestResume(
  db: DbClient,
  input: McpRuntimeTestLeaseToken & {
    projectId: string
    reportedVersion: string | null
  },
): McpRuntimeTestOwner {
  nonEmpty(input.runtimeSessionId)
  nonEmpty(input.testSessionId)
  nonEmpty(input.turnId)
  nonEmpty(input.leaseNonceDigest)
  nonEmpty(input.projectId)
  return dbTxSync(db, (tx) => {
    assertLiveTurn(tx, input.testSessionId, input.turnId)
    const owner = tx
      .select()
      .from(opencodeMcpTestSessionOwners)
      .where(
        and(
          eq(opencodeMcpTestSessionOwners.runtimeSessionId, input.runtimeSessionId),
          eq(opencodeMcpTestSessionOwners.testSessionId, input.testSessionId),
          eq(opencodeMcpTestSessionOwners.leaseTurnId, input.turnId),
          eq(opencodeMcpTestSessionOwners.leaseNonceDigest, input.leaseNonceDigest),
        ),
      )
      .get()
    if (owner === undefined || owner.projectId !== input.projectId) fail('lease-mismatch')
    tx.update(opencodeMcpTestSessionOwners)
      .set({
        currentTurnId: input.turnId,
        reportedVersion: input.reportedVersion,
      })
      .where(eq(opencodeMcpTestSessionOwners.runtimeSessionId, input.runtimeSessionId))
      .run()
    return {
      ...owner,
      currentTurnId: input.turnId,
      reportedVersion: input.reportedVersion,
    }
  })
}

export function releaseMcpRuntimeTestLease(db: DbClient, token: McpRuntimeTestLeaseToken): boolean {
  return dbTxSync(db, (tx) => {
    const released = tx
      .update(opencodeMcpTestSessionOwners)
      .set({
        leaseTurnId: null,
        leaseAcquiredAt: null,
        leaseNonceDigest: null,
      })
      .where(
        and(
          eq(opencodeMcpTestSessionOwners.runtimeSessionId, token.runtimeSessionId),
          eq(opencodeMcpTestSessionOwners.testSessionId, token.testSessionId),
          eq(opencodeMcpTestSessionOwners.leaseTurnId, token.turnId),
          eq(opencodeMcpTestSessionOwners.leaseNonceDigest, token.leaseNonceDigest),
        ),
      )
      .returning({ id: opencodeMcpTestSessionOwners.runtimeSessionId })
      .all()
    return released.length === 1
  })
}
