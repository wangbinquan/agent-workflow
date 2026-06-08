// RFC-021 (Q5) — "viewed" review progress for the worktree diff: which files
// the reviewer has already checked off, persisted per task in localStorage so
// it survives tab switches / navigation / refetch. Reviewing AI-authored diffs
// means walking dozens of files; without a "seen it" marker there is no sense
// of how far through you are. Pure helpers here; WorktreeDiffPanel wires them.
//
// Files are identified by their diff block HEADER (the `a/path b/path` string),
// which is stable across refetch — unlike the index-based render key.

const PREFIX = 'awf.diffViewed.'

export function viewedStorageKey(scope: string): string {
  return `${PREFIX}${scope}`
}

/** Load the persisted viewed-file set for a scope (e.g. a task id). Returns an
 *  empty set when no scope is given, storage is unavailable, or the stored
 *  value is malformed — never throws. */
export function loadViewed(scope: string | undefined): Set<string> {
  if (scope === undefined || typeof localStorage === 'undefined') return new Set()
  try {
    const raw = localStorage.getItem(viewedStorageKey(scope))
    if (raw === null) return new Set()
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? new Set(parsed.filter((x): x is string => typeof x === 'string'))
      : new Set()
  } catch {
    return new Set()
  }
}

/** Persist the viewed-file set for a scope. Best-effort: no-ops when there is
 *  no scope or storage is unavailable / over quota. */
export function saveViewed(scope: string | undefined, viewed: ReadonlySet<string>): void {
  if (scope === undefined || typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(viewedStorageKey(scope), JSON.stringify([...viewed]))
  } catch {
    /* quota exceeded / storage disabled — viewed state stays in-memory only */
  }
}

/** Pure toggle: a new set with `key` added (if absent) or removed (if present). */
export function toggleViewed(viewed: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(viewed)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  return next
}

/** Review progress over the current file keys. Only keys still present in the
 *  diff count — a file that dropped out of the diff must not inflate either the
 *  numerator or the denominator. */
export function viewedProgress(
  fileKeys: ReadonlyArray<string>,
  viewed: ReadonlySet<string>,
): { viewed: number; total: number } {
  const present = new Set(fileKeys)
  let n = 0
  for (const k of present) if (viewed.has(k)) n += 1
  return { viewed: n, total: present.size }
}
