// RFC-164 PR-1 → RFC-168 — add-member DIALOG shells.
//
// Since RFC-168 the detail page manages members through the gallery + context
// panel (WorkgroupMemberGallery / WorkgroupContextPanel) and no longer opens
// these dialogs; this file keeps its historical path because the mid-run
// config dialog (WorkgroupTaskConfigDialog, RFC-164 PR-5) imports the two
// shells from here and must stay byte-stable in behavior. The field bodies
// live in MemberFields.tsx and are shared with the panel — the behavior
// contract both shells rely on is design/RFC-168 §8.1: fresh-mount draft,
// `others` uniqueness, alias auto-follow until hand-edited, validated row on
// submit, applying/applyError wiring, nested dialogs close only themselves.
//
// Contract: `onSubmit` receives a validated WorkgroupMemberRowState; `others`
// feeds the displayName-uniqueness check.

import { useTranslation } from 'react-i18next'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import type { WorkgroupMemberRowState } from '@/lib/workgroup-form'
import {
  AgentMemberFields,
  HumanMemberFields,
  useAgentMemberDraft,
  useHumanMemberDraft,
  type MemberDraftOthers,
} from './MemberFields'

export interface MemberDialogCommonProps {
  others: MemberDraftOthers
  applying: boolean
  applyError: unknown
  onClose: () => void
}

export function AgentMemberDialog(
  props: MemberDialogCommonProps & { onSubmit: (row: WorkgroupMemberRowState) => Promise<void> },
) {
  const { t } = useTranslation()
  const draft = useAgentMemberDraft(props.others)

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t('workgroups.addAgentTitle')}
      size="sm"
      data-testid="workgroup-add-agent-dialog"
      footer={
        <>
          {props.applyError != null && (
            <ErrorBanner error={props.applyError} testid="workgroup-member-dialog-error" />
          )}
          <button type="button" className="btn" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={draft.invalid || props.applying}
            onClick={() => void props.onSubmit(draft.buildRow())}
            data-testid="workgroup-add-agent-confirm"
          >
            {t('workgroups.addMemberConfirm')}
          </button>
        </>
      }
    >
      <AgentMemberFields draft={draft} />
    </Dialog>
  )
}

export function HumanMemberDialog(
  props: MemberDialogCommonProps & { onSubmit: (row: WorkgroupMemberRowState) => Promise<void> },
) {
  const { t } = useTranslation()
  const draft = useHumanMemberDraft(props.others)

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t('workgroups.addHumanTitle')}
      size="sm"
      data-testid="workgroup-add-human-dialog"
      footer={
        <>
          {props.applyError != null && (
            <ErrorBanner error={props.applyError} testid="workgroup-member-dialog-error" />
          )}
          <button type="button" className="btn" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={draft.invalid || props.applying}
            onClick={() => {
              const row = draft.buildRow()
              if (row !== null) void props.onSubmit(row)
            }}
            data-testid="workgroup-add-human-confirm"
          >
            {t('workgroups.addMemberConfirm')}
          </button>
        </>
      }
    >
      <HumanMemberFields draft={draft} />
    </Dialog>
  )
}
