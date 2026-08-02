// RFC-239 — the unified "结构变更" panel: ONE pane replacing the former
// worktree-diff + worktree-structure tabs. Left: the grouped overview sidebar
// (repo → module/docs/config/deps/moves/other, weight bars, severity dots,
// viewed progress). Right: the selected file's structure-annotated diff.
// Deep views (graph/impact/call-chain/deps) open as an on-demand overlay.
//
// Data contract: the TEXT diff is the file universe; the STRUCTURAL response
// joins in per path and its failure only degrades the sidebar (banner) —
// never blocks the diff (design §6). Viewed progress persists in the exact
// pre-merge localStorage format so existing review state survives.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { StructuralDiff, TaskDiff } from '@agent-workflow/shared'
import { buildChangeGroups, type ChangeGroup } from '@agent-workflow/shared'
import { splitByRepo } from '@/components/DiffViewer'
import { Select } from '@/components/Select'
import { Segmented } from '@/components/Segmented'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { tabDomIds } from '@/components/TabBar'
import { loadViewed, saveViewed, toggleViewed, viewedProgress } from '@/lib/diffViewed'
import { buildChangeEntries, toGroupEntries, type HunkInfo } from '@/lib/changeReview'
import type { CallChainRoot } from '@/components/structure/CallChainView'
import { ChangeFileDetail } from './ChangeFileDetail'
import { DrilldownOverlay, type DrilldownKind } from './DrilldownOverlay'
import {
  ChangeNarrativeCard,
  narrativeGroupSummaries,
  useChangeNarrative,
} from './ChangeNarrativeCard'

interface StructuralQueryState {
  data: StructuralDiff | undefined
  error: unknown
  isLoading: boolean
  refetch?: () => void
}

export interface ChangeReviewScopeOption {
  value: string
  label: string
}

const CATEGORY_TITLE: Record<ChangeGroup['category'], string> = {
  code: '', // code groups use their module segment as-is
  deps: 'tasks.changesGroupDeps',
  docs: 'tasks.changesGroupDocs',
  config: 'tasks.changesGroupConfig',
  moves: 'tasks.changesGroupMoves',
  other: 'tasks.changesGroupOther',
}

/** Auto-expand policy: small change-sets open everything; large ones open the
 *  two heaviest groups and fold the rest (design §5). */
function defaultExpanded(groups: readonly ChangeGroup[], fileTotal: number): Set<string> {
  if (groups.length <= 4 && fileTotal <= 50) return new Set(groups.map((g) => g.key))
  return new Set(groups.slice(0, 2).map((g) => g.key))
}

export function ChangeReviewPanel({
  taskId,
  storageKey,
  diff,
  diffTruncated,
  structural,
  scopeValue,
  scopeOptions,
  onScopeChange,
  engineMode,
  onEngineChange,
}: {
  taskId: string
  /** viewed-progress persistence scope (the task id). */
  storageKey?: string
  diff: TaskDiff | undefined
  diffTruncated: boolean
  structural: StructuralQueryState
  scopeValue: string
  scopeOptions: ChangeReviewScopeOption[]
  onScopeChange: (v: string) => void
  engineMode: 'baseline' | 'deep'
  onEngineChange: (v: 'baseline' | 'deep') => void
}) {
  const { t } = useTranslation()
  const groupsRaw = useMemo(() => splitByRepo(diff?.diff ?? ''), [diff?.diff])
  const entries = useMemo(
    () => buildChangeEntries(groupsRaw, structural.data),
    [groupsRaw, structural.data],
  )
  const entryByKey = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries])
  const changeGroups = useMemo(() => buildChangeGroups(toGroupEntries(entries)), [entries])

  // ---- selection + keyboard (visual order = group order → files in group) ----
  const fileOrder = useMemo(() => {
    const order: string[] = []
    for (const g of changeGroups) {
      for (const f of g.files) {
        const key = f.repoLabel === undefined ? f.filePath : `${f.repoLabel}/${f.filePath}`
        if (entryByKey.has(key)) order.push(key)
      }
    }
    return order
  }, [changeGroups, entryByKey])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [focusHunk, setFocusHunk] = useState<HunkInfo | null>(null)
  useEffect(() => {
    if (fileOrder.length === 0) {
      if (selectedKey !== null) setSelectedKey(null)
      return
    }
    if (selectedKey === null || !fileOrder.includes(selectedKey)) {
      setSelectedKey(fileOrder[0] ?? null)
    }
  }, [fileOrder, selectedKey])

  // ---- viewed progress (byte-compatible with the pre-merge format) ----
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
  const progress = viewedProgress(
    entries.map((e) => e.viewedKey),
    viewed,
  )

  // ---- group folding ----
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    defaultExpanded(changeGroups, entries.length),
  )
  const expandedInit = useRef(false)
  useEffect(() => {
    // Re-derive on first non-empty group set only; user folds win afterwards.
    if (expandedInit.current || changeGroups.length === 0) return
    expandedInit.current = true
    setExpanded(defaultExpanded(changeGroups, entries.length))
  }, [changeGroups, entries.length])
  const toggleGroup = (key: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // ---- narrative ----
  const narrative = useChangeNarrative(taskId, diff !== undefined)
  const groupSummaries = narrativeGroupSummaries(narrative.data)

  // ---- drilldown ----
  const [drill, setDrill] = useState<DrilldownKind | null>(null)
  const [callRoot, setCallRoot] = useState<CallChainRoot | null>(null)
  const openCallChain = useCallback((root: CallChainRoot) => {
    setCallRoot(root)
    setDrill('callchain')
  }, [])
  const jumpToFile = useCallback(
    (structuralFilePath: string) => {
      setDrill(null)
      if (entryByKey.has(structuralFilePath)) setSelectedKey(structuralFilePath)
    },
    [entryByKey],
  )
  const jumpToRef = useCallback(
    (ref: string) => {
      // A reading-order ref is a group key or a file path.
      const group = changeGroups.find((g) => g.key === ref)
      if (group !== undefined) {
        setExpanded((prev) => new Set([...prev, ref]))
        const first = group.files[0]
        if (first !== undefined) {
          const key =
            first.repoLabel === undefined ? first.filePath : `${first.repoLabel}/${first.filePath}`
          if (entryByKey.has(key)) setSelectedKey(key)
        }
        return
      }
      const hit =
        entryByKey.get(ref) ?? entries.find((e) => e.filePath === ref || e.key.endsWith(`/${ref}`))
      if (hit !== undefined) setSelectedKey(hit.key)
    },
    [changeGroups, entries, entryByKey],
  )

  // Structural keys of every file in the currently-selected file's group
  // (graph group-focus). Hook order: MUST live above the early returns
  // (react-hooks/rules-of-hooks — caught by CI after the impl-gate batch).
  const selectedGroupKeys = useMemo(() => {
    const currentKey = selectedKey ?? fileOrder[0]
    if (currentKey === undefined || currentKey === null) return null
    const group = changeGroups.find((g) =>
      g.files.some(
        (f) =>
          (f.repoLabel === undefined ? f.filePath : `${f.repoLabel}/${f.filePath}`) === currentKey,
      ),
    )
    if (group === undefined) return null
    return new Set(
      group.files.map((f) =>
        f.repoLabel === undefined ? f.filePath : `${f.repoLabel}/${f.filePath}`,
      ),
    )
  }, [changeGroups, selectedKey, fileOrder])

  // ---- keyboard on the sidebar tablist ----
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const selectFile = useCallback((key: string) => {
    setSelectedKey(key)
    setFocusHunk(null)
    tabRefs.current.get(key)?.focus()
  }, [])
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
          const target = e.target as HTMLElement
          if (target.tagName === 'INPUT') break
          // Group headers are buttons too — Space must ACTIVATE them (fold),
          // not toggle the selected file's viewed state (impl-gate P2).
          if (target.closest('.changes__group-header') !== null) break
          e.preventDefault()
          const cur = entryByKey.get(selectedKey ?? fileOrder[0] ?? '')
          if (cur !== undefined) markViewed(cur.viewedKey)
          break
        }
      }
    },
    [entryByKey, fileOrder, selectedKey, selectFile, markViewed],
  )

  // ---- empty / error states ----
  // The text diff is the primary line, but a GC'd worktree 410s it while the
  // structural artifact may still exist on disk (its whole point: survive GC).
  // Render from the structural side alone in that case instead of dead-ending.
  if (diff === undefined && structural.data === undefined) {
    return <LoadingState size="compact" label={t('tasks.loadingDiff')} />
  }
  if (entries.length === 0) {
    const hint = structural.data?.emptyHint
    return (
      <EmptyState
        title={
          hint === 'scratch-space'
            ? t('tasks.changesEmptyScratch')
            : hint === 'no-changes'
              ? t('tasks.changesEmptyNoChanges')
              : t('tasks.diffNoChanges')
        }
      />
    )
  }

  const selected = entryByKey.get(selectedKey ?? '') ?? entryByKey.get(fileOrder[0] ?? '')
  const drillAvailable = structural.data !== undefined
  const summary = structural.data?.summary

  return (
    <div className="changes" data-testid="change-review">
      <div className="changes__toolbar">
        {scopeOptions.length > 1 && (
          <>
            <span className="changes__toolbar-label">{t('tasks.structScopeLabel')}</span>
            <Select
              value={scopeValue}
              onChange={onScopeChange}
              options={scopeOptions}
              ariaLabel={t('tasks.structScopeLabel')}
            />
          </>
        )}
        <span className="changes__toolbar-label">{t('tasks.structEngineLabel')}</span>
        <Segmented<'baseline' | 'deep'>
          value={engineMode}
          onChange={onEngineChange}
          options={[
            { value: 'baseline', label: t('tasks.structEngineBaseline') },
            { value: 'deep', label: t('tasks.structEngineDeep') },
          ]}
          ariaLabel={t('tasks.structEngineLabel')}
        />
        {summary !== undefined && (
          <span className="changes__summary-line">
            {t('tasks.changesSummaryLine', {
              files: summary.files,
              methods: summary.methods.added + summary.methods.modified + summary.methods.removed,
            })}
          </span>
        )}
        <span className="changes__toolbar-spacer" />
        {drillAvailable && (
          <div className="changes__drill-buttons">
            <button type="button" className="btn btn--xs" onClick={() => setDrill('graph')}>
              {t('tasks.changesDrillGraph')}
            </button>
            {(structural.data?.impact.length ?? 0) > 0 && (
              <button type="button" className="btn btn--xs" onClick={() => setDrill('impact')}>
                {t('tasks.changesDrillImpact')}
              </button>
            )}
            {structural.data?.callChainAvailable === true && callRoot !== null && (
              // Only after a symbol's ⎇ picked a root — a rootless dialog has
              // nothing but "pick a method" and no picker (impl-gate P2).
              <button type="button" className="btn btn--xs" onClick={() => setDrill('callchain')}>
                {t('tasks.changesDrillCallChain')}
              </button>
            )}
            {(structural.data?.dependencyChanges.length ?? 0) > 0 && (
              <button type="button" className="btn btn--xs" onClick={() => setDrill('deps')}>
                {t('tasks.changesDrillDeps')}
              </button>
            )}
          </div>
        )}
      </div>
      {structural.error != null &&
        (structural.data === undefined ? (
          <div className="changes__banner" role="status">
            {t('tasks.changesStructuralUnavailable')}
          </div>
        ) : (
          // Polling keeps the previous structural response on a failed
          // refetch; without this the panel silently pairs a fresh text diff
          // with stale annotations (impl-gate P2).
          <ErrorBanner
            error={structural.error}
            {...(structural.refetch === undefined ? {} : { onRetry: structural.refetch })}
          />
        ))}
      <ChangeNarrativeCard
        taskId={taskId}
        status={narrative.data}
        contentDigest={structural.data?.contentDigest}
        onJumpToRef={jumpToRef}
      />
      <div className="changes__body">
        <aside className="changes__sidebar">
          {diffTruncated && (
            <div className="changes__truncated diff__truncated">
              {t('tasks.diffTruncatedBanner')}
            </div>
          )}
          <div className="changes__progress" data-testid="diff-viewed-progress">
            {t('tasks.diffViewedProgress', { n: progress.viewed, total: progress.total })}
          </div>
          <nav
            role="tablist"
            aria-label={t('tasks.diffFileSelectorLabel')}
            aria-orientation="vertical"
            className="changes__tablist"
            onKeyDown={onTablistKeyDown}
          >
            {changeGroups.map((g) => {
              const isOpen = expanded.has(g.key)
              const repoPrefix = g.key.startsWith('repo:')
                ? (g.key.slice('repo:'.length).split('/')[0] ?? null)
                : null
              const title =
                g.category === 'code'
                  ? g.title === 'code'
                    ? t('tasks.changesGroupCode')
                    : g.title === '__misc__'
                      ? t('tasks.changesGroupMiscCode')
                      : g.title
                  : t(CATEGORY_TITLE[g.category])
              const sentence = groupSummaries.get(g.key)
              const groupViewed = g.files.filter((f) => {
                const key = f.repoLabel === undefined ? f.filePath : `${f.repoLabel}/${f.filePath}`
                const entry = entryByKey.get(key)
                return entry !== undefined && viewed.has(entry.viewedKey)
              }).length
              return (
                <div key={g.key} className="changes__group" data-testid="change-group">
                  <button
                    type="button"
                    className="changes__group-header"
                    aria-expanded={isOpen}
                    onClick={() => toggleGroup(g.key)}
                  >
                    <span className="changes__group-fold">{isOpen ? '▾' : '▸'}</span>
                    <span className="changes__group-title" title={g.key}>
                      {repoPrefix !== null ? `${repoPrefix} · ` : ''}
                      {title}
                    </span>
                    {g.stats.severity.breaking > 0 && (
                      <span
                        className="changes__sev-dot changes__sev-dot--breaking"
                        title={t('tasks.structSevBreaking')}
                      />
                    )}
                    {g.stats.severity.breaking === 0 && g.stats.severity.risky > 0 && (
                      <span
                        className="changes__sev-dot changes__sev-dot--risky"
                        title={t('tasks.structSevRisky')}
                      />
                    )}
                    <span className="changes__group-count">
                      {t('tasks.changesGroupCount', { files: g.stats.files, viewed: groupViewed })}
                    </span>
                    <span className="changes__group-magnitude">
                      {g.stats.lines.added + g.stats.lines.removed > 0 ? (
                        <>
                          {g.stats.lines.added > 0 && (
                            <span className="structure__delta structure__delta--added">
                              +{g.stats.lines.added}
                            </span>
                          )}
                          {g.stats.lines.removed > 0 && (
                            <span className="structure__delta structure__delta--removed">
                              −{g.stats.lines.removed}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="structure__delta">
                          {g.stats.symbolCounts.added +
                            g.stats.symbolCounts.modified +
                            g.stats.symbolCounts.removed +
                            g.stats.symbolCounts.renamed}
                        </span>
                      )}
                    </span>
                    <span className="changes__weight" aria-hidden="true">
                      <span
                        className="changes__weight-bar"
                        style={{ width: `${Math.round(g.weight * 100)}%` }}
                      />
                    </span>
                  </button>
                  {sentence !== undefined && (
                    <div className="changes__group-sentence">{sentence}</div>
                  )}
                  {isOpen &&
                    g.files.map((f) => {
                      const key =
                        f.repoLabel === undefined ? f.filePath : `${f.repoLabel}/${f.filePath}`
                      const entry = entryByKey.get(key)
                      if (entry === undefined) return null
                      const isActive = selected?.key === key
                      const isViewed = viewed.has(entry.viewedKey)
                      const idx = fileOrder.indexOf(key)
                      const ids = tabDomIds('change-file', String(idx))
                      const base = f.filePath.split('/').pop() ?? f.filePath
                      return (
                        <div
                          key={key}
                          className={`changes__file-row ${isViewed ? 'changes__file-row--viewed' : ''}`}
                        >
                          <input
                            type="checkbox"
                            className="changes__viewed"
                            checked={isViewed}
                            aria-label={t('tasks.diffMarkViewed', { file: key })}
                            onChange={() => markViewed(entry.viewedKey)}
                          />
                          <button
                            type="button"
                            role="tab"
                            id={ids.tabId}
                            aria-controls={ids.panelId}
                            ref={(el) => {
                              if (el !== null) tabRefs.current.set(key, el)
                              else tabRefs.current.delete(key)
                            }}
                            tabIndex={isActive ? 0 : -1}
                            aria-selected={isActive}
                            title={key}
                            className={`changes__file-tab ${isActive ? 'changes__file-tab--active' : ''}`}
                            onClick={() => selectFile(key)}
                          >
                            <span className="changes__file-name">{base}</span>
                            {entry.severity.breaking > 0 && (
                              <span className="changes__sev-dot changes__sev-dot--breaking" />
                            )}
                            {entry.severity.breaking === 0 && entry.severity.risky > 0 && (
                              <span className="changes__sev-dot changes__sev-dot--risky" />
                            )}
                            <span className="changes__file-stats">
                              {entry.textStats.added > 0 && (
                                <span className="structure__delta structure__delta--added">
                                  +{entry.textStats.added}
                                </span>
                              )}
                              {entry.textStats.removed > 0 && (
                                <span className="structure__delta structure__delta--removed">
                                  −{entry.textStats.removed}
                                </span>
                              )}
                            </span>
                          </button>
                        </div>
                      )
                    })}
                </div>
              )
            })}
          </nav>
        </aside>
        <section
          className="changes__main"
          role="tabpanel"
          id={tabDomIds('change-file', String(fileOrder.indexOf(selected?.key ?? ''))).panelId}
          aria-labelledby={
            tabDomIds('change-file', String(fileOrder.indexOf(selected?.key ?? ''))).tabId
          }
        >
          {selected !== undefined ? (
            <ChangeFileDetail
              taskId={taskId}
              entry={selected}
              focusHunk={focusHunk}
              onOpenCallChain={openCallChain}
            />
          ) : (
            <EmptyState title={t('tasks.diffNoChanges')} />
          )}
        </section>
      </div>
      <DrilldownOverlay
        kind={drill}
        onClose={() => setDrill(null)}
        data={structural.data}
        taskId={taskId}
        callRoot={callRoot}
        currentFileKey={selected?.key ?? null}
        currentGroupKeys={selectedGroupKeys}
        onOpenCallChain={openCallChain}
        onJumpToFile={jumpToFile}
      />
    </div>
  )
}
