// RFC-395: retired writers cannot reappear; frozen-source phase evidence remains conversion-owned.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createDigitalEmployeeWriterCutoverPersistence } from '@/modules/digital-employee/infrastructure/writerCutoverPersistence'
import { createDigitalEmployeeWriterCutoverOperations } from '@/modules/digital-employee/composition/writerCutover'
import { appendCommittedEvent } from '@/platform/events/committed/append'
import { createCommittedEventDeliveryPersistence } from '@/platform/events/committed/deliveryPersistence'
import { readOnlyProbes } from '@/modules/code-capability/infrastructure/migration/probes'
import { describeEachProvider } from './helpers/eachProvider'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { frozenValues } from './helpers/rfc395V2/contentFixtures'
import { familyCutoversRule } from '@/platform/persistence/migration/archives/familyCutovers'
import {
  writerDrainLookup,
  writerDrainRule,
} from '@/platform/persistence/migration/archives/writerDrain'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { eq, sql } from 'drizzle-orm'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { seedCodeHistoryRows, historyFixtureArchive } from './helpers/legacyCapabilitySeed'

for (const facts of [
  { activeGeneration: 1, updatedAt: 1700000000000 },
  { activeGeneration: 9, updatedAt: 1700000000100 },
]) {
  test(`writer read DTO uses stable installation facts ${facts.activeGeneration}`, async () => {
    const operations = createDigitalEmployeeWriterCutoverOperations(
      createDigitalEmployeeWriterCutoverPersistence(facts),
    )
    const expected = {
      ...facts,
      mode: 'os-active',
      legacyAdmissionsEnabled: false,
      legacyOpenMissionCount: 0,
    } as const
    expect(await operations.read()).toEqual(expected)
    expect(await operations.read()).toEqual(expected)
    expect(await operations.analyze()).toEqual({
      schemaVersion: 1,
      writer: expected,
      mechanicallyAdoptable: [],
      drainingTotal: 0,
      drainingTruncated: false,
      draining: [],
      blockedReason: null,
    })
    expect('activate' in operations).toBe(false)
    expect('refresh' in operations).toBe(false)
  })
}
test('a missing installation receipt cannot invent an activation time or generation', async () => {
  await expect(createDigitalEmployeeWriterCutoverPersistence().read()).rejects.toThrow(
    'digital-employee-writer-installation-unbound',
  )
  await expect(
    createDigitalEmployeeWriterCutoverPersistence({ activeGeneration: 0, updatedAt: 0 }).read(),
  ).rejects.toThrow('digital-employee-writer-installation-invalid')
})

describeEachProvider('RFC-395 current committed routing', (h) => {
  test('new events dispatch without family mode and retain routing receipts', async () => {
    const receipt = await h.session.transaction((tx) =>
      appendCommittedEvent(tx, {
        producer: 'collaboration',
        family: 'review',
        type: 'fixture.changed.v1',
        aggregate: { kind: 'review-round', id: 'retired-shape' },
        eventGroupId: 'retired-shape',
        eventGroupOrdinal: 0,
        operationRef: 'retired-shape',
        occurredAt: 100,
        payload: {},
        consumers: [{ id: 'fixture.consumer', deliveryClass: 'critical' }],
      }),
    )
    expect(receipt.cutover).not.toHaveProperty('mode')
    expect(receipt.eventRef).toMatchObject({
      deliveryMode: 'dispatchable',
      producerEpoch: receipt.cutover.epoch,
    })
    const claimed = await createCommittedEventDeliveryPersistence(h.db).claimNext({
      workerId: 'worker',
      now: 200,
    })
    expect(claimed?.event.envelope.eventId).toBe(receipt.eventRef?.eventId)
  })
})

describeV2Providers('RFC-395 frozen retired-shape admission evidence', (h) => {
  test.each(['legacy', 'shadow', 'dispatchable'] as const)(
    'source family %s is preserved in receipt and never silently promoted',
    async (mode) => {
      await h.install()
      await h.sourceHarness.native.execute(
        `DELETE FROM ${h.sourceHarness.table('committed_event_family_cutovers')}`,
      )
      const values = frozenValues('committed_event_family_cutovers', {
        producer: 'collaboration',
        family: 'review',
        mode,
        epoch: 7,
        changed_at: 0,
        change_ref: 'raw\nreference',
      })
      await h.write('committed_event_family_cutovers', [values])
      const input = await h.input([{ rules: [familyCutoversRule], lookups: [], validators: [] }])
      try {
        const sink = new V2MemorySink()
        const result = await runConversion(input, sink)
        if (mode === 'dispatchable') {
          expect(result.blocks).toEqual([])
          expect(sink.rows('committed_event_family_cutovers')).toEqual([
            {
              producer: 'collaboration',
              family: 'review',
              epoch: 7,
              changed_at: 0,
              change_ref: 'raw\nreference',
            },
          ])
        } else {
          expect(result.blocks).toContainEqual(
            expect.objectContaining({ code: 'v2-family-cutover-not-dispatchable' }),
          )
          expect(sink.rows('committed_event_family_cutovers')).toEqual([])
        }
        expect([...sink.units.values()].flatMap((unit) => unit.records)).toContainEqual(
          expect.objectContaining({
            kind: 'family-cutover-source',
            payload: expect.objectContaining({
              original: (await input.source.readChunk('committed_event_family_cutovers', null, 1))
                .rows[0],
            }),
          }),
        )
        expect(
          (await input.source.readChunk('committed_event_family_cutovers', null, 1)).decodedRows[0],
        ).toEqual(values)
      } finally {
        await input.source.close()
      }
    },
  )
  test('an os-active/zero source claim still blocks on a genuinely open legacy mission', async () => {
    await h.install()
    await h.sourceHarness.native.execute(
      `DELETE FROM ${h.sourceHarness.table('employee_os_writer_state')}`,
    )
    await h.write('employee_os_writer_state', [
      frozenValues('employee_os_writer_state', {
        id: 'global',
        mode: 'os-active',
        active_generation: 4,
        legacy_open_mission_count: 0,
        legacy_admissions_enabled: false,
      }),
    ])
    await h.write('development_missions', [
      frozenValues('development_missions', { id: 'open', terminal_at: null }),
    ])
    const input = await h.input([
      { rules: [writerDrainRule], lookups: [writerDrainLookup], validators: [] },
    ])
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).blocks).toContainEqual(
        expect.objectContaining({ code: 'v2-writer-not-os-active' }),
      )
      expect([...sink.units.values()].flatMap((unit) => unit.rows)).toEqual([])
    } finally {
      await input.source.close()
    }
  })
})

test('retired runtime writers and phase-change APIs cannot revive', () => {
  const source = (path: string) => readFileSync(resolve(import.meta.dir, '../src', path), 'utf8')
  for (const path of [
    'modules/development-automation/application/cutover.ts',
    'modules/development-automation/application/ports/cutoverStore.ts',
    'modules/development-automation/infrastructure/cutoverStore.ts',
  ])
    expect(source(path)).not.toContain('insertLegacyLink')
  for (const path of [
    'modules/digital-employee/infrastructure/writerCutoverPersistence.ts',
    'modules/digital-employee/composition/writerCutover.ts',
  ]) {
    expect(source(path)).not.toContain('employeeOsWriterState')
    expect(source(path)).not.toContain('Date.now')
    expect(source(path)).not.toMatch(/\.(?:insert|update|delete)\(/)
  }
  for (const path of [
    'platform/events/committed/append.ts',
    'platform/events/committed/appendProgram.ts',
  ])
    expect(source(path)).not.toContain('changeCommittedEventCutover')
  const delivery = source('platform/events/committed/deliveryPersistence.ts')
  expect(delivery).not.toContain('committedEventFamilyCutovers.mode')
  expect(delivery).toContain("eq(committedEvents.deliveryMode, 'dispatchable')")
  expect(delivery).toContain(
    'eq(committedEvents.producerEpoch, committedEventFamilyCutovers.epoch)',
  )
  expect(source('modules/development-automation/application/writerCutoverGates.ts')).not.toMatch(
    /sweepWakesWhileDraining|recoverWhileDraining/,
  )
})

describeEachProvider('RFC-395 history-index probe executes real SQL', (h) => {
  test.each([
    'clean',
    'missing-parent',
    'table',
    'contract',
    'negative-ordinal',
    'past-end',
  ] as const)(
    'reports %s while leaving a second valid index entry untouched',
    async (corruption) => {
      await seedCodeHistoryRows(h.db, 'code_ai_attempts', [
        { id: 'probe-a', roundId: 'round', stageName: 'review' },
        { id: 'probe-b', roundId: 'round', stageName: 'review', attemptSeq: 1 },
      ])
      const { codeHistoryIdIndex } = tablesOf(h.db)
      const where = eq(codeHistoryIdIndex.originalId, 'probe-a')
      const archiveId = historyFixtureArchive('code_ai_attempts', []).id
      const orphan = corruption === 'missing-parent'
      const sqlite = h.capabilities.provider === 'sqlite'
      // Only the orphan fixture bypasses the physical FK; the probe still reads the actual tables.
      if (orphan)
        await h.executeFixtureDdl(
          sqlite
            ? 'PRAGMA foreign_keys = OFF'
            : 'ALTER TABLE agent_workflow.code_history_id_index DROP CONSTRAINT code_history_id_index_archive_fk',
        )
      try {
        if (corruption !== 'clean')
          await h.db
            .update(codeHistoryIdIndex)
            .set(
              orphan
                ? { archiveId: 'missing-archive' }
                : corruption === 'table'
                  ? { sourceTable: 'code_work_items' }
                  : corruption === 'contract'
                    ? { sourceContract: 'wrong-contract' }
                    : { recordOrdinal: corruption === 'negative-ordinal' ? -1 : 2 },
            )
            .where(where)
        const recording = h.recordStatements()
        try {
          expect(
            await readOnlyProbes[0]!.run({
              provider: h.capabilities.provider,
              query: async (statement) => await rawRows(h.db, sql.raw(statement)),
            }),
          ).toEqual({
            id: 'code-capability:history-index',
            passed: corruption === 'clean',
            detail: { invalidEntries: corruption === 'clean' ? 0 : 1 },
          })
        } finally {
          recording.stop()
        }
        expect(recording.statements).toHaveLength(1)
        expect(recording.statements[0]!.sql).toMatch(/^SELECT/)
        expect(
          (
            await h.db
              .select()
              .from(codeHistoryIdIndex)
              .where(eq(codeHistoryIdIndex.originalId, 'probe-b'))
          )[0],
        ).toMatchObject({ archiveId, recordOrdinal: 1 })
      } finally {
        if (orphan) {
          await h.db.update(codeHistoryIdIndex).set({ archiveId }).where(where)
          await h.executeFixtureDdl(
            sqlite
              ? 'PRAGMA foreign_keys = ON'
              : 'ALTER TABLE agent_workflow.code_history_id_index ADD CONSTRAINT code_history_id_index_archive_fk FOREIGN KEY (archive_id) REFERENCES agent_workflow.code_history_archives (id)',
          )
        }
      }
    },
  )
})
