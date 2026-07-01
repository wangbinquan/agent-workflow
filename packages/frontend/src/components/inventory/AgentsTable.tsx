// RFC-029: tabular view of agents the opencode child process actually
// loaded. Source values map onto i18n keys; unknown sources fall back to
// the raw string so the table never breaks on a future opencode release.

import { useTranslation } from 'react-i18next'
import type { InventoryAgent } from '@agent-workflow/shared'
import { sourceLabel } from './sourceLabel'

export function AgentsTable({ agents }: { agents: readonly InventoryAgent[] }) {
  const { t } = useTranslation()
  if (agents.length === 0) {
    return <div className="muted inventory-section__empty">{t('nodeDrawer.inventory.empty')}</div>
  }
  return (
    <table className="inventory-table inventory-table--agents">
      <colgroup>
        <col className="col-name" />
        <col className="col-mode" />
        <col className="col-model" />
        <col className="col-source" />
      </colgroup>
      <thead>
        <tr>
          <th>{t('nodeDrawer.inventory.col.name')}</th>
          <th>{t('nodeDrawer.inventory.col.mode')}</th>
          <th>{t('nodeDrawer.inventory.col.model')}</th>
          <th>{t('nodeDrawer.inventory.col.source')}</th>
        </tr>
      </thead>
      <tbody>
        {agents.map((a) => (
          <tr key={a.name}>
            <td>{a.name}</td>
            <td>{a.mode}</td>
            <td>
              {a.modelProviderId !== null || a.modelId !== null
                ? `${a.modelProviderId ?? '?'} / ${a.modelId ?? '?'}`
                : '—'}
            </td>
            <td>{sourceLabel(a.source, t)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
