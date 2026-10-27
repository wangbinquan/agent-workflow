export type MigrationPhase =
  | 'freeze'
  | 'offline-upgrade'
  | 'content-capture'
  | 'conversion'
  | 'backup'
  | 'load'
  | 'validation'
  | 'activation'

export interface MigrationProgress {
  readonly phase: MigrationPhase
  readonly detail: string
  readonly completed?: number
  readonly total?: number
  readonly unit?: string
  readonly boundary?: boolean
}
export type MigrationProgressCallback = (progress: MigrationProgress) => void

/** Called synchronously by work loops, including while timers cannot run. */
export function createMigrationProgressReporter(
  write: (line: string) => void,
  options: { now?: () => number; intervalMs?: number } = {},
): MigrationProgressCallback {
  const now = options.now ?? Date.now
  const started = now()
  const last = new Map<MigrationPhase, number>()
  return (event) => {
    const time = now()
    const previous = last.get(event.phase)
    if (!event.boundary && previous !== undefined && time - previous < (options.intervalMs ?? 3000))
      return
    last.set(event.phase, time)
    const count =
      event.completed === undefined
        ? ''
        : ` ${event.completed}${event.total === undefined ? '' : `/${event.total}`} ${event.unit ?? 'units'}`
    write(
      `[db migration] ${event.phase}: ${event.detail}${count} (${((time - started) / 1000).toFixed(1)}s elapsed)\n`,
    )
  }
}
