// RFC-041 PR4 — generic memory row shared by All / By-Scope / Scoped lists.
//
// Pure presentational: the parent passes a MemorySummary and (optionally)
// owns the action buttons. Approval-queue rendering lives in
// <MemoryApprovalQueue /> because it depends on candidate-only fields
// (distillAction, sourceRefs).

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { MemorySummary } from '@agent-workflow/shared'

export interface MemoryRowProps {
  memory: MemorySummary
  /** Optional trailing actions (Approve / Archive / Delete buttons). */
  actions?: ReactNode
  /** RFC-045: when provided AND the row's status is candidate / approved /
   *  archived, an Edit button is rendered BEFORE the `actions` slot. */
  onEdit?: () => void
  /** RFC-045: optional override for editability (parents that already gate
   *  on isAdmin pass false to hide the button). Defaults to true. */
  editable?: boolean
  'data-testid'?: string
}

const EDITABLE_STATUSES = new Set(['candidate', 'approved', 'archived'])

export function MemoryRow({
  memory,
  actions,
  onEdit,
  editable = true,
  'data-testid': testId,
}: MemoryRowProps) {
  const { t } = useTranslation()
  const showEdit = onEdit !== undefined && editable && EDITABLE_STATUSES.has(memory.status)
  return (
    <li
      className={`memory-row memory-row--${memory.status}`}
      data-testid={testId ?? `memory-row-${memory.id}`}
    >
      <div className="memory-row__head">
        <span className={`memory-row__scope memory-row__scope--${memory.scopeType}`}>
          {t(`memory.scope.${memory.scopeType}`)}
        </span>
        <span className="memory-row__title">{memory.title}</span>
        <span className={`memory-row__status memory-row__status--${memory.status}`}>
          {t(`memory.status.${memory.status}`)}
        </span>
        {memory.status === 'candidate' &&
          (memory.outputLang === 'zh-CN' || memory.outputLang === 'en-US') && (
            <span
              className={`memory-row__lang memory-row__lang--${memory.outputLang}`}
              data-testid={`memory-row-${memory.id}-lang`}
              title={t(`memory.candidateRow.langTooltip.${memory.outputLang}`)}
            >
              {t(`memory.candidateRow.lang.${memory.outputLang}`)}
            </span>
          )}
      </div>
      {memory.tags.length > 0 && (
        <div className="memory-row__tags">
          {memory.tags.map((tag) => (
            <span key={tag} className="memory-row__tag">
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="memory-row__meta muted">
        <code className="memory-row__id">{memory.id}</code>
        {memory.approvedAt !== null && (
          <span className="memory-row__approved-at">
            {new Date(memory.approvedAt).toLocaleString()}
          </span>
        )}
        {memory.version > 1 && <span className="memory-row__version">v{memory.version}</span>}
      </div>
      {(showEdit || actions !== undefined) && (
        <div className="memory-row__actions">
          {showEdit && (
            <button
              type="button"
              className="btn btn--xs"
              onClick={onEdit}
              data-testid={`memory-row-${memory.id}-edit`}
            >
              {t('memory.action.edit')}
            </button>
          )}
          {actions}
        </div>
      )}
    </li>
  )
}
