// RFC-224 — official opencode executable identity.
//
// Version output is not an identity proof: a wrapper or fork can print the
// expected version. Production execution therefore admits only an executable
// whose bytes match this immutable platform/arch/version allowlist, copies it
// into the caller's private run directory, and executes only that copy.

import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  createReadStream,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  mkdtempSync,
  rmSync,
  type Stats,
} from 'node:fs'
import { chmod, copyFile, lstat, mkdir, realpath, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { OPENCODE_FFF_CAPABILITY_CODEC } from './hermetic'

export const OFFICIAL_OPENCODE_BUILD_CODEC = 1 as const

export type OfficialOpencodePlatform = 'darwin' | 'linux'
export type OfficialOpencodeArch = 'arm64' | 'x64'

/**
 * One exact executable identity. `codec` versions this allowlist record shape;
 * `digest` is always the lowercase SHA-256 of the unpacked executable, not of
 * the release archive.
 */
export interface OfficialOpencodeBuild {
  platform: OfficialOpencodePlatform
  arch: OfficialOpencodeArch
  version: string
  digest: string
  codec: typeof OFFICIAL_OPENCODE_BUILD_CODEC
  fffCapabilityCodec: typeof OPENCODE_FFF_CAPABILITY_CODEC
}

function frozenBuild(build: OfficialOpencodeBuild): Readonly<OfficialOpencodeBuild> {
  return Object.freeze(build)
}

/** The sole production trust root. Unknown versions/platforms never fall back. */
export const OFFICIAL_OPENCODE_BUILDS: readonly Readonly<OfficialOpencodeBuild>[] = Object.freeze([
  frozenBuild({
    platform: 'darwin',
    arch: 'arm64',
    version: '1.18.3',
    digest: '43f7083d450567706a80b6441331a25b5ed6d6c9f742826790545b068229cbb2',
    codec: OFFICIAL_OPENCODE_BUILD_CODEC,
    fffCapabilityCodec: OPENCODE_FFF_CAPABILITY_CODEC,
  }),
  frozenBuild({
    platform: 'darwin',
    arch: 'x64',
    version: '1.18.3',
    digest: 'ba11415d6af7efc9dc0073520d546b869711da5f39076d12e08eeb266ba1279b',
    codec: OFFICIAL_OPENCODE_BUILD_CODEC,
    fffCapabilityCodec: OPENCODE_FFF_CAPABILITY_CODEC,
  }),
  frozenBuild({
    platform: 'linux',
    arch: 'arm64',
    version: '1.18.3',
    digest: '915ca1cd9eb5a7b3e15bd89dc71c38cf0caa9a02d13c5371422675b4b370bffb',
    codec: OFFICIAL_OPENCODE_BUILD_CODEC,
    fffCapabilityCodec: OPENCODE_FFF_CAPABILITY_CODEC,
  }),
  frozenBuild({
    platform: 'linux',
    arch: 'x64',
    version: '1.18.3',
    digest: 'fdf58364c969a144fff0ae3a30f2fb6e705ada06864842613de1f9ecc70feb20',
    codec: OFFICIAL_OPENCODE_BUILD_CODEC,
    fffCapabilityCodec: OPENCODE_FFF_CAPABILITY_CODEC,
  }),
])

export const OFFICIAL_OPENCODE_BINARY_ERROR_CODE = 'execution-identity-untrusted-binary' as const

/**
 * Deliberately carries no source path, digest, file bytes, or underlying fs
 * error. The launcher may surface `code`; it must not turn binary verification
 * into a filesystem/content oracle.
 */
export class OfficialOpencodeBinaryError extends Error {
  readonly code = OFFICIAL_OPENCODE_BINARY_ERROR_CODE

  constructor() {
    super('opencode executable is not an approved official build')
    this.name = 'OfficialOpencodeBinaryError'
  }
}

export interface SnapshotOfficialOpencodeBinaryOptions {
  /** Must be exactly one PATH token or one absolute executable path. */
  command: readonly string[]
  /** Exact probed version; loose semver/ranges are intentionally unsupported. */
  version: string
  /** Absolute path selected by the caller inside its private run directory. */
  snapshotPath: string
  platform?: NodeJS.Platform
  arch?: string
}

/**
 * Narrow dependency seam for deterministic unit tests. Production callers
 * omit this argument; no environment variable or path-name bypass exists.
 */
export interface OfficialOpencodeBinaryDependencies {
  builds: readonly Readonly<OfficialOpencodeBuild>[]
  which(token: string): string | null
  realpath(path: string): Promise<string>
  stat(path: string): Promise<Stats>
  lstat(path: string): Promise<Stats>
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>
  chmod(path: string, mode: number): Promise<void>
  copyFile(source: string, destination: string, mode: number): Promise<void>
  unlink(path: string): Promise<void>
  hashFile(path: string): Promise<string>
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256')
  const input = createReadStream(path)
  for await (const chunk of input) {
    digest.update(chunk)
  }
  return digest.digest('hex')
}

const DEFAULT_DEPENDENCIES: Readonly<OfficialOpencodeBinaryDependencies> = Object.freeze({
  builds: OFFICIAL_OPENCODE_BUILDS,
  which: (token: string) => Bun.which(token),
  realpath,
  stat,
  lstat,
  mkdir,
  chmod,
  copyFile,
  unlink,
  hashFile: sha256File,
})

function untrusted(): never {
  throw new OfficialOpencodeBinaryError()
}

function isSha256Digest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}

function isOfficialPlatform(value: NodeJS.Platform): value is OfficialOpencodePlatform {
  return value === 'darwin' || value === 'linux'
}

function isOfficialArch(value: string): value is OfficialOpencodeArch {
  return value === 'arm64' || value === 'x64'
}

/**
 * Resolve one and only one allowlist row for the full identity tuple.
 * Duplicate injected rows fail closed rather than creating ambiguous policy.
 */
export function requireOfficialOpencodeBuild(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  builds: readonly Readonly<OfficialOpencodeBuild>[] = OFFICIAL_OPENCODE_BUILDS,
): Readonly<OfficialOpencodeBuild> {
  if (version.length === 0 || !isOfficialPlatform(platform) || !isOfficialArch(arch)) {
    return untrusted()
  }

  const matches = builds.filter(
    (build) =>
      build.codec === OFFICIAL_OPENCODE_BUILD_CODEC &&
      build.fffCapabilityCodec === OPENCODE_FFF_CAPABILITY_CODEC &&
      build.platform === platform &&
      build.arch === arch &&
      build.version === version &&
      isSha256Digest(build.digest),
  )
  if (matches.length !== 1) return untrusted()
  return matches[0]!
}

async function resolveSingleExecutable(
  command: readonly string[],
  deps: OfficialOpencodeBinaryDependencies,
): Promise<string> {
  if (command.length !== 1) return untrusted()
  const token = command[0]
  if (typeof token !== 'string' || token.length === 0 || token.includes('\0')) {
    return untrusted()
  }

  // Relative strings containing a path separator are neither PATH tokens nor
  // absolute paths. Rejecting them avoids cwd-dependent identity.
  let unresolved: string
  if (isAbsolute(token)) {
    unresolved = token
  } else {
    if (token.includes('/') || token.includes('\\')) return untrusted()
    const found = deps.which(token)
    if (found === null || found.length === 0) return untrusted()
    unresolved = found
  }

  const resolved = await deps.realpath(unresolved)
  if (!isAbsolute(resolved)) return untrusted()
  const metadata = await deps.stat(resolved)
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) return untrusted()
  return resolved
}

/**
 * Verify an already-private snapshot immediately before each server/attach
 * exec. This checks bytes, regular-file/symlink status, and the required 0500
 * mode. It returns no path or metadata, so callers cannot accidentally switch
 * back to executing the source.
 */
export async function verifyOfficialSnapshot(
  path: string,
  expectedDigest: string,
  dependencies: Partial<OfficialOpencodeBinaryDependencies> = {},
): Promise<void> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  try {
    if (!isAbsolute(path) || !isSha256Digest(expectedDigest)) return untrusted()
    const metadata = await deps.lstat(path)
    if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o777) !== 0o500) {
      return untrusted()
    }
    const actualDigest = await deps.hashFile(path)
    if (actualDigest !== expectedDigest) return untrusted()
  } catch {
    return untrusted()
  }
}

/**
 * Resolve/hash the source, copy it into a private caller-owned directory, and
 * re-hash the copy. The returned value is deliberately only `snapshotPath`.
 */
export async function snapshotOfficialOpencodeBinary(
  options: SnapshotOfficialOpencodeBinaryOptions,
  dependencies: Partial<OfficialOpencodeBinaryDependencies> = {},
): Promise<string> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  let copied = false
  try {
    if (!isAbsolute(options.snapshotPath)) return untrusted()
    const build = requireOfficialOpencodeBuild(
      options.version,
      options.platform ?? process.platform,
      options.arch ?? process.arch,
      deps.builds,
    )
    const source = await resolveSingleExecutable(options.command, deps)
    const sourceDigest = await deps.hashFile(source)
    if (sourceDigest !== build.digest) return untrusted()

    const privateDir = dirname(options.snapshotPath)
    await deps.mkdir(privateDir, { recursive: true, mode: 0o700 })
    await deps.chmod(privateDir, 0o700)
    const directoryMetadata = await deps.stat(privateDir)
    if (!directoryMetadata.isDirectory() || (directoryMetadata.mode & 0o777) !== 0o700) {
      return untrusted()
    }

    // EXCL prevents replacement of an existing destination. If the source is
    // swapped after its first hash, the mandatory snapshot re-hash below still
    // catches the race.
    await deps.copyFile(source, options.snapshotPath, constants.COPYFILE_EXCL)
    copied = true
    await deps.chmod(options.snapshotPath, 0o500)
    await verifyOfficialSnapshot(options.snapshotPath, build.digest, deps)
    return options.snapshotPath
  } catch {
    if (copied) {
      try {
        await deps.unlink(options.snapshotPath)
      } catch {
        // The untrusted snapshot is never returned or executed. Cleanup is
        // best-effort because preserving the stable verification error matters
        // more than exposing a secondary filesystem error.
      }
    }
    return untrusted()
  }
}

/**
 * Run a diagnostic against the same private official snapshot trust boundary
 * used by model execution. The source command is never executed directly.
 */
export async function withOfficialOpencodeSnapshot<T>(
  command: readonly string[],
  callback: (snapshotPath: string) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'aw-opencode-official-'))
  const snapshotPath = join(root, 'opencode')
  try {
    await snapshotOfficialOpencodeBinary({
      command,
      version: '1.18.3',
      snapshotPath,
    })
    await verifyOfficialSnapshot(snapshotPath, requireOfficialOpencodeBuild('1.18.3').digest)
    return await callback(snapshotPath)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function sha256FileSync(path: string): string {
  const digest = createHash('sha256')
  const fd = openSync(path, constants.O_RDONLY)
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      const bytes = readSync(fd, buffer, 0, buffer.byteLength, null)
      if (bytes === 0) break
      digest.update(buffer.subarray(0, bytes))
    }
  } finally {
    closeSync(fd)
  }
  return digest.digest('hex')
}

function resolveSingleExecutableSync(command: readonly string[]): string {
  if (command.length !== 1) return untrusted()
  const token = command[0]
  if (typeof token !== 'string' || token.length === 0 || token.includes('\0')) {
    return untrusted()
  }
  let unresolved: string
  if (isAbsolute(token)) {
    unresolved = token
  } else {
    if (token.includes('/') || token.includes('\\')) return untrusted()
    const found = Bun.which(token)
    if (found === null || found.length === 0) return untrusted()
    unresolved = found
  }
  const resolved = realpathSync(unresolved)
  if (!isAbsolute(resolved)) return untrusted()
  const metadata = statSync(resolved)
  if (!metadata.isFile() || (metadata.mode & 0o111) === 0) return untrusted()
  return resolved
}

/** Synchronous twin used by the historically synchronous system-agent builder.
 * It retains the same trust checks and streams the source through a bounded
 * fixed-size buffer instead of reading the executable into one allocation. */
export function snapshotOfficialOpencodeBinarySync(
  options: SnapshotOfficialOpencodeBinaryOptions,
): string {
  let copied = false
  try {
    if (!isAbsolute(options.snapshotPath)) return untrusted()
    const build = requireOfficialOpencodeBuild(
      options.version,
      options.platform ?? process.platform,
      options.arch ?? process.arch,
    )
    const source = resolveSingleExecutableSync(options.command)
    if (sha256FileSync(source) !== build.digest) return untrusted()
    const privateDir = dirname(options.snapshotPath)
    mkdirSync(privateDir, { recursive: true, mode: 0o700 })
    chmodSync(privateDir, 0o700)
    const directoryMetadata = statSync(privateDir)
    if (!directoryMetadata.isDirectory() || (directoryMetadata.mode & 0o777) !== 0o700) {
      return untrusted()
    }
    copyFileSync(source, options.snapshotPath, constants.COPYFILE_EXCL)
    copied = true
    chmodSync(options.snapshotPath, 0o500)
    verifyOfficialSnapshotSync(options.snapshotPath, build.digest)
    return options.snapshotPath
  } catch {
    if (copied) {
      try {
        unlinkSync(options.snapshotPath)
      } catch {
        // rejected bytes are never returned
      }
    }
    return untrusted()
  }
}

export function verifyOfficialSnapshotSync(path: string, expectedDigest: string): void {
  try {
    if (!isAbsolute(path) || !isSha256Digest(expectedDigest)) return untrusted()
    const before = lstatSync(path)
    if (before.isSymbolicLink() || !before.isFile() || (before.mode & 0o777) !== 0o500) {
      return untrusted()
    }
    const fd = openSync(
      path,
      constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0),
    )
    try {
      const opened = fstatSync(fd)
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size
      ) {
        return untrusted()
      }
    } finally {
      closeSync(fd)
    }
    if (sha256FileSync(path) !== expectedDigest) return untrusted()
  } catch {
    return untrusted()
  }
}
