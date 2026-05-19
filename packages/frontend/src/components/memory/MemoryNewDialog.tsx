// RFC-045 — admin manual create memory dialog.
//
// Opens from the /memory page header `[+ New memory]` button. On Save:
//   POST /api/memories  (perm=memory:approve; route is shared with the
//   existing `createManualCandidate` path so the WS publishes
//   memory.candidate.created for free).
// After a successful create the dialog closes and the caller switches
// the visible tab to Approval Queue.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { Agent, Memory, Workflow } from '@agent-workflow/shared'
import { api } from '@/api/client'
import type { ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { describeApiError } from '@/i18n'
import {
  MemoryFormFields,
  useMemoryFormState,
  validateMemoryForm,
  type MemoryFormState,
  type ScopeOption,
} from './MemoryFormFields'

interface CachedRepoListEntry {
  id: string
  url: string
  localPath: string
}

export interface MemoryNewDialogProps {
  open: boolean
  onClose: () => void
  onCreated?: (m: Memory) => void
}

interface CreatePayload {
  scopeType: MemoryFormState['scopeType']
  scopeId: string | null
  title: string
  bodyMd: string
  tags?: string[]
}

export function MemoryNewDialog(props: MemoryNewDialogProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const f = useMemoryFormState()
  const errors = validateMemoryForm(
    f.state,
    t as (k: string, o?: Record<string, unknown>) => string,
  )
  const isInvalid = Object.keys(errors).length > 0

  const agents = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: ({ signal }) => api.get<Agent[]>('/api/agents', undefined, signal),
    enabled: props.open,
  })
  const workflows = useQuery<Workflow[]>({
    queryKey: ['workflows'],
    queryFn: ({ signal }) => api.get<Workflow[]>('/api/workflows', undefined, signal),
    enabled: props.open,
  })
  const repos = useQuery<{ items: CachedRepoListEntry[] }>({
    queryKey: ['cached-repos'],
    queryFn: ({ signal }) =>
      api.get<{ items: CachedRepoListEntry[] }>('/api/cached-repos', undefined, signal),
    enabled: props.open,
  })

  const create = useMutation<Memory, ApiError, CreatePayload>({
    mutationFn: async (payload) => {
      const res = await api.post<{ memory: Memory }>('/api/memories', payload)
      return res.memory
    },
    onSuccess: (memory) => {
      void qc.invalidateQueries({ queryKey: ['memories', 'candidates'] })
      void qc.invalidateQueries({ queryKey: ['memories', 'pending-count'] })
      f.reset()
      props.onCreated?.(memory)
      props.onClose()
    },
  })

  const handleSubmit = () => {
    if (isInvalid || create.isPending) return
    const payload: CreatePayload = {
      scopeType: f.state.scopeType,
      scopeId: f.state.scopeType === 'global' ? null : f.state.scopeId,
      title: f.state.title.trim(),
      bodyMd: f.state.bodyMd.trim(),
      tags: f.state.tags.length > 0 ? f.state.tags : undefined,
    }
    create.mutate(payload)
  }

  return (
    <Dialog
      open={props.open}
      onClose={() => {
        if (create.isPending) return
        props.onClose()
      }}
      title={t('memory.newDialogTitle')}
      size="md"
      data-testid="memory-new-dialog"
      footer={
        <>
          <button
            type="button"
            className="btn btn--sm"
            onClick={props.onClose}
            disabled={create.isPending}
            data-testid="memory-new-dialog-cancel"
          >
            {t('memory.formCancel')}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={handleSubmit}
            disabled={isInvalid || create.isPending}
            data-testid="memory-new-dialog-save"
          >
            {t('memory.formSave')}
          </button>
        </>
      }
    >
      {create.error !== null && create.error !== undefined && (
        <div className="error-box" data-testid="memory-new-dialog-error">
          {describeApiError(create.error)}
        </div>
      )}
      <MemoryFormFields
        state={f.state}
        errors={errors}
        onScopeType={f.setScopeType}
        onScopeId={f.setScopeId}
        onTitle={f.setTitle}
        onBodyMd={f.setBodyMd}
        onTags={f.setTags}
        agents={agentsToOptions(agents.data)}
        workflows={workflowsToOptions(workflows.data)}
        repos={reposToOptions(repos.data?.items)}
        disabled={create.isPending}
      />
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
