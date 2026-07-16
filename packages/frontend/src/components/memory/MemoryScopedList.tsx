// RFC-041 PR4 — read-only list of approved memories for a single
// (scopeType, scopeId) pair. Embedded in agent / workflow / repo detail
// pages as the "Memories" sub-tab. Global scope passes scopeId=null.

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { MemoryScope, MemorySummary } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { MemoryEditDialog } from './MemoryEditDialog'
import { MemoryRow } from './MemoryRow'

interface ListResponse {
  items: MemorySummary[]
}

export interface MemoryScopedListProps {
  scopeType: MemoryScope
  scopeId: string | null
  'data-testid'?: string
}

export function MemoryScopedList(props: MemoryScopedListProps) {
  const { t } = useTranslation()
  const [editingId, setEditingId] = useState<string | null>(null)
  const query: Record<string, string> = { status: 'approved', scopeType: props.scopeType }
  if (props.scopeId !== null) query.scopeId = props.scopeId
  const list = useQuery<ListResponse>({
    queryKey: ['memories', 'scoped', props.scopeType, props.scopeId ?? '__global__'],
    queryFn: ({ signal }) => api.get<ListResponse>('/api/memories', query, signal),
  })
  const listError = list.error !== null && list.error !== undefined
  const retryAction = (
    <button type="button" className="btn btn--sm" onClick={() => void list.refetch()}>
      {t('common.retry')}
    </button>
  )
  if (list.data === undefined) {
    if (list.isLoading) return <LoadingState size="compact" />
    if (listError) {
      return <ErrorBanner error={list.error} action={retryAction} />
    }
    return <LoadingState size="compact" />
  }
  const rows = list.data.items
  if (rows.length === 0) {
    return (
      <>
        {listError && <ErrorBanner error={list.error} action={retryAction} />}
        <EmptyState
          title={t('memory.emptyStates.scope')}
          description={t('memory.emptyStates.scopeDescription')}
          data-testid={props['data-testid'] ?? 'memory-scoped-empty'}
        />
      </>
    )
  }

  return (
    <>
      {listError && <ErrorBanner error={list.error} action={retryAction} />}
      <ul className="memory-scoped-list" data-testid={props['data-testid'] ?? 'memory-scoped-list'}>
        {rows.map((m) => (
          <MemoryRow
            key={m.id}
            memory={m}
            editable={m.canManage === true}
            onEdit={m.canManage === true ? () => setEditingId(m.id) : undefined}
          />
        ))}
      </ul>
      {editingId !== null && (
        <MemoryEditDialog open onClose={() => setEditingId(null)} memoryId={editingId} />
      )}
    </>
  )
}
