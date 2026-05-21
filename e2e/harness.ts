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

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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

export async function startDaemon(opts: SpawnOptions = {}): Promise<DaemonHandle> {
  const binary = opts.binary ?? defaultBinaryPath()
  if (!isExecutableFile(binary)) {
    throw new Error(
      `e2e/harness: binary not found at ${binary}\n` +
        `  Run \`bun run build:binary\` to produce it, or set AGENT_WORKFLOW_E2E_BINARY.`,
    )
  }

  // RFC-054 W1-3 — accept an existing home so the crash-recovery spec can
  // SIGKILL daemon A and spawn daemon B against the same SQLite + worktrees.
  const home = opts.home ?? mkdtempSync(join(tmpdir(), 'aw-e2e-'))
  const keepHome = opts.home !== undefined
  mkdirSync(home, { recursive: true })

  const stubOpencode = opts.stubOpencode ?? resolve(here, 'fixtures', 'stub-opencode.sh')
  if (!isExecutableFile(stubOpencode)) {
    throw new Error(`e2e/harness: stub-opencode not executable: ${stubOpencode}`)
  }

  // Pre-seed config.json so the daemon picks the stub binary on its
  // version-probe path — no PATH gymnastics required.
  const configPath = join(home, 'config.json')
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
        bindPort: 0,
        language: 'en-US',
        theme: 'light',
        logLevel: 'info',
      },
      null,
      2,
    ),
    'utf-8',
  )

  const child: ChildProcessWithoutNullStreams = spawn(
    binary,
    ['start', '--host', '127.0.0.1', '--port', '0'],
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

  // Drain stderr indefinitely so the pipe never fills.
  child.stderr.setEncoding('utf-8')
  child.stderr.on('data', (chunk: string) => {
    if (process.env.E2E_VERBOSE) process.stderr.write(`[daemon stderr] ${chunk}`)
  })
  child.stderr.on('error', () => {
    /* ignore */
  })

  child.stdout.setEncoding('utf-8')

  // Wait for the ready line on stdout.
  //
  // Format:  "agent-workflow ready — open this URL in your browser:"
  //          "  http://<host>:<port>/?token=<token>"
  const ready = await new Promise<{ baseUrl: string; token: string }>((resolveReady, reject) => {
    let buffer = ''
    const timeout = setTimeout(() => {
      cleanup()
      reject(
        new Error(
          `e2e/harness: timed out after 30s waiting for daemon ready line\n` +
            `  stdout so far:\n${buffer}`,
        ),
      )
    }, 30_000)

    const onData = (chunk: string): void => {
      if (process.env.E2E_VERBOSE) process.stdout.write(`[daemon stdout] ${chunk}`)
      buffer += chunk
      const m = buffer.match(/(https?:\/\/[^\s?]+)\?token=([A-Za-z0-9]+)/)
      if (m !== null) {
        cleanup()
        const baseUrl = m[1].replace(/\/$/, '')
        resolveReady({ baseUrl, token: m[2] })
      }
    }
    const onExit = (code: number | null): void => {
      cleanup()
      reject(
        new Error(
          `e2e/harness: daemon exited with code ${code ?? 'null'} before printing ready line\n` +
            `  stdout: ${buffer}`,
        ),
      )
    }
    const cleanup = (): void => {
      clearTimeout(timeout)
      child.stdout.off('data', onData)
      child.off('exit', onExit)
    }
    child.stdout.on('data', onData)
    child.once('exit', onExit)
  })

  // Keep draining stdout so the child never blocks on a full pipe.
  child.stdout.on('data', (chunk: string) => {
    if (process.env.E2E_VERBOSE) process.stdout.write(`[daemon stdout] ${chunk}`)
  })

  const stop = async (): Promise<void> => {
    if (!child.killed && child.exitCode === null) {
      try {
        child.kill('SIGTERM')
      } catch {
        // already dead
      }
    }
    await new Promise<void>((res) => {
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore
        }
        res()
      }, 5_000)
      if (child.exitCode !== null) {
        clearTimeout(t)
        res()
        return
      }
      child.once('exit', () => {
        clearTimeout(t)
        res()
      })
    })
    if (!keepHome) {
      try {
        rmSync(home, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    }
  }

  // RFC-054 W1-3 — direct signal helper for crash-recovery spec. Sends
  // `signal` (default SIGKILL) and waits for `child.exited` to land. After
  // `fallbackTimeoutMs` of no exit, force-SIGKILLs the child so the test
  // doesn't hang. Default 5s suits the SIGKILL case; pass ≥ 35s when
  // sending SIGTERM so the daemon's 30s graceful-shutdown budget can run
  // to completion without being short-circuited.
  const killChild = async (
    signal: NodeJS.Signals = 'SIGKILL',
    fallbackTimeoutMs: number = 5_000,
  ): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      child.kill(signal)
    } catch {
      // already dead
    }
    await new Promise<void>((res) => {
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        res()
      }, fallbackTimeoutMs)
      if (child.exitCode !== null || child.signalCode !== null) {
        clearTimeout(t)
        res()
        return
      }
      child.once('exit', () => {
        clearTimeout(t)
        res()
      })
    })
  }

  return {
    baseUrl: ready.baseUrl,
    token: ready.token,
    home,
    stubOpencode,
    stop,
    killChild,
    keepHome,
  }
}
