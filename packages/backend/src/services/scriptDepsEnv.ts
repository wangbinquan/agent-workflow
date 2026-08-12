// RFC-253 §6 — prepared dependency environments.
//
// A script node declares exact package pins; the platform installs them once
// into a content-addressed directory under appHome and reuses that directory.
//
// Three properties are load-bearing:
//
// A cache hit performs no install and spawns no process. Install commands keep
// deterministic artifact settings (`--only-binary=:all:` / `--ignore-scripts`)
// and run as ordinary managed child processes.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  normalizeScriptDependencies,
  serializeScriptDepsEnvKeyV1,
  type ScriptLanguage,
} from '@agent-workflow/shared'
import type { Logger } from '@/util/log'
import { runManagedProcess } from './execution/managedProcess'
import { sha256Hex } from '@/util/hash'

export interface ScriptDepsEnv {
  /** Content hash identifying this environment; recorded on the node_run. */
  hash: string
  /** Directory the interpreter should search (PYTHONPATH / NODE_PATH). */
  libDir: string
  /** Root of the reusable dependency environment. */
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

  const hash = sha256Hex(
    serializeScriptDepsEnvKeyV1({
      language: input.language,
      interpreterPath: input.interpreterPath,
      interpreterVersion: input.interpreterVersion,
      specs,
    }),
  )

  const rootDir = envDirFor(input.appHome, input.language, hash)
  // impl-gate 4.2: the search path is per package manager. `pip --target lib`
  // puts packages directly in `lib/`, while `npm --prefix <dir>` writes
  // `<dir>/node_modules` — pointing NODE_PATH at `lib/` gave every node script
  // an empty search path, so `language: 'node'` + dependencies never worked.
  const libDir = join(rootDir, input.language === 'node' ? 'node_modules' : 'lib')

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

    const result = await runManagedProcess({
      argv,
      cwd: buildDir,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => {
            return typeof entry[1] === 'string'
          }),
        ),
        PWD: buildDir,
      },
      timeoutMs: input.timeoutMs,
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
 * Collect environments unused for longer than `ttlDays`.
 *
 * ⚠ HONEST STATUS (impl-gate M6, 2026-08-04): this previously said "called from
 * the daemon's hourly maintenance pass". It is not called from anywhere — the
 * cache currently grows without bound. Wiring it up must also teach it to skip
 * in-flight `.build-*` directories, which have no manifest and would therefore
 * be collected immediately, deleting a running install out from under itself.
 * Tracked as plan.md T25 / docs/audit-backlog.md.
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
