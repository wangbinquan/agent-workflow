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
import { secureDir } from '@/util/fs-perms'
import { fromFileUrl } from '@/util/platform'

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
  await mkdir(pluginDir, { recursive: true })
  // RFC-windows PR-2 T9: restrict the plugin install root to the current user.
  // POSIX: chmod 0o700 (was the mkdir `mode`, which some umasks ignore);
  // Windows: icacls (chmod is a no-op there).
  secureDir(pluginDir)
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
  // NOTE: do NOT pass `--no-save`. We rely on npm's default save behaviour
  // (npm 5+) to record the requested package under the host package.json's
  // `dependencies`, which `readInstalledPackage` then uses to identify
  // *which* node_modules entry the user actually asked for. Without that
  // signal we'd have to guess by walking `node_modules/`, which silently
  // picks the wrong package whenever npm flattens transitive deps alongside
  // the requested one (e.g. for `github:…/opencode-toolkit#v0.2.6` we
  // previously surfaced `zod`'s version because readdir returned it first).
  const { stdout, stderr, exitCode } = await runCommand(
    npmBin,
    ['install', '--prefix', pluginDir, '--no-audit', '--no-fund', '--silent', spec],
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
  // RFC-windows PR-2 T7: resolve a file:// spec to a host path cross-platform.
  // `new URL(spec).pathname` returned `/C:/x/y` on Windows; fromFileUrl uses
  // node:url.fileURLToPath which maps `file:///C:/x/y` → `C:\x\y` correctly.
  const raw = fromFileUrl(spec)
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
 * Resolve the package npm just installed at the user's request — by *name*,
 * not by `readdir(node_modules)` order. The authoritative signal is the host
 * `pluginDir/package.json`'s `dependencies`, which `npm install` populates by
 * default (we deliberately omit `--no-save` from the install args). Walking
 * node_modules blindly is unsafe: npm flattens transitive deps next to the
 * requested package, and readdir order is filesystem-dependent — that's how
 * the production bug surfaced `zod` (a transitive dep of `opencode-toolkit`)
 * as the plugin's `resolvedVersion`.
 */
async function readInstalledPackage(
  pluginDir: string,
): Promise<{ entryDir: string; version: string | null }> {
  const nm = join(pluginDir, 'node_modules')
  let requestedName: string | null = null
  try {
    const host = JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf-8'))
    const deps = host?.dependencies
    if (deps !== null && typeof deps === 'object') {
      const keys = Object.keys(deps as Record<string, unknown>)
      // npm install of a single spec writes exactly one direct dep. If we
      // somehow find more than one (host pkg.json hand-edited?), pick the
      // newest by mtime via Object.keys insertion order (npm appends).
      if (keys.length > 0) requestedName = keys[keys.length - 1]!
    }
  } catch {
    // unreadable host package.json — fall through to the partial-install path.
  }

  if (requestedName === null) {
    // No host deps recorded: most likely npm reported success but wrote
    // nothing (broken install), or a future npm version dropped default
    // --save. Either way, picking an arbitrary node_modules entry would
    // mislead the UI/runner, so surface the install as version-less and let
    // opencode fail loudly on import.
    log.warn('plugin install left host package.json without dependencies', { pluginDir })
    return { entryDir: pluginDir, version: null }
  }

  // Scoped name (`@scope/pkg`) joins correctly under node_modules/.
  const pkgRoot = join(nm, requestedName)
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
