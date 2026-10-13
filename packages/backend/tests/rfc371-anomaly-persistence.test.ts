// RFC-371: one durable rule history, complete authorized page totals and actual recovery.
import { expect, test } from 'bun:test'
import { describeEachProvider } from './helpers/eachProvider'
import { observationAnomalyStates, observationAnomalyHistory } from '@/db/observationAnalysis'
import {
  observeProjectionTaskAnomalies,
  observationAnomalyQueries,
  observationAnomalySampler,
} from '@/modules/run-observability/infrastructure/observationAnomalies'
import { observationProjectionCurrent } from '@/db/observationProjection'
import { emptyCompleteObservationFold } from '@/modules/run-observability/domain/completeObservationMetrics'
import { eq } from 'drizzle-orm'
import type { QualifiedObservationContribution } from '@/modules/run-observability/ports/incrementalObservationQualified'
import type { ObservationSpanFact } from '@agent-workflow/shared'
import { emptyIncrementalObservationFold } from '@/modules/run-observability/domain/incrementalObservationFold'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
describeEachProvider('RFC-371 actual anomaly persistence', (h) => {
  test('timed sampling seeks both metadata sections to EOF beyond one page each', async () => {
    for (const section of ['tasks', 'span-facts', 'other'] as const) {
      for (let at = 0; at < 211; at += 100) {
        await h.db
          .insert(observationProjectionCurrent)
          .values(
            Array.from({ length: Math.min(100, 211 - at) }, (_, n) => {
              const key = String(at + n).padStart(5, '0') + '/' + section
              return {
                kind: 'contribution' as const,
                key,
                component: key,
                section,
                revision: '1',
                document: JSON.stringify({
                  key,
                  component: key,
                  aggregates: [],
                  fold: emptyCompleteObservationFold(),
                  detail: { section, parent: null, key, taskId: null, document: {} },
                }),
              }
            }),
          )
          .run()
      }
    }
    const recording = h.recordStatements()
    try {
      await observationAnomalySampler(h.db, () => 1000)()
    } finally {
      recording.stop()
    }
    const pages = recording
      .selects()
      .filter(
        (statement) =>
          statement.sql.includes('observation_projection_current') &&
          statement.sql.includes('"section"') &&
          statement.sql.includes('limit'),
      )
    expect(pages).toHaveLength(6)
    expect(pages.map((page) => page.rows)).toEqual([200, 11, 0, 200, 11, 0])
    if (h.capabilities.isolation === 'exclusive') {
      for (const page of pages) {
        const plan = await h.explain(page)
        expect(plan).toContain('observation_projection_current_section')
        expect(plan).toMatch(/kind=\? AND section=\?/)
      }
    }
  }, 30000)

  test('a committed open tool crosses the timeout threshold without new producer events; unknown does not resolve it', async () => {
    let now = 1000
    const fact: ObservationSpanFact = {
      schemaVersion: 1,
      spanKey: 'original-tool',
      invocationId: 'original-call',
      scope: {
        sourceNamespace: 'original',
        rootSessionId: 'root',
        nativeSessionId: 'root',
        parentNativeSessionId: null,
        ancestors: [],
        callId: 'tool',
        kind: 'tool',
      },
      label: 'Original tool',
      parentCallId: null,
      model: null,
      measurementRecordId: null,
      state: { startedAt: 1000, endedAt: null, nativeObservedAt: 1000, status: 'open' },
      capturedAt: 1000,
    }
    const row: QualifiedObservationContribution = {
      key: 'committed-tool',
      component: 'original-call',
      aggregates: [],
      fold: emptyCompleteObservationFold(),
      detail: {
        section: 'span-facts',
        parent: null,
        key: 'original-tool',
        taskId: 'original-task',
        cohortAt: 1000,
        document: {
          fact,
          durationMs: null,
          quality: 'complete',
          reasons: [],
          usage: null,
          cost: null,
        },
      },
    }
    await h.db
      .insert(observationProjectionCurrent)
      .values({
        kind: 'contribution',
        key: row.key,
        component: row.component,
        section: 'span-facts',
        taskId: 'original-task',
        revision: '1',
        document: JSON.stringify(row),
      })
      .run()
    const tick = observationAnomalySampler(h.db, () => now),
      query = observationAnomalyQueries(h.db, async (ids) => ids)
    await tick()
    expect((await query({ from: 0, to: 1000000, pageSize: 20 })).total).toBe('0')
    now = 301000
    await tick()
    const active = (await query({ from: 0, to: 1000000, pageSize: 20 })).items[0]!
    expect(active).toMatchObject({ rule: 'tool-timeout', state: 'firing', taskId: 'original-task' })
    for (const status of ['unknown', 'success'] as const) {
      now += 60000
      fact.state.status = status
      fact.state.endedAt = status === 'success' ? now : null
      await h.db
        .update(observationProjectionCurrent)
        .set({ revision: '2', document: JSON.stringify(row) })
        .where(eq(observationProjectionCurrent.key, row.key))
        .run()
      await tick()
      expect((await query({ from: 0, to: 1000000, pageSize: 20 })).items[0]).toMatchObject({
        id: active.id,
        state: status === 'success' ? 'resolved' : 'firing',
      })
    }
  })
  test('a repeated committed sample is idempotent, later evidence fires and recovery is retained', async () => {
    const base = emptyIncrementalObservationFold(),
      gap = {
        ...base,
        counters: { ...base.counters, tasks: '1' },
        unknownCoverage: '1',
        gaps: { 'usage-incomplete': '1' },
      }
    for (const asOf of [1000, 1000, 62000])
      await databaseSessionFor(h.db).transaction((tx) =>
        observeProjectionTaskAnomalies(tx, 'task/original', gap, { revision: '1', asOf }),
      )
    let rows = await h.db.select().from(observationAnomalyStates).all()
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0]!.document).state).toBe('firing')
    await databaseSessionFor(h.db).transaction((tx) =>
      observeProjectionTaskAnomalies(
        tx,
        'task/original',
        { ...base, counters: { ...base.counters, tasks: '1' } },
        { revision: '2', asOf: 63000 },
      ),
    )
    rows = await h.db.select().from(observationAnomalyStates).all()
    expect(JSON.parse(rows[0]!.document).state).toBe('resolved')
    expect(await h.db.select().from(observationAnomalyHistory).all()).toHaveLength(3)
    const firstEpisode = JSON.parse(rows[0]!.document).id
    for (const asOf of [64000, 125000])
      await databaseSessionFor(h.db).transaction((tx) =>
        observeProjectionTaskAnomalies(tx, 'task/original', gap, { revision: '3', asOf }),
      )
    const query = observationAnomalyQueries(h.db, async (ids) => ids)
    const oldWindow = await query({ from: 0, to: 64000, pageSize: 37 })
    expect(oldWindow.total).toBe('1')
    expect(oldWindow.items[0]).toMatchObject({
      id: firstEpisode,
      state: 'resolved',
      resolvedAt: 63000,
    })
    const both = await query({ from: 0, to: 200000, pageSize: 37 })
    expect(both.total).toBe('2')
    expect(both.items.map((value) => value.state).sort()).toEqual(['firing', 'resolved'])
  })
  test('pagination does not change the complete authorized total, including beyond 200 tasks', async () => {
    const { ObservationAnomalySchema } = await import('@agent-workflow/shared')
    for (let at = 0; at < 211; at += 100)
      await h.db
        .insert(observationAnomalyStates)
        .values(
          Array.from({ length: Math.min(100, 211 - at) }, (_, n) => {
            const key = String(at + n).padStart(6, '0'),
              taskId = at + n === 210 ? 'hidden' : 'visible',
              document = ObservationAnomalySchema.parse({
                id: key,
                key,
                taskId,
                taskName: 'Original',
                rule: 'unpriced',
                state: 'firing',
                sourceState: 'available',
                samples: '1',
                minimumSamples: '1',
                windowMs: 60000,
                durationMs: 0,
                firstObservedAt: 1000,
                lastObservedAt: 2000,
                firedAt: 1000,
                resolvedAt: null,
                evidence: [],
                revision: '1',
              })
            return { key, taskId, sourceRevision: '1', document: JSON.stringify(document) }
          }),
        )
        .run()
    const query = observationAnomalyQueries(h.db, async (ids) =>
        ids.filter((id) => id === 'visible'),
      ),
      one = await query({ from: 0, to: 3000, pageSize: 37 }),
      two = await query({ from: 0, to: 3000, pageSize: 37, after: one.nextCursor! })
    expect(one.total).toBe('210')
    expect(two.total).toBe('210')
    expect(two.items[0]!.key).toBe('000037')
    expect(one.items).toHaveLength(37)
  })
})
