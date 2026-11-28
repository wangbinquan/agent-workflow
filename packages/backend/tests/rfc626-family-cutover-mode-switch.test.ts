// RFC-626 design §3.4 row 14. The cutover route of every committed-event family is a seed row of
// the target schema and must never be set aside. With automatic resolution a route whose mode
// is not `dispatchable` is kept as one mode switch: `epoch` + 1, `changed_at` = the plan time,
// `change_ref` = `rfc626:automatic-upgrade`, with a decision carrying the original mode, epoch
// and change_ref. Delivery only takes events produced in the route's current epoch
// (platform/events/committed/deliveryPersistence.ts), so events recorded under the old mode
// are not delivered afterwards. Operator resolution still blocks the route.
import { setDefaultTimeout, expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { frozenValues } from './helpers/rfc395V2/contentFixtures'
import {
  AUTOMATIC_UPGRADE_CHANGE_REF,
  FAMILY_CUTOVER_SWITCHED,
  familyCutoversRule,
} from '@/platform/persistence/migration/archives/familyCutovers'
import { seedPresence } from '@/platform/persistence/migration/conversion/generic/seedPresence'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import type { MigrationRecord } from '@/platform/persistence/migration/conversion/types'

setDefaultTimeout(60_000)

const table = 'committed_event_family_cutovers'
// The four routes the target schema seeds.
const routes = [
  { producer: 'task-execution', family: 'task-lifecycle' },
  { producer: 'collaboration', family: 'review' },
  { producer: 'collaboration', family: 'clarify' },
  { producer: 'collaboration', family: 'questions' },
] as const

describeV2Providers('RFC-626 family cutover routes that are not dispatchable', (h) => {
  test('automatic switches the route to the next epoch; operator blocks it', async () => {
    await h.install()
    await h.sourceHarness.native.execute(`DELETE FROM ${h.sourceHarness.table(table)}`)
    await h.write(
      table,
      routes.map((route) =>
        frozenValues(table, {
          ...route,
          mode: route.family === 'review' ? 'legacy' : 'dispatchable',
          epoch: route.family === 'review' ? 1 : 2,
          changed_at: 456,
          change_ref: route.family === 'review' ? 'rfc341:foundation' : 'rfc341:cutover',
        }),
      ),
    )
    const input = await h.input([
      { rules: [familyCutoversRule], lookups: [seedPresence], validators: [] },
    ])
    try {
      const sink = new V2MemorySink()
      const summary = await runConversion({ ...input, resolution: 'automatic' }, sink)
      expect(summary.blocks).toEqual([])
      expect(summary.status).toBe('converted')
      const rows = sink.rows(table)
      expect(rows).toHaveLength(4)
      expect(rows.find((row) => row.family === 'review')).toEqual({
        producer: 'collaboration',
        family: 'review',
        epoch: 2,
        changed_at: input.planTime,
        change_ref: AUTOMATIC_UPGRADE_CHANGE_REF,
      })
      // Dispatchable routes are untouched.
      for (const family of ['task-lifecycle', 'clarify', 'questions'])
        expect(rows.find((row) => row.family === family)).toMatchObject({
          epoch: 2,
          changed_at: 456,
          change_ref: 'rfc341:cutover',
        })
      const records = [...sink.units.values()].flatMap((unit) => unit.records)
      const switched = records.filter(
        (record): record is Extract<MigrationRecord, { kind: 'decision' }> =>
          record.kind === 'decision' && record.code === FAMILY_CUTOVER_SWITCHED,
      )
      expect(switched).toHaveLength(1)
      expect(switched[0]!.payload).toMatchObject({
        automatic: 'kept',
        sourceTable: table,
        mode: 'legacy',
        epoch: '1',
        changeRef: 'rfc341:foundation',
        changedAt: 456,
      })
      // The original row is still evidence of the activation.
      expect(records.filter((record) => record.kind === 'family-cutover-source')).toHaveLength(4)

      const manualSink = new V2MemorySink()
      const manual = await runConversion(input, manualSink)
      expect(manual.blocks.map((block) => block.code)).toEqual([
        'v2-family-cutover-not-dispatchable',
      ])
      expect(manualSink.rows(table).some((row) => row.family === 'review')).toBe(false)
    } finally {
      await input.source.close()
    }
  })
})
