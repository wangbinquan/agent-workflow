// RFC-199 B2/T4 — workflow draft save/transport projection.
//
// This component is intentionally presentation-only: it never performs API
// work and never dispatches reducer events. The controller owns those effects
// through the callbacks below.

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { NoticeBanner } from '@/components/NoticeBanner'
import { StatusChip, type StatusChipKind } from '@/components/StatusChip'
import type {
  WorkflowDraftPhase,
  WorkflowDraftTransport,
  WorkflowEditorDraftState,
} from '@/lib/workflow-editor-draft'

type ConfirmAction = () => void | Promise<void>

export interface WorkflowDraftStatusProps {
  state: WorkflowEditorDraftState
  onRetryNow: () => void
  onSaveCopy: () => void
  onLoadRemote: ConfirmAction
  onOverwriteRemote: ConfirmAction
  onExportLocal: () => void
  onRetryAccess: () => void
  onReturnToList: () => void
  /** Conflict always offers copy; terminal notices expose it only when authorized. */
  canSaveCopy?: boolean
}

const PHASE_KIND: Record<WorkflowDraftPhase, StatusChipKind> = {
  clean: 'success',
  dirty: 'warn',
  saving: 'info',
  reconciling: 'info',
  error: 'danger',
  conflict: 'danger',
  inaccessible: 'danger',
  deleted: 'danger',
}

const TRANSPORT_KIND: Record<WorkflowDraftTransport, StatusChipKind> = {
  online: 'success',
  degraded: 'warn',
  offline: 'danger',
}

function Actions({ children }: { children: ReactNode }): ReactElement {
  return <div className="page__actions">{children}</div>
}

export function workflowDraftHasNotice(
  state: Pick<WorkflowEditorDraftState, 'phase' | 'transport'>,
): boolean {
  return (
    state.transport === 'offline' ||
    state.phase === 'reconciling' ||
    state.phase === 'error' ||
    state.phase === 'conflict' ||
    state.phase === 'inaccessible' ||
    state.phase === 'deleted'
  )
}

export function WorkflowDraftStatusSummary(props: {
  state: Pick<WorkflowEditorDraftState, 'phase' | 'transport'>
}): ReactElement {
  const { t } = useTranslation()
  const phaseLabel = t(`editor.draftStatus.phase.${props.state.phase}`)
  const transportLabel = t(`editor.draftStatus.transport.${props.state.transport}`)

  return (
    <div
      className="editor-draft-status-summary"
      role="group"
      aria-label={t('editor.draftStatus.groupLabel')}
      aria-live="polite"
      aria-atomic="true"
      data-testid="workflow-draft-status-summary"
    >
      <StatusChip
        kind={PHASE_KIND[props.state.phase]}
        size="sm"
        aria-label={t('editor.draftStatus.phaseAria', { status: phaseLabel })}
        data-testid="workflow-draft-phase"
      >
        {phaseLabel}
      </StatusChip>
      <StatusChip
        kind={TRANSPORT_KIND[props.state.transport]}
        size="sm"
        aria-label={t('editor.draftStatus.transportAria', { status: transportLabel })}
        data-testid="workflow-draft-transport"
      >
        {transportLabel}
      </StatusChip>
    </div>
  )
}

export function WorkflowDraftStatus(props: WorkflowDraftStatusProps): ReactElement {
  const { t } = useTranslation()
  const [confirmation, setConfirmation] = useState<'load' | 'overwrite' | null>(null)
  const loadTriggerRef = useRef<HTMLButtonElement | null>(null)
  const overwriteTriggerRef = useRef<HTMLButtonElement | null>(null)
  const phase = props.state.phase
  const transport = props.state.transport
  const remoteVersion = props.state.conflict?.current?.version ?? props.state.serverRevision.version
  const localRevision = props.state.revision

  useEffect(() => {
    if (phase !== 'conflict') setConfirmation(null)
  }, [phase])

  return (
    <section
      className="workflow-draft-status"
      aria-label={t('editor.draftStatus.groupLabel')}
      data-testid="workflow-draft-status"
    >
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
          title={t('editor.draftStatus.errorTitle')}
          action={
            <button type="button" className="btn btn--sm" onClick={props.onRetryNow}>
              {t('editor.draftStatus.retryNow')}
            </button>
          }
        >
          {t('editor.draftStatus.errorBody')}
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
          {t('editor.draftStatus.conflictBody', {
            localRevision,
            remoteVersion,
          })}
        </NoticeBanner>
      )}

      {phase === 'inaccessible' && (
        <NoticeBanner
          tone="error"
          title={t('editor.draftStatus.inaccessibleTitle')}
          action={
            <Actions>
              <button type="button" className="btn btn--sm" onClick={props.onExportLocal}>
                {t('editor.draftStatus.exportLocal')}
              </button>
              <button type="button" className="btn btn--sm" onClick={props.onRetryAccess}>
                {t('editor.draftStatus.retryAccess')}
              </button>
              <button type="button" className="btn btn--sm" onClick={props.onReturnToList}>
                {t('editor.draftStatus.returnToList')}
              </button>
              {props.canSaveCopy === true && (
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  onClick={props.onSaveCopy}
                >
                  {t('editor.draftStatus.saveCopy')}
                </button>
              )}
            </Actions>
          }
        >
          {t('editor.draftStatus.inaccessibleBody')}
        </NoticeBanner>
      )}

      {phase === 'deleted' && (
        <NoticeBanner
          tone="error"
          title={t('editor.draftStatus.deletedTitle')}
          action={
            <Actions>
              <button type="button" className="btn btn--sm" onClick={props.onExportLocal}>
                {t('editor.draftStatus.exportLocal')}
              </button>
              <button type="button" className="btn btn--sm" onClick={props.onReturnToList}>
                {t('editor.draftStatus.returnToList')}
              </button>
              {props.canSaveCopy === true && (
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  onClick={props.onSaveCopy}
                >
                  {t('editor.draftStatus.saveCopy')}
                </button>
              )}
            </Actions>
          }
        >
          {t('editor.draftStatus.deletedBody')}
        </NoticeBanner>
      )}

      <ConfirmDialog
        open={phase === 'conflict' && confirmation === 'load'}
        title={t('editor.draftStatus.loadDialogTitle')}
        description={t('editor.draftStatus.loadDialogBody', {
          localRevision,
          remoteVersion,
        })}
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
