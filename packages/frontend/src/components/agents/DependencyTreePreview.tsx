// RFC-022: live `<DependencyTree>` preview inside AgentForm. Owns:
//   - 200ms debounce on `dependsOn` changes (the form fires onChange on every
//     chip add/remove, which we don't want to hammer the API with)
//   - call to POST /api/agents/closure-preview (returns 200 + ok:false on
//     validation errors so this hook doesn't have to switch on HTTP status)
//   - rendering: <DependencyTree> when closure expands, <DependencyCycleHint>
//     for cycles, plain error chips for not-found / self-ref, muted hint
//     when no dependents are declared.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import { buildDependencyTree, type DependencyTreeAgent } from '@/lib/dependency-tree'
import { DependencyCycleHint, DependencyTree } from './DependencyTree'

/** Wire shape coming back from /api/agents/closure-preview. */
interface ClosureSummary {
  name: string
  description: string
  skillCount: number
  /** RFC-028 — raw mcp[] from the closure response; we derive mcpCount
   *  in `toTreeAgents` below so the tree renderer never sees the array. */
  mcp?: string[]
  readonly: boolean
  dependsOn: readonly string[]
  missing?: boolean
}

function toTreeAgents(rows: readonly ClosureSummary[]): DependencyTreeAgent[] {
  return rows.map((r) => ({
    name: r.name,
    description: r.description,
    skillCount: r.skillCount,
    mcpCount: r.mcp?.length ?? 0,
    readonly: r.readonly,
    dependsOn: r.dependsOn,
  }))
}

interface PreviewOk {
  ok: true
  agents: ClosureSummary[]
}

interface PreviewErr {
  ok: false
  code: string
  details?: { cyclePath?: string[]; notFound?: string[]; name?: string }
}

type PreviewResponse = PreviewOk | PreviewErr

interface Props {
  /** Self name (may be empty for new-agent flow — preview still works). */
  name: string
  dependsOn: string[]
  /** Optional click handler for closure-member rows. Defaults to navigating
   *  to `/agents/:name`; tests can pass a vi.fn() instead. */
  onNodeClick?: (name: string) => void
}

export function DependencyTreePreview({ name, dependsOn, onNodeClick }: Props) {
  const { t } = useTranslation()
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ok'; agents: ClosureSummary[] }
    | { kind: 'err'; code: string; details: PreviewErr['details'] }
  >({ kind: 'idle' })
  // Track each in-flight request so a slow response can't clobber a newer one.
  const seqRef = useRef(0)
  // Serialize dependsOn so the effect re-runs only when the content changes
  // (parent renders pass a fresh array reference every keystroke).
  const dependsOnKey = dependsOn.join('\n')

  useEffect(() => {
    if (name === '' && dependsOn.length === 0) {
      setState({ kind: 'idle' })
      return
    }
    const mySeq = ++seqRef.current
    const handle = setTimeout(() => {
      setState({ kind: 'loading' })
      api
        .post<PreviewResponse>('/api/agents/closure-preview', { name, dependsOn })
        .then((res) => {
          if (mySeq !== seqRef.current) return
          if (res.ok) {
            setState({ kind: 'ok', agents: res.agents })
          } else {
            setState({ kind: 'err', code: res.code, details: res.details })
          }
        })
        .catch(() => {
          if (mySeq !== seqRef.current) return
          setState({ kind: 'err', code: 'network', details: {} })
        })
    }, 200)
    return () => {
      clearTimeout(handle)
    }
    // The dependency on `dependsOn` is intentionally serialized via the
    // memoized key below — array identity changes on every render but the
    // serialized content is what should retrigger the preview fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, dependsOnKey])

  if (state.kind === 'idle') {
    return <p className="muted dep-tree__empty">{t('dependencyTreePreview.emptyHint')}</p>
  }
  if (state.kind === 'loading') {
    return <p className="muted dep-tree__loading">{t('dependencyTreePreview.loading')}</p>
  }
  if (state.kind === 'err') {
    if (state.code === 'agent-dependency-cycle' && state.details?.cyclePath) {
      return <DependencyCycleHint cyclePath={state.details.cyclePath} />
    }
    if (state.code === 'agent-dependency-self') {
      return (
        <p className="dep-tree__error" role="alert">
          {t('dependencyTreePreview.errorSelf')}
        </p>
      )
    }
    if (state.code === 'agent-dependency-not-found') {
      const names = (state.details?.notFound ?? []).join(', ')
      return (
        <p className="dep-tree__error" role="alert">
          {t('dependencyTreePreview.errorNotFound', { names })}
        </p>
      )
    }
    return (
      <p className="dep-tree__error" role="alert">
        {t('dependencyTreePreview.errorGeneric', { code: state.code })}
      </p>
    )
  }
  // ok: build tree. With name='' fallback to first agent if root absent.
  const rootName = name === '' ? (state.agents[0]?.name ?? '') : name
  if (rootName === '') {
    return <p className="muted dep-tree__empty">{t('dependencyTreePreview.emptyHint')}</p>
  }
  const tree = buildDependencyTree(toTreeAgents(state.agents), rootName)
  // tree.children empty + tree exists = no dependents declared. Show hint.
  if (tree.children.length === 0) {
    return <p className="muted dep-tree__empty">{t('dependencyTreePreview.emptyHint')}</p>
  }
  return <DependencyTree tree={tree} onNodeClick={onNodeClick} />
}
