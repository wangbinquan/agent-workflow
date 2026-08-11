// RFC-276 — neutral managed-process primitive.
//
// This module owns process reliability only: bounded stream pumps, byte-exact
// stdout capture, a durable PID receipt seam, timeout/cancel handling, process
// tree termination with SIGKILL escalation, and a bounded pipe-drain deadline.
// It deliberately has no sandbox, containment, network, filesystem, or runtime
// identity policy. Callers pass the exact argv, cwd, and complete environment
// that should reach the child.

import type { Logger } from '@/util/log'
import { killProcessTree } from '@/util/process'
import { explainSpawnEnoent } from '@/util/spawnDiagnostics'
import { platformSpawnOptionsForHost } from '@/util/platformExec'

/** Per-line cap (code units); mirrors runner.ts MAX_STREAM_LINE_CHARS. */
export const MANAGED_PROCESS_MAX_LINE_CHARS = 1024 * 1024
/** Rolling-tail cap for the retained raw stream text. */
export const MANAGED_PROCESS_MAX_STREAM_CHARS = 8 * 1024 * 1024
/** RFC-280 impl-gate P1-A: margin after the SIGKILL grace before a still-alive
 *  child is abandoned as `child-unkillable` (matches the pre-RFC-280 runner). */
/** RFC-282 E1a — exported: runner's kill-escalation messages reuse THIS value
 *  (it carried an identical local copy; two spellings of one deadline). */
export const FINAL_REAP_MARGIN_MS = 5_000

const LINE_TRUNCATED_MARKER = '…[line truncated]'

export type ManagedProcessOutcome =
  | 'exited'
  | 'timeout'
  | 'aborted'
  | 'spawn-failed'
  | 'child-unkillable'

export interface ManagedProcessRequest {
  argv: readonly string[]
  cwd: string
  /** Complete environment passed to the child without interpretation. */
  env: Record<string, string>
  timeoutMs?: number
  killEscalationGraceMs?: number
  signal?: AbortSignal
  /**
   * RFC-280 T4 — last-moment admission seam, awaited immediately before
   * `Bun.spawn`. A throw means the run is no longer admitted (e.g. the MCP
   * playground's turn was canceled between plan assembly and spawn): no child
   * is created and the result comes back `spawn-failed` with the thrown
   * message as `spawnError`.
   */
  beforeSpawn?: () => Promise<void> | void
  /**
   * RFC-280 T4 — stdin delivery. `pipe` writes `data` once and closes (the
   * claude prompt transport); omitted/`ignore` keeps the historical closed
   * stdin.
   */
  stdin?: { mode: 'pipe'; data: string } | { mode: 'ignore' }
  /**
   * Called as soon as the child exists, BEFORE any output is read.
   *
   * This is the seam that keeps a daemon crash recoverable: `node_runs.pid` has
   * to be on disk while the child is alive, or the boot reaper has nothing to
   * match against and the orphan survives forever (design-gate P0-3). Awaited,
   * so the row is persisted before output processing begins.
   */
  onSpawned?: (info: { pid: number; spawnBinaryPath: string }) => Promise<void> | void
  onStdoutLine?: (line: string) => Promise<void> | void
  onStderrLine?: (line: string) => Promise<void> | void
  /**
   * RFC-280 T4 — notified when a line exceeded the cap and was TRUNCATED
   * before delivery. Lets a capture-faithful caller (systemAgentRun's event
   * sink) mark its capture incomplete instead of silently storing a clipped
   * frame as if it were whole.
   */
  onLineTruncated?: () => Promise<void> | void
  /**
   * RFC-280 T4 — when true, a post-exit pipe-drain timeout keeps the `exited`
   * outcome (exitCode is real; only trailing output was lost) and reports
   * `drainTimedOut: true` instead of relabeling the run `child-unkillable`.
   * The historical relabel remains the default for existing consumers
   * (script nodes): their contract treats an undrainable pipe as an unsafe
   * child. Agent runs treat it as evidence loss on a finished run.
   */
  keepExitedOnDrainTimeout?: boolean
  /** Retain raw stdout bytes (byte-exact, unlike the line stream). */
  captureRawStdout?: boolean
  log?: Logger
}

export interface ManagedProcessResult {
  outcome: ManagedProcessOutcome
  exitCode: number | null
  /** Byte-exact stdout when `captureRawStdout`, else ''. Tail-truncated at the cap. */
  rawStdout: string
  /** Rolling tail of stderr, for error messages. */
  stderrTail: string
  truncated: { stdout: boolean; stderr: boolean }
  /** RFC-280 T4 — set with `keepExitedOnDrainTimeout` when trailing output was
   *  lost to the bounded post-exit drain (exitCode itself is trustworthy). */
  drainTimedOut?: boolean
  /** RFC-280 T7 — an onStdoutLine/onStderrLine callback threw (a persist error):
   *  the child was escalated and this carries the first reason. Consumers that
   *  tolerate line-callback failures (the runner) read it instead of catching a
   *  thrown drain race. */
  pumpError?: string
  /**
   * argv[0] exactly as spawned — the binary the reaper must match against a
   * live pid.
   */
  spawnBinaryPath: string
  /** null when the child never started. */
  pid: number | null
  spawnError?: string
}

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger

function appendBounded(
  current: string,
  addition: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const joined = current + addition
  if (joined.length <= 2 * maxChars) return { text: joined, truncated: false }
  return { text: joined.slice(joined.length - maxChars), truncated: true }
}

interface Pump {
  done: Promise<void>
  cancel: () => void
}

/**
 * Drain a byte stream, emitting complete lines and (optionally) retaining the
 * raw text. `onRaw` sees every decoded chunk verbatim — no line splitting, no
 * empty-line filtering — which is what makes byte-exact stdout capture possible.
 */
/** RFC-282 E1a — exported as the ONE stream pump (runner's `pumpLines` twin
 *  was src-dead and already diverged on the truncation marker; its bound lock
 *  now pins THIS implementation). */
export function pump(
  stream: ReadableStream<Uint8Array>,
  onLine: ((line: string) => Promise<void> | void) | undefined,
  onRaw: ((chunk: string) => void) | undefined,
  onLineTruncated?: () => Promise<void> | void,
): Pump {
  const reader = stream.getReader()
  let canceled = false
  const done = (async (): Promise<void> => {
    const decoder = new TextDecoder()
    let buffer = ''
    let dropping = false
    try {
      for (;;) {
        const { value, done: eof } = await reader.read()
        if (eof) break
        const chunk = decoder.decode(value, { stream: true })
        onRaw?.(chunk)
        if (onLine === undefined) continue
        buffer += chunk
        for (;;) {
          const idx = buffer.indexOf('\n')
          if (idx < 0) {
            if (dropping) buffer = ''
            else if (buffer.length > MANAGED_PROCESS_MAX_LINE_CHARS) {
              await onLineTruncated?.()
              await onLine(buffer.slice(0, MANAGED_PROCESS_MAX_LINE_CHARS) + LINE_TRUNCATED_MARKER)
              buffer = ''
              dropping = true
            }
            break
          }
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (dropping) {
            dropping = false
            continue
          }
          if (line.length > 0) await onLine(line)
        }
      }
      if (onLine !== undefined && buffer.length > 0 && !canceled && !dropping) {
        if (buffer.length > MANAGED_PROCESS_MAX_LINE_CHARS) await onLineTruncated?.()
        await onLine(
          buffer.length > MANAGED_PROCESS_MAX_LINE_CHARS
            ? buffer.slice(0, MANAGED_PROCESS_MAX_LINE_CHARS) + LINE_TRUNCATED_MARKER
            : buffer,
        )
      }
    } finally {
      reader.releaseLock()
    }
  })()
  return {
    done,
    cancel: () => {
      canceled = true
      void reader.cancel().catch(() => {})
    },
  }
}

function killTree(child: Bun.Subprocess, signal: 'SIGTERM' | 'SIGKILL'): void {
  const pid = child.pid
  if (typeof pid === 'number' && pid > 0 && killProcessTree(pid, signal)) return
  try {
    child.kill(signal === 'SIGKILL' ? 9 : 15)
  } catch {
    // Already gone.
  }
}

/**
 * Run one managed subprocess to completion.
 *
 * Never throws for a child-side failure: every outcome (crash, timeout, abort,
 * missing binary) comes back in `ContainedSpawnResult` so the caller writes one
 * terminal row rather than juggling exception paths.
 */
export async function runManagedProcess(req: ManagedProcessRequest): Promise<ManagedProcessResult> {
  const log = req.log ?? noopLog
  const graceMs = req.killEscalationGraceMs ?? 10_000

  const spawnBinaryPath = req.argv[0] ?? ''

  // RFC-280 T4 — admission seam: a throw here means "do not spawn", reported
  // as spawn-failed so the caller writes one terminal row (never a live child).
  if (req.beforeSpawn !== undefined) {
    try {
      await req.beforeSpawn()
    } catch (err) {
      return {
        outcome: 'spawn-failed',
        exitCode: null,
        rawStdout: '',
        stderrTail: '',
        truncated: { stdout: false, stderr: false },
        spawnBinaryPath,
        pid: null,
        spawnError: err instanceof Error ? err.message : String(err),
      }
    }
  }

  let child: Bun.Subprocess
  try {
    child = Bun.spawn({
      ...platformSpawnOptionsForHost(),
      cmd: [...req.argv],
      cwd: req.cwd,
      env: req.env,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: req.stdin?.mode === 'pipe' ? 'pipe' : 'ignore',
      // Own process group so the whole descendant tree can be signalled.
      // Without it a fork()ed grandchild survives every kill we send.
      detached: true,
    })
  } catch (err) {
    // A missing binary makes Bun.spawn THROW rather than return 127 — and Bun
    // names argv[0] in the ENOENT even when the missing path is the cwd.
    // Translate before reporting so operators see the actual missing path.
    return {
      outcome: 'spawn-failed',
      exitCode: null,
      rawStdout: '',
      stderrTail: '',
      truncated: { stdout: false, stderr: false },
      spawnBinaryPath,
      pid: null,
      spawnError: explainSpawnEnoent(err instanceof Error ? err.message : String(err), {
        argv0: req.argv[0] ?? spawnBinaryPath,
        cwd: req.cwd,
      }),
    }
  }

  // RFC-280 T4 — one-shot stdin delivery (the claude prompt transport):
  // write before reading any output, then close so the child sees EOF.
  if (req.stdin?.mode === 'pipe') {
    const sink = child.stdin as { write: (s: string) => void; end: () => void } | undefined
    if (sink !== undefined) {
      try {
        sink.write(req.stdin.data)
        sink.end()
      } catch (err) {
        // A child that exited instantly closes its pipe; the exit path below
        // reports the real outcome — a broken stdin write must not mask it.
        log.warn('managed-process stdin write failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  const pid = typeof child.pid === 'number' ? child.pid : null
  if (pid !== null && req.onSpawned !== undefined) {
    try {
      await req.onSpawned({ pid, spawnBinaryPath })
    } catch (err) {
      // Persisting the pid is best-effort for the RUN; failing it must not kill
      // a healthy child. It is logged loudly because the crash-recovery
      // guarantee is degraded when it happens.
      log.warn('onSpawned receipt failed; orphan recovery degraded', {
        pid,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  let rawStdout = ''
  let stderrTail = ''
  const truncated = { stdout: false, stderr: false }

  const stdoutPump = pump(
    child.stdout as ReadableStream<Uint8Array>,
    req.onStdoutLine,
    req.captureRawStdout === true
      ? (chunk) => {
          const next = appendBounded(rawStdout, chunk, MANAGED_PROCESS_MAX_STREAM_CHARS)
          rawStdout = next.text
          if (next.truncated) truncated.stdout = true
        }
      : undefined,
    req.onLineTruncated,
  )
  const stderrPump = pump(
    child.stderr as ReadableStream<Uint8Array>,
    req.onStderrLine,
    (chunk) => {
      const next = appendBounded(stderrTail, chunk, MANAGED_PROCESS_MAX_STREAM_CHARS)
      stderrTail = next.text
      if (next.truncated) truncated.stderr = true
    },
    req.onLineTruncated,
  )

  let outcome: ManagedProcessOutcome = 'exited'
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let reapDeadlineTimer: ReturnType<typeof setTimeout> | undefined
  // RFC-280 impl-gate P1-A: the final liveness bound. A child that ignores even
  // SIGKILL (uninterruptible D-state, a stuck-I/O grandchild, a failed signal
  // delivery) would otherwise make `await child.exited` hang FOREVER — and the
  // caller's finally (lease release / plan cleanup / row settle) never runs.
  // The pre-RFC-280 runner raced `child.exited` against exactly this deadline;
  // moving agent runs into managedProcess must not drop it. Armed at the first
  // kill signal (escalate), fires FINAL_REAP_MARGIN_MS after the SIGKILL grace.
  let reapDeadlineFire: (() => void) | undefined
  const reapDeadline = new Promise<'unreaped'>((resolve) => {
    reapDeadlineFire = () => resolve('unreaped')
  })

  const escalate = (): void => {
    // impl-gate 3.2: a second escalation (cancel, then the timeout firing during
    // the grace window) used to overwrite `killTimer`, leaving the first timer
    // to fire later at a pid that may already be recycled.
    if (killTimer !== undefined) return
    killTree(child, 'SIGTERM')
    killTimer = setTimeout(() => {
      log.warn('child ignored SIGTERM past grace; escalating to SIGKILL', { pid, graceMs })
      killTree(child, 'SIGKILL')
      // After SIGKILL, bound the reap: if the child still hasn't exited by the
      // final margin, abandon it as child-unkillable instead of awaiting forever.
      // impl-gate P2-1: this deadline settles the exit race (via reapDeadlineFire)
      // — it MUST stay ref'd (RFC-254: an unref'd timer never fires on Windows
      // Bun once the loop is otherwise idle, which would resurrect the very hang
      // this deadline exists to bound). Mirrors the drainTimer below; cleared in
      // the finally.
      reapDeadlineTimer = setTimeout(() => reapDeadlineFire?.(), FINAL_REAP_MARGIN_MS)
    }, graceMs)
    killTimer.unref()
  }

  // RFC-280 T7 — a line-callback failure (persist error) makes further output
  // unrecordable; escalate the child (the historical runner `settlePump` did
  // exactly this) and record the reason instead of letting the pump rejection
  // escape the drain race as a thrown exception.
  let pumpError: string | undefined
  const onPumpError = (err: unknown): void => {
    if (pumpError === undefined) pumpError = err instanceof Error ? err.message : String(err)
    escalate()
  }
  void stdoutPump.done.catch(onPumpError)
  void stderrPump.done.catch(onPumpError)

  const onAbort = (): void => {
    if (outcome === 'exited') outcome = 'aborted'
    escalate()
  }
  if (req.signal !== undefined) {
    if (req.signal.aborted) onAbort()
    else req.signal.addEventListener('abort', onAbort, { once: true })
  }
  if (req.timeoutMs !== undefined && req.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      // impl-gate 3.2: guarded like `onAbort`. Without it, "user cancels →
      // SIGTERM → timeout fires during the 10s grace" relabels a cancellation
      // as a timeout, and the caller then writes `failed` instead of
      // `canceled`/`interrupted`.
      if (outcome === 'exited') outcome = 'timeout'
      escalate()
    }, req.timeoutMs)
    timeoutTimer.unref()
  }

  let exitCode: number | null = null
  let childUnreaped = false
  try {
    // RFC-280 impl-gate P1-A: race the exit against the reap deadline (armed on
    // escalation) so an unkillable child cannot wedge the caller forever.
    const exitResult = await Promise.race([
      child.exited.then((code) => ({ kind: 'exited' as const, code })),
      reapDeadline.then(() => ({ kind: 'unreaped' as const })),
    ])
    if (exitResult.kind === 'unreaped') {
      childUnreaped = true
      outcome = 'child-unkillable'
      log.error('child survived SIGKILL past reap deadline; abandoning', {
        pid,
        deadlineMs: graceMs + FINAL_REAP_MARGIN_MS,
      })
    } else {
      exitCode = exitResult.code
    }
  } finally {
    if (killTimer !== undefined) clearTimeout(killTimer)
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
    if (reapDeadlineTimer !== undefined) clearTimeout(reapDeadlineTimer)
    req.signal?.removeEventListener('abort', onAbort)
  }

  // An unreaped child still holds its pipes — cancel the pumps, don't await
  // EOF (it will never come), and don't relabel the already-terminal outcome.
  if (childUnreaped) {
    stdoutPump.cancel()
    stderrPump.cancel()
    // impl-gate P1-1: the child is STILL ALIVE here (its `.exited` never
    // resolved), so its handle keeps the event loop ref'd. Without unref the
    // abandoned unkillable child pins the daemon (and `bun test`) open forever
    // — the exact liveness bound the pre-RFC-280 runner protected with
    // `child.unref()` and the T7 collapse dropped.
    child.unref()
    return {
      outcome,
      exitCode,
      rawStdout,
      stderrTail,
      truncated,
      spawnBinaryPath,
      pid,
      ...(pumpError !== undefined ? { pumpError } : {}),
    }
  }

  // Bound the wait on the pipes: a surviving grandchild can hold the write end
  // open forever, and `done` would never settle.
  let drainTimer: ReturnType<typeof setTimeout> | undefined
  const drained = await Promise.race([
    // allSettled: a rejected pump (callback threw) is already recorded via
    // onPumpError — it must not THROW out of the race.
    Promise.allSettled([stdoutPump.done, stderrPump.done]).then(() => true),
    new Promise<boolean>((resolve) => {
      // RFC-254: this deadline must stay ref'd — the await depends on it, and
      // unref'd timers never fire on Windows Bun once the loop is otherwise
      // idle (see rfc254-no-unref-deadline-guard.test.ts).
      drainTimer = setTimeout(() => resolve(false), Math.max(1_000, graceMs))
    }),
  ])
  if (drainTimer !== undefined) clearTimeout(drainTimer)
  let drainTimedOut = false
  if (!drained) {
    stdoutPump.cancel()
    stderrPump.cancel()
    killTree(child, 'SIGKILL')
    if (outcome === 'exited') {
      // RFC-280 T4: an agent caller keeps the real exitCode (trailing output
      // lost = evidence degradation, reported via drainTimedOut); the
      // historical relabel stays the default for script-node consumers.
      if (req.keepExitedOnDrainTimeout === true) drainTimedOut = true
      else outcome = 'child-unkillable'
    }
  }

  return {
    outcome,
    exitCode,
    rawStdout,
    stderrTail,
    truncated,
    spawnBinaryPath,
    pid,
    ...(drainTimedOut ? { drainTimedOut: true } : {}),
    ...(pumpError !== undefined ? { pumpError } : {}),
  }
}
