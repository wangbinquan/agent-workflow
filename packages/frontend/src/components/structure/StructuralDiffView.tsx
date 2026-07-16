// RFC-083 PR-D — structural (semantic) diff view. The textual diff's overlay:
// summary cards + dependency changes + a per-file collapsible structural tree
// with +/~/− badges. Pure aggregation/grouping lives in lib/structureView.ts;
// this file is JSX wiring reusing existing public primitives + diff CSS colors.

import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  StructuralDiff,
  FileStructuralDiff,
  DependencyChange,
  StructuralDiffSummary,
  SymbolChange,
  HunkAnchor,
  ImpactItem,
} from '@agent-workflow/shared'
import { EmptyState } from '@/components/EmptyState'
import { Segmented } from '@/components/Segmented'
import { tabDomIds } from '@/components/TabBar'
import {
  summaryRows,
  groupFileChanges,
  displayableFiles,
  fileTreeRows,
  badgeClass,
  badgeSymbol,
  diffSignatureTokens,
  type SummaryRow,
  type SigToken,
} from '@/lib/structureView'
import {
  classifyBreaking,
  explainChange,
  orderAndFilterChanges,
  walkthroughItems,
  severityCounts,
  type Severity,
  type SortBy,
  type WalkthroughItem,
} from '@/lib/structureSemantics'
import { StructuralGraph } from './StructuralGraph'
import { CallChainView, type CallChainRoot } from './CallChainView'

const ALL_SEVERITIES: readonly Severity[] = ['breaking', 'risky', 'safe']
const SEVERITY_LABEL: Record<Severity, string> = {
  breaking: 'tasks.structSevBreaking',
  risky: 'tasks.structSevRisky',
  safe: 'tasks.structSevSafe',
}

// degradedReasons that mean "deep was requested but fell back to baseline".
const DEEP_FALLBACK_REASONS = new Set<string>([
  'indexer-missing',
  'build-failed',
  'timeout',
  'scip-parse-error',
])

// The detail views, toggled by the segmented control. 'impact' (callers) and
// 'deps' (dependency changes) are folded in here instead of always-on panels so
// they stop eating page space — everything below the summary cards is ONE pane.
const VIEWS = [
  { key: 'tree', labelKey: 'tasks.structViewTree' },
  { key: 'graph', labelKey: 'tasks.structViewGraph' },
  { key: 'impact', labelKey: 'tasks.structViewImpact' },
  { key: 'deps', labelKey: 'tasks.structViewDeps' },
  { key: 'callchain', labelKey: 'tasks.structViewCallChain' },
] as const
type ViewKey = (typeof VIEWS)[number]['key']

const CARD_LABEL_KEY: Record<SummaryRow['key'], string> = {
  classes: 'tasks.structCardClasses',
  methods: 'tasks.structCardMethods',
  fields: 'tasks.structCardFields',
  imports: 'tasks.structCardImports',
  dependencies: 'tasks.structCardDependencies',
}

export function StructuralDiffView({
  data,
  onJumpToHunk,
}: {
  data: StructuralDiff
  /** Jump to the textual diff for a symbol (text↔structure cross-nav). */
  onJumpToHunk?: (anchor: HunkAnchor) => void
}) {
  const { t } = useTranslation()
  const [view, setView] = useState<ViewKey>('tree')
  // RFC-088 — tree ordering + severity filtering. Default: risk-first sort, all
  // severities shown.
  const [sortBy, setSortBy] = useState<SortBy>('severity')
  const [sevFilter, setSevFilter] = useState<ReadonlySet<Severity>>(() => new Set(ALL_SEVERITIES))
  const [callRoot, setCallRoot] = useState<CallChainRoot | null>(null)
  const openCallChain = (root: CallChainRoot): void => {
    setCallRoot(root)
    setView('callchain')
  }
  // Only offer the ⎇ entry when the call chain is actually available (single-repo
  // tasks with a changed callable); multi-repo leaves callChainAvailable unset, so
  // the entry stays hidden instead of rendering a button that no-ops.
  const callChainEntry = data.callChainAvailable === true ? openCallChain : undefined
  const files = displayableFiles(data.files)
  // RFC-088 — risk classification across all files: drives the breaking summary
  // card and the walkthrough.
  const counts = severityCounts(files)
  const walkthrough = walkthroughItems(files, 8)
  const hasContent = files.length > 0 || data.dependencyChanges.length > 0
  if (!hasContent) {
    if (data.degradedReason === 'snapshot-pruned') {
      return <EmptyState title={t('tasks.structPruned')} />
    }
    if (data.degradedReason === 'readonly-node-no-snapshot') {
      return <EmptyState title={t('tasks.structReadonlyNode')} />
    }
    return <EmptyState title={t('tasks.structEmpty')} />
  }
  const degraded = data.files.some((f) => f.status === 'degraded')
  const deepFellBack =
    data.engine === 'baseline' && DEEP_FALLBACK_REASONS.has(data.degradedReason ?? '')
  // A view is offered only when it has something to show; if the current view
  // empties out (data refetch), fall back to the first available one.
  const viewAvailable = (k: ViewKey): boolean => {
    if (k === 'tree' || k === 'graph') return files.length > 0
    if (k === 'impact') return data.impact.length > 0
    if (k === 'deps') return data.dependencyChanges.length > 0
    return data.callChainAvailable === true // callchain
  }
  const availableViews = VIEWS.filter((v) => viewAvailable(v.key))
  const activeView = availableViews.some((v) => v.key === view)
    ? view
    : (availableViews[0]?.key ?? 'tree')
  return (
    <div className="structure">
      {deepFellBack && (
        <div className="structure__banner" role="status">
          {t('tasks.structDegradedDeepFallback')}
        </div>
      )}
      {degraded && (
        <div className="structure__banner" role="status">
          {t('tasks.structDegradedBanner')}
        </div>
      )}
      <StructuralSummaryCards
        summary={data.summary}
        breaking={counts.breaking}
        onFocusBreaking={() => {
          setView('tree')
          setSortBy('severity')
          setSevFilter(new Set<Severity>(['breaking']))
        }}
      />
      {walkthrough.length > 0 && (
        <WalkthroughCard
          items={walkthrough}
          more={counts.breaking + counts.risky - walkthrough.length}
          onJumpToHunk={onJumpToHunk}
          onOpenCallChain={callChainEntry}
        />
      )}
      {availableViews.length > 0 && (
        <div className="structure__detail">
          <Segmented<ViewKey>
            value={activeView}
            onChange={setView}
            options={availableViews.map((v) => ({ value: v.key, label: t(v.labelKey) }))}
            ariaLabel={t('tasks.structViewLabel')}
            className="structure__view-toggle"
          />
          {activeView === 'tree' ? (
            <>
              <StructureTreeToolbar
                sortBy={sortBy}
                setSortBy={setSortBy}
                sevFilter={sevFilter}
                setSevFilter={setSevFilter}
              />
              <StructuralTree
                files={files}
                sortBy={sortBy}
                sevFilter={sevFilter}
                onJumpToHunk={onJumpToHunk}
                onOpenCallChain={callChainEntry}
              />
            </>
          ) : activeView === 'graph' ? (
            <StructuralGraph data={data} onOpenCallChain={callChainEntry} />
          ) : activeView === 'impact' ? (
            <div className="structure__impact-view">
              <ImpactPanel impact={data.impact} />
            </div>
          ) : activeView === 'deps' ? (
            <div className="structure__impact-view">
              <DependencyChangesPanel changes={data.dependencyChanges} />
            </div>
          ) : (
            <div className="structure__impact-view">
              <CallChainView taskId={data.taskId} root={callRoot} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Parse the readable symbol name out of a SymbolNode id
 *  (`filePath#qualifiedName:kind:line`). */
function symbolName(id: string | undefined): string {
  if (id === undefined) return '?'
  const afterHash = id.includes('#') ? (id.split('#')[1] ?? id) : id
  return afterHash.split(':')[0] ?? afterHash
}

function ImpactPanel({ impact }: { impact: ImpactItem[] }) {
  const { t } = useTranslation()
  // Precise (deep/SCIP) when any item is 'extracted'; else heuristic (baseline).
  const precise = impact.some((i) => i.confidence === 'extracted')
  return (
    <div className="structure__impact">
      <div className="structure__impact-header">
        {t('tasks.structImpactHeader')}
        <span className="structure__tag">
          {precise ? t('tasks.structImpactExtracted') : t('tasks.structImpactInferred')}
        </span>
      </div>
      <ul className="structure__impact-list">
        {impact.map((it, i) => (
          <li key={`${it.changedSymbolId}-${i}`} className="structure__impact-item">
            <span className="structure__impact-target">{symbolName(it.changedSymbolId)}</span>
            <span className="structure__impact-arrow">←</span>
            <span className="structure__impact-callers">
              {it.callers.map((c) => symbolName(c.symbolId) || c.filePath).join(', ')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** RFC-088 — tree controls: sort (risk / name) + per-severity show toggles. */
function StructureTreeToolbar({
  sortBy,
  setSortBy,
  sevFilter,
  setSevFilter,
}: {
  sortBy: SortBy
  setSortBy: (s: SortBy) => void
  sevFilter: ReadonlySet<Severity>
  setSevFilter: (s: ReadonlySet<Severity>) => void
}) {
  const { t } = useTranslation()
  const toggleSev = (s: Severity): void => {
    const next = new Set(sevFilter)
    if (next.has(s)) next.delete(s)
    else next.add(s)
    // never let the filter empty out to "show nothing" — re-show all instead
    setSevFilter(next.size === 0 ? new Set(ALL_SEVERITIES) : next)
  }
  return (
    <div className="structure__toolbar">
      <span className="structure__toolbar-label">{t('tasks.structSortLabel')}</span>
      <Segmented<SortBy>
        value={sortBy}
        onChange={setSortBy}
        options={(['severity', 'name'] as const).map((s) => ({
          value: s,
          label: t(s === 'severity' ? 'tasks.structSortSeverity' : 'tasks.structSortName'),
        }))}
        ariaLabel={t('tasks.structSortLabel')}
        className="structure__sort"
      />
      <span className="structure__toolbar-label">{t('tasks.structFilterLabel')}</span>
      {ALL_SEVERITIES.map((s) => (
        <label key={s} className="structure__sev-toggle">
          <input type="checkbox" checked={sevFilter.has(s)} onChange={() => toggleSev(s)} />
          <span className={`structure__severity structure__severity--${s}`}>
            {t(SEVERITY_LABEL[s])}
          </span>
        </label>
      ))}
    </div>
  )
}

/** RFC-088 — "look here first" strip: top-N changes by risk, each linking to the
 *  textual diff (hunk) or the call chain. Host gates rendering on items.length. */
function WalkthroughCard({
  items,
  more,
  onJumpToHunk,
  onOpenCallChain,
}: {
  items: WalkthroughItem[]
  more: number
  onJumpToHunk?: (anchor: HunkAnchor) => void
  onOpenCallChain?: (root: CallChainRoot) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="structure__walkthrough" data-testid="structure-walkthrough">
      <div className="structure__walkthrough-header">{t('tasks.structWalkthroughTitle')}</div>
      <ul className="structure__walkthrough-list">
        {items.map((it, i) => {
          const node = it.change.after ?? it.change.before
          const explain = explainChange(it.change)
          const anchor = it.change.hunkAnchor
          const after = it.change.after
          const onClick =
            onJumpToHunk !== undefined && anchor !== undefined
              ? () => onJumpToHunk(anchor)
              : onOpenCallChain !== undefined &&
                  after !== undefined &&
                  CALLABLE_KINDS.has(after.kind)
                ? () =>
                    onOpenCallChain({
                      ref: `${after.filePath}#${after.qualifiedName}`,
                      label: `${after.name}()`,
                    })
                : undefined
          const inner = (
            <>
              <span className={`structure__severity structure__severity--${it.severity}`}>
                {t(SEVERITY_LABEL[it.severity])}
              </span>
              <span className="structure__walkthrough-name">
                {node?.name ?? node?.qualifiedName}
              </span>
              <span className="structure__walkthrough-explain">{t(explain.key, explain.vars)}</span>
            </>
          )
          return (
            <li
              key={`${it.filePath}-${node?.qualifiedName ?? '?'}-${i}`}
              className="structure__walkthrough-item"
            >
              {onClick !== undefined ? (
                <button
                  type="button"
                  className="structure__walkthrough-jump"
                  onClick={onClick}
                  title={it.filePath}
                >
                  {inner}
                </button>
              ) : (
                <span className="structure__walkthrough-static" title={it.filePath}>
                  {inner}
                </span>
              )}
            </li>
          )
        })}
      </ul>
      {more > 0 && (
        <div className="structure__walkthrough-more">
          {t('tasks.structWalkthroughMore', { n: more })}
        </div>
      )}
    </div>
  )
}

function StructuralSummaryCards({
  summary,
  breaking,
  onFocusBreaking,
}: {
  summary: StructuralDiffSummary
  /** RFC-088 — count of breaking-classified changes; renders a clickable card. */
  breaking: number
  onFocusBreaking: () => void
}) {
  const { t } = useTranslation()
  const rows = summaryRows(summary)
  return (
    <div className="structure__cards">
      <div className="structure__card">
        <span className="structure__card-count">{summary.files}</span>
        <span className="structure__card-label">{t('tasks.structCardFiles')}</span>
      </div>
      {breaking > 0 && (
        <button
          type="button"
          className="structure__card structure__card--breaking"
          onClick={onFocusBreaking}
          title={t('tasks.structSevBreaking')}
        >
          <span className="structure__card-count">{breaking}</span>
          <span className="structure__card-label">{t('tasks.structCardBreaking')}</span>
        </button>
      )}
      {rows.map((r) => (
        <div key={r.key} className="structure__card">
          <span className="structure__card-label">{t(CARD_LABEL_KEY[r.key])}</span>
          <span className="structure__card-counts">
            {r.count.added > 0 && (
              <span className="structure__delta structure__delta--added">+{r.count.added}</span>
            )}
            {r.count.modified > 0 && (
              <span className="structure__delta structure__delta--modified">
                ~{r.count.modified}
              </span>
            )}
            {r.count.removed > 0 && (
              <span className="structure__delta structure__delta--removed">−{r.count.removed}</span>
            )}
            {r.count.renamed > 0 && (
              <span className="structure__delta structure__delta--renamed">→{r.count.renamed}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

function DependencyChangesPanel({ changes }: { changes: DependencyChange[] }) {
  const { t } = useTranslation()
  return (
    <div className="structure__deps">
      <div className="structure__deps-header">{t('tasks.structDepsHeader')}</div>
      <ul className="structure__deps-list">
        {changes.map((d, i) => {
          const ct: SymbolChange['changeType'] =
            d.changeType === 'updated' ? 'modified' : d.changeType
          return (
            <li key={`${d.ecosystem}:${d.packageName}:${i}`} className="structure__dep">
              <span className={badgeClass(ct)} aria-label={d.changeType}>
                {badgeSymbol(ct)}
              </span>
              <span className="structure__dep-eco">{d.ecosystem}</span>
              <span className="structure__dep-name">{d.packageName}</span>
              {d.versionBefore !== undefined && d.versionAfter !== undefined ? (
                <span className="structure__dep-ver">
                  {d.versionBefore} → {d.versionAfter}
                </span>
              ) : d.versionAfter !== undefined ? (
                <span className="structure__dep-ver">{d.versionAfter}</span>
              ) : null}
              {d.viaManifest && d.viaImport && (
                <span className="structure__tag">{t('tasks.structViaImportManifest')}</span>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function StructuralTree({
  files,
  sortBy,
  sevFilter,
  onJumpToHunk,
  onOpenCallChain,
}: {
  files: FileStructuralDiff[]
  sortBy: SortBy
  sevFilter: ReadonlySet<Severity>
  onJumpToHunk?: (anchor: HunkAnchor) => void
  onOpenCallChain?: (root: CallChainRoot) => void
}) {
  const { t } = useTranslation()
  const [sel, setSel] = useState(0)
  const idx = Math.min(sel, files.length - 1)

  // Keyboard file switching, mirroring WorktreeDiffPanel. The list is a vertical
  // `role="tablist"`; Up/Down (+ Home/End) step between FILE rows in their
  // VISUAL (top-to-bottom) order — directory headers are skipped, and the order
  // follows the rendered tree, NOT the `files` array (fileTreeRows groups + sorts
  // by directory, so the two can differ). Selecting pulls focus onto the tab so
  // the focus ring, scroll-into-view, and the roving tab stop track the shown
  // file and repeated presses continue from there.
  const rows = useMemo(() => fileTreeRows(files), [files])
  const fileOrder = useMemo(
    () => rows.flatMap((r) => (r.fileIndex === undefined ? [] : [r.fileIndex])),
    [rows],
  )
  const tabRefs = useRef(new Map<number, HTMLButtonElement>())
  const selectFile = useCallback((fileIndex: number) => {
    setSel(fileIndex)
    tabRefs.current.get(fileIndex)?.focus()
  }, [])
  const onTablistKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (fileOrder.length === 0) return
      const pos = fileOrder.indexOf(idx)
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
      }
    },
    [fileOrder, idx, selectFile],
  )
  return (
    <div className="structure__tree">
      <aside className="structure__files">
        <nav
          role="tablist"
          aria-label={t('tasks.structFileSelectorLabel')}
          aria-orientation="vertical"
          className="structure__tablist"
          onKeyDown={onTablistKeyDown}
        >
          {rows.map((row, ri) => {
            const indent = { paddingLeft: `${8 + row.depth * 14}px` }
            if (row.fileIndex === undefined) {
              return (
                <div key={`d${ri}`} className="structure__tree-dir" style={indent}>
                  {row.name}
                </div>
              )
            }
            const f = files[row.fileIndex]
            if (f === undefined) return null
            const i = row.fileIndex
            const ids = tabDomIds('structural-file', String(i))
            return (
              <button
                type="button"
                key={`f${i}`}
                role="tab"
                id={ids.tabId}
                aria-controls={ids.panelId}
                ref={(el) => {
                  if (el !== null) tabRefs.current.set(i, el)
                  else tabRefs.current.delete(i)
                }}
                // Roving tab stop: only the active file tab is Tab-reachable;
                // Up/Down then move among the rest (ARIA tablist).
                tabIndex={i === idx ? 0 : -1}
                aria-selected={i === idx}
                title={f.filePath}
                className={`structure__file-tab ${i === idx ? 'structure__file-tab--active' : ''}`}
                style={indent}
                onClick={() => selectFile(i)}
              >
                <span className="structure__file-name">{row.name}</span>
                {f.status === 'degraded' && (
                  <span className="structure__chip" title={t('tasks.structDegradedBanner')}>
                    {t('tasks.structDegradedChip')}
                  </span>
                )}
              </button>
            )
          })}
        </nav>
      </aside>
      {files.map((file, index) => {
        const ids = tabDomIds('structural-file', String(index))
        const active = index === idx
        return (
          <section
            key={file.filePath}
            className="structure__body"
            role="tabpanel"
            id={ids.panelId}
            aria-labelledby={ids.tabId}
            hidden={!active}
          >
            {active ? (
              <FileChanges
                file={file}
                sortBy={sortBy}
                sevFilter={sevFilter}
                onJumpToHunk={onJumpToHunk}
                onOpenCallChain={onOpenCallChain}
              />
            ) : null}
          </section>
        )
      })}
    </div>
  )
}

/** RFC-083 (Q1) — the before→after signature comparison: two monospace rows,
 *  old on top (removed tokens flagged red), new below (added tokens flagged
 *  green). Reuses the diff add/remove palette via `.structure__sigtok--*`. */
function SignatureDiff({ diff }: { diff: { before: SigToken[]; after: SigToken[] } }) {
  return (
    <div className="structure__sigdiff" data-testid="sigdiff">
      <code className="structure__sigdiff-row structure__sigdiff-row--before">
        {diff.before.map((tok, i) => (
          <span
            key={i}
            className={
              tok.kind === 'removed'
                ? 'structure__sigtok structure__sigtok--removed'
                : 'structure__sigtok'
            }
          >
            {tok.text}
          </span>
        ))}
      </code>
      <code className="structure__sigdiff-row structure__sigdiff-row--after">
        {diff.after.map((tok, i) => (
          <span
            key={i}
            className={
              tok.kind === 'added'
                ? 'structure__sigtok structure__sigtok--added'
                : 'structure__sigtok'
            }
          >
            {tok.text}
          </span>
        ))}
      </code>
    </div>
  )
}

const CALLABLE_KINDS = new Set(['method', 'function', 'constructor'])

function FileChanges({
  file,
  sortBy,
  sevFilter,
  onJumpToHunk,
  onOpenCallChain,
}: {
  file: FileStructuralDiff
  sortBy: SortBy
  sevFilter: ReadonlySet<Severity>
  onJumpToHunk?: (anchor: HunkAnchor) => void
  onOpenCallChain?: (root: CallChainRoot) => void
}) {
  const { t } = useTranslation()
  if (file.status === 'parse-error') {
    return <div className="structure__muted muted">{t('tasks.structParseError')}</div>
  }
  const groups = groupFileChanges(file)
  if (groups.length === 0) {
    return <div className="structure__muted muted">{t('tasks.structFileNoSymbolChanges')}</div>
  }
  // RFC-088 — per-group order + severity filter; groups that empty out under the
  // filter are dropped, and if everything is filtered away say so.
  const shownGroups = groups
    .map((g) => ({
      container: g.container,
      changes: orderAndFilterChanges(g.changes, sortBy, { severities: sevFilter }),
    }))
    .filter((g) => g.changes.length > 0)
  if (shownGroups.length === 0) {
    return <div className="structure__muted muted">{t('tasks.structFileNoSymbolChanges')}</div>
  }
  return (
    <div className="structure__changes">
      {shownGroups.map((g) => (
        <div key={g.container || '__top__'} className="structure__group">
          {g.container !== '' && <div className="structure__group-header">{g.container}</div>}
          <ul className="structure__symbols">
            {g.changes.map((ch, i) => {
              const node = ch.after ?? ch.before
              const jumpable = onJumpToHunk !== undefined && ch.hunkAnchor !== undefined
              // a call-chain root must be a callable that still exists (`after`)
              const callRoot =
                onOpenCallChain !== undefined &&
                ch.after !== undefined &&
                CALLABLE_KINDS.has(ch.after.kind)
                  ? {
                      ref: `${ch.after.filePath}#${ch.after.qualifiedName}`,
                      label: `${ch.after.name}()`,
                    }
                  : null
              // RFC-083 (Q1) — when the declaration signature changed, show the
              // before→after token diff instead of just a "signature changed"
              // tag, so the reviewer sees exactly which params/return moved.
              const sigDiff =
                ch.signatureChanged === true && ch.changeType === 'modified'
                  ? diffSignatureTokens(ch.before?.signature, ch.after?.signature)
                  : null
              // RFC-088 — risk chip + one-line plain-language explanation.
              const verdict = classifyBreaking(ch)
              const explain = explainChange(ch)
              const body = (
                <>
                  <span className={badgeClass(ch.changeType)} aria-label={ch.changeType}>
                    {badgeSymbol(ch.changeType)}
                  </span>
                  <span className="structure__symbol-kind">{node?.kind}</span>
                  <span className="structure__symbol-name">
                    {node?.name ?? node?.qualifiedName}
                  </span>
                  {verdict.severity !== 'safe' && (
                    <span
                      className={`structure__severity structure__severity--${verdict.severity}`}
                      title={verdict.uncertain ? t('tasks.structSevUnknownVis') : undefined}
                    >
                      {t(SEVERITY_LABEL[verdict.severity])}
                      {verdict.uncertain ? ' ?' : ''}
                    </span>
                  )}
                  {(ch.changeType === 'renamed' || ch.changeType === 'moved') &&
                    ch.renamedFrom !== undefined && (
                      <span className="structure__symbol-from">
                        {t('tasks.structRenamedFrom', { from: ch.renamedFrom })}
                      </span>
                    )}
                  {ch.signatureChanged === true && sigDiff === null && (
                    <span className="structure__tag">{t('tasks.structSigChanged')}</span>
                  )}
                  {ch.bodyDelta !== undefined && (
                    <span className="structure__body-delta" title={t('tasks.structBodyDeltaTitle')}>
                      {ch.bodyDelta.added > 0 && (
                        <span className="structure__body-delta-add">+{ch.bodyDelta.added}</span>
                      )}
                      {ch.bodyDelta.removed > 0 && (
                        <span className="structure__body-delta-del">−{ch.bodyDelta.removed}</span>
                      )}
                    </span>
                  )}
                </>
              )
              return (
                <li key={`${node?.qualifiedName ?? '?'}-${i}`} className="structure__symbol">
                  {jumpable ? (
                    <button
                      type="button"
                      className="structure__symbol-jump"
                      title={t('tasks.structJumpToDiff')}
                      onClick={() => onJumpToHunk(ch.hunkAnchor as HunkAnchor)}
                    >
                      {body}
                    </button>
                  ) : (
                    body
                  )}
                  {callRoot !== null && (
                    <button
                      type="button"
                      className="structure__callchain-entry"
                      title={t('tasks.structCallChainEntry')}
                      aria-label={t('tasks.structCallChainEntry')}
                      onClick={() => onOpenCallChain?.(callRoot)}
                    >
                      ⎇
                    </button>
                  )}
                  {sigDiff !== null && <SignatureDiff diff={sigDiff} />}
                  <div className="structure__explain">{t(explain.key, explain.vars)}</div>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}
