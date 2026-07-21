// RFC-041 PR4 — group-by-scope view used in /memory/by-scope.

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { MemorySummary } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { groupCandidatesByScope, SCOPE_TABS } from '@/lib/memory'
import { MemoryEditDialog } from './MemoryEditDialog'
import { MemoryRow } from './MemoryRow'

interface ListResponse {
  items: MemorySummary[]
}

export function MemoryByScopeBrowser() {
  const { t } = useTranslation()
  const [editingId, setEditingId] = useState<string | null>(null)
  const approved = useQuery<ListResponse>({
    queryKey: ['memories', 'all'],
    queryFn: ({ signal }) => api.get<ListResponse>('/api/memories', { status: 'approved' }, signal),
  })
  const approvedError = approved.error !== null && approved.error !== undefined
  if (approved.data === undefined) {
    if (approved.isLoading) return <LoadingState />
    if (approvedError) {
      return <ErrorBanner error={approved.error} onRetry={() => void approved.refetch()} />
    }
    return <LoadingState />
  }
  const grouped = groupCandidatesByScope(approved.data.items)

  return (
    <div className="memory-by-scope" data-testid="memory-by-scope">
      {approvedError && (
        <ErrorBanner error={approved.error} onRetry={() => void approved.refetch()} />
      )}
      {SCOPE_TABS.map((scope) => (
        <section key={scope} className="memory-by-scope__section" data-scope={scope}>
          <h3 className="memory-by-scope__heading">
            {t(`memory.scope.${scope}`)} ({grouped[scope].length})
          </h3>
          {grouped[scope].length === 0 ? (
            <EmptyState
              size="compact"
              title={t('memory.emptyStates.scope')}
              description={t('memory.emptyStates.scopeDescription')}
            />
          ) : (
            <ul className="memory-by-scope__list">
              {grouped[scope].map((m) => (
                <MemoryRow
                  key={m.id}
                  memory={m}
                  editable={m.canManage === true}
                  onEdit={m.canManage === true ? () => setEditingId(m.id) : undefined}
                />
              ))}
            </ul>
          )}
        </section>
      ))}
      {editingId !== null && (
        <MemoryEditDialog open onClose={() => setEditingId(null)} memoryId={editingId} />
      )}
    </div>
  )
}
