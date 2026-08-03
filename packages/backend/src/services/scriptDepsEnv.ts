// RFC-253 §6 — prepared dependency environments.
//
// A script node declares exact package pins; the platform installs them ONCE
// into a content-addressed directory under appHome and mounts that directory
// read-only into every later run that asks for the same set.
//
// Three properties are load-bearing:
//
//   1. **Cache hit costs nothing.** A hit does no network I/O and spawns no
//      process, which is what makes `network: 'deny'` + third-party libraries a
//      usable combination (D15).
//   2. **The installer runs inside containment** and installs only prebuilt
//      artifacts (`--only-binary=:all:` / `--ignore-scripts`), so no package's
//      own build or lifecycle script ever executes (D14). Note the honest
//      limit: the outer sandbox is not a jail — it masks appHome and the
//      crown jewels, it does not confine writes to the build directory
//      (design-gate F4). That is the same posture every agent runs under today.
//   3. **The directory is read-only at run time.** Two nodes sharing an
//      environment must not be able to poison each other's imports, which is a
//      cross-node code-injection channel if left writable (AC-20).

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  normalizeScriptDependencies,
  serializeScriptDepsEnvKeyV1,
  type ScriptLanguage,
} from '@agent-workflow/shared'
import type { Logger } from '@/util/log'
import type { SandboxCtx } from './sandbox'
import { runContainedProcess } from './execution/containedSpawn'

export interface ScriptDepsEnv {
  /** Content hash identifying this environment; recorded on the node_run. */
  hash: string
  /** Directory the interpreter should search (PYTHONPATH / NODE_PATH). */
  libDir: string
  /** Root that gets the read-only mount. */
  rootDir: string
}

interface DepsManifest {
  language: ScriptLanguage
  interpreterPath: string
  interpreterVersion: string
  specs: string[]
  createdAt: number
  lastUsedAt: number
  /** Resolved artifacts, for audit (design-gate P1). */
  resolved?: string[]
}

export function scriptEnvsRoot(appHome: string): string {
  return join(appHome, 'script-envs')
}

function envDirFor(appHome: string, language: ScriptLanguage, hash: string): string {
  return join(scriptEnvsRoot(appHome), language, hash)
}

function manifestPath(rootDir: string): string {
  return join(rootDir, 'manifest.json')
}

function readManifest(rootDir: string): DepsManifest | null {
  try {
    const raw = readFileSync(manifestPath(rootDir), 'utf8')
    const parsed = JSON.parse(raw) as DepsManifest
    return Array.isArray(parsed.specs) ? parsed : null
  } catch {
    return null
  }
}

/**
 * In-process build lock keyed by hash. Two nodes starting the same cold
 * environment concurrently must produce ONE directory, not race each other's
 * partial installs (AC-21). The atomic rename below is the cross-process
 * backstop; this map keeps the common single-daemon case from doing the work
 * twice.
 */
const inFlight = new Map<string, Promise<ScriptDepsEnv>>()

export interface EnsureDepsInput {
  appHome: string
  language: ScriptLanguage
  interpreterPath: string
  interpreterVersion: string
  specs: readonly string[]
  timeoutMs: number
  /** Installer containment. Network is ALLOWED here even when the node denies it. */
  sandbox?: SandboxCtx
  signal?: AbortSignal
  onLine?: (stream: 'stdout' | 'stderr', line: string) => Promise<void> | void
  log?: Logger
}

export class ScriptDepsInstallError extends Error {
  readonly detail: string
  constructor(message: string, detail: string) {
    super(message)
    this.name = 'ScriptDepsInstallError'
    this.detail = detail
  }
}

/**
 * Return the prepared environment for `specs`, building it if absent.
 * Throws `ScriptDepsInstallError` when the build fails.
 */
export async function ensureScriptDepsEnv(input: EnsureDepsInput): Promise<ScriptDepsEnv | null> {
  const specs = normalizeScriptDependencies(input.specs)
  if (specs.length === 0) return null

  const hash = createHash('sha256')
    .update(
      serializeScriptDepsEnvKeyV1({
        language: input.language,
        interpreterPath: input.interpreterPath,
        interpreterVersion: input.interpreterVersion,
        specs,
      }),
    )
    .digest('hex')

  const rootDir = envDirFor(input.appHome, input.language, hash)
  const libDir = join(rootDir, 'lib')

  const existing = readManifest(rootDir)
  if (existing !== null) {
    // Touch so the collector can distinguish "still in use" from "abandoned".
    try {
      writeFileSync(
        manifestPath(rootDir),
        JSON.stringify({ ...existing, lastUsedAt: Date.now() }, null, 2),
        'utf8',
      )
    } catch {
      // A read-only or full disk must not fail an otherwise-usable cache hit.
    }
    return { hash, libDir, rootDir }
  }

  const pending = inFlight.get(hash)
  if (pending !== undefined) return pending

  const build = (async (): Promise<ScriptDepsEnv> => {
    const buildDir = `${rootDir}.build-${process.pid}-${Date.now()}`
    const buildLib = join(buildDir, 'lib')
    mkdirSync(buildLib, { recursive: true })
    mkdirSync(join(buildDir, 'home'), { recursive: true })
    mkdirSync(join(buildDir, 'tmp'), { recursive: true })

    const argv =
      input.language === 'python'
        ? [
            input.interpreterPath,
            '-m',
            'pip',
            'install',
            '--no-input',
            '--disable-pip-version-check',
            // D14: refuse source distributions outright. A source distribution
            // would run the package's own `setup.py` at install time, which is
            // arbitrary code execution during a step the author never sees.
            '--only-binary=:all:',
            '--target',
            buildLib,
            ...specs,
          ]
        : [
            'npm',
            'install',
            // D14: the npm equivalent — no preinstall/postinstall/prepare.
            '--ignore-scripts',
            '--no-audit',
            '--no-fund',
            '--prefix',
            buildDir,
            ...specs,
          ]

    const result = await runContainedProcess({
      argv,
      cwd: buildDir,
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: join(buildDir, 'home'),
        TMPDIR: join(buildDir, 'tmp'),
        LANG: 'C.UTF-8',
      },
      timeoutMs: input.timeoutMs,
      ...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.log === undefined ? {} : { log: input.log }),
      onStdoutLine: (line) => input.onLine?.('stdout', line),
      onStderrLine: (line) => input.onLine?.('stderr', line),
    })

    if (result.outcome !== 'exited' || result.exitCode !== 0) {
      rmSync(buildDir, { recursive: true, force: true })
      const tail = result.stderrTail.slice(-2000)
      // The most common failure by far is "this package has no wheel", and the
      // raw pip message does not explain why the platform refuses it.
      const hint = /no matching distribution|only-binary|could not build/i.test(tail)
        ? ' — the platform installs prebuilt artifacts only and never runs a package build script; pick a release that publishes a wheel'
        : ''
      throw new ScriptDepsInstallError(`dependency install failed${hint}`, tail)
    }

    const manifest: DepsManifest = {
      language: input.language,
      interpreterPath: input.interpreterPath,
      interpreterVersion: input.interpreterVersion,
      specs,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      resolved: specs,
    }
    writeFileSync(manifestPath(buildDir), JSON.stringify(manifest, null, 2), 'utf8')

    mkdirSync(join(scriptEnvsRoot(input.appHome), input.language), { recursive: true })
    try {
      renameSync(buildDir, rootDir)
    } catch {
      // Lost the race to another builder (or another daemon). Their directory
      // is equivalent by construction — same hash, same inputs — so drop ours.
      rmSync(buildDir, { recursive: true, force: true })
      if (!existsSync(manifestPath(rootDir))) {
        throw new ScriptDepsInstallError('dependency environment publish failed', rootDir)
      }
    }
    return { hash, libDir, rootDir }
  })()

  inFlight.set(hash, build)
  try {
    return await build
  } finally {
    inFlight.delete(hash)
  }
}

/**
 * Collect environments unused for longer than `ttlDays`. Called from the
 * daemon's hourly maintenance pass.
 */
export function collectScriptDepsEnvs(input: { appHome: string; ttlDays: number; now?: number }): {
  removed: string[]
} {
  const now = input.now ?? Date.now()
  const cutoff = now - input.ttlDays * 24 * 3_600_000
  const removed: string[] = []
  const root = scriptEnvsRoot(input.appHome)
  if (!existsSync(root)) return { removed }
  for (const language of ['python', 'bash', 'node'] as const) {
    const langDir = join(root, language)
    if (!existsSync(langDir)) continue
    let entries: string[] = []
    try {
      entries = [...new Bun.Glob('*').scanSync({ cwd: langDir, onlyFiles: false })]
    } catch {
      continue
    }
    for (const entry of entries) {
      const dir = join(langDir, entry)
      const manifest = readManifest(dir)
      // A directory without a readable manifest is a failed/partial build —
      // never a live environment, so age it out on the same schedule.
      const lastUsed = manifest?.lastUsedAt ?? 0
      if (lastUsed > cutoff) continue
      try {
        rmSync(dir, { recursive: true, force: true })
        removed.push(dir)
      } catch {
        // Leave it for the next pass.
      }
    }
  }
  return { removed }
}
