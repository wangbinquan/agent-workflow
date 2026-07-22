// Dispatch card — one workgroup assignment rendered under its trigger message:
// status/source chips, assignee, folded result, run timer, cancel, and (for a
// HUMAN assignee, PR-5 拍板 #16) the to-do delivery affordances (quick reply +
// structured form). (RFC-217 T10: extracted from WorkgroupRoom.tsx.)

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkgroupRunEntry, WorkgroupRuntimeMember } from '@agent-workflow/shared'
import { ConfirmButton } from '@/components/ConfirmButton'
import { StatusChip } from '@/components/StatusChip'
import { TextArea } from '@/components/Form'
import { DeliverFormDialog } from '@/components/workgroup/room/DeliverFormDialog'
import {
  assignmentDurationMs,
  assignmentStatusToKind,
  formatTurnDuration,
  isAssignmentCancelable,
  isHumanDeliveryCard,
  resolveComposerKey,
  resultBodyFor,
  sendChordModLabel,
  type WorkgroupDeliverInput,
  type WorkgroupRoomAssignment,
  type WorkgroupRoomResponse,
} from '@/lib/workgroup-room'

export interface DispatchCardProps {
  assignment: WorkgroupRoomAssignment
  data: WorkgroupRoomResponse
  members: Map<string, WorkgroupRuntimeMember>
  /** Memoized nodeRunId→entry index over runHistory (the card's agent-run
   *  timer; human to-do cards have no run, hence no timer). */
  runIndex: ReadonlyMap<string, WorkgroupRunEntry>
  now: number
  canceling: boolean
  onCancel: (assignmentId: string) => Promise<unknown>
  onViewRun: (nodeRunId: string) => void
  delivering: boolean
  onDeliver: (assignmentId: string, input: WorkgroupDeliverInput) => Promise<unknown>
}

export function DispatchCard({
  assignment,
  data,
  members,
  runIndex,
  now,
  canceling,
  onCancel,
  onViewRun,
  delivering,
  onDeliver,
}: DispatchCardProps) {
  const { t } = useTranslation()
  const assignee =
    assignment.assigneeMemberId === null ? undefined : members.get(assignment.assigneeMemberId)
  const dur = assignmentDurationMs(runIndex, assignment.nodeRunId, now)
  const resultBody = resultBodyFor(assignment, data.messages)
  // PR-5 (拍板 #16): a dispatched card assigned to a HUMAN member renders in
  // the to-do form — highlighted + the two delivery entries.
  const isTodo = isHumanDeliveryCard(assignment, members)
  const [quickOpen, setQuickOpen] = useState(false)
  const [quickText, setQuickText] = useState('')
  const [formOpen, setFormOpen] = useState(false)
  // Quick-reply submit, shared by the button and the Cmd/Ctrl+Enter chord.
  // (No focus hand-off after delivery: a successful deliver flips the card to
  // 'delivered', which unmounts the whole to-do affordance — there is no stable
  // element to focus, so we let focus fall naturally.)
  function submitQuick(): void {
    if (delivering || quickText.trim().length === 0) return
    void onDeliver(assignment.id, { kind: 'quick', body: quickText }).then(() => {
      setQuickOpen(false)
      setQuickText('')
    })
  }

  return (
    <div
      className={`workgroup-room__card${isTodo ? ' workgroup-room__card--todo' : ''}`}
      data-testid={`wg-card-${assignment.id}`}
    >
      <div className="workgroup-room__card-head">
        <strong className="workgroup-room__card-title">{assignment.title}</strong>
        <StatusChip
          kind={assignmentStatusToKind(assignment.status)}
          size="sm"
          data-testid={`wg-card-status-${assignment.id}`}
        >
          {t(`workgroups.room.assignmentStatus.${assignment.status}`)}
        </StatusChip>
        <span className="chip chip--tight">{t(`workgroups.room.source.${assignment.source}`)}</span>
        {isTodo && (
          <StatusChip kind="warn" size="sm" data-testid={`wg-card-todo-${assignment.id}`}>
            {t('workgroups.room.deliverTodo')}
          </StatusChip>
        )}
        {assignment.nodeRunId !== null && (
          <span className="workgroup-room__time" data-testid={`wg-card-duration-${assignment.id}`}>
            {dur === null ? '—' : formatTurnDuration(dur)}
          </span>
        )}
      </div>
      <div className="workgroup-room__card-assignee">
        {t('workgroups.room.assignedTo')}{' '}
        <span className="workgroup-room__member-name">
          {assignee !== undefined ? `@${assignee.displayName}` : t('common.emDash')}
        </span>
      </div>
      {resultBody !== null && (
        <details
          className="workgroup-room__card-result"
          data-testid={`wg-card-result-${assignment.id}`}
        >
          <summary>{t('workgroups.room.resultSummary')}</summary>
          <div className="workgroup-room__body">{resultBody}</div>
        </details>
      )}
      {(assignment.nodeRunId !== null || isAssignmentCancelable(assignment.status) || isTodo) && (
        <div className="workgroup-room__card-actions">
          {isTodo && (
            <>
              <button
                type="button"
                className="btn btn--xs btn--primary"
                onClick={() => setQuickOpen((v) => !v)}
                disabled={delivering}
                data-testid={`wg-card-deliver-quick-${assignment.id}`}
              >
                {t('workgroups.room.deliverQuick')}
              </button>
              <button
                type="button"
                className="btn btn--xs"
                onClick={() => setFormOpen(true)}
                disabled={delivering}
                data-testid={`wg-card-deliver-form-${assignment.id}`}
              >
                {t('workgroups.room.deliverForm')}
              </button>
            </>
          )}
          {assignment.nodeRunId !== null && (
            <button
              type="button"
              className="btn btn--xs"
              onClick={() => onViewRun(assignment.nodeRunId!)}
              data-testid={`wg-card-run-${assignment.id}`}
            >
              {t('workgroups.room.viewRun')}
            </button>
          )}
          {isAssignmentCancelable(assignment.status) && (
            <ConfirmButton
              label={t('workgroups.room.cancelCard')}
              onConfirm={() => onCancel(assignment.id)}
              variant="danger"
              size="sm"
              disabled={canceling}
            />
          )}
        </div>
      )}
      {/* Quick reply — inline textarea, POSTs the chat-body shape. */}
      {isTodo && quickOpen && (
        <div className="workgroup-room__card-quick">
          <TextArea
            rows={3}
            value={quickText}
            onChange={setQuickText}
            onKeyDown={(e) => {
              const action = resolveComposerKey({
                key: e.key,
                metaKey: e.metaKey,
                ctrlKey: e.ctrlKey,
                altKey: e.altKey,
                shiftKey: e.shiftKey,
                isComposing: e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229,
                mentionOpen: false, // no @-completion in the delivery box
                candidateCount: 0,
                activeIndex: 0,
              })
              if (action.type === 'send') {
                e.preventDefault() // unconditional (never leak a newline)
                submitQuick()
              }
            }}
            placeholder={t('workgroups.room.deliverQuickPlaceholder')}
            disabled={delivering}
            data-testid={`wg-card-quick-input-${assignment.id}`}
          />
          <div className="form-field__hint workgroup-room__composer-hint">
            {t('workgroups.room.deliverShortcutHint', { mod: sendChordModLabel() })}
          </div>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={delivering || quickText.trim().length === 0}
            onClick={submitQuick}
            data-testid={`wg-card-quick-submit-${assignment.id}`}
          >
            {t('workgroups.room.deliverSubmit')}
          </button>
        </div>
      )}
      {/* Form delivery — structured {summary, detail?} via the shared Dialog. */}
      {isTodo && formOpen && (
        <DeliverFormDialog
          assignment={assignment}
          delivering={delivering}
          onClose={() => setFormOpen(false)}
          onDeliver={onDeliver}
        />
      )}
    </div>
  )
}
