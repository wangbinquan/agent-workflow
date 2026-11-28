// RFC-626 design §4.7 / §9.9 "集中验证中的修订" / §9.10: the conversion runs for minutes without
// returning to the event loop, and on the reference database it left several gigabytes of dead
// values in memory because the runtime only starts a full collection when its heap has grown
// to a multiple of what was alive the last time. The engine therefore calls `reclaim()` at
// chunk, table and unit boundaries, and the default reclaimer runs a full collection there
// when the process has grown beyond the highest resident size it ever had, or when an interval
// has passed.
//
// Why growth and not the clock alone: the final measurement staged rows with large payloads
// at 2 GB of dead values in five seconds — the resident size of the upgrade went from 2.9 to
// 4.5 GB between two collections that were 20 s apart.
//
// Locks: both triggers of the reclaimer and their throttles (the interval is counted from the
// end of a collection; growth is measured from the highest size ever reached, and never asks
// more often than its own least interval), and that the engine really reaches it — once per
// staged chunk, once per staged table and once per converted unit — without which the default
// would never run.
import { expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { preservedRule } from '@/platform/persistence/migration/conversion/generic/preserved'
import { createReclaimer } from '@/platform/persistence/migration/conversion/reclaim'

const MIB = 1024 * 1024

test('nothing is collected before the interval has passed while the process does not grow', () => {
  let clock = 1_000
  let collections = 0
  const reclaim = createReclaimer({
    intervalMs: 5_000,
    now: () => clock,
    collect: () => collections++,
    residentBytes: () => 500 * MIB,
  })
  reclaim()
  clock += 4_999
  reclaim()
  expect(collections).toBe(0)
  clock += 1
  reclaim()
  expect(collections).toBe(1)
})

test('the next interval is counted from the end of a collection', () => {
  let clock = 0
  let collections = 0
  const reclaim = createReclaimer({
    intervalMs: 1_000,
    now: () => clock,
    // A collection that itself takes longer than the interval.
    collect: () => {
      collections++
      clock += 3_000
    },
    residentBytes: () => 500 * MIB,
  })
  clock = 1_000
  reclaim()
  expect(collections).toBe(1)
  // The clock now reads 4000. Counted from the start of the collection the interval would
  // already be over and every call would collect again.
  reclaim()
  clock += 999
  reclaim()
  expect(collections).toBe(1)
  clock += 1
  reclaim()
  expect(collections).toBe(2)
})

test('a process that has grown past its highest size is collected at once, not at the interval', () => {
  let clock = 0
  let resident = 1_000 * MIB
  let collections = 0
  const reclaim = createReclaimer({
    intervalMs: 20_000,
    growthBytes: 256 * MIB,
    minIntervalMs: 1_000,
    now: () => clock,
    collect: () => collections++,
    residentBytes: () => resident,
  })
  // One second in, just below the step: nothing.
  clock = 1_000
  resident = 1_255 * MIB
  reclaim()
  expect(collections).toBe(0)
  // The step is reached.
  resident = 1_256 * MIB
  reclaim()
  expect(collections).toBe(1)
  // The size it reached is the new highest: staying there asks for nothing more …
  clock += 5_000
  reclaim()
  expect(collections).toBe(1)
  // … and neither does shrinking and growing back below the highest plus a step
  // (a system that takes freed pages away must not make every refill a collection).
  resident = 900 * MIB
  reclaim()
  resident = 1_500 * MIB
  reclaim()
  expect(collections).toBe(1)
  // A step above the highest size ever reached.
  resident = 1_512 * MIB
  reclaim()
  expect(collections).toBe(2)
})

test('growth never asks for collections closer together than its least interval', () => {
  let clock = 0
  let resident = 1_000 * MIB
  let collections = 0
  const reclaim = createReclaimer({
    intervalMs: 20_000,
    growthBytes: 100 * MIB,
    minIntervalMs: 1_000,
    now: () => clock,
    collect: () => collections++,
    residentBytes: () => resident,
  })
  // A step that really needs the memory: it keeps growing whatever is collected.
  for (let step = 1; step <= 10; step++) {
    clock += 100
    resident += 150 * MIB
    reclaim()
  }
  // Ten calls in one second: the first second passes without any, then one.
  expect(collections).toBe(1)
  clock += 999
  resident += 150 * MIB
  reclaim()
  expect(collections).toBe(1)
  clock += 1
  reclaim()
  expect(collections).toBe(2)
})

test('the size after a collection counts when it is higher than the size before', () => {
  let clock = 0
  let resident = 1_000 * MIB
  let collections = 0
  const reclaim = createReclaimer({
    intervalMs: 5_000,
    growthBytes: 100 * MIB,
    minIntervalMs: 1_000,
    now: () => clock,
    // Collecting by the clock while the process is at a size nobody had read yet.
    collect: () => {
      collections++
      resident = 1_400 * MIB
    },
    residentBytes: () => resident,
  })
  clock = 5_000
  reclaim()
  expect(collections).toBe(1)
  // 1400 is the highest now: 1450 is not a step above it.
  clock += 2_000
  resident = 1_450 * MIB
  reclaim()
  expect(collections).toBe(1)
})

test('the default reclaimer reads the real resident size, runs a real collection and returns', () => {
  let clock = 0
  const reclaim = createReclaimer({ intervalMs: 1, now: () => clock })
  clock = 10
  expect(() => reclaim()).not.toThrow()
})

describeV2Providers('RFC-626 conversion reclaim', (h) => {
  test('the engine calls reclaim after every staged chunk, after the staged table and after every unit', async () => {
    await h.install()
    const runtime = (id: string) => ({
      id,
      name: id,
      protocol: 'opencode',
      enabled: true,
      is_sandbox: false,
      model: '',
      binary_path: null,
      temperature: 0,
      extra_args_json: '[]',
      last_probe_json: null,
      created_at: 1,
      updated_at: 1,
    })
    await h.write('runtimes', [runtime('reclaim-a'), runtime('reclaim-b'), runtime('reclaim-c')])
    // One row per chunk and per unit: three chunks and three units of one table.
    const input = await h.input(
      [{ rules: [preservedRule('runtimes')], lookups: [], validators: [] }],
      { chunkLimit: 1 },
    )
    let calls = 0
    try {
      const sink = new V2MemorySink()
      const summary = await runConversion({ ...input, reclaim: () => calls++ }, sink)
      expect(summary.status).toBe('converted')
      expect(sink.units.size).toBeGreaterThanOrEqual(3)
      // Three staged chunks of the table, once for the table itself, once per unit.
      expect(calls).toBeGreaterThanOrEqual(3 + 1 + sink.units.size)
    } finally {
      await input.source.close()
    }
  }, 180_000)
})
