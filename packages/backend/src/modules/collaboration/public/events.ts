import type { EventObservationInput } from '@/modules/event-center/public/types'
import type { CollaborationCommittedV1 } from '../domain/collaborationCommittedEvent'

export const COLLABORATION_COMMITTED_SOURCE_REF = {
  id: 'platform.collaboration-committed',
  revision: 1,
} as const

export const COLLABORATION_COMMITTED_EVENT_REF = {
  id: 'platform.collaboration.committed',
  revision: 1,
} as const

/** Internal Event Center catalog contribution for durable W3 diagnostics. */
export const collaborationCommittedEventCatalogJson = JSON.stringify({
  typeRef: { typeId: 'collaboration', revision: 1 },
  eventSources: [
    {
      sourceId: COLLABORATION_COMMITTED_SOURCE_REF.id,
      version: COLLABORATION_COMMITTED_SOURCE_REF.revision,
      displayName: { 'zh-CN': '协作已提交事件', 'en-US': 'Collaboration committed events' },
      description: {
        'zh-CN': '由 review、clarify 与 questions 事务提交的内部事实。',
        'en-US': 'Internal facts committed by review, clarify, and questions transactions.',
      },
      observationMode: 'passive',
      observerProgramRef: null,
      pollIntervalMs: 60_000,
      batchSize: 100,
    },
  ],
  eventTypes: [
    {
      eventTypeId: COLLABORATION_COMMITTED_EVENT_REF.id,
      version: COLLABORATION_COMMITTED_EVENT_REF.revision,
      subjectTypeId: 'platform.task',
      payloadSchemaId: 'platform.collaboration-committed',
      displayName: { 'zh-CN': '协作事实已提交', 'en-US': 'Collaboration fact committed' },
      description: {
        'zh-CN': '一个人工门或协作投影变更已完成事务提交。',
        'en-US': 'A human-gate or collaboration projection change committed.',
      },
      deliveryClass: 'platform.collaboration',
      catalogVisibility: 'internal',
      sourceRef: COLLABORATION_COMMITTED_SOURCE_REF,
      triggerParameters: {
        namespace: 'collaboration',
        fields: [
          ['task_id', '任务 ID', 'Task ID'],
          ['family', '事件族', 'Event family'],
          ['event_type', '事件类型', 'Event type'],
          ['gate_kind', '人工门类型', 'Gate kind'],
        ].map(([fieldId, zh, en]) => ({
          fieldId,
          displayName: { 'zh-CN': zh, 'en-US': en },
          description: { 'zh-CN': zh, 'en-US': en },
        })),
      },
    },
  ],
})

export function collaborationCommittedObservation(
  event: CollaborationCommittedV1,
): EventObservationInput {
  const gate = event.payload.gate
  return {
    sourceRef: COLLABORATION_COMMITTED_SOURCE_REF,
    eventTypeRef: COLLABORATION_COMMITTED_EVENT_REF,
    subject: { typeId: 'platform.task', subjectRef: gate.taskId },
    occurredAt: Date.parse(event.occurredAt),
    dedupeKey: event.eventId,
    summary: `${event.family}/${event.type}: ${gate.gateId}`,
    payloadArtifactRef: null,
    routingFactsJson: JSON.stringify({
      taskId: gate.taskId,
      family: event.family,
      eventType: event.type,
      gateKind: gate.gateKind,
      gateId: gate.gateId,
      roundId: gate.roundId,
    }),
    triggerParameters: {
      task_id: gate.taskId,
      family: event.family,
      event_type: event.type,
      gate_kind: gate.gateKind,
    },
  }
}
