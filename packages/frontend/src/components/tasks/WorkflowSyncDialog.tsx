// RFC-109 — confirm dialog for "sync latest workflow & continue". Shows the
// version delta + the node diff (added / removed / changed) + data-loss
// warnings, and BLOCKS confirmation when the live definition is invalid or a
// wrapper changed structure under live state (Codex F3/F8). Confirm POSTs
// sync-workflow with the previewed `latestVersion` as `expectedVersion` (F5).
//
// Reuses the shared <Dialog> chrome (overlay/focus-trap/footer) and the
// .task-error-banner style family — no bespoke modal chrome.

import { type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  WorkflowSyncPreview,
  WorkflowSyncWarning,
  WorkflowSyncBlocker,
} from '@agent-workflow/shared'

import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'

export interface WorkflowSyncDialogProps {
  open: boolean
  onClose: () => void
  preview: WorkflowSyncPreview
  onConfirm: () => void
  pending: boolean
  error?: unknown
}

export function WorkflowSyncDialog(props: WorkflowSyncDialogProps): ReactElement {
  const { t } = useTranslation()
  const { preview } = props
  const { diff } = preview
  const blocked = preview.invalid || diff.blockers.length > 0
  const versionText = `v${preview.currentVersion ?? t('tasks.syncWorkflow.unknownVersion')} → v${preview.latestVersion ?? '?'}`

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t('tasks.syncWorkflow.dialogTitle')}
      size="lg"
      footer={
        <>
          <button type="button" className="btn btn--sm" onClick={props.onClose}>
            {t('tasks.syncWorkflow.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={props.onConfirm}
            disabled={blocked || props.pending}
            data-testid="workflow-sync-confirm"
          >
            {props.pending ? t('tasks.syncWorkflow.syncing') : t('tasks.syncWorkflow.confirm')}
          </button>
        </>
      }
    >
      <div className="workflow-sync" data-testid="workflow-sync-dialog">
        <p className="workflow-sync__version">
          <strong>{t('tasks.syncWorkflow.versionLabel')}:</strong> {versionText}
        </p>

        {props.error !== undefined && props.error !== null && <ErrorBanner error={props.error} />}

        {preview.invalid && (
          <div className="task-error-banner task-error-banner--warning" role="alert">
            <div className="task-error-banner__body">
              <strong>{t('tasks.syncWorkflow.invalidTitle')}</strong>
              <ul className="workflow-sync__issues">
                {preview.invalidIssues.map((i) => (
                  <li key={i.code}>
                    <code>{i.code}</code> — {i.message}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        {diff.blockers.length > 0 && (
          <div className="task-error-banner task-error-banner--warning" role="alert">
            <div className="task-error-banner__body">
              <strong>{t('tasks.syncWorkflow.blockerTitle')}</strong>
              <ul className="workflow-sync__issues">
                {diff.blockers.map((b: WorkflowSyncBlocker) => (
                  <li key={b.nodeId}>{t(`tasks.syncWorkflow.blocker.${b.code}`)}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <NodeList title={t('tasks.syncWorkflow.sectionAdded')} items={diff.added} testid="added" />
        <NodeList
          title={t('tasks.syncWorkflow.sectionRemoved')}
          items={diff.removed}
          testid="removed"
        />
        <NodeList
          title={t('tasks.syncWorkflow.sectionModified')}
          items={diff.modified}
          testid="modified"
        />

        {diff.warnings.length > 0 && (
          <section className="workflow-sync__section">
            <h4>{t('tasks.syncWorkflow.sectionWarnings')}</h4>
            <ul className="workflow-sync__warnings" data-testid="workflow-sync-warnings">
              {diff.warnings.map((w: WorkflowSyncWarning, i) => (
                <li key={`${w.code}-${w.nodeId}-${i}`}>
                  <strong>{t(`tasks.syncWorkflow.warn.${w.code}`)}</strong> — {w.detail}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Dialog>
  )
}

function NodeList(props: {
  title: string
  items: ReadonlyArray<{ nodeId: string; label: string; kind: string }>
  testid: string
}): ReactElement | null {
  if (props.items.length === 0) return null
  return (
    <section className="workflow-sync__section">
      <h4>
        {props.title} <span className="workflow-sync__count">({props.items.length})</span>
      </h4>
      <ul className="workflow-sync__nodes" data-testid={`workflow-sync-${props.testid}`}>
        {props.items.map((n) => (
          <li key={n.nodeId}>
            {n.label} <span className="workflow-sync__kind">{n.kind}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
