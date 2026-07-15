// Spawn the agent-workflow single binary against a temp $AGENT_WORKFLOW_HOME
// for Playwright e2e (P-5-07).
//
// The binary serves both the API and the embedded frontend on the same
// origin — same shape as production — so the test browser only needs the
// daemon URL + token. No vite dev server, no CORS plumbing.
//
// Local: `bun run build:binary` first, then `bun run e2e`.
// CI:    the `e2e` job downloads the artifact from `build-binary`.
//
// Note: this file runs in Playwright's Node runtime (not Bun), so it uses
// node:child_process rather than Bun.spawn.

import { type ChildProcessByStdio, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { type Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

export interface DaemonHandle {
  /** Base URL printed by the daemon, e.g. http://127.0.0.1:53212 — no trailing token / slash. */
  baseUrl: string
  /** Token the daemon generated on first run, parsed from its ready line. */
  token: string
  /** Temp $AGENT_WORKFLOW_HOME for this session — wipes on teardown unless `keepHome=true`. */
  home: string
  /** Resolved path to the stub-opencode shim. */
  stubOpencode: string
  /** Stop the daemon and (unless `keepHome=true`) remove the temp home. */
  stop: () => Promise<void>
  /**
   * RFC-054 W1-3 — directly send a signal to the daemon child process.
   * Used by crash-recovery.spec.ts to SIGKILL mid-task (vs. the graceful
   * SIGTERM path that `stop()` walks). The promise resolves after the
   * child has actually exited (or after `fallbackTimeoutMs` SIGKILL
   * fallback; default 5s — bump to ≥ 35s when sending SIGTERM so the
   * 30s graceful-shutdown budget can complete).
   */
  killChild: (signal?: NodeJS.Signals, fallbackTimeoutMs?: number) => Promise<void>
  /** True if the home dir was provided externally (don't wipe on stop). */
  keepHome: boolean
}

export interface SpawnOptions {
  /**
   * Path to the agent-workflow binary. Defaults to dist/agent-workflow-<plat>-<arch>.
   * If the file does not exist, harness throws — tell the engineer to build first.
   */
  binary?: string
  /**
   * Override the stub-opencode shim path. Defaults to e2e/fixtures/stub-opencode.sh
   * (the fixed-output stub used by main.spec.ts + review.spec.ts). Tests that
   * need round-driven behaviour (clarify.spec.ts) pass stub-opencode-clarify.sh
   * here.
   */
  stubOpencode?: string
  /**
   * Extra env vars merged into the daemon (and inherited by every opencode
   * subprocess). The clarify e2e uses CLARIFY_STUB_STATE +
   * CLARIFY_STUB_ASK_SHARDS to drive the round-driven stub.
   */
  extraEnv?: Record<string, string>
  /**
   * RFC-054 W1-3 — reuse an existing AGENT_WORKFLOW_HOME directory instead
   * of mkdtemp-ing a fresh one. Required for crash-recovery: kill daemon A,
   * spawn daemon B against the same home so the SQLite db + worktrees are
   * preserved. When set, `stop()` does NOT remove the directory.
   */
  home?: string
}

function platformSuffix(): string {
  const plat = process.platform === 'darwin' ? 'macos' : process.platform
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch
  return `${plat}-${arch}`
}

export function defaultBinaryPath(): string {
  if (process.env.AGENT_WORKFLOW_E2E_BINARY) return process.env.AGENT_WORKFLOW_E2E_BINARY
  return resolve(repoRoot, 'dist', `agent-workflow-${platformSuffix()}`)
}

function isExecutableFile(path: string): boolean {
  try {
    const st = statSync(path)
    return st.isFile()
  } catch {
    return false
  }
}

const DAEMON_START_ATTEMPTS = 3
const STARTUP_KILL_TIMEOUT_MS = 1_000
const CHILD_EXIT_GRACE_MS = 1_000
const READY_TIMEOUT_MS = 30_000
const OUTPUT_TAIL_BYTES = 32 * 1024

type DaemonChild = ChildProcessByStdio<null, Readable, Readable>

function appendOutputTail(current: string, chunk: string): string {
  const next = current + chunk
  return next.length <= OUTPUT_TAIL_BYTES ? next : next.slice(-OUTPUT_TAIL_BYTES)
}

function isPortCollisionError(error: unknown): boolean {
  return error instanceof Error && /EADDRINUSE|address already in use/i.test(error.message)
}

async function signalChildAndWait(
  child: DaemonChild,
  signal: NodeJS.Signals,
  fallbackTimeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return

  await new Promise<void>((resolveExit) => {
    const timers: { fallback?: NodeJS.Timeout; hardStop?: NodeJS.Timeout } = {}
    let settled = false

    const finish = (): void => {
      if (settled) return
      settled = true
      if (timers.fallback !== undefined) clearTimeout(timers.fallback)
      if (timers.hardStop !== undefined) clearTimeout(timers.hardStop)
      child.off('exit', finish)
      resolveExit()
    }

    child.once('exit', finish)
    if (child.exitCode !== null || child.signalCode !== null) {
      finish()
      return
    }

    try {
      child.kill(signal)
    } catch {
      finish()
      return
    }

    if (settled) return
    timers.fallback = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        finish()
        return
      }
      // SIGKILL is asynchronous on Node's ChildProcess API. Wait briefly for
      // the exit event before allowing the caller to remove the child's home.
      timers.hardStop = setTimeout(finish, CHILD_EXIT_GRACE_MS)
    }, fallbackTimeoutMs)
  })
}

function removeOwnedHome(home: string, keepHome: boolean): void {
  if (keepHome) return
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {
    // best-effort; startup/teardown must still report the original failure
  }
}

async function waitForDaemonReady(child: DaemonChild): Promise<{ baseUrl: string; token: string }> {
  child.stderr.setEncoding('utf-8')
  child.stdout.setEncoding('utf-8')

  let stdoutTail = ''
  let stderrTail = ''
  const onStderr = (chunk: string): void => {
    stderrTail = appendOutputTail(stderrTail, chunk)
    if (process.env.E2E_VERBOSE) process.stderr.write(`[daemon stderr] ${chunk}`)
  }
  child.stderr.on('data', onStderr)
  child.stderr.on('error', () => {
    /* ignore */
  })

  return new Promise<{ baseUrl: string; token: string }>((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => {
      cleanup()
      rejectReady(
        new Error(
          `e2e/harness: timed out after ${READY_TIMEOUT_MS / 1_000}s waiting for daemon ready line\n` +
            `  stdout so far:\n${stdoutTail}\n  stderr so far:\n${stderrTail}`,
        ),
      )
    }, READY_TIMEOUT_MS)

    const onData = (chunk: string): void => {
      if (process.env.E2E_VERBOSE) process.stdout.write(`[daemon stdout] ${chunk}`)
      stdoutTail = appendOutputTail(stdoutTail, chunk)
      const match = stdoutTail.match(/(https?:\/\/[^\s?]+)\?token=([A-Za-z0-9]+)/)
      if (match === null) return
      const baseUrl = match[1]
      const token = match[2]
      if (baseUrl === undefined || token === undefined) return
      cleanup()
      resolveReady({ baseUrl: baseUrl.replace(/\/$/, ''), token })
    }
    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup()
      rejectReady(
        new Error(
          `e2e/harness: daemon closed with code ${code ?? 'null'} signal ${signal ?? 'null'} before printing ready line\n` +
            `  stdout: ${stdoutTail}\n  stderr: ${stderrTail}`,
        ),
      )
    }
    const onError = (error: Error): void => {
      cleanup()
      rejectReady(
        new Error(`e2e/harness: failed to spawn daemon: ${error.message}`, { cause: error }),
      )
    }
    const cleanup = (): void => {
      clearTimeout(timeout)
      child.stdout.off('data', onData)
      child.off('close', onClose)
      child.off('error', onError)
    }

    child.stdout.on('data', onData)
    child.once('close', onClose)
    child.once('error', onError)
  })
}

/**
 * Resolve an ephemeral loopback port in the Node parent before spawning the
 * compiled Bun daemon. Bun 1.3.13 on macOS rejects `Bun.serve({ port: 0 })`
 * with EADDRINUSE, so passing zero through the config/CLI makes every browser
 * gate fail before a page opens. The socket is held until the port is known and
 * then closed immediately before spawn; each isolated daemon still receives a
 * fresh OS-selected port.
 */
async function allocateLoopbackPort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    probe.once('error', rejectListen)
    probe.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolveListen)
  })
  const address = probe.address()
  const port = typeof address === 'object' && address !== null ? address.port : null
  await new Promise<void>((resolveClose, rejectClose) => {
    probe.close((error) => (error === undefined ? resolveClose() : rejectClose(error)))
  })
  if (port === null) throw new Error('e2e/harness: failed to allocate a loopback port')
  return port
}

type PortAllocator = () => Promise<number>

async function startDaemonWithPortAllocator(
  opts: SpawnOptions,
  portAllocator: PortAllocator,
): Promise<DaemonHandle> {
  const binary = opts.binary ?? defaultBinaryPath()
  if (!isExecutableFile(binary)) {
    throw new Error(
      `e2e/harness: binary not found at ${binary}\n` +
        `  Run \`bun run build:binary\` to produce it, or set AGENT_WORKFLOW_E2E_BINARY.`,
    )
  }

  const stubOpencode = opts.stubOpencode ?? resolve(here, 'fixtures', 'stub-opencode.sh')
  if (!isExecutableFile(stubOpencode)) {
    throw new Error(`e2e/harness: stub-opencode not executable: ${stubOpencode}`)
  }

  // RFC-054 W1-3 — accept an existing home so the crash-recovery spec can
  // SIGKILL daemon A and spawn daemon B against the same SQLite + worktrees.
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'aw-e2e-'))
  const keepHome = opts.home !== undefined
  let child: DaemonChild | undefined

  try {
    mkdirSync(home, { recursive: true })
    const configPath = join(home, 'config.json')

    for (let attempt = 1; attempt <= DAEMON_START_ATTEMPTS; attempt += 1) {
      const bindPort = await portAllocator()

      // Pre-seed config.json so the daemon picks the stub binary on its
      // version-probe path — no PATH gymnastics required. Re-write it on each
      // retry because a port may be claimed after the probe socket is closed.
      writeFileSync(
        configPath,
        JSON.stringify(
          {
            $schema_version: 1,
            opencodePath: stubOpencode,
            maxConcurrentNodes: 4,
            multiProcessSubprocessConcurrency: 4,
            defaultPerTaskMaxDurationMs: 60 * 60 * 1000,
            defaultPerTaskMaxTotalTokens: 0,
            defaultPerNodeTimeoutMs: 30 * 60 * 1000,
            worktreeAutoGc: { enabled: false },
            eventsArchiveThresholds: { perNodeRunRows: 50_000, globalRows: 1_000_000 },
            largeOutputThresholdBytes: 1_048_576,
            bindHost: '127.0.0.1',
            bindPort,
            language: 'en-US',
            theme: 'light',
            logLevel: 'info',
          },
          null,
          2,
        ),
        'utf-8',
      )

      const attemptChild: DaemonChild = spawn(
        binary,
        ['start', '--host', '127.0.0.1', '--port', String(bindPort)],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            AGENT_WORKFLOW_HOME: home,
            LANG: 'en_US.UTF-8',
            ...(opts.extraEnv ?? {}),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      child = attemptChild

      try {
        const ready = await waitForDaemonReady(attemptChild)

        // Keep draining stdout so the child never blocks on a full pipe.
        attemptChild.stdout.on('data', (chunk: string) => {
          if (process.env.E2E_VERBOSE) process.stdout.write(`[daemon stdout] ${chunk}`)
        })

        const startedChild = attemptChild
        const stop = async (): Promise<void> => {
          await signalChildAndWait(startedChild, 'SIGTERM', 5_000)
          removeOwnedHome(home, keepHome)
        }

        // RFC-054 W1-3 — direct signal helper for crash-recovery spec. Sends
        // `signal` (default SIGKILL) and waits for the child to exit. Pass
        // ≥ 35s with SIGTERM when the daemon's 30s graceful budget must run.
        const killChild = async (
          signal: NodeJS.Signals = 'SIGKILL',
          fallbackTimeoutMs: number = 5_000,
        ): Promise<void> => signalChildAndWait(startedChild, signal, fallbackTimeoutMs)

        return {
          baseUrl: ready.baseUrl,
          token: ready.token,
          home,
          stubOpencode,
          stop,
          killChild,
          keepHome,
        }
      } catch (error) {
        await signalChildAndWait(attemptChild, 'SIGKILL', STARTUP_KILL_TIMEOUT_MS)
        child = undefined
        if (attempt < DAEMON_START_ATTEMPTS && isPortCollisionError(error)) continue
        throw error
      }
    }

    throw new Error(`e2e/harness: exhausted ${DAEMON_START_ATTEMPTS} daemon start attempts`)
  } catch (error) {
    if (child !== undefined) {
      await signalChildAndWait(child, 'SIGKILL', STARTUP_KILL_TIMEOUT_MS)
    }
    removeOwnedHome(home, keepHome)
    throw error
  }
}

export async function startDaemon(opts: SpawnOptions = {}): Promise<DaemonHandle> {
  return startDaemonWithPortAllocator(opts, allocateLoopbackPort)
}

/** Test-only seam: lifecycle tests inject deterministic ports without binding sockets. */
export const harnessTestApi = {
  startDaemonWithPortAllocator,
}
