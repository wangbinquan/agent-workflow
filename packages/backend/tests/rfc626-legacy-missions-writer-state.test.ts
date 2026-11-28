// RFC-626 design §3.4 row 13 (blocks.md table 2, D12). The new version's writer state is always
// "the new flow took over" and admits no legacy mission, so with automatic resolution an
// unfinished legacy mission (`terminal_at` NULL, or not a number — in practice a row the codec
// rejected) is set aside with `v2-legacy-mission-unfinished`, and the writer state is recorded as
// taken over with the set-aside missions listed instead of blocking the global row. A missing
// global writer-state row is treated the same way instead of a table block. Operator
// resolution still blocks.
import { setDefaultTimeout, expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { frozenValues } from './helpers/rfc395V2/contentFixtures'
import { conversion as generic } from '@/platform/persistence/migration/conversion/generic'
import { conversion as alignment } from '@/platform/persistence/migration/conversion/alignment'
import {
  LEGACY_MISSION_UNFINISHED,
  WRITER_STATE_MISSING_TAKEN_OVER,
  WRITER_TAKEN_OVER,
  legacyMissionUnfinished,
  writerDrainLookup,
  writerDrainRule,
} from '@/platform/persistence/migration/archives/writerDrain'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import type { MigrationRecord } from '@/platform/persistence/migration/conversion/types'

setDefaultTimeout(60_000)

test('a legacy mission is unfinished while terminal_at proves no end', () => {
  expect(legacyMissionUnfinished({ terminal_at: null })).toBe('open')
  expect(legacyMissionUnfinished({ terminal_at: 'later' })).toBe('unproven')
  expect(legacyMissionUnfinished({ terminal_at: 9007199254740993n })).toBe('unproven')
  expect(legacyMissionUnfinished({ terminal_at: 456 })).toBeNull()
})

const missionKey = (id: string) => encodeMigrationKey('development_missions', [canonicalValue(id)])
const records = (sink: V2MemorySink) => [...sink.units.values()].flatMap((unit) => unit.records)
const decisions = (sink: V2MemorySink, code: string) =>
  records(sink).filter(
    (record): record is Extract<MigrationRecord, { kind: 'decision' }> =>
      record.kind === 'decision' && record.code === code,
  )
const contributions = [
  { rules: [writerDrainRule], lookups: [writerDrainLookup], validators: [] },
  // The production rule for legacy missions with the lookups it draws on.
  {
    rules: alignment.rules.filter((rule) => rule.claims.includes('development_missions')),
    lookups: [...generic.lookups, ...alignment.lookups],
    validators: [],
  },
]

describeV2Providers('RFC-626 legacy missions and the writer state', (h) => {
  test('automatic sets unfinished missions aside and records the writer state as taken over', async () => {
    await h.install()
    await h.sourceHarness.native.execute(
      `DELETE FROM ${h.sourceHarness.table('employee_os_writer_state')}`,
    )
    await h.write('employee_os_writer_state', [
      frozenValues('employee_os_writer_state', {
        id: 'global',
        mode: 'legacy-draining',
        active_generation: 9,
        legacy_admissions_enabled: true,
        legacy_open_mission_count: 1,
      }),
    ])
    const sqlite = h.sourceHarness.provider === 'sqlite'
    await h.write('development_missions', [
      frozenValues('development_missions', { id: 'open', status: 'watching', terminal_at: null }),
      frozenValues('development_missions', { id: 'done', status: 'done', terminal_at: 456 }),
      // SQLite keeps text in an integer column; the codec rejects the row.
      ...(sqlite
        ? [
            frozenValues('development_missions', {
              id: 'unproven',
              status: 'done',
              terminal_at: 'later',
            }),
          ]
        : []),
    ])
    const setAside = [missionKey('open'), ...(sqlite ? [missionKey('unproven')] : [])].sort()
    const input = await h.input(contributions)
    try {
      const sink = new V2MemorySink()
      const summary = await runConversion({ ...input, resolution: 'automatic' }, sink)
      expect(summary.blocks).toEqual([])
      expect(summary.status).toBe('converted')
      expect(sink.rows('development_missions').map((row) => row.id)).toEqual(['done'])
      const dispositions = [...sink.units.values()].flatMap((unit) => unit.dispositions)
      expect(dispositions).toContainEqual(
        expect.objectContaining({
          sourceTable: 'development_missions',
          sourceKey: missionKey('open'),
          class: 'archived',
          kind: 'archived',
          decision: expect.objectContaining({ code: LEGACY_MISSION_UNFINISHED }),
        }),
      )
      if (sqlite)
        expect(dispositions).toContainEqual(
          expect.objectContaining({
            sourceKey: missionKey('unproven'),
            class: 'archived',
            decision: expect.objectContaining({ code: 'v2-source-codec' }),
          }),
        )
      const writer = records(sink).find((record) => record.kind === 'writer-drain')!
      expect(writer).toMatchObject({
        payload: {
          confirmedOsActive: true,
          activation: 'boot-equivalent',
          next: {
            activeGeneration: 9,
            mode: 'os-active',
            legacyAdmissionsEnabled: false,
            legacyOpenMissionCount: 0,
            updatedAt: input.planTime,
          },
          setAsideMissions: setAside,
        },
      })
      expect(decisions(sink, WRITER_TAKEN_OVER)).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            automatic: 'kept',
            sourceTable: 'employee_os_writer_state',
            mode: 'legacy-draining',
            writerState: 'os-active',
            setAsideMissions: setAside,
          }),
        }),
      ])

      // Operator resolution: the global row blocks and the open mission is converted.
      const manualSink = new V2MemorySink()
      const manual = await runConversion(input, manualSink)
      expect(manual.blocks.map((block) => block.code)).toContain('v2-writer-not-os-active')
      expect(manual.blocks.map((block) => block.code)).not.toContain(LEGACY_MISSION_UNFINISHED)
      expect(manualSink.rows('development_missions').map((row) => row.id)).toContain('open')
      expect(decisions(manualSink, WRITER_TAKEN_OVER)).toEqual([])
    } finally {
      await input.source.close()
    }
  }, 180_000)

  test('without missions to drain the writer record is the same in both modes', async () => {
    await h.install()
    await h.sourceHarness.native.execute(
      `DELETE FROM ${h.sourceHarness.table('employee_os_writer_state')}`,
    )
    await h.write('employee_os_writer_state', [
      frozenValues('employee_os_writer_state', {
        id: 'global',
        mode: 'os-active',
        active_generation: 3,
      }),
    ])
    await h.write('development_missions', [
      frozenValues('development_missions', { id: 'done', status: 'done', terminal_at: 456 }),
    ])
    const input = await h.input(contributions)
    try {
      const automatic = new V2MemorySink()
      const manual = new V2MemorySink()
      expect(
        (await runConversion({ ...input, resolution: 'automatic' }, automatic)).blocks,
      ).toEqual([])
      expect((await runConversion(input, manual)).blocks).toEqual([])
      const writer = (sink: V2MemorySink) =>
        records(sink).find((record) => record.kind === 'writer-drain')
      expect(writer(automatic)).toEqual(writer(manual))
      expect(writer(automatic)).not.toHaveProperty('payload.setAsideMissions')
      expect(decisions(automatic, WRITER_TAKEN_OVER)).toEqual([])
    } finally {
      await input.source.close()
    }
  }, 180_000)

  test('a missing global writer state is taken over in automatic mode, a table block otherwise', async () => {
    await h.install()
    await h.sourceHarness.native.execute(
      `DELETE FROM ${h.sourceHarness.table('employee_os_writer_state')}`,
    )
    await h.write('employee_os_writer_state', [
      frozenValues('employee_os_writer_state', { id: 'not-global', mode: 'os-active' }),
    ])
    await h.write('development_missions', [
      frozenValues('development_missions', { id: 'open', status: 'watching', terminal_at: null }),
    ])
    const input = await h.input(contributions)
    try {
      const sink = new V2MemorySink()
      const summary = await runConversion({ ...input, resolution: 'automatic' }, sink)
      expect(summary.blocks).toEqual([])
      const taken = decisions(sink, WRITER_STATE_MISSING_TAKEN_OVER)
      expect(taken).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            automatic: 'kept',
            sourceTable: 'employee_os_writer_state',
            writerState: 'os-active',
            setAsideMissions: [missionKey('open')],
          }),
        }),
      ])
      expect(taken[0]!.payload).not.toHaveProperty('sourceKey')
      expect(sink.rows('development_missions')).toEqual([])

      const manual = await runConversion(input, new V2MemorySink())
      expect(manual.blocks).toContainEqual(
        expect.objectContaining({ code: 'v2-writer-state-missing', scope: 'table' }),
      )
    } finally {
      await input.source.close()
    }
  }, 180_000)
})
