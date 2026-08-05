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

import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type {
  CodePosition,
  StructuralDiff,
  SymbolResolution,
  TaskDiff,
} from '@agent-workflow/shared'
import {
  buildChangeGroups,
  changeEntryKey,
  repoKeyWire,
  type ChangeGroup,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { CODE_NAV_EMPTY, codeNavReducer, codeNavTop, type CodeNavEntry } from '@/lib/codeNav'
import { CodeViewer } from '@/components/code/CodeViewer'
import { SymbolMenu } from '@/components/code/SymbolMenu'
import { splitByRepo } from '@/components/DiffViewer'
import { Select } from '@/components/Select'
import { Segmented } from '@/components/Segmented'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { Checkbox } from '@/components/Form'
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
        const key = changeEntryKey(f.repoLabel, f.filePath)
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
  const toggleGroup = useCallback(
    (key: string): void =>
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      }),
    [],
  )

  // ---- narrative ----
  const narrative = useChangeNarrative(taskId, diff !== undefined)
  const groupSummaries = narrativeGroupSummaries(narrative.data)

  // ---- drilldown ----
  const [drill, setDrill] = useState<DrilldownKind | null>(null)
  const [callRoot, setCallRoot] = useState<CallChainRoot | null>(null)
  // ⎇ inside the GRAPH dialog replaces its content with the call chain; keep
  // where it came from so the chain view can offer a way BACK to the graph
  // (user feedback: "切换到调用链之后无法返回类图").
  const [chainFrom, setChainFrom] = useState<'graph' | null>(null)
  const openCallChain = useCallback(
    (root: CallChainRoot) => {
      setChainFrom(drill === 'graph' ? 'graph' : null)
      setCallRoot(root)
      setDrill('callchain')
    },
    [drill],
  )
  const backToGraph = useCallback(() => {
    setChainFrom(null)
    setDrill('graph')
  }, [])
  const jumpToFile = useCallback(
    (structuralFilePath: string, line?: number) => {
      setDrill(null)
      if (entryByKey.has(structuralFilePath)) {
        setSelectedKey(structuralFilePath)
        setExternalFile(null) // impl-gate P2-9 — leave the external view
        // RFC-258 — impact rows carry the caller's line: land in the full view
        // focused on it instead of the top of the hunk list.
        if (line !== undefined) {
          setCodeView('full')
          setFullFocus(line)
        }
      } else {
        // impl-gate P1-5 — deep impact callers are OFTEN unchanged files;
        // show them read-only instead of silently doing nothing.
        const entry = entries.find((e) => e.key === structuralFilePath)
        const repoKey = entry?.repoLabel ?? ''
        setExternalFile({ repoKey, filePath: structuralFilePath, side: 'worktree' })
        setCodeView('full')
        setFullFocus(line ?? null)
      }
    },
    [entryByKey, entries],
  )
  const jumpToRef = useCallback(
    (ref: string) => {
      // A reading-order ref is a group key or a file path.
      const group = changeGroups.find((g) => g.key === ref)
      if (group !== undefined) {
        setExpanded((prev) => new Set([...prev, ref]))
        const first = group.files[0]
        if (first !== undefined) {
          const key = changeEntryKey(first.repoLabel, first.filePath)
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

  // ---- RFC-258: source navigation session + symbol menu ----
  const [codeView, setCodeView] = useState<'hunk' | 'full'>('hunk')
  const [fullFocus, setFullFocus] = useState<number | null>(null)
  /** Task-external file rendered read-only in the detail area (breadcrumb is
   *  the only way in/out). */
  const [externalFile, setExternalFile] = useState<{
    repoKey: string
    filePath: string
    side: 'base' | 'worktree'
  } | null>(null)
  const [nav, dispatchNav] = useReducer(codeNavReducer, CODE_NAV_EMPTY)
  const [menu, setMenu] = useState<{
    anchor: { x: number; y: number }
    params: {
      path: string
      /** canonical repo key ('' = root; wire-encoded on send — P0-2/F-04). */
      repo: string
      side: 'base' | 'worktree'
      line: number
      col: number
      name: string
    }
  } | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  // leaving the session: switching files by sidebar clears the whole stack
  const selectFromSidebar = useCallback((key: string) => {
    setSelectedKey(key)
    setExternalFile(null)
    setCodeView('hunk')
    setFullFocus(null)
    setMenu(null)
    dispatchNav({ type: 'clear' })
  }, [])
  useEffect(() => {
    setMenu(null)
    dispatchNav({ type: 'clear' })
    setExternalFile(null)
  }, [taskId])

  const intel = useQuery<SymbolResolution>({
    queryKey: [
      'codeIntel',
      taskId,
      repoKeyWire(menu?.params.repo ?? ''),
      menu?.params.path,
      menu?.params.side,
      menu?.params.line,
      menu?.params.col,
      menu?.params.name,
      engineMode,
      structural.data?.contentDigest ?? '', // snapshot hint (F-16)
    ],
    queryFn: ({ signal }) => {
      const p = menu?.params
      if (p === undefined) throw new Error('unreachable')
      const qs = new URLSearchParams({
        path: p.path,
        side: p.side,
        line: String(p.line),
        col: String(p.col),
        name: p.name,
        mode: engineMode,
      })
      qs.set('repo', repoKeyWire(p.repo))
      return api.get(
        `/api/tasks/${encodeURIComponent(taskId)}/code-intel?${qs.toString()}`,
        undefined,
        signal,
      )
    },
    enabled: menu !== null,
    retry: false,
  })

  const currentNavEntry = useCallback((): CodeNavEntry => {
    // impl-gate P1-8 — snapshot the live scroll offset of whichever view is
    // showing, so pop restores the exact reading position (F-17).
    const scrollEl = panelRef.current?.querySelector('.changes__diff, .code-viewer__scroll')
    const scrollTop = scrollEl instanceof HTMLElement ? scrollEl.scrollTop : undefined
    if (externalFile !== null) {
      return { ...externalFile, viewMode: 'full', line: fullFocus ?? undefined, scrollTop }
    }
    const entry = selectedKey !== null ? entryByKey.get(selectedKey) : undefined
    return {
      repoKey: entry?.repoLabel ?? '',
      side: 'worktree',
      filePath: entry?.filePath ?? '',
      viewMode: codeView,
      line: fullFocus ?? undefined,
      scrollTop,
    }
  }, [externalFile, selectedKey, entryByKey, codeView, fullFocus])

  const navigateTo = useCallback(
    (pos: CodePosition) => {
      dispatchNav({ type: 'push', from: currentNavEntry() })
      setMenu(null)
      const key = changeEntryKey(pos.repoKey === '' ? null : pos.repoKey, pos.filePath)
      if (pos.side === 'worktree' && entryByKey.has(key)) {
        setSelectedKey(key)
        setExternalFile(null)
        setCodeView('full')
        setFullFocus(pos.startLine)
      } else {
        setExternalFile({ repoKey: pos.repoKey, filePath: pos.filePath, side: pos.side })
        setCodeView('full')
        setFullFocus(pos.startLine)
      }
    },
    [currentNavEntry, entryByKey],
  )

  const navigateBack = useCallback(() => {
    const top = codeNavTop(nav)
    if (top === null) return
    dispatchNav({ type: 'pop' })
    setMenu(null)
    const key = changeEntryKey(top.repoKey === '' ? null : top.repoKey, top.filePath)
    if (top.side === 'worktree' && entryByKey.has(key)) {
      setSelectedKey(key)
      setExternalFile(null)
      setCodeView(top.viewMode)
      setFullFocus(top.line ?? null)
    } else {
      setExternalFile({ repoKey: top.repoKey, filePath: top.filePath, side: top.side })
      setCodeView('full')
      setFullFocus(top.line ?? null)
    }
    // restore the snapshotted scroll offset once the view remounts (P1-8)
    if (top.scrollTop !== undefined) {
      requestAnimationFrame(() => {
        const el = panelRef.current?.querySelector('.changes__diff, .code-viewer__scroll')
        if (el instanceof HTMLElement) el.scrollTop = top.scrollTop ?? 0
      })
    }
  }, [nav, entryByKey])

  const onIdentifier = useCallback(
    (hit: {
      side: 'base' | 'worktree'
      line: number
      col: number
      name: string
      clientX: number
      clientY: number
    }) => {
      const source =
        externalFile ?? (selectedKey !== null ? entryByKey.get(selectedKey) : undefined)
      if (source === undefined || source === null) return
      const filePath = 'filePath' in source ? source.filePath : ''
      // Keep the ROOT repo's '' explicit (impl-gate P0-2 / gate F-04): the
      // wire layer encodes it as '.'; collapsing it to null made every
      // out-of-diff root-repo click 400 on multi-repo tasks.
      const repo =
        externalFile !== null
          ? externalFile.repoKey
          : (entryByKey.get(selectedKey ?? '')?.repoLabel ?? '')
      const rect = panelRef.current?.getBoundingClientRect()
      setMenu({
        anchor: {
          x: hit.clientX - (rect?.left ?? 0) + 4,
          y: hit.clientY - (rect?.top ?? 0) + 4,
        },
        params: {
          path: filePath,
          repo,
          side: hit.side,
          line: hit.line,
          col: hit.col,
          name: hit.name,
        },
      })
    },
    [externalFile, selectedKey, entryByKey],
  )

  // Structural keys of every file in the currently-selected file's group
  // (graph group-focus). Hook order: MUST live above the early returns
  // (react-hooks/rules-of-hooks — caught by CI after the impl-gate batch).
  const selectedGroupKeys = useMemo(() => {
    const currentKey = selectedKey ?? fileOrder[0]
    if (currentKey === undefined || currentKey === null) return null
    const group = changeGroups.find((g) =>
      g.files.some((f) => changeEntryKey(f.repoLabel, f.filePath) === currentKey),
    )
    if (group === undefined) return null
    return new Set(group.files.map((f) => changeEntryKey(f.repoLabel, f.filePath)))
  }, [changeGroups, selectedKey, fileOrder])

  // ---- keyboard on the file selectors ----
  // Group disclosures, file selectors and viewed checkboxes intentionally do
  // not share a composite ARIA widget. Each control keeps its native keyboard
  // behavior; the optional reading-order shortcuts live on file buttons only.
  const fileRefs = useRef(new Map<string, HTMLButtonElement>())
  const groupHeaderRefs = useRef(new Map<string, HTMLButtonElement>())
  const detailHeadingId = useId()
  const visibleFileOrder = useMemo(() => {
    const order: string[] = []
    for (const group of changeGroups) {
      if (!expanded.has(group.key)) continue
      for (const file of group.files) {
        const key = changeEntryKey(file.repoLabel, file.filePath)
        if (entryByKey.has(key)) order.push(key)
      }
    }
    return order
  }, [changeGroups, entryByKey, expanded])
  const selectFile = useCallback(
    (key: string) => {
      selectFromSidebar(key)
      setFocusHunk(null)
      fileRefs.current.get(key)?.focus()
    },
    [selectFromSidebar],
  )
  const onFileKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, key: string) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.target !== e.currentTarget || visibleFileOrder.length === 0) return
      const pos = visibleFileOrder.indexOf(key)
      if (pos < 0) return
      const go = (p: number): void => {
        const next = visibleFileOrder[Math.max(0, Math.min(visibleFileOrder.length - 1, p))]
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
          go(visibleFileOrder.length - 1)
          break
        case ' ':
        case 'Spacebar': {
          e.preventDefault()
          const cur = entryByKey.get(key)
          if (cur !== undefined) markViewed(cur.viewedKey)
          break
        }
      }
    },
    [entryByKey, visibleFileOrder, selectFile, markViewed],
  )

  const toggleGroupWithFocus = useCallback(
    (key: string, isOpen: boolean) => {
      if (isOpen) {
        const group = groupHeaderRefs.current.get(key)?.closest('.changes__group')
        if (group?.contains(document.activeElement) === true) {
          groupHeaderRefs.current.get(key)?.focus()
        }
      }
      toggleGroup(key)
    },
    [toggleGroup],
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
          <div className="changes__tablist">
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
                const key = changeEntryKey(f.repoLabel, f.filePath)
                const entry = entryByKey.get(key)
                return entry !== undefined && viewed.has(entry.viewedKey)
              }).length
              return (
                <div key={g.key} className="changes__group" data-testid="change-group">
                  <button
                    type="button"
                    className="changes__group-header"
                    aria-expanded={isOpen}
                    aria-controls={`change-group-files-${g.key}`}
                    ref={(element) => {
                      if (element !== null) groupHeaderRefs.current.set(g.key, element)
                      else groupHeaderRefs.current.delete(g.key)
                    }}
                    onClick={() => toggleGroupWithFocus(g.key, isOpen)}
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
                  <nav
                    id={`change-group-files-${g.key}`}
                    aria-label={`${title} · ${t('tasks.diffFileSelectorLabel')}`}
                    hidden={!isOpen}
                  >
                    <ul className="changes__file-list">
                      {g.files.map((f) => {
                        const key = changeEntryKey(f.repoLabel, f.filePath)
                        const entry = entryByKey.get(key)
                        if (entry === undefined) return null
                        const isActive = selected?.key === key
                        const isViewed = viewed.has(entry.viewedKey)
                        const base = f.filePath.split('/').pop() ?? f.filePath
                        return (
                          <li
                            key={key}
                            className={`changes__file-row ${isViewed ? 'changes__file-row--viewed' : ''}`}
                          >
                            <Checkbox
                              checked={isViewed}
                              aria-label={t('tasks.diffMarkViewed', { file: key })}
                              onChange={() => markViewed(entry.viewedKey)}
                            />
                            <button
                              type="button"
                              ref={(el) => {
                                if (el !== null) fileRefs.current.set(key, el)
                                else fileRefs.current.delete(key)
                              }}
                              aria-current={isActive ? 'true' : undefined}
                              aria-keyshortcuts="Space"
                              title={key}
                              className={`changes__file-tab ${isActive ? 'changes__file-tab--active' : ''}`}
                              onClick={() => selectFile(key)}
                              onKeyDown={(event) => onFileKeyDown(event, key)}
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
                          </li>
                        )
                      })}
                    </ul>
                  </nav>
                </div>
              )
            })}
          </div>
        </aside>
        <section className="changes__main" aria-labelledby={detailHeadingId} ref={panelRef}>
          <h2 id={detailHeadingId} className="sr-only">
            {externalFile?.filePath ?? selected?.filePath ?? t('tasks.diffNoChanges')}
          </h2>
          {nav.stack.length > 0 && (
            <div className="changes__crumbs" data-testid="code-nav-crumbs">
              <button type="button" className="btn btn--xs" onClick={navigateBack}>
                ← {t('tasks.codeNavBack')}
              </button>
              <span className="changes__crumbs-path">
                {externalFile?.filePath ?? selected?.filePath ?? ''}
              </span>
            </div>
          )}
          {externalFile !== null ? (
            <CodeViewer
              taskId={taskId}
              repoKey={externalFile.repoKey}
              filePath={externalFile.filePath}
              side={externalFile.side}
              focus={fullFocus !== null ? { line: fullFocus } : null}
              onIdentifierClick={(hit) => onIdentifier({ side: externalFile.side, ...hit })}
              readonlyBadge
            />
          ) : selected !== undefined ? (
            <ChangeFileDetail
              taskId={taskId}
              entry={selected}
              focusHunk={focusHunk}
              onOpenCallChain={openCallChain}
              codeView={codeView}
              onCodeViewChange={(v) => {
                setCodeView(v)
                if (v === 'hunk') setFullFocus(null)
              }}
              fullFocus={fullFocus}
              onFullFocusChange={(line) => setFullFocus(line)}
              onIdentifier={onIdentifier}
            />
          ) : (
            <EmptyState title={t('tasks.diffNoChanges')} />
          )}
          {menu !== null && (
            <SymbolMenu
              resolution={intel.data ?? null}
              loading={intel.isLoading}
              error={intel.isError}
              anchor={menu.anchor}
              onSelect={navigateTo}
              onClose={() => setMenu(null)}
            />
          )}
        </section>
      </div>
      <DrilldownOverlay
        kind={drill}
        onClose={() => {
          setChainFrom(null)
          setDrill(null)
        }}
        data={structural.data}
        taskId={taskId}
        callRoot={callRoot}
        currentFileKey={selected?.key ?? null}
        currentGroupKeys={selectedGroupKeys}
        onOpenCallChain={openCallChain}
        onJumpToFile={jumpToFile}
        onBackToGraph={chainFrom === 'graph' ? backToGraph : undefined}
        engineMode={engineMode}
      />
    </div>
  )
}
