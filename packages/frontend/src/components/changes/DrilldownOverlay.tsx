// RFC-239 §G6 — the deep views (relation graph / impact / call chain /
// dependency changes) demoted from always-mounted sibling tabs to an
// on-demand overlay (public Dialog). The graph gains a focus filter (all /
// current file); impact rows became clickable jumps (they were inert text).
// ImpactPanel + DependencyChangesPanel migrated from the deleted
// StructuralDiffView shell (RFC-083/088) with behavior otherwise unchanged.

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  DependencyChange,
  ImpactItem,
  StructuralDiff,
  SymbolChange,
} from '@agent-workflow/shared'
import { Dialog } from '@/components/Dialog'
import { Segmented } from '@/components/Segmented'
import { StructuralGraph } from '@/components/structure/StructuralGraph'
import { CallChainView, type CallChainRoot } from '@/components/structure/CallChainView'
import { badgeClass, badgeSymbol } from '@/lib/structureView'

export type DrilldownKind = 'graph' | 'impact' | 'callchain' | 'deps'

/** Parse the readable symbol name out of a SymbolNode id
 *  (`filePath#qualifiedName:kind:line`). */
function symbolName(id: string | undefined): string {
  if (id === undefined) return '?'
  const afterHash = id.includes('#') ? (id.split('#')[1] ?? id) : id
  return afterHash.split(':')[0] ?? afterHash
}

function symbolFile(id: string | undefined): string | null {
  if (id === undefined || !id.includes('#')) return null
  return id.split('#')[0] ?? null
}

export function ImpactPanel({
  impact,
  onJumpToFile,
}: {
  impact: ImpactItem[]
  /** RFC-239 — rows are jumps now: select the caller's file in the sidebar. */
  onJumpToFile?: (filePath: string) => void
}) {
  const { t } = useTranslation()
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
              {it.callers.map((c, j) => {
                const label = symbolName(c.symbolId) || c.filePath
                return onJumpToFile !== undefined ? (
                  <button
                    key={`${c.filePath}-${j}`}
                    type="button"
                    className="changes__impact-caller"
                    title={c.filePath}
                    onClick={() => onJumpToFile(c.filePath)}
                  >
                    {label}
                  </button>
                ) : (
                  <span key={`${c.filePath}-${j}`} title={c.filePath}>
                    {j > 0 ? ', ' : ''}
                    {label}
                  </span>
                )
              })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function DependencyChangesPanel({ changes }: { changes: DependencyChange[] }) {
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

const KIND_TITLE: Record<DrilldownKind, string> = {
  graph: 'tasks.changesDrillGraph',
  impact: 'tasks.changesDrillImpact',
  callchain: 'tasks.changesDrillCallChain',
  deps: 'tasks.changesDrillDeps',
}

export function DrilldownOverlay({
  kind,
  onClose,
  data,
  taskId,
  callRoot,
  currentFileKey,
  currentGroupKeys,
  onOpenCallChain,
  onJumpToFile,
}: {
  kind: DrilldownKind | null
  onClose: () => void
  data: StructuralDiff | undefined
  taskId: string
  callRoot: CallChainRoot | null
  /** Structural key (`label/rel` or `rel`) of the sidebar's current file. */
  currentFileKey: string | null
  /** Structural keys of the selected file's whole group (graph group-focus,
   *  impl-gate P2 — design §4 promises all/group/file). */
  currentGroupKeys?: ReadonlySet<string> | null
  onOpenCallChain?: (root: CallChainRoot) => void
  onJumpToFile?: (filePath: string) => void
}) {
  const { t } = useTranslation()
  const [focus, setFocus] = useState<'all' | 'group' | 'file'>('all')
  // Graph focus filter (design §4): feed StructuralGraph a file-subset of the
  // diff. Pure pre-filter — the graph model itself is untouched.
  const graphData = useMemo<StructuralDiff | undefined>(() => {
    if (data === undefined) return undefined
    if (kind !== 'graph' || focus === 'all') return data
    const keepKeys =
      focus === 'group'
        ? (currentGroupKeys ?? (currentFileKey === null ? null : new Set([currentFileKey])))
        : currentFileKey === null
          ? null
          : new Set([currentFileKey])
    if (keepKeys === null) return data
    const files = data.files.filter((f) => keepKeys.has(f.filePath))
    const keep = new Set(files.map((f) => f.filePath))
    return {
      ...data,
      files,
      classEdges: data.classEdges.filter((e) => {
        const from = e.from.split('::')[0] ?? ''
        const to = e.to.split('::')[0] ?? ''
        return keep.has(from) || keep.has(to)
      }),
      impact: data.impact.filter((it) => {
        const f = symbolFile(it.changedSymbolId)
        return f !== null && keep.has(f)
      }),
    }
  }, [data, kind, focus, currentFileKey, currentGroupKeys])

  if (kind === null || data === undefined) return null
  return (
    <Dialog open onClose={onClose} title={t(KIND_TITLE[kind])} size="lg">
      <div className="changes__drill" data-testid={`drilldown-${kind}`}>
        {kind === 'graph' && (
          <>
            {currentFileKey !== null && (
              <Segmented<'all' | 'group' | 'file'>
                value={focus}
                onChange={setFocus}
                options={[
                  { value: 'all', label: t('tasks.changesDrillFocusAll') },
                  ...(currentGroupKeys != null && currentGroupKeys.size > 1
                    ? [{ value: 'group' as const, label: t('tasks.changesDrillFocusGroup') }]
                    : []),
                  { value: 'file', label: t('tasks.changesDrillFocusFile') },
                ]}
                ariaLabel={t('tasks.changesDrillFocusLabel')}
                className="changes__drill-focus"
              />
            )}
            <div className="changes__drill-graph">
              <StructuralGraph data={graphData ?? data} onOpenCallChain={onOpenCallChain} />
            </div>
          </>
        )}
        {kind === 'impact' && <ImpactPanel impact={data.impact} onJumpToFile={onJumpToFile} />}
        {kind === 'callchain' && <CallChainView taskId={taskId} root={callRoot} />}
        {kind === 'deps' && <DependencyChangesPanel changes={data.dependencyChanges} />}
      </div>
    </Dialog>
  )
}
