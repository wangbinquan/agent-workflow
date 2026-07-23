// RFC-022: dependency-tree section embedded in NodeDetailDrawer's Stats tab.
// Fetches the closure of the workflow node's primary agent at the time the
// drawer is opened (the API reflects current DB state, not a snapshot — see
// design.md §5.6 trade-off). Same `<DependencyTree>` component as the
// AgentForm preview so the visual is identical.

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { AgentClosureSummary } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { buildDependencyTree, type DependencyTreeAgent } from '@/lib/dependency-tree'
import { DependencyTree } from './DependencyTree'

function toTreeAgents(rows: readonly AgentClosureSummary[]): DependencyTreeAgent[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    ownerUserId: r.ownerUserId,
    description: r.description,
    skills: r.skills,
    mcps: r.mcp,
    plugins: r.plugins,
    dependsOn: r.dependsOnIds,
    masked: r.masked,
    missing: r.missing,
  }))
}

interface ClosureResponse {
  ok: boolean
  agents?: AgentClosureSummary[]
  code?: string
}

interface Props {
  agentId: string
  /** Click handler for closure rows; if omitted, names render as plain text. */
  onNodeClick?: (id: string) => void
}

export function NodeDependencyTreeSection({ agentId, onNodeClick }: Props) {
  const { t } = useTranslation()
  const q = useQuery<ClosureResponse>({
    queryKey: ['agent-closure', agentId],
    queryFn: ({ signal }) =>
      api.get(`/api/agents/${encodeURIComponent(agentId)}/closure`, undefined, signal),
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
  const tree = buildDependencyTree(toTreeAgents(data.agents), agentId)
  if (tree.children.length === 0) {
    return <span className="muted">{t('dependencyTreePreview.emptyHint')}</span>
  }
  return <DependencyTree tree={tree} onNodeClick={onNodeClick} />
}
