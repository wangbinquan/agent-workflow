// RFC-083 PR-D — pure helpers for the structural-diff view. Kept out of the
// components so the aggregation / grouping / badge mapping get unit coverage.

import { diffWordsWithSpace } from 'diff'
import type {
  FileStructuralDiff,
  SymbolChange,
  StructuralDiffSummary,
  ChangeCount,
} from '@agent-workflow/shared'

export function changeTotal(c: ChangeCount): number {
  return c.added + c.modified + c.removed + c.renamed
}

export interface SummaryRow {
  key: 'classes' | 'methods' | 'fields' | 'imports' | 'dependencies'
  count: ChangeCount
  total: number
}

/** Ordered summary-card rows (skipping empty categories). */
export function summaryRows(s: StructuralDiffSummary): SummaryRow[] {
  const rows: Array<{ key: SummaryRow['key']; count: ChangeCount }> = [
    { key: 'classes', count: s.classes },
    { key: 'methods', count: s.methods },
    { key: 'fields', count: s.fields },
    { key: 'imports', count: s.imports },
    { key: 'dependencies', count: s.dependencies },
  ]
  return rows.map((r) => ({ ...r, total: changeTotal(r.count) })).filter((r) => r.total > 0)
}

export interface ChangeGroup {
  /** Container qualifiedName (e.g. `OrderService`), or '' for top-level. */
  container: string
  changes: SymbolChange[]
}

/** Group a file's symbol changes by their enclosing container (the qualifiedName
 *  prefix before the last segment), top-level symbols under ''. */
export function groupFileChanges(file: FileStructuralDiff): ChangeGroup[] {
  const groups = new Map<string, SymbolChange[]>()
  for (const ch of file.changes) {
    const node = ch.after ?? ch.before
    const qn = node?.qualifiedName ?? ''
    const dot = qn.lastIndexOf('.')
    const container = dot > 0 ? qn.slice(0, dot) : ''
    const arr = groups.get(container)
    if (arr === undefined) groups.set(container, [ch])
    else arr.push(ch)
  }
  return [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([container, changes]) => ({ container, changes }))
}

/** Files worth showing in the left list: those with changes, or a non-ok status
 *  worth surfacing (degraded / parse-error). */
export function displayableFiles(files: FileStructuralDiff[]): FileStructuralDiff[] {
  return files.filter(
    (f) => f.changes.length > 0 || f.status === 'degraded' || f.status === 'parse-error',
  )
}

// ---- left-sidebar file tree (group the flat file list by directory) ----
export interface FileTreeRow {
  /** indentation depth (0 = top) */
  depth: number
  /** directory segment(s) name, or the file basename */
  name: string
  /** for files: the index into the original files[] array (selection + data) */
  fileIndex?: number
}

interface TreeNode {
  name: string
  fileIndex?: number
  children: Map<string, TreeNode>
}

/** Build a nested directory tree from the changed files + flatten it to render
 *  rows. Single-child directory chains are COMPACTED into one row (VS-Code style)
 *  so deep packages like `src/main/java/com/wbq/snake` don't over-indent. */
export function fileTreeRows(files: ReadonlyArray<{ filePath: string }>): FileTreeRow[] {
  const root: TreeNode = { name: '', children: new Map() }
  files.forEach((f, idx) => {
    const segs = f.filePath.split('/')
    let node = root
    for (let i = 0; i < segs.length - 1; i += 1) {
      const seg = segs[i] ?? ''
      let child = node.children.get(seg)
      if (child === undefined) {
        child = { name: seg, children: new Map() }
        node.children.set(seg, child)
      }
      node = child
    }
    const base = segs[segs.length - 1] ?? f.filePath
    node.children.set(base, { name: base, fileIndex: idx, children: new Map() })
  })

  const rows: FileTreeRow[] = []
  const walk = (node: TreeNode, depth: number): void => {
    const dirs: TreeNode[] = []
    const leaves: TreeNode[] = []
    for (const c of node.children.values()) (c.fileIndex === undefined ? dirs : leaves).push(c)
    dirs.sort((a, b) => a.name.localeCompare(b.name))
    leaves.sort((a, b) => a.name.localeCompare(b.name))
    for (let d of dirs) {
      // compact single-child dir chains into one row
      let name = d.name
      while (d.children.size === 1) {
        const only = [...d.children.values()][0]
        if (only === undefined || only.fileIndex !== undefined) break
        name = `${name}/${only.name}`
        d = only
      }
      rows.push({ depth, name })
      walk(d, depth + 1)
    }
    for (const l of leaves) rows.push({ depth, name: l.name, fileIndex: l.fileIndex })
  }
  walk(root, 0)
  return rows
}

export function badgeClass(changeType: SymbolChange['changeType']): string {
  switch (changeType) {
    case 'added':
      return 'structure__badge structure__badge--added'
    case 'removed':
      return 'structure__badge structure__badge--removed'
    case 'modified':
      return 'structure__badge structure__badge--modified'
    default:
      return 'structure__badge structure__badge--renamed' // renamed | moved
  }
}

export interface SigToken {
  text: string
  kind: 'same' | 'added' | 'removed'
}

/** RFC-083 (Q1) — token-level diff of a modified callable's declaration
 *  signature, split into a "before" row (old, with removed tokens flagged) and
 *  an "after" row (new, with added tokens flagged). Returns null when there is
 *  nothing meaningful to compare (a side missing, or the two are identical).
 *  Lets the UI show `(a: number): void` → `(a: string, b?: T): void` instead of
 *  a bare "signature changed" tag — the actual param/return delta is what tells
 *  a reviewer whether existing callers will break. */
export function diffSignatureTokens(
  before: string | undefined,
  after: string | undefined,
): { before: SigToken[]; after: SigToken[] } | null {
  const b = before ?? ''
  const a = after ?? ''
  if (b === '' || a === '' || b === a) return null
  const beforeRow: SigToken[] = []
  const afterRow: SigToken[] = []
  for (const part of diffWordsWithSpace(b, a)) {
    if (part.added === true) {
      afterRow.push({ text: part.value, kind: 'added' })
    } else if (part.removed === true) {
      beforeRow.push({ text: part.value, kind: 'removed' })
    } else {
      beforeRow.push({ text: part.value, kind: 'same' })
      afterRow.push({ text: part.value, kind: 'same' })
    }
  }
  return { before: beforeRow, after: afterRow }
}

export function badgeSymbol(changeType: SymbolChange['changeType']): string {
  switch (changeType) {
    case 'added':
      return '+'
    case 'removed':
      return '−' // minus sign
    case 'modified':
      return '~'
    default:
      return '→' // → (renamed/moved)
  }
}
