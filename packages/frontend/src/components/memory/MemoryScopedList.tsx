// RFC-041 PR4 — read-only list of approved memories for a single
// (scopeType, scopeId) pair. Embedded in agent / workflow / repo detail
// pages as the "Memories" sub-tab. Global scope passes scopeId=null.

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { Memory, MemoryScope, MemorySummary } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { LoadingState } from '@/components/LoadingState'
import { usePermission } from '@/hooks/useActor'
import { describeApiError } from '@/i18n'
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
  const isAdmin = usePermission('memory:edit')
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

  if (list.isLoading) return <LoadingState size="compact" />
  if (list.error !== null && list.error !== undefined) {
    return <div className="error-box">{describeApiError(list.error)}</div>
  }
  const rows = list.data?.items ?? []
  if (rows.length === 0) {
    return (
      <EmptyState
        title={t('memory.empty')}
        data-testid={props['data-testid'] ?? 'memory-scoped-empty'}
      />
    )
  }

  return (
    <>
      <ul className="memory-scoped-list" data-testid={props['data-testid'] ?? 'memory-scoped-list'}>
        {rows.map((m) => (
          <MemoryRow
            key={m.id}
            memory={m}
            editable={isAdmin}
            onEdit={isAdmin ? () => setEditingId(m.id) : undefined}
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
