// RFC-225 — persistent workgroup autosave + transport status.

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { NoticeBanner } from '@/components/NoticeBanner'
import { StatusChip, type StatusChipKind } from '@/components/StatusChip'
import type { WorkgroupAutosaveState, WorkgroupDraftPhase } from '@/hooks/useWorkgroupAutosave'

type ConfirmAction = () => void | Promise<void>

export interface WorkgroupDraftStatusProps {
  state: WorkgroupAutosaveState
  onRetryNow: () => void
  onSaveCopy: () => void
  onLoadRemote: ConfirmAction
  onOverwriteRemote: ConfirmAction
  onReturnToList: () => void
}

const PHASE_KIND: Record<WorkgroupDraftPhase, StatusChipKind> = {
  clean: 'success',
  dirty: 'warn',
  blocked: 'warn',
  saving: 'info',
  reconciling: 'info',
  error: 'danger',
  conflict: 'danger',
  inaccessible: 'danger',
  deleted: 'danger',
}

function Actions({ children }: { children: ReactNode }): ReactElement {
  return <div className="page__actions">{children}</div>
}

export function WorkgroupDraftStatus(props: WorkgroupDraftStatusProps): ReactElement {
  const { t } = useTranslation()
  const [confirmation, setConfirmation] = useState<'load' | 'overwrite' | null>(null)
  const loadTriggerRef = useRef<HTMLButtonElement | null>(null)
  const overwriteTriggerRef = useRef<HTMLButtonElement | null>(null)
  const { phase, transport, blockReason } = props.state
  const remoteVersion = props.state.conflict?.current?.version ?? props.state.serverRevision.version
  const localRevision = props.state.revision
  const phaseLabel =
    phase === 'blocked'
      ? t('workgroups.autosave.phaseBlocked')
      : t(`editor.draftStatus.phase.${phase}`)

  useEffect(() => {
    if (phase !== 'conflict') setConfirmation(null)
  }, [phase])

  return (
    <section
      className="workflow-draft-status"
      aria-label={t('workgroups.autosave.groupLabel')}
      data-testid="workgroup-draft-status"
    >
      <div
        className="page__actions workflow-draft-status__summary"
        aria-live="polite"
        aria-atomic="true"
      >
        <StatusChip
          kind={PHASE_KIND[phase]}
          size="sm"
          aria-label={t('editor.draftStatus.phaseAria', { status: phaseLabel })}
          data-testid="workgroup-draft-phase"
        >
          {phaseLabel}
        </StatusChip>
        <StatusChip
          kind={transport === 'online' ? 'success' : transport === 'degraded' ? 'warn' : 'danger'}
          size="sm"
          aria-label={t('editor.draftStatus.transportAria', {
            status: t(`editor.draftStatus.transport.${transport}`),
          })}
          data-testid="workgroup-draft-transport"
        >
          {t(`editor.draftStatus.transport.${transport}`)}
        </StatusChip>
      </div>

      {phase === 'blocked' && (
        <NoticeBanner
          tone="warning"
          size="compact"
          title={t(
            blockReason === 'transient-member'
              ? 'workgroups.autosave.transientTitle'
              : 'workgroups.autosave.invalidTitle',
          )}
        >
          {t(
            blockReason === 'transient-member'
              ? 'workgroups.autosave.transientBody'
              : 'workgroups.autosave.invalidBody',
          )}
        </NoticeBanner>
      )}

      {transport === 'offline' && (
        <NoticeBanner
          tone="warning"
          size="compact"
          title={t('editor.draftStatus.offlineTitle')}
          action={
            <button type="button" className="btn btn--sm" onClick={props.onRetryNow}>
              {t('editor.draftStatus.retryNow')}
            </button>
          }
        >
          {t('editor.draftStatus.offlineBody')}
        </NoticeBanner>
      )}

      {phase === 'reconciling' && (
        <NoticeBanner
          tone="info"
          size="compact"
          title={t('editor.draftStatus.reconcilingTitle')}
          action={
            <button type="button" className="btn btn--sm" onClick={props.onRetryNow}>
              {t('editor.draftStatus.retryNow')}
            </button>
          }
        >
          {t('editor.draftStatus.reconcilingBody')}
        </NoticeBanner>
      )}

      {phase === 'error' && (
        <NoticeBanner
          tone="error"
          size="compact"
          title={t('workgroups.autosave.errorTitle')}
          action={
            <button type="button" className="btn btn--sm" onClick={props.onRetryNow}>
              {t('editor.draftStatus.retryNow')}
            </button>
          }
        >
          {t('workgroups.autosave.errorBody')}
        </NoticeBanner>
      )}

      {phase === 'conflict' && (
        <NoticeBanner
          tone="warning"
          title={t('editor.draftStatus.conflictTitle')}
          action={
            <Actions>
              <button type="button" className="btn btn--sm btn--primary" onClick={props.onSaveCopy}>
                {t('editor.draftStatus.saveCopyRecommended')}
              </button>
              <button
                ref={loadTriggerRef}
                type="button"
                className="btn btn--sm"
                onClick={() => setConfirmation('load')}
              >
                {t('editor.draftStatus.loadRemote')}
              </button>
              <button
                ref={overwriteTriggerRef}
                type="button"
                className="btn btn--sm btn--danger"
                onClick={() => setConfirmation('overwrite')}
              >
                {t('editor.draftStatus.overwriteRemote')}
              </button>
            </Actions>
          }
        >
          {t('editor.draftStatus.conflictBody', { localRevision, remoteVersion })}
        </NoticeBanner>
      )}

      {(phase === 'inaccessible' || phase === 'deleted') && (
        <NoticeBanner
          tone="error"
          title={t(
            phase === 'deleted'
              ? 'workgroups.autosave.deletedTitle'
              : 'workgroups.autosave.inaccessibleTitle',
          )}
          action={
            <Actions>
              <button type="button" className="btn btn--sm btn--primary" onClick={props.onSaveCopy}>
                {t('editor.draftStatus.saveCopy')}
              </button>
              <button type="button" className="btn btn--sm" onClick={props.onReturnToList}>
                {t('workgroups.autosave.returnToList')}
              </button>
            </Actions>
          }
        >
          {t(
            phase === 'deleted'
              ? 'workgroups.autosave.deletedBody'
              : 'workgroups.autosave.inaccessibleBody',
          )}
        </NoticeBanner>
      )}

      <ConfirmDialog
        open={phase === 'conflict' && confirmation === 'load'}
        title={t('editor.draftStatus.loadDialogTitle')}
        description={t('editor.draftStatus.loadDialogBody', { localRevision, remoteVersion })}
        confirmLabel={t('editor.draftStatus.loadDialogConfirm')}
        onConfirm={props.onLoadRemote}
        onClose={() => setConfirmation(null)}
        triggerRef={loadTriggerRef}
      />
      <ConfirmDialog
        open={phase === 'conflict' && confirmation === 'overwrite'}
        title={t('editor.draftStatus.overwriteDialogTitle')}
        description={t('editor.draftStatus.overwriteDialogBody', {
          localRevision,
          baseVersion: props.state.serverRevision.version,
          remoteVersion,
        })}
        confirmLabel={t('editor.draftStatus.overwriteDialogConfirm')}
        tone="danger"
        onConfirm={props.onOverwriteRemote}
        onClose={() => setConfirmation(null)}
        triggerRef={overwriteTriggerRef}
      />
    </section>
  )
}
