// RFC-253 T10 — the contained-subprocess primitive.
//
// `runner.ts` already knows how to run a child process safely: wrap the argv in
// the platform sandbox at the last moment, pump both streams with bounded
// buffers, SIGTERM the whole process group and escalate to SIGKILL after a
// grace period, and never let a wedged pipe hold the daemon open. That
// knowledge is currently welded into a 1900-line function that also renders
// prompts and parses model events, so the script node cannot reuse it.
//
// This module is that knowledge, extracted as an independent primitive.
//
// ⚠ HONEST STATUS (impl-gate M2, 2026-08-04): this file previously claimed a
// `containedSpawnRegistry.ts` ratchet forced every new `Bun.spawn` site through
// here. That file was never written — the claim was aspirational and shipped as
// if it were fact. It is the ONE thing that would have justified a second spawn
// implementation living beside runner.ts, so without it this IS a second
// implementation, and `scriptRun.ts:resolveScriptInterpreter` already added a
// bare `Bun.spawn` site that such a ratchet would have caught. The work is
// tracked as plan.md T11 and in docs/audit-backlog.md; until it lands, treat
// "runner.ts will migrate to this" as an intention, not a booked debt.
//
// One deliberate difference from runner.ts (design-gate F8): the caller can ask
// for the RAW stdout bytes in addition to the line stream. The line pump drops
// empty lines and the trailing newline — correct for a JSON event stream, wrong
// for "the script's stdout IS the port value", where `a\n\nb\n` must survive
// byte for byte.

import type { Logger } from '@/util/log'
import { killProcessTree } from '@/util/process'
import { explainSpawnEnoent } from '@/util/spawnDiagnostics'
import { platformSpawnOptionsForHost } from '@/util/platformExec'
import {
  sandboxEnforceBlocked,
  wrapSpawnPlanSandbox,
  type SandboxCtx,
  type SpawnSandboxTopology,
} from '../sandbox'

/** Per-line cap (code units); mirrors runner.ts MAX_STREAM_LINE_CHARS. */
export const CONTAINED_MAX_LINE_CHARS = 1024 * 1024
/** Rolling-tail cap for the retained raw stream text. */
export const CONTAINED_MAX_STREAM_CHARS = 8 * 1024 * 1024

const LINE_TRUNCATED_MARKER = '…[line truncated]'

export type ContainedSpawnOutcome =
  | 'exited'
  | 'timeout'
  | 'aborted'
  | 'spawn-failed'
  | 'child-unkillable'

export interface ContainedSpawnRequest {
  argv: readonly string[]
  cwd: string
  /** COMPLETE environment. The daemon's own env is never inherited. */
  env: Record<string, string>
  timeoutMs?: number
  killEscalationGraceMs?: number
  signal?: AbortSignal
  sandbox?: SandboxCtx
  sandboxTopology?: SpawnSandboxTopology
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
  /** Retain raw stdout bytes (byte-exact, unlike the line stream). */
  captureRawStdout?: boolean
  log?: Logger
}

export interface ContainedSpawnResult {
  outcome: ContainedSpawnOutcome
  exitCode: number | null
  /** Byte-exact stdout when `captureRawStdout`, else ''. Tail-truncated at the cap. */
  rawStdout: string
  /** Rolling tail of stderr, for error messages. */
  stderrTail: string
  truncated: { stdout: boolean; stderr: boolean }
  /**
   * argv[0] BEFORE sandbox wrapping — the binary the reaper must match a live
   * pid against. `sandbox-exec` execs in place and never shows up in `ps`, so
   * recording the wrapper made every stale-process check report a pid mismatch
   * and skip the kill entirely (2026-08-04 audit). Same convention as
   * `runner.ts`, which records `plan.cmd[0]` for exactly this reason.
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
function pump(
  stream: ReadableStream<Uint8Array>,
  onLine: ((line: string) => Promise<void> | void) | undefined,
  onRaw: ((chunk: string) => void) | undefined,
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
            else if (buffer.length > CONTAINED_MAX_LINE_CHARS) {
              await onLine(buffer.slice(0, CONTAINED_MAX_LINE_CHARS) + LINE_TRUNCATED_MARKER)
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
        await onLine(
          buffer.length > CONTAINED_MAX_LINE_CHARS
            ? buffer.slice(0, CONTAINED_MAX_LINE_CHARS) + LINE_TRUNCATED_MARKER
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
 * Run one contained subprocess to completion.
 *
 * Never throws for a child-side failure: every outcome (crash, timeout, abort,
 * missing binary) comes back in `ContainedSpawnResult` so the caller writes one
 * terminal row rather than juggling exception paths.
 */
export async function runContainedProcess(
  req: ContainedSpawnRequest,
): Promise<ContainedSpawnResult> {
  const log = req.log ?? noopLog
  const graceMs = req.killEscalationGraceMs ?? 10_000

  // The enforce-mode fence must close BEFORE the child exists, not after: an
  // unsandboxed run that is later reported as blocked has already run.
  if (sandboxEnforceBlocked(req.sandbox)) {
    return {
      outcome: 'spawn-failed',
      exitCode: null,
      rawStdout: '',
      stderrTail: '',
      truncated: { stdout: false, stderr: false },
      spawnBinaryPath: req.argv[0] ?? '',
      pid: null,
      spawnError: 'sandbox-unavailable',
    }
  }

  const cmd = wrapSpawnPlanSandbox(req.argv, req.sandbox, req.sandboxTopology)
  // 2026-08-04 audit: the RECORDED binary is the UNWRAPPED argv[0], matching
  // `runner.ts` (whose comment spells out why: the stale-process reaper matches
  // a live pid against this exact binary). Recording the wrapper instead broke
  // that on macOS, where `sandbox-exec` execs in place and therefore never
  // appears in `ps` — `pidCommandContainsBinary` then returned false forever,
  // `killStaleRunProcessTree` reported `command-mismatch` and sent NO signal,
  // and the boot reaper flipped the row to `interrupted` and let startup
  // proceed while the script kept writing. Resume/retry's "kill the live
  // writer before rolling back" precondition was silently bypassed — the
  // healthier the containment, the less killable the process.
  const spawnBinaryPath = req.argv[0] ?? ''

  let child: Bun.Subprocess
  try {
    child = Bun.spawn({
      ...platformSpawnOptionsForHost(),
      cmd: cmd as string[],
      cwd: req.cwd,
      env: req.env,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      // Own process group so the whole descendant tree can be signalled.
      // Without it a fork()ed grandchild survives every kill we send.
      detached: true,
    })
  } catch (err) {
    // A missing binary makes Bun.spawn THROW rather than return 127 — and Bun
    // names argv[0] in the ENOENT even when the missing path is the cwd, so
    // under a sandbox wrapper "the worktree is gone" reads as "bwrap is gone"
    // (`docs/dev-gotchas.md`, 2026-08-04 incident). Translate before reporting.
    return {
      outcome: 'spawn-failed',
      exitCode: null,
      rawStdout: '',
      stderrTail: '',
      truncated: { stdout: false, stderr: false },
      spawnBinaryPath,
      pid: null,
      spawnError: explainSpawnEnoent(err instanceof Error ? err.message : String(err), {
        argv0: cmd[0] ?? spawnBinaryPath,
        cwd: req.cwd,
      }),
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
          const next = appendBounded(rawStdout, chunk, CONTAINED_MAX_STREAM_CHARS)
          rawStdout = next.text
          if (next.truncated) truncated.stdout = true
        }
      : undefined,
  )
  const stderrPump = pump(child.stderr as ReadableStream<Uint8Array>, req.onStderrLine, (chunk) => {
    const next = appendBounded(stderrTail, chunk, CONTAINED_MAX_STREAM_CHARS)
    stderrTail = next.text
    if (next.truncated) truncated.stderr = true
  })

  let outcome: ContainedSpawnOutcome = 'exited'
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined

  const escalate = (): void => {
    // impl-gate 3.2: a second escalation (cancel, then the timeout firing during
    // the grace window) used to overwrite `killTimer`, leaving the first timer
    // to fire later at a pid that may already be recycled.
    if (killTimer !== undefined) return
    killTree(child, 'SIGTERM')
    killTimer = setTimeout(() => {
      log.warn('child ignored SIGTERM past grace; escalating to SIGKILL', { pid, graceMs })
      killTree(child, 'SIGKILL')
    }, graceMs)
    killTimer.unref()
  }

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
  try {
    exitCode = await child.exited
  } finally {
    if (killTimer !== undefined) clearTimeout(killTimer)
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
    req.signal?.removeEventListener('abort', onAbort)
  }

  // Bound the wait on the pipes: a surviving grandchild can hold the write end
  // open forever, and `done` would never settle.
  let drainTimer: ReturnType<typeof setTimeout> | undefined
  const drained = await Promise.race([
    Promise.all([stdoutPump.done, stderrPump.done]).then(() => true),
    new Promise<boolean>((resolve) => {
      // RFC-254: this deadline must stay ref'd — the await depends on it, and
      // unref'd timers never fire on Windows Bun once the loop is otherwise
      // idle (see rfc254-no-unref-deadline-guard.test.ts).
      drainTimer = setTimeout(() => resolve(false), Math.max(1_000, graceMs))
    }),
  ])
  if (drainTimer !== undefined) clearTimeout(drainTimer)
  if (!drained) {
    stdoutPump.cancel()
    stderrPump.cancel()
    killTree(child, 'SIGKILL')
    if (outcome === 'exited') outcome = 'child-unkillable'
  }

  return {
    outcome,
    exitCode,
    rawStdout,
    stderrTail,
    truncated,
    spawnBinaryPath,
    pid,
  }
}
