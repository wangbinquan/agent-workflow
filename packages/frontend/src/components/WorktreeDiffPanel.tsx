// RFC-021: worktree diff with a vertical per-file tab list on the left
// and the selected file's hunks on the right.
//
// Why a panel and not just `<DiffViewer>` inside the tab pane: tasks
// routinely touch dozens of files, sometimes hundreds. Stacking every
// file vertically forces the user to scroll past a huge tree of hunks
// they don't care about. A vertical tab list (left) + single-file body
// (right) caps right-pane DOM at one file no matter the diff size.
//
// RFC-066 multi-repo: the backend concatenates each repo's diff behind a
// `# === Repo: <name> ===` marker. `splitByRepo` segments on those markers so
// the file column is grouped under per-repo headings — and, crucially, files
// at the SAME path in different repos get distinct selection + "viewed" keys
// instead of colliding. Single-repo diffs carry no marker → one null-repo
// group → identical rendering and identical (bare-header) viewed keys, so
// previously-persisted progress keeps matching.

import { Fragment, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DiffFileBody, splitByRepo, type FileBlock } from './DiffViewer'
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

export function WorktreeDiffPanel({ diff, truncated, focusFilePath, storageKey }: Props) {
  const { t } = useTranslation()
  const groups = useMemo(() => splitByRepo(diff), [diff])
  // Flatten groups to render-order items with unique selection keys and
  // repo-qualified viewed keys.
  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    groups.forEach((g, gi) => {
      g.blocks.forEach((b, bi) => {
        out.push({
          selKey: `${gi}:${bi}::${b.header}`,
          viewedKey: g.repo === null ? b.header : `${g.repo}::${b.header}`,
          repo: g.repo,
          block: b,
        })
      })
    })
    return out
  }, [groups])

  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  // RFC-021 (Q5) — which files the reviewer has checked off, persisted per task.
  const [viewed, setViewed] = useState<ReadonlySet<string>>(() => loadViewed(storageKey))
  useEffect(() => setViewed(loadViewed(storageKey)), [storageKey])
  const markViewed = (viewedKey: string): void =>
    setViewed((prev) => {
      const next = toggleViewed(prev, viewedKey)
      saveViewed(storageKey, next)
      return next
    })

  // Jump-to-file: when an external focus request arrives, select the block whose
  // header references that path. Header is `diff --git a/<p> b/<p>` so a
  // substring match is reliable. Re-runs on focus changes (incl. re-clicks via
  // the request token the caller may bump).
  useEffect(() => {
    if (focusFilePath === null || focusFilePath === undefined || focusFilePath === '') return
    const hit = items.find((it) => it.block.header.includes(focusFilePath))
    if (hit !== undefined) setSelectedKey(hit.selKey)
  }, [focusFilePath, items])

  // Self-heal: when the diff string changes (resume / refetch) the
  // previously selected file may no longer exist. Fall back to the
  // first block so the right pane always renders something.
  useEffect(() => {
    if (items.length === 0) {
      if (selectedKey !== null) setSelectedKey(null)
      return
    }
    const firstKey = items[0]!.selKey
    if (selectedKey === null || !items.some((it) => it.selKey === selectedKey)) {
      setSelectedKey(firstKey)
    }
  }, [items, selectedKey])

  if (diff.trim() === '') {
    return <div className="diff diff--empty muted">{t('tasks.diffNoChanges')}</div>
  }

  const selected = items.find((it) => it.selKey === selectedKey) ?? items[0]
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
        <nav role="tablist" aria-orientation="vertical" className="worktree-diff__tablist">
          {items.map((it, idx) => {
            // Emit a repo heading at each repo boundary (multi-repo only).
            const showRepo = it.repo !== null && (idx === 0 || items[idx - 1]?.repo !== it.repo)
            const isActive = selected !== undefined && selected.selKey === it.selKey
            const isViewed = viewed.has(it.viewedKey)
            const ariaFile = it.repo !== null ? `${it.repo}/${it.block.header}` : it.block.header
            return (
              <Fragment key={it.selKey}>
                {showRepo && (
                  <div
                    className="worktree-diff__repo"
                    data-testid="diff-repo-group"
                    title={it.repo!}
                  >
                    {it.repo}
                  </div>
                )}
                <div
                  className={`worktree-diff__file-row ${isViewed ? 'worktree-diff__file-row--viewed' : ''}`}
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
                    aria-selected={isActive}
                    title={it.block.header}
                    className={`worktree-diff__file-tab ${isActive ? 'worktree-diff__file-tab--active' : ''}`}
                    onClick={() => setSelectedKey(it.selKey)}
                  >
                    {it.block.header}
                  </button>
                </div>
              </Fragment>
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
