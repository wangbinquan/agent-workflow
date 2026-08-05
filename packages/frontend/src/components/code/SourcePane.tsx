// RFC-258 §4.4 — the self-contained source pane for the graph↔source split
// (Sourcetrail-style): a CodeViewer + its own SymbolMenu + its own navigation
// stack, fed by a graph-side target. The target arrives as a STRUCTURAL file
// path (display key) + optional qualifiedName; the repo split is driven by the
// structural diff's EXPLICIT repoKey field — never guessed from the prefix
// shape (gate F-04) — and the symbol's line resolves through file-symbols
// (gate F-06: call-chain nodes carry refs, not positions).

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  repoKeyWire,
  type CodePosition,
  type FileSymbolsResult,
  type StructuralDiff,
  type SymbolResolution,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { CodeViewer } from './CodeViewer'
import { SymbolMenu } from './SymbolMenu'
import { CODE_NAV_EMPTY, codeNavReducer, codeNavTop } from '@/lib/codeNav'

export interface SourceTarget {
  /** Structural display path (multi-repo carries the repo-key prefix). */
  structuralPath: string
  qualifiedName?: string
  line?: number
}

/** Split a structural display path into (repoKey, repo-relative path) using
 *  the diff's explicit per-file repoKey (F-04). Structural-only misses fall
 *  back to the root repo with the path as-is. */
export function splitStructuralPath(
  data: StructuralDiff | undefined,
  structuralPath: string,
): { repoKey: string; filePath: string } {
  const file = data?.files.find((f) => f.filePath === structuralPath)
  if (file !== undefined) {
    const repoKey = file.repoKey ?? ''
    if (repoKey !== '' && structuralPath.startsWith(`${repoKey}/`)) {
      return { repoKey, filePath: structuralPath.slice(repoKey.length + 1) }
    }
    return { repoKey, filePath: structuralPath }
  }
  // Structural-only miss (deep refs often point at UNCHANGED files, impl-gate
  // P1-4): longest-prefix match over the diff's KNOWN repo keys — sourced from
  // explicit fields (top-level repoKeys + per-file repoKey), never guessed
  // from path shape alone (F-04).
  const known = new Set<string>(data?.repoKeys ?? [])
  for (const f of data?.files ?? []) if (f.repoKey !== undefined) known.add(f.repoKey)
  let best = ''
  for (const key of known) {
    if (key !== '' && structuralPath.startsWith(`${key}/`) && key.length > best.length) best = key
  }
  if (best !== '') return { repoKey: best, filePath: structuralPath.slice(best.length + 1) }
  return { repoKey: '', filePath: structuralPath }
}

export function SourcePane({
  taskId,
  data,
  target,
  engineMode,
  onClose,
}: {
  taskId: string
  data: StructuralDiff | undefined
  target: SourceTarget
  engineMode: 'baseline' | 'deep'
  onClose: () => void
}) {
  const { t } = useTranslation()
  const initial = useMemo(() => splitStructuralPath(data, target.structuralPath), [data, target])
  const [current, setCurrent] = useState<{
    repoKey: string
    filePath: string
    side: 'base' | 'worktree'
    line: number | null
  }>({ ...initial, side: 'worktree', line: target.line ?? null })
  useEffect(() => {
    setCurrent({ ...initial, side: 'worktree', line: target.line ?? null })
    dispatchNav({ type: 'clear' })
    setMenu(null)
  }, [initial, target.line])

  const [nav, dispatchNav] = useReducer(codeNavReducer, CODE_NAV_EMPTY)
  const [menu, setMenu] = useState<{
    anchor: { x: number; y: number }
    params: { line: number; col: number; name: string; side: 'base' | 'worktree' }
  } | null>(null)
  const paneRef = useRef<HTMLDivElement | null>(null)

  // qualifiedName → line via file-symbols (F-06), only when no line given.
  const wantSymbolLookup =
    target.qualifiedName !== undefined && target.qualifiedName !== '' && target.line === undefined
  const symbols = useQuery<FileSymbolsResult>({
    queryKey: ['rfc258FileSymbols', taskId, repoKeyWire(initial.repoKey), initial.filePath],
    queryFn: ({ signal }) =>
      api.get(
        `/api/tasks/${encodeURIComponent(taskId)}/file-symbols?path=${encodeURIComponent(initial.filePath)}&repo=${encodeURIComponent(repoKeyWire(initial.repoKey))}&side=worktree`,
        undefined,
        signal,
      ),
    enabled: wantSymbolLookup,
    retry: false,
  })
  const resolvedLine = useMemo(() => {
    if (!wantSymbolLookup) return null
    const qn = target.qualifiedName
    const hit =
      symbols.data?.symbols.find((s) => s.qualifiedName === qn) ??
      symbols.data?.symbols.find((s) => s.name === qn?.split('.').pop())
    return hit?.range.startLine ?? null
  }, [wantSymbolLookup, symbols.data, target.qualifiedName])
  useEffect(() => {
    if (resolvedLine === null) return
    // guard: only place the resolved line while still ON the initial target
    // (impl-gate P2-11 — a slow lookup raced a user navigation and clobbered it)
    setCurrent((c) =>
      c.filePath === initial.filePath && c.repoKey === initial.repoKey
        ? { ...c, line: resolvedLine }
        : c,
    )
  }, [resolvedLine, initial])

  const intel = useQuery<SymbolResolution>({
    queryKey: [
      'codeIntel',
      taskId,
      repoKeyWire(current.repoKey),
      current.filePath,
      menu?.params.side,
      menu?.params.line,
      menu?.params.col,
      menu?.params.name,
      engineMode,
      'pane',
      data?.contentDigest ?? '', // snapshot hint (impl-gate P1-1 / F-16)
    ],
    queryFn: ({ signal }) => {
      const p = menu?.params
      if (p === undefined) throw new Error('unreachable')
      const qs = new URLSearchParams({
        path: current.filePath,
        side: p.side,
        line: String(p.line),
        col: String(p.col),
        name: p.name,
        mode: engineMode,
        repo: repoKeyWire(current.repoKey),
      })
      return api.get(
        `/api/tasks/${encodeURIComponent(taskId)}/code-intel?${qs.toString()}`,
        undefined,
        signal,
      )
    },
    enabled: menu !== null,
    retry: false,
  })

  const navigateTo = useCallback(
    (pos: CodePosition) => {
      dispatchNav({
        type: 'push',
        from: {
          repoKey: current.repoKey,
          side: current.side,
          filePath: current.filePath,
          line: current.line ?? undefined,
          viewMode: 'full',
        },
      })
      setMenu(null)
      setCurrent({
        repoKey: pos.repoKey,
        filePath: pos.filePath,
        side: pos.side,
        line: pos.startLine,
      })
    },
    [current],
  )
  const navigateBack = useCallback(() => {
    const top = codeNavTop(nav)
    if (top === null) return
    dispatchNav({ type: 'pop' })
    setMenu(null)
    setCurrent({
      repoKey: top.repoKey,
      filePath: top.filePath,
      side: top.side,
      line: top.line ?? null,
    })
  }, [nav])

  const unresolvable = wantSymbolLookup && symbols.isSuccess && resolvedLine === null

  return (
    <div className="source-pane" ref={paneRef} data-testid="drill-source-pane">
      <div className="source-pane__head">
        {nav.stack.length > 0 && (
          <button type="button" className="btn btn--xs" onClick={navigateBack}>
            ← {t('tasks.codeNavBack')}
          </button>
        )}
        <span className="changes__crumbs-path" title={current.filePath}>
          {current.filePath}
        </span>
        <span className="source-pane__spacer" />
        <button
          type="button"
          className="btn btn--xs"
          onClick={onClose}
          aria-label={t('tasks.drillSourceClose')}
        >
          ✕
        </button>
      </div>
      {unresolvable ? (
        <EmptyState title={t('tasks.drillSourceSymbolMissing')} />
      ) : (
        <CodeViewer
          taskId={taskId}
          repoKey={current.repoKey}
          filePath={current.filePath}
          side={current.side}
          focus={current.line !== null ? { line: current.line } : null}
          onIdentifierClick={(hit) => {
            const rect = paneRef.current?.getBoundingClientRect()
            setMenu({
              anchor: {
                x: hit.clientX - (rect?.left ?? 0) + 4,
                y: hit.clientY - (rect?.top ?? 0) + 4,
              },
              params: { line: hit.line, col: hit.col, name: hit.name, side: current.side },
            })
          }}
        />
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
    </div>
  )
}
