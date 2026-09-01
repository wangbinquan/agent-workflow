// RFC-349 — PostgreSQL implementation of the cross-context human-gate park
// atoms. Collaboration projection, task lifecycle CAS, ownership fence and
// both committed-event families share one serializable transaction.

import { eq } from 'drizzle-orm'

import { tasks } from '@/db/schema'
import { PostgresqlHumanGateOpenParticipantInTx } from '@/modules/collaboration/infrastructure/postgresqlHumanGateOpenParticipant'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import { committedEventGroupId } from '@/platform/events/committed/types'
import type {
  HumanGateTaskLifecycle,
  HumanGateTaskParkResult,
} from '../application/ports/humanGateTaskLifecycle'
import type { TaskExecutionPostCommitEventRef } from '../domain/postCommitEventRef'
import {
  assertPostgresqlTaskOwnerlessTx,
  assertPostgresqlTaskOwnerTx,
  transitionPostgresqlHumanGateTaskTx,
  withPostgresqlSerializableTaskExecution,
} from './postgresqlTaskLifecycleTransaction'
import { createPostgresqlNodeRunLifecycleParticipantInTx } from './postgresqlNodeRunLifecyclePersistence'
import { createPostgresqlNodeRunMintParticipantInTx } from './postgresqlNodeRunMintParticipant'
import { PostgresqlTaskRuntimeLifecyclePersistence } from './postgresqlTaskRuntimeLifecyclePersistence'

class ManualQuestionPending extends Error {}

export class PostgresqlHumanGateTaskLifecyclePersistence implements HumanGateTaskLifecycle {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async parkPrepared(
    input: Parameters<HumanGateTaskLifecycle['parkPrepared']>[0],
  ): Promise<HumanGateTaskParkResult> {
    if (
      input.prepared.taskId.length === 0 ||
      input.prepared.expectedTaskRevision < 0 ||
      input.prepared.manifestDigest.length === 0 ||
      (input.token !== undefined && input.token.taskId !== input.prepared.taskId)
    ) {
      throw new Error('prepared-human-gate-task-or-manifest-mismatch')
    }
    const result = await withPostgresqlSerializableTaskExecution(this.db, async (tx) => {
      if (input.token === undefined) {
        await assertPostgresqlTaskOwnerlessTx(tx, input.prepared.taskId)
      } else {
        await assertPostgresqlTaskOwnerTx(tx, input.token, input.now)
      }
      const consumed = await new PostgresqlHumanGateOpenParticipantInTx(
        tx,
        createPostgresqlNodeRunMintParticipantInTx(tx),
        createPostgresqlNodeRunLifecycleParticipantInTx(tx),
      ).consumePreparedGateTx({
        prepared: input.prepared,
        taskRevision: input.prepared.expectedTaskRevision,
        now: input.now,
      })
      if (consumed.gate.kind !== input.prepared.gateKind) {
        throw new Error('prepared-human-gate-kind-mismatch')
      }
      const parked = await transitionPostgresqlHumanGateTaskTx(tx, {
        taskId: input.prepared.taskId,
        expectedTaskRevision: input.prepared.expectedTaskRevision,
        transition: consumed.gate.kind === 'review' ? 'park-review' : 'park-human',
        now: input.now,
        committedEventIdentity: {
          operationRef: input.prepared.operationId,
          eventGroupId: committedEventGroupId('collaboration', input.prepared.operationId),
          eventGroupOrdinal: 0,
        },
      })
      return {
        taskRevision: parked.taskRevision,
        gateRevision: consumed.gateRevision,
        nodeProjectionDigest: consumed.nodeProjectionDigest,
        committedEventRef: consumed.committedEventRef,
        eventRefs: [...parked.eventRefs, ...consumed.eventRefs],
      }
    })
    await publishCommittedEventsAfterCommit(result.eventRefs)
    return result
  }

  async settleManualQuestionParks(
    input: Parameters<HumanGateTaskLifecycle['settleManualQuestionParks']>[0],
  ): ReturnType<HumanGateTaskLifecycle['settleManualQuestionParks']> {
    const result = await withPostgresqlSerializableTaskExecution(this.db, async (tx) => {
      if (input.token === undefined) {
        await assertPostgresqlTaskOwnerlessTx(tx, input.taskId)
      } else {
        await assertPostgresqlTaskOwnerTx(tx, input.token, input.now)
      }
      const taskRows = await tx
        .select({
          status: tasks.status,
          lifecycleEventRevision: tasks.lifecycleEventRevision,
        })
        .from(tasks)
        .where(eq(tasks.id, input.taskId))
        .limit(1)
      const task = taskRows[0]
      if (task === undefined || !['pending', 'running', 'awaiting_human'].includes(task.status)) {
        return {
          parked: false,
          taskRevision: null,
          operationIds: [] as readonly string[],
          eventRefs: [] as readonly TaskExecutionPostCommitEventRef[],
        }
      }
      const gates = new PostgresqlHumanGateOpenParticipantInTx(
        tx,
        createPostgresqlNodeRunMintParticipantInTx(tx),
        createPostgresqlNodeRunLifecycleParticipantInTx(tx),
      )
      const operationIds = await gates.listPreparedManualQuestionParksTx(input.taskId)
      if (operationIds.length === 0) {
        return {
          parked: false,
          taskRevision: task.lifecycleEventRevision,
          operationIds,
          eventRefs: [] as readonly TaskExecutionPostCommitEventRef[],
        }
      }
      let outstanding = false
      for (const operationId of operationIds) {
        const consumed = await gates.consumeManualQuestionParkTx({
          operationId,
          taskId: input.taskId,
          now: input.now,
        })
        outstanding ||= consumed.outstanding
      }
      if (!outstanding) {
        return {
          parked: false,
          taskRevision: task.lifecycleEventRevision,
          operationIds,
          eventRefs: [] as readonly TaskExecutionPostCommitEventRef[],
        }
      }
      const parked = await transitionPostgresqlHumanGateTaskTx(tx, {
        taskId: input.taskId,
        expectedTaskRevision: task.lifecycleEventRevision,
        transition: 'park-human',
        now: input.now,
      })
      return {
        parked: true,
        taskRevision: parked.taskRevision,
        operationIds,
        eventRefs: parked.eventRefs,
      }
    })
    if (result.eventRefs.length > 0) await publishCommittedEventsAfterCommit(result.eventRefs)
    return result
  }

  async trySetWhenNoManualQuestionParks(
    input: Parameters<HumanGateTaskLifecycle['trySetWhenNoManualQuestionParks']>[0],
  ): ReturnType<HumanGateTaskLifecycle['trySetWhenNoManualQuestionParks']> {
    try {
      const won = await new PostgresqlTaskRuntimeLifecyclePersistence(this.db).trySetWithGuard(
        input,
        async (tx) => {
          const pending = await new PostgresqlHumanGateOpenParticipantInTx(
            tx,
            createPostgresqlNodeRunMintParticipantInTx(tx),
            createPostgresqlNodeRunLifecycleParticipantInTx(tx),
          ).listPreparedManualQuestionParksTx(input.taskId)
          if (pending.length > 0) throw new ManualQuestionPending()
        },
      )
      return { kind: 'settled', won }
    } catch (error) {
      if (error instanceof ManualQuestionPending) return { kind: 'manual-question-pending' }
      throw error
    }
  }
}
