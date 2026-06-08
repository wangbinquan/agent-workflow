// RFC-091 — neutral, domain-free helper that folds a flat list of file paths
// into a directory tree and flattens it back to indent-able render rows.
//
// Originally lived in `lib/structureView.ts` (RFC-083 PR-D, for the structural
// diff's left-sidebar tree). Lifted here so non-structure components — namely
// `WorktreeDiffPanel` (the working-dir text diff) — can reuse the SAME tree
// presentation without importing from the structure-view domain module.
// `structureView.ts` re-exports it for back-compat.

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
