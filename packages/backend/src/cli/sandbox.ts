// RFC-216 — `agent-workflow sandbox`: a READ-ONLY sandbox preflight.
//
// It probes the OS sandbox mechanism (reusing RFC-205's probeSandboxMechanism)
// and prints exactly what to install/fix — it NEVER runs a package manager,
// NEVER touches sysctl, NEVER writes a file (config is read via readConfig, the
// no-write variant — loadConfig would materialize ~/.agent-workflow/config.json
// on a fresh box). The only process this command ever spawns is the probe
// itself, wrapped in `boundedSpawn` so a hung/forking mechanism can't wedge or
// leak (design §2/§6). Exit codes are the single truth table in guidance.ts.
//
// Effect boundary (read-only guard, design §6): this file imports no
// node:child_process, uses no Bun.$/execSync/spawnSync/fs-write, and its single
// `Bun.spawn` lives in `boundedSpawn`, which is only ever passed to
// probeSandboxMechanism as its spawnFn.

import { readConfig } from '@/config'
import {
  detectPackageManager,
  renderSandboxReport,
  type PackageManager,
  type ProbeDiagnostics,
  type SandboxMode,
} from '@/services/sandbox/guidance'
import { probeSandboxMechanism, type ProbeSpawnFn } from '@/services/sandbox/probe'
import { killProcessTree } from '@/util/process'
import { Paths } from '@/util/paths'

export interface SandboxCliResult {
  output: string
  exitCode: number
}

const PROBE_TIMEOUT_MS = 10_000
const STDERR_CAP_BYTES = 4096
const STDERR_GRACE_MS = 1_000

const USAGE = [
  'usage: agent-workflow sandbox [--require-available]',
  '',
  '  Read-only sandbox preflight: probes the OS sandbox mechanism and prints how',
  '  to install/fix it. Writes no files; runs no package manager or sysctl.',
  '',
  '  --require-available   exit non-zero unless the sandbox is actually in effect',
  '                        (mode != off AND mechanism available) — for CI/provisioning',
  '  --help, -h            show this help',
].join('\n')

/** Minimal shape of a spawned probe process — the injectable seam for tests. */
export interface SpawnedProbe {
  readonly pid: number | undefined
  readonly stderr: ReadableStream<Uint8Array> | null
  readonly exited: Promise<number>
}
export type RawSpawn = (cmd: string[]) => SpawnedProbe

const defaultRawSpawn: RawSpawn = (cmd) =>
  // The ONLY Bun.spawn in the sandbox CLI. detached → own process group so a
  // timeout / finally can SIGKILL the whole tree (grandchildren included).
  Bun.spawn({
    cmd,
    stdout: 'ignore',
    stderr: 'pipe',
    stdin: 'ignore',
    detached: true,
  }) as unknown as SpawnedProbe

/**
 * Read at most `cap` bytes from a stderr stream, discarding the rest. Streaming
 * (never buffers the whole thing) so a stderr flood from a broken mechanism can
 * not OOM the daemon — the exact P2#1 concern. Resolves on EOF (which the
 * caller's group-SIGKILL guarantees) or stream error.
 */
async function readCappedStderr(
  stream: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<string> {
  if (stream === null) return ''
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined && value.length > 0 && total < cap) {
        const take = Math.min(value.length, cap - total)
        chunks.push(value.subarray(0, take))
        total += take
      }
      // Past the cap we keep draining to EOF but never grow `chunks` → bounded
      // memory even against a multi-MB stderr flood.
    }
  } catch {
    // stream errored — return whatever we captured
  } finally {
    try {
      await reader.cancel()
    } catch {
      /* ignore */
    }
  }
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    buf.set(c, off)
    off += c.length
  }
  return new TextDecoder().decode(buf)
}

/**
 * Wrap the probe spawn with a deadline + whole-lifecycle normalization. Returns
 * a `ProbeSpawnFn` (fed to probeSandboxMechanism, kept byte-identical to RFC-205)
 * plus a getter for the `ProbeDiagnostics` it captured on the side.
 *
 * Every failure — launch throw, `exited` reject, stderr reject, timeout — is
 * caught and normalized to `unavailable` (a sentinel non-zero code) so it can
 * never propagate past the renderer and crash into main's exit 1 (design §2).
 */
export function makeBoundedSpawn(
  rawSpawn: RawSpawn = defaultRawSpawn,
  kill: (pid: number, signal: 'SIGKILL') => void = (pid, sig) => void killProcessTree(pid, sig),
  timeoutMs: number = PROBE_TIMEOUT_MS,
): { spawn: ProbeSpawnFn; getDiag: () => ProbeDiagnostics } {
  let diag: ProbeDiagnostics = { kind: 'error', message: 'probe did not run' }

  const spawn: ProbeSpawnFn = async (cmd) => {
    let proc: SpawnedProbe
    try {
      proc = rawSpawn(cmd)
    } catch (err) {
      // A missing binary makes Bun.spawn THROW (not return 127) — normalize it.
      diag = { kind: 'error', message: (err as Error).message }
      return 127
    }

    const pid = proc.pid
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (typeof pid === 'number') kill(pid, 'SIGKILL')
    }, timeoutMs)

    try {
      // Start reading stderr, but await the EXIT first — a grandchild can hold
      // the pipe open past exit, so binding the return to an unbounded read
      // would re-hang (opencode.ts lesson). The read is memory-capped and
      // grace-bounded below.
      const stderrPromise = readCappedStderr(proc.stderr, STDERR_CAP_BYTES)
      const code = await proc.exited
      if (timedOut) {
        diag = { kind: 'timeout' }
        return 127
      }
      const stderrSnippet = await Promise.race([
        stderrPromise,
        new Promise<string>((r) => setTimeout(() => r(''), STDERR_GRACE_MS)),
      ])
      diag = { kind: 'exit', exitCode: code, stderrSnippet }
      return code
    } catch (err) {
      // `exited`/stderr rejection — normalize to unavailable, never throw out.
      diag = { kind: 'error', message: (err as Error).message }
      return 127
    } finally {
      clearTimeout(timer)
      // Unconditional best-effort group reap: catches a wrapper that forked a
      // background grandchild then exited fast (before the timeout fired). The
      // real exit code was already captured above.
      if (typeof pid === 'number') kill(pid, 'SIGKILL')
    }
  }

  return { spawn, getDiag: () => diag }
}

function parseArgs(
  argv: readonly string[],
): { help: boolean; requireAvailable: boolean } | { error: string } {
  let help = false
  let requireAvailable = false
  for (const a of argv) {
    if (a === '--help' || a === '-h') help = true
    else if (a === '--require-available') requireAvailable = true
    else return { error: `unknown option: ${a}` }
  }
  return { help, requireAvailable }
}

export interface SandboxCommandDeps {
  /** PATH lookup (Bun.which by default). Injected so tests stay hermetic. */
  which?: (bin: string) => string | null | undefined
  /** Probe spawn factory (boundedSpawn by default). */
  boundedSpawn?: ReturnType<typeof makeBoundedSpawn>
  configPath?: string
  platform?: NodeJS.Platform
}

/**
 * `agent-workflow sandbox [--require-available] | --help`.
 * Returns the report + the exit code; main.ts prints and exits with it.
 */
export async function sandboxCommand(
  argv: readonly string[],
  deps: SandboxCommandDeps = {},
): Promise<SandboxCliResult> {
  const parsed = parseArgs(argv)
  if ('error' in parsed) {
    // argv fail-closed: never silently fall back to the default gate (a typo'd
    // --require-available in CI would otherwise exit 0 on an off host).
    return { output: `${parsed.error}\n${USAGE}\n`, exitCode: 2 }
  }
  if (parsed.help) return { output: `${USAGE}\n`, exitCode: 0 }

  const which = deps.which ?? ((bin: string) => Bun.which(bin))
  const has = (bin: string): boolean => {
    const w = which(bin)
    return typeof w === 'string' && w.length > 0
  }
  const platform = deps.platform ?? process.platform
  const configPath = deps.configPath ?? Paths.config

  // Axis 1: configReadable (decision D). readConfig NEVER writes; a corrupt file
  // throws → we keep going (probe the real mechanism) but exit 2, without ever
  // faking `available`.
  let mode: SandboxMode = 'warn'
  let configReadable = true
  let configError: string | undefined
  try {
    const cfg = readConfig(configPath)
    mode = (cfg?.sandboxMode ?? 'warn') as SandboxMode
  } catch (err) {
    configReadable = false
    configError = (err as Error).message
  }

  // Axis 2: mechanismAvailable — real trial run through the bounded spawn.
  const bounded = deps.boundedSpawn ?? makeBoundedSpawn()
  const status = await probeSandboxMechanism(platform, bounded.spawn)
  const diag = bounded.getDiag()

  const bwrapOnPath = platform === 'linux' ? has('bwrap') : false
  const packageManager: PackageManager | null =
    platform === 'linux' && !status.available && !bwrapOnPath ? detectPackageManager(has) : null

  const report = renderSandboxReport({
    platform,
    status,
    diag,
    mode,
    requireAvailable: parsed.requireAvailable,
    bwrapOnPath,
    packageManager,
    configReadable,
    configError,
  })
  return { output: report.text, exitCode: report.exitCode }
}
