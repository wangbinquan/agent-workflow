// RFC-041 PR4 — side-by-side compare dialog for a candidate whose
// distillAction = 'conflict_with'.
//
// The candidate row shows a [Compare] button; clicking it loads the
// referenced memory's full detail (title + bodyMd + tags) and renders a
// two-column diff alongside the candidate. The user then chooses
// Reject / Approve-and-supersede via the buttons supplied by the parent.

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { Memory } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { LoadingState } from '@/components/LoadingState'

interface MemoryDetailResponse {
  memory: Memory
  ancestors: unknown[]
}

export interface MemoryConflictCompareDialogProps {
  open: boolean
  onClose: () => void
  candidate: Memory
  /** ULID of the existing memory that the candidate conflicts with. */
  existingId: string
  /** Click handler for the supersede CTA — disables when no admin perm. */
  onApproveSupersede?: () => void
  onReject?: () => void
  approving?: boolean
  rejecting?: boolean
}

export function MemoryConflictCompareDialog(props: MemoryConflictCompareDialogProps) {
  const { t } = useTranslation()
  const existing = useQuery<MemoryDetailResponse>({
    queryKey: ['memories', 'detail', props.existingId],
    queryFn: ({ signal }) =>
      api.get(`/api/memories/${encodeURIComponent(props.existingId)}`, undefined, signal),
    enabled: props.open,
    staleTime: 30_000,
  })

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t('memory.conflictDialog.title')}
      size="lg"
      data-testid="memory-conflict-compare-dialog"
      panelClassName="memory-compare-dialog"
    >
      <div className="memory-compare">
        <section className="memory-compare__col" data-testid="memory-compare-existing">
          <h3 className="memory-compare__col-title">{t('memory.conflictDialog.existing')}</h3>
          {existing.isLoading ? (
            <LoadingState size="compact" />
          ) : existing.error !== null && existing.error !== undefined ? (
            <div className="error-box">{String(existing.error)}</div>
          ) : existing.data !== undefined ? (
            <MemoryPreview memory={existing.data.memory} />
          ) : null}
        </section>
        <section className="memory-compare__col" data-testid="memory-compare-candidate">
          <h3 className="memory-compare__col-title">{t('memory.conflictDialog.candidate')}</h3>
          <MemoryPreview memory={props.candidate} />
        </section>
      </div>
      <footer className="memory-compare__footer">
        {props.onReject !== undefined && (
          <button
            type="button"
            className="btn btn--sm"
            onClick={props.onReject}
            disabled={props.rejecting === true}
            data-testid="memory-compare-reject"
          >
            {t('memory.action.reject')}
          </button>
        )}
        {props.onApproveSupersede !== undefined && (
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={props.onApproveSupersede}
            disabled={props.approving === true || existing.data === undefined}
            data-testid="memory-compare-approve-supersede"
          >
            {t('memory.action.approveSupersede')}
          </button>
        )}
      </footer>
    </Dialog>
  )
}

function MemoryPreview({ memory }: { memory: Memory }) {
  const { t } = useTranslation()
  return (
    <div className="memory-compare__preview">
      <h4 className="memory-compare__title">{memory.title}</h4>
      <pre className="memory-compare__body">{memory.bodyMd}</pre>
      <div className="memory-compare__tags-label muted">{t('memory.conflictDialog.tagsLabel')}</div>
      <div className="memory-compare__tags">
        {memory.tags.length === 0 ? (
          <span className="muted">{t('common.emDash')}</span>
        ) : (
          memory.tags.map((tag) => (
            <span key={tag} className="memory-row__tag">
              {tag}
            </span>
          ))
        )}
      </div>
    </div>
  )
}
