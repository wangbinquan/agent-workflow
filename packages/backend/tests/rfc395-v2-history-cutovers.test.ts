import { setDefaultTimeout, expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { frozenValues } from './helpers/rfc395V2/contentFixtures'
import { seedRequiredRows } from './helpers/rfc395V2/integrationFixtures'
import { familyCutoversRule } from '@/platform/persistence/migration/archives/familyCutovers'
import {
  writerDrainLookup,
  writerDrainRule,
} from '@/platform/persistence/migration/archives/writerDrain'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'

// Slowest case took 3.04 s on CI run 40433510287 including hooks; allow 20 s.
setDefaultTimeout(20_000)

describeV2Providers('RFC-395 V2-X family routing and writer receipts', (h) => {
  test('dispatchable routes preserve epoch, time and change_ref and produce the original record', async () => {
    await h.install()
    await h.write('committed_event_family_cutovers', [
      frozenValues('committed_event_family_cutovers', {
        producer: 'task-execution',
        family: 'review',
        mode: 'dispatchable',
        epoch: 77,
        changed_at: 456,
        change_ref: 'original-change',
      }),
    ])
    const input = await h.input([{ rules: [familyCutoversRule], lookups: [], validators: [] }])
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).blocks).toEqual([])
      expect(
        sink
          .rows('committed_event_family_cutovers')
          .find((row) => row.change_ref === 'original-change'),
      ).toEqual({
        producer: 'task-execution',
        family: 'review',
        epoch: 77,
        changed_at: 456,
        change_ref: 'original-change',
      })
      expect([...sink.units.values()].flatMap((unit) => unit.records)).toContainEqual(
        expect.objectContaining({
          kind: 'family-cutover-source',
          payload: expect.objectContaining({ original: expect.any(Object) }),
        }),
      )
    } finally {
      await input.source.close()
    }
  })
  test('every non-dispatchable source route blocks without publishing a target route', async () => {
    await h.install()
    await h.write(
      'committed_event_family_cutovers',
      ['legacy', 'shadow'].map((mode, index) =>
        frozenValues('committed_event_family_cutovers', {
          producer: 'task-execution',
          family: index === 0 ? 'review' : 'clarify',
          mode,
        }),
      ),
    )
    const input = await h.input([{ rules: [familyCutoversRule], lookups: [], validators: [] }])
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).blocks).toContainEqual(
        expect.objectContaining({ code: 'v2-family-cutover-not-dispatchable' }),
      )
      expect(
        sink
          .rows('committed_event_family_cutovers')
          .some((row) => row.producer === 'task-execution' && row.family !== 'task-lifecycle'),
      ).toBe(false)
    } finally {
      await input.source.close()
    }
  })
  test('X-4 untouched frozen install is boot-activatable, including the SQLite pre-cutover seed', async () => {
    await h.install()
    // Hosted PostgreSQL receives the same singleton through its initial row copy.
    await seedRequiredRows(h)
    const input = await h.input([
      { rules: [writerDrainRule], lookups: [writerDrainLookup], validators: [] },
    ])
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).blocks).toEqual([])
      expect([...sink.units.values()].flatMap((unit) => unit.records)).toContainEqual(
        expect.objectContaining({
          kind: 'writer-drain',
          payload: expect.objectContaining({
            confirmedOsActive: true,
            activation: 'boot-equivalent',
          }),
        }),
      )
    } finally {
      await input.source.close()
    }
  })
  for (const mode of ['pre-cutover', 'legacy-draining', 'os-active']) {
    for (const terminalAt of [null, 456]) {
      test(`X-4 ${mode}, mission terminal_at=${terminalAt}: evaluate activate instead of stored flags`, async () => {
        await h.install()
        await h.sourceHarness.native.execute(
          `DELETE FROM ${h.sourceHarness.table('employee_os_writer_state')}`,
        )
        await h.write('employee_os_writer_state', [
          frozenValues('employee_os_writer_state', {
            id: 'global',
            mode,
            active_generation: mode === 'pre-cutover' ? 0 : 9,
            legacy_admissions_enabled: true,
            legacy_open_mission_count: terminalAt === null ? 0 : 999,
          }),
        ])
        await h.write('development_missions', [
          frozenValues('development_missions', {
            id: 'mission',
            status: 'watching',
            terminal_at: terminalAt,
          }),
        ])
        const input = await h.input([
          { rules: [writerDrainRule], lookups: [writerDrainLookup], validators: [] },
        ])
        try {
          const sink = new V2MemorySink()
          const result = await runConversion(input, sink)
          if (terminalAt === null) {
            expect(result.blocks).toHaveLength(1)
            expect(result.blocks[0]).toMatchObject({
              code: 'v2-writer-not-os-active',
              missingFields: ['development_missions.terminal_at'],
            })
          } else expect(result.blocks).toEqual([])
          expect([...sink.units.values()].flatMap((unit) => unit.records)).toContainEqual(
            expect.objectContaining({
              kind: 'writer-drain',
              payload: expect.objectContaining({
                confirmedOsActive: terminalAt !== null,
                activation: 'boot-equivalent',
                next: {
                  activeGeneration: mode === 'pre-cutover' ? 1 : 9,
                  mode: terminalAt === null ? 'legacy-draining' : 'os-active',
                  legacyAdmissionsEnabled: false,
                  legacyOpenMissionCount: terminalAt === null ? 1 : 0,
                  updatedAt: input.planTime,
                },
              }),
            }),
          )
          expect([...sink.units.values()].flatMap((unit) => unit.rows)).toEqual([])
          expect(
            (await input.source.readChunk('employee_os_writer_state', null, 1)).decodedRows[0],
          ).toMatchObject({ mode, legacy_admissions_enabled: true })
        } finally {
          await input.source.close()
        }
      })
    }
  }
  test('X-4 boot cannot activate without global, even when a different writer row exists', async () => {
    await h.install()
    await h.sourceHarness.native.execute(
      `DELETE FROM ${h.sourceHarness.table('employee_os_writer_state')}`,
    )
    await h.write('employee_os_writer_state', [
      frozenValues('employee_os_writer_state', { id: 'not-global', mode: 'os-active' }),
    ])
    const input = await h.input([
      { rules: [writerDrainRule], lookups: [writerDrainLookup], validators: [] },
    ])
    try {
      expect((await runConversion(input, new V2MemorySink())).blocks).toContainEqual(
        expect.objectContaining({ code: 'v2-writer-state-missing' }),
      )
    } finally {
      await input.source.close()
    }
  })
})
