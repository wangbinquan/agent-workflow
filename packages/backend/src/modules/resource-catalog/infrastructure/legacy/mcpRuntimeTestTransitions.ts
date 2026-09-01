// RFC-238 — transaction-local lifecycle invalidation helpers.
//
// Canonical MCP/runtime/user/ACL writers call these before committing their
// own mutation. They only write durable intent; the daemon-scoped coordinator
// performs abort/reap/cleanup after commit.

import { and, eq, inArray, isNull } from 'drizzle-orm'
import {
  normalizeStoredAdditionalPermissions,
  resolveEffectiveAccountPermissions,
} from '@agent-workflow/shared'
import { isVisibleToAudienceSnapshot } from '../../domain/resourceAccess'
import { listResourceGrantUserIdsInTx } from '../sqliteResourceGrantRepository'
import type { DbTxSync } from '@/db/txSync'
import {
  mcpRuntimeTestCreateReceipts,
  mcpRuntimeTestSessions,
  mcpRuntimeTestSessionLeases,
  runtimes,
  userPermissionGrants,
  users,
} from '@/db/schema'
import { ConflictError } from '@/util/errors'

type SessionRow = typeof mcpRuntimeTestSessions.$inferSelect

function endNow(
  tx: DbTxSync,
  session: SessionRow,
  reason:
    | 'mcp-disabled'
    | 'mcp-deleted'
    | 'access-revoked'
    | 'runtime-disabled'
    | 'runtime-deleted',
  now: number,
): void {
  tx.update(mcpRuntimeTestSessions)
    .set({
      status: 'ending',
      endReason: reason,
      idleDeadlineAt: null,
      sessionVersion: session.sessionVersion + 1,
      updatedAt: now,
    })
    .where(eq(mcpRuntimeTestSessions.id, session.id))
    .run()
}

function blockAfterTurn(
  tx: DbTxSync,
  session: SessionRow,
  reason: 'mcp-config-changed' | 'runtime-profile-changed',
  now: number,
): void {
  tx.update(mcpRuntimeTestSessions)
    .set(
      session.inFlightTurnId === null
        ? {
            status: 'ending',
            endReason: reason,
            continuationBlockedReason: reason,
            idleDeadlineAt: null,
            sessionVersion: session.sessionVersion + 1,
            updatedAt: now,
          }
        : {
            continuationBlockedReason: reason,
            sessionVersion: session.sessionVersion + 1,
            updatedAt: now,
          },
    )
    .where(eq(mcpRuntimeTestSessions.id, session.id))
    .run()
}

export function transitionMcpRuntimeTestsInTx(
  tx: DbTxSync,
  input: {
    mcpId: string
    reason: 'mcp-config-changed' | 'mcp-disabled' | 'mcp-deleted'
    now: number
  },
): void {
  const sessions = tx
    .select()
    .from(mcpRuntimeTestSessions)
    .where(
      and(
        eq(mcpRuntimeTestSessions.mcpId, input.mcpId),
        eq(mcpRuntimeTestSessions.status, 'active'),
      ),
    )
    .all()
  for (const session of sessions) {
    if (input.reason === 'mcp-config-changed') {
      blockAfterTurn(tx, session, input.reason, input.now)
    } else {
      endNow(tx, session, input.reason, input.now)
    }
  }
}

export function transitionMcpAclRuntimeTestsInTx(
  tx: DbTxSync,
  input: {
    mcpId: string
    ownerUserId: string | null
    visibility: 'public' | 'private'
    grantedUserIds: ReadonlySet<string>
    now: number
  },
): void {
  const sessions = tx
    .select()
    .from(mcpRuntimeTestSessions)
    .where(
      and(
        eq(mcpRuntimeTestSessions.mcpId, input.mcpId),
        eq(mcpRuntimeTestSessions.status, 'active'),
      ),
    )
    .all()
  for (const session of sessions) {
    const account = tx
      .select({ role: users.role, status: users.status })
      .from(users)
      .where(eq(users.id, session.ownerUserId))
      .get()
    const storedPermissions = tx
      .select({ permission: userPermissionGrants.permission })
      .from(userPermissionGrants)
      .where(eq(userPermissionGrants.userId, session.ownerUserId))
      .all()
      .map((grant) => grant.permission)
    const accountPermissions =
      account === undefined
        ? null
        : resolveEffectiveAccountPermissions({
            role: account.role,
            additionalPermissions: normalizeStoredAdditionalPermissions({
              role: account.role,
              additionalPermissions: storedPermissions,
            }).additionalPermissions,
          })
    // RFC-284 T10（§2.4）：可见性四分支收编快照判定；status 检查按设计留调用方。
    const stillVisible =
      account?.status === 'active' &&
      accountPermissions !== null &&
      isVisibleToAudienceSnapshot(
        session.ownerUserId,
        {
          bypass: accountPermissions.has('resource-acl:bypass'),
          private: accountPermissions.has('resource-acl:private'),
        },
        input,
      )
    if (!stillVisible) {
      endNow(tx, session, 'access-revoked', input.now)
    } else {
      blockAfterTurn(tx, session, 'mcp-config-changed', input.now)
    }
  }
}

export function transitionRuntimeTestsInTx(
  tx: DbTxSync,
  input: {
    runtimeName: string
    reason: 'runtime-profile-changed' | 'runtime-disabled' | 'runtime-deleted'
    now: number
  },
): void {
  const sessions = tx
    .select()
    .from(mcpRuntimeTestSessions)
    .where(
      and(
        eq(mcpRuntimeTestSessions.runtimeName, input.runtimeName),
        eq(mcpRuntimeTestSessions.status, 'active'),
      ),
    )
    .all()
  for (const session of sessions) {
    if (input.reason === 'runtime-profile-changed') {
      blockAfterTurn(tx, session, input.reason, input.now)
    } else {
      endNow(tx, session, input.reason, input.now)
    }
  }
}

export function transitionInheritedRuntimeTestsInTx(
  tx: DbTxSync,
  input: {
    protocols: readonly ('opencode' | 'claude-code')[]
    now: number
  },
): void {
  if (input.protocols.length === 0) return
  const inheritedRuntimeNames = tx
    .select({ name: runtimes.name })
    .from(runtimes)
    .where(and(inArray(runtimes.protocol, [...input.protocols]), isNull(runtimes.binaryPath)))
    .all()
    .map((row) => row.name)
  for (const runtimeName of inheritedRuntimeNames) {
    const sessions = tx
      .select()
      .from(mcpRuntimeTestSessions)
      .where(
        and(
          eq(mcpRuntimeTestSessions.runtimeName, runtimeName),
          eq(mcpRuntimeTestSessions.status, 'active'),
        ),
      )
      .all()
    for (const session of sessions) {
      blockAfterTurn(tx, session, 'runtime-profile-changed', input.now)
    }
  }
}

export function transitionOwnerRuntimeTestsInTx(
  tx: DbTxSync,
  ownerUserId: string,
  now: number,
): void {
  const sessions = tx
    .select()
    .from(mcpRuntimeTestSessions)
    .where(
      and(
        eq(mcpRuntimeTestSessions.ownerUserId, ownerUserId),
        eq(mcpRuntimeTestSessions.status, 'active'),
      ),
    )
    .all()
  for (const session of sessions) endNow(tx, session, 'access-revoked', now)
}

/**
 * Final MCP-delete DB barrier. Process/scratch cleanup happens before entering
 * the canonical MCP mutation; these dependent rows are removed only inside
 * the same transaction that deletes the MCP itself.
 */
export function deletePreparedMcpRuntimeTestsInTx(tx: DbTxSync, mcpId: string): void {
  const sessions = tx
    .select({
      id: mcpRuntimeTestSessions.id,
      status: mcpRuntimeTestSessions.status,
      cleanupState: mcpRuntimeTestSessions.cleanupState,
    })
    .from(mcpRuntimeTestSessions)
    .where(eq(mcpRuntimeTestSessions.mcpId, mcpId))
    .all()
  const unsafe = sessions.find(
    (session) => session.status !== 'ended' || session.cleanupState !== 'complete',
  )
  if (unsafe !== undefined) {
    throw new ConflictError(
      'mcp-test-cleanup-incomplete',
      'an MCP runtime test could not be safely stopped',
      { sessionId: unsafe.id },
    )
  }
  for (const session of sessions) {
    tx.delete(mcpRuntimeTestSessionLeases)
      .where(eq(mcpRuntimeTestSessionLeases.testSessionId, session.id))
      .run()
    tx.delete(mcpRuntimeTestSessions).where(eq(mcpRuntimeTestSessions.id, session.id)).run()
  }
  tx.delete(mcpRuntimeTestCreateReceipts).where(eq(mcpRuntimeTestCreateReceipts.mcpId, mcpId)).run()
}

/** Test/helper query for the canonical ACL grant set already materialized in tx. */
export function mcpGrantIdsInTx(tx: DbTxSync, mcpId: string): ReadonlySet<string> {
  // RFC-284 T10（§2.3）：收编 resourceAcl 单点。
  return new Set(listResourceGrantUserIdsInTx(tx, 'mcp', mcpId))
}
