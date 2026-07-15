// RFC-041 PR4 — read-only list of approved memories for a single
// (scopeType, scopeId) pair. Embedded in agent / workflow / repo detail
// pages as the "Memories" sub-tab. Global scope passes scopeId=null.

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { Memory, MemoryScope, MemorySummary } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { useActor } from '@/hooks/useActor'
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
  // RFC-099 (D12): per-row canManage is the gate; admin role is the fallback
  // for payloads predating the annotation.
  const isAdmin = useActor().data?.user.role === 'admin'
  const [editingId, setEditingId] = useState<string | null>(null)
  const query: Record<string, string> = { status: 'approved', scopeType: props.scopeType }
  if (props.scopeId !== null) query.scopeId = props.scopeId
  const list = useQuery<ListResponse>({
    queryKey: ['memories', 'scoped', props.scopeType, props.scopeId ?? '__global__'],
    queryFn: ({ signal }) => api.get<ListResponse>('/api/memories', query, signal),
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
          title={t('memory.empty')}
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
            editable={(m.canManage ?? isAdmin) === true}
            onEdit={(m.canManage ?? isAdmin) === true ? () => setEditingId(m.id) : undefined}
          />
        ))}
      </ul>
      {editingId !== null && editingMemory.data?.memory !== undefined && (
        <MemoryEditDialog
          open
          onClose={() => setEditingId(null)}
          memory={editingMemory.data.memory}
        />
      )}
    </>
  )
}
