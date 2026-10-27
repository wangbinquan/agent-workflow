// RFC-395 T19: staging peak survives close; conversion reports from synchronous loops.
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createStagingStore } from '@/platform/persistence/migration/conversion/staging'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { createDryRunSink } from '@/modules/system-operations/infrastructure/epochSwitch/dryRunSink'
import { columnLookup } from '@/platform/persistence/migration/conversion/lookups'
import type { MigrationProgress } from '@/platform/persistence/migration/run/progress'
import { describeV2Providers } from './helpers/rfc395V2Harness'

test('T19 staging peak includes lookup bytes and remains observable after deletion', () => {
  const root = mkdtempSync(join(tmpdir(), 't19p-staging-'))
  const store = createStagingStore(root)
  const initial = store.peakBytes
  try {
    store.putLookup('large', 'one', 'x'.repeat(2 * 1024 * 1024))
    const peak = store.peakBytes
    expect(peak).toBeGreaterThanOrEqual(initial + 2 * 1024 * 1024)
    expect(peak).toBeGreaterThanOrEqual(statSync(store.path).size)
    store.close()
    expect(existsSync(dirname(store.path))).toBe(false)
    expect(store.peakBytes).toBe(peak)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

describeV2Providers('T19 measured staging and progress', (h) => {
  test('captures peak before close; pages, lookups and units report in order with unchanged results', async () => {
    await h.install()
    await h.write(
      'maintenance_state',
      Array.from({ length: 5 }, (_, i) => ({
        key: `t19-${i}`,
        value: 'x'.repeat(20000),
        updated_at: i,
      })),
    )
    const lookup = columnLookup('maintenance_state', ['key'], ['value'])
    const events: MigrationProgress[] = []
    const input = await h.input(
      [
        {
          rules: [
            {
              ref: { id: 't19/copy', version: 1 },
              owner: 'fixture',
              claims: ['maintenance_state'],
              produces: [{ table: 'maintenance_state' }],
              lookups: [lookup.key],
              unit: { kind: 'source-chunk', table: 'maintenance_state' },
              disposition: 'preserved',
              convert(unit, ctx) {
                for (const row of unit.rows.get('maintenance_state')!)
                  ctx.out.row('maintenance_state', row.values, row)
              },
            },
          ],
          lookups: [lookup],
          validators: [],
        },
      ],
      { chunkLimit: 2 },
    )
    let peak = 0
    try {
      const observed = await runConversion(
        {
          ...input,
          progress: (event) => events.push(event),
          onStagingPeak(bytes) {
            peak = bytes
            expect(
              readdirSync(input.scratchRoot).some((name) => name.startsWith('conversion-')),
            ).toBe(true)
          },
        },
        createDryRunSink(),
      )
      expect(peak).toBeGreaterThan(200000)
      expect(readdirSync(input.scratchRoot)).toEqual([])
      expect(events[0]).toMatchObject({ phase: 'conversion', detail: 'start', boundary: true })
      const pages = events.filter((event) => event.detail.startsWith('staging current/'))
      expect(pages.map((event) => event.completed)).toEqual([2, 4, 5])
      expect(events.some((event) => event.detail.startsWith('lookup '))).toBe(true)
      expect(
        events.filter((event) => event.detail === 't19/copy').map((event) => event.completed),
      ).toEqual([1, 2, 3])
      expect(events.at(-1)).toMatchObject({ detail: 'complete', completed: 3, boundary: true })
      const count = events.length
      expect(await runConversion(input, createDryRunSink())).toEqual(observed)
      expect(events).toHaveLength(count)
    } finally {
      await input.source.close()
    }
  })
})
