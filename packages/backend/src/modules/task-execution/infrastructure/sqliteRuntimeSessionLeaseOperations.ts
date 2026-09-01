import { TERMINAL_NODE_RUN_STATUSES } from '@agent-workflow/shared'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { nodeRunEvents, nodeRuns, runtimeSessionLeases } from '@/db/schema'
import type {
  RuntimeSessionLeaseOperations,
  RuntimeSessionLeaseToken,
} from '../application/ports/runtimeSessionLeaseOperations'
import { RuntimeSessionLeaseError } from '../application/ports/runtimeSessionLeaseOperations'
import {
  withCurrentTaskExecutionMutation,
  withCurrentTaskExecutionTransaction,
  withTaskExecutionTransaction,
} from './sqliteOwnedTaskMutation'

const TERMINAL = new Set<string>(TERMINAL_NODE_RUN_STATUSES)

function fail(reason: string): never {
  throw new RuntimeSessionLeaseError(reason)
}

function constraintViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /runtime_session_leases|SQLITE_CONSTRAINT|UNIQUE constraint failed/i.test(message)
}

export function createSqliteRuntimeSessionLeaseOperations(
  db: DbClient,
): RuntimeSessionLeaseOperations {
  const operations: RuntimeSessionLeaseOperations = {
    async load(protocol, sessionId) {
      return db
        .select()
        .from(runtimeSessionLeases)
        .where(
          and(
            eq(runtimeSessionLeases.protocol, protocol),
            eq(runtimeSessionLeases.sessionId, sessionId),
          ),
        )
        .get()
    },

    async claimNew(input) {
      try {
        return withTaskExecutionTransaction({
          db,
          taskId: input.taskId,
          run: (tx) => {
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

            tx.insert(runtimeSessionLeases)
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
            tx.update(nodeRuns)
              .set({ opencodeSessionId: input.sessionId })
              .where(eq(nodeRuns.id, input.currentNodeRunId))
              .run()
            return {
              protocol: input.protocol,
              sessionId: input.sessionId,
              nodeRunId: input.currentNodeRunId,
              leaseNonceDigest: input.leaseNonceDigest,
            }
          },
        })
      } catch (error) {
        if (error instanceof RuntimeSessionLeaseError) throw error
        if (constraintViolation(error)) fail('owner-conflict')
        throw error
      }
    },

    async preclaimResume(input) {
      return withTaskExecutionTransaction({
        db,
        taskId: input.taskId,
        run: (tx) => {
          const owner = tx
            .select()
            .from(runtimeSessionLeases)
            .where(
              and(
                eq(runtimeSessionLeases.protocol, input.protocol),
                eq(runtimeSessionLeases.sessionId, input.sessionId),
              ),
            )
            .get()
          if (owner === undefined) fail('owner-missing')
          if (owner.taskId !== input.taskId || owner.nodeId !== input.nodeId) {
            fail('owner-mismatch')
          }
          if (owner.resetPending) fail('reset-pending')

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
            .all()
          if (claimed.length !== 1) fail('lease-held')
          return {
            protocol: input.protocol,
            sessionId: input.sessionId,
            nodeRunId: input.currentNodeRunId,
            leaseNonceDigest: input.leaseNonceDigest,
          }
        },
      })
    },

    async confirmResume(token) {
      return withCurrentTaskExecutionTransaction({
        db,
        run: (tx) => {
          const owner = tx
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
          return linked.length === 1
        },
      })
    },

    async rotate(token, nextSessionId) {
      try {
        return withCurrentTaskExecutionTransaction({
          db,
          run: (tx) => {
            const outgoing = tx
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
              .get()
            if (outgoing === undefined || outgoing.leasedAt === null || !outgoing.resetPending) {
              fail('lease-mismatch')
            }

            const run = tx
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
              .get()
            if (run === undefined) fail('run-not-claimable')

            const collision = tx
              .select({ sessionId: runtimeSessionLeases.sessionId })
              .from(runtimeSessionLeases)
              .where(
                and(
                  eq(runtimeSessionLeases.protocol, token.protocol),
                  eq(runtimeSessionLeases.sessionId, nextSessionId),
                ),
              )
              .get()
            if (collision !== undefined) fail('owner-conflict')

            tx.delete(runtimeSessionLeases)
              .where(
                and(
                  eq(runtimeSessionLeases.protocol, token.protocol),
                  eq(runtimeSessionLeases.sessionId, token.sessionId),
                  eq(runtimeSessionLeases.leaseNodeRunId, token.nodeRunId),
                  eq(runtimeSessionLeases.leaseNonceDigest, token.leaseNonceDigest),
                ),
              )
              .run()
            tx.insert(runtimeSessionLeases)
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
            const linked = tx
              .update(nodeRuns)
              .set({ opencodeSessionId: nextSessionId })
              .where(and(eq(nodeRuns.id, token.nodeRunId), isNull(nodeRuns.opencodeSessionId)))
              .returning({ id: nodeRuns.id })
              .all()
            if (linked.length !== 1) fail('run-not-claimable')

            const lineageRunIds = tx
              .select({ id: nodeRuns.id })
              .from(nodeRuns)
              .where(
                and(
                  eq(nodeRuns.taskId, outgoing.taskId),
                  eq(nodeRuns.nodeId, outgoing.nodeId),
                  eq(nodeRuns.opencodeSessionId, token.sessionId),
                ),
              )
              .all()
              .map((row) => row.id)
            if (lineageRunIds.length > 0) {
              tx.update(nodeRuns)
                .set({ opencodeSessionId: nextSessionId })
                .where(inArray(nodeRuns.id, lineageRunIds))
                .run()
            }

            const eventRunIds = [...new Set([token.nodeRunId, ...lineageRunIds])]
            tx.update(nodeRunEvents)
              .set({ sessionId: nextSessionId })
              .where(
                and(
                  inArray(nodeRunEvents.nodeRunId, eventRunIds),
                  eq(nodeRunEvents.sessionId, token.sessionId),
                  isNull(nodeRunEvents.parentSessionId),
                ),
              )
              .run()
            tx.update(nodeRunEvents)
              .set({ parentSessionId: nextSessionId })
              .where(
                and(
                  inArray(nodeRunEvents.nodeRunId, eventRunIds),
                  eq(nodeRunEvents.parentSessionId, token.sessionId),
                ),
              )
              .run()

            return { ...token, sessionId: nextSessionId }
          },
        })
      } catch (error) {
        if (error instanceof RuntimeSessionLeaseError) throw error
        if (constraintViolation(error)) fail('owner-conflict')
        throw error
      }
    },

    async markResetPending(token) {
      return withCurrentTaskExecutionTransaction({
        db,
        run: (tx) => {
          const held = tx
            .select({
              sessionId: runtimeSessionLeases.sessionId,
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
            .get()
          if (held === undefined) fail('lease-mismatch')
          if (held.resetPending) return true
          const fenced = tx
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
            .all()
          if (fenced.length !== 1) fail('lease-mismatch')
          const cleared = tx
            .update(nodeRuns)
            .set({ opencodeSessionId: null })
            .where(
              and(
                eq(nodeRuns.id, token.nodeRunId),
                eq(nodeRuns.opencodeSessionId, token.sessionId),
              ),
            )
            .returning({ id: nodeRuns.id })
            .all()
          return cleared.length === 1
        },
      })
    },

    async discard(token) {
      return withCurrentTaskExecutionTransaction({
        db,
        run: (tx) => {
          const held = tx
            .select({ sessionId: runtimeSessionLeases.sessionId })
            .from(runtimeSessionLeases)
            .where(
              and(
                eq(runtimeSessionLeases.protocol, token.protocol),
                eq(runtimeSessionLeases.sessionId, token.sessionId),
                eq(runtimeSessionLeases.leaseNodeRunId, token.nodeRunId),
                eq(runtimeSessionLeases.leaseNonceDigest, token.leaseNonceDigest),
              ),
            )
            .get()
          if (held === undefined) return false
          tx.update(nodeRuns)
            .set({ opencodeSessionId: null })
            .where(
              and(
                eq(nodeRuns.id, token.nodeRunId),
                eq(nodeRuns.opencodeSessionId, token.sessionId),
              ),
            )
            .run()
          const discarded = tx
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
            .all()
          return discarded.length === 1
        },
      })
    },

    async release(token) {
      const released = withCurrentTaskExecutionMutation({
        db,
        run: (tx) =>
          tx
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
            .all(),
      })
      return released.length === 1
    },

    async repairAfterOrphanReap(nodeRunId) {
      let repaired = 0
      const held = db
        .select()
        .from(runtimeSessionLeases)
        .where(
          nodeRunId === undefined
            ? sql`${runtimeSessionLeases.leaseNodeRunId} IS NOT NULL`
            : eq(runtimeSessionLeases.leaseNodeRunId, nodeRunId),
        )
        .all()
      for (const lease of held) {
        if (lease.leaseNodeRunId === null || lease.leaseNonceDigest === null) continue
        const run = db
          .select({
            status: nodeRuns.status,
            sessionId: nodeRuns.opencodeSessionId,
            failureCode: nodeRuns.failureCode,
          })
          .from(nodeRuns)
          .where(eq(nodeRuns.id, lease.leaseNodeRunId))
          .get()
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
