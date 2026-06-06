// RFC-083 PR-D — structural (semantic) diff view. The textual diff's overlay:
// summary cards + dependency changes + a per-file collapsible structural tree
// with +/~/− badges. Pure aggregation/grouping lives in lib/structureView.ts;
// this file is JSX wiring reusing existing public primitives + diff CSS colors.

import { useState } from 'react'
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
import {
  summaryRows,
  groupFileChanges,
  displayableFiles,
  fileTreeRows,
  badgeClass,
  badgeSymbol,
  type SummaryRow,
} from '@/lib/structureView'
import { StructuralGraph } from './StructuralGraph'
import { CallChainView, type CallChainRoot } from './CallChainView'

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
  const [callRoot, setCallRoot] = useState<CallChainRoot | null>(null)
  const openCallChain = (root: CallChainRoot): void => {
    setCallRoot(root)
    setView('callchain')
  }
  const files = displayableFiles(data.files)
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
      <StructuralSummaryCards summary={data.summary} />
      {availableViews.length > 0 && (
        <div className="structure__detail">
          <div
            className="segmented structure__view-toggle"
            role="radiogroup"
            aria-label={t('tasks.structViewLabel')}
          >
            {availableViews.map((v) => (
              <button
                key={v.key}
                type="button"
                role="radio"
                aria-checked={activeView === v.key}
                className={`segmented__option ${activeView === v.key ? 'segmented__option--active' : ''}`}
                onClick={() => setView(v.key)}
              >
                {t(v.labelKey)}
              </button>
            ))}
          </div>
          {activeView === 'tree' ? (
            <StructuralTree
              files={files}
              onJumpToHunk={onJumpToHunk}
              onOpenCallChain={openCallChain}
            />
          ) : activeView === 'graph' ? (
            <StructuralGraph data={data} onOpenCallChain={openCallChain} />
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

function StructuralSummaryCards({ summary }: { summary: StructuralDiffSummary }) {
  const { t } = useTranslation()
  const rows = summaryRows(summary)
  return (
    <div className="structure__cards">
      <div className="structure__card">
        <span className="structure__card-count">{summary.files}</span>
        <span className="structure__card-label">{t('tasks.structCardFiles')}</span>
      </div>
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
  onJumpToHunk,
  onOpenCallChain,
}: {
  files: FileStructuralDiff[]
  onJumpToHunk?: (anchor: HunkAnchor) => void
  onOpenCallChain?: (root: CallChainRoot) => void
}) {
  const { t } = useTranslation()
  const [sel, setSel] = useState(0)
  const idx = Math.min(sel, files.length - 1)
  const selected = files[idx]
  return (
    <div className="structure__tree">
      <aside className="structure__files">
        <nav role="tablist" aria-orientation="vertical" className="structure__tablist">
          {fileTreeRows(files).map((row, ri) => {
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
            return (
              <button
                type="button"
                key={`f${i}`}
                role="tab"
                aria-selected={i === idx}
                title={f.filePath}
                className={`structure__file-tab ${i === idx ? 'structure__file-tab--active' : ''}`}
                style={indent}
                onClick={() => setSel(i)}
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
      <section className="structure__body">
        {selected !== undefined && (
          <FileChanges
            file={selected}
            onJumpToHunk={onJumpToHunk}
            onOpenCallChain={onOpenCallChain}
          />
        )}
      </section>
    </div>
  )
}

const CALLABLE_KINDS = new Set(['method', 'function', 'constructor'])

function FileChanges({
  file,
  onJumpToHunk,
  onOpenCallChain,
}: {
  file: FileStructuralDiff
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
  return (
    <div className="structure__changes">
      {groups.map((g) => (
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
              const body = (
                <>
                  <span className={badgeClass(ch.changeType)} aria-label={ch.changeType}>
                    {badgeSymbol(ch.changeType)}
                  </span>
                  <span className="structure__symbol-kind">{node?.kind}</span>
                  <span className="structure__symbol-name">
                    {node?.name ?? node?.qualifiedName}
                  </span>
                  {(ch.changeType === 'renamed' || ch.changeType === 'moved') &&
                    ch.renamedFrom !== undefined && (
                      <span className="structure__symbol-from">
                        {t('tasks.structRenamedFrom', { from: ch.renamedFrom })}
                      </span>
                    )}
                  {ch.signatureChanged === true && (
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
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}
