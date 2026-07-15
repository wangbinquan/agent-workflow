// RFC-041 PR4 — group-by-scope view used in /memory/by-scope.

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { Memory, MemorySummary } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { groupCandidatesByScope, SCOPE_TABS } from '@/lib/memory'
import { useActor } from '@/hooks/useActor'
import { MemoryEditDialog } from './MemoryEditDialog'
import { MemoryRow } from './MemoryRow'

interface ListResponse {
  items: MemorySummary[]
}

export function MemoryByScopeBrowser() {
  const { t } = useTranslation()
  // RFC-099 (D12): per-row canManage is the gate; admin role is the fallback
  // for payloads predating the annotation.
  const isAdmin = useActor().data?.user.role === 'admin'
  const [editingId, setEditingId] = useState<string | null>(null)
  const approved = useQuery<ListResponse>({
    queryKey: ['memories', 'all'],
    queryFn: ({ signal }) => api.get<ListResponse>('/api/memories', { status: 'approved' }, signal),
  })
  const editingMemory = useQuery<{ memory: Memory }>({
    queryKey: ['memories', 'detail', editingId],
    queryFn: ({ signal }) =>
      api.get<{ memory: Memory }>(
        `/api/memories/${encodeURIComponent(editingId ?? '')}`,
        undefined,
        signal,
      ),
    enabled: editingId !== null,
  })

  const approvedError = approved.error !== null && approved.error !== undefined
  const retryAction = (
    <button type="button" className="btn btn--sm" onClick={() => void approved.refetch()}>
      {t('common.retry')}
    </button>
  )
  if (approved.data === undefined) {
    if (approved.isLoading) return <LoadingState />
    if (approvedError) {
      return <ErrorBanner error={approved.error} action={retryAction} />
    }
    return <LoadingState />
  }
  const grouped = groupCandidatesByScope(approved.data.items)

  return (
    <div className="memory-by-scope" data-testid="memory-by-scope">
      {approvedError && <ErrorBanner error={approved.error} action={retryAction} />}
      {SCOPE_TABS.map((scope) => (
        <section key={scope} className="memory-by-scope__section" data-scope={scope}>
          <h3 className="memory-by-scope__heading">
            {t(`memory.scope.${scope}`)} ({grouped[scope].length})
          </h3>
          {grouped[scope].length === 0 ? (
            <EmptyState size="compact" title={t('memory.empty')} />
          ) : (
            <ul className="memory-by-scope__list">
              {grouped[scope].map((m) => (
                <MemoryRow
                  key={m.id}
                  memory={m}
                  editable={(m.canManage ?? isAdmin) === true}
                  onEdit={(m.canManage ?? isAdmin) === true ? () => setEditingId(m.id) : undefined}
                />
              ))}
            </ul>
          )}
        </section>
      ))}
      {editingId !== null && editingMemory.data?.memory !== undefined && (
        <MemoryEditDialog
          open
          onClose={() => setEditingId(null)}
          memory={editingMemory.data.memory}
        />
      )}
    </div>
  )
}
