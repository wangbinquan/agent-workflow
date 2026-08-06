// RFC-239 — right pane of the unified change view: file header (rename /
// degraded chips) → symbol outline (nested, noise-collapsed) → the unified
// diff annotated with hunk→symbol badges and a sticky current-symbol bar.
// Markdown files add a rendered/text toggle backed by GET /file-content
// (both full sides; any side failing falls back to the text diff).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type {
  FileSymbolsResult as FileSymbolsResultWire,
  SymbolChange,
} from '@agent-workflow/shared'
import { classifyBreaking, explainChange, repoKeyWire, type Severity } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { DiffFileBody } from '@/components/DiffViewer'
import { MarkdownDiffView } from '@/components/review/MarkdownDiffView'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Segmented } from '@/components/Segmented'
import { badgeClass, badgeSymbol, diffSignatureTokens, type SigToken } from '@/lib/structureView'
import { hunkForSymbol, symbolForHunk } from '@/lib/hunkSymbolMap'
import { buildDiffSegments } from '@/lib/changeReview'
import type { ChangeFileEntry, HunkInfo } from '@/lib/changeReview'
import type { CallChainRoot } from '@/components/structure/CallChainView'
import { CodeViewer } from '@/components/code/CodeViewer'
import { resolveIdentifierClick } from '@/lib/identifierClick'
import { hunkPointToFilePoint } from '@/lib/hunkPoint'
import { fullFileRanges } from '@/lib/fullFileRanges'

const SEVERITY_LABEL: Record<Severity, string> = {
  breaking: 'tasks.structSevBreaking',
  risky: 'tasks.structSevRisky',
  safe: 'tasks.structSevSafe',
}
const CALLABLE_KINDS = new Set(['method', 'function', 'constructor'])
const CONTAINER_KINDS = new Set([
  'class',
  'interface',
  'trait',
  'struct',
  'enum',
  'object',
  'module',
  'namespace',
])

interface FileContentResult {
  exists: boolean
  content?: string
}

/** RFC-083 (Q1) — before→after signature token diff (moved from the old
 *  StructuralDiffView; behavior unchanged). */
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

interface OutlineGroup {
  container: string
  containerChange?: SymbolChange
  members: SymbolChange[]
}

/** Group a file's symbol changes container-first: container symbols become
 *  group headers, members nest under their container's qualifiedName prefix;
 *  imports are aggregated out (rendered as one collapsed row). */
function outlineGroups(changes: readonly SymbolChange[]): {
  groups: OutlineGroup[]
  imports: SymbolChange[]
} {
  const imports: SymbolChange[] = []
  const rest: SymbolChange[] = []
  for (const c of changes) {
    if (c.kind === 'import') imports.push(c)
    else rest.push(c)
  }
  const byContainer = new Map<string, OutlineGroup>()
  const containerOf = (qn: string): string => {
    const i = qn.lastIndexOf('.')
    return i <= 0 ? '' : qn.slice(0, i)
  }
  // containers first so members can attach
  for (const c of rest) {
    const node = c.after ?? c.before
    if (node === undefined) continue
    if (CONTAINER_KINDS.has(c.kind)) {
      const g = byContainer.get(node.qualifiedName) ?? {
        container: node.qualifiedName,
        members: [],
      }
      g.containerChange = c
      byContainer.set(node.qualifiedName, g)
    }
  }
  for (const c of rest) {
    const node = c.after ?? c.before
    if (node === undefined || CONTAINER_KINDS.has(c.kind)) continue
    const container = containerOf(node.qualifiedName)
    const g = byContainer.get(container) ?? { container, members: [] }
    g.members.push(c)
    byContainer.set(container, g)
  }
  const groups = [...byContainer.values()].sort((a, b) => a.container.localeCompare(b.container))
  return { groups, imports }
}

function SymbolRow({
  change,
  hunks,
  onJumpToHunk,
  onOpenCallChain,
  focused,
}: {
  change: SymbolChange
  hunks: readonly HunkInfo[]
  onJumpToHunk: (hunk: HunkInfo) => void
  onOpenCallChain?: (root: CallChainRoot) => void
  focused?: boolean
}) {
  const { t } = useTranslation()
  const rowRef = useRef<HTMLLIElement | null>(null)
  useEffect(() => {
    if (focused === true) rowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [focused])
  const node = change.after ?? change.before
  const verdict = classifyBreaking(change)
  // added+safe explanations are pure tautology ("新增 method x") — drop them
  // (design §2.4 de-noising); everything else keeps the plain-language line.
  const explain =
    change.changeType === 'added' && verdict.severity === 'safe' ? null : explainChange(change)
  const target = hunkForSymbol(change, hunks)
  const sigDiff =
    change.signatureChanged === true && change.changeType === 'modified'
      ? diffSignatureTokens(change.before?.signature, change.after?.signature)
      : null
  const callRoot =
    onOpenCallChain !== undefined &&
    change.after !== undefined &&
    CALLABLE_KINDS.has(change.after.kind)
      ? {
          ref: `${change.after.filePath}#${change.after.qualifiedName}`,
          label: `${change.after.name}()`,
        }
      : null
  const body = (
    <>
      <span className={badgeClass(change.changeType)} aria-label={change.changeType}>
        {badgeSymbol(change.changeType)}
      </span>
      <span className="structure__symbol-kind">{node?.kind}</span>
      <span className="structure__symbol-name">{node?.name ?? node?.qualifiedName}</span>
      {verdict.severity !== 'safe' && (
        <span
          className={`structure__severity structure__severity--${verdict.severity}`}
          title={verdict.uncertain ? t('tasks.structSevUnknownVis') : undefined}
        >
          {t(SEVERITY_LABEL[verdict.severity])}
          {verdict.uncertain ? ' ?' : ''}
        </span>
      )}
      {(change.changeType === 'renamed' || change.changeType === 'moved') &&
        change.renamedFrom !== undefined && (
          <span className="structure__symbol-from">
            {t('tasks.structRenamedFrom', { from: change.renamedFrom })}
          </span>
        )}
      {change.signatureChanged === true && sigDiff === null && (
        <span className="structure__tag">{t('tasks.structSigChanged')}</span>
      )}
      {change.bodyDelta !== undefined && (
        <span className="structure__body-delta" title={t('tasks.structBodyDeltaTitle')}>
          {change.bodyDelta.added > 0 && (
            <span className="structure__body-delta-add">+{change.bodyDelta.added}</span>
          )}
          {change.bodyDelta.removed > 0 && (
            <span className="structure__body-delta-del">−{change.bodyDelta.removed}</span>
          )}
        </span>
      )}
    </>
  )
  return (
    <li
      ref={rowRef}
      className={`structure__symbol${focused === true ? ' structure__symbol--focused' : ''}`}
    >
      {target !== null ? (
        <button
          type="button"
          className="structure__symbol-main structure__symbol-jump"
          title={t('tasks.changesJumpToHunk')}
          onClick={() => onJumpToHunk(target)}
        >
          {body}
        </button>
      ) : (
        <span className="structure__symbol-main">{body}</span>
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
      {explain !== null && <div className="structure__explain">{t(explain.key, explain.vars)}</div>}
    </li>
  )
}

function SymbolOutline({
  entry,
  onJumpToHunk,
  onOpenCallChain,
  focusQualifiedName,
}: {
  entry: ChangeFileEntry
  onJumpToHunk: (hunk: HunkInfo) => void
  onOpenCallChain?: (root: CallChainRoot) => void
  /** Reverse jump: outline row to highlight + scroll into view. */
  focusQualifiedName?: string | null
}) {
  const { t } = useTranslation()
  const f = entry.structural
  const [showImports, setShowImports] = useState(false)
  const { groups, imports } = useMemo(() => outlineGroups(f?.changes ?? []), [f?.changes])
  // Fully-added files default-collapse to container level (design §2.4): a
  // generated file's 40 members are noise until asked for.
  const allAdded = useMemo(
    () =>
      (f?.changes ?? []).length > 0 && (f?.changes ?? []).every((c) => c.changeType === 'added'),
    [f?.changes],
  )
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => setExpanded(new Set()), [entry.key])
  if (f === undefined || (f.changes.length === 0 && entry.pureMove)) {
    return entry.pureMove ? (
      <div className="changes__outline-note muted">
        {t('tasks.changesPureMove', { from: entry.renamedFrom ?? '' })}
      </div>
    ) : null
  }
  if (f.status === 'parse-error') {
    return <div className="changes__outline-note muted">{t('tasks.structParseError')}</div>
  }
  if (f.changes.length === 0) return null
  const toggle = (key: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  return (
    <div className="changes__outline" data-testid="symbol-outline">
      {imports.length > 0 && (
        <div className="changes__outline-imports">
          <button
            type="button"
            className="changes__outline-fold"
            aria-expanded={showImports}
            onClick={() => setShowImports((v) => !v)}
          >
            <span className="changes__outline-chevron" aria-hidden="true">
              {showImports ? '▾' : '▸'}
            </span>
            <span className="changes__outline-label">
              {t('tasks.changesImportsAggregated', { n: imports.length })}
            </span>
          </button>
          {showImports && (
            <ul className="structure__symbols">
              {imports.map((c, i) => (
                <SymbolRow
                  key={`imp-${i}`}
                  change={c}
                  hunks={entry.hunks}
                  onJumpToHunk={onJumpToHunk}
                  focused={(c.after ?? c.before)?.qualifiedName === focusQualifiedName}
                />
              ))}
            </ul>
          )}
        </div>
      )}
      {groups.map((g) => {
        const key = g.container === '' ? '(top)' : g.container
        const memberCount = g.members.length
        const collapsed = allAdded && !expanded.has(key) && memberCount > 0
        // The top-level group (container '') has no container symbol to act as
        // its header. When allAdded collapses it, it MUST still render a fold
        // header — otherwise its members are hidden with no way to expand them
        // (an all-new file of top-level functions showed an empty outline and
        // no ⎇ call-chain entry at all).
        const foldable = allAdded && memberCount > 0
        return (
          <div key={key} className="structure__group">
            {(g.container !== '' || g.containerChange !== undefined || foldable) && (
              <div className="structure__group-header">
                {foldable ? (
                  <button
                    type="button"
                    className="changes__outline-fold"
                    aria-expanded={!collapsed}
                    onClick={() => toggle(key)}
                  >
                    <span className="changes__outline-chevron" aria-hidden="true">
                      {collapsed ? '▸' : '▾'}
                    </span>
                    <span className="changes__outline-label">
                      {g.container === '' ? t('tasks.changesTopLevelGroup') : key}
                    </span>
                    <span className="changes__outline-count">
                      {t('tasks.changesContainerCollapsed', { n: memberCount })}
                    </span>
                  </button>
                ) : (
                  key
                )}
              </div>
            )}
            {g.containerChange !== undefined && !collapsed && (
              <ul className="structure__symbols">
                <SymbolRow
                  change={g.containerChange}
                  hunks={entry.hunks}
                  onJumpToHunk={onJumpToHunk}
                  onOpenCallChain={onOpenCallChain}
                  focused={
                    (g.containerChange.after ?? g.containerChange.before)?.qualifiedName ===
                    focusQualifiedName
                  }
                />
              </ul>
            )}
            {!collapsed && (
              <ul className="structure__symbols">
                {g.members.map((c, i) => (
                  <SymbolRow
                    key={`${key}-${i}`}
                    change={c}
                    hunks={entry.hunks}
                    onJumpToHunk={onJumpToHunk}
                    onOpenCallChain={onOpenCallChain}
                    focused={(c.after ?? c.before)?.qualifiedName === focusQualifiedName}
                  />
                ))}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}

/** Diff body split at hunk boundaries so each hunk header can carry its owning
 *  symbol badge and the scroll container can track the current symbol. */
function AnnotatedDiff({
  entry,
  focusHunk,
  scrollRef,
  onOwnerClick,
  onIdentifier,
}: {
  entry: ChangeFileEntry
  focusHunk: HunkInfo | null
  scrollRef: React.RefObject<HTMLDivElement | null>
  /** Reverse jump (impl-gate P2): click a hunk's owner → highlight + scroll
   *  the matching outline row. */
  onOwnerClick?: (qualifiedName: string) => void
  /** RFC-258 — identifier click inside a hunk body, already converted to a
   *  (side, file line/col) point (gate F-05). */
  onIdentifier?: (hit: {
    side: 'base' | 'worktree'
    line: number
    col: number
    name: string
    clientX: number
    clientY: number
  }) => void
}) {
  const { t } = useTranslation()
  const changes = useMemo(() => entry.structural?.changes ?? [], [entry.structural?.changes])
  const hunkRefs = useRef(new Map<number, HTMLElement>())
  const [currentSymbol, setCurrentSymbol] = useState<string | null>(null)

  useEffect(() => {
    if (focusHunk === null) return
    const el = hunkRefs.current.get(focusHunk.headerIndex)
    el?.scrollIntoView({ block: 'start' })
    el?.classList.add('changes__hunk--focus')
    const timer = setTimeout(() => el?.classList.remove('changes__hunk--focus'), 1600)
    return () => clearTimeout(timer)
  }, [focusHunk])

  const onScroll = useCallback(() => {
    const container = scrollRef.current
    if (container === null) return
    const top = container.scrollTop
    let ownerName: string | null = null
    for (const h of entry.hunks) {
      const el = hunkRefs.current.get(h.headerIndex)
      if (el === undefined) continue
      if (el.offsetTop <= top + 24) {
        const sym = symbolForHunk(changes, h)
        const node = sym?.after ?? sym?.before
        ownerName = node?.qualifiedName ?? null
      }
    }
    setCurrentSymbol(ownerName)
  }, [changes, entry.hunks, scrollRef])

  const handleIdentifierClick = useCallback(
    (ev: React.MouseEvent) => {
      if (onIdentifier === undefined || entry.block === undefined) return
      const hit = resolveIdentifierClick(ev, 'data-hunkrow')
      if (hit === null) return
      const target = ev.target as Element
      const rowEl = target.closest('[data-hunkrow]')
      const hunkIdx = Number(rowEl?.getAttribute('data-hunk'))
      const hunk = entry.hunks.find((h) => h.headerIndex === hunkIdx)
      if (hunk === undefined) return
      // resolveIdentifierClick's `line` is the 1-based body row; convert to a
      // (side, file line, col) point through the F-05 state machine.
      const point = hunkPointToFilePoint(entry.block.lines, hunk, hit.line - 1, hit.col)
      if (point === null) return
      onIdentifier({ ...point, name: hit.name, clientX: ev.clientX, clientY: ev.clientY })
    },
    [onIdentifier, entry.block, entry.hunks],
  )

  if (entry.block === undefined) {
    return <div className="changes__outline-note muted">{t('tasks.changesTextUnavailable')}</div>
  }
  const lines = entry.block.lines
  const segments = buildDiffSegments(lines, entry.hunks)
  return (
    <div
      className="changes__diff"
      onScroll={onScroll}
      ref={scrollRef}
      onClick={handleIdentifierClick}
    >
      {currentSymbol !== null && (
        <div className="changes__sticky-symbol" data-testid="sticky-symbol">
          {currentSymbol}
        </div>
      )}
      <div className="diff__file-header">{entry.block.header}</div>
      {segments.map((seg, i) => {
        const owner = seg.hunk === null ? null : symbolForHunk(changes, seg.hunk)
        const ownerNode = owner?.after ?? owner?.before
        return (
          <section
            key={i}
            className="changes__hunk"
            ref={(el) => {
              if (seg.hunk === null) return
              if (el !== null) hunkRefs.current.set(seg.hunk.headerIndex, el)
              else hunkRefs.current.delete(seg.hunk.headerIndex)
            }}
          >
            {ownerNode !== undefined && (
              <button
                type="button"
                className="changes__hunk-owner"
                title={ownerNode.qualifiedName}
                onClick={() => onOwnerClick?.(ownerNode.qualifiedName)}
              >
                {ownerNode.qualifiedName}
              </button>
            )}
            <pre className="diff__body">
              {lines.slice(seg.start, seg.end).map((line, j) => (
                <span
                  key={j}
                  className={lineClassOf(line)}
                  // RFC-258 — body rows carry their hunk + 1-based body row so
                  // the identifier layer can run the F-05 coordinate machine.
                  {...(seg.hunk !== null && j > 0
                    ? { 'data-hunk': seg.hunk.headerIndex, 'data-hunkrow': j }
                    : {})}
                >
                  {line === '' ? ' ' : line}
                  {'\n'}
                </span>
              ))}
            </pre>
          </section>
        )
      })}
    </div>
  )
}

// Mirrors DiffViewer's per-line palette classes without exporting them anew.
function lineClassOf(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff__line diff__line--meta'
  if (line.startsWith('+')) return 'diff__line diff__line--add'
  if (line.startsWith('-')) return 'diff__line diff__line--del'
  if (line.startsWith('@@')) return 'diff__line diff__line--hunk'
  if (line.startsWith('diff --git') || line.startsWith('index '))
    return 'diff__line diff__line--meta'
  return 'diff__line'
}

/** RFC-258 §4.2 (impl-gate P1-6) — the full view's symbol anchor bar: every
 *  symbol of the CURRENT worktree file (not just changed ones) as a jump
 *  chip, plus the honest completeness badge when the table is degraded /
 *  unsupported / parse-error (gate F-09). Also the keyboard-reachable jump
 *  path AC-2 promises (real buttons). */
function FileSymbolAnchorBar({
  taskId,
  repoKey,
  filePath,
  onJumpToLine,
}: {
  taskId: string
  repoKey: string
  filePath: string
  onJumpToLine: (line: number) => void
}) {
  const { t } = useTranslation()
  const symbols = useQuery<FileSymbolsResultWire>({
    queryKey: ['rfc258FileSymbols', taskId, repoKeyWire(repoKey), filePath],
    queryFn: ({ signal }) =>
      api.get(
        `/api/tasks/${encodeURIComponent(taskId)}/file-symbols?path=${encodeURIComponent(filePath)}&repo=${encodeURIComponent(repoKeyWire(repoKey))}&side=worktree`,
        undefined,
        signal,
      ),
    retry: false,
  })
  const data = symbols.data
  const rows = data?.symbols ?? []
  if (data === undefined || (rows.length === 0 && data.status === 'ok')) return null
  return (
    <div className="changes__anchorbar" data-testid="symbol-anchor-bar">
      {data.status !== 'ok' && (
        <span className="structure__tag" title={data.status}>
          {t('tasks.fileSymbolsIncomplete')}
        </span>
      )}
      {rows.map((s, i) => (
        <button
          key={`${s.qualifiedName}-${i}`}
          type="button"
          className="changes__anchor"
          title={`${s.qualifiedName} · ${s.kind}`}
          onClick={() => onJumpToLine(s.range.startLine)}
        >
          {s.name}
        </button>
      ))}
    </div>
  )
}

export function ChangeFileDetail({
  taskId,
  entry,
  focusHunk,
  onOpenCallChain,
  codeView = 'hunk',
  onCodeViewChange,
  fullFocus = null,
  onFullFocusChange,
  onIdentifier,
}: {
  taskId: string
  entry: ChangeFileEntry
  focusHunk: HunkInfo | null
  onOpenCallChain?: (root: CallChainRoot) => void
  /** RFC-258 — hunk ↔ full-file source view; controlled by the panel so the
   *  navigation session can restore the pre-jump view (gate F-17). */
  codeView?: 'hunk' | 'full'
  onCodeViewChange?: (view: 'hunk' | 'full') => void
  /** Line to focus in the full view (jump arrival / outline anchor). */
  fullFocus?: number | null
  /** Anchor-bar jumps report the picked line back to the panel (P1-6). */
  onFullFocusChange?: (line: number) => void
  /** Identifier click from either view (full view reports side='worktree'). */
  onIdentifier?: (hit: {
    side: 'base' | 'worktree'
    line: number
    col: number
    name: string
    clientX: number
    clientY: number
  }) => void
}) {
  const { t } = useTranslation()
  const [docView, setDocView] = useState<'rendered' | 'text'>('rendered')
  const [pendingFocus, setPendingFocus] = useState<HunkInfo | null>(focusHunk)
  // Reverse jump target (impl-gate P2): qualifiedName of the outline row to
  // highlight after clicking a hunk's owner badge.
  const [outlineFocus, setOutlineFocus] = useState<string | null>(null)
  useEffect(() => setOutlineFocus(null), [entry.key])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => setPendingFocus(focusHunk), [focusHunk])
  useEffect(() => setDocView('rendered'), [entry.key])

  const isDoc = entry.kind === 'doc'
  const wantRendered = isDoc && docView === 'rendered'
  const contentParams = (side: 'base' | 'worktree'): string => {
    const p = new URLSearchParams({ path: entry.filePath, side })
    if (side === 'base' && entry.renamedFrom !== undefined) p.set('basePath', entry.renamedFrom)
    if (entry.repoLabel !== null) p.set('repo', entry.repoLabel)
    return p.toString()
  }
  const baseContent = useQuery<FileContentResult>({
    queryKey: ['tasks', taskId, 'file-content', entry.key, 'base'],
    queryFn: ({ signal }) =>
      api.get(
        `/api/tasks/${encodeURIComponent(taskId)}/file-content?${contentParams('base')}`,
        undefined,
        signal,
      ),
    enabled: wantRendered,
    retry: false,
  })
  const worktreeContent = useQuery<FileContentResult>({
    queryKey: ['tasks', taskId, 'file-content', entry.key, 'worktree'],
    queryFn: ({ signal }) =>
      api.get(
        `/api/tasks/${encodeURIComponent(taskId)}/file-content?${contentParams('worktree')}`,
        undefined,
        signal,
      ),
    enabled: wantRendered,
    retry: false,
  })
  // Any side failing (413/415/network) falls back to the text diff with a note
  // — but `{exists:false}` is a NORMAL empty side (pure add/delete), design
  // gate P1-N1.
  const renderedFailed = baseContent.isError || worktreeContent.isError
  const renderedReady = baseContent.data !== undefined && worktreeContent.data !== undefined

  return (
    <div className="changes__detail" data-testid="change-file-detail">
      <div className="changes__file-head">
        <span className="changes__file-path" title={entry.key}>
          {entry.filePath}
        </span>
        {entry.renamedFrom !== undefined && (
          <span className="changes__file-renamed" title={entry.renamedFrom}>
            {t('tasks.changesRenamedFrom', { from: entry.renamedFrom })}
          </span>
        )}
        {entry.structural?.status === 'degraded' && (
          <span className="structure__chip">{t('tasks.structDegradedChip')}</span>
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
        {isDoc && (
          <Segmented<'rendered' | 'text'>
            value={docView}
            onChange={setDocView}
            options={[
              { value: 'rendered', label: t('tasks.changesDocRendered') },
              { value: 'text', label: t('tasks.changesDocText') },
            ]}
            ariaLabel={t('tasks.changesDocViewLabel')}
            className="changes__doc-toggle"
          />
        )}
        {!isDoc && onCodeViewChange !== undefined && (
          <Segmented<'hunk' | 'full'>
            value={codeView}
            onChange={onCodeViewChange}
            options={[
              { value: 'hunk', label: t('tasks.changesCodeViewHunk') },
              { value: 'full', label: t('tasks.changesCodeViewFull') },
            ]}
            ariaLabel={t('tasks.changesCodeViewLabel')}
            className="changes__doc-toggle"
          />
        )}
      </div>
      <div className="changes__review-workspace">
        <SymbolOutline
          entry={entry}
          onJumpToHunk={(h) => setPendingFocus(h)}
          onOpenCallChain={onOpenCallChain}
          focusQualifiedName={outlineFocus}
        />
        <div className="changes__review-surface">
          {!isDoc && codeView === 'full' && onCodeViewChange !== undefined ? (
            <>
              <FileSymbolAnchorBar
                taskId={taskId}
                repoKey={entry.repoLabel ?? ''}
                filePath={entry.filePath}
                onJumpToLine={(line) => onFullFocusChange?.(line)}
              />
              <CodeViewer
                taskId={taskId}
                repoKey={entry.repoLabel ?? ''}
                filePath={entry.filePath}
                side="worktree"
                focus={fullFocus !== null ? { line: fullFocus } : null}
                changedRanges={fullFileRanges(entry.hunks)}
                onIdentifierClick={
                  onIdentifier === undefined
                    ? undefined
                    : (hit) => {
                        // The full view renders the worktree side (F-05); the caret
                        // layer already produced file-line coordinates.
                        onIdentifier({ side: 'worktree', ...hit })
                      }
                }
              />
            </>
          ) : wantRendered && !renderedFailed ? (
            renderedReady ? (
              <MarkdownDiffView
                left={baseContent.data.exists ? (baseContent.data.content ?? '') : ''}
                right={worktreeContent.data.exists ? (worktreeContent.data.content ?? '') : ''}
                className="changes__md"
              />
            ) : (
              <div className="changes__outline-note muted">{t('tasks.changesDocLoading')}</div>
            )
          ) : (
            <>
              {wantRendered && renderedFailed && (
                <ErrorBanner
                  error={baseContent.error ?? worktreeContent.error}
                  onRetry={() => {
                    void baseContent.refetch()
                    void worktreeContent.refetch()
                  }}
                />
              )}
              {entry.block !== undefined && entry.hunks.length === 0 ? (
                <DiffFileBody block={entry.block} />
              ) : (
                <AnnotatedDiff
                  key={entry.key} // fresh scroll + sticky state per file (impl-gate P2)
                  entry={entry}
                  focusHunk={pendingFocus}
                  scrollRef={scrollRef}
                  onOwnerClick={(qn) => setOutlineFocus(qn)}
                  onIdentifier={onIdentifier}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
