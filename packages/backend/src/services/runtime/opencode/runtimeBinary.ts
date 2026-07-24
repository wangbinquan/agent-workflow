// RFC-227 — version-neutral OpenCode executable identity.
//
// The administrator-selected runtime binary is local trusted code. The
// platform resolves it once, hashes it, copies those exact bytes into a
// private per-run seal, re-hashes the copy, and executes only that copy.
// SHA-256 is a byte/TOCTOU identity fence; it is not a vendor signature and is
// never compared with a static OpenCode-version allowlist.

import { createHash } from 'node:crypto'
import { constants, createReadStream, mkdtempSync, rmSync, type Stats } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, realpath, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

export const OPENCODE_BINARY_IDENTITY_CODEC = 1 as const
export const RUNTIME_OPENCODE_BINARY_ERROR_CODE = 'execution-identity-untrusted-binary' as const

export type RuntimeOpencodeBinaryFailureReason = 'not-found' | 'unlaunchable' | 'changed'

export class RuntimeOpencodeBinaryError extends Error {
  readonly code = RUNTIME_OPENCODE_BINARY_ERROR_CODE

  constructor(readonly reason: RuntimeOpencodeBinaryFailureReason = 'unlaunchable') {
    super('opencode executable could not be frozen for execution')
    this.name = 'RuntimeOpencodeBinaryError'
  }
}

export interface RuntimeOpencodeBinaryIdentity {
  resolvedPath: string
  digest: string
}

export interface SnapshotRuntimeOpencodeBinaryOptions {
  /** Exactly one PATH token or one absolute executable path. */
  command: readonly string[]
  /** Absolute destination inside a private caller-owned run directory. */
  snapshotPath: string
  /** Resume/cache fence. Different source bytes fail closed. */
  expectedDigest?: string
}

export interface RuntimeOpencodeBinaryDependencies {
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
  for await (const chunk of input) digest.update(chunk)
  return digest.digest('hex')
}

const DEFAULT_DEPENDENCIES: Readonly<RuntimeOpencodeBinaryDependencies> = Object.freeze({
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

function fail(reason: RuntimeOpencodeBinaryFailureReason = 'unlaunchable'): never {
  throw new RuntimeOpencodeBinaryError(reason)
}

function isSha256Digest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}

function executableFile(metadata: Stats, platform = process.platform): boolean {
  return metadata.isFile() && (platform === 'win32' || (metadata.mode & 0o111) !== 0)
}

function failureFor(error: unknown): RuntimeOpencodeBinaryFailureReason {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
    return 'not-found'
  }
  return 'unlaunchable'
}

async function resolveSingleExecutable(
  command: readonly string[],
  dependencies: RuntimeOpencodeBinaryDependencies,
): Promise<string> {
  if (command.length !== 1) return fail()
  const token = command[0]
  if (typeof token !== 'string' || token.length === 0 || token.includes('\0')) {
    return fail()
  }

  let unresolved: string
  if (isAbsolute(token)) {
    unresolved = token
  } else {
    // Relative path fragments are cwd-dependent. A bare PATH token is stable
    // once resolved to the canonical absolute path below.
    if (token.includes('/') || token.includes('\\')) return fail()
    const found = dependencies.which(token)
    if (found === null || found.length === 0) return fail('not-found')
    unresolved = found
  }

  try {
    const resolved = await dependencies.realpath(unresolved)
    if (!isAbsolute(resolved)) return fail()
    const metadata = await dependencies.stat(resolved)
    if (!executableFile(metadata)) return fail()
    return resolved
  } catch (error) {
    if (error instanceof RuntimeOpencodeBinaryError) throw error
    return fail(failureFor(error))
  }
}

/** Read-only identity inspection used before any resume store mutation. */
export async function inspectRuntimeOpencodeBinary(
  command: readonly string[],
  dependencies: Partial<RuntimeOpencodeBinaryDependencies> = {},
): Promise<RuntimeOpencodeBinaryIdentity> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  try {
    const resolvedPath = await resolveSingleExecutable(command, deps)
    const digest = await deps.hashFile(resolvedPath)
    if (!isSha256Digest(digest)) return fail()
    return { resolvedPath, digest }
  } catch (error) {
    if (error instanceof RuntimeOpencodeBinaryError) throw error
    return fail(failureFor(error))
  }
}

/**
 * Resolve/hash source, copy exclusively into a private seal, and re-hash the
 * snapshot. The returned path is the only executable callers may launch.
 */
export async function snapshotRuntimeOpencodeBinary(
  options: SnapshotRuntimeOpencodeBinaryOptions,
  dependencies: Partial<RuntimeOpencodeBinaryDependencies> = {},
): Promise<RuntimeOpencodeBinaryIdentity & { snapshotPath: string }> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  let copied = false
  try {
    if (!isAbsolute(options.snapshotPath)) return fail()
    if (options.expectedDigest !== undefined && !isSha256Digest(options.expectedDigest)) {
      return fail()
    }
    const inspected = await inspectRuntimeOpencodeBinary(options.command, deps)
    const sourceBefore = await deps.lstat(inspected.resolvedPath)
    if (sourceBefore.isSymbolicLink() || !executableFile(sourceBefore)) {
      return fail('changed')
    }
    if (options.expectedDigest !== undefined && inspected.digest !== options.expectedDigest) {
      return fail('changed')
    }

    const privateDir = dirname(options.snapshotPath)
    await deps.mkdir(privateDir, { recursive: true, mode: 0o700 })
    await deps.chmod(privateDir, 0o700)
    const directoryMetadata = await deps.stat(privateDir)
    if (
      !directoryMetadata.isDirectory() ||
      (process.platform !== 'win32' && (directoryMetadata.mode & 0o777) !== 0o700)
    ) {
      return fail()
    }

    await deps.copyFile(inspected.resolvedPath, options.snapshotPath, constants.COPYFILE_EXCL)
    copied = true
    if (process.platform !== 'win32') await deps.chmod(options.snapshotPath, 0o500)
    await verifyRuntimeOpencodeSnapshot(options.snapshotPath, inspected.digest, deps)
    const sourceAfter = await deps.lstat(inspected.resolvedPath)
    const sourceDigestAfter = await deps.hashFile(inspected.resolvedPath)
    if (
      sourceAfter.isSymbolicLink() ||
      !executableFile(sourceAfter) ||
      sourceAfter.dev !== sourceBefore.dev ||
      sourceAfter.ino !== sourceBefore.ino ||
      sourceAfter.size !== sourceBefore.size ||
      sourceAfter.mtimeMs !== sourceBefore.mtimeMs ||
      sourceAfter.ctimeMs !== sourceBefore.ctimeMs ||
      sourceDigestAfter !== inspected.digest
    ) {
      return fail('changed')
    }
    return { ...inspected, snapshotPath: options.snapshotPath }
  } catch (error) {
    if (copied) {
      try {
        await deps.unlink(options.snapshotPath)
      } catch {
        // Rejected bytes are never returned or executed.
      }
    }
    if (error instanceof RuntimeOpencodeBinaryError) throw error
    return fail(failureFor(error))
  }
}

/**
 * Verify the private snapshot immediately before server exec.
 */
export async function verifyRuntimeOpencodeSnapshot(
  path: string,
  expectedDigest: string,
  dependencies: Partial<RuntimeOpencodeBinaryDependencies> = {},
): Promise<void> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  try {
    if (!isAbsolute(path) || !isSha256Digest(expectedDigest)) return fail()
    const metadata = await deps.lstat(path)
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o500)
    ) {
      return fail('changed')
    }
    const actualDigest = await deps.hashFile(path)
    if (actualDigest !== expectedDigest) return fail('changed')
  } catch (error) {
    if (error instanceof RuntimeOpencodeBinaryError) throw error
    return fail(failureFor(error))
  }
}

/** Diagnostic helper: execute only a temporary byte-frozen snapshot. */
export async function withRuntimeOpencodeSnapshot<T>(
  command: readonly string[],
  callback: (snapshotPath: string, identity: RuntimeOpencodeBinaryIdentity) => Promise<T>,
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'aw-opencode-runtime-'))
  const snapshotPath = join(root, 'opencode')
  try {
    const identity = await snapshotRuntimeOpencodeBinary({ command, snapshotPath })
    await verifyRuntimeOpencodeSnapshot(snapshotPath, identity.digest)
    return await callback(snapshotPath, identity)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
