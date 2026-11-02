import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { command, REPO_ROOT, sha256, writeJson } from './io'
import { executableName, nativePlatform } from './model'
import type { Platform, ReleaseEntry } from './model'

export interface BinaryEvidence {
  path: string
  tag: string
  commit: string
  platform: Platform
  kind: 'release-asset' | 'retained-asset' | 'tag-build' | 'workflow-artifact' | 'local-candidate'
  evidenceLevel: 1 | 2 | 3 | 4
  sha256: string
  /** Fallback bytes are measured locally, never represented as release-authenticated. */
  verification: 'registry-sha256' | 'local-build-sha256' | 'candidate-sha256'
  fallbackReason?: string
}
export interface ResolveBinaryOptions {
  platform?: Platform
  cacheDir?: string
  repository?: string
  allowTagBuild?: boolean
  bunExecutable?: string
}
export const DEFAULT_CACHE = join(tmpdir(), 'agent-workflow-release-upgrade')

/** Candidates are measured independently; never claim they are published release bytes. */
export function candidateBinary(
  path: string,
  commit: string,
  expectedSha256?: string,
): BinaryEvidence {
  path = resolve(path)
  const digest = sha256(readFileSync(path)) // Missing artifacts are an error, including negative controls.
  if (expectedSha256) verifyBinary(path, expectedSha256)
  chmodSync(path, 0o755)
  return {
    path,
    tag: 'candidate',
    commit,
    platform: nativePlatform(),
    kind: process.env.GITHUB_ACTIONS === 'true' ? 'workflow-artifact' : 'local-candidate',
    evidenceLevel: process.env.GITHUB_ACTIONS === 'true' ? 3 : 4,
    sha256: digest,
    verification: 'candidate-sha256',
  }
}

export function verifyBinary(path: string, expected: string): void {
  const actual = sha256(readFileSync(path))
  if (actual !== expected)
    throw new Error(`Binary SHA-256 mismatch at ${path}: expected ${expected}, got ${actual}`)
}

async function exactBun(version: string, cache: string, supplied?: string): Promise<string> {
  const validate = async (path: string) => {
    const actual = (await command([path, '--version'], { label: 'Bun version probe' }))
      .toString()
      .trim()
    if (actual !== version)
      throw new Error(`Tag declares Bun ${version}; ${path} reports ${actual}`)
    return path
  }
  if (supplied) return validate(supplied)
  if (Bun.version === version) return process.execPath
  const os =
    process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux'
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64'
  const name = `bun-${os}-${arch}`
  const directory = join(cache, 'bun', version)
  const executable = join(directory, name, process.platform === 'win32' ? 'bun.exe' : 'bun')
  if (!existsSync(executable)) {
    mkdirSync(directory, { recursive: true })
    const zip = join(directory, `${name}.zip`)
    await command([
      'gh',
      'release',
      'download',
      `bun-v${version}`,
      '--repo',
      'oven-sh/bun',
      '--pattern',
      `${name}.zip`,
      '--output',
      zip,
      '--clobber',
    ])
    if (process.platform === 'win32') {
      // Arguments are environment values, not interpolated PowerShell code.
      await command(
        [
          'powershell.exe',
          '-NoProfile',
          '-Command',
          'Expand-Archive -LiteralPath $env:AW_BUN_ARCHIVE -DestinationPath $env:AW_BUN_DEST -Force',
        ],
        { env: { ...process.env, AW_BUN_ARCHIVE: zip, AW_BUN_DEST: directory } },
      )
    } else await command(['unzip', '-o', '-q', zip, '-d', directory])
    chmodSync(executable, 0o755)
  }
  return validate(executable)
}

/**
 * The tag's committed bytes as a tar stream. `git archive` applies working-tree conversion, so tags
 * without an eol rule (before RFC-254's `.gitattributes`: v0.1.0 to v0.16.x) would arrive with CRLF
 * under the Windows runner's `core.autocrlf=true`. A historical build starts from the tagged bytes.
 * (Bun itself accepts a CRLF `bun.lock`; line endings did not cause the Windows frozen-install
 * refusals, see `explainLockfileRefusal`.)
 */
export async function tagSourceArchive(tag: string, cwd?: string): Promise<Buffer> {
  return command(
    ['git', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', tag],
    { cwd },
  )
}

/**
 * Lines a regenerated lockfile dropped (`-`) and added (`+`), matched as multisets in file order.
 * Lines are JSON-quoted so carriage returns and other invisible bytes stay visible.
 */
export function lockfileDrift(tagLockfile: string, regenerated: string, limit = 40): string[] {
  const unmatched = (sign: '-' | '+', text: string, other: string) => {
    const remaining = new Map<string, number>()
    for (const line of other.split('\n')) remaining.set(line, (remaining.get(line) ?? 0) + 1)
    const lines: string[] = []
    for (const line of text.split('\n')) {
      const left = remaining.get(line) ?? 0
      if (left > 0) remaining.set(line, left - 1)
      else lines.push(`${sign} ${JSON.stringify(line)}`)
    }
    return lines
  }
  const removed = unmatched('-', tagLockfile, regenerated)
  const added = unmatched('+', regenerated, tagLockfile)
  if (removed.length === 0 && added.length === 0)
    return ['lockfile drift: none (the regenerated lockfile has the same lines as the tag)']
  const capped = (lines: string[]) =>
    lines.length > limit ? [...lines.slice(0, limit), `  … ${lines.length - limit} more`] : lines
  return [
    `lockfile drift (tag → regenerated): ${removed.length} removed, ${added.length} added`,
    ...capped(removed),
    ...capped(added),
  ]
}

/**
 * Names what a frozen install refused instead of leaving it to guesswork: regenerate `bun.lock` in
 * the disposable build directory and report the drift. Release-upgrade nightly 41303628365 blamed
 * CRLF for the Windows refusals of v0.1.0 / v0.10.0 / v0.16.3, and nightly 41363751171 refused the
 * LF archives just the same. The probe never masks the original failure.
 */
export async function explainLockfileRefusal(
  cwd: string,
  regenerate: () => Promise<unknown>,
): Promise<string> {
  const lockfile = join(cwd, 'bun.lock')
  try {
    const before = readFileSync(lockfile, 'utf8')
    await regenerate()
    const drift = lockfileDrift(before, readFileSync(lockfile, 'utf8'))
    return `\nbuild directory: ${cwd}\n${drift.join('\n')}`
  } catch (error) {
    return `\nbuild directory: ${cwd}\nlockfile drift probe failed: ${String(error).slice(0, 4_000)}`
  }
}

async function buildTag(
  release: ReleaseEntry,
  options: ResolveBinaryOptions,
  reason: string,
): Promise<BinaryEvidence> {
  const platform = options.platform ?? nativePlatform()
  if (platform !== nativePlatform())
    throw new Error('tag-build must run on the requested native platform')
  const cache = options.cacheDir ?? DEFAULT_CACHE
  const buildDir = join(cache, 'tag-build', release.commit, platform, release.bunVersion)
  const path = join(buildDir, executableName(platform))
  const evidenceFile = join(buildDir, 'evidence.json')
  if (existsSync(evidenceFile) && existsSync(path)) {
    const evidence = JSON.parse(readFileSync(evidenceFile, 'utf8')) as BinaryEvidence
    if (evidence.commit !== release.commit || evidence.kind !== 'tag-build')
      throw new Error('Tag-build cache identity mismatch')
    verifyBinary(path, evidence.sha256)
    return { ...evidence, path, fallbackReason: reason }
  }
  mkdirSync(buildDir, { recursive: true })
  const bun = await exactBun(release.fallback.bunVersion, cache, options.bunExecutable)
  const actualCommit = (await command(['git', 'rev-parse', `${release.tag}^{commit}`]))
    .toString()
    .trim()
  if (actualCommit !== release.commit)
    throw new Error(`Tag ${release.tag} no longer resolves to registered commit`)
  // GitHub's windows-latest `os.tmpdir()` is the 8.3 short name `C:\Users\RUNNER~1\…`
  // (docs/dev-gotchas.md); build under the long name so no tool sees two spellings of one
  // directory. Everywhere else this only resolves symlinks (macOS `/var` → `/private/var`).
  const scratch = mkdtempSync(join(realpathSync.native(buildDir), 'archive-'))
  try {
    const archive = await tagSourceArchive(release.tag)
    // Extract in the archive directory instead of passing it to `-C`: under the Windows runner's
    // Git Bash, `tar` is MSYS GNU tar, which cannot use a native `C:\…` path there ("Cannot
    // open: No such file or directory", release-upgrade nightly 41287876705).
    await command(['tar', '-xf', '-'], { input: archive, cwd: scratch })
    // No .git directory, branch, clone or worktree is created. Source writes made
    // by historical build scripts stay inside this disposable archive directory.
    const env = {
      ...process.env,
      PATH: `${dirname(bun)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
    }
    try {
      await command([bun, 'install', '--frozen-lockfile'], {
        cwd: scratch,
        env,
        timeoutMs: 900_000,
        label: `${release.tag} dependency install`,
      })
    } catch (error) {
      if (!String(error).includes('lockfile had changes')) throw error
      const drift = await explainLockfileRefusal(scratch, () =>
        command([bun, 'install', '--lockfile-only', '--ignore-scripts'], {
          cwd: scratch,
          env,
          timeoutMs: 900_000,
          label: `${release.tag} lockfile drift probe`,
        }),
      )
      throw new Error(`${error instanceof Error ? error.message : String(error)}${drift}`)
    }
    await command([bun, 'run', 'build:binary'], {
      cwd: scratch,
      env,
      timeoutMs: 1_800_000,
      label: `${release.tag} tag-build`,
    })
    let output = join(scratch, 'dist', executableName(platform))
    if (!existsSync(output) && platform === 'windows-x86_64') {
      // Pre-Windows releases named native builds win32-x86_64 (Bun may append
      // .exe). Preserve their exact source/build; only normalize the cache name.
      const historical = readdirSync(join(scratch, 'dist')).filter((name) =>
        /^agent-workflow-win32-x86_64(?:\.exe)?$/.test(name),
      )
      if (historical.length !== 1)
        throw new Error(
          `${release.tag}: native Windows tag-build produced no unambiguous executable`,
        )
      output = join(scratch, 'dist', historical[0]!)
    }
    const bytes = readFileSync(output)
    writeFileSync(path, bytes, { mode: 0o755 })
    const evidence: BinaryEvidence = {
      path,
      tag: release.tag,
      commit: release.commit,
      platform,
      kind: 'tag-build',
      evidenceLevel: 4,
      sha256: sha256(bytes),
      verification: 'local-build-sha256',
      fallbackReason: reason,
    }
    writeJson(evidenceFile, evidence)
    return evidence
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export async function resolveBinary(
  release: ReleaseEntry,
  options: ResolveBinaryOptions = {},
): Promise<BinaryEvidence> {
  const platform = options.platform ?? nativePlatform()
  const source = release.binaries[platform]
  const fallback = (reason: string) => {
    if (options.allowTagBuild === false) throw new Error(reason)
    return buildTag(release, options, reason)
  }
  if (!source) return fallback(`${release.tag} has no ${platform} release asset`)
  const directory = join(options.cacheDir ?? DEFAULT_CACHE, 'binaries', platform, source.sha256)
  const path = join(directory, executableName(platform))
  if (!existsSync(path)) {
    mkdirSync(directory, { recursive: true })
    const temporary = join(mkdtempSync(join(directory, 'download-')), executableName(platform))
    try {
      try {
        await command(
          [
            'gh',
            'release',
            'download',
            source.release,
            '--repo',
            options.repository ?? 'wangbinquan/agent-workflow',
            '--pattern',
            source.asset,
            '--output',
            temporary,
          ],
          { timeoutMs: 900_000, label: `download ${release.tag}/${platform}` },
        )
      } catch (error) {
        return fallback(
          `Asset download failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      // Integrity failure is terminal; it must not silently turn into a tag-build.
      verifyBinary(temporary, source.sha256)
      chmodSync(temporary, 0o755)
      renameSync(temporary, path)
    } finally {
      rmSync(dirname(temporary), { recursive: true, force: true })
    }
  }
  verifyBinary(path, source.sha256)
  return {
    path,
    tag: release.tag,
    commit: release.commit,
    platform,
    kind: source.kind,
    evidenceLevel: source.evidenceLevel,
    sha256: source.sha256,
    verification: 'registry-sha256',
  }
}

/** The compiled repo stub is the actual runtime. The shim only adapts old transports. */
export async function resolveRuntimeShim(cacheDir = DEFAULT_CACHE): Promise<string> {
  const source = join(REPO_ROOT, 'scripts/release-upgrade/lib/runtime-shim.ts')
  const key = sha256(readFileSync(source))
  const path = join(
    cacheDir,
    'runtime-shim',
    nativePlatform(),
    key,
    `opencode${process.platform === 'win32' ? '.exe' : ''}`,
  )
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    await command([process.execPath, 'build', '--compile', source, '--outfile', path], {
      label: 'compile release runtime adapter',
    })
  }
  return path
}
