import { TERMINAL_NODE_RUN_STATUSES } from '@agent-workflow/shared'
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'

import { nodeRunEvents, nodeRuns, runtimeSessionLeases } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  RuntimeSessionLeaseOperations,
  RuntimeSessionLeaseToken,
} from '../application/ports/runtimeSessionLeaseOperations'
import { RuntimeSessionLeaseError } from '../application/ports/runtimeSessionLeaseOperations'
import { currentTaskExecutionContext } from '../application/taskExecutionContext'
import {
  assertPostgresqlTaskOwnerlessTx,
  assertPostgresqlTaskOwnerTx,
  type PostgresqlTaskExecutionTransaction,
  withPostgresqlSerializableTaskExecution,
} from './postgresqlTaskLifecycleTransaction'

const TERMINAL = new Set<string>(TERMINAL_NODE_RUN_STATUSES)

function fail(reason: string): never {
  throw new RuntimeSessionLeaseError(reason)
}

function constraintViolation(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { readonly code?: unknown }).code
    if (code === '23505' || code === '23514') return true
    current = (current as { readonly cause?: unknown }).cause
  }
  const message = error instanceof Error ? error.message : String(error)
  return /runtime_session_leases|duplicate key|unique constraint/i.test(message)
}

async function fence(
  tx: PostgresqlTaskExecutionTransaction,
  taskId: string,
  now: number,
): Promise<void> {
  const context = currentTaskExecutionContext(taskId)
  if (context === undefined) {
    await assertPostgresqlTaskOwnerlessTx(tx, taskId)
    return
  }
  await assertPostgresqlTaskOwnerTx(tx, context.token, now)
}

export function createPostgresqlRuntimeSessionLeaseOperations(
  db: PostgresqlDatabaseClient,
): RuntimeSessionLeaseOperations {
  const operations: RuntimeSessionLeaseOperations = {
    async load(protocol, sessionId) {
      const rows = await db
        .select()
        .from(runtimeSessionLeases)
        .where(
          and(
            eq(runtimeSessionLeases.protocol, protocol),
            eq(runtimeSessionLeases.sessionId, sessionId),
          ),
        )
        .limit(1)
      return rows[0]
    },

    async claimNew(input) {
      try {
        return await withPostgresqlSerializableTaskExecution(db, async (tx) => {
          await fence(tx, input.taskId, input.leasedAt)
          const runs = await tx
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
            .limit(1)
          if (runs[0] === undefined) fail('run-not-claimable')

          await tx
            .insert(runtimeSessionLeases)
            .values({
              protocol: input.protocol,
              sessionId: input.sessionId,
              taskId: input.taskId,
              nodeId: input.nodeId,
              createdNodeRunId: input.currentNodeRunId,
              leaseNodeRunId: input.currentNodeRunId,
              leaseNonceDigest: input.leaseNonceDigest,
              leasedAt: input.leasedAt,
              resetPending: false,
            })
            .run()
          await tx
            .update(nodeRuns)
            .set({ opencodeSessionId: input.sessionId })
            .where(eq(nodeRuns.id, input.currentNodeRunId))
            .run()
          return {
            protocol: input.protocol,
            sessionId: input.sessionId,
            nodeRunId: input.currentNodeRunId,
            leaseNonceDigest: input.leaseNonceDigest,
          }
        })
      } catch (error) {
        if (error instanceof RuntimeSessionLeaseError) throw error
        if (constraintViolation(error)) fail('owner-conflict')
        throw error
      }
    },

    async preclaimResume(input) {
      return await withPostgresqlSerializableTaskExecution(db, async (tx) => {
        await fence(tx, input.taskId, input.leasedAt)
        const owners = await tx
          .select()
          .from(runtimeSessionLeases)
          .where(
            and(
              eq(runtimeSessionLeases.protocol, input.protocol),
              eq(runtimeSessionLeases.sessionId, input.sessionId),
            ),
          )
          .limit(1)
        const owner = owners[0]
        if (owner === undefined) fail('owner-missing')
        if (owner.taskId !== input.taskId || owner.nodeId !== input.nodeId) fail('owner-mismatch')
        if (owner.resetPending) fail('reset-pending')

        const runs = await tx
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
          .limit(1)
        if (runs[0] === undefined) fail('run-not-claimable')

        const claimed = await tx
          .update(runtimeSessionLeases)
          .set({
            leaseNodeRunId: input.currentNodeRunId,
            leaseNonceDigest: input.leaseNonceDigest,
            leasedAt: input.leasedAt,
            resetPending: false,
          })
          .where(
            and(
              eq(runtimeSessionLeases.protocol, input.protocol),
              eq(runtimeSessionLeases.sessionId, input.sessionId),
              isNull(runtimeSessionLeases.leaseNodeRunId),
              isNull(runtimeSessionLeases.leaseNonceDigest),
              isNull(runtimeSessionLeases.leasedAt),
            ),
          )
          .returning({ sessionId: runtimeSessionLeases.sessionId })
        if (claimed.length !== 1) fail('lease-held')
        return {
          protocol: input.protocol,
          sessionId: input.sessionId,
          nodeRunId: input.currentNodeRunId,
          leaseNonceDigest: input.leaseNonceDigest,
        }
      })
    },

    async confirmResume(token) {
      return await withPostgresqlSerializableTaskExecution(db, async (tx) => {
        const owners = await tx
          .select({ taskId: runtimeSessionLeases.taskId, nodeId: runtimeSessionLeases.nodeId })
          .from(runtimeSessionLeases)
          .where(
            and(
              eq(runtimeSessionLeases.protocol, token.protocol),
              eq(runtimeSessionLeases.sessionId, token.sessionId),
              eq(runtimeSessionLeases.leaseNodeRunId, token.nodeRunId),
              eq(runtimeSessionLeases.leaseNonceDigest, token.leaseNonceDigest),
            ),
          )
          .limit(1)
        const owner = owners[0]
        if (owner === undefined) fail('lease-mismatch')
        await fence(tx, owner.taskId, Date.now())
        const linked = await tx
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
        return linked.length === 1
      })
    },

    async rotate(token, nextSessionId) {
      try {
        return await withPostgresqlSerializableTaskExecution(db, async (tx) => {
          const outgoingRows = await tx
            .select()
            .from(runtimeSessionLeases)
            .where(
              and(
                eq(runtimeSessionLeases.protocol, token.protocol),
                eq(runtimeSessionLeases.sessionId, token.sessionId),
                eq(runtimeSessionLeases.leaseNodeRunId, token.nodeRunId),
                eq(runtimeSessionLeases.leaseNonceDigest, token.leaseNonceDigest),
              ),
            )
            .limit(1)
          const outgoing = outgoingRows[0]
          if (outgoing === undefined || outgoing.leasedAt === null || !outgoing.resetPending) {
            fail('lease-mismatch')
          }
          await fence(tx, outgoing.taskId, Date.now())

          const runs = await tx
            .select({ id: nodeRuns.id })
            .from(nodeRuns)
            .where(
              and(
                eq(nodeRuns.id, token.nodeRunId),
                eq(nodeRuns.taskId, outgoing.taskId),
                eq(nodeRuns.nodeId, outgoing.nodeId),
                eq(nodeRuns.status, 'running'),
                isNull(nodeRuns.opencodeSessionId),
              ),
            )
            .limit(1)
          if (runs[0] === undefined) fail('run-not-claimable')

          const collisions = await tx
            .select({ sessionId: runtimeSessionLeases.sessionId })
            .from(runtimeSessionLeases)
            .where(
              and(
                eq(runtimeSessionLeases.protocol, token.protocol),
                eq(runtimeSessionLeases.sessionId, nextSessionId),
              ),
            )
            .limit(1)
          if (collisions[0] !== undefined) fail('owner-conflict')

          await tx
            .delete(runtimeSessionLeases)
            .where(
              and(
                eq(runtimeSessionLeases.protocol, token.protocol),
                eq(runtimeSessionLeases.sessionId, token.sessionId),
                eq(runtimeSessionLeases.leaseNodeRunId, token.nodeRunId),
                eq(runtimeSessionLeases.leaseNonceDigest, token.leaseNonceDigest),
              ),
            )
            .run()
          await tx
            .insert(runtimeSessionLeases)
            .values({
              protocol: token.protocol,
              sessionId: nextSessionId,
              taskId: outgoing.taskId,
              nodeId: outgoing.nodeId,
              createdNodeRunId: outgoing.createdNodeRunId,
              leaseNodeRunId: token.nodeRunId,
              leaseNonceDigest: token.leaseNonceDigest,
              leasedAt: outgoing.leasedAt,
              resetPending: false,
            })
            .run()
          const linked = await tx
            .update(nodeRuns)
            .set({ opencodeSessionId: nextSessionId })
            .where(and(eq(nodeRuns.id, token.nodeRunId), isNull(nodeRuns.opencodeSessionId)))
            .returning({ id: nodeRuns.id })
          if (linked.length !== 1) fail('run-not-claimable')

          const lineageRows = await tx
            .select({ id: nodeRuns.id })
            .from(nodeRuns)
            .where(
              and(
                eq(nodeRuns.taskId, outgoing.taskId),
                eq(nodeRuns.nodeId, outgoing.nodeId),
                eq(nodeRuns.opencodeSessionId, token.sessionId),
              ),
            )
          const lineageRunIds = lineageRows.map((row) => row.id)
          if (lineageRunIds.length > 0) {
            await tx
              .update(nodeRuns)
              .set({ opencodeSessionId: nextSessionId })
              .where(inArray(nodeRuns.id, lineageRunIds))
              .run()
          }

          const eventRunIds = [...new Set([token.nodeRunId, ...lineageRunIds])]
          await tx
            .update(nodeRunEvents)
            .set({ sessionId: nextSessionId })
            .where(
              and(
                inArray(nodeRunEvents.nodeRunId, eventRunIds),
                eq(nodeRunEvents.sessionId, token.sessionId),
                isNull(nodeRunEvents.parentSessionId),
              ),
            )
            .run()
          await tx
            .update(nodeRunEvents)
            .set({ parentSessionId: nextSessionId })
            .where(
              and(
                inArray(nodeRunEvents.nodeRunId, eventRunIds),
                eq(nodeRunEvents.parentSessionId, token.sessionId),
              ),
            )
            .run()

          return { ...token, sessionId: nextSessionId }
        })
      } catch (error) {
        if (error instanceof RuntimeSessionLeaseError) throw error
        if (constraintViolation(error)) fail('owner-conflict')
        throw error
      }
    },

    async markResetPending(token) {
      return await withPostgresqlSerializableTaskExecution(db, async (tx) => {
        const heldRows = await tx
          .select({
            taskId: runtimeSessionLeases.taskId,
            resetPending: runtimeSessionLeases.resetPending,
          })
          .from(runtimeSessionLeases)
          .where(
            and(
              eq(runtimeSessionLeases.protocol, token.protocol),
              eq(runtimeSessionLeases.sessionId, token.sessionId),
              eq(runtimeSessionLeases.leaseNodeRunId, token.nodeRunId),
              eq(runtimeSessionLeases.leaseNonceDigest, token.leaseNonceDigest),
            ),
          )
          .limit(1)
        const held = heldRows[0]
        if (held === undefined) fail('lease-mismatch')
        await fence(tx, held.taskId, Date.now())
        if (held.resetPending) return true
        const fenced = await tx
          .update(runtimeSessionLeases)
          .set({ resetPending: true })
          .where(
            and(
              eq(runtimeSessionLeases.protocol, token.protocol),
              eq(runtimeSessionLeases.sessionId, token.sessionId),
              eq(runtimeSessionLeases.leaseNodeRunId, token.nodeRunId),
              eq(runtimeSessionLeases.leaseNonceDigest, token.leaseNonceDigest),
              eq(runtimeSessionLeases.resetPending, false),
            ),
          )
          .returning({ sessionId: runtimeSessionLeases.sessionId })
        if (fenced.length !== 1) fail('lease-mismatch')
        const cleared = await tx
          .update(nodeRuns)
          .set({ opencodeSessionId: null })
          .where(
            and(eq(nodeRuns.id, token.nodeRunId), eq(nodeRuns.opencodeSessionId, token.sessionId)),
          )
          .returning({ id: nodeRuns.id })
        return cleared.length === 1
      })
    },

    async discard(token) {
      return await withPostgresqlSerializableTaskExecution(db, async (tx) => {
        const heldRows = await tx
          .select({ taskId: runtimeSessionLeases.taskId })
          .from(runtimeSessionLeases)
          .where(
            and(
              eq(runtimeSessionLeases.protocol, token.protocol),
              eq(runtimeSessionLeases.sessionId, token.sessionId),
              eq(runtimeSessionLeases.leaseNodeRunId, token.nodeRunId),
              eq(runtimeSessionLeases.leaseNonceDigest, token.leaseNonceDigest),
            ),
          )
          .limit(1)
        const held = heldRows[0]
        if (held === undefined) return false
        await fence(tx, held.taskId, Date.now())
        await tx
          .update(nodeRuns)
          .set({ opencodeSessionId: null })
          .where(
            and(eq(nodeRuns.id, token.nodeRunId), eq(nodeRuns.opencodeSessionId, token.sessionId)),
          )
          .run()
        const discarded = await tx
          .delete(runtimeSessionLeases)
          .where(
            and(
              eq(runtimeSessionLeases.protocol, token.protocol),
              eq(runtimeSessionLeases.sessionId, token.sessionId),
              eq(runtimeSessionLeases.leaseNodeRunId, token.nodeRunId),
              eq(runtimeSessionLeases.leaseNonceDigest, token.leaseNonceDigest),
            ),
          )
          .returning({ sessionId: runtimeSessionLeases.sessionId })
        return discarded.length === 1
      })
    },

    async release(token) {
      return await withPostgresqlSerializableTaskExecution(db, async (tx) => {
        const heldRows = await tx
          .select({ taskId: runtimeSessionLeases.taskId })
          .from(runtimeSessionLeases)
          .where(
            and(
              eq(runtimeSessionLeases.protocol, token.protocol),
              eq(runtimeSessionLeases.sessionId, token.sessionId),
              eq(runtimeSessionLeases.leaseNodeRunId, token.nodeRunId),
              eq(runtimeSessionLeases.leaseNonceDigest, token.leaseNonceDigest),
            ),
          )
          .limit(1)
        const held = heldRows[0]
        if (held === undefined) return false
        await fence(tx, held.taskId, Date.now())
        const released = await tx
          .update(runtimeSessionLeases)
          .set({ leaseNodeRunId: null, leaseNonceDigest: null, leasedAt: null })
          .where(
            and(
              eq(runtimeSessionLeases.protocol, token.protocol),
              eq(runtimeSessionLeases.sessionId, token.sessionId),
              eq(runtimeSessionLeases.leaseNodeRunId, token.nodeRunId),
              eq(runtimeSessionLeases.leaseNonceDigest, token.leaseNonceDigest),
              eq(runtimeSessionLeases.resetPending, false),
            ),
          )
          .returning({ sessionId: runtimeSessionLeases.sessionId })
        return released.length === 1
      })
    },

    async repairAfterOrphanReap(nodeRunId) {
      let repaired = 0
      const held = await db
        .select()
        .from(runtimeSessionLeases)
        .where(
          nodeRunId === undefined
            ? isNotNull(runtimeSessionLeases.leaseNodeRunId)
            : eq(runtimeSessionLeases.leaseNodeRunId, nodeRunId),
        )
      for (const lease of held) {
        if (lease.leaseNodeRunId === null || lease.leaseNonceDigest === null) continue
        const runRows = await db
          .select({
            status: nodeRuns.status,
            sessionId: nodeRuns.opencodeSessionId,
            failureCode: nodeRuns.failureCode,
          })
          .from(nodeRuns)
          .where(eq(nodeRuns.id, lease.leaseNodeRunId))
          .limit(1)
        const run = runRows[0]
        if (run === undefined || !TERMINAL.has(run.status)) continue
        const token: RuntimeSessionLeaseToken = {
          protocol: lease.protocol,
          sessionId: lease.sessionId,
          nodeRunId: lease.leaseNodeRunId,
          leaseNonceDigest: lease.leaseNonceDigest,
        }
        const repairedLease =
          run.failureCode !== 'runtime-session-identity-invalid' &&
          !lease.resetPending &&
          run.sessionId === lease.sessionId
            ? await operations.release(token)
            : await operations.discard(token)
        if (repairedLease) repaired += 1
      }
      return repaired
    },
  }
  return Object.freeze(operations)
}
