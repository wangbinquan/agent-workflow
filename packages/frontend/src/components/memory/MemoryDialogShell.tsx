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
import { useUserLookup } from '@/hooks/useUserLookup'
import { resourceOptionLabel } from '@/lib/resource-option-label'
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
  const owners = useUserLookup([
    ...(agents.data ?? []).map((agent) => agent.ownerUserId),
    ...(workflows.data ?? []).map((workflow) => workflow.ownerUserId),
  ])

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
        <ErrorBanner error={props.contentState.error} onRetry={props.contentState.onRetry} />
      ) : (
        <>
          {props.errorText !== null && (
            <ErrorBanner error={props.errorText} testid={`${props.testid}-error`} />
          )}
          <MemoryFormFields
            state={props.form.state}
            errors={errors}
            onScopeType={props.form.setScopeType}
            onScopeId={props.form.setScopeId}
            onTitle={props.form.setTitle}
            onBodyMd={props.form.setBodyMd}
            onTags={props.form.setTags}
            agents={agentsToOptions(
              agents.data,
              (ownerUserId) => owners.get(ownerUserId)?.displayName ?? ownerUserId ?? undefined,
            )}
            workflows={workflowsToOptions(
              workflows.data,
              (ownerUserId) => owners.get(ownerUserId)?.displayName ?? ownerUserId ?? undefined,
            )}
            repos={reposToOptions(repos.data?.items)}
            disabled={props.pending}
          />
        </>
      )}
    </Dialog>
  )
}

function agentsToOptions(
  agents: Agent[] | undefined,
  ownerLabel: (ownerUserId: string | null | undefined) => string | undefined,
): ScopeOption[] {
  if (!agents) return []
  return agents.map((agent) => ({
    id: agent.id,
    label: resourceOptionLabel(agent.name, ownerLabel(agent.ownerUserId)),
  }))
}

function workflowsToOptions(
  workflows: Workflow[] | undefined,
  ownerLabel: (ownerUserId: string | null | undefined) => string | undefined,
): ScopeOption[] {
  if (!workflows) return []
  return workflows.map((workflow) => ({
    id: workflow.id,
    label: resourceOptionLabel(workflow.name, ownerLabel(workflow.ownerUserId)),
  }))
}

function reposToOptions(repos?: CachedRepoListEntry[]): ScopeOption[] {
  if (!repos) return []
  return repos.map((r) => ({ id: r.id, label: r.url }))
}
