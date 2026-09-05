// RFC-238 / RFC-359 W4-D16 —— MCP 运行时测试会话的事务内生命周期失效：一份实现，两个 provider 共用。
//
// 规范写者（MCP 目录 / ACL）在同一笔事务里先调用这些函数写下**持久意图**（结束 / 阻塞），提交后由 daemon 侧
// 协调器执行 abort / reap / cleanup。ACL 变更那条判定（失去可见性的观众结束、保留的观众阻塞到本回合后）
// 此前只有 SQLite 有，PG 版漏了——现在两边同一份。
// `legacy/mcpRuntimeTestTransitions.ts` 的同步版仍服务 runtime / user 写者（它们尚未迁到统一事务），随其各自合一退役。

import { and, eq } from 'drizzle-orm'
import {
  normalizeStoredAdditionalPermissions,
  resolveEffectiveAccountPermissions,
} from '@agent-workflow/shared'

import {
  mcpRuntimeTestCreateReceipts,
  mcpRuntimeTestSessions,
  mcpRuntimeTestSessionLeases,
  userPermissionGrants,
  users,
} from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { ConflictError } from '@/util/errors'
import { isVisibleToAudienceSnapshot } from '../domain/resourceAccess'

type SessionRow = typeof mcpRuntimeTestSessions.$inferSelect

async function endNow(
  transaction: DatabaseTransaction,
  session: SessionRow,
  reason: 'mcp-disabled' | 'mcp-deleted' | 'access-revoked',
  now: number,
): Promise<void> {
  await transaction
    .update(mcpRuntimeTestSessions)
    .set({
      status: 'ending',
      endReason: reason,
      idleDeadlineAt: null,
      sessionVersion: session.sessionVersion + 1,
      updatedAt: now,
    })
    .where(eq(mcpRuntimeTestSessions.id, session.id))
}

async function blockAfterTurn(
  transaction: DatabaseTransaction,
  session: SessionRow,
  now: number,
): Promise<void> {
  await transaction
    .update(mcpRuntimeTestSessions)
    .set(
      session.inFlightTurnId === null
        ? {
            status: 'ending',
            endReason: 'mcp-config-changed',
            continuationBlockedReason: 'mcp-config-changed',
            idleDeadlineAt: null,
            sessionVersion: session.sessionVersion + 1,
            updatedAt: now,
          }
        : {
            continuationBlockedReason: 'mcp-config-changed',
            sessionVersion: session.sessionVersion + 1,
            updatedAt: now,
          },
    )
    .where(eq(mcpRuntimeTestSessions.id, session.id))
}

async function activeSessionsOf(
  transaction: DatabaseTransaction,
  mcpId: string,
): Promise<SessionRow[]> {
  return await transaction
    .select()
    .from(mcpRuntimeTestSessions)
    .where(
      and(eq(mcpRuntimeTestSessions.mcpId, mcpId), eq(mcpRuntimeTestSessions.status, 'active')),
    )
}

export async function transitionMcpRuntimeTests(
  transaction: DatabaseTransaction,
  input: {
    readonly mcpId: string
    readonly reason: 'mcp-config-changed' | 'mcp-disabled' | 'mcp-deleted'
    readonly now: number
  },
): Promise<void> {
  for (const session of await activeSessionsOf(transaction, input.mcpId)) {
    if (input.reason === 'mcp-config-changed') await blockAfterTurn(transaction, session, input.now)
    else await endNow(transaction, session, input.reason, input.now)
  }
}

/** ACL 变更：失去可见性的观众结束（access-revoked），保留的观众阻塞到本回合后重新协商。 */
export async function transitionMcpAclRuntimeTests(
  transaction: DatabaseTransaction,
  input: {
    readonly mcpId: string
    readonly ownerUserId: string | null
    readonly visibility: 'public' | 'private'
    readonly grantedUserIds: ReadonlySet<string>
    readonly now: number
  },
): Promise<void> {
  for (const session of await activeSessionsOf(transaction, input.mcpId)) {
    const account = (
      await transaction
        .select({ role: users.role, status: users.status })
        .from(users)
        .where(eq(users.id, session.ownerUserId))
        .limit(1)
    )[0]
    const storedPermissions = (
      await transaction
        .select({ permission: userPermissionGrants.permission })
        .from(userPermissionGrants)
        .where(eq(userPermissionGrants.userId, session.ownerUserId))
    ).map((grant) => grant.permission)
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
    if (!stillVisible) await endNow(transaction, session, 'access-revoked', input.now)
    else await blockAfterTurn(transaction, session, input.now)
  }
}

/**
 * MCP 最终删除的库内屏障：进程 / scratch 清理在进入规范 MCP 变更之前完成；依赖行只在删除 MCP 的同一笔事务里移除，
 * 任何未安全停止的会话让删除失败（mcp-test-cleanup-incomplete）。
 */
export async function deletePreparedMcpRuntimeTests(
  transaction: DatabaseTransaction,
  mcpId: string,
): Promise<void> {
  const sessions = await transaction
    .select({
      id: mcpRuntimeTestSessions.id,
      status: mcpRuntimeTestSessions.status,
      cleanupState: mcpRuntimeTestSessions.cleanupState,
    })
    .from(mcpRuntimeTestSessions)
    .where(eq(mcpRuntimeTestSessions.mcpId, mcpId))
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
    await transaction
      .delete(mcpRuntimeTestSessionLeases)
      .where(eq(mcpRuntimeTestSessionLeases.testSessionId, session.id))
    await transaction
      .delete(mcpRuntimeTestSessions)
      .where(eq(mcpRuntimeTestSessions.id, session.id))
  }
  await transaction
    .delete(mcpRuntimeTestCreateReceipts)
    .where(eq(mcpRuntimeTestCreateReceipts.mcpId, mcpId))
}
