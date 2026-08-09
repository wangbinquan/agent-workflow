import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const MAX_SEED = 2_147_483_647
const MAX_LOCAL_SHARDS = 16
const MAX_SHARD_TIMEOUT_MS = 86_400_000
const MAX_SHARD_KILL_GRACE_MS = 60_000
const POST_KILL_SETTLE_MS = 1_000

export const DEFAULT_LOCAL_BACKEND_SHARDS = 4
export const DEFAULT_LOCAL_BACKEND_SHARD_TIMEOUT_MS = 15 * 60_000
export const DEFAULT_LOCAL_BACKEND_SHARD_KILL_GRACE_MS = 2_000

export interface BackendShardPlan {
  index: number
  count: number
  seed: number
  command: string[]
  homeDir: string
  tempDir: string
  env: Record<string, string>
}

interface BuildBackendShardPlansOptions {
  runRoot: string
  shardCount: number
  baseSeed: number
  bunExecutable?: string
}

export interface ShardResult {
  plan: BackendShardPlan
  exitCode: number
  durationMs: number
  output: string
  timedOut: boolean
}

export interface KillableProcess {
  readonly pid: number
  kill(signal?: NodeJS.Signals | number): void
  unref?(): void
}

export type BackendShardInterruptSignal = 'SIGINT' | 'SIGTERM'

export interface BackendShardInterruptController {
  readonly interruptedSignal: BackendShardInterruptSignal | undefined
  interrupt(signal: BackendShardInterruptSignal): void
  dispose(): void
}

interface BackendShardInterruptControllerOptions {
  signalProcessTree?: (child: KillableProcess, signal: NodeJS.Signals) => void
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (handle: unknown) => void
  onEscalate?: (reason: 'grace-expired' | 'second-signal') => void
}

export interface RunBackendShardOptions {
  timeoutMs: number
  killGraceMs: number
  active?: Set<KillableProcess>
}

function parseInteger(
  raw: string | undefined,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer between ${min} and ${max}`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return value
}

export function resolveLocalBackendShardCount(raw: string | undefined): number {
  return parseInteger(
    raw,
    'AW_LOCAL_BACKEND_SHARDS',
    DEFAULT_LOCAL_BACKEND_SHARDS,
    1,
    MAX_LOCAL_SHARDS,
  )
}

export function resolveLocalTestSeed(raw: string | undefined, now = Date.now()): number {
  const generated = (Math.abs(Math.trunc(now)) % (MAX_SEED - 1)) + 1
  return parseInteger(raw, 'AW_LOCAL_TEST_SEED', generated, 1, MAX_SEED)
}

export function resolveLocalBackendShardTimeoutMs(raw: string | undefined): number {
  return parseInteger(
    raw,
    'AW_LOCAL_BACKEND_SHARD_TIMEOUT_MS',
    DEFAULT_LOCAL_BACKEND_SHARD_TIMEOUT_MS,
    1,
    MAX_SHARD_TIMEOUT_MS,
  )
}

export function resolveLocalBackendShardKillGraceMs(raw: string | undefined): number {
  return parseInteger(
    raw,
    'AW_LOCAL_BACKEND_SHARD_KILL_GRACE_MS',
    DEFAULT_LOCAL_BACKEND_SHARD_KILL_GRACE_MS,
    0,
    MAX_SHARD_KILL_GRACE_MS,
  )
}

export function buildBackendShardPlans({
  runRoot,
  shardCount,
  baseSeed,
  bunExecutable = process.execPath,
}: BuildBackendShardPlansOptions): BackendShardPlan[] {
  if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > MAX_LOCAL_SHARDS) {
    throw new Error(`shardCount must be between 1 and ${MAX_LOCAL_SHARDS}`)
  }
  if (!Number.isInteger(baseSeed) || baseSeed < 1 || baseSeed > MAX_SEED) {
    throw new Error(`baseSeed must be between 1 and ${MAX_SEED}`)
  }

  return Array.from({ length: shardCount }, (_, offset) => {
    const index = offset + 1
    const seed = ((baseSeed + offset - 1) % MAX_SEED) + 1
    const homeDir = join(runRoot, `home-${index}`)
    const tempDir = join(runRoot, `tmp-${index}`)
    return {
      index,
      count: shardCount,
      seed,
      command: [
        bunExecutable,
        'test',
        '--isolate',
        '--randomize',
        `--seed=${seed}`,
        `--shard=${index}/${shardCount}`,
        '--dots',
      ],
      homeDir,
      tempDir,
      env: {
        AGENT_WORKFLOW_HOME: homeDir,
        AGENT_WORKFLOW_TEST_SHARD_HOME: homeDir,
        AGENT_WORKFLOW_TEST_SHARD_TMP: tempDir,
        TMPDIR: tempDir,
        TMP: tempDir,
        TEMP: tempDir,
      },
    }
  })
}

function durationLabel(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`
}

function summaryLines(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:--seed=|\d+ (?:pass|skip|fail)|Ran )/.test(line))
}

function outputTail(output: string, maxLines = 300): string {
  const lines = output.split(/\r?\n/)
  return lines.slice(Math.max(0, lines.length - maxLines)).join('\n')
}

interface StreamCapture {
  done: Promise<string>
  cancel(reason: string): Promise<void>
}

/**
 * Read a child pipe while retaining partial output. `Response(stream).text()`
 * cannot be interrupted when a descendant inherits the descriptor, so timeout
 * handling owns the reader and can explicitly cancel the pending read.
 */
function captureStream(stream: ReadableStream<Uint8Array>): StreamCapture {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let output = ''
  let canceled = false
  let settled = false
  const done = (async () => {
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        output += decoder.decode(next.value, { stream: true })
      }
      output += decoder.decode()
      return output
    } catch (error) {
      if (!canceled) throw error
      output += decoder.decode()
      return output
    } finally {
      settled = true
      reader.releaseLock()
    }
  })()
  return {
    done,
    async cancel(reason: string): Promise<void> {
      if (settled) return
      canceled = true
      try {
        await reader.cancel(reason)
      } catch {
        // The process may close the stream between the settled check and cancel.
      }
      await done.catch(() => undefined)
    },
  }
}

async function waitWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ settled: true; value: T } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then((value) => ({ settled: true as const, value })),
      new Promise<{ settled: false }>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout({ settled: false }), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Every shard is spawned detached, so on POSIX `pid` is also its process-group
 * id. A negative pid targets the complete group (test runner plus subprocesses)
 * rather than leaving a hung runtime child behind. Windows has no negative-pid
 * group signal; Bun's detached-process kill is the platform fallback there.
 */
export function signalBackendShardProcessTree(
  child: KillableProcess,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // A very-early spawn failure may predate process-group creation. Fall
      // back to the direct handle so the runner still makes forward progress.
    }
  }
  try {
    child.kill(signal)
  } catch {
    // Already exited is idempotent for timeout/interrupt cleanup.
  }
}

export function backendShardInterruptExitCode(signal: 'SIGINT' | 'SIGTERM'): 130 | 143 {
  return signal === 'SIGINT' ? 130 : 143
}

/**
 * Forward the first shell interrupt, then bound shutdown by the same TERM→KILL
 * grace used for shard timeouts. A second signal skips the remaining grace and
 * kills every still-active process group immediately. The first signal remains
 * the shell exit-code owner (130 for SIGINT, 143 for SIGTERM).
 */
export function createBackendShardInterruptController(
  active: Set<KillableProcess>,
  killGraceMs: number,
  options: BackendShardInterruptControllerOptions = {},
): BackendShardInterruptController {
  if (!Number.isInteger(killGraceMs) || killGraceMs < 0 || killGraceMs > MAX_SHARD_KILL_GRACE_MS) {
    throw new Error(`killGraceMs must be an integer between 0 and ${MAX_SHARD_KILL_GRACE_MS}`)
  }
  const signalProcessTree = options.signalProcessTree ?? signalBackendShardProcessTree
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as Timer))
  let firstSignal: BackendShardInterruptSignal | undefined
  let escalationTimer: unknown
  // Snapshot ownership on first interrupt. A TERM/SIGINT-compliant group
  // leader can exit and be removed from the runner's live `active` set while
  // a signal-ignoring descendant still owns the detached process group.
  const interruptedGroups = new Set<KillableProcess>()

  const signalAll = (signal: NodeJS.Signals): void => {
    for (const child of active) interruptedGroups.add(child)
    for (const child of interruptedGroups) signalProcessTree(child, signal)
  }
  const cancelEscalationTimer = (): void => {
    if (escalationTimer === undefined) return
    clearTimer(escalationTimer)
    escalationTimer = undefined
  }
  const escalate = (reason: 'grace-expired' | 'second-signal'): void => {
    cancelEscalationTimer()
    options.onEscalate?.(reason)
    signalAll('SIGKILL')
  }

  return {
    get interruptedSignal() {
      return firstSignal
    },
    interrupt(signal): void {
      if (firstSignal !== undefined) {
        escalate('second-signal')
        return
      }
      firstSignal = signal
      signalAll(signal)
      escalationTimer = setTimer(() => {
        escalationTimer = undefined
        options.onEscalate?.('grace-expired')
        signalAll('SIGKILL')
      }, killGraceMs)
    },
    dispose(): void {
      // Before an interrupt, dispose is ordinary listener/timer cleanup. After
      // an interrupt, retaining the short grace timer is load-bearing: callers
      // may already have observed every direct child exit while descendants
      // remain in their original process groups.
      if (firstSignal === undefined) cancelEscalationTimer()
    },
  }
}

export async function runBackendShard(
  repoRoot: string,
  runRoot: string,
  plan: BackendShardPlan,
  options: RunBackendShardOptions,
): Promise<ShardResult> {
  if (
    !Number.isInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > MAX_SHARD_TIMEOUT_MS
  ) {
    throw new Error(`timeoutMs must be an integer between 1 and ${MAX_SHARD_TIMEOUT_MS}`)
  }
  if (
    !Number.isInteger(options.killGraceMs) ||
    options.killGraceMs < 0 ||
    options.killGraceMs > MAX_SHARD_KILL_GRACE_MS
  ) {
    throw new Error(`killGraceMs must be an integer between 0 and ${MAX_SHARD_KILL_GRACE_MS}`)
  }
  const active = options.active ?? new Set<KillableProcess>()
  mkdirSync(plan.homeDir, { recursive: true })
  mkdirSync(plan.tempDir, { recursive: true })
  const startedAt = performance.now()
  console.log(`[backend ${plan.index}/${plan.count}] start seed=${plan.seed}`)

  try {
    const child = Bun.spawn(plan.command, {
      cwd: repoRoot,
      env: { ...process.env, ...plan.env },
      stdout: 'pipe',
      stderr: 'pipe',
      // POSIX: makes child.pid the process-group id used by
      // signalBackendShardProcessTree. Also isolates user Ctrl-C forwarding
      // from the runner's own process group.
      detached: true,
    })
    active.add(child)
    const stdoutCapture = captureStream(child.stdout)
    const stderrCapture = captureStream(child.stderr)
    const completed = Promise.all([child.exited, stdoutCapture.done, stderrCapture.done]).then(
      ([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }),
    )
    try {
      const beforeDeadline = await waitWithin(completed, options.timeoutMs)
      if (beforeDeadline.settled) {
        const { exitCode, stdout, stderr } = beforeDeadline.value
        const output = [stdout, stderr].filter(Boolean).join('\n')
        const durationMs = performance.now() - startedAt

        if (exitCode === 0) {
          const summary = summaryLines(output).join(' | ')
          console.log(
            `[backend ${plan.index}/${plan.count}] pass ${durationLabel(durationMs)}${summary ? ` | ${summary}` : ''}`,
          )
        } else {
          const logPath = join(runRoot, `shard-${plan.index}.log`)
          await Bun.write(logPath, output)
          console.error(
            `[backend ${plan.index}/${plan.count}] FAIL exit=${exitCode} ${durationLabel(durationMs)} log=${logPath}`,
          )
          console.error(outputTail(output))
        }

        return { plan, exitCode, durationMs, output, timedOut: false }
      }

      const timeoutLine = `[backend ${plan.index}/${plan.count}] TIMEOUT after ${options.timeoutMs}ms; sent SIGTERM to process group ${child.pid}; grace=${options.killGraceMs}ms`
      console.error(timeoutLine)
      signalBackendShardProcessTree(child, 'SIGTERM')
      // Once the wall-clock deadline fires, the direct Bun handle is no longer
      // proof that the detached process GROUP is gone: the leader can obey TERM
      // and close both pipes while a grandchild that ignored TERM remains in
      // the group. Keep the full grace deadline and always probe/kill the group
      // at its boundary. SIGKILL is idempotent when the group is already empty.
      const graceElapsed = Bun.sleep(options.killGraceMs)
      const duringGrace = await waitWithin(completed, options.killGraceMs)
      await graceElapsed
      const killLine = `[backend ${plan.index}/${plan.count}] timeout grace expired; sent SIGKILL to process group ${child.pid}`
      console.error(killLine)
      signalBackendShardProcessTree(child, 'SIGKILL')
      let stdout: string
      let stderr: string
      if (duringGrace.settled) {
        stdout = duringGrace.value.stdout
        stderr = duringGrace.value.stderr
      } else {
        // A descendant can outlive the direct process or inherit its pipe. Do
        // not let either reader hold the shard runner beyond the hard deadline.
        await Promise.all([
          stdoutCapture.cancel('backend shard wall-clock timeout'),
          stderrCapture.cancel('backend shard wall-clock timeout'),
        ])
        const captured = await Promise.all([stdoutCapture.done, stderrCapture.done])
        stdout = captured[0]
        stderr = captured[1]
        const reaped = await waitWithin(child.exited, POST_KILL_SETTLE_MS)
        if (!reaped.settled) {
          child.unref?.()
          console.error(
            `[backend ${plan.index}/${plan.count}] process ${child.pid} did not settle within ${POST_KILL_SETTLE_MS}ms after SIGKILL; detached handle released`,
          )
        }
      }

      const output = [stdout, stderr, timeoutLine, killLine].filter(Boolean).join('\n')
      const durationMs = performance.now() - startedAt
      const logPath = join(runRoot, `shard-${plan.index}.log`)
      await Bun.write(logPath, output)
      console.error(
        `[backend ${plan.index}/${plan.count}] FAIL timeout ${durationLabel(durationMs)} log=${logPath}`,
      )
      console.error(outputTail(output))
      return { plan, exitCode: 124, durationMs, output, timedOut: true }
    } catch (error) {
      signalBackendShardProcessTree(child, 'SIGKILL')
      await Promise.all([
        stdoutCapture.cancel('backend shard runner error'),
        stderrCapture.cancel('backend shard runner error'),
      ])
      throw error
    } finally {
      active.delete(child)
    }
  } catch (error) {
    const durationMs = performance.now() - startedAt
    const output = error instanceof Error ? (error.stack ?? error.message) : String(error)
    const logPath = join(runRoot, `shard-${plan.index}.log`)
    await Bun.write(logPath, output)
    console.error(
      `[backend ${plan.index}/${plan.count}] FAIL spawn ${durationLabel(durationMs)} log=${logPath}\n${output}`,
    )
    return { plan, exitCode: 1, durationMs, output, timedOut: false }
  }
}

export async function runBackendShards(): Promise<number> {
  const repoRoot = resolve(import.meta.dir, '..')
  const shardCount = resolveLocalBackendShardCount(process.env.AW_LOCAL_BACKEND_SHARDS)
  const baseSeed = resolveLocalTestSeed(process.env.AW_LOCAL_TEST_SEED)
  const timeoutMs = resolveLocalBackendShardTimeoutMs(process.env.AW_LOCAL_BACKEND_SHARD_TIMEOUT_MS)
  const killGraceMs = resolveLocalBackendShardKillGraceMs(
    process.env.AW_LOCAL_BACKEND_SHARD_KILL_GRACE_MS,
  )
  const runRoot = mkdtempSync(join(tmpdir(), 'agent-workflow-backend-shards-'))
  const plans = buildBackendShardPlans({ runRoot, shardCount, baseSeed })
  const active = new Set<KillableProcess>()
  const interrupts = createBackendShardInterruptController(active, killGraceMs, {
    onEscalate: (reason) => {
      console.error(
        reason === 'second-signal'
          ? '[backend] second interrupt received; sent SIGKILL to active shard process groups'
          : `[backend] interrupt grace expired after ${killGraceMs}ms; sent SIGKILL to active shard process groups`,
      )
    },
  })

  const interrupt = (signal: 'SIGINT' | 'SIGTERM'): void => {
    const first = interrupts.interruptedSignal === undefined
    interrupts.interrupt(signal)
    if (first) {
      console.error(
        `[backend] interrupted by ${signal}; forwarded to active shard process groups; kill-grace=${killGraceMs}ms`,
      )
    }
  }
  const onSigint = () => interrupt('SIGINT')
  const onSigterm = () => interrupt('SIGTERM')
  process.on('SIGINT', onSigint)
  process.on('SIGTERM', onSigterm)

  console.log(
    `[backend] ${shardCount} isolated local shards | base-seed=${baseSeed} | timeout=${timeoutMs}ms | kill-grace=${killGraceMs}ms | temp=${runRoot}`,
  )
  const startedAt = performance.now()
  try {
    const results = await Promise.all(
      plans.map((plan) =>
        runBackendShard(repoRoot, runRoot, plan, { timeoutMs, killGraceMs, active }),
      ),
    )
    const failed = results.filter((result) => result.exitCode !== 0)
    const durationMs = performance.now() - startedAt

    if (interrupts.interruptedSignal !== undefined) {
      console.error(
        `[backend] interrupted by ${interrupts.interruptedSignal}; diagnostics kept at ${runRoot}`,
      )
      return backendShardInterruptExitCode(interrupts.interruptedSignal)
    }
    if (failed.length > 0) {
      console.error(
        `[backend] ${failed.length}/${shardCount} shard(s) failed after ${durationLabel(durationMs)}; diagnostics kept at ${runRoot}`,
      )
      return 1
    }

    console.log(`[backend] all ${shardCount} shards passed in ${durationLabel(durationMs)}`)
    try {
      rmSync(runRoot, { recursive: true, force: true })
    } catch (error) {
      console.warn(`[backend] passed, but temporary cleanup failed: ${String(error)}`)
    }
    return 0
  } finally {
    interrupts.dispose()
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
}

if (import.meta.main) process.exitCode = await runBackendShards()
