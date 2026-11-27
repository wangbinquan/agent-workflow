// Runtime-safe process boundary: no converter or migration application imports.
import { resolve } from 'node:path'
import { IS_EMBEDDED } from '@/embed'
import { startInterval } from '@/platform/background/intervalTimer'
import { createLogger } from '@/platform/logging/logger'
import { platformSpawnOptionsForHost } from '@/platform/execution/local/platformExec'

/** `45s`, `3m05s`, `1h02m`: short enough to read in a log line. */
function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

/**
 * The line for an upgrade that is working but has reported nothing for a while.
 *
 * The child reports from inside its work loops (`createMigrationProgressReporter`), but much of a
 * conversion is single statements that cannot report from inside — a content digest of the whole
 * source, a snapshot copy, an integrity check — and each grows with the database. On a 1.07 GB
 * database the upgrade printed nothing for 47 s, 176 s, 115 s and 120 s at a stretch (2026-11-26),
 * during which a working upgrade and a hung one look the same. The parent only waits, so it can
 * say that the child is alive, what it last reported and for how long.
 */
export function createQuietUpgradeNotice(input: {
  readonly now: () => number
  readonly write: (line: string) => void
  /** Silence before the first notice. */
  readonly quietMs?: number
  /** Spacing of the notices that follow while the silence lasts. */
  readonly repeatMs?: number
}): { relayed(line: string): void; tick(): void } {
  const quietMs = input.quietMs ?? 15_000
  const repeatMs = input.repeatMs ?? 30_000
  const started = input.now()
  let lastOutputAt = started
  let lastNoticeAt: number | null = null
  let lastStep: string | null = null
  return {
    /** The child printed a line. */
    relayed(line) {
      lastOutputAt = input.now()
      lastNoticeAt = null
      // The step, without the child's own clock: the notice carries the parent's.
      const step = /^\[db migration\] (.+?)(?: \(\d+(?:\.\d+)?s elapsed\))?$/.exec(line)
      if (step) lastStep = step[1]!
    },
    /** On a timer: at most one notice per period of silence. */
    tick() {
      const now = input.now()
      if (lastNoticeAt === null ? now - lastOutputAt < quietMs : now - lastNoticeAt < repeatMs)
        return
      lastNoticeAt = now
      input.write(
        `[db migration] still working${lastStep === null ? '' : ` (last reported: ${lastStep})`}: ` +
          `no new output for ${elapsedText(now - lastOutputAt)}, ${elapsedText(now - started)} since the upgrade started`,
      )
    },
  }
}

export async function runAutoUpgradeChild(): Promise<void> {
  const argv = IS_EMBEDDED
    ? [process.execPath]
    : [process.execPath, 'run', resolve(import.meta.dir, '..', 'main.ts')]
  const child = Bun.spawn([...argv, 'db', 'migration', 'auto', '--json'], {
    ...platformSpawnOptionsForHost(),
    env: { ...process.env, AGENT_WORKFLOW_EPOCH_LOCK_DELEGATION: String(process.pid) },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const log = createLogger('epoch-upgrade')
  let signal: string | null = null
  const interrupt = () => {
    signal = 'SIGINT'
    child.kill('SIGINT')
  }
  const terminate = () => {
    signal = 'SIGTERM'
    child.kill('SIGTERM')
  }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', terminate)
  const line = (value: string) => {
    process.stderr.write(value + '\n')
    if (value.startsWith('WARN ')) log.warn(value.slice(5))
    else log.info(value)
  }
  // This process is started only for an installation that needs the upgrade (RFC-532 admission).
  line(
    '[db migration] automatic database upgrade started: the database of this installation is ' +
      'being converted to the current format, and the service starts once the result is verified. ' +
      'The previous database is not modified. A large installation takes tens of minutes or more; progress follows.',
  )
  const quiet = createQuietUpgradeNotice({ now: Date.now, write: line })
  const quietTimer = startInterval({
    owner: 'bootstrap.auto-upgrade-quiet-notice',
    everyMs: 5_000,
    tick: () => quiet.tick(),
  })
  const relay = async () => {
    const decoder = new TextDecoder()
    let pending = ''
    const relayed = (value: string) => {
      quiet.relayed(value)
      line(value)
    }
    for await (const chunk of child.stderr) {
      pending += decoder.decode(chunk, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop()!
      for (const value of lines) relayed(value)
    }
    pending += decoder.decode()
    if (pending) relayed(pending)
  }
  try {
    const [code, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      relay(),
    ])
    if (signal)
      throw new Error(
        `Database upgrade interrupted by ${signal}; the child has exited. Start again to resume.`,
      )
    if (code !== 0) {
      process.stderr.write(stdout + (stdout.endsWith('\n') ? '' : '\n'))
      throw new Error(
        code === 3
          ? 'Automatic database upgrade refused; follow the conclusion above.'
          : `Automatic database upgrade child exited ${code}: ${stdout}`,
      )
    }
  } finally {
    quietTimer.stop()
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', terminate)
  }
}
