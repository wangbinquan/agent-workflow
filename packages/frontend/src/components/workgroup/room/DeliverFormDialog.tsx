// PR-5 结构化交付表单（拍板 #16 第二形态）。
// (RFC-217 T10: extracted from WorkgroupRoom.tsx.)

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '@/components/Dialog'
import { Field, TextArea, TextInput } from '@/components/Form'
import type { WorkgroupDeliverInput, WorkgroupRoomAssignment } from '@/lib/workgroup-room'

export interface DeliverFormDialogProps {
  assignment: WorkgroupRoomAssignment
  delivering: boolean
  onClose: () => void
  onDeliver: (assignmentId: string, input: WorkgroupDeliverInput) => Promise<unknown>
}

export function DeliverFormDialog({
  assignment,
  delivering,
  onClose,
  onDeliver,
}: DeliverFormDialogProps) {
  const { t } = useTranslation()
  const [summary, setSummary] = useState('')
  const [detail, setDetail] = useState('')
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('workgroups.room.deliverFormTitle')}
      size="md"
      data-testid={`wg-deliver-form-dialog-${assignment.id}`}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={delivering || summary.trim().length === 0}
            onClick={() =>
              void onDeliver(assignment.id, { kind: 'form', summary, detail }).then(onClose)
            }
            data-testid={`wg-deliver-form-submit-${assignment.id}`}
          >
            {t('workgroups.room.deliverSubmit')}
          </button>
        </>
      }
    >
      <Field label={t('workgroups.room.deliverSummaryLabel')} required>
        <TextInput
          value={summary}
          onChange={setSummary}
          maxLength={16384}
          data-testid={`wg-deliver-summary-${assignment.id}`}
        />
      </Field>
      <Field label={t('workgroups.room.deliverDetailLabel')}>
        <TextArea
          value={detail}
          onChange={setDetail}
          rows={6}
          maxLength={65536}
          data-testid={`wg-deliver-detail-${assignment.id}`}
        />
      </Field>
    </Dialog>
  )
}
