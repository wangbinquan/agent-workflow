// RFC-237 — runtime-neutral executable copy-seal (extracted VERBATIM from
// runtime/opencode/runtimeBinary.ts, which now re-exports these under its
// legacy names so every RFC-224/227 import site keeps working unchanged).
//
// The administrator-selected runtime binary is local trusted code. The
// platform resolves it once, hashes it, copies those exact bytes into a
// private per-run seal, re-hashes the copy, and executes only that copy.
// SHA-256 is a byte/TOCTOU identity fence; it is not a vendor signature and is
// never compared with a static version allowlist (RFC-227 §2 — the contract is
// protocol-neutral and applies to the claude-code seal identically).

import { createHash } from 'node:crypto'
import { constants, createReadStream, mkdtempSync, rmSync, type Stats } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, realpath, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join } from 'node:path'
import { assertSameFileIdentityForHost } from '@/util/fileTrust'

export const RUNTIME_BINARY_SNAPSHOT_ERROR_CODE = 'execution-identity-untrusted-binary' as const

export type RuntimeBinarySnapshotFailureReason = 'not-found' | 'unlaunchable' | 'changed'

export class RuntimeBinarySnapshotError extends Error {
  readonly code = RUNTIME_BINARY_SNAPSHOT_ERROR_CODE

  constructor(readonly reason: RuntimeBinarySnapshotFailureReason = 'unlaunchable') {
    super('runtime executable could not be frozen for execution')
    this.name = 'RuntimeBinarySnapshotError'
  }
}

export interface RuntimeBinaryIdentity {
  resolvedPath: string
  digest: string
}

export interface SnapshotRuntimeBinaryOptions {
  /** Exactly one PATH token or one absolute executable path. */
  command: readonly string[]
  /** Absolute destination inside a private caller-owned run directory. */
  snapshotPath: string
  /** Resume/cache fence. Different source bytes fail closed. */
  expectedDigest?: string
}

export interface RuntimeBinaryDependencies {
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

const DEFAULT_DEPENDENCIES: Readonly<RuntimeBinaryDependencies> = Object.freeze({
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

function fail(reason: RuntimeBinarySnapshotFailureReason = 'unlaunchable'): never {
  throw new RuntimeBinarySnapshotError(reason)
}

function isSha256Digest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}

function executableFile(metadata: Stats, platform = process.platform): boolean {
  return metadata.isFile() && (platform === 'win32' || (metadata.mode & 0o111) !== 0)
}

/**
 * RFC-254 T39 — the executable extension a byte-frozen snapshot copy must carry
 * so the OS will run it, given where the caller asked the copy to land
 * (`snapshotPath`) and the realpath-resolved source it is copied from.
 *
 * Pure so both platform branches are exercised on any host. Rules:
 *   - POSIX: always '' (an extension is not what makes a file executable there;
 *     the 0500 mode is). Strict no-op vs. the pre-T39 behaviour.
 *   - win32, caller path already ends with the source extension: '' — the
 *     verified opencode/mcp/system paths pre-suffix via EXECUTABLE_SUFFIX_FOR_HOST
 *     (`opencode.exe`), and appending again would both double the suffix and
 *     break the `snapshotPath === input.binaryPath` admission guard.
 *   - win32, caller path lacks it (`claude-sealed`, the rfc135 fixture's
 *     `opencode`): the resolved source extension, so the inert extensionless
 *     copy becomes runnable.
 * The extension is derived from the RESOLVED source, never caller/attacker
 * input, so the trust boundary (the byte digest) is untouched.
 */
export function snapshotExecutableExtension(
  snapshotPath: string,
  resolvedSourcePath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return ''
  const sourceExtension = extname(resolvedSourcePath)
  if (sourceExtension === '') return ''
  return snapshotPath.toLowerCase().endsWith(sourceExtension.toLowerCase()) ? '' : sourceExtension
}

function failureFor(error: unknown): RuntimeBinarySnapshotFailureReason {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
    return 'not-found'
  }
  return 'unlaunchable'
}

async function resolveSingleExecutable(
  command: readonly string[],
  dependencies: RuntimeBinaryDependencies,
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
    if (error instanceof RuntimeBinarySnapshotError) throw error
    return fail(failureFor(error))
  }
}

/** Read-only identity inspection used before any resume store mutation. */
export async function inspectRuntimeBinary(
  command: readonly string[],
  dependencies: Partial<RuntimeBinaryDependencies> = {},
): Promise<RuntimeBinaryIdentity> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  try {
    const resolvedPath = await resolveSingleExecutable(command, deps)
    const digest = await deps.hashFile(resolvedPath)
    if (!isSha256Digest(digest)) return fail()
    return { resolvedPath, digest }
  } catch (error) {
    if (error instanceof RuntimeBinarySnapshotError) throw error
    return fail(failureFor(error))
  }
}

/**
 * Resolve/hash source, copy exclusively into a private seal, and re-hash the
 * snapshot. The returned path is the only executable callers may launch.
 */
export async function snapshotRuntimeBinary(
  options: SnapshotRuntimeBinaryOptions,
  dependencies: Partial<RuntimeBinaryDependencies> = {},
): Promise<RuntimeBinaryIdentity & { snapshotPath: string }> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies }
  let copied = false
  // Hoisted so the catch's cleanup unlinks the SAME path the copy wrote. On
  // POSIX this stays === options.snapshotPath (extension is ''); on win32 it may
  // carry the resolved source extension so the copy is executable — see below.
  let effectiveSnapshotPath = options.snapshotPath
  try {
    if (!isAbsolute(options.snapshotPath)) return fail()
    if (options.expectedDigest !== undefined && !isSha256Digest(options.expectedDigest)) {
      return fail()
    }
    const inspected = await inspectRuntimeBinary(options.command, deps)
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

    // RFC-254 T39: a byte-frozen COPY must be OS-executable; on win32 that needs
    // a recognized extension, which some callers' snapshot basenames lack. See
    // `snapshotExecutableExtension` for the full rule (POSIX no-op; win32 append
    // only when absent, so the pre-suffixed verified opencode path is untouched).
    effectiveSnapshotPath = `${options.snapshotPath}${snapshotExecutableExtension(
      options.snapshotPath,
      inspected.resolvedPath,
    )}`

    await deps.copyFile(inspected.resolvedPath, effectiveSnapshotPath, constants.COPYFILE_EXCL)
    copied = true
    if (process.platform !== 'win32') await deps.chmod(effectiveSnapshotPath, 0o500)
    await verifyRuntimeBinarySnapshot(effectiveSnapshotPath, inspected.digest, deps)
    const sourceAfter = await deps.lstat(inspected.resolvedPath)
    const sourceDigestAfter = await deps.hashFile(inspected.resolvedPath)
    if (
      sourceAfter.isSymbolicLink() ||
      !executableFile(sourceAfter) ||
      !assertSameFileIdentityForHost(sourceBefore, sourceAfter).trusted ||
      sourceAfter.size !== sourceBefore.size ||
      sourceAfter.mtimeMs !== sourceBefore.mtimeMs ||
      sourceAfter.ctimeMs !== sourceBefore.ctimeMs ||
      sourceDigestAfter !== inspected.digest
    ) {
      return fail('changed')
    }
    return { ...inspected, snapshotPath: effectiveSnapshotPath }
  } catch (error) {
    if (copied) {
      try {
        await deps.unlink(effectiveSnapshotPath)
      } catch {
        // Rejected bytes are never returned or executed.
      }
    }
    if (error instanceof RuntimeBinarySnapshotError) throw error
    return fail(failureFor(error))
  }
}

/**
 * Verify the private snapshot immediately before exec.
 */
export async function verifyRuntimeBinarySnapshot(
  path: string,
  expectedDigest: string,
  dependencies: Partial<RuntimeBinaryDependencies> = {},
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
    if (error instanceof RuntimeBinarySnapshotError) throw error
    return fail(failureFor(error))
  }
}

/** Diagnostic helper: execute only a temporary byte-frozen snapshot. */
export async function withRuntimeBinarySnapshot<T>(
  command: readonly string[],
  callback: (snapshotPath: string, identity: RuntimeBinaryIdentity) => Promise<T>,
  snapshotBasename = 'runtime-binary',
): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'aw-runtime-binary-'))
  const snapshotPath = join(root, snapshotBasename)
  try {
    // RFC-254 T39: snapshotRuntimeBinary may append a resolved source extension
    // on win32 so the copy is executable — use the path it ACTUALLY wrote for
    // verify + the callback, not the pre-extension basename. POSIX no-op.
    const identity = await snapshotRuntimeBinary({ command, snapshotPath })
    await verifyRuntimeBinarySnapshot(identity.snapshotPath, identity.digest)
    return await callback(identity.snapshotPath, identity)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
