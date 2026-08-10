// Cross-platform privacy, file-kind and same-object checks for sensitive files
// and no-follow worktree reads.
//
// The shared rules are:
//   1. only the owner (plus the OS administrator boundary) may access the file;
//   2. a checked path must not be a symbolic-link redirection;
//   3. the opened handle must still name the object described before open.
//
// POSIX exposes these facts through mode/dev/ino. Windows requires the DACL and
// platform-specific identity handling. The functions return a reasoned verdict
// and take an explicit platform so both branches remain testable on every host.
// `...ForHost` wrappers below; the pure `assert*` functions and their tests never
// touch them, so this module's testability is unchanged. Both a Promise-returning
// and a sync twin exist because the control-ACK path is synchronous.
import { assertWindowsFilePrivate, assertWindowsFilePrivateSync } from './win32Acl'

/** The only mode a platform-private file may carry on POSIX. */
export const PRIVATE_FILE_MODE = 0o600
/** Mode for an owner-readable/executable file that must not be writable. */
export const OWNER_READ_EXECUTE_MODE = 0o500

export type FileTrustFailure =
  /** Not a regular file (directory, fifo, socket, device). */
  | 'not-regular-file'
  /** Not a real directory. */
  | 'not-directory'
  /** Permission bits grant access to somebody other than the owner. */
  | 'not-private'
  /** The path is a symbolic link / reparse point. */
  | 'is-link'
  /** The opened object is not the one that was described before opening. */
  | 'identity-changed'
  /** Grew or shrank between the check and the read. */
  | 'size-changed'
  /**
   * This platform has no implementation that can PROVE the property. Callers
   * must treat it as a hard failure; it exists so the reason is legible
   * instead of masquerading as a permission mismatch.
   */
  | 'platform-unsupported'

export type FileTrustVerdict = { trusted: true } | { trusted: false; reason: FileTrustFailure }

const TRUSTED: FileTrustVerdict = { trusted: true }
const deny = (reason: FileTrustFailure): FileTrustVerdict => ({ trusted: false, reason })

/**
 * The minimal identity pair for comparing filesystem objects across checks.
 */
export interface FileIdentity {
  // `number | bigint` because Node's `bigint: true` stat variant preserves the
  // full permission word. Comparison is by value, so mixing the two
  // representations of the SAME identity would be a false mismatch — callers
  // must not compare a bigint stat against a number stat, and in practice
  // never do: both operands always come from the same stat call style.
  dev: number | bigint
  ino: number | bigint
}

/** The subset of `fs.Stats` these assertions read. */
export interface TrustStats extends FileIdentity {
  isFile: () => boolean
  isDirectory: () => boolean
  isSymbolicLink: () => boolean
  /** `bigint` when the caller used Node's `{ bigint: true }` stat variant. */
  mode: number | bigint
  size: number | bigint
}

/**
 * True when this platform can prove privacy/identity from stat metadata alone.
 *
 * POSIX can: mode bits and dev/ino are exactly those facts. Windows cannot —
 * the answer lives in the DACL and in `FileIndex`/`VolumeSerialNumber`, which
 * `fs.Stats` does not carry, so path-aware wrappers consult the Windows ACL
 * implementation instead of approximating the answer.
 */
export function statMetadataIsAuthoritative(platform: NodeJS.Platform): boolean {
  return platform !== 'win32'
}

/**
 * Verdict for a handle we just created or opened exclusively: it must be a
 * regular file whose permissions name only the owner.
 */
export function assertPrivateRegularFile(
  stats: TrustStats,
  platform: NodeJS.Platform,
  expectedMode: number = PRIVATE_FILE_MODE,
): FileTrustVerdict {
  if (!statMetadataIsAuthoritative(platform)) return deny('platform-unsupported')
  if (!stats.isFile()) return deny('not-regular-file')
  if (Number(BigInt(stats.mode) & 0o777n) !== expectedMode) return deny('not-private')
  return TRUSTED
}

export interface UnopenedFileExpectation {
  /** Reject anything larger; omit to skip the size ceiling. */
  maxBytes?: number
  /** Defaults to PRIVATE_FILE_MODE. */
  expectedMode?: number
}

/**
 * Verdict for a path described by `lstat` BEFORE we open it. Link rejection is
 * checked first so a planted symlink reports as a link rather than as whatever
 * its target's permissions happen to be — the difference matters when reading
 * the diagnosis afterwards.
 */
export function assertUnopenedPrivateFile(
  stats: TrustStats,
  platform: NodeJS.Platform,
  expectation: UnopenedFileExpectation = {},
): FileTrustVerdict {
  if (!statMetadataIsAuthoritative(platform)) return deny('platform-unsupported')
  if (stats.isSymbolicLink()) return deny('is-link')
  if (!stats.isFile()) return deny('not-regular-file')
  if (Number(BigInt(stats.mode) & 0o777n) !== (expectation.expectedMode ?? PRIVATE_FILE_MODE)) {
    return deny('not-private')
  }
  if (expectation.maxBytes !== undefined && Number(stats.size) > expectation.maxBytes) {
    return deny('size-changed')
  }
  return TRUSTED
}

/**
 * RFC-254 T40a — file IDENTITY is authoritative wherever the filesystem
 * actually supplies it, which now includes win32.
 *
 * POSIX carries identity as `dev`/`ino`. Windows carries the SAME fact as
 * `VolumeSerialNumber`/`FileIndex`, and Bun populates `fs.Stats.dev`/`ino` from
 * `GetFileInformationByHandle` with exactly those — MEASURED on Bun 1.3.14 /
 * Windows 11 to be non-zero, stable across stats, distinct per file, and equal
 * between an open handle's `fstat` and the path's `lstat` (the precise TOCTOU
 * pair this check needs). The module header's older "ino is 0/unstable on
 * NTFS" note predates that and is corrected here — it holds only for
 * filesystems that supply no index (FAT, some network shares), which report 0.
 *
 * So identity does NOT need the DACL/FFI that PRIVACY still does
 * (`statMetadataIsAuthoritative` stays win32-false for the mode-based privacy
 * assertions above; only this identity check is now win32-authoritative). The
 * FileIndex-reuse-after-delete window is identical to POSIX inode reuse — the
 * same guarantee, not a weaker one.
 *
 * Fail closed when the index is absent: a `0` pair means the filesystem gave
 * no identity, and two "0" objects must NOT be treated as the same file.
 *
 * Size is deliberately NOT part of this. Callers own their own equality or
 * ceiling policy; folding either one in here would silently change the other.
 */
export function assertSameFileIdentity(
  before: FileIdentity,
  opened: TrustStats,
  platform: NodeJS.Platform,
): FileTrustVerdict {
  if (!opened.isFile()) return deny('not-regular-file')
  if (platform === 'win32' && (BigInt(opened.ino) === 0n || BigInt(before.ino) === 0n)) {
    // Filesystem supplied no file index (FAT / some network shares): cannot
    // prove identity, so fail closed rather than match another indexless object.
    return deny('platform-unsupported')
  }
  if (opened.dev !== before.dev || opened.ino !== before.ino) return deny('identity-changed')
  return TRUSTED
}

/** Same-object identity check for directory cleanup ownership. */
export function assertSameDirectoryIdentity(
  before: FileIdentity,
  opened: TrustStats,
  platform: NodeJS.Platform,
): FileTrustVerdict {
  if (!opened.isDirectory() || opened.isSymbolicLink()) return deny('not-directory')
  if (platform === 'win32' && (BigInt(opened.ino) === 0n || BigInt(before.ino) === 0n)) {
    return deny('platform-unsupported')
  }
  if (opened.dev !== before.dev || opened.ino !== before.ino) return deny('identity-changed')
  return TRUSTED
}

// --- path-aware privacy (RFC-254 T40b) --------------------------------------
//
// PRIVACY is the one proof win32 cannot answer from stat metadata (its `mode` is
// synthesized). There the answer lives in the DACL, read by PATH — so these
// variants take the path and, on win32 only, defer to an injected reader that
// inspects the actual ACL (`util/win32Acl.ts:assertWindowsFilePrivate` in
// production). The reader is a parameter, not an import, so this module stays pure
// and BOTH branches run on any OS: a POSIX test passes a fake win32 reader.
//
// IDENTITY (dev/ino) and the link/size checks remain stat-based and are applied
// here too, so the win32 path still rejects a symlink or an oversize file before
// ever consulting the DACL.

export type WindowsFilePrivacyReader = (path: string) => Promise<FileTrustVerdict>
export type WindowsFilePrivacyReaderSync = (path: string) => FileTrustVerdict

/**
 * The non-DACL half of the win32 privacy checks — the guards that are identical
 * for the sync and async variants. Returns a verdict to short-circuit with, or
 * `null` to mean "guards passed, now consult the DACL reader".
 */
function win32PrivacyGuards(
  stats: TrustStats,
  checkLink: boolean,
  expectation?: UnopenedFileExpectation,
): FileTrustVerdict | null {
  if (checkLink && stats.isSymbolicLink()) return deny('is-link')
  if (!stats.isFile()) return deny('not-regular-file')
  if (expectation?.maxBytes !== undefined && Number(stats.size) > expectation.maxBytes) {
    return deny('size-changed')
  }
  return null
}

export async function assertPrivateRegularFileByPath(
  path: string,
  stats: TrustStats,
  platform: NodeJS.Platform,
  win32Reader: WindowsFilePrivacyReader,
  expectedMode: number = PRIVATE_FILE_MODE,
): Promise<FileTrustVerdict> {
  if (platform !== 'win32') return assertPrivateRegularFile(stats, platform, expectedMode)
  return win32PrivacyGuards(stats, false) ?? win32Reader(path)
}

export async function assertUnopenedPrivateFileByPath(
  path: string,
  stats: TrustStats,
  platform: NodeJS.Platform,
  win32Reader: WindowsFilePrivacyReader,
  expectation: UnopenedFileExpectation = {},
): Promise<FileTrustVerdict> {
  if (platform !== 'win32') return assertUnopenedPrivateFile(stats, platform, expectation)
  // Link rejection first (same ordering as the POSIX path) so a planted symlink
  // reports as a link rather than as whatever its target's ACL happens to be.
  return win32PrivacyGuards(stats, true, expectation) ?? win32Reader(path)
}

export function assertPrivateRegularFileByPathSync(
  path: string,
  stats: TrustStats,
  platform: NodeJS.Platform,
  win32Reader: WindowsFilePrivacyReaderSync,
  expectedMode: number = PRIVATE_FILE_MODE,
): FileTrustVerdict {
  if (platform !== 'win32') return assertPrivateRegularFile(stats, platform, expectedMode)
  return win32PrivacyGuards(stats, false) ?? win32Reader(path)
}

export function assertUnopenedPrivateFileByPathSync(
  path: string,
  stats: TrustStats,
  platform: NodeJS.Platform,
  win32Reader: WindowsFilePrivacyReaderSync,
  expectation: UnopenedFileExpectation = {},
): FileTrustVerdict {
  if (platform !== 'win32') return assertUnopenedPrivateFile(stats, platform, expectation)
  return win32PrivacyGuards(stats, true, expectation) ?? win32Reader(path)
}

// --- host-frozen wrappers ----------------------------------------------------
//
// The privacy wrappers are async and path-aware because their win32 branch reads
// the DACL (I/O). Identity stays sync — dev/ino need no ACL (RFC-254 T40a).

export function assertPrivateRegularFileForHost(
  path: string,
  stats: TrustStats,
  expectedMode?: number,
): Promise<FileTrustVerdict> {
  return assertPrivateRegularFileByPath(
    path,
    stats,
    process.platform,
    assertWindowsFilePrivate,
    expectedMode,
  )
}

export function assertUnopenedPrivateFileForHost(
  path: string,
  stats: TrustStats,
  expectation?: UnopenedFileExpectation,
): Promise<FileTrustVerdict> {
  return assertUnopenedPrivateFileByPath(
    path,
    stats,
    process.platform,
    assertWindowsFilePrivate,
    expectation,
  )
}

// Sync twins for callers that use `openSync`/`fstatSync`. Same verdict as the
// async wrappers; only the win32 DACL read is synchronous (`spawnSync icacls`).
export function assertPrivateRegularFileForHostSync(
  path: string,
  stats: TrustStats,
  expectedMode?: number,
): FileTrustVerdict {
  return assertPrivateRegularFileByPathSync(
    path,
    stats,
    process.platform,
    assertWindowsFilePrivateSync,
    expectedMode,
  )
}

export function assertUnopenedPrivateFileForHostSync(
  path: string,
  stats: TrustStats,
  expectation?: UnopenedFileExpectation,
): FileTrustVerdict {
  return assertUnopenedPrivateFileByPathSync(
    path,
    stats,
    process.platform,
    assertWindowsFilePrivateSync,
    expectation,
  )
}

export function assertSameFileIdentityForHost(
  before: FileIdentity,
  opened: TrustStats,
): FileTrustVerdict {
  return assertSameFileIdentity(before, opened, process.platform)
}

export function assertSameDirectoryIdentityForHost(
  before: FileIdentity,
  opened: TrustStats,
): FileTrustVerdict {
  return assertSameDirectoryIdentity(before, opened, process.platform)
}
