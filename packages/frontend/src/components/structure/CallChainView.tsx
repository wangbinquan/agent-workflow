// RFC-085 — the "调用链" view: a root (changed) method and its forward call chain,
// expanded LAZILY one level at a time (GET /call-targets per method). Resolved
// callees get a ▸ to drill deeper; external/unresolved are grey leaves; cycles +
// the depth cap stop the recursion. Default-open one level (the root's callees).

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { CallTarget } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { expandState, walkChainTree, type ExpandState } from '@/lib/callChain'
import { buildSequence, type SeqCallNode } from '@/lib/sequence'
import { SequenceDiagram } from './SequenceDiagram'
import { LoadingState } from '@/components/LoadingState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { EmptyState } from '@/components/EmptyState'
import { Segmented } from '@/components/Segmented'

export interface CallChainRoot {
  /** `${filePath}#${qualifiedName}` of the root (changed) method. */
  ref: string
  /** display label, e.g. `charge()`. */
  label: string
}

type ChainMode = 'tree' | 'sequence'

export function CallChainView({
  taskId,
  root,
  onOpenSource,
}: {
  taskId: string
  root: CallChainRoot | null
  /** RFC-258 — jump to a resolved callee's definition in the source pane. */
  onOpenSource?: (target: { structuralPath: string; qualifiedName: string }) => void
}) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<ChainMode>('tree')
  if (root === null) {
    return <EmptyState title={t('tasks.structCallPick')} />
  }
  return (
    <div className="callchain" data-testid="call-chain">
      <div className="callchain__top">
        <div className="callchain__root">
          <span className="callchain__root-glyph" aria-hidden="true">
            ⎇
          </span>
          <span className="callchain__root-label">{root.label}</span>
        </div>
        <Segmented<ChainMode>
          value={mode}
          onChange={setMode}
          options={(['tree', 'sequence'] as const).map((m) => ({
            value: m,
            label: t(m === 'tree' ? 'tasks.structCallModeTree' : 'tasks.structCallModeSequence'),
          }))}
          ariaLabel={t('tasks.structCallMode')}
          className="callchain__mode"
        />
      </div>
      {mode === 'tree' ? (
        <CallLevel
          taskId={taskId}
          parentRef={root.ref}
          ancestors={new Set([root.ref])}
          depth={1}
          onOpenSource={onOpenSource}
        />
      ) : (
        <SequencePane taskId={taskId} root={root} onOpenSource={onOpenSource} />
      )}
    </div>
  )
}

/** Owner-class lifeline id for a method ref (`file#A.b` → `file::A`). */
function rootClassOf(ref: string): string {
  const hash = ref.indexOf('#')
  const file = hash < 0 ? ref : ref.slice(0, hash)
  const qn = hash < 0 ? ref : ref.slice(hash + 1)
  const dot = qn.lastIndexOf('.')
  return `${file}::${dot > 0 ? qn.slice(0, dot) : qn}`
}

/** Eagerly (but bounded) walk the chain for the diagram, via the pure
 *  `walkChainTree` (cycle/depth/node truncation lives there + is unit-tested). */
function fetchChainTree(
  taskId: string,
  rootRef: string,
  signal: AbortSignal | undefined,
): Promise<{ tree: SeqCallNode[]; truncated: boolean }> {
  const fetcher = async (ref: string): Promise<CallTarget[]> => {
    const res = await api.get<{ targets: CallTarget[] }>(
      `/api/tasks/${encodeURIComponent(taskId)}/call-targets?methodRef=${encodeURIComponent(ref)}`,
      undefined,
      signal,
    )
    return res.targets ?? []
  }
  return walkChainTree(rootRef, fetcher)
}

function SequencePane({
  taskId,
  root,
  onOpenSource,
}: {
  taskId: string
  root: CallChainRoot
  onOpenSource?: (target: { structuralPath: string; qualifiedName: string }) => void
}) {
  const { t } = useTranslation()
  const q = useQuery({
    queryKey: ['chainTree', taskId, root.ref],
    queryFn: ({ signal }) => fetchChainTree(taskId, root.ref, signal),
  })
  if (q.isLoading) return <LoadingState />
  if (q.isError) return <ErrorBanner error={q.error} />
  const model = buildSequence(rootClassOf(root.ref), q.data?.tree ?? [])
  return (
    <div className="callchain__sequence">
      {q.data?.truncated === true && (
        <div className="callchain__empty muted">{t('tasks.structCallSeqTruncated')}</div>
      )}
      <SequenceDiagram model={model} onOpenSource={onOpenSource} />
    </div>
  )
}

/** One level of callees for `parentRef` (always loads — that's the "lazy" unit). */
function CallLevel({
  taskId,
  parentRef,
  ancestors,
  depth,
  onOpenSource,
}: {
  taskId: string
  parentRef: string
  ancestors: ReadonlySet<string>
  depth: number
  onOpenSource?: (target: { structuralPath: string; qualifiedName: string }) => void
}) {
  const { t } = useTranslation()
  const q = useQuery<{ targets: CallTarget[] }>({
    queryKey: ['callTargets', taskId, parentRef],
    queryFn: ({ signal }) =>
      api.get(
        `/api/tasks/${encodeURIComponent(taskId)}/call-targets?methodRef=${encodeURIComponent(parentRef)}`,
        undefined,
        signal,
      ),
  })
  if (q.isLoading) return <LoadingState />
  if (q.isError) return <ErrorBanner error={q.error} />
  const targets = (q.data?.targets ?? []).slice().sort((a, b) => a.order - b.order)
  if (targets.length === 0) {
    return <div className="callchain__empty muted">{t('tasks.structCallNoCalls')}</div>
  }
  return (
    <ul className="callchain__list">
      {targets.map((tg, i) => (
        <CallNode
          key={`${tg.order}-${tg.label}-${i}`}
          taskId={taskId}
          target={tg}
          ancestors={ancestors}
          depth={depth}
          onOpenSource={onOpenSource}
        />
      ))}
    </ul>
  )
}

const STATE_TAG: Record<Exclude<ExpandState, 'expandable'>, string> = {
  leaf: '', // external/unresolved get their own tag below
  cycle: 'tasks.structCallCycle',
  'too-deep': 'tasks.structCallTruncated',
}

function CallNode({
  taskId,
  target,
  ancestors,
  depth,
  onOpenSource,
}: {
  taskId: string
  target: CallTarget
  ancestors: ReadonlySet<string>
  depth: number
  onOpenSource?: (target: { structuralPath: string; qualifiedName: string }) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const state = expandState(target, ancestors, depth)
  const expandable = state === 'expandable'
  return (
    <li className="callchain__node">
      <div className={`callchain__row callchain__row--${target.resolution}`}>
        {expandable ? (
          <button
            type="button"
            className="callchain__toggle"
            aria-expanded={open}
            aria-label={t(open ? 'tasks.structCallCollapse' : 'tasks.structCallExpand')}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="callchain__bullet" aria-hidden="true">
            ·
          </span>
        )}
        <span className="callchain__label">{target.label}</span>
        {onOpenSource !== undefined &&
          target.resolution === 'resolved' &&
          target.ref !== undefined && (
            <button
              type="button"
              className="callchain__source"
              title={t('tasks.structOpenSource')}
              aria-label={t('tasks.structOpenSource')}
              onClick={() => {
                const ref = target.ref ?? ''
                const hash = ref.indexOf('#')
                onOpenSource({
                  structuralPath: hash < 0 ? ref : ref.slice(0, hash),
                  qualifiedName: hash < 0 ? '' : ref.slice(hash + 1),
                })
              }}
            >
              ‹›
            </button>
          )}
        {target.resolution === 'external' && (
          <span className="callchain__tag callchain__tag--external">
            {t('tasks.structCallExternal')}
          </span>
        )}
        {target.resolution === 'unresolved' && (
          <span className="callchain__tag callchain__tag--unresolved">
            {t('tasks.structCallUnresolved')}
          </span>
        )}
        {state !== 'expandable' && state !== 'leaf' && (
          <span className="callchain__tag">{t(STATE_TAG[state])}</span>
        )}
      </div>
      {open && expandable && target.ref !== undefined && (
        <div className="callchain__children">
          <CallLevel
            taskId={taskId}
            parentRef={target.ref}
            ancestors={new Set([...ancestors, target.ref])}
            depth={depth + 1}
            onOpenSource={onOpenSource}
          />
        </div>
      )}
    </li>
  )
}
