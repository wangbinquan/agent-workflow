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

import { dirname, posix, win32 } from 'node:path'

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

// --- controlled PATH assembly (RFC-254 T12 / design gate P0-A) ---------------

/**
 * The system directories a sealed child needs on its PATH, and nothing else.
 *
 * This is a CAPABILITY WHITELIST, not an inheritance of the daemon's PATH — the
 * sealed process must not see the operator's tool installs. POSIX has needed
 * only `/usr/bin:/bin` because every base utility lives there; Windows spreads
 * the equivalents across four directories under `%SystemRoot%`, and omitting
 * `System32` alone leaves the child unable to start at all.
 *
 * `WindowsPowerShell\v1.0` is included because OpenCode's own shell selection
 * probes `pwsh` then `powershell` before falling back to `cmd`
 * (opencode `core/src/shell.ts:98-106`); without it the agent silently drops to
 * the weakest shell dialect on the list.
 */
export function controlledSystemPathEntries(
  platform: NodeJS.Platform,
  systemRoot: string | undefined,
): string[] {
  if (platform !== 'win32') return ['/usr/bin', '/bin']
  const root = systemRoot !== undefined && systemRoot.length > 0 ? systemRoot : 'C:\\Windows'
  return [
    `${root}\\System32`,
    root,
    `${root}\\System32\\Wbem`,
    `${root}\\System32\\WindowsPowerShell\\v1.0`,
  ]
}

/**
 * Assemble the full controlled PATH: seal-private tool directories first, then
 * the platform's system entries.
 *
 * `extraLeading` is where run-scoped seals go (the frozen Bun snapshot, and on
 * Windows the resolved git directory — see below). Order matters: a sealed copy
 * must win over anything the system directories happen to also provide.
 *
 * WHY GIT HAS TO BE PASSED IN HERE (design gate P0-A):
 * on POSIX the agent's git is free — `/usr/bin` already contains it, so nobody
 * ever had to think about it. Windows installs git under
 * `C:\Program Files\Git\cmd`, which is in NO system directory, so a controlled
 * PATH built from system entries alone leaves the agent with no `git` at all —
 * every `git status`/`diff`/`commit` fails and the platform's core
 * Code → Audit → Fix workflow cannot run. It also breaks OpenCode's own Git
 * Bash discovery, which resolves through `which("git")`.
 */
export function buildControlledPath(
  extraLeading: readonly string[],
  platform: NodeJS.Platform,
  systemRoot: string | undefined,
): string {
  const seen = new Set<string>()
  const entries: string[] = []
  for (const entry of [...extraLeading, ...controlledSystemPathEntries(platform, systemRoot)]) {
    if (entry.length === 0) continue
    const key = platform === 'win32' ? entry.toLowerCase() : entry
    if (seen.has(key)) continue
    seen.add(key)
    entries.push(entry)
  }
  return pathListJoin(entries, platform)
}

export function buildControlledPathForHost(extraLeading: readonly string[] = []): string {
  // Parse with the TARGET platform's rules, not the host's. `node:path`'s
  // default `dirname` is the host flavour, so on a POSIX box it finds no
  // separator in `C:\Program Files\Git\cmd\git.exe` and answers '.' — which
  // would put a bogus entry on the controlled PATH. (Caught by a T22 test that
  // exercised the same mistake in the script-node resolver.)
  const dirnameFor = process.platform === 'win32' ? win32.dirname : dirname
  const git = resolveGitToolDirectory(process.platform, (cmd) => Bun.which(cmd), dirnameFor)
  return buildControlledPath(
    git === null ? extraLeading : [...extraLeading, git],
    process.platform,
    process.env.SystemRoot,
  )
}

/**
 * The directory holding the host's `git`, frozen for a run's controlled PATH.
 *
 * Returns null on POSIX: `/usr/bin` is already on the controlled PATH there, so
 * adding anything would widen the whitelist for no gain. On Windows it resolves
 * the real `git` executable and returns its directory.
 *
 * Trust note: git is a binary this platform ALREADY executes under the daemon's
 * own identity for every worktree operation (`util/git.ts`), so exposing it to
 * the sealed shell introduces no new trusted party. What it must NOT do is
 * leak the rest of the operator's PATH or home directory — hence a single
 * resolved directory rather than an inherited search list.
 */
export function resolveGitToolDirectory(
  platform: NodeJS.Platform,
  which: (cmd: string) => string | null,
  dirnameOf: (p: string) => string,
): string | null {
  if (platform !== 'win32') return null
  const resolved = which('git')
  if (resolved === null || resolved.length === 0) return null
  return dirnameOf(resolved)
}

/**
 * RFC-254 T23 — the PATH a script node's interpreter runs with.
 *
 * Same capability-whitelist principle as the agent's controlled PATH: the
 * interpreter's own directory first (so the resolved interpreter wins over any
 * same-named binary on the system path), then the platform's base directories.
 * POSIX keeps the historical five-entry list byte-for-byte.
 */
export function buildScriptPath(
  interpreterDir: string,
  platform: NodeJS.Platform,
  systemRoot: string | undefined,
): string {
  const base =
    platform === 'win32'
      ? controlledSystemPathEntries('win32', systemRoot)
      : ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']
  return pathListJoin(
    [interpreterDir, ...base].filter((p) => p.length > 0),
    platform,
  )
}
