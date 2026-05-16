// RFC-021: worktree diff with a vertical per-file tab list on the left
// and the selected file's hunks on the right.
//
// Why a panel and not just `<DiffViewer>` inside the tab pane: tasks
// routinely touch dozens of files, sometimes hundreds. Stacking every
// file vertically forces the user to scroll past a huge tree of hunks
// they don't care about. A vertical tab list (left) + single-file body
// (right) caps right-pane DOM at one file no matter the diff size.

import { useEffect, useMemo, useState } from 'react'
import { DiffFileBody, splitByFile, type FileBlock } from './DiffViewer'

interface Props {
  diff: string
  truncated?: boolean
}

export function WorktreeDiffPanel({ diff, truncated }: Props) {
  const blocks = useMemo(() => splitByFile(diff), [diff])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  // Self-heal: when the diff string changes (resume / refetch) the
  // previously selected file may no longer exist. Fall back to the
  // first block so the right pane always renders something.
  useEffect(() => {
    if (blocks.length === 0) {
      if (selectedKey !== null) setSelectedKey(null)
      return
    }
    const first = blocks[0]
    if (first === undefined) return
    const firstKey = keyOf(first, 0)
    if (selectedKey === null || !blocks.some((b, i) => keyOf(b, i) === selectedKey)) {
      setSelectedKey(firstKey)
    }
  }, [blocks, selectedKey])

  if (diff.trim() === '') {
    return <div className="diff diff--empty muted">No changes since the task started.</div>
  }

  const selected = blocks.find((b, i) => keyOf(b, i) === selectedKey) ?? blocks[0]

  return (
    <div className="worktree-diff">
      <aside className="worktree-diff__files">
        {truncated === true && (
          <div className="worktree-diff__truncated diff__truncated">
            ⚠ Diff truncated at 1 MiB. View the worktree directly for the full output.
          </div>
        )}
        <nav role="tablist" aria-orientation="vertical" className="worktree-diff__tablist">
          {blocks.map((b, i) => {
            const k = keyOf(b, i)
            const isActive =
              selected !== undefined && keyOf(selected, blocks.indexOf(selected)) === k
            return (
              <button
                type="button"
                key={k}
                role="tab"
                aria-selected={isActive}
                title={b.header}
                className={`worktree-diff__file-tab ${isActive ? 'worktree-diff__file-tab--active' : ''}`}
                onClick={() => setSelectedKey(k)}
              >
                {b.header}
              </button>
            )
          })}
        </nav>
      </aside>
      <section className="worktree-diff__body">
        {selected !== undefined ? <DiffFileBody block={selected} /> : null}
      </section>
    </div>
  )
}

function keyOf(block: FileBlock, idx: number): string {
  // `header` is generally unique across blocks (one `diff --git a/X b/Y`
  // per file), but the splitter can emit a synthetic `(preamble)` block
  // and theoretically two renames could collide; suffix with index for
  // deterministic uniqueness.
  return `${idx}::${block.header}`
}
