// RFC-031 — installer for opencode plugin records.
//
// One installer call materialises a plugin spec into a stable local directory
// `~/.agent-workflow/plugins/{id}/` and returns the resolved entry path the
// runner will inject as `file://<cachedPath>` into OPENCODE_CONFIG_CONTENT.
// The acceptance contract (proposal §5 / design §3.2):
//   1. Eager install on save — POST/PUT triggers this; failure → 422, no DB row.
//   2. Spawn time is zero-network — opencode receives a `file://` path, never
//      the raw npm/git spec.
//   3. Concurrent saves of the same plugin id share a single in-flight install
//      (Map<id, Promise>) to prevent npm-install races on the same directory.
//   4. stderr / error messages are routed through `redactSensitiveString`
//      before they reach API responses, log output, or DB rows.
//   5. `npm` binary discovery is probed once per process; absence downgrades
//      the service to file: spec only.
//
// SourceKind inference mirrors opencode `plugin/shared.ts:isPathPluginSpec`:
//   `file:` / leading `/` / `./` / `../` / windows-drive → file
//   `git+` / `github:` / `gitlab:` / `bitbucket:`         → git
//   everything else                                       → npm

import { spawn } from 'node:child_process'
import { mkdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { PluginSourceKind } from '@agent-workflow/shared'
import { redactSensitiveString } from '@/util/redact'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'

const log = createLogger('plugin-installer')

const DEFAULT_INSTALL_TIMEOUT_MS = 60_000
/** Hard cap on stderr captured into errors / log output. */
const STDERR_CAPTURE_BYTES = 2_048

export interface InstallResult {
  /** Absolute filesystem path of the resolved plugin entry directory. */
  cachedPath: string
  /** npm: package.json.version; git: short sha (if discoverable); file: mtime hash. Null if unreadable. */
  resolvedVersion: string | null
  sourceKind: PluginSourceKind
}

export class PluginInstallFailedError extends Error {
  readonly code = 'plugin-install-failed' as const
  readonly exitCode: number
  readonly stderr: string
  constructor(stderr: string, exitCode: number) {
    super(`plugin install failed (exit ${exitCode})`)
    this.stderr = stderr
    this.exitCode = exitCode
  }
}

export class PluginInstallTimeoutError extends Error {
  readonly code = 'plugin-install-timeout' as const
  constructor(public readonly timeoutMs: number) {
    super(`plugin install exceeded ${timeoutMs}ms`)
  }
}

export class NpmUnavailableError extends Error {
  readonly code = 'npm-unavailable' as const
  constructor() {
    super('npm binary not found in PATH; non-file: plugin specs cannot be installed')
  }
}

export class PluginFileNotFoundError extends Error {
  readonly code = 'plugin-file-not-found' as const
  constructor(public readonly spec: string) {
    super(`plugin file path not found: ${spec}`)
  }
}

/** Classify a user-supplied spec without touching the filesystem. */
export function inferSourceKind(spec: string): PluginSourceKind {
  if (
    spec.startsWith('file:') ||
    spec.startsWith('/') ||
    spec.startsWith('./') ||
    spec.startsWith('../') ||
    /^[A-Za-z]:[\\/]/.test(spec)
  ) {
    return 'file'
  }
  if (
    spec.startsWith('git+') ||
    spec.startsWith('github:') ||
    spec.startsWith('gitlab:') ||
    spec.startsWith('bitbucket:')
  ) {
    return 'git'
  }
  return 'npm'
}

// ─────────────────────────────────────────────────────────────────────────────
// npm binary probe
// ─────────────────────────────────────────────────────────────────────────────

let npmProbeCache: { available: boolean; checkedAt: number } | null = null
const NPM_PROBE_TTL_MS = 5 * 60_000

/** Returns true iff `npm --version` exits cleanly. Cached for 5 min. */
export async function probeNpmBinary(): Promise<boolean> {
  const now = Date.now()
  if (npmProbeCache && now - npmProbeCache.checkedAt < NPM_PROBE_TTL_MS) {
    return npmProbeCache.available
  }
  let available = false
  try {
    const { exitCode } = await runCommand('npm', ['--version'], { timeoutMs: 5_000 })
    available = exitCode === 0
  } catch {
    available = false
  }
  npmProbeCache = { available, checkedAt: now }
  return available
}

/** Test helper: clear the npm probe cache so the next call re-checks. */
export function resetNpmProbeCacheForTests(): void {
  npmProbeCache = null
}

// ─────────────────────────────────────────────────────────────────────────────
// in-flight Map to serialise concurrent installs on the same plugin id
// ─────────────────────────────────────────────────────────────────────────────

const inFlight = new Map<string, Promise<InstallResult>>()

/**
 * Install or refresh a plugin spec into `<rootDir>/<pluginId>/`. Concurrent
 * calls for the same pluginId share the underlying promise.
 *
 * @param pluginId  ULID of the plugin row (caller mints before calling).
 * @param spec      Raw user-supplied spec.
 * @param opts      Optional overrides; tests pass `npmBin`/`pluginsDir`.
 */
export async function installPlugin(
  pluginId: string,
  spec: string,
  opts: {
    pluginsDir?: string
    npmBin?: string
    timeoutMs?: number
  } = {},
): Promise<InstallResult> {
  const existing = inFlight.get(pluginId)
  if (existing) return existing
  const promise = (async () => {
    try {
      return await installPluginInner(pluginId, spec, opts)
    } finally {
      inFlight.delete(pluginId)
    }
  })()
  inFlight.set(pluginId, promise)
  return promise
}

async function installPluginInner(
  pluginId: string,
  spec: string,
  opts: { pluginsDir?: string; npmBin?: string; timeoutMs?: number },
): Promise<InstallResult> {
  const sourceKind = inferSourceKind(spec)
  if (sourceKind === 'file') {
    return installFilePlugin(spec)
  }
  // npm + git both go through `npm install` — npm-package-arg handles git URLs
  // and github shorthand natively (see opencode plugin/shared.ts:resolvePluginTarget).
  const npmBin = opts.npmBin ?? 'npm'
  if (npmBin === 'npm') {
    const ok = await probeNpmBinary()
    if (!ok) throw new NpmUnavailableError()
  }
  const root = opts.pluginsDir ?? Paths.pluginsDir
  const pluginDir = join(root, pluginId)
  await mkdir(pluginDir, { recursive: true, mode: 0o700 })
  // Seed a minimal host package so `npm install` writes node_modules/ here
  // rather than walking up to the user's repo.
  const hostPkg = join(pluginDir, 'package.json')
  await Bun.write(
    hostPkg,
    JSON.stringify(
      {
        name: `aw-plugin-host-${pluginId}`,
        version: '0.0.0',
        private: true,
        dependencies: {},
      },
      null,
      2,
    ),
  )

  const timeoutMs = opts.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS
  const { stdout, stderr, exitCode } = await runCommand(
    npmBin,
    ['install', '--prefix', pluginDir, '--no-audit', '--no-fund', '--no-save', '--silent', spec],
    { timeoutMs },
  )
  if (exitCode !== 0) {
    const tail = redactSensitiveString(stderr || stdout).slice(0, STDERR_CAPTURE_BYTES)
    log.warn('plugin install failed', { pluginId, exitCode, sourceKind })
    throw new PluginInstallFailedError(tail, exitCode)
  }

  // Read node_modules/ to identify the installed package name + version.
  const installed = await readInstalledPackage(pluginDir)
  return {
    cachedPath: installed.entryDir,
    resolvedVersion: installed.version,
    sourceKind,
  }
}

async function installFilePlugin(spec: string): Promise<InstallResult> {
  // Strip file:// prefix if present; everything else is a host path.
  const raw = spec.startsWith('file://') ? new URL(spec).pathname : spec
  let resolved: string
  try {
    resolved = await realpath(raw)
  } catch {
    throw new PluginFileNotFoundError(spec)
  }
  // mtime-based "version" so the UI / DB always has a value; not a semver and
  // intentionally not part of the public API.
  let mtime = 0
  try {
    const st = await stat(resolved)
    mtime = Math.floor(st.mtimeMs)
  } catch {
    // realpath worked but stat failed (race) — fall back to 0
  }
  return {
    cachedPath: resolved,
    resolvedVersion: mtime > 0 ? mtime.toString(16) : null,
    sourceKind: 'file',
  }
}

/**
 * Inspect `pluginDir/node_modules/` to find the single direct dependency
 * we just installed. We pick the only non-hidden top-level entry and read
 * its `package.json`.
 */
async function readInstalledPackage(
  pluginDir: string,
): Promise<{ entryDir: string; version: string | null }> {
  const nm = join(pluginDir, 'node_modules')
  let entries: string[]
  try {
    const dir = await import('node:fs/promises').then((m) => m.readdir(nm))
    entries = dir.filter((n) => !n.startsWith('.'))
  } catch {
    // No node_modules — npm reported success but produced nothing. Treat as
    // partial install: return the plugin dir itself; opencode will then fail
    // on import with a clearer error, and we still have a row to retry.
    return { entryDir: pluginDir, version: null }
  }
  // Scoped packages live under nm/@scope/<pkg>; walk one level when needed.
  let pkgRoot = ''
  if (entries.length === 0) {
    return { entryDir: pluginDir, version: null }
  }
  const first = entries[0]!
  if (first.startsWith('@')) {
    const scopeDir = join(nm, first)
    const sub = await import('node:fs/promises').then((m) => m.readdir(scopeDir))
    const subFiltered = sub.filter((n) => !n.startsWith('.'))
    if (subFiltered.length === 0) return { entryDir: scopeDir, version: null }
    pkgRoot = join(scopeDir, subFiltered[0]!)
  } else {
    pkgRoot = join(nm, first)
  }
  let version: string | null = null
  try {
    const json = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf-8'))
    if (typeof json.version === 'string') version = json.version
  } catch {
    // unreadable package.json — keep null, the row is still valid.
  }
  return { entryDir: pkgRoot, version }
}

// ─────────────────────────────────────────────────────────────────────────────
// update flow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Probe whether a newer version of `spec` is available without overwriting
 * the cached install. Implementation: install into a sibling dir, read the
 * version, compare, then remove. Quick and side-effect-free for the live
 * cache.
 */
export async function checkForUpdate(
  pluginId: string,
  spec: string,
  currentVersion: string | null,
  opts: { pluginsDir?: string; npmBin?: string; timeoutMs?: number } = {},
): Promise<{ available: boolean; latest: string | null }> {
  const root = opts.pluginsDir ?? Paths.pluginsDir
  const probeDir = join(root, `${pluginId}.check-${Date.now().toString(36)}`)
  try {
    const result = await installPluginInner(`${pluginId}.check`, spec, {
      ...opts,
      pluginsDir: probeDir, // installer mkdir's <probeDir>/<pluginId.check>
    })
    const available =
      result.resolvedVersion !== null &&
      currentVersion !== null &&
      result.resolvedVersion !== currentVersion
    return { available, latest: result.resolvedVersion }
  } finally {
    await rm(probeDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Delete the framework-managed install directory for a plugin id. No-op when missing. */
export async function cleanupPluginDir(
  pluginId: string,
  opts: { pluginsDir?: string } = {},
): Promise<void> {
  const root = opts.pluginsDir ?? Paths.pluginsDir
  const pluginDir = join(root, pluginId)
  await rm(pluginDir, { recursive: true, force: true }).catch(() => undefined)
}

// ─────────────────────────────────────────────────────────────────────────────
// child process plumbing
// ─────────────────────────────────────────────────────────────────────────────

interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

function runCommand(
  bin: string,
  args: string[],
  opts: { timeoutMs: number },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    const MAX_CAPTURE = 1024 * 64
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes < MAX_CAPTURE) {
        stdout += chunk.toString('utf-8')
        stdoutBytes += chunk.length
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < MAX_CAPTURE) {
        stderr += chunk.toString('utf-8')
        stderrBytes += chunk.length
      }
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new PluginInstallTimeoutError(opts.timeoutMs))
    }, opts.timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, exitCode: code ?? -1 })
    })
  })
}
