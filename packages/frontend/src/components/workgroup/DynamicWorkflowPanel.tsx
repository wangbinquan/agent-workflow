// RFC-167 PR-3 — the dynamic-workflow orchestration panel: the primary view
// of a dynamic_workflow task until its generated DAG is confirmed.
//
// Phase-driven (room aggregate's `dw` slot):
//   generating / rejected — progress card (attempt counter + the rejection
//     feedback the orchestrator is currently addressing); a failed task
//     surfaces its error summary here (generation exhausted).
//   awaiting_confirm      — read-only DAG preview (WorkflowCanvas readOnly,
//     same frame as the task-status canvas) + the confirm gate: approve
//     (swap-and-execute), reject (comment REQUIRED — regenerates with the
//     feedback), save-as-workflow (persist the one-shot DAG for reuse).
//   executing             — pointer card to the workflow-status canvas;
//     save-as stays available (the generated def is kept as a breadcrumb).
//
// Data: the SAME GET /room aggregate the chat room uses (workgroupRoomKey —
// one cache entry, invalidated by task.status WS frames via useTaskSync).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { describeTaskFailure } from '@/lib/task-failure'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent, TaskStatus } from '@agent-workflow/shared'
import { WorkflowDefinitionSchema } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Card } from '@/components/Card'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { Field, TextArea, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { TaskStatusChip } from '@/components/TaskStatusChip'
import { WorkflowCanvas } from '@/components/canvas/WorkflowCanvas'
import { describeApiError } from '@/i18n'
import { workgroupRoomKey, type WorkgroupRoomResponse } from '@/lib/workgroup-room'

export interface DynamicWorkflowPanelProps {
  taskId: string
  /** Live task status from the page-level query (WS-refreshed). */
  taskStatus: TaskStatus
  /** Task error summary — shown when generation exhausted (task failed). */
  errorSummary: string | null
}

export function DynamicWorkflowPanel({
  taskId,
  taskStatus,
  errorSummary,
}: DynamicWorkflowPanelProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const room = useQuery<WorkgroupRoomResponse>({
    queryKey: workgroupRoomKey(taskId),
    queryFn: ({ signal }) =>
      api.get(`/api/workgroup-tasks/${encodeURIComponent(taskId)}/room`, undefined, signal),
    // WS task.status frames carry the live phase flips; slow-poll fallback
    // while the task is still moving. Codex impl-gate P2: the poll only stops
    // once the ROOM AGGREGATE ITSELF has observed the terminal status — the
    // page's faster task query may see `done` first, and cutting the poll on
    // that alone would freeze a stale awaiting_confirm gate forever when the
    // WS frame was missed.
    refetchInterval: (q) => {
      const terminal = taskStatus === 'done' || taskStatus === 'failed' || taskStatus === 'canceled'
      if (terminal && q.state.data?.taskStatus === taskStatus) return false
      return 15_000
    },
  })

  // Shared with TaskStatusCanvas / the editor — one cache entry.
  const agents = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: ({ signal }) => api.get('/api/agents', undefined, signal),
  })

  const dw = room.data?.dw ?? null
  const generated = useMemo(() => {
    if (dw?.generatedDef === undefined) return null
    const parsed = WorkflowDefinitionSchema.safeParse(dw.generatedDef)
    return parsed.success ? parsed.data : null
  }, [dw?.generatedDef])

  const [rejectOpen, setRejectOpen] = useState(false)
  const [rejectComment, setRejectComment] = useState('')
  const [saveAsOpen, setSaveAsOpen] = useState(false)
  const [saveAsName, setSaveAsName] = useState('')
  const [saveAsDesc, setSaveAsDesc] = useState('')
  const [savedName, setSavedName] = useState<string | null>(null)
  const confirm = useMutation({
    mutationFn: (input: { decision: 'approve' | 'reject'; comment?: string }) =>
      api.post<{ decision: string }>(
        `/api/workgroup-tasks/${encodeURIComponent(taskId)}/dw-confirm`,
        input,
      ),
    onSuccess: (_data, variables) => {
      setRejectOpen(false)
      setRejectComment('')
      // Codex impl-gate P2 (final round): only a REJECTION discards the
      // proposal — its saved-as note must not survive onto the regenerated
      // one. An approval keeps the same proposal, so the acknowledgement
      // stays (clearing it there invited a duplicate save).
      if (variables.decision === 'reject') setSavedName(null)
      void qc.invalidateQueries({ queryKey: workgroupRoomKey(taskId) })
      // approve resumes into execution / reject re-enters generation — both
      // move the task status and (on approve) swap the snapshot the canvas
      // renders from.
      void qc.invalidateQueries({ queryKey: ['tasks', taskId] })
      void qc.invalidateQueries({ queryKey: ['tasks', taskId, 'node-runs'] })
    },
  })

  const saveAs = useMutation({
    mutationFn: (input: { name: string; description?: string }) =>
      api.post<{ id: string; name: string }>(
        `/api/workgroup-tasks/${encodeURIComponent(taskId)}/dw-save-as-workflow`,
        input,
      ),
    onSuccess: (created) => {
      setSaveAsOpen(false)
      setSavedName(created.name)
      void qc.invalidateQueries({ queryKey: ['workflows'] })
    },
  })

  if (room.isLoading) return <LoadingState size="comfortable" />
  if (room.error !== null && room.error !== undefined) {
    return <div className="error-box">{describeApiError(room.error)}</div>
  }
  if (dw === null) {
    return <EmptyState size="comfortable" title={t('workgroups.dw.previewEmpty')} />
  }
  // Codex impl-gate P2: dw.phase freezes at its last substate on cancel
  // (e.g. 'generating') — a canceled task must not spin the generation card
  // forever or offer confirm buttons that would 409. NOT an early return
  // (final round): a generated def may still exist (cancel after approval)
  // and save-as deliberately stays available on terminal tasks — the
  // canceled card below shares the save-as button + dialogs.
  const canceled = taskStatus === 'canceled'

  const saveAsButton =
    generated !== null ? (
      <button
        type="button"
        className="btn btn--sm btn--ghost"
        onClick={() => {
          setSaveAsName('')
          setSaveAsDesc('')
          setSaveAsOpen(true)
        }}
        data-testid="dw-save-as-btn"
      >
        {t('workgroups.dw.saveAs')}
      </button>
    ) : undefined

  return (
    <div className="task-canvas-layout task-canvas-layout--dw" data-testid="dw-orchestration-panel">
      {/* ── canceled: the orchestration flow ended (dw.phase froze at its
          last substate) — but a generated def may still exist (cancel after
          approval) and save-as stays available on terminal tasks. ── */}
      {canceled && (
        <Card
          header={<h3 className="workgroup-room__side-title">{t('workgroups.dw.title')}</h3>}
          data-testid="dw-canceled-notice"
          footer={
            saveAsButton && <div className="workgroup-room__card-actions">{saveAsButton}</div>
          }
        >
          <p className="workgroup-room__gate-state">{t('workgroups.dw.canceledNotice')}</p>
          {savedName !== null && (
            <p className="workgroup-room__gate-state" data-testid="dw-saved-note">
              {t('workgroups.dw.saved', { name: savedName })}
            </p>
          )}
        </Card>
      )}

      {/* ── generating / rejected: progress (or exhaustion) card ────────── */}
      {!canceled && (dw.phase === 'generating' || dw.phase === 'rejected') && (
        <Card
          header={<h3 className="workgroup-room__side-title">{t('workgroups.dw.title')}</h3>}
          data-testid="dw-generating-card"
        >
          {taskStatus === 'failed' ? (
            <div className="error-box" data-testid="dw-generate-failed">
              {/* RFC-203 T4: dw-generate-exhausted (and friends) localize via
                  the shared failure oracle; unknown summaries fall back to the
                  existing exhausted copy instead of raw machine tokens. */}
              {errorSummary !== null && errorSummary !== ''
                ? (() => {
                    const f = describeTaskFailure({ errorSummary })
                    return f.matched === 'generic' ? t('workgroups.dw.exhausted') : f.title
                  })()
                : t('workgroups.dw.exhausted')}
            </div>
          ) : (
            <>
              <LoadingState size="compact" />
              <p className="workgroup-room__gate-state">
                {t('workgroups.dw.generating', { n: dw.generateAttempts + 1 })}
              </p>
            </>
          )}
          {dw.rejectionComment !== undefined && dw.rejectionComment !== '' && (
            <>
              <p className="workgroup-room__gate-state">{t('workgroups.dw.rejectionFeedback')}</p>
              <div className="workgroup-room__body" data-testid="dw-rejection-feedback">
                {dw.rejectionComment}
              </div>
            </>
          )}
        </Card>
      )}

      {/* ── awaiting_confirm: read-only preview + the confirm gate ──────── */}
      {!canceled && dw.phase === 'awaiting_confirm' && (
        <>
          <Card
            header={<h3 className="workgroup-room__side-title">{t('workgroups.dw.gateTitle')}</h3>}
            data-testid="dw-confirm-card"
            footer={
              <div className="workgroup-room__card-actions">
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  disabled={confirm.isPending || generated === null}
                  onClick={() => confirm.mutate({ decision: 'approve' })}
                  data-testid="dw-gate-approve"
                >
                  {confirm.isPending ? t('common.saving') : t('workgroups.dw.approve')}
                </button>
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={confirm.isPending}
                  onClick={() => setRejectOpen(true)}
                  data-testid="dw-gate-reject"
                >
                  {t('workgroups.dw.reject')}
                </button>
                {saveAsButton}
              </div>
            }
          >
            <p className="workgroup-room__gate-state">{t('workgroups.dw.awaiting')}</p>
            {dw.generateAttempts > 0 && (
              <p className="workgroup-room__gate-state">
                {t('workgroups.dw.attemptsUsed', { n: dw.generateAttempts })}
              </p>
            )}
            {savedName !== null && (
              <p className="workgroup-room__gate-state" data-testid="dw-saved-note">
                {t('workgroups.dw.saved', { name: savedName })}
              </p>
            )}
            {confirm.error !== null && confirm.error !== undefined && !rejectOpen && (
              <div className="error-box" data-testid="dw-gate-error">
                {describeApiError(confirm.error)}
              </div>
            )}
          </Card>
          {generated !== null ? (
            <div className="canvas-frame canvas-frame--task" data-testid="dw-preview-canvas">
              <WorkflowCanvas definition={generated} agents={agents.data ?? []} readOnly />
            </div>
          ) : (
            <EmptyState size="compact" title={t('workgroups.dw.previewEmpty')} />
          )}
        </>
      )}

      {/* ── executing (and beyond): pointer to the real canvas. Codex
          impl-gate P2: dw.phase stays 'executing' after the run terminates —
          the card's copy follows the TASK status so a finished / failed DAG
          is never labeled as still running. ── */}
      {!canceled && dw.phase === 'executing' && (
        <Card
          header={<h3 className="workgroup-room__side-title">{t('workgroups.dw.title')}</h3>}
          data-testid="dw-executing-card"
          footer={
            saveAsButton && <div className="workgroup-room__card-actions">{saveAsButton}</div>
          }
        >
          <p className="workgroup-room__gate-state">
            <TaskStatusChip status={taskStatus} />
          </p>
          <p className="workgroup-room__gate-state">
            {taskStatus === 'done'
              ? t('workgroups.dw.executingDone')
              : taskStatus === 'failed'
                ? t('workgroups.dw.executingFailed')
                : t('workgroups.dw.executing')}
          </p>
          {savedName !== null && (
            <p className="workgroup-room__gate-state" data-testid="dw-saved-note">
              {t('workgroups.dw.saved', { name: savedName })}
            </p>
          )}
        </Card>
      )}

      {/* ── reject dialog (comment REQUIRED — backend 422s without one) ─── */}
      <Dialog
        open={rejectOpen}
        onClose={() => setRejectOpen(false)}
        title={t('workgroups.dw.rejectTitle')}
        size="sm"
        data-testid="dw-reject-dialog"
        footer={
          <>
            {confirm.error !== null && confirm.error !== undefined && (
              <span className="form-actions__error">{describeApiError(confirm.error)}</span>
            )}
            <button type="button" className="btn" onClick={() => setRejectOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--danger"
              disabled={confirm.isPending || rejectComment.trim().length === 0}
              onClick={() => confirm.mutate({ decision: 'reject', comment: rejectComment.trim() })}
              data-testid="dw-reject-submit"
            >
              {confirm.isPending ? t('common.saving') : t('workgroups.dw.rejectSubmit')}
            </button>
          </>
        }
      >
        <Field
          label={t('workgroups.dw.rejectCommentLabel')}
          required
          hint={t('workgroups.dw.rejectCommentHint')}
        >
          <TextArea
            value={rejectComment}
            onChange={setRejectComment}
            rows={4}
            maxLength={65536}
            data-testid="dw-reject-comment"
          />
        </Field>
      </Dialog>

      {/* ── save-as dialog ───────────────────────────────────────────────── */}
      <Dialog
        open={saveAsOpen}
        onClose={() => setSaveAsOpen(false)}
        title={t('workgroups.dw.saveAsTitle')}
        size="sm"
        data-testid="dw-save-as-dialog"
        footer={
          <>
            {saveAs.error !== null && saveAs.error !== undefined && (
              <span className="form-actions__error">{describeApiError(saveAs.error)}</span>
            )}
            <button type="button" className="btn" onClick={() => setSaveAsOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--sm btn--primary"
              disabled={saveAs.isPending || saveAsName.trim().length === 0}
              onClick={() =>
                saveAs.mutate({
                  name: saveAsName.trim(),
                  ...(saveAsDesc.trim() !== '' ? { description: saveAsDesc.trim() } : {}),
                })
              }
              data-testid="dw-save-as-submit"
            >
              {saveAs.isPending ? t('common.saving') : t('workgroups.dw.saveAsSubmit')}
            </button>
          </>
        }
      >
        <Field label={t('workgroups.dw.saveAsNameLabel')} required>
          <TextInput value={saveAsName} onChange={setSaveAsName} data-testid="dw-save-as-name" />
        </Field>
        <Field label={t('workgroups.dw.saveAsDescLabel')}>
          <TextInput value={saveAsDesc} onChange={setSaveAsDesc} data-testid="dw-save-as-desc" />
        </Field>
      </Dialog>
    </div>
  )
}
