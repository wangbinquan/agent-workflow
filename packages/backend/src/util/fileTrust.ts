// RFC-254 T0a (D22) — the single place that decides whether a file on disk may
// be trusted as platform-private.
//
// WHY THIS EXISTS
// ---------------
// The verified-execution store proves three things about every sensitive file
// it writes or reads back — the launch manifest, the control ACK, the sealed
// inputs, the byte-frozen binary, the store-hygiene lock probes:
//
//   1. PRIVACY  — nobody but us can read or write it.
//   2. NOT-A-LINK — the name we checked is the object we opened, not a
//      redirection someone planted between the two.
//   3. IDENTITY — the handle we ended up holding is the same object `lstat`
//      described a moment ago (the TOCTOU half).
//
// Until now each of those was spelled inline, six files over, as POSIX
// arithmetic: `(mode & 0o777) !== 0o600`, `O_NOFOLLOW`, `dev`/`ino` equality.
// That is not merely unportable — on Windows it is actively misleading. Node
// synthesizes `mode` from the read-only attribute (a writable file reports
// 0o666 whatever its ACL says), and `ino` is 0 or unstable on NTFS. So the
// POSIX spelling on Windows can both reject a perfectly private file and — if
// anyone ever "fixed" it by relaxing the comparison — accept a world-writable
// one. The RFC-254 design gate (P0-C) called this out as the single most
// dangerous scattered assumption in the verified path.
//
// The rule this module enforces, and the reason it returns a REASON rather
// than a boolean: a platform that cannot yet prove privacy must FAIL, loudly
// and diagnosably, never silently skip the check. Skipping is how a receipt
// ends up claiming "verified" over a file nothing verified (the same failure
// mode RFC-253 hit with its containment receipts). `win32` therefore answers
// `platform-unsupported` here, which callers map onto their existing
// store-unsafe failure — the same OUTCOME Windows already gets today from the
// mode arithmetic, but with a reason an operator can act on.
//
// Every function is pure over a `Stats`-shaped input plus an explicit
// `platform`, so both branches are exercised on whatever OS runs the suite.

/** The only mode a platform-private file may carry on POSIX. */
export const PRIVATE_FILE_MODE = 0o600
/** The only mode a sealed (read+execute, never writable) tree may carry. */
export const SEALED_EXEC_MODE = 0o500

export type FileTrustFailure =
  /** Not a regular file (directory, fifo, socket, device). */
  | 'not-regular-file'
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

/** The subset of `fs.Stats` these assertions read. */
export interface TrustStats {
  isFile: () => boolean
  isSymbolicLink: () => boolean
  mode: number
  dev: number
  ino: number
  size: number
}

/**
 * True when this platform can prove privacy/identity from stat metadata alone.
 *
 * POSIX can: mode bits and dev/ino are exactly those facts. Windows cannot —
 * the answer lives in the DACL and in `FileIndex`/`VolumeSerialNumber`, which
 * `fs.Stats` does not carry. A win32 implementation is a separate task
 * (RFC-254 T0a win32 half); until it lands, this seam keeps the verified path
 * fail-closed rather than approximately-correct.
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
  if ((stats.mode & 0o777) !== expectedMode) return deny('not-private')
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
  if ((stats.mode & 0o777) !== (expectation.expectedMode ?? PRIVATE_FILE_MODE)) {
    return deny('not-private')
  }
  if (expectation.maxBytes !== undefined && stats.size > expectation.maxBytes) {
    return deny('size-changed')
  }
  return TRUSTED
}

/**
 * The TOCTOU half: the object behind the handle must be the one `lstat`
 * described. `dev`+`ino` is the POSIX identity pair.
 *
 * Size is deliberately NOT part of this. Callers disagree about it on purpose
 * — the launch manifest demands byte-exact equality (it was just written and
 * must not have been rewritten), while the control ACK only enforces a
 * ceiling (it is legitimately still being appended when first read). Folding
 * either rule in here would silently retighten or loosen the other.
 */
export function assertSameFileIdentity(
  before: TrustStats,
  opened: TrustStats,
  platform: NodeJS.Platform,
): FileTrustVerdict {
  if (!statMetadataIsAuthoritative(platform)) return deny('platform-unsupported')
  if (!opened.isFile()) return deny('not-regular-file')
  if (opened.dev !== before.dev || opened.ino !== before.ino) return deny('identity-changed')
  return TRUSTED
}

// --- host-frozen wrappers ----------------------------------------------------

export function assertPrivateRegularFileForHost(
  stats: TrustStats,
  expectedMode?: number,
): FileTrustVerdict {
  return assertPrivateRegularFile(stats, process.platform, expectedMode)
}

export function assertUnopenedPrivateFileForHost(
  stats: TrustStats,
  expectation?: UnopenedFileExpectation,
): FileTrustVerdict {
  return assertUnopenedPrivateFile(stats, process.platform, expectation)
}

export function assertSameFileIdentityForHost(
  before: TrustStats,
  opened: TrustStats,
): FileTrustVerdict {
  return assertSameFileIdentity(before, opened, process.platform)
}
