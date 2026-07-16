// RFC-151 PR-4 — shared shell of the two admin memory dialogs.
//
// <MemoryNewDialog> (POST /api/memories) and <MemoryEditDialog>
// (diff → PATCH /api/memories/:id) forked the exact same chrome: Dialog
// skeleton + cancel/save footer, the three scope-option queries (agents /
// workflows / cached-repos, fetched only while open), the three ToOptions
// mappers and the validate-before-submit gate. This shell owns all of that;
// the dialogs keep only what genuinely differs — form seeding, the submit
// payload (create vs diff + eager cache write) and error-text mapping.
//
// The caller owns the mutation, so:
//   - `pending` drives the disabled states + the close guard,
//   - `errorText` is the already-mapped message (Edit special-cases
//     memory-terminal-status before falling back to describeApiError),
//   - `onSubmit` fires only when the form validates and nothing is in
//     flight (same double-guard the dialogs used to carry themselves).

import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { Agent, Workflow } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import {
  MemoryFormFields,
  validateMemoryForm,
  type useMemoryFormState,
  type ScopeOption,
} from './MemoryFormFields'

interface CachedRepoListEntry {
  id: string
  url: string
  localPath: string
}

export interface MemoryDialogShellProps {
  open: boolean
  onClose: () => void
  /** Resolved dialog title (memory.newDialogTitle / memory.editDialogTitle). */
  title: string
  /** Testid base — 'memory-new-dialog' | 'memory-edit-dialog'; the footer
   *  buttons and error box derive `-cancel` / `-save` / `-error` from it. */
  testid: string
  /** The caller-seeded form handle (create: empty; edit: entity seed). */
  form: ReturnType<typeof useMemoryFormState>
  /** True while the caller's mutation is in flight. */
  pending: boolean
  /** Already-mapped mutation error message, or null when clean. */
  errorText: string | null
  onSubmit: () => void
  /** Keeps this Dialog mounted while an edit detail request resolves. */
  contentState?: { status: 'loading' } | { status: 'error'; error: unknown; onRetry: () => void }
}

export function MemoryDialogShell(props: MemoryDialogShellProps) {
  const { t } = useTranslation()
  const errors = validateMemoryForm(
    props.form.state,
    t as (k: string, o?: Record<string, unknown>) => string,
  )
  const isInvalid = Object.keys(errors).length > 0

  const agents = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: ({ signal }) => api.get<Agent[]>('/api/agents', undefined, signal),
    enabled: props.open && props.contentState === undefined,
  })
  const workflows = useQuery<Workflow[]>({
    queryKey: ['workflows'],
    queryFn: ({ signal }) => api.get<Workflow[]>('/api/workflows', undefined, signal),
    enabled: props.open && props.contentState === undefined,
  })
  const repos = useQuery<{ items: CachedRepoListEntry[] }>({
    queryKey: ['cached-repos'],
    queryFn: ({ signal }) =>
      api.get<{ items: CachedRepoListEntry[] }>('/api/cached-repos', undefined, signal),
    enabled: props.open && props.contentState === undefined,
  })

  return (
    <Dialog
      open={props.open}
      onClose={() => {
        if (props.pending) return
        props.onClose()
      }}
      title={props.title}
      size="md"
      data-testid={props.testid}
      footer={
        <>
          <button
            type="button"
            className="btn btn--sm"
            onClick={props.onClose}
            disabled={props.pending}
            data-testid={`${props.testid}-cancel`}
          >
            {t('memory.formCancel')}
          </button>
          {props.contentState === undefined && (
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={() => {
                if (isInvalid || props.pending) return
                props.onSubmit()
              }}
              disabled={isInvalid || props.pending}
              data-testid={`${props.testid}-save`}
            >
              {t('memory.formSave')}
            </button>
          )}
        </>
      }
    >
      {props.contentState?.status === 'loading' ? (
        <LoadingState label={t('memory.loadingEdit')} />
      ) : props.contentState?.status === 'error' ? (
        <ErrorBanner
          error={props.contentState.error}
          action={
            <button type="button" className="btn btn--sm" onClick={props.contentState.onRetry}>
              {t('common.retry')}
            </button>
          }
        />
      ) : (
        <>
          {props.errorText !== null && (
            <div className="error-box" data-testid={`${props.testid}-error`}>
              {props.errorText}
            </div>
          )}
          <MemoryFormFields
            state={props.form.state}
            errors={errors}
            onScopeType={props.form.setScopeType}
            onScopeId={props.form.setScopeId}
            onTitle={props.form.setTitle}
            onBodyMd={props.form.setBodyMd}
            onTags={props.form.setTags}
            agents={agentsToOptions(agents.data)}
            workflows={workflowsToOptions(workflows.data)}
            repos={reposToOptions(repos.data?.items)}
            disabled={props.pending}
          />
        </>
      )}
    </Dialog>
  )
}

function agentsToOptions(agents?: Agent[]): ScopeOption[] {
  if (!agents) return []
  return agents.map((a) => ({ id: a.id, label: a.name }))
}

function workflowsToOptions(workflows?: Workflow[]): ScopeOption[] {
  if (!workflows) return []
  return workflows.map((w) => ({ id: w.id, label: w.name }))
}

function reposToOptions(repos?: CachedRepoListEntry[]): ScopeOption[] {
  if (!repos) return []
  return repos.map((r) => ({ id: r.id, label: r.url }))
}
