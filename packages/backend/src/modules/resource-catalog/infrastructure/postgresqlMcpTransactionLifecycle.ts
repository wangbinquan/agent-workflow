import { and, eq } from 'drizzle-orm'

import {
  mcpRuntimeTestCreateReceipts,
  mcpRuntimeTestSessions,
  mcpRuntimeTestSessionLeases,
} from '@/db/schema'
import { ConflictError } from '@/util/errors'
import type { PostgresqlMcpTransactionLifecycle } from './postgresqlMcpRepository'

type SessionRow = typeof mcpRuntimeTestSessions.$inferSelect

async function endNow(
  transaction: Parameters<PostgresqlMcpTransactionLifecycle['transitionMutation']>[0],
  session: SessionRow,
  reason: 'mcp-disabled',
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
    .run()
}

async function blockAfterTurn(
  transaction: Parameters<PostgresqlMcpTransactionLifecycle['transitionMutation']>[0],
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
    .run()
}

/**
 * Transaction-bound MCP runtime-test lifecycle for PostgreSQL catalog writes.
 * It records the same durable stop/block intent as SQLite without opening a
 * nested transaction; daemon cleanup remains the only process/filesystem owner.
 */
export function createPostgresqlMcpTransactionLifecycle(): PostgresqlMcpTransactionLifecycle {
  const lifecycle: PostgresqlMcpTransactionLifecycle = {
    async transitionMutation(transaction, input) {
      const sessions = await transaction
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
          await blockAfterTurn(transaction, session, input.now)
        } else {
          await endNow(transaction, session, input.reason, input.now)
        }
      }
    },

    async deletePrepared(transaction, mcpId) {
      const sessions = await transaction
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
        await transaction
          .delete(mcpRuntimeTestSessionLeases)
          .where(eq(mcpRuntimeTestSessionLeases.testSessionId, session.id))
          .run()
        await transaction
          .delete(mcpRuntimeTestSessions)
          .where(eq(mcpRuntimeTestSessions.id, session.id))
          .run()
      }
      await transaction
        .delete(mcpRuntimeTestCreateReceipts)
        .where(eq(mcpRuntimeTestCreateReceipts.mcpId, mcpId))
        .run()
    },
  }
  return Object.freeze(lifecycle)
}
