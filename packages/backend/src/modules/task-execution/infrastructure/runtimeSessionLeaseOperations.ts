import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { TERMINAL_NODE_RUN_STATUSES } from '@agent-workflow/shared'
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'
import type { EngineCapabilities } from '@/platform/persistence/capabilities'
import {
  type RuntimeSessionLeaseOperations,
  type RuntimeSessionLeaseToken,
  RuntimeSessionLeaseError,
} from '../application/ports/runtimeSessionLeaseOperations'

import {
  fenceTaskWrite,
  withTaskExecutionAggregateWrite,
  type TaskExecutionTransaction,
} from './ownedTaskExecution'

import { compareAndWriteRunSessionInTx } from './nodeRunWriteProtocol'

import { taskAggregateWrite } from './taskDefinitionWriteParticipant'

const TERMINAL = new Set<string>(TERMINAL_NODE_RUN_STATUSES)

function fail(reason: string): never {
  throw new RuntimeSessionLeaseError(reason)
}

/**
 * RFC-397：只有租约主键 `(protocol, session_id)` 冲突是重复认领；其它表的唯一键、FK、CHECK 错误原样传播。
 * 冲突目标经能力矩阵取得（PG 给约束名 `runtime_session_leases_pkey`，SQLite 给列清单），一条正则两边都认。
 */
function constraintViolation(engine: EngineCapabilities, error: unknown): boolean {
  const target = engine.uniqueViolationTarget(error)
  return (
    target !== undefined &&
    /^runtime_session_leases(?:_pkey|\.protocol, runtime_session_leases\.session_id)$/.test(target)
  )
}

/** 按「当前执行上下文 > 无主」为一次租约写入选围栏（与其余 owned 写手同一份 `fenceTaskWrite`）。 */
async function fence(tx: TaskExecutionTransaction, taskId: string, now: number): Promise<void> {
  await fenceTaskWrite(tx, { taskId, now })
  await taskAggregateWrite.lockTaskAggregateRoot(tx, taskId)
}

export function createRuntimeSessionLeaseOperations(
  db: PersistenceDb,
): RuntimeSessionLeaseOperations {
  const engine = databaseSessionFor(db).engine
  const operations: RuntimeSessionLeaseOperations = {
    async load(protocol, sessionId) {
      const { runtimeSessionLeases } = tablesOf(db)
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
        return await withTaskExecutionAggregateWrite(db, async (tx) => {
          await fence(tx, input.taskId, input.leasedAt)
          const { runtimeSessionLeases } = tablesOf(tx)
          const { nodeRuns, nodeRunRuntimeStates } = tablesOf(tx)
          const runs = await tx
            .select({ id: nodeRuns.id })
            .from(nodeRuns)
            .leftJoin(nodeRunRuntimeStates, eq(nodeRunRuntimeStates.nodeRunId, nodeRuns.id))
            .where(
              and(
                eq(nodeRuns.id, input.currentNodeRunId),
                eq(nodeRuns.taskId, input.taskId),
                eq(nodeRuns.nodeId, input.nodeId),
                eq(nodeRuns.status, 'running'),
                isNull(nodeRunRuntimeStates.sessionId),
              ),
            )
            .limit(1)
          if (runs[0] === undefined) fail('run-not-claimable')

          await insertOne(tx, runtimeSessionLeases, {
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
          if (
            !(await compareAndWriteRunSessionInTx(
              tx,
              input.currentNodeRunId,
              null,
              input.sessionId,
              { taskId: input.taskId, nodeId: input.nodeId, status: 'running' },
            ))
          )
            fail('run-not-claimable')
          const token: RuntimeSessionLeaseToken = {
            protocol: input.protocol,
            sessionId: input.sessionId,
            nodeRunId: input.currentNodeRunId,
            leaseNonceDigest: input.leaseNonceDigest,
          }
          return token
        })
      } catch (error) {
        if (error instanceof RuntimeSessionLeaseError) throw error
        if (constraintViolation(engine, error)) fail('owner-conflict')
        throw error
      }
    },

    async preclaimResume(input) {
      return await withTaskExecutionAggregateWrite(db, async (tx) => {
        await fence(tx, input.taskId, input.leasedAt)
        const { runtimeSessionLeases } = tablesOf(tx)
        const { nodeRuns, nodeRunRuntimeStates } = tablesOf(tx)
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
          .leftJoin(nodeRunRuntimeStates, eq(nodeRunRuntimeStates.nodeRunId, nodeRuns.id))
          .where(
            and(
              eq(nodeRuns.id, input.currentNodeRunId),
              eq(nodeRuns.taskId, input.taskId),
              eq(nodeRuns.nodeId, input.nodeId),
              eq(nodeRuns.status, 'running'),
              isNull(nodeRunRuntimeStates.sessionId),
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
              eq(runtimeSessionLeases.taskId, input.taskId),
              eq(runtimeSessionLeases.nodeId, input.nodeId),
              eq(runtimeSessionLeases.resetPending, false),
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
      return await withTaskExecutionAggregateWrite(db, async (tx) => {
        const { runtimeSessionLeases } = tablesOf(tx)
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
        // RFC-397：排他锁后按完整 token 重读，不能沿用等待围栏之前的租约快照。
        await engineOf(tx).lockAggregateRoot(
          tx,
          runtimeSessionLeases,
          runtimeSessionLeases.sessionId,
          token.sessionId,
        )
        const [held] = await tx
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
          .limit(1)
        if (held === undefined) fail('lease-mismatch')
        return compareAndWriteRunSessionInTx(tx, token.nodeRunId, null, token.sessionId, {
          taskId: owner.taskId,
          nodeId: owner.nodeId,
          status: 'running',
        })
      })
    },

    async rotate(token, nextSessionId) {
      try {
        return await withTaskExecutionAggregateWrite(db, async (tx) => {
          const { runtimeSessionLeases, nodeRunEvents } = tablesOf(tx)
          const { nodeRuns, nodeRunRuntimeStates } = tablesOf(tx)
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
            .leftJoin(nodeRunRuntimeStates, eq(nodeRunRuntimeStates.nodeRunId, nodeRuns.id))
            .where(
              and(
                eq(nodeRuns.id, token.nodeRunId),
                eq(nodeRuns.taskId, outgoing.taskId),
                eq(nodeRuns.nodeId, outgoing.nodeId),
                eq(nodeRuns.status, 'running'),
                isNull(nodeRunRuntimeStates.sessionId),
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

          const deleted = await tx
            .delete(runtimeSessionLeases)
            .where(
              and(
                eq(runtimeSessionLeases.protocol, token.protocol),
                eq(runtimeSessionLeases.sessionId, token.sessionId),
                eq(runtimeSessionLeases.leaseNodeRunId, token.nodeRunId),
                eq(runtimeSessionLeases.leaseNonceDigest, token.leaseNonceDigest),
                eq(runtimeSessionLeases.resetPending, true),
                isNotNull(runtimeSessionLeases.leasedAt),
              ),
            )
            .returning({ sessionId: runtimeSessionLeases.sessionId })
          if (deleted.length !== 1) fail('lease-mismatch')
          await insertOne(tx, runtimeSessionLeases, {
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
          if (
            !(await compareAndWriteRunSessionInTx(tx, token.nodeRunId, null, nextSessionId, {
              taskId: outgoing.taskId,
              nodeId: outgoing.nodeId,
              status: 'running',
            }))
          )
            fail('run-not-claimable')

          const lineageRows = await tx
            .select({ id: nodeRuns.id })
            .from(nodeRuns)
            .leftJoin(nodeRunRuntimeStates, eq(nodeRunRuntimeStates.nodeRunId, nodeRuns.id))
            .where(
              and(
                eq(nodeRuns.taskId, outgoing.taskId),
                eq(nodeRuns.nodeId, outgoing.nodeId),
                eq(nodeRunRuntimeStates.sessionId, token.sessionId),
              ),
            )
          const lineageRunIds = lineageRows.map((row) => row.id)
          for (const id of [...lineageRunIds].sort()) {
            if (!(await compareAndWriteRunSessionInTx(tx, id, token.sessionId, nextSessionId)))
              fail('run-not-claimable')
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
          await tx
            .update(nodeRunEvents)
            .set({ parentSessionId: nextSessionId })
            .where(
              and(
                inArray(nodeRunEvents.nodeRunId, eventRunIds),
                eq(nodeRunEvents.parentSessionId, token.sessionId),
              ),
            )

          return { ...token, sessionId: nextSessionId }
        })
      } catch (error) {
        if (error instanceof RuntimeSessionLeaseError) throw error
        if (constraintViolation(engine, error)) fail('owner-conflict')
        throw error
      }
    },

    async markResetPending(token) {
      return await withTaskExecutionAggregateWrite(db, async (tx) => {
        const { runtimeSessionLeases } = tablesOf(tx)
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
        const [current] = await tx
          .select({ resetPending: runtimeSessionLeases.resetPending })
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
        if (current === undefined) fail('lease-mismatch')
        if (current.resetPending) return true
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
        return compareAndWriteRunSessionInTx(tx, token.nodeRunId, token.sessionId, null)
      })
    },

    async discard(token) {
      return await withTaskExecutionAggregateWrite(db, async (tx) => {
        const { runtimeSessionLeases } = tablesOf(tx)
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
        await compareAndWriteRunSessionInTx(tx, token.nodeRunId, token.sessionId, null)
        return discarded.length === 1
      })
    },

    async release(token) {
      return await withTaskExecutionAggregateWrite(db, async (tx) => {
        const { runtimeSessionLeases } = tablesOf(tx)
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
      const { runtimeSessionLeases } = tablesOf(db)
      const { nodeRuns, nodeRunRuntimeStates } = tablesOf(db)
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
            sessionId: nodeRunRuntimeStates.sessionId,
            failureCode: nodeRuns.failureCode,
          })
          .from(nodeRuns)
          .leftJoin(nodeRunRuntimeStates, eq(nodeRunRuntimeStates.nodeRunId, nodeRuns.id))
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
