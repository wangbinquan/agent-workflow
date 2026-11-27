// RFC-616 §6.3 / §14「事件历史」(design/RFC-616-process-metrics/design.md) — the event history the event center
// offers to process metrics, on both providers.
//
// Process metrics reads how a subject changed over time from the events published about it (a digital-employee
// case's state changes are the first user). This file locks what that read promises:
//   · only the requested subject type and subjects come back;
//   · each subject's events are in the order they happened (time, then event id), whatever order they were
//     stored or observed in;
//   · the stored document is returned verbatim, and it is where an observation's routing facts end up;
//   · the id-batch rule of the platform contract (500, duplicates collapsed, empty list answers empty).

import { expect, test } from 'bun:test'

import { createProcessSubjectEvents } from '@/modules/event-center/composition/processFacts'
import { PROCESS_FACT_ID_BATCH } from '@/platform/contracts/processFacts'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import { describeEachProvider } from './helpers/eachProvider'
import { composeEventCenter, standaloneEventCenterSelections } from './helpers/eventCenter'

const T0 = Date.UTC(2026, 10, 1)
const text = (value: string) => ({ 'zh-CN': value, 'en-US': value })

async function seedEvent(
  db: PersistenceDb,
  input: {
    readonly id: string
    readonly subjectType: string
    readonly subjectRef: string
    readonly occurredAt: number
    readonly observedAt?: number
    readonly eventTypeId?: string
    readonly summaryJson?: string
  },
): Promise<void> {
  const { eventRecords } = tablesOf(db)
  await insertOne(db, eventRecords, {
    id: input.id,
    eventTypeId: input.eventTypeId ?? 'probe.changed',
    eventTypeRevision: 1,
    sourceId: 'probe.source',
    sourceRevision: 1,
    subjectType: input.subjectType,
    subjectRef: input.subjectRef,
    occurredAt: input.occurredAt,
    observedAt: input.observedAt ?? input.occurredAt,
    dedupeKey: input.id,
    summaryJson: input.summaryJson ?? JSON.stringify({ summary: input.id, routingFacts: null }),
    payloadArtifactRef: null,
  })
}

describeEachProvider('RFC-616 event history of subjects', (harness) => {
  test("a subject's events come back oldest first, whatever order they were stored and observed in", async () => {
    const db = harness.db
    // Stored newest first, and observed in the reverse of the order they happened.
    await seedEvent(db, {
      id: 'evt-3',
      subjectType: 'probe.subject',
      subjectRef: 'subject-a',
      occurredAt: T0 + 30,
      observedAt: T0 + 100,
    })
    await seedEvent(db, {
      id: 'evt-2b',
      subjectType: 'probe.subject',
      subjectRef: 'subject-a',
      occurredAt: T0 + 20,
      observedAt: T0 + 200,
    })
    await seedEvent(db, {
      id: 'evt-2a',
      subjectType: 'probe.subject',
      subjectRef: 'subject-a',
      occurredAt: T0 + 20,
      observedAt: T0 + 300,
    })
    await seedEvent(db, {
      id: 'evt-1',
      subjectType: 'probe.subject',
      subjectRef: 'subject-a',
      occurredAt: T0 + 10,
      observedAt: T0 + 400,
      eventTypeId: 'probe.created',
    })

    const history = await createProcessSubjectEvents(db).history('probe.subject', ['subject-a'])

    expect(
      history.map((event) => [event.occurredAt, event.eventTypeId, event.summaryJson]),
    ).toEqual([
      [T0 + 10, 'probe.created', JSON.stringify({ summary: 'evt-1', routingFacts: null })],
      // Two events of the same millisecond fall back to the event id.
      [T0 + 20, 'probe.changed', JSON.stringify({ summary: 'evt-2a', routingFacts: null })],
      [T0 + 20, 'probe.changed', JSON.stringify({ summary: 'evt-2b', routingFacts: null })],
      [T0 + 30, 'probe.changed', JSON.stringify({ summary: 'evt-3', routingFacts: null })],
    ])
    expect(history.every((event) => event.subjectRef === 'subject-a')).toBe(true)
  })

  test('only the requested subject type and subjects are returned, each subject on its own timeline', async () => {
    const db = harness.db
    await seedEvent(db, {
      id: 'a-late',
      subjectType: 'probe.subject',
      subjectRef: 'subject-a',
      occurredAt: T0 + 50,
    })
    await seedEvent(db, {
      id: 'b-early',
      subjectType: 'probe.subject',
      subjectRef: 'subject-b',
      occurredAt: T0 + 5,
    })
    await seedEvent(db, {
      id: 'a-early',
      subjectType: 'probe.subject',
      subjectRef: 'subject-a',
      occurredAt: T0 + 1,
    })
    await seedEvent(db, {
      id: 'b-late',
      subjectType: 'probe.subject',
      subjectRef: 'subject-b',
      occurredAt: T0 + 90,
    })
    // The same reference under another subject type is another subject.
    await seedEvent(db, {
      id: 'other-type',
      subjectType: 'probe.other',
      subjectRef: 'subject-a',
      occurredAt: T0 + 2,
    })
    await seedEvent(db, {
      id: 'not-asked',
      subjectType: 'probe.subject',
      subjectRef: 'subject-c',
      occurredAt: T0 + 3,
    })
    const events = createProcessSubjectEvents(db)
    const summaryOf = (event: { readonly summaryJson: string }) =>
      (JSON.parse(event.summaryJson) as { summary: string }).summary

    const both = await events.history('probe.subject', ['subject-b', 'subject-a', 'subject-b'])
    const timeline = (subjectRef: string) =>
      both.filter((event) => event.subjectRef === subjectRef).map(summaryOf)
    expect(both).toHaveLength(4)
    expect(timeline('subject-a')).toEqual(['a-early', 'a-late'])
    expect(timeline('subject-b')).toEqual(['b-early', 'b-late'])
    // Subjects are not interleaved: every event of one subject precedes the next subject's.
    expect(both.map((event) => event.subjectRef)).toEqual([
      'subject-a',
      'subject-a',
      'subject-b',
      'subject-b',
    ])

    expect((await events.history('probe.other', ['subject-a'])).map(summaryOf)).toEqual([
      'other-type',
    ])
    expect(await events.history('probe.subject', ['subject-unknown'])).toEqual([])
    expect(await events.history('probe.unknown', ['subject-a'])).toEqual([])
    expect(await events.history('probe.subject', [])).toEqual([])
  })

  test('the stored document is returned verbatim', async () => {
    const db = harness.db
    // Not what JSON.stringify would produce: key order and spacing must survive.
    const stored = '{ "routingFacts": {"b": 1, "a": [2, 3]},   "summary": "kept as written" }'
    await seedEvent(db, {
      id: 'verbatim',
      subjectType: 'probe.subject',
      subjectRef: 'subject-a',
      occurredAt: T0,
      summaryJson: stored,
    })
    expect(await createProcessSubjectEvents(db).history('probe.subject', ['subject-a'])).toEqual([
      {
        subjectRef: 'subject-a',
        occurredAt: T0,
        eventTypeId: 'probe.changed',
        summaryJson: stored,
      },
    ])
  })

  test('the routing facts of an observation are part of the document read back', async () => {
    const db = harness.db
    const eventCenter = await composeEventCenter({
      ...standaloneEventCenterSelections(),
      db,
      typePackageDescriptorJsons: [
        JSON.stringify({
          typeRef: { typeId: 'probe', revision: 1 },
          eventSources: [
            {
              sourceId: 'probe.source',
              version: 1,
              displayName: text('Probe source'),
              description: text('Facts published by the probe.'),
              observationMode: 'passive',
              observerProgramRef: null,
              pollIntervalMs: 60_000,
              batchSize: 100,
            },
          ],
          eventTypes: [
            {
              eventTypeId: 'probe.changed',
              version: 1,
              subjectTypeId: 'probe.subject',
              payloadSchemaId: 'probe.change',
              displayName: text('Probe changed'),
              description: text('The probe entered a new state.'),
              deliveryClass: 'probe.change',
              sourceRef: { id: 'probe.source', revision: 1 },
            },
          ],
        }),
      ],
      automation: { kind: 'observation-only' },
    })
    await eventCenter.participant.observe({
      sourceRef: { id: 'probe.source', revision: 1 },
      eventTypeRef: { id: 'probe.changed', revision: 1 },
      subject: { typeId: 'probe.subject', subjectRef: 'subject-a' },
      occurredAt: T0 + 7,
      dedupeKey: 'probe:subject-a:1',
      summary: 'probe subject-a: idle → busy',
      payloadArtifactRef: null,
      routingFactsJson: JSON.stringify({ state: 'busy', previousState: 'idle', revision: 2 }),
    })

    const history = await createProcessSubjectEvents(db).history('probe.subject', ['subject-a'])

    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      subjectRef: 'subject-a',
      occurredAt: T0 + 7,
      eventTypeId: 'probe.changed',
    })
    expect(JSON.parse(history[0]!.summaryJson)).toMatchObject({
      summary: 'probe subject-a: idle → busy',
      routingFacts: { state: 'busy', previousState: 'idle', revision: 2 },
    })
  })

  test('a batch holds at most 500 subjects', async () => {
    const events = createProcessSubjectEvents(harness.db)
    const refs = (count: number) => Array.from({ length: count }, (_, index) => `subject-${index}`)

    await expect(events.history('probe.subject', refs(PROCESS_FACT_ID_BATCH + 1))).rejects.toThrow(
      RangeError,
    )
    expect(await events.history('probe.subject', refs(PROCESS_FACT_ID_BATCH))).toEqual([])
  })
})
