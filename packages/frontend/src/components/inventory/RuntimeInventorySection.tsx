// RFC-029: Runtime Inventory section rendered at the top of the
// NodeDetailDrawer's Session tab (between the attempts switcher and the
// ConversationFlow). Shows what the opencode child process actually
// loaded — agents / skills / mcps / plugins — sourced from the per-run
// inventory snapshot written by the framework-injected dump plugin.

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { InventorySnapshot } from '@agent-workflow/shared'
import { isAgentNodeKind } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { AgentsTable } from './AgentsTable'
import { SkillsTable } from './SkillsTable'
import { McpsTable } from './McpsTable'
import { PluginsTable } from './PluginsTable'

interface Props {
  taskId: string
  nodeRunId: string
  workflowNodeKind: string | null
}

export function RuntimeInventorySection({ taskId, nodeRunId, workflowNodeKind }: Props) {
  const { t } = useTranslation()
  // useState (not useEffect) so the open/closed preference is preserved
  // across attempt switches per RFC-029 AC-9.
  const [open, setOpen] = useState(false)
  // Non-agent kinds never produce inventory; the early-return below renders
  // nothing so the Session tab's `sessionNotApplicable` placeholder owns the
  // layout. The query is kept enabled-by-flag so hook order stays stable
  // (react-hooks/rules-of-hooks).
  const enabled = isAgentNodeKind(workflowNodeKind)
  const query = useQuery<InventorySnapshot>({
    queryKey: ['tasks', taskId, 'node-runs', nodeRunId, 'inventory'],
    enabled,
    queryFn: ({ signal }) =>
      api.get<InventorySnapshot>(
        `/api/tasks/${encodeURIComponent(taskId)}/node-runs/${encodeURIComponent(nodeRunId)}/inventory`,
        undefined,
        signal,
      ),
  })
  if (!enabled) return null
  const snap = query.data

  return (
    <details
      className="inventory-section"
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      data-testid="runtime-inventory-section"
    >
      <summary className="inventory-section__summary">
        <span>{t('nodeDrawer.inventory.title')}</span>
        {snap !== undefined && snap.captured && (
          <span className="inventory-section__chips" data-testid="inventory-chips">
            <span className="inventory-section__chip">
              {t('nodeDrawer.inventory.chip.agents')}·{snap.agents.length}
            </span>
            <span className="inventory-section__chip">
              {t('nodeDrawer.inventory.chip.skills')}·{snap.skills.length}
            </span>
            <span className="inventory-section__chip">
              {t('nodeDrawer.inventory.chip.mcps')}·{snap.mcps.length}
            </span>
            <span className="inventory-section__chip">
              {t('nodeDrawer.inventory.chip.plugins')}·{snap.plugins.length}
            </span>
          </span>
        )}
      </summary>
      <InventoryBody query={query} />
    </details>
  )
}

interface QueryShape {
  isLoading: boolean
  error: unknown
  data: InventorySnapshot | undefined
}

function InventoryBody({ query }: { query: QueryShape }) {
  const { t } = useTranslation()
  if (query.isLoading) {
    return <div className="inventory-section__pending">{t('nodeDrawer.inventory.pending')}</div>
  }
  if (query.error !== null && query.error !== undefined) {
    return (
      <div className="inventory-section__missing">
        {t('nodeDrawer.inventory.reason.file-missing')}
      </div>
    )
  }
  const snap = query.data
  if (snap === undefined) return null
  if (!snap.captured) {
    const reasonKey = `nodeDrawer.inventory.reason.${snap.reason}` as const
    return (
      <div className="inventory-section__missing" data-testid="inventory-missing">
        {t(reasonKey, { defaultValue: snap.reason })}
      </div>
    )
  }
  return (
    <div className="inventory-section__body">
      <h4 className="inventory-section__subtitle">{t('nodeDrawer.inventory.subtitle.agents')}</h4>
      <AgentsTable agents={snap.agents} />
      <h4 className="inventory-section__subtitle">{t('nodeDrawer.inventory.subtitle.skills')}</h4>
      <SkillsTable skills={snap.skills} />
      <h4 className="inventory-section__subtitle">{t('nodeDrawer.inventory.subtitle.mcps')}</h4>
      <McpsTable mcps={snap.mcps} />
      <h4 className="inventory-section__subtitle">{t('nodeDrawer.inventory.subtitle.plugins')}</h4>
      <PluginsTable plugins={snap.plugins} />
    </div>
  )
}
