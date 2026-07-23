// RFC-224 T14 — the sole transactional owner/lease service for verified
// OpenCode business sessions. Filesystem/store locking remains the caller's
// responsibility; every database transition here is synchronous and atomic.

import { and, eq, isNull, or } from 'drizzle-orm'
import { TERMINAL_NODE_RUN_STATUSES } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { nodeRuns, opencodeSessionOwners } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'

export type OpencodeSessionOwner = typeof opencodeSessionOwners.$inferSelect

export type OpencodeSessionOwnerErrorReason =
  | 'invalid-input'
  | 'owner-conflict'
  | 'owner-missing'
  | 'owner-mismatch'
  | 'lease-held'
  | 'lease-mismatch'
  | 'run-not-claimable'

/**
 * Safe boundary error: details identify an internal branch for tests/logging,
 * while the message exposes only RFC-224's stable non-secret failure code.
 */
export class OpencodeSessionOwnerError extends Error {
  readonly code = 'execution-identity-session-mismatch' as const

  constructor(readonly reason: OpencodeSessionOwnerErrorReason) {
    super('execution-identity-session-mismatch')
    this.name = 'OpencodeSessionOwnerError'
  }
}

export interface OpencodeSessionOwnerImmutable {
  sessionId: string
  taskId: string
  nodeId: string
  createdNodeRunId: string
  identityDigest: string
  officialBuildDigest: string
  sessionContractDigest: string
  sessionStoreKey: string
  projectId: string
  opencodeVersion: string
}

export interface NewOpencodeSessionClaim {
  sessionId: string
  taskId: string
  nodeId: string
  currentNodeRunId: string
  identityDigest: string
  officialBuildDigest: string
  sessionContractDigest: string
  sessionStoreKey: string
  projectId: string
  opencodeVersion: string
  leaseNonceDigest: string
  leasedAt?: number
}

export interface ResumeOpencodeSessionLeaseClaim extends OpencodeSessionOwnerImmutable {
  currentNodeRunId: string
  leaseNonceDigest: string
  leasedAt?: number
}

export interface OpencodeSessionLeaseToken {
  sessionId: string
  nodeRunId: string
  leaseNonceDigest: string
}

const TERMINAL_NODE_RUN_STATUS_SET: ReadonlySet<string> = new Set(TERMINAL_NODE_RUN_STATUSES)

function fail(reason: OpencodeSessionOwnerErrorReason): never {
  throw new OpencodeSessionOwnerError(reason)
}

function assertNonEmpty(value: string): void {
  if (value.length === 0) fail('invalid-input')
}

function leaseTime(value: number | undefined): number {
  const resolved = value ?? Date.now()
  if (!Number.isSafeInteger(resolved) || resolved < 0) fail('invalid-input')
  return resolved
}

function validateImmutable(input: OpencodeSessionOwnerImmutable): void {
  assertNonEmpty(input.sessionId)
  assertNonEmpty(input.taskId)
  assertNonEmpty(input.nodeId)
  assertNonEmpty(input.createdNodeRunId)
  assertNonEmpty(input.identityDigest)
  assertNonEmpty(input.officialBuildDigest)
  assertNonEmpty(input.sessionContractDigest)
  assertNonEmpty(input.sessionStoreKey)
  assertNonEmpty(input.projectId)
  assertNonEmpty(input.opencodeVersion)
}

function immutableMatches(
  owner: OpencodeSessionOwner,
  expected: OpencodeSessionOwnerImmutable,
): boolean {
  return (
    owner.sessionId === expected.sessionId &&
    owner.taskId === expected.taskId &&
    owner.nodeId === expected.nodeId &&
    owner.createdNodeRunId === expected.createdNodeRunId &&
    owner.identityDigest === expected.identityDigest &&
    owner.officialBuildDigest === expected.officialBuildDigest &&
    owner.sessionContractDigest === expected.sessionContractDigest &&
    owner.sessionStoreKey === expected.sessionStoreKey &&
    owner.projectId === expected.projectId &&
    owner.opencodeVersion === expected.opencodeVersion
  )
}

function ownerConstraintViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    /UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE|SQLITE_CONSTRAINT_PRIMARYKEY|constraint failed/i.test(
      message,
    ) && /opencode_session_owners|uniq_opencode_session_owners_store_key/i.test(message)
  )
}

/** Read immutable provenance before constructing a resume plan; no store access occurs here. */
export function getOpencodeSessionOwner(
  db: DbClient,
  sessionId: string,
): OpencodeSessionOwner | undefined {
  assertNonEmpty(sessionId)
  return db
    .select()
    .from(opencodeSessionOwners)
    .where(eq(opencodeSessionOwners.sessionId, sessionId))
    .get()
}

/**
 * New-session marker barrier. The owner row, its initial lease, and the
 * current run's transcript linkage either all commit or all roll back.
 */
export function claimNewOpencodeSession(
  db: DbClient,
  input: NewOpencodeSessionClaim,
): OpencodeSessionOwner {
  const immutable: OpencodeSessionOwnerImmutable = {
    sessionId: input.sessionId,
    taskId: input.taskId,
    nodeId: input.nodeId,
    createdNodeRunId: input.currentNodeRunId,
    identityDigest: input.identityDigest,
    officialBuildDigest: input.officialBuildDigest,
    sessionContractDigest: input.sessionContractDigest,
    sessionStoreKey: input.sessionStoreKey,
    projectId: input.projectId,
    opencodeVersion: input.opencodeVersion,
  }
  validateImmutable(immutable)
  assertNonEmpty(input.currentNodeRunId)
  assertNonEmpty(input.leaseNonceDigest)
  const leasedAt = leaseTime(input.leasedAt)

  try {
    return dbTxSync(db, (tx) => {
      const conflict = tx
        .select({ sessionId: opencodeSessionOwners.sessionId })
        .from(opencodeSessionOwners)
        .where(
          or(
            eq(opencodeSessionOwners.sessionId, input.sessionId),
            eq(opencodeSessionOwners.sessionStoreKey, input.sessionStoreKey),
          ),
        )
        .limit(1)
        .get()
      if (conflict !== undefined) fail('owner-conflict')

      tx.insert(opencodeSessionOwners)
        .values({
          ...immutable,
          leaseNodeRunId: input.currentNodeRunId,
          leaseNonceDigest: input.leaseNonceDigest,
          leasedAt,
        })
        .run()

      const linked = tx
        .update(nodeRuns)
        .set({ opencodeSessionId: input.sessionId })
        .where(
          and(
            eq(nodeRuns.id, input.currentNodeRunId),
            eq(nodeRuns.taskId, input.taskId),
            eq(nodeRuns.nodeId, input.nodeId),
            eq(nodeRuns.status, 'running'),
            isNull(nodeRuns.opencodeSessionId),
          ),
        )
        .returning({ id: nodeRuns.id })
        .all()
      if (linked.length !== 1) fail('run-not-claimable')

      return {
        ...immutable,
        leaseNodeRunId: input.currentNodeRunId,
        leaseNonceDigest: input.leaseNonceDigest,
        leasedAt,
      }
    })
  } catch (error) {
    if (error instanceof OpencodeSessionOwnerError) throw error
    if (ownerConstraintViolation(error)) fail('owner-conflict')
    throw error
  }
}

/**
 * Resume pre-store barrier. This is the only lease acquisition for resume:
 * it runs before mount/scrub/SQLite/server work and does not yet stamp the
 * current node_run's session id.
 */
export function preclaimOpencodeSessionResume(
  db: DbClient,
  input: ResumeOpencodeSessionLeaseClaim,
): OpencodeSessionOwner {
  validateImmutable(input)
  assertNonEmpty(input.currentNodeRunId)
  assertNonEmpty(input.leaseNonceDigest)
  const leasedAt = leaseTime(input.leasedAt)

  return dbTxSync(db, (tx) => {
    const owner = tx
      .select()
      .from(opencodeSessionOwners)
      .where(eq(opencodeSessionOwners.sessionId, input.sessionId))
      .get()
    if (owner === undefined) fail('owner-missing')
    if (!immutableMatches(owner, input)) fail('owner-mismatch')
    if (
      owner.leaseNodeRunId !== null ||
      owner.leaseNonceDigest !== null ||
      owner.leasedAt !== null
    ) {
      fail('lease-held')
    }

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
      .update(opencodeSessionOwners)
      .set({
        leaseNodeRunId: input.currentNodeRunId,
        leaseNonceDigest: input.leaseNonceDigest,
        leasedAt,
      })
      .where(
        and(
          eq(opencodeSessionOwners.sessionId, input.sessionId),
          isNull(opencodeSessionOwners.leaseNodeRunId),
          isNull(opencodeSessionOwners.leaseNonceDigest),
          isNull(opencodeSessionOwners.leasedAt),
        ),
      )
      .returning({ sessionId: opencodeSessionOwners.sessionId })
      .all()
    if (claimed.length !== 1) fail('lease-held')

    return {
      ...owner,
      leaseNodeRunId: input.currentNodeRunId,
      leaseNonceDigest: input.leaseNonceDigest,
      leasedAt,
    }
  })
}

/**
 * Resume marker barrier. Lease acquisition already happened pre-store; this
 * method only confirms the exact holder/nonce and CAS-links the current run.
 */
export function confirmOpencodeSessionResume(
  db: DbClient,
  token: OpencodeSessionLeaseToken,
): OpencodeSessionOwner {
  assertNonEmpty(token.sessionId)
  assertNonEmpty(token.nodeRunId)
  assertNonEmpty(token.leaseNonceDigest)

  return dbTxSync(db, (tx) => {
    const owner = tx
      .select()
      .from(opencodeSessionOwners)
      .where(
        and(
          eq(opencodeSessionOwners.sessionId, token.sessionId),
          eq(opencodeSessionOwners.leaseNodeRunId, token.nodeRunId),
          eq(opencodeSessionOwners.leaseNonceDigest, token.leaseNonceDigest),
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
    if (linked.length !== 1) fail('run-not-claimable')
    return owner
  })
}

/** Normal finally path: only the exact session/run/nonce holder can clear itself. */
export function releaseOpencodeSessionLease(
  db: DbClient,
  token: OpencodeSessionLeaseToken,
): boolean {
  assertNonEmpty(token.sessionId)
  assertNonEmpty(token.nodeRunId)
  assertNonEmpty(token.leaseNonceDigest)
  return dbTxSync(db, (tx) => {
    const released = tx
      .update(opencodeSessionOwners)
      .set({ leaseNodeRunId: null, leaseNonceDigest: null, leasedAt: null })
      .where(
        and(
          eq(opencodeSessionOwners.sessionId, token.sessionId),
          eq(opencodeSessionOwners.leaseNodeRunId, token.nodeRunId),
          eq(opencodeSessionOwners.leaseNonceDigest, token.leaseNonceDigest),
        ),
      )
      .returning({ sessionId: opencodeSessionOwners.sessionId })
      .all()
    return released.length === 1
  })
}

export interface RepairOpencodeSessionLeaseInput extends OpencodeSessionLeaseToken {
  /**
   * The lifecycle caller must establish this from persisted pid/spawn identity
   * and a dead process group before entering this DB service.
   */
  processGroupDead: true
}

/**
 * Crash repair. OS liveness is proven by the caller first; this transaction
 * then re-reads both the unchanged lease triple and a terminal holder run.
 */
export function repairOpencodeSessionLease(
  db: DbClient,
  input: RepairOpencodeSessionLeaseInput,
): boolean {
  if (input.processGroupDead !== true) fail('invalid-input')
  assertNonEmpty(input.sessionId)
  assertNonEmpty(input.nodeRunId)
  assertNonEmpty(input.leaseNonceDigest)

  return dbTxSync(db, (tx) => {
    const owner = tx
      .select({
        taskId: opencodeSessionOwners.taskId,
        nodeId: opencodeSessionOwners.nodeId,
      })
      .from(opencodeSessionOwners)
      .where(
        and(
          eq(opencodeSessionOwners.sessionId, input.sessionId),
          eq(opencodeSessionOwners.leaseNodeRunId, input.nodeRunId),
          eq(opencodeSessionOwners.leaseNonceDigest, input.leaseNonceDigest),
        ),
      )
      .get()
    if (owner === undefined) return false

    const holder = tx
      .select({
        taskId: nodeRuns.taskId,
        nodeId: nodeRuns.nodeId,
        status: nodeRuns.status,
      })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, input.nodeRunId))
      .get()
    if (
      holder === undefined ||
      holder.taskId !== owner.taskId ||
      holder.nodeId !== owner.nodeId ||
      !TERMINAL_NODE_RUN_STATUS_SET.has(holder.status)
    ) {
      return false
    }

    const repaired = tx
      .update(opencodeSessionOwners)
      .set({ leaseNodeRunId: null, leaseNonceDigest: null, leasedAt: null })
      .where(
        and(
          eq(opencodeSessionOwners.sessionId, input.sessionId),
          eq(opencodeSessionOwners.leaseNodeRunId, input.nodeRunId),
          eq(opencodeSessionOwners.leaseNonceDigest, input.leaseNonceDigest),
        ),
      )
      .returning({ sessionId: opencodeSessionOwners.sessionId })
      .all()
    return repaired.length === 1
  })
}
