// RFC-021: worktree diff with a vertical per-file list on the left and the
// selected file's hunks on the right.
//
// Why a panel and not just `<DiffViewer>` inside the tab pane: tasks
// routinely touch dozens of files, sometimes hundreds. Stacking every
// file vertically forces the user to scroll past a huge tree of hunks
// they don't care about. A vertical file list (left) + single-file body
// (right) caps right-pane DOM at one file no matter the diff size.
//
// RFC-091: the left file column is a folder TREE (not a flat list) — files are
// grouped under non-interactive directory header rows, shown by basename and
// indented, with single-child dir chains compacted (VS-Code style). It reuses
// `fileTreeRows()` — the SAME pure helper the structural-diff view uses — so the
// two panels look identical. Files still each render as a `role="tab"`; directory
// rows are plain text. Keyboard navigation steps through files in their VISUAL
// (top-to-bottom) order, which `fileTreeRows` reorders by directory — so the
// nav order follows the rendered tree, not the raw diff order.
//
// RFC-066 multi-repo: the backend concatenates each repo's diff behind a
// `# === Repo: <name> ===` marker. `splitByRepo` segments on those markers so
// each repo gets its own heading + its own folder tree — and, crucially, files
// at the SAME path in different repos get distinct selection + "viewed" keys
// instead of colliding. Single-repo diffs carry no marker → one null-repo
// group → identical rendering and identical (bare-header) viewed keys, so
// previously-persisted progress keeps matching.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DiffFileBody, splitByRepo, type FileBlock } from './DiffViewer'
import { fileTreeRows } from '@/lib/fileTree'
import { loadViewed, saveViewed, toggleViewed, viewedProgress } from '@/lib/diffViewed'

interface Props {
  diff: string
  truncated?: boolean
  /** RFC-083: when set/changed, select the file block whose header contains
   *  this path (text↔structure cross-nav from the structural diff view). */
  focusFilePath?: string | null
  /** RFC-021 (Q5): scope for persisting per-file "viewed" review progress
   *  (typically the task id). Omit to keep viewed state in-memory only. */
  storageKey?: string
}

interface Item {
  /** Globally-unique render/selection key (group + block index + header). */
  selKey: string
  /** Key the file is tracked under in the viewed set. Bare header for a
   *  single-repo diff (back-compat with persisted progress); repo-qualified
   *  for multi-repo so same-path files across repos stay distinct. */
  viewedKey: string
  /** Repo name for the group this file belongs to, or null (single-repo). */
  repo: string | null
  block: FileBlock
}

/** One left-column render row: a repo heading, a directory header, or a file. */
type RenderRow =
  | { kind: 'repo'; key: string; repo: string }
  | { kind: 'dir'; key: string; depth: number; name: string }
  | { kind: 'file'; key: string; depth: number; name: string; item: Item }

/** Build the Item for a (group, block) pair — selection + viewed keys. */
function makeItem(gi: number, repo: string | null, bi: number, b: FileBlock): Item {
  return {
    selKey: `${gi}:${bi}::${b.header}`,
    viewedKey: repo === null ? b.header : `${repo}::${b.header}`,
    repo,
    block: b,
  }
}

/** Path a file block sits at in the folder tree. A rename header is
 *  `old → new` (see deriveFileHeader) — place it under the NEW path so the
 *  tree reflects where the file ends up; the full `old → new` stays in the
 *  tab's title. Non-renames (and the `(preamble)` pseudo-block) pass through. */
function diffFilePath(header: string): string {
  const i = header.indexOf(' → ')
  return i === -1 ? header : header.slice(i + ' → '.length)
}

export function WorktreeDiffPanel({ diff, truncated, focusFilePath, storageKey }: Props) {
  const { t } = useTranslation()
  const groups = useMemo(() => splitByRepo(diff), [diff])

  // Flat file list in raw (group, block) order — the state truth source for
  // viewed keys, focus matching, self-heal existence checks, and progress.
  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    groups.forEach((g, gi) => g.blocks.forEach((b, bi) => out.push(makeItem(gi, g.repo, bi, b))))
    return out
  }, [groups])

  // Visual render rows: per repo, an optional heading + a folder tree
  // (fileTreeRows) whose leaves map back to file Items. `fileOrder` is the
  // file selKeys in top-to-bottom VISUAL order — what keyboard nav steps over.
  const { rows, fileOrder } = useMemo(() => {
    const rows: RenderRow[] = []
    const fileOrder: string[] = []
    groups.forEach((g, gi) => {
      if (g.repo !== null) rows.push({ kind: 'repo', key: `repo:${gi}`, repo: g.repo })
      const treeRows = fileTreeRows(g.blocks.map((b) => ({ filePath: diffFilePath(b.header) })))
      treeRows.forEach((tr, ri) => {
        if (tr.fileIndex === undefined) {
          rows.push({
            kind: 'dir',
            key: `dir:${gi}:${ri}:${tr.name}`,
            depth: tr.depth,
            name: tr.name,
          })
          return
        }
        const b = g.blocks[tr.fileIndex]
        if (b === undefined) return
        const item = makeItem(gi, g.repo, tr.fileIndex, b)
        rows.push({ kind: 'file', key: item.selKey, depth: tr.depth, name: tr.name, item })
        fileOrder.push(item.selKey)
      })
    })
    return { rows, fileOrder }
  }, [groups])

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  // RFC-021 (Q5) — which files the reviewer has checked off, persisted per task.
  const [viewed, setViewed] = useState<ReadonlySet<string>>(() => loadViewed(storageKey))
  useEffect(() => setViewed(loadViewed(storageKey)), [storageKey])
  const markViewed = useCallback(
    (viewedKey: string): void =>
      setViewed((prev) => {
        const next = toggleViewed(prev, viewedKey)
        saveViewed(storageKey, next)
        return next
      }),
    [storageKey],
  )

  // Keyboard file switching. The left list is already a vertical
  // `role="tablist"`, whose ARIA contract is Up/Down to move between tabs. Each
  // file tab keeps a ref so selecting one can pull focus onto it: that keeps the
  // focus ring, scroll-into-view, and the roving tab stop in sync with the shown
  // file, and lets repeated Arrow presses continue from the new position even on
  // browsers that don't focus a <button> on click (Safari / Firefox on macOS).
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const selectFile = useCallback((key: string) => {
    setSelectedKey(key)
    tabRefs.current.get(key)?.focus()
  }, [])

  // Up/Down (+ Home/End) move between files in their VISUAL (tree) order; Space
  // toggles the current file's "viewed" mark. Scoped to the list via onKeyDown —
  // NOT a global window listener — so it never hijacks these keys while the diff
  // body on the right is being scrolled.
  const onTablistKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (fileOrder.length === 0) return
      const currentKey = selectedKey ?? fileOrder[0]
      const pos = fileOrder.indexOf(currentKey ?? '')
      const go = (p: number): void => {
        const next = fileOrder[Math.max(0, Math.min(fileOrder.length - 1, p))]
        if (next !== undefined) selectFile(next)
      }
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          go(pos + 1)
          break
        case 'ArrowUp':
          e.preventDefault()
          go(pos - 1)
          break
        case 'Home':
          e.preventDefault()
          go(0)
          break
        case 'End':
          e.preventDefault()
          go(fileOrder.length - 1)
          break
        case ' ':
        case 'Spacebar': {
          // Space toggles the current file's "viewed" mark — a keyboard shortcut
          // for the per-file checkbox. Skip when the Space came from the checkbox
          // itself: it toggles natively, and handling it here too would
          // double-toggle to a no-op. preventDefault otherwise stops the page
          // from scrolling (Space's default) and the tab from re-activating.
          if ((e.target as HTMLElement).tagName === 'INPUT') break
          e.preventDefault()
          const cur = items.find((it) => it.selKey === (selectedKey ?? fileOrder[0]))
          if (cur !== undefined) markViewed(cur.viewedKey)
          break
        }
      }
    },
    [fileOrder, items, selectedKey, selectFile, markViewed],
  )

  // Jump-to-file: when an external focus request arrives, select the block whose
  // header references that path. Header is `diff --git a/<p> b/<p>` so a
  // substring match is reliable. Re-runs on focus changes (incl. re-clicks via
  // the request token the caller may bump).
  useEffect(() => {
    if (focusFilePath === null || focusFilePath === undefined || focusFilePath === '') return
    const hit = items.find((it) => it.block.header.includes(focusFilePath))
    if (hit !== undefined) setSelectedKey(hit.selKey)
  }, [focusFilePath, items])

  // Self-heal: when the diff string changes (resume / refetch) the previously
  // selected file may no longer exist. Fall back to the first VISIBLE file so the
  // right pane always renders something and the first rendered tab is selected.
  useEffect(() => {
    if (fileOrder.length === 0) {
      if (selectedKey !== null) setSelectedKey(null)
      return
    }
    if (selectedKey === null || !fileOrder.includes(selectedKey)) {
      setSelectedKey(fileOrder[0] ?? null)
    }
  }, [fileOrder, selectedKey])

  if (diff.trim() === '') {
    return <div className="diff diff--empty muted">{t('tasks.diffNoChanges')}</div>
  }

  const selected =
    items.find((it) => it.selKey === selectedKey) ?? items.find((it) => it.selKey === fileOrder[0])
  const progress = viewedProgress(
    items.map((it) => it.viewedKey),
    viewed,
  )

  return (
    <div className="worktree-diff">
      <aside className="worktree-diff__files">
        {truncated === true && (
          <div className="worktree-diff__truncated diff__truncated">
            {t('tasks.diffTruncatedBanner')}
          </div>
        )}
        <div className="worktree-diff__progress" data-testid="diff-viewed-progress">
          {t('tasks.diffViewedProgress', { n: progress.viewed, total: progress.total })}
        </div>
        <nav
          role="tablist"
          aria-orientation="vertical"
          className="worktree-diff__tablist"
          onKeyDown={onTablistKeyDown}
        >
          {rows.map((row) => {
            if (row.kind === 'repo') {
              return (
                <div
                  key={row.key}
                  className="worktree-diff__repo"
                  data-testid="diff-repo-group"
                  title={row.repo}
                >
                  {row.repo}
                </div>
              )
            }
            if (row.kind === 'dir') {
              return (
                <div
                  key={row.key}
                  className="worktree-diff__tree-dir"
                  data-testid="diff-tree-dir"
                  style={{ paddingLeft: `${8 + row.depth * 14}px` }}
                  title={row.name}
                >
                  {row.name}
                </div>
              )
            }
            const it = row.item
            const isActive = selected !== undefined && selected.selKey === it.selKey
            const isViewed = viewed.has(it.viewedKey)
            const ariaFile = it.repo !== null ? `${it.repo}/${it.block.header}` : it.block.header
            return (
              <div
                key={row.key}
                className={`worktree-diff__file-row ${isViewed ? 'worktree-diff__file-row--viewed' : ''}`}
                style={{ paddingLeft: `${8 + row.depth * 14}px` }}
              >
                <input
                  type="checkbox"
                  className="worktree-diff__viewed"
                  checked={isViewed}
                  aria-label={t('tasks.diffMarkViewed', { file: ariaFile })}
                  onChange={() => markViewed(it.viewedKey)}
                />
                <button
                  type="button"
                  role="tab"
                  ref={(el) => {
                    if (el !== null) tabRefs.current.set(it.selKey, el)
                    else tabRefs.current.delete(it.selKey)
                  }}
                  // Roving tab stop: only the active file tab is in the Tab
                  // order; Up/Down then move among the rest (ARIA tablist).
                  tabIndex={isActive ? 0 : -1}
                  aria-selected={isActive}
                  title={it.block.header}
                  className={`worktree-diff__file-tab ${isActive ? 'worktree-diff__file-tab--active' : ''}`}
                  onClick={() => selectFile(it.selKey)}
                >
                  {row.name}
                </button>
              </div>
            )
          })}
        </nav>
      </aside>
      <section className="worktree-diff__body">
        {selected !== undefined ? <DiffFileBody block={selected.block} /> : null}
      </section>
    </div>
  )
}
