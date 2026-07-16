// RFC-031 — installer for opencode plugin records.
//
// Every npm/git installer call materialises into a fresh immutable generation
// under `~/.agent-workflow/plugins/{id}/generations/{opId}/`. The DB continues
// pointing at the prior complete generation until the caller atomically
// publishes the new cachedPath. file: specs remain external paths and are not
// advertised as atomically checkable/upgradable.
// The acceptance contract (proposal §5 / design §3.2):
//   1. Eager install on save — POST/PUT triggers this; failure → 422, no DB row.
//   2. Spawn time is zero-network — opencode receives a `file://` path, never
//      the raw npm/git spec.
//   3. The stable-id ResourceOperationCoordinator serialises publication; the
//      installer itself never shares mutable directories or in-flight results.
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
import type { Dirent } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import type { PluginSourceKind } from '@agent-workflow/shared'
import { ulid } from 'ulid'
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
  /** null for external file: sources. */
  generationDir: string | null
  /** Stable immutable source identity; null only for external file: sources. */
  sourceIdentity: string | null
  manifest: PluginGenerationManifest | null
}

export const PLUGIN_GENERATION_MANIFEST = '.agent-workflow-plugin-generation.json'

export interface PluginGenerationManifest {
  version: 1
  pluginId: string
  opId: string
  sourceKind: 'npm' | 'git'
  requestedSpec: string
  entryRelativePath: string
  resolvedVersion: string | null
  sourceIdentity: string
  resolved: string
  integrity: string | null
  commit: string | null
  completed: true
  createdAt: number
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

/**
 * Prepare an immutable install generation. Publication is a separate DB step.
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
  const sourceKind = inferSourceKind(spec)
  if (sourceKind === 'file') return installFilePlugin(spec)
  return installPluginGeneration(pluginId, ulid(), spec, sourceKind, opts)
}

async function installPluginGeneration(
  pluginId: string,
  opId: string,
  spec: string,
  sourceKind: 'npm' | 'git',
  opts: { pluginsDir?: string; npmBin?: string; timeoutMs?: number },
): Promise<InstallResult> {
  // npm + git both go through `npm install` — npm-package-arg handles git URLs
  // and github shorthand natively (see opencode plugin/shared.ts:resolvePluginTarget).
  const npmBin = opts.npmBin ?? 'npm'
  if (npmBin === 'npm') {
    const ok = await probeNpmBinary()
    if (!ok) throw new NpmUnavailableError()
  }
  const root = opts.pluginsDir ?? Paths.pluginsDir
  const generationsDir = join(root, pluginId, 'generations')
  await mkdir(generationsDir, { recursive: true, mode: 0o700 })
  const pluginDir = join(generationsDir, opId)
  await mkdir(pluginDir, { recursive: false, mode: 0o700 })
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
  if (sourceKind === 'npm' && installed.version === null) {
    throw new PluginInstallFailedError('installed npm package has no readable version', 0)
  }
  const identity = await readInstalledIdentity(pluginDir, installed.packageName, sourceKind)
  await stat(installed.entryDir)
  const resolvedVersion = sourceKind === 'git' ? identity.commit!.slice(0, 12) : installed.version
  const manifest: PluginGenerationManifest = {
    version: 1,
    pluginId,
    opId,
    sourceKind,
    requestedSpec: spec,
    entryRelativePath: relative(pluginDir, installed.entryDir),
    resolvedVersion,
    sourceIdentity: identity.sourceIdentity,
    resolved: identity.resolved,
    integrity: identity.integrity,
    commit: identity.commit,
    completed: true,
    createdAt: Date.now(),
  }
  const manifestPath = join(pluginDir, PLUGIN_GENERATION_MANIFEST)
  const tmpManifest = `${manifestPath}.${ulid()}.tmp`
  await Bun.write(tmpManifest, JSON.stringify(manifest, null, 2))
  await rename(tmpManifest, manifestPath)
  return {
    cachedPath: installed.entryDir,
    resolvedVersion,
    sourceKind,
    generationDir: pluginDir,
    sourceIdentity: identity.sourceIdentity,
    manifest,
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
    generationDir: null,
    sourceIdentity: null,
    manifest: null,
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
): Promise<{ entryDir: string; packageName: string; version: string | null }> {
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
    throw new PluginInstallFailedError('installed package identity is missing', 0)
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
  return { entryDir: pkgRoot, packageName: requestedName, version }
}

async function readInstalledIdentity(
  pluginDir: string,
  packageName: string,
  sourceKind: 'npm' | 'git',
): Promise<{
  sourceIdentity: string
  resolved: string
  integrity: string | null
  commit: string | null
}> {
  let lock: unknown
  try {
    lock = JSON.parse(await readFile(join(pluginDir, 'package-lock.json'), 'utf-8'))
  } catch {
    throw new PluginInstallFailedError('npm install did not produce package-lock identity', 0)
  }
  const packages = (lock as { packages?: unknown }).packages
  const entry =
    packages !== null && typeof packages === 'object'
      ? (packages as Record<string, unknown>)[`node_modules/${packageName}`]
      : undefined
  if (entry === null || typeof entry !== 'object') {
    throw new PluginInstallFailedError('installed package is missing from package-lock', 0)
  }
  const record = entry as Record<string, unknown>
  const resolved = typeof record.resolved === 'string' ? record.resolved : ''
  const integrity = typeof record.integrity === 'string' ? record.integrity : null
  if (sourceKind === 'npm') {
    if (resolved === '' || integrity === null) {
      throw new PluginInstallFailedError('npm package-lock identity is incomplete', 0)
    }
    return {
      sourceIdentity: `npm:${resolved}\n${integrity}`,
      resolved,
      integrity,
      commit: null,
    }
  }
  const gitHead = typeof record.gitHead === 'string' ? record.gitHead : ''
  const commit =
    (/^[a-f0-9]{40}$/i.exec(gitHead)?.[0] ?? /[#/]([a-f0-9]{40})(?:$|\?)/i.exec(resolved)?.[1]) ||
    null
  if (commit === null) {
    throw new PluginInstallFailedError('git package-lock identity has no final commit SHA', 0)
  }
  return {
    sourceIdentity: `git:${commit.toLowerCase()}`,
    resolved,
    integrity,
    commit: commit.toLowerCase(),
  }
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
  currentCachedPath: string,
  opts: { pluginsDir?: string; npmBin?: string; timeoutMs?: number } = {},
): Promise<{ available: boolean; latest: string | null; identityStatus: 'known' | 'unknown' }> {
  const sourceKind = inferSourceKind(spec)
  if (sourceKind === 'file') {
    throw new PluginInstallFailedError('file source is externally managed and cannot be checked', 0)
  }
  const root = opts.pluginsDir ?? Paths.pluginsDir
  await mkdir(root, { recursive: true, mode: 0o700 })
  const probeDir = await mkdtemp(join(root, '.check-'))
  try {
    const result = await installPluginGeneration(pluginId, ulid(), spec, sourceKind, {
      ...opts,
      pluginsDir: probeDir,
    })
    const current = await readGenerationManifestForCachedPath(currentCachedPath)
    if (
      current === null ||
      current.pluginId !== pluginId ||
      current.sourceKind !== sourceKind ||
      current.requestedSpec !== spec
    ) {
      return { available: false, latest: result.resolvedVersion, identityStatus: 'unknown' }
    }
    return {
      available: current.sourceIdentity !== result.sourceIdentity,
      latest: result.resolvedVersion,
      identityStatus: 'known',
    }
  } finally {
    await rm(probeDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

export async function readGenerationManifestForCachedPath(
  cachedPath: string,
): Promise<PluginGenerationManifest | null> {
  let cursor = cachedPath
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const parsed = JSON.parse(
        await readFile(join(cursor, PLUGIN_GENERATION_MANIFEST), 'utf-8'),
      ) as Partial<PluginGenerationManifest>
      if (!isCompleteGenerationManifest(parsed, cursor, cachedPath)) return null
      return parsed
    } catch {
      const parent = dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
  }
  return null
}

function isCompleteGenerationManifest(
  parsed: Partial<PluginGenerationManifest>,
  generationDir: string,
  cachedPath: string,
): parsed is PluginGenerationManifest {
  if (
    parsed.version !== 1 ||
    parsed.completed !== true ||
    typeof parsed.pluginId !== 'string' ||
    parsed.pluginId.length === 0 ||
    typeof parsed.opId !== 'string' ||
    parsed.opId.length === 0 ||
    (parsed.sourceKind !== 'npm' && parsed.sourceKind !== 'git') ||
    typeof parsed.requestedSpec !== 'string' ||
    parsed.requestedSpec.length === 0 ||
    typeof parsed.entryRelativePath !== 'string' ||
    parsed.entryRelativePath.length === 0 ||
    isAbsolute(parsed.entryRelativePath) ||
    parsed.entryRelativePath === '..' ||
    parsed.entryRelativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    (parsed.resolvedVersion !== null && typeof parsed.resolvedVersion !== 'string') ||
    typeof parsed.sourceIdentity !== 'string' ||
    parsed.sourceIdentity.length === 0 ||
    typeof parsed.resolved !== 'string' ||
    parsed.resolved.length === 0 ||
    (parsed.integrity !== null && typeof parsed.integrity !== 'string') ||
    (parsed.commit !== null && typeof parsed.commit !== 'string') ||
    !Number.isInteger(parsed.createdAt)
  ) {
    return false
  }
  if (
    resolvePath(generationDir, parsed.entryRelativePath) !== resolvePath(cachedPath) ||
    (parsed.sourceKind === 'npm' &&
      (parsed.integrity === null ||
        parsed.commit !== null ||
        parsed.sourceIdentity !== `npm:${parsed.resolved}\n${parsed.integrity}`)) ||
    (parsed.sourceKind === 'git' &&
      (parsed.commit === null ||
        !/^[a-f0-9]{40}$/i.test(parsed.commit) ||
        parsed.sourceIdentity !== `git:${parsed.commit.toLowerCase()}`))
  ) {
    return false
  }
  return true
}

export async function cleanupInstallGeneration(result: InstallResult): Promise<void> {
  if (result.generationDir === null) return
  await rm(result.generationDir, { recursive: true, force: true }).catch(() => undefined)
}

/** Conservative orphan/old-generation collection. Unknown/active paths stay. */
export async function garbageCollectPluginGenerations(opts: {
  pluginsDir?: string
  referencedCachedPaths: ReadonlySet<string>
  activeCachedPaths?: ReadonlySet<string>
  graceMs?: number
  now?: number
}): Promise<string[]> {
  const root = opts.pluginsDir ?? Paths.pluginsDir
  const active = opts.activeCachedPaths ?? new Set<string>()
  const graceMs = opts.graceMs ?? 24 * 60 * 60_000
  const now = opts.now ?? Date.now()
  const removed: string[] = []
  let pluginDirs: Dirent[]
  try {
    pluginDirs = await readdir(root, { withFileTypes: true })
  } catch {
    return removed
  }
  for (const pluginDirent of pluginDirs) {
    if (!pluginDirent.isDirectory()) continue
    if (pluginDirent.name.startsWith('.check-')) {
      const checkDir = join(root, pluginDirent.name)
      try {
        if (now - (await stat(checkDir)).mtimeMs >= graceMs) {
          await rm(checkDir, { recursive: true, force: true })
          removed.push(checkDir)
        }
      } catch {
        // Conservative best effort: an unreadable or concurrently-removed dir stays.
      }
      continue
    }
    const generationsRoot = join(root, pluginDirent.name, 'generations')
    let generations: Dirent[]
    try {
      generations = await readdir(generationsRoot, { withFileTypes: true })
    } catch {
      continue
    }
    for (const generation of generations) {
      if (!generation.isDirectory()) continue
      const generationDir = join(generationsRoot, generation.name)
      const isReferenced = [...opts.referencedCachedPaths, ...active].some(
        (path) => path === generationDir || path.startsWith(`${generationDir}/`),
      )
      if (isReferenced) continue
      let age = 0
      try {
        age = now - (await stat(generationDir)).mtimeMs
      } catch {
        continue
      }
      if (age < graceMs) continue
      try {
        await rm(generationDir, { recursive: true, force: true })
        removed.push(generationDir)
      } catch {
        // Conservative best effort: failed deletions are not reported as removed.
      }
    }
  }
  return removed
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
