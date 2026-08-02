// RFC-239 — pure helpers for the unified structural-change view: join the
// textual diff (all files) with the structural diff (code/manifest files) into
// per-file entries, classify file kinds, parse hunk ranges, and adapt entries
// into the shared change-group DTO. JSX stays in components/changes/*.
//
// The FILE universe is the textual diff's block list (it has every changed
// file); structural data joins in per path. Multi-repo: text blocks arrive in
// `# === Repo: <label> ===` groups while structural paths carry a `label/`
// prefix — both sides use the backend's canonicalRepoKeys (RFC-248: the key IS
// the mount path), so joining is
// exact label equality (unjoinable rows keep their single side, never dropped).

import type { FileStructuralDiff, StructuralDiff, ChangeGroupEntry } from '@agent-workflow/shared'
import { classifyFileKind, severityCounts, type ChangeFileKind } from '@agent-workflow/shared'
import type { FileBlock, RepoGroup } from '@/components/DiffViewer'

/** One hunk's line coordinates: sides in file line numbers, body in block-line
 *  indexes (for scroll targets). A zero `count` side is an EMPTY range (pure
 *  add has no old side, pure delete no new side) — design gate P0-1. */
export interface HunkInfo {
  /** Index of the `@@` line within the block's `lines`. */
  headerIndex: number
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

export function parseHunks(lines: readonly string[]): HunkInfo[] {
  const out: HunkInfo[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = HUNK_RE.exec(lines[i] ?? '')
    if (m === null) continue
    out.push({
      headerIndex: i,
      oldStart: Number(m[1]),
      oldCount: m[2] === undefined ? 1 : Number(m[2]),
      newStart: Number(m[3]),
      newCount: m[4] === undefined ? 1 : Number(m[4]),
    })
  }
  return out
}

/** Split a block's lines into render segments: one preamble (diff --git /
 *  index headers, hunk=null) followed by ONE segment per hunk spanning its
 *  `@@` header through the line before the next header (impl-gate P2: the
 *  first cut produced empty hunk segments and dropped every body into a
 *  null segment, breaking owner badges and scroll targets). */
export interface DiffSegment {
  start: number
  end: number
  hunk: HunkInfo | null
}

export function buildDiffSegments(
  lines: readonly string[],
  hunks: readonly HunkInfo[],
): DiffSegment[] {
  if (hunks.length === 0) return [{ start: 0, end: lines.length, hunk: null }]
  const segments: DiffSegment[] = []
  const first = hunks[0]
  if (first !== undefined && first.headerIndex > 0) {
    segments.push({ start: 0, end: first.headerIndex, hunk: null })
  }
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i]
    if (h === undefined) continue
    const next = hunks[i + 1]
    segments.push({
      start: h.headerIndex,
      end: next === undefined ? lines.length : next.headerIndex,
      hunk: h,
    })
  }
  return segments
}

/** ±line counts from a block's hunk body lines (excludes headers). */
export function blockTextStats(lines: readonly string[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  let inHunk = false
  for (const l of lines) {
    if (HUNK_RE.test(l)) {
      inHunk = true
      continue
    }
    if (!inHunk) continue
    if (l.startsWith('+')) added += 1
    else if (l.startsWith('-')) removed += 1
  }
  return { added, removed }
}

/** The 8 structural languages, for kind classification when a file has no
 *  structural record (e.g. the structural API failed but the text diff loaded). */
const CODE_EXT_RE = /\.(c|cc|cpp|cxx|h|hh|hpp|java|py|rs|go|js|jsx|mjs|cjs|ts|tsx|scala|sc)$/i
/** Common dependency manifests (backend `deps/manifests.ts` is authoritative;
 *  this is only the no-structural-data fallback). */
const MANIFEST_BASENAME_RE =
  /(^|\/)(package\.json|cargo\.toml|go\.mod|requirements[^/]*\.txt|pyproject\.toml|pom\.xml|build\.gradle(\.kts)?|build\.sbt|vcpkg\.json|conanfile\.(txt|py)|CMakeLists\.txt)$/i

export interface ChangeFileEntry {
  /** Stable selection key (repo label + path). */
  key: string
  /** Repo-relative path (new side). */
  filePath: string
  repoLabel: string | null
  kind: ChangeFileKind
  block?: FileBlock
  hunks: HunkInfo[]
  structural?: FileStructuralDiff
  renamedFrom?: string
  pureMove: boolean
  textStats: { added: number; removed: number }
  severity: { breaking: number; risky: number }
  /** Key the file is tracked under in the persisted viewed set — byte-equal to
   *  the pre-merge WorktreeDiffPanel format so old progress keeps matching
   *  (design gate P1-4): rename headers are `old → new`, multi-repo prefixes
   *  `repo::`. */
  viewedKey: string
}

/** New-side path of a text block header (`old → new` renames map to new). */
export function diffFilePath(header: string): string {
  const i = header.indexOf(' → ')
  return i === -1 ? header : header.slice(i + ' → '.length)
}

function renamedFromOfHeader(header: string): string | undefined {
  const i = header.indexOf(' → ')
  return i === -1 ? undefined : header.slice(0, i)
}

/** Strip the `label/` prefix a multi-repo structural file path carries. */
function stripLabel(path: string, label: string): string {
  return path.startsWith(`${label}/`) ? path.slice(label.length + 1) : path
}

/**
 * Join text-diff repo groups with the structural diff into per-file entries.
 * `structural` may be undefined (API failed / still loading) — entries then
 * carry text-side data only and the sidebar degrades gracefully.
 */
export function buildChangeEntries(
  groups: readonly RepoGroup[],
  structural: StructuralDiff | undefined,
): ChangeFileEntry[] {
  // Multi-repo identity must survive the text diff being unavailable (GC'd
  // worktree, structural-only fallback): the merged structural artifact stamps
  // fromRef='multi', so canonical `label/rel` keys keep their repo split
  // (impl-gate P2 — treating them as single-repo paths lost grouping AND made
  // file-content requests target the wrong repo with an invalid path).
  const multiRepo = groups.some((g) => g.repo !== null) || structural?.fromRef === 'multi'
  const structuralByKey = new Map<string, FileStructuralDiff>()
  const manifestPaths = new Set<string>()
  if (structural !== undefined) {
    for (const f of structural.files) structuralByKey.set(f.filePath, f)
    for (const d of structural.dependencyChanges) {
      if (d.manifestPath !== undefined) manifestPaths.add(d.manifestPath)
    }
  }

  const entries: ChangeFileEntry[] = []
  const seen = new Set<string>()
  for (const g of groups) {
    for (const block of g.blocks) {
      if (block.header === '(preamble)') continue
      const rel = diffFilePath(block.header)
      const structuralKey = g.repo === null ? rel : `${g.repo}/${rel}`
      const f = structuralByKey.get(structuralKey)
      const textStats = blockTextStats(block.lines)
      const renamedFrom =
        f?.renamedFrom !== undefined
          ? g.repo === null
            ? f.renamedFrom
            : stripLabel(f.renamedFrom, g.repo)
          : renamedFromOfHeader(block.header)
      const sev = f === undefined ? { breaking: 0, risky: 0, safe: 0 } : severityCounts([f])
      entries.push({
        key: structuralKey,
        filePath: rel,
        repoLabel: g.repo,
        kind: classifyFileKind(rel, {
          isCode: f !== undefined ? f.lang !== 'unknown' : CODE_EXT_RE.test(rel),
          isManifest: manifestPaths.has(structuralKey) || MANIFEST_BASENAME_RE.test(rel),
          isBinary:
            f?.status === 'skipped-binary' ||
            block.lines.some((l) => l.startsWith('Binary files ')),
        }),
        block,
        hunks: parseHunks(block.lines),
        structural: f,
        renamedFrom,
        pureMove:
          renamedFrom !== undefined &&
          (f !== undefined ? f.changes.length === 0 : textStats.added + textStats.removed === 0),
        textStats,
        severity: { breaking: sev.breaking, risky: sev.risky },
        viewedKey: g.repo === null ? block.header : `${g.repo}::${block.header}`,
      })
      seen.add(structuralKey)
    }
  }
  // Structural-only files (e.g. the text diff hit its 1 MiB truncation and lost
  // whole blocks): keep them so the sidebar never under-reports — the detail
  // pane shows a "text diff unavailable" note for them.
  if (structural !== undefined) {
    for (const [key, f] of structuralByKey) {
      if (seen.has(key)) continue
      const label = multiRepo ? (key.includes('/') ? (key.split('/')[0] ?? null) : null) : null
      const rel = label === null ? key : stripLabel(key, label)
      const sev = severityCounts([f])
      entries.push({
        key,
        filePath: rel,
        repoLabel: label,
        kind: classifyFileKind(rel, {
          isCode: f.lang !== 'unknown',
          isManifest: manifestPaths.has(key),
          isBinary: f.status === 'skipped-binary',
        }),
        hunks: [],
        structural: f,
        renamedFrom:
          f.renamedFrom === undefined
            ? undefined
            : label === null
              ? f.renamedFrom
              : stripLabel(f.renamedFrom, label),
        pureMove: f.renamedFrom !== undefined && f.changes.length === 0,
        textStats: { added: 0, removed: 0 },
        severity: { breaking: sev.breaking, risky: sev.risky },
        viewedKey:
          label === null
            ? f.renamedFrom !== undefined
              ? `${rel} → ${rel}`
              : rel
            : `${label}::${rel}`,
      })
    }
  }
  return entries
}

/** Sum per-file symbol changeType counts (renamed+moved fold into renamed). */
function symbolCountsOf(f: FileStructuralDiff): {
  added: number
  modified: number
  removed: number
  renamed: number
} {
  const counts = { added: 0, modified: 0, removed: 0, renamed: 0 }
  for (const c of f.changes) {
    if (c.changeType === 'renamed' || c.changeType === 'moved') counts.renamed += 1
    else counts[c.changeType] += 1
  }
  return counts
}

/** Adapt joined entries to the shared change-group DTO (the pure input
 *  `buildChangeGroups` consumes — same shape the backend narrative builds). */
export function toGroupEntries(entries: readonly ChangeFileEntry[]): ChangeGroupEntry[] {
  return entries.map((e) => ({
    filePath: e.filePath,
    ...(e.repoLabel === null ? {} : { repoLabel: e.repoLabel }),
    kind: e.kind,
    ...(e.renamedFrom === undefined ? {} : { renamedFrom: e.renamedFrom }),
    pureMove: e.pureMove,
    textStats: e.textStats,
    ...(e.structural === undefined ? {} : { symbolCounts: symbolCountsOf(e.structural) }),
    severity: e.severity,
  }))
}
