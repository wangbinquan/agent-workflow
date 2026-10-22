import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect } from 'bun:test'
import { Hono } from 'hono'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { composeCrewStationEventIngress } from '@/modules/integration/composition/crewstationEvents'
import {
  CREWSTATION_CODE_HOST_EVENTS,
  type CrewStationEventDelivery,
  type CrewStationEventSource,
} from '@/modules/integration/infrastructure/crewstation/eventContract'
import { errorHandler } from '@/util/errors'
import type {
  EventObservationInput,
  EventObservationReceipt,
} from '@/modules/event-center/public/types'

/** Exercise the real hosted HTTP/inbox/normalizer/Event Center path. The CS
 * envelope and its source-token verifier are fixtures; the platform producer
 * itself still requires separate deployment acceptance. No Case or Reaction
 * rows are seeded here. The caller continues through the ordinary OS worker. */
export async function receiveCrewStationSystemMockIssue(input: {
  db: PersistenceDb
  payload: Record<string, unknown>
  observe: (observation: EventObservationInput) => Promise<EventObservationReceipt>
}): Promise<{ deliveryId: string; status: 'received' }> {
  const source: CrewStationEventSource = {
    producerId: Bun.randomUUIDv7(),
    producer: 'gitlab',
    project: 'code-host',
    revision: 1,
    instanceUrl: 'https://gitlab.example',
    apiBaseUrl: 'https://gitlab.example/api/v4',
    repositories: ['rfc310/digital-employee-os'],
    eventTypes: Object.keys(CREWSTATION_CODE_HOST_EVENTS)
      .filter((name) => name.startsWith('gitlab.'))
      .map((name) => ({ id: Bun.randomUUIDv7(), name })),
    bindings: [
      {
        endpointId: 'rfc310-issue-endpoint',
        revision: 1,
        repositories: ['rfc310/digital-employee-os'],
        mode: 'crewstation',
      },
    ],
  }
  const timestamp = new Date().toISOString()
  const delivery: CrewStationEventDelivery = {
    deliveryId: Bun.randomUUIDv7(),
    eventId: Bun.randomUUIDv7(),
    eventTypeId: source.eventTypes.find((type) => type.name === 'gitlab.issue.update')!.id,
    eventType: 'gitlab.issue.update',
    source: { producerId: source.producerId, producer: source.producer, project: source.project },
    occurredAt: timestamp,
    receivedAt: timestamp,
    traceId: '370'.padEnd(32, '0'),
    attempt: 1,
    payload: input.payload,
  }
  const create = () =>
    composeCrewStationEventIngress({
      db: input.db,
      installationId: 'system-mock/agent-workflow',
      sources: [source],
      fence: {
        current: () => ({ epoch: 1, leaseId: 'system-mock-lease', instanceId: 'system-mock' }),
        assertHeld: async () => {},
      },
      verifySource: async (token) => token === 'system-mock-cs-source',
    })
  const app = new Hono()
  create().mount(app)
  app.onError(errorHandler)
  const deliver = (attempt: number) =>
    app.request('/integrations/crewstation/events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cs-source-token': 'system-mock-cs-source',
        'x-cs-delivery-id': delivery.deliveryId,
        'x-cs-event-type': delivery.eventType,
        'x-cs-delivery-attempt': String(attempt),
      },
      body: JSON.stringify({ ...delivery, attempt }),
    })
  expect((await deliver(1)).status).toBe(204)
  const { webhookDeliveries } = tablesOf(input.db)
  // ACK is durable intake, not business execution. A reconstructed worker must
  // route it without relying on the receiving process's memory.
  expect(await input.db.select().from(webhookDeliveries)).toHaveLength(0)
  await create().runPending({ observe: input.observe, wakeTerminalControl: () => {} })
  expect((await deliver(2)).status).toBe(204)
  await create().runPending({ observe: input.observe, wakeTerminalControl: () => {} })
  const receipts = await input.db.select().from(webhookDeliveries)
  expect(receipts).toHaveLength(1)
  return { deliveryId: receipts[0]!.id, status: 'received' }
}
