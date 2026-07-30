// RFC-239 — the change-group model: reorganizes a task's changed files into a
// handful of deterministic groups (per-repo → module / docs / config / deps /
// moves / other) that drive BOTH the frontend overview sidebar and the backend
// AI-narrative input — one implementation so "the groups the AI narrates" are
// exactly "the groups the user sees".
//
// Dependency-free leaf (type-only import from the structural-diff schema);
// input is the pure ChangeGroupEntry DTO, NOT the frontend's join product —
// the frontend adapter / backend numstat chain each assemble entries
// themselves (design gate 2nd-round P1-1).

import type { ChangeCount } from './schemas/structuralDiff'

export type ChangeFileKind = 'code' | 'doc' | 'config' | 'deps' | 'binary' | 'other'

export interface ChangeGroupEntry {
  /** Repo-relative path (no repo-label prefix). */
  filePath: string
  /** Canonical repo label for multi-repo tasks; omit for single-repo. */
  repoLabel?: string
  kind: ChangeFileKind
  renamedFrom?: string
  /** Pure rename/move (no content change) — computed by the caller from the
   *  structural side (changes empty / no bodyChanged). rename+edit files carry
   *  false and group normally. */
  pureMove: boolean
  /** Per-file ±line counts; optional — line weights degrade to symbol counts
   *  when the caller has no line source (backend numstat missing / truncated
   *  frontend patch). */
  textStats?: { added: number; removed: number }
  /** Per-file symbol changeType counts (all categories folded together). */
  symbolCounts?: ChangeCount
  /** Pre-computed via shared classifyBreaking (single severity source). */
  severity: { breaking: number; risky: number }
}

export interface ChangeGroupStats {
  files: number
  symbolCounts: ChangeCount
  lines: { added: number; removed: number }
  severity: { breaking: number; risky: number }
}

export interface ChangeGroup {
  /** Stable key: `repo:<label>/` prefix (multi-repo only) + `mod:<seg>` |
   *  'code' | 'docs' | 'config' | 'deps' | 'moves' | 'other'. Narrative group
   *  sentences key off this. */
  key: string
  /** Module segment for code groups; the category token otherwise (frontend
   *  maps category tokens to i18n labels). */
  title: string
  category: 'code' | 'docs' | 'config' | 'deps' | 'moves' | 'other'
  files: ChangeGroupEntry[]
  stats: ChangeGroupStats
  /** Relative magnitude vs the largest group across the whole task, ∈ (0, 1].
   *  Line-based; degrades to symbol-count-based when no group has line stats. */
  weight: number
}

const DOC_EXT_RE = /\.(md|mdx|rst|adoc|txt)$/i
const CONFIG_EXT_RE = /\.(json|jsonc|ya?ml|toml|ini|env(\..+)?)$/i

/** Shared file-kind classifier so the frontend join and the backend narrative
 *  input agree. The caller supplies the three facts only it can know (code =
 *  structural lang resolved; manifest = dependency ecosystem file; binary);
 *  doc/config classify here by extension. Order matters: a manifest like
 *  package.json is 'deps' even though `.json` also matches config. */
export function classifyFileKind(
  filePath: string,
  facts: { isCode: boolean; isManifest: boolean; isBinary: boolean },
): ChangeFileKind {
  if (facts.isManifest) return 'deps'
  if (facts.isCode) return 'code'
  if (DOC_EXT_RE.test(filePath)) return 'doc'
  if (CONFIG_EXT_RE.test(filePath)) return 'config'
  if (facts.isBinary) return 'binary'
  return 'other'
}

/** Code files fold into ONE group when a repo has at most this many. */
const SINGLE_CODE_GROUP_MAX = 4
/** Beyond this many module groups per repo, the smallest fold into 'other code'. */
const MAX_MODULE_GROUPS = 8
const MISC_MODULE_SEG = '__misc__'
/** Title token for files that live at the repo root (no directory). */
export const ROOT_MODULE_SEG = '(root)'

const EMPTY_COUNT: ChangeCount = { added: 0, modified: 0, removed: 0, renamed: 0 }

function addCounts(a: ChangeCount, b: ChangeCount | undefined): ChangeCount {
  if (b === undefined) return a
  return {
    added: a.added + b.added,
    modified: a.modified + b.modified,
    removed: a.removed + b.removed,
    renamed: a.renamed + b.renamed,
  }
}

function countTotal(c: ChangeCount): number {
  return c.added + c.modified + c.removed + c.renamed
}

/** Module segment of a code file: first directory segment after stripping ONE
 *  leading `src` (conservative — only `src`, per design §1.3). Root files map
 *  to `(root)`. */
export function moduleSegment(filePath: string): string {
  const parts = filePath.split('/').filter((p) => p !== '')
  if (parts.length <= 1) return ROOT_MODULE_SEG
  const dirs = parts.slice(0, -1)
  const afterSrc = dirs[0] === 'src' ? dirs.slice(1) : dirs
  return afterSrc.length === 0 ? ROOT_MODULE_SEG : (afterSrc[0] ?? ROOT_MODULE_SEG)
}

function entryLines(e: ChangeGroupEntry): number {
  return e.textStats === undefined ? 0 : e.textStats.added + e.textStats.removed
}

function entrySymbolTotal(e: ChangeGroupEntry): number {
  return e.symbolCounts === undefined ? 0 : countTotal(e.symbolCounts)
}

/** File order inside a group: severity presence (breaking → risky → rest),
 *  then magnitude (lines, falling back to symbol count) descending, then path. */
function fileSortKey(e: ChangeGroupEntry): [number, number, string] {
  const sev = e.severity.breaking > 0 ? 0 : e.severity.risky > 0 ? 1 : 2
  const magnitude = entryLines(e) > 0 ? entryLines(e) : entrySymbolTotal(e)
  return [sev, -magnitude, e.filePath]
}

function compareTuples(a: [number, number, string], b: [number, number, string]): number {
  if (a[0] !== b[0]) return a[0] - b[0]
  if (a[1] !== b[1]) return a[1] - b[1]
  return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0
}

function groupStats(files: ChangeGroupEntry[]): ChangeGroupStats {
  let symbolCounts = EMPTY_COUNT
  let added = 0
  let removed = 0
  let breaking = 0
  let risky = 0
  for (const f of files) {
    symbolCounts = addCounts(symbolCounts, f.symbolCounts)
    added += f.textStats?.added ?? 0
    removed += f.textStats?.removed ?? 0
    breaking += f.severity.breaking
    risky += f.severity.risky
  }
  return {
    files: files.length,
    symbolCounts,
    lines: { added, removed },
    severity: { breaking, risky },
  }
}

/** A group's magnitude for ordering/weights: lines when any line stats exist
 *  anywhere in the task, else total symbol counts (degraded mode). */
function groupMagnitude(stats: ChangeGroupStats, useLines: boolean): number {
  return useLines ? stats.lines.added + stats.lines.removed : countTotal(stats.symbolCounts)
}

const CATEGORY_ORDER: Record<ChangeGroup['category'], number> = {
  code: 0,
  deps: 1,
  docs: 2,
  config: 3,
  moves: 4,
  other: 5,
}

interface RawGroup {
  keySuffix: string
  title: string
  category: ChangeGroup['category']
  files: ChangeGroupEntry[]
}

/** Group one repo's entries (key suffixes only — the caller adds the repo
 *  prefix for multi-repo tasks). `useLines` picks the magnitude source for the
 *  >8-group fold so it matches the global weight mode. */
function groupOneRepo(entries: ChangeGroupEntry[], useLines: boolean): RawGroup[] {
  const moves: ChangeGroupEntry[] = []
  const code: ChangeGroupEntry[] = []
  const byCategory: Record<'docs' | 'config' | 'deps' | 'other', ChangeGroupEntry[]> = {
    docs: [],
    config: [],
    deps: [],
    other: [],
  }
  for (const e of entries) {
    if (e.pureMove && e.renamedFrom !== undefined) moves.push(e)
    else if (e.kind === 'code') code.push(e)
    else if (e.kind === 'doc') byCategory.docs.push(e)
    else if (e.kind === 'config') byCategory.config.push(e)
    else if (e.kind === 'deps') byCategory.deps.push(e)
    else byCategory.other.push(e) // binary + other
  }

  const raw: RawGroup[] = []
  if (code.length > 0 && code.length <= SINGLE_CODE_GROUP_MAX) {
    raw.push({ keySuffix: 'code', title: 'code', category: 'code', files: code })
  } else if (code.length > 0) {
    const bySeg = new Map<string, ChangeGroupEntry[]>()
    for (const e of code) {
      const seg = moduleSegment(e.filePath)
      const arr = bySeg.get(seg)
      if (arr === undefined) bySeg.set(seg, [e])
      else arr.push(e)
    }
    let moduleGroups: RawGroup[] = [...bySeg.entries()].map(([seg, files]) => ({
      keySuffix: `mod:${seg}`,
      title: seg,
      category: 'code' as const,
      files,
    }))
    if (moduleGroups.length > MAX_MODULE_GROUPS) {
      // keep the largest 7 by magnitude, fold the tail into "other code"
      moduleGroups.sort(
        (a, b) =>
          groupMagnitude(groupStats(b.files), useLines) -
          groupMagnitude(groupStats(a.files), useLines),
      )
      const kept = moduleGroups.slice(0, MAX_MODULE_GROUPS - 1)
      const folded = moduleGroups.slice(MAX_MODULE_GROUPS - 1).flatMap((g) => g.files)
      kept.push({
        keySuffix: `mod:${MISC_MODULE_SEG}`,
        title: MISC_MODULE_SEG,
        category: 'code',
        files: folded,
      })
      moduleGroups = kept
    }
    raw.push(...moduleGroups)
  }
  if (byCategory.deps.length > 0)
    raw.push({ keySuffix: 'deps', title: 'deps', category: 'deps', files: byCategory.deps })
  if (byCategory.docs.length > 0)
    raw.push({ keySuffix: 'docs', title: 'docs', category: 'docs', files: byCategory.docs })
  if (byCategory.config.length > 0)
    raw.push({ keySuffix: 'config', title: 'config', category: 'config', files: byCategory.config })
  if (moves.length > 0)
    raw.push({ keySuffix: 'moves', title: 'moves', category: 'moves', files: moves })
  if (byCategory.other.length > 0)
    raw.push({ keySuffix: 'other', title: 'other', category: 'other', files: byCategory.other })
  return raw
}

/** Build the deterministic change groups for a whole task. Multi-repo entries
 *  (repoLabel set) group per repo, repos ordered by first appearance. */
export function buildChangeGroups(entries: ChangeGroupEntry[]): ChangeGroup[] {
  const repoOrder: (string | undefined)[] = []
  const byRepo = new Map<string | undefined, ChangeGroupEntry[]>()
  for (const e of entries) {
    if (!byRepo.has(e.repoLabel)) {
      byRepo.set(e.repoLabel, [])
      repoOrder.push(e.repoLabel)
    }
    byRepo.get(e.repoLabel)?.push(e)
  }

  // Whether ANY entry carries line stats decides the magnitude source globally,
  // so weights stay comparable across groups (degraded ⇒ symbol counts).
  const useLines = entries.some((e) => e.textStats !== undefined)

  const groups: ChangeGroup[] = []
  for (const repoLabel of repoOrder) {
    const repoEntries = byRepo.get(repoLabel) ?? []
    const prefix = repoLabel === undefined ? '' : `repo:${repoLabel}/`
    const raw = groupOneRepo(repoEntries, useLines)
    for (const g of raw) {
      const files = [...g.files].sort((a, b) => compareTuples(fileSortKey(a), fileSortKey(b)))
      groups.push({
        key: `${prefix}${g.keySuffix}`,
        title: g.title,
        category: g.category,
        files,
        stats: groupStats(files),
        weight: 0, // filled below once the global max is known
      })
    }
  }

  const maxMagnitude = Math.max(1, ...groups.map((g) => groupMagnitude(g.stats, useLines)))
  for (const g of groups) {
    // Every group gets a visible sliver even at magnitude 0 (e.g. pure moves).
    g.weight = Math.max(groupMagnitude(g.stats, useLines) / maxMagnitude, 0.02)
  }

  // Order: per-repo blocks in first-appearance order; inside a repo, code
  // groups by magnitude desc, then deps → docs → config → moves → other.
  const repoRank = new Map(repoOrder.map((r, i) => [r ?? '', i]))
  groups.sort((a, b) => {
    const ra =
      repoRank.get(a.key.startsWith('repo:') ? (a.key.split('/')[0] ?? '').slice(5) : '') ?? 0
    const rb =
      repoRank.get(b.key.startsWith('repo:') ? (b.key.split('/')[0] ?? '').slice(5) : '') ?? 0
    if (ra !== rb) return ra - rb
    if (a.category !== b.category) return CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]
    if (a.category === 'code') {
      const ma = groupMagnitude(a.stats, useLines)
      const mb = groupMagnitude(b.stats, useLines)
      if (ma !== mb) return mb - ma
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
  return groups
}
