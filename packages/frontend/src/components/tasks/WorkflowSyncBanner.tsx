// RFC-109 — task-detail banner shown when the task's workflow has a newer
// definition than the frozen snapshot AND the task is in a syncable (non-active)
// state. Clicking opens <WorkflowSyncDialog> to preview the change + confirm.
//
// Returns null (invisible) when not syncable, definitions are identical, the
// workflow is deleted/not-visible, or the worktree is gone — mirrors the
// StuckTaskBanner "null by default" pattern.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import type { Task, WorkflowSyncPreview } from '@agent-workflow/shared'

import { WorkflowSyncDialog } from './WorkflowSyncDialog'

export interface WorkflowSyncBannerProps {
  taskId: string
}

export function WorkflowSyncBanner(props: WorkflowSyncBannerProps): ReactElement | null {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)

  const q = useQuery<WorkflowSyncPreview>({
    queryKey: ['tasks', props.taskId, 'workflow-sync-preview'],
    queryFn: ({ signal }) =>
      api.get<WorkflowSyncPreview>(
        `/api/tasks/${encodeURIComponent(props.taskId)}/workflow-sync-preview`,
        undefined,
        signal,
      ),
    refetchOnWindowFocus: true,
    staleTime: 15_000,
    // Codex impl-gate F5: no WS event invalidates this query (task WS refreshes
    // task/node-runs/diff only), so a workflow edit in another tab or a task that
    // just settled into a syncable state would otherwise stay hidden until focus.
    // A conservative interval keeps the banner fresh while the page is open.
    refetchInterval: 30_000,
  })

  const sync = useMutation({
    mutationFn: (expectedVersion: number) =>
      api.post<Task>(`/api/tasks/${encodeURIComponent(props.taskId)}/sync-workflow`, {
        expectedVersion,
      }),
    onSuccess: (tk) => {
      qc.setQueryData(['tasks', props.taskId], tk)
      void qc.invalidateQueries({ queryKey: ['tasks', props.taskId, 'node-runs'] })
      void qc.invalidateQueries({ queryKey: ['tasks', props.taskId, 'workflow-sync-preview'] })
      void qc.invalidateQueries({ queryKey: ['tasks'] })
      setOpen(false)
    },
    onError: () => {
      // A stale-version 409 means the workflow advanced again — refresh the
      // preview so the dialog re-renders against the new latest version.
      void qc.invalidateQueries({ queryKey: ['tasks', props.taskId, 'workflow-sync-preview'] })
    },
  })

  const preview = q.data
  if (preview === undefined || !preview.syncable || !preview.differs) return null

  const versionText = `v${preview.currentVersion ?? t('tasks.syncWorkflow.unknownVersion')} → v${preview.latestVersion ?? '?'}`

  return (
    <>
      <div
        className="task-error-banner task-error-banner--warning"
        role="status"
        data-testid="workflow-sync-banner"
      >
        <div className="task-error-banner__body">
          <div className="task-error-banner__summary">
            <strong>{t('tasks.syncWorkflow.bannerTitle')}</strong>{' '}
            <span>
              {t('tasks.syncWorkflow.bannerHint')} ({versionText})
            </span>
          </div>
        </div>
        <button
          type="button"
          className="btn btn--sm btn--primary"
          onClick={() => setOpen(true)}
          data-testid="workflow-sync-open"
        >
          {t('tasks.syncWorkflow.button')}
        </button>
      </div>
      {open && (
        <WorkflowSyncDialog
          open={open}
          onClose={() => setOpen(false)}
          preview={preview}
          pending={sync.isPending}
          error={sync.error}
          onConfirm={() => {
            if (preview.latestVersion !== null) sync.mutate(preview.latestVersion)
          }}
        />
      )}
    </>
  )
}
