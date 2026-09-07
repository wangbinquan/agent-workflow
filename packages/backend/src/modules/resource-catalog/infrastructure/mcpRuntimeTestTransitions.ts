// RFC-238 / RFC-359 W4-D16 —— MCP 运行时测试会话的事务内生命周期失效：一份实现，两个 provider 共用。
//
// 规范写者（MCP 目录 / ACL）在同一笔事务里先调用这些函数写下**持久意图**（结束 / 阻塞），提交后由 daemon 侧
// 协调器执行 abort / reap / cleanup。ACL 变更那条判定（失去可见性的观众结束、保留的观众阻塞到本回合后）
// 此前只有 SQLite 有，PG 版漏了——现在两边同一份。
// `legacy/mcpRuntimeTestTransitions.ts` 的同步版仍服务 runtime / user 写者（它们尚未迁到统一事务），随其各自合一退役。

import { and, eq, inArray, isNull } from 'drizzle-orm'
import {
  normalizeStoredAdditionalPermissions,
  resolveEffectiveAccountPermissions,
} from '@agent-workflow/shared'

import {
  mcpRuntimeTestCreateReceipts,
  mcpRuntimeTestSessions,
  mcpRuntimeTestSessionLeases,
  runtimes,
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
  reason:
    | 'mcp-disabled'
    | 'mcp-deleted'
    | 'access-revoked'
    | 'runtime-disabled'
    | 'runtime-deleted',
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
  reason: 'mcp-config-changed' | 'runtime-profile-changed',
  now: number,
): Promise<void> {
  await transaction
    .update(mcpRuntimeTestSessions)
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
    if (input.reason === 'mcp-config-changed')
      await blockAfterTurn(transaction, session, input.reason, input.now)
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
    else await blockAfterTurn(transaction, session, 'mcp-config-changed', input.now)
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

/**
 * RFC-359 W4-D28b —— runtime 写者的会话失效：一份实现，两个 provider 共用。
 *
 * 此前 SQLite 走 `legacy/mcpRuntimeTestTransitions.ts` 的同步版，PostgreSQL 则在
 * `postgresqlRuntimeRegistryPersistence.ts` 里**内联重写了一份**（本地 `transitionRuntimeTests` /
 * `transitionRuntimeTest`）。两份逐字段对过账：`runtime-profile-changed` 走「本回合后阻塞」、
 * 其余两个原因走「立即结束」，写入的列与取值完全一致——属纯重复，合一到这里。
 */
export async function transitionRuntimeTests(
  transaction: DatabaseTransaction,
  input: {
    readonly runtimeName: string
    readonly reason: 'runtime-profile-changed' | 'runtime-disabled' | 'runtime-deleted'
    readonly now: number
  },
): Promise<void> {
  const sessions = await transaction
    .select()
    .from(mcpRuntimeTestSessions)
    .where(
      and(
        eq(mcpRuntimeTestSessions.runtimeName, input.runtimeName),
        eq(mcpRuntimeTestSessions.status, 'active'),
      ),
    )
  for (const session of sessions) {
    if (input.reason === 'runtime-profile-changed')
      await blockAfterTurn(transaction, session, input.reason, input.now)
    else await endNow(transaction, session, input.reason, input.now)
  }
}

/**
 * 继承型 runtime（没有自己的 `binaryPath`，跟着协议默认走）在协议侧变更时一并失效。
 * 原因固定为 `runtime-profile-changed`——变的是它继承的那份画像，不是它自己被停用或删除。
 */
export async function transitionInheritedRuntimeTests(
  transaction: DatabaseTransaction,
  input: {
    readonly protocols: readonly ('opencode' | 'claude-code')[]
    readonly now: number
  },
): Promise<void> {
  if (input.protocols.length === 0) return
  const inherited = await transaction
    .select({ name: runtimes.name })
    .from(runtimes)
    .where(and(inArray(runtimes.protocol, [...input.protocols]), isNull(runtimes.binaryPath)))
  for (const row of inherited) {
    await transitionRuntimeTests(transaction, {
      runtimeName: row.name,
      reason: 'runtime-profile-changed',
      now: input.now,
    })
  }
}
