import { randomUUID } from 'node:crypto'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import { ObservationCapturedUsageSchema } from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { agents } from '@/db/schema'
import {
  systemAgentObservationGroups as groups,
  systemAgentObservationOwners as owners,
  systemAgentObservationSources as sources,
} from '@/db/observationSystem'
import { databaseSessionFor, engineOf } from '@/platform/persistence/databaseTransaction'
import type { ObservationInvocationParticipant } from '@/modules/run-observability/public/participants'
import type { NativeUsageInvocationPersistence } from '../application/ports/nativeUsageInvocation'
import type { SystemAgentObservationFactory } from '../application/ports/systemAgentObservation'
import type { SystemNativeUsageOwnerBinding } from '../application/ports/nativeUsagePersistence'
import { issueSystemObservationOwner } from '../infrastructure/systemObservationOwner'
import { recordSystemNativeUsageRoot } from '../infrastructure/systemNativeUsageRoot'
import { finalizeNativeUsageInvocation } from '../application/finalizeNativeUsageInvocation'

/** The selected composition supplies the same acceptance/ledger and original native paging owner. */
export function composeSystemAgentObservations(input: {
  readonly db: ProviderNeutralDatabase
  readonly observations: ObservationInvocationParticipant
  readonly nativeUsage?: NativeUsageInvocationPersistence
}): SystemAgentObservationFactory {
  const { db } = input
  return {
    async open(request) {
      const invocationId = ulid()
      const demand = request.demand
      const kind = demand?.kind ?? request.feature
      const originalId = demand?.originalId ?? invocationId
      const groupId = `system:${kind}:${originalId}`
      const agent = await db
        .select({ id: agents.id, revision: agents.updatedAt })
        .from(agents)
        .where(eq(agents.name, request.agentName))
        .get()
      const agentId = agent?.id ?? `system-agent:${request.agentName}`
      const runtime = request.runtimeObservationIdentity
        ? { ...request.runtimeObservationIdentity, protocol: request.protocol }
        : null
      const purpose = demand?.purpose ?? 'system'
      const row: typeof owners.$inferInsert = {
        id: invocationId,
        groupId,
        originalAttempt: demand?.originalAttempt ?? invocationId,
        agentId,
        agentName: request.agentName,
        agentRevision: agent?.revision ?? null,
        purpose,
        runtime: JSON.stringify(runtime),
        ownerNonce: randomUUID(),
        startedAt: request.startedAt,
        finishedAt: null,
        outcome: null,
      }
      await databaseSessionFor(db).transaction(async (tx) => {
        await tx
          .insert(groups)
          .values({
            id: groupId,
            kind,
            originalId,
            name: demand?.name ?? request.feature,
            parentTaskId: demand?.parentTaskId ?? null,
            ownerUserId: demand?.ownerUserId ?? null,
            startedAt: request.startedAt,
            finishedAt: null,
            status: 'running',
          })
          .onConflictDoNothing()
        await tx.insert(owners).values(row)
        await tx
          .update(groups)
          .set({ status: 'running', finishedAt: null })
          .where(eq(groups.id, groupId))
      })
      const original = await db.select().from(owners).where(eq(owners.id, invocationId)).get()
      if (!original) throw new Error('Original System observation owner was not committed')
      const binding: SystemNativeUsageOwnerBinding = {
        sourceKind: 'system',
        invocationId,
        taskId: groupId,
        nodeRunId: invocationId,
        systemOwner: issueSystemObservationOwner(original),
      }
      const durableOwner = input.nativeUsage?.forSystemInvocation?.({
        binding,
        ...(runtime ? { runtime } : {}),
      })
      return {
        invocationId,
        taskId: groupId,
        nodeRunId: invocationId,
        agentId,
        agentRevision: original.agentRevision,
        purpose,
        runtime,
        ...(durableOwner ? { durableOwner } : {}),
        async accept(capture) {
          await input.observations.accept({
            invocationId,
            taskId: groupId,
            nodeRunId: invocationId,
            agentId,
            agentRevision: original.agentRevision,
            purpose,
            runtime,
            ...capture,
          })
        },
        async root(sessionId, previous) {
          if (!durableOwner) return
          await recordSystemNativeUsageRoot(db, binding, {
            sessionId,
            ...(previous ? { previous } : {}),
            ...(request.resumeSessionId ? { resumeSessionId: request.resumeSessionId } : {}),
            ownerNonce: original.ownerNonce,
            observedAt: Date.now(),
          })
        },
        async append(evidence) {
          if (!evidence.length) return
          await databaseSessionFor(db).transaction(async (tx) => {
            await engineOf(tx).lockAggregateRoot(tx, owners, owners.id, invocationId)
            for (const frame of evidence) {
              const checked = ObservationCapturedUsageSchema.parse(frame)
              if (checked.invocationId !== invocationId)
                throw new Error('System source changed its original invocation')
              await tx.insert(sources).values({
                taskId: groupId,
                nodeRunId: invocationId,
                evidenceJson: JSON.stringify(checked),
                pending: true,
              })
            }
          })
        },
        async process(fact) {
          if (fact.spawnedAt !== null)
            await db
              .update(owners)
              .set({
                startedAt: fact.spawnedAt,
                ...(fact.phase === 'settled'
                  ? { finishedAt: fact.drainedAt ?? fact.reapedAt, outcome: fact.outcome }
                  : {}),
              })
              .where(eq(owners.id, invocationId))
        },
        async settle(outcome, finishedAt) {
          await db.update(owners).set({ outcome, finishedAt }).where(eq(owners.id, invocationId))
          await db
            .update(groups)
            .set({
              status:
                outcome === 'ok' || outcome === 'conforms'
                  ? 'done'
                  : outcome === 'aborted'
                    ? 'cancelled'
                    : 'failed',
              finishedAt,
            })
            .where(eq(groups.id, groupId))
        },
        async reconcile() {
          if (!input.observations.reconcile) return
          while (await input.observations.reconcile(invocationId)) {
            /* committed original source EOF */
          }
        },
        async finalize(capture, rootSessionId) {
          await finalizeNativeUsageInvocation({
            capture,
            observations: input.observations,
            invocationId,
            nodeRunId: invocationId,
            rootSessionId,
          })
        },
      }
    },
  }
}
