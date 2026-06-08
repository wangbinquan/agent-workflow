// RFC-091 — `fileTreeRows` was lifted out of `lib/structureView.ts` into a
// neutral `lib/fileTree.ts` so BOTH the structural-diff view and the working-dir
// diff panel (WorktreeDiffPanel) share one folder-tree presentation. These lock
// the pure behavior at its new home; the last test guards the back-compat
// re-export path that StructuralDiffView + structure-view.test.tsx still import.

import { describe, expect, test } from 'vitest'
import { fileTreeRows } from '@/lib/fileTree'
import { fileTreeRows as reexportedFromStructureView } from '@/lib/structureView'

describe('fileTreeRows', () => {
  test('groups files by directory and compacts single-child dir chains', () => {
    const rows = fileTreeRows([
      { filePath: 'src/main/java/com/wbq/Deep.java' },
      { filePath: 'src/main/java/com/wbq/Other.java' },
      { filePath: 'Top.ts' },
    ])
    // the single-child chain `src/main/java/com/wbq` compacts to ONE dir row...
    const dir = rows.find((r) => r.fileIndex === undefined)
    expect(dir?.name).toBe('src/main/java/com/wbq')
    expect(dir?.depth).toBe(0)
    // ...with its files as basenames indented one level under it
    const deep = rows.find((r) => r.name === 'Deep.java')
    expect(deep?.fileIndex).toBe(0)
    expect(deep?.depth).toBe(1)
    // a top-level file stays at depth 0 (no directory row of its own)
    expect(rows.find((r) => r.name === 'Top.ts')?.depth).toBe(0)
  })

  test('directories sort before files, both alphabetically', () => {
    const rows = fileTreeRows([
      { filePath: 'z.ts' },
      { filePath: 'a.ts' },
      { filePath: 'b/inner.ts' },
    ])
    // dir `b` (+ its child) precedes the root files, which are sorted a → z
    expect(rows.map((r) => r.name)).toEqual(['b', 'inner.ts', 'a.ts', 'z.ts'])
  })

  test('a single root-level file yields one depth-0 leaf and no directory rows', () => {
    const rows = fileTreeRows([{ filePath: 'README.md' }])
    expect(rows).toEqual([{ depth: 0, name: 'README.md', fileIndex: 0 }])
  })

  test('back-compat: lib/structureView re-exports the same fileTreeRows', () => {
    expect(reexportedFromStructureView).toBe(fileTreeRows)
  })
})
