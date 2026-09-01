// RFC-349 — collaboration-owned PostgreSQL committed-event producers.
// The caller supplies the provider transaction that already owns the business
// projection so an event can never commit independently from its gate change.

import { committedEventGroupId } from '@/platform/events/committed/types'
import {
  appendPostgresqlCommittedEventTx,
  type PostgresqlCommittedEventTransaction,
} from '@/platform/events/committed/postgresqlPersistence'
import {
  collaborationDurableConsumers,
  type CollaborationEventFamily,
  type CollaborationGateRefV1,
  type CollaborationProjectionFrame,
} from '../domain/collaborationCommittedEvent'
import type { CollaborationPostCommitEventRef } from '../domain/postCommitEventRef'

function aggregateFor(family: CollaborationEventFamily, gate: CollaborationGateRefV1) {
  if (family === 'review') {
    return { kind: 'review-round' as const, id: gate.roundId ?? gate.gateId }
  }
  if (family === 'clarify') {
    return { kind: 'clarify-round' as const, id: gate.roundId ?? gate.gateId }
  }
  return { kind: 'question-gate' as const, id: gate.gateId }
}

export async function appendPostgresqlHumanGateOpenedEventTx(
  tx: PostgresqlCommittedEventTransaction,
  input: Readonly<{
    family: CollaborationEventFamily
    gate: CollaborationGateRefV1
    occurredAt: number
    projectionFrames?: readonly CollaborationProjectionFrame[]
    identity: Readonly<{
      operationRef: string
      eventGroupId?: string
      eventGroupOrdinal?: number
      correlationRef?: string | null
      causationRef?: string | null
    }>
  }>,
): Promise<CollaborationPostCommitEventRef | null> {
  const receipt = await appendPostgresqlCommittedEventTx(tx, {
    producer: 'collaboration',
    family: input.family,
    type: 'collaboration.human-gate-opened.v1',
    aggregate: aggregateFor(input.family, input.gate),
    operationRef: input.identity.operationRef,
    eventGroupId:
      input.identity.eventGroupId ??
      committedEventGroupId('collaboration', input.identity.operationRef),
    eventGroupOrdinal: input.identity.eventGroupOrdinal ?? 0,
    correlationRef: input.identity.correlationRef ?? null,
    causationRef: input.identity.causationRef ?? null,
    occurredAt: input.occurredAt,
    payload: {
      gate: input.gate,
      gateStatus: 'open' as const,
      projectionFrames: input.projectionFrames ?? [],
    },
    consumers: collaborationDurableConsumers(input.family, 'collaboration.human-gate-opened.v1'),
  })
  return receipt.eventRef
}
