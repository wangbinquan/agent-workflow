/**
 * RFC-626 §4.7: keeps what the conversion holds close to what it still needs.
 *
 * The conversion works through its tables and units for minutes without returning to the
 * event loop. The runtime collects short-lived values on its own, but a row or a receipt that
 * lives across a few of those collections is only reclaimed by a full collection, and the
 * runtime starts one of those when its heap has grown to a multiple of what was alive the last
 * time — on a database of a gigabyte that left several gigabytes of dead values in memory.
 * `reclaim()` is called at the boundaries where nothing of the previous step is needed any
 * more — after a chunk of rows is staged, after a table, after a unit — and runs a full
 * collection there when one of two things holds:
 *
 * - **the process has grown.** Its resident size is `growthBytes` above the highest it has
 *   been. Dead values are only a cost when they make the process take memory it never had
 *   before; as long as they fit into what it already holds, collecting them buys nothing.
 *   Staging rows with large payloads piles up dead values at hundreds of megabytes a second
 *   (measured: 2 GB in five seconds on the reference database), far faster than any interval
 *   one would choose by the clock, and this is what stops it. Not more often than
 *   `minIntervalMs`, so a step that really needs the memory is not collected in a loop.
 * - **time has passed.** `intervalMs` since the last collection. Converting units piles up
 *   dead values slowly (about 8 MB a second on the reference database, one full collection
 *   costs about half a second): every 5 s held the conversion at 0.5 GB and cost some 25 s of
 *   a five-minute upgrade; every 20 s lets about 160 MB more accumulate for a quarter of that.
 */
export type Reclaim = () => void
export function createReclaimer(
  options: {
    /** A collection is due this long after the last one, whatever the memory. */
    readonly intervalMs?: number
    /** A collection is due when the resident size exceeds its highest value by this much. */
    readonly growthBytes?: number
    /** Least time between two collections that growth asks for. */
    readonly minIntervalMs?: number
    readonly collect?: () => void
    readonly now?: () => number
    /** The resident size of the process; read on every call, so it has to be cheap. */
    readonly residentBytes?: () => number
  } = {},
): Reclaim {
  const intervalMs = options.intervalMs ?? 20_000
  const growthBytes = options.growthBytes ?? 256 * 1024 * 1024
  const minIntervalMs = options.minIntervalMs ?? 1_000
  const collect = options.collect ?? (() => Bun.gc(true))
  const now = options.now ?? Date.now
  const residentBytes = options.residentBytes ?? (() => process.memoryUsage.rss())
  let last = now()
  let highest = residentBytes()
  return () => {
    const elapsed = now() - last
    if (elapsed < intervalMs) {
      if (elapsed < minIntervalMs) return
      const resident = residentBytes()
      if (resident < highest + growthBytes) return
      // What the process reached before this collection counts, whatever it gives back.
      highest = resident
    }
    collect()
    // Measured after the collection: its own duration is not counted against the next one.
    last = now()
    highest = Math.max(highest, residentBytes())
  }
}
