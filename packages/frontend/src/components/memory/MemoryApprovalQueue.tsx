// RFC-041 PR4 — admin approval queue.
//
// Lists every status='candidate' memory and exposes [Approve] / [Reject]
// (and [Compare] for conflict_with). Non-admin users land here only
// because of misnavigation: action buttons are rendered disabled.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Memory, MemoryCandidatePromote } from '@agent-workflow/shared'
import type { ApiError } from '@/api/client'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { LoadingState } from '@/components/LoadingState'
import { MemoryConflictCompareDialog } from './MemoryConflictCompareDialog'
import { MemoryEditDialog } from './MemoryEditDialog'
import { promoteActionToLabel, sourceKindLabel } from '@/lib/memory'
import { describeApiError } from '@/i18n'

interface ListResponse {
  items: Memory[]
}

export interface MemoryApprovalQueueProps {
  isAdmin: boolean
}

export function MemoryApprovalQueue({ isAdmin }: MemoryApprovalQueueProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  // `include=body` widens the list rows to full Memory shape so the card can
  // render bodyMd / sourceKind / sourceEventId / supersedesId inline — without
  // it admins would approve candidates blind. See routes-memories.ts.
  const candidates = useQuery<ListResponse>({
    queryKey: ['memories', 'candidates'],
    queryFn: ({ signal }) =>
      api.get<ListResponse>('/api/memories', { status: 'candidate', include: 'body' }, signal),
  })

  const promote = useMutation<Memory, ApiError, { id: string; body: MemoryCandidatePromote }>({
    mutationFn: async ({ id, body }) => {
      const res = await api.post<{ memory: Memory }>(
        `/api/memories/${encodeURIComponent(id)}/promote`,
        body,
      )
      return res.memory
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['memories', 'candidates'] })
      void qc.invalidateQueries({ queryKey: ['memories', 'pending-count'] })
      void qc.invalidateQueries({ queryKey: ['memories', 'all'] })
    },
  })

  const [compareWith, setCompareWith] = useState<{
    candidate: Memory
    existingId: string
  } | null>(null)
  // RFC-045: row-level edit dialog. Even though the approval queue now
  // loads full Memory rows (via `include=body`), MemoryEditDialog wants the
  // canonical detail shape (timestamps + chain), so we still fetch by id on
  // click and only mount the dialog once that response is in the cache.
  const [editingId, setEditingId] = useState<string | null>(null)
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

  if (candidates.isLoading) {
    return <LoadingState />
  }
  if (candidates.error !== null && candidates.error !== undefined) {
    return <div className="error-box">{describeApiError(candidates.error)}</div>
  }
  const rows = candidates.data?.items ?? []
  if (rows.length === 0) {
    return <EmptyState title={t('memory.empty')} data-testid="memory-approval-queue-empty" />
  }

  return (
    <div className="memory-approval-queue" data-testid="memory-approval-queue">
      {/* RFC-099 (D12): non-admins may still manage rows whose scoped
          resource they OWN — the banner only shows when nothing here is
          manageable by them. */}
      {!isAdmin && rows.every((m) => m.canManage !== true) && rows.length > 0 && (
        <div className="info-box info-box--muted" data-testid="memory-admin-only-banner">
          {t('memory.adminOnly')}
        </div>
      )}
      <ul className="memory-approval-queue__list">
        {rows.map((mem) => (
          <CandidateCard
            key={mem.id}
            candidate={mem}
            isAdmin={mem.canManage ?? isAdmin}
            disabled={promote.isPending}
            onApprove={() => promote.mutate({ id: mem.id, body: { action: 'approve' } })}
            onReject={() => promote.mutate({ id: mem.id, body: { action: 'reject' } })}
            onCompare={(refId) => setCompareWith({ candidate: mem, existingId: refId })}
            onEdit={(mem.canManage ?? isAdmin) ? () => setEditingId(mem.id) : undefined}
          />
        ))}
      </ul>
      {compareWith !== null && (
        <MemoryConflictCompareDialog
          open
          onClose={() => setCompareWith(null)}
          candidate={compareWith.candidate}
          existingId={compareWith.existingId}
          approving={promote.isPending}
          rejecting={promote.isPending}
          onApproveSupersede={
            isAdmin
              ? () => {
                  promote.mutate(
                    {
                      id: compareWith.candidate.id,
                      body: {
                        action: 'approve_and_supersede',
                        supersedeIds: [compareWith.existingId],
                      },
                    },
                    { onSuccess: () => setCompareWith(null) },
                  )
                }
              : undefined
          }
          onReject={
            isAdmin
              ? () => {
                  promote.mutate(
                    { id: compareWith.candidate.id, body: { action: 'reject' } },
                    { onSuccess: () => setCompareWith(null) },
                  )
                }
              : undefined
          }
        />
      )}
      {promote.error !== null && promote.error !== undefined && (
        <div className="error-box" data-testid="memory-approve-error">
          {describeApiError(promote.error)}
        </div>
      )}
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

interface CandidateCardProps {
  candidate: Memory
  isAdmin: boolean
  disabled: boolean
  onApprove: () => void
  onReject: () => void
  onCompare: (refId: string) => void
  /** RFC-045: when defined and the user is admin, render an [Edit] button. */
  onEdit?: () => void
}

function CandidateCard({
  candidate,
  isAdmin,
  disabled,
  onApprove,
  onReject,
  onCompare,
  onEdit,
}: CandidateCardProps) {
  const { t } = useTranslation()
  const label =
    candidate.distillAction !== null
      ? promoteActionToLabel(candidate.distillAction, candidate.supersedesId)
      : null
  const refId = candidate.supersedesId
  return (
    <li className="memory-candidate-card" data-testid={`memory-candidate-${candidate.id}`}>
      <header className="memory-candidate-card__head">
        <span
          className={`memory-row__scope memory-row__scope--${candidate.scopeType}`}
          data-testid={`memory-candidate-scope-${candidate.id}`}
        >
          {t(`memory.scope.${candidate.scopeType}`)}
        </span>
        <h3 className="memory-candidate-card__title">{candidate.title}</h3>
        {label !== null && (
          <span
            className={`memory-candidate-card__action-tag memory-candidate-card__action-tag--${candidate.distillAction}`}
          >
            {t(label.i18nKey, label.params)}
          </span>
        )}
      </header>
      <CollapsibleBody bodyMd={candidate.bodyMd} candidateId={candidate.id} />
      {candidate.tags.length > 0 && (
        <div className="memory-candidate-card__tags">
          {candidate.tags.map((tag) => (
            <span key={tag} className="memory-row__tag">
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="memory-candidate-card__meta muted">
        <code>{candidate.id}</code>
        {candidate.sourceEventId !== null && (
          <span>
            {t('memory.candidate.from', {
              kind: t(sourceKindLabel(candidate.sourceKind)),
              id: candidate.sourceEventId,
            })}
          </span>
        )}
      </div>
      <footer className="memory-candidate-card__actions">
        {onEdit !== undefined && (
          <button
            type="button"
            className="btn btn--sm"
            onClick={onEdit}
            disabled={!isAdmin || disabled}
            data-testid={`memory-candidate-${candidate.id}-edit`}
          >
            {t('memory.action.edit')}
          </button>
        )}
        {candidate.distillAction === 'conflict_with' && refId !== null && (
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => onCompare(refId)}
            data-testid={`memory-candidate-${candidate.id}-compare`}
          >
            {t('memory.action.compare')}
          </button>
        )}
        <button
          type="button"
          className="btn btn--sm"
          onClick={onReject}
          disabled={!isAdmin || disabled}
          data-testid={`memory-candidate-${candidate.id}-reject`}
        >
          {t('memory.action.reject')}
        </button>
        <button
          type="button"
          className="btn btn--sm btn--primary"
          onClick={onApprove}
          disabled={!isAdmin || disabled}
          data-testid={`memory-candidate-${candidate.id}-approve`}
        >
          {t('memory.action.approve')}
        </button>
      </footer>
    </li>
  )
}

/**
 * Approval card body: shows up to {@link COLLAPSE_LINE_THRESHOLD} lines by
 * default, with a [Show full body] / [Collapse] toggle when the body is longer.
 * Short bodies render fully and the toggle is omitted.
 *
 * The threshold is line-count based (newline-separated) rather than character
 * count: a single long paragraph wraps onto multiple visual lines via the CSS
 * `white-space: pre-wrap` rule on `.memory-candidate-card__body`, so once the
 * source has ≤ 8 newlines we trust the CSS to clamp visual height with
 * `max-height` (no toggle). Above the threshold we hide the rest behind the
 * toggle so the queue stays scannable when many candidates are queued.
 */
const COLLAPSE_LINE_THRESHOLD = 8

function countLines(s: string): number {
  let n = 1
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) n++
  }
  return n
}

function CollapsibleBody({ bodyMd, candidateId }: { bodyMd: string; candidateId: string }) {
  const { t } = useTranslation()
  const lineCount = countLines(bodyMd)
  const needsToggle = lineCount > COLLAPSE_LINE_THRESHOLD
  const [expanded, setExpanded] = useState(false)
  if (!needsToggle) {
    return (
      <pre
        className="memory-candidate-card__body"
        data-testid={`memory-candidate-${candidateId}-body`}
      >
        {bodyMd}
      </pre>
    )
  }
  return (
    <div className="memory-candidate-card__body-wrap">
      <pre
        className={`memory-candidate-card__body${expanded ? '' : ' memory-candidate-card__body--clamped'}`}
        data-testid={`memory-candidate-${candidateId}-body`}
        data-expanded={expanded ? 'true' : 'false'}
      >
        {bodyMd}
      </pre>
      <button
        type="button"
        className="btn btn--xs memory-candidate-card__body-toggle"
        onClick={() => setExpanded((v) => !v)}
        data-testid={`memory-candidate-${candidateId}-body-toggle`}
      >
        {expanded ? t('memory.action.collapseBody') : t('memory.action.expandBody')}
      </button>
    </div>
  )
}
