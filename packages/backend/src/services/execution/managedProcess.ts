// RFC-276 — neutral managed-process primitive.
//
// This module owns process reliability only: bounded stream pumps, byte-exact
// stdout capture, a durable PID receipt seam, timeout/cancel handling, process
// tree termination with SIGKILL escalation, and a bounded pipe-drain deadline.
// It deliberately has no sandbox, containment, network, filesystem, or runtime
// identity policy. Callers pass the exact argv, cwd, and complete environment
// that should reach the child.

import type { Logger } from '@/util/log'
import { randomUUID } from 'node:crypto'
import { closeSync, openSync, readSync } from 'node:fs'
import { killProcessTree } from '@/util/process'
import { explainSpawnEnoent } from '@/util/spawnDiagnostics'
import { platformSpawnOptionsForHost } from '@/util/platformExec'
import { JS_TIMER_MAX_MS } from '@agent-workflow/shared'
import {
  MANAGED_PROCESS_LAUNCH_ERROR_PREFIX,
  MANAGED_PROCESS_LAUNCH_OUTPUT_PREFIX,
  MANAGED_PROCESS_LAUNCH_READY_PREFIX,
  cleanupWindowsOutputSpool,
  createWindowsOutputSpool,
  managedProcessLauncherArgv,
  managedProcessLauncherEnvironment,
  type ManagedProcessActivationFrame,
  type WindowsOutputSpool,
} from './managedProcessLauncher'

/** Per-line cap (code units)——数值单点；runner.ts 的 MAX_STREAM_LINE_CHARS 是本值的 re-export（RFC-284 §3.5）。 */
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
  onSpawned?: (info: {
    pid: number
    spawnBinaryPath: string
    /** Present for the RFC-328 pre-activation launcher. */
    launchNonce?: string
  }) => Promise<void> | void
  /**
   * Task execution uses a durable pre-activation receipt.  When enabled, a
   * missing/failed onSpawned callback prevents stdin delivery, terminates and
   * reaps the process tree, and reports spawn-failed.
   */
  requireSpawnReceipt?: boolean
  onStdoutLine?: (line: string) => Promise<void> | void
  onStderrLine?: (line: string) => Promise<void> | void
  /**
   * RFC-314 D3 —— 一个 chunk 的行投递完之后各调一次（见 `pump()` 的同名参数）。
   * 调用方用它把逐行写入合并成一条语句；不传即行为逐字不变。
   */
  onStdoutChunkEnd?: () => Promise<void> | void
  onStderrChunkEnd?: () => Promise<void> | void
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
  /** Durable launcher identity when pre-activation is enabled. */
  launchNonce?: string
  spawnError?: string
  /** Hosted Windows relay evidence from the compiled launcher. */
  launcherOutputBytes?: { stdoutBytes: number; stderrBytes: number }
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

function stripLauncherProtocol(text: string, launchNonce: string | undefined): string {
  if (launchNonce === undefined) return text
  const ready = `${MANAGED_PROCESS_LAUNCH_READY_PREFIX}${launchNonce}`
  const error = `${MANAGED_PROCESS_LAUNCH_ERROR_PREFIX}${launchNonce}:`
  const output = `${MANAGED_PROCESS_LAUNCH_OUTPUT_PREFIX}${launchNonce}:`
  return text
    .split('\n')
    .map((line) => {
      const readyAt = line.indexOf(ready)
      const errorAt = line.indexOf(error)
      const outputAt = line.indexOf(output)
      const controlOffsets = [readyAt, errorAt, outputAt].filter((index) => index >= 0)
      return controlOffsets.length === 0 ? line : line.slice(0, Math.min(...controlOffsets))
    })
    .join('\n')
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
  /**
   * RFC-314 D3 —— 一个 chunk 的所有完整行都投递完之后调用一次（EOF 收尾行之后再调
   * 一次）。调用方用它把逐行累积的写入合并成一条语句：**chunk 边界是唯一一个既天然
   * 存在、又不引入新的持久化延迟的边界**——它在同一个 `await` 内跑完才让出事件循环，
   * pump 的下一次 `reader.read()` 之前一定已经落库，因此读点不需要任何 flush 屏障。
   * 不传即行为逐字不变（本仓另外四个调用方都不传）。
   */
  onChunkEnd?: () => Promise<void> | void,
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
        // RFC-314 D3：本 chunk 的完整行已全部投递。
        await onChunkEnd?.()
      }
      if (onLine !== undefined && buffer.length > 0 && !canceled && !dropping) {
        if (buffer.length > MANAGED_PROCESS_MAX_LINE_CHARS) await onLineTruncated?.()
        await onLine(
          buffer.length > MANAGED_PROCESS_MAX_LINE_CHARS
            ? buffer.slice(0, MANAGED_PROCESS_MAX_LINE_CHARS) + LINE_TRUNCATED_MARKER
            : buffer,
        )
        // RFC-314 D3：EOF 收尾行也要冲刷，否则最后一行会留在缓冲里。
        await onChunkEnd?.()
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

function readWindowsOutputSpoolChunk(path: string, offset: number, buffer: Uint8Array): number {
  // Reopen on every pull. Bun 1.4 on Windows can leave a regular-file
  // descriptor at sticky EOF while another process subsequently extends it.
  const readFd = openSync(path, 'r')
  try {
    return readSync(readFd, buffer, 0, buffer.byteLength, offset)
  } finally {
    closeSync(readFd)
  }
}

function windowsOutputSpoolStream(
  path: string,
  writersClosed: Promise<void>,
  completion?:
    | { expectedBytes: Promise<number>; interrupted: Promise<void> }
    | { completionSeen: Promise<void> },
): ReadableStream<Uint8Array> {
  const buffer = new Uint8Array(64 * 1024)
  let offset = 0
  let writersAreClosed = false
  let expectedBytes: number | undefined
  let interruptionWasSeen = false
  let completionWasSeen = completion === undefined
  let stablePolls = 0
  let canceled = false
  const observedClosure = writersClosed.then(
    () => {
      writersAreClosed = true
    },
    (error) => {
      writersAreClosed = true
      throw error
    },
  )
  // `pull` propagates the same rejection; this prevents a temporary unhandled
  // promise while the durable receipt callback is still running.
  void observedClosure.catch(() => {})
  if (completion !== undefined) {
    if ('expectedBytes' in completion) {
      void completion.expectedBytes.then((value) => {
        expectedBytes = value
      })
      void completion.interrupted.then(() => {
        interruptionWasSeen = true
      })
    } else {
      void completion.completionSeen.then(() => {
        completionWasSeen = true
      })
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      try {
        while (!canceled) {
          const count = readWindowsOutputSpoolChunk(path, offset, buffer)
          if (count > 0) {
            offset += count
            stablePolls = 0
            // The next pull reuses `buffer`; enqueue an owned copy.
            controller.enqueue(buffer.slice(0, count))
            return
          }

          if (writersAreClosed) {
            await observedClosure
            if (completion !== undefined && 'expectedBytes' in completion) {
              if (expectedBytes !== undefined && offset >= expectedBytes) {
                controller.close()
                return
              }
              if (interruptionWasSeen) {
                // Timeout/cancel kills the launcher before it can write its
                // ordinary OUTPUT byte-count record. Once that launcher handle
                // is closed, two empty polls are the terminal barrier for the
                // bytes it managed to relay; do not wait a full drain grace for
                // a record that can no longer be produced.
                stablePolls += 1
                if (stablePolls >= 2) {
                  controller.close()
                  return
                }
                await Bun.sleep(10)
                continue
              }
              await Promise.race([completion.expectedBytes, completion.interrupted, Bun.sleep(10)])
              continue
            }
            if (!completionWasSeen) {
              await Promise.race([
                (completion as { completionSeen: Promise<void> }).completionSeen,
                Bun.sleep(10),
              ])
              continue
            }
            stablePolls += 1
            if (stablePolls >= 2) {
              controller.close()
              return
            }
            await Bun.sleep(10)
          } else {
            await Promise.race([observedClosure, Bun.sleep(10)])
          }
        }
      } catch (error) {
        if (!canceled) controller.error(error)
      }
    },
    cancel(): void {
      canceled = true
    },
  })
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
  const launchNonce = req.requireSpawnReceipt === true ? randomUUID() : undefined

  if (req.requireSpawnReceipt === true && req.onSpawned === undefined) {
    return {
      outcome: 'spawn-failed',
      exitCode: null,
      rawStdout: '',
      stderrTail: '',
      truncated: { stdout: false, stderr: false },
      spawnBinaryPath,
      pid: null,
      spawnError: 'required durable spawn receipt callback is missing',
    }
  }

  if (
    req.timeoutMs !== undefined &&
    (!Number.isSafeInteger(req.timeoutMs) || req.timeoutMs < 0 || req.timeoutMs > JS_TIMER_MAX_MS)
  ) {
    return {
      outcome: 'spawn-failed',
      exitCode: null,
      rawStdout: '',
      stderrTail: '',
      truncated: { stdout: false, stderr: false },
      spawnBinaryPath,
      pid: null,
      spawnError: `timeoutMs must be an integer from 0 to ${JS_TIMER_MAX_MS}`,
    }
  }

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
  let outputSpool: WindowsOutputSpool | undefined
  try {
    outputSpool =
      process.platform === 'win32' && launchNonce !== undefined
        ? createWindowsOutputSpool()
        : undefined
    const spawnArgv =
      launchNonce === undefined
        ? [...req.argv]
        : managedProcessLauncherArgv({
            launchNonce,
            targetArgv: req.argv,
            ...(outputSpool === undefined ? {} : { windowsOutputPaths: outputSpool }),
          })
    // A compiled Bun launcher can lose writes to its inherited fd 1/2 even
    // when both ends use regular-file redirection. On Windows the parent passes
    // three private paths instead: the launcher copies target bytes directly to
    // stdout/stderr files and writes readiness/errors to a separate control
    // file. The launcher process owns every final writer, so its exit is an
    // actual close boundary rather than a timing guess across nested stdio.
    child = Bun.spawn({
      ...platformSpawnOptionsForHost(),
      cmd: spawnArgv,
      cwd: req.cwd,
      env:
        launchNonce === undefined
          ? req.env
          : managedProcessLauncherEnvironment({ env: req.env, launchNonce }),
      stdout: outputSpool === undefined ? 'pipe' : 'ignore',
      stderr: outputSpool === undefined ? 'pipe' : 'ignore',
      // A gated launcher always needs its private activation pipe. The target's
      // actual stdin mode is carried inside the post-receipt frame.
      stdin: launchNonce !== undefined || req.stdin?.mode === 'pipe' ? 'pipe' : 'ignore',
      // POSIX needs a detached process-group leader so -pid reaches every
      // descendant. Windows has no POSIX process groups and its tree kill is
      // already owned by Job Object/taskkill; Bun's detached Windows spawn can
      // lose compiled-child output, so keep that host flat.
      detached: process.platform !== 'win32',
    })
  } catch (err) {
    cleanupWindowsOutputSpool(outputSpool)
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

  const childExited = child.exited
  const activeOutputSpool = outputSpool
  const outputWritersClosed =
    activeOutputSpool === undefined ? Promise.resolve() : childExited.then(() => {})

  const pid = typeof child.pid === 'number' ? child.pid : null
  let activationFailure: string | null = null
  if (pid !== null && req.onSpawned !== undefined) {
    try {
      await req.onSpawned({
        pid,
        spawnBinaryPath,
        ...(launchNonce !== undefined ? { launchNonce } : {}),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (req.requireSpawnReceipt === true) activationFailure = message
      log.warn('onSpawned receipt failed', {
        pid,
        required: req.requireSpawnReceipt === true,
        error: message,
      })
    }
  }

  // A gated launcher receives exactly one frame only AFTER the durable PID
  // receipt. Until then it cannot exec the real runtime or consume task stdin.
  // Non-task callers retain the historical direct one-shot stdin path.
  if (activationFailure === null && launchNonce !== undefined) {
    const sink = child.stdin as { write: (s: string) => void; end: () => void } | undefined
    if (sink !== undefined) {
      try {
        const frame: ManagedProcessActivationFrame = {
          v: 1,
          launchNonce,
          targetArgv: req.argv,
          targetEnv: req.env,
          stdin:
            req.stdin?.mode === 'pipe'
              ? { mode: 'pipe', data: req.stdin.data }
              : { mode: 'ignore' },
          ...(outputSpool === undefined
            ? {}
            : {
                windowsOutputPaths: {
                  stdoutPath: outputSpool.stdoutPath,
                  stderrPath: outputSpool.stderrPath,
                  controlPath: outputSpool.controlPath,
                },
              }),
        }
        sink.write(JSON.stringify(frame))
        sink.end()
      } catch (err) {
        activationFailure = err instanceof Error ? err.message : String(err)
        log.warn('managed-process stdin write failed', {
          error: activationFailure,
        })
      }
    }
  } else if (activationFailure === null && req.stdin?.mode === 'pipe') {
    const sink = child.stdin as { write: (s: string) => void; end: () => void } | undefined
    if (sink !== undefined) {
      try {
        sink.write(req.stdin.data)
        sink.end()
      } catch (err) {
        log.warn('managed-process stdin write failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  let rawStdout = ''
  let stderrTail = ''
  let launcherSpawnError: string | undefined
  let launcherOutputBytes: { stdoutBytes: number; stderrBytes: number } | undefined
  let launcherOutputResolve:
    | ((value: { stdoutBytes: number; stderrBytes: number }) => void)
    | undefined
  const launcherOutput = new Promise<{ stdoutBytes: number; stderrBytes: number }>((resolve) => {
    launcherOutputResolve = resolve
  })
  let launcherOutputSeenResolve: (() => void) | undefined
  const launcherOutputSeen = new Promise<void>((resolve) => {
    launcherOutputSeenResolve = resolve
  })
  let launcherInterruptedResolve: (() => void) | undefined
  const launcherInterrupted = new Promise<void>((resolve) => {
    launcherInterruptedResolve = resolve
  })
  let launcherReadyResolve: (() => void) | undefined
  const launcherReady = new Promise<void>((resolve) => {
    launcherReadyResolve = resolve
  })
  const truncated = { stdout: false, stderr: false }

  const consumeLauncherControlLine = (line: string): boolean => {
    if (
      launchNonce !== undefined &&
      line.startsWith(`${MANAGED_PROCESS_LAUNCH_READY_PREFIX}${launchNonce}`)
    ) {
      launcherReadyResolve?.()
      return true
    }
    if (
      launchNonce !== undefined &&
      line.startsWith(`${MANAGED_PROCESS_LAUNCH_ERROR_PREFIX}${launchNonce}:`)
    ) {
      const encoded = line.slice(`${MANAGED_PROCESS_LAUNCH_ERROR_PREFIX}${launchNonce}:`.length)
      try {
        const parsed: unknown = JSON.parse(encoded)
        launcherSpawnError = typeof parsed === 'string' ? parsed : encoded
      } catch {
        launcherSpawnError = encoded
      }
      // A launcher-side failure may happen before any target exists, so there
      // is no later OUTPUT record. ERROR is the terminal 0-byte barrier for
      // that path; any bytes already observed by a post-spawn failure remain
      // retained by the pumps before they close.
      const noTargetOutput = { stdoutBytes: 0, stderrBytes: 0 }
      launcherOutputResolve?.(noTargetOutput)
      launcherOutputSeenResolve?.()
      return true
    }
    if (
      launchNonce !== undefined &&
      line.startsWith(`${MANAGED_PROCESS_LAUNCH_OUTPUT_PREFIX}${launchNonce}:`)
    ) {
      const encoded = line.slice(`${MANAGED_PROCESS_LAUNCH_OUTPUT_PREFIX}${launchNonce}:`.length)
      try {
        const parsed: unknown = JSON.parse(encoded)
        const stdoutBytes = (parsed as { stdoutBytes?: unknown } | null)?.stdoutBytes
        const stderrBytes = (parsed as { stderrBytes?: unknown } | null)?.stderrBytes
        if (
          parsed !== null &&
          typeof parsed === 'object' &&
          typeof stdoutBytes === 'number' &&
          Number.isSafeInteger(stdoutBytes) &&
          stdoutBytes >= 0 &&
          typeof stderrBytes === 'number' &&
          Number.isSafeInteger(stderrBytes) &&
          stderrBytes >= 0
        ) {
          launcherOutputBytes = { stdoutBytes, stderrBytes }
          launcherOutputResolve?.(launcherOutputBytes)
          launcherOutputSeenResolve?.()
        } else {
          launcherSpawnError = 'invalid managed-process launcher output record'
        }
      } catch {
        launcherSpawnError = 'invalid managed-process launcher output record'
      }
      return true
    }
    return false
  }

  const stdoutPump = pump(
    activeOutputSpool === undefined
      ? (child.stdout as ReadableStream<Uint8Array>)
      : windowsOutputSpoolStream(activeOutputSpool.stdoutPath, outputWritersClosed, {
          expectedBytes: launcherOutput.then((value) => value.stdoutBytes),
          interrupted: launcherInterrupted,
        }),
    req.onStdoutLine,
    req.captureRawStdout === true
      ? (chunk) => {
          const next = appendBounded(rawStdout, chunk, MANAGED_PROCESS_MAX_STREAM_CHARS)
          rawStdout = next.text
          if (next.truncated) truncated.stdout = true
        }
      : undefined,
    req.onLineTruncated,
    req.onStdoutChunkEnd,
  )
  const stderrPump = pump(
    activeOutputSpool === undefined
      ? (child.stderr as ReadableStream<Uint8Array>)
      : windowsOutputSpoolStream(activeOutputSpool.stderrPath, outputWritersClosed, {
          expectedBytes: launcherOutput.then((value) => value.stderrBytes),
          interrupted: launcherInterrupted,
        }),
    async (line) => {
      if (consumeLauncherControlLine(line)) return
      await req.onStderrLine?.(line)
    },
    (chunk) => {
      const next = appendBounded(stderrTail, chunk, MANAGED_PROCESS_MAX_STREAM_CHARS)
      stderrTail = next.text
      if (next.truncated) truncated.stderr = true
    },
    req.onLineTruncated,
    req.onStderrChunkEnd,
  )
  const controlPump =
    activeOutputSpool === undefined
      ? undefined
      : pump(
          windowsOutputSpoolStream(activeOutputSpool.controlPath, outputWritersClosed, {
            completionSeen: launcherOutputSeen,
          }),
          (line) => {
            if (!consumeLauncherControlLine(line)) {
              log.warn('unknown managed-process launcher control record', { line })
            }
          },
          undefined,
        )

  let outcome: ManagedProcessOutcome = activationFailure === null ? 'exited' : 'spawn-failed'
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let reapDeadlineTimer: ReturnType<typeof setTimeout> | undefined
  let executionSettled = false
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
    launcherInterruptedResolve?.()
    launcherOutputSeenResolve?.()
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

  if (activationFailure !== null) escalate()

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
  void controlPump?.done.catch(onPumpError)

  const onAbort = (): void => {
    if (outcome === 'exited') outcome = 'aborted'
    escalate()
  }
  if (req.signal !== undefined) {
    if (req.signal.aborted) onAbort()
    else req.signal.addEventListener('abort', onAbort, { once: true })
  }
  const armExecutionTimeout = (): void => {
    if (
      executionSettled ||
      killTimer !== undefined ||
      timeoutTimer !== undefined ||
      req.timeoutMs === undefined ||
      req.timeoutMs <= 0
    ) {
      return
    }
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
  if (launchNonce === undefined) armExecutionTimeout()
  else void launcherReady.then(armExecutionTimeout)

  let exitCode: number | null = null
  let childUnreaped = false
  try {
    // RFC-280 impl-gate P1-A: race the exit against the reap deadline (armed on
    // escalation) so an unkillable child cannot wedge the caller forever.
    const exitResult = await Promise.race([
      childExited.then((code) => ({ kind: 'exited' as const, code })),
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
    executionSettled = true
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
    controlPump?.cancel()
    // impl-gate P1-1: the child is STILL ALIVE here (its `.exited` never
    // resolved), so its handle keeps the event loop ref'd. Without unref the
    // abandoned unkillable child pins the daemon (and `bun test`) open forever
    // — the exact liveness bound the pre-RFC-280 runner protected with
    // `child.unref()` and the T7 collapse dropped.
    child.unref()
    cleanupWindowsOutputSpool(outputSpool)
    return {
      outcome,
      exitCode,
      rawStdout,
      stderrTail: stripLauncherProtocol(stderrTail, launchNonce),
      truncated,
      spawnBinaryPath,
      pid,
      ...(launchNonce !== undefined ? { launchNonce } : {}),
      ...(activationFailure !== null ? { spawnError: activationFailure } : {}),
      ...(pumpError !== undefined ? { pumpError } : {}),
      ...(launcherOutputBytes === undefined ? {} : { launcherOutputBytes }),
    }
  }

  // Bound the wait on the pipes: a surviving grandchild can hold the write end
  // open forever, and `done` would never settle.
  let drainTimer: ReturnType<typeof setTimeout> | undefined
  const drained = await Promise.race([
    // allSettled: a rejected pump (callback threw) is already recorded via
    // onPumpError — it must not THROW out of the race.
    Promise.allSettled([
      stdoutPump.done,
      stderrPump.done,
      ...(controlPump === undefined ? [] : [controlPump.done]),
    ]).then(() => true),
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
    controlPump?.cancel()
    killTree(child, 'SIGKILL')
    if (outcome === 'exited') {
      // RFC-280 T4: an agent caller keeps the real exitCode (trailing output
      // lost = evidence degradation, reported via drainTimedOut); the
      // historical relabel stays the default for script-node consumers.
      if (req.keepExitedOnDrainTimeout === true) drainTimedOut = true
      else outcome = 'child-unkillable'
    }
  }

  if (launcherSpawnError !== undefined) {
    outcome = 'spawn-failed'
    exitCode = null
  }

  // Launcher control records share the inherited stderr pipe but are private
  // orchestration metadata.  Keep user/runtime diagnostics byte-for-byte while
  // removing those records from the returned tail.
  stderrTail = stripLauncherProtocol(stderrTail, launchNonce)

  cleanupWindowsOutputSpool(outputSpool)

  return {
    outcome,
    exitCode,
    rawStdout,
    stderrTail,
    truncated,
    spawnBinaryPath,
    pid,
    ...(launchNonce !== undefined ? { launchNonce } : {}),
    ...(activationFailure !== null
      ? { spawnError: activationFailure }
      : launcherSpawnError !== undefined
        ? {
            spawnError: explainSpawnEnoent(launcherSpawnError, {
              argv0: req.argv[0] ?? spawnBinaryPath,
              cwd: req.cwd,
            }),
          }
        : {}),
    ...(drainTimedOut ? { drainTimedOut: true } : {}),
    ...(pumpError !== undefined ? { pumpError } : {}),
    ...(launcherOutputBytes === undefined ? {} : { launcherOutputBytes }),
  }
}
