// RFC-022: dependency-tree section embedded in NodeDetailDrawer's Stats tab.
// Fetches the closure of the workflow node's primary agent at the time the
// drawer is opened (the API reflects current DB state, not a snapshot — see
// design.md §5.6 trade-off). Same `<DependencyTree>` component as the
// AgentForm preview so the visual is identical.

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import { buildDependencyTree, type DependencyTreeAgent } from '@/lib/dependency-tree'
import { DependencyTree } from './DependencyTree'

/** Wire shape coming back from /api/agents/:name/closure. */
interface ClosureSummary {
  name: string
  description: string
  skillCount: number
  /** RFC-028 — raw mcp[]; we map to mcpCount in `toTreeAgents` below. */
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

interface ClosureResponse {
  ok: boolean
  agents?: ClosureSummary[]
  code?: string
}

interface Props {
  agentName: string
  /** Click handler for closure rows; if omitted, names render as plain text. */
  onNodeClick?: (name: string) => void
}

export function NodeDependencyTreeSection({ agentName, onNodeClick }: Props) {
  const { t } = useTranslation()
  const q = useQuery<ClosureResponse>({
    queryKey: ['agent-closure', agentName],
    queryFn: ({ signal }) =>
      api.get(`/api/agents/${encodeURIComponent(agentName)}/closure`, undefined, signal),
    staleTime: 30_000,
    retry: false,
  })

  if (q.isLoading) {
    return <span className="muted">{t('dependencyTreePreview.loading')}</span>
  }
  if (q.error !== null && q.error !== undefined) {
    return (
      <span className="muted">{t('dependencyTreePreview.errorGeneric', { code: 'fetch' })}</span>
    )
  }
  const data = q.data
  if (data === undefined || data.agents === undefined) return null
  const tree = buildDependencyTree(toTreeAgents(data.agents), agentName)
  if (tree.children.length === 0) {
    return <span className="muted">{t('dependencyTreePreview.emptyHint')}</span>
  }
  return <DependencyTree tree={tree} onNodeClick={onNodeClick} />
}
