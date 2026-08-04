// RFC-254 T1 — platform-parameterized execution/path primitives.
//
// WHY THIS EXISTS
// ---------------
// The daemon shipped POSIX-only for its whole life, so a set of platform facts
// were spelled inline as literals: `/dev/null`, `':'`-joined PATH lists,
// `lastIndexOf('/')` to take a dirname, and `x.startsWith(`${root}/`)` to ask
// "is this path inside that root". Every one of those is wrong on Windows, and
// the last one is wrong in a way that does not throw — it silently answers
// `false` for every real path, which turns an allow-check into "deny everything"
// and a deny-check into "permit everything" depending on the caller.
//
// The RFC-254 design gate proved that a hand-maintained list of these sites is
// never complete (three separate reviews produced three different, all-wrong
// counts), so coverage is enforced by a whole-repo negative scan —
// `tests/rfc254-platform-surface-guard.test.ts` — rather than by anybody's
// memory. This module is the single destination that scan points call sites at.
//
// EVERY export takes `platform` explicitly. That is not ceremony: the win32
// branches have to be executable on the Linux/macOS CI legs, and a helper that
// reads `process.platform` internally can only ever exercise the host's own
// branch (RFC-254 design gate P2-1). Production call sites use the
// `*ForHost` wrappers at the bottom, which freeze the current platform once.

import { posix, win32 } from 'node:path'

/** The null sink: `NUL` is a reserved device name on Windows, not a path. */
export function nullDevice(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'NUL' : '/dev/null'
}

/**
 * Join directories into one PATH-style search list. Windows separates with `;`
 * because `:` is the drive-letter separator (`C:\bin` would split into two
 * meaningless entries).
 */
export function pathListJoin(dirs: readonly string[], platform: NodeJS.Platform): string {
  return dirs.join(platform === 'win32' ? ';' : ':')
}

/**
 * Split a PATH-style search list back into directories, dropping empties.
 * Callers that must extend an inherited PATH need the same separator rule.
 */
export function pathListSplit(list: string, platform: NodeJS.Platform): string[] {
  return list.split(platform === 'win32' ? ';' : ':').filter((entry) => entry.length > 0)
}

/**
 * Spawn options every production child needs on the host platform.
 *
 * `windowsHide` keeps a console-subsystem child from flashing (and, for a
 * long-running agent, *storming*) console windows in the user's face. The
 * multica reference implementation hit exactly this — a visible console per
 * grandchild — before hiding the window.
 */
export function platformSpawnOptions(platform: NodeJS.Platform): { windowsHide?: true } {
  return platform === 'win32' ? { windowsHide: true } : {}
}

/**
 * Case-fold + separator-fold a path for lexical comparison.
 *
 * Windows path comparison is case-INSENSITIVE (NTFS folds case) and accepts
 * both separators, so `C:/Foo` and `c:\foo` name the same directory. Comparing
 * them case-sensitively is a real defect in both directions: an allow-check
 * would reject a legitimate path, and a deny-check would miss a path it was
 * supposed to block (`docs/dev-gotchas.md` records the macOS instance of this
 * exact bug class, where a case-folding mismatch let a nested mount be treated
 * as a sibling).
 */
function foldForCompare(value: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? value.replaceAll('/', '\\').toLowerCase() : value
}

/**
 * True iff `candidate` IS `root` or lies lexically beneath it.
 *
 * LEXICAL ONLY — it does not touch the filesystem and does not resolve `..`,
 * symlinks or reparse points. Callers that need those guarantees must have
 * already canonicalized both operands (the verified-plan call sites realpath
 * first); this replaces the `x === root || x.startsWith(`${root}/`)` idiom and
 * nothing more, so it must not be mistaken for a containment proof.
 *
 * An empty `root` is never "containing" anything — the old idiom would have
 * accepted every absolute path against `''` via the `/` prefix.
 */
export function isLexicallyInside(
  root: string,
  candidate: string,
  platform: NodeJS.Platform,
): boolean {
  if (root.length === 0) return false
  const sep = platform === 'win32' ? win32.sep : posix.sep
  const foldedRoot = foldForCompare(root, platform)
  const foldedCandidate = foldForCompare(candidate, platform)
  if (foldedCandidate === foldedRoot) return true
  const prefix = foldedRoot.endsWith(sep) ? foldedRoot : `${foldedRoot}${sep}`
  return foldedCandidate.startsWith(prefix)
}

// --- host-frozen wrappers (production call sites use these) ------------------

/** The host's null sink. */
export const NULL_DEVICE_FOR_HOST = nullDevice(process.platform)

export function pathListJoinForHost(dirs: readonly string[]): string {
  return pathListJoin(dirs, process.platform)
}

export function pathListSplitForHost(list: string): string[] {
  return pathListSplit(list, process.platform)
}

export function platformSpawnOptionsForHost(): { windowsHide?: true } {
  return platformSpawnOptions(process.platform)
}

export function isLexicallyInsideForHost(root: string, candidate: string): boolean {
  return isLexicallyInside(root, candidate, process.platform)
}
