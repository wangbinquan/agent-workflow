// RFC-045 — admin edit memory dialog.
//
// Opens from row-level [Edit] buttons in Approval Queue / All / By-scope.
// On Save: PATCH /api/memories/:id  (perm=memory:edit). Service layer
// version-bumps + publishes memory.updated only when ≥1 field actually
// changed; this UI also computes a client-side diff so the PATCH body
// stays minimal.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { Agent, Memory, Workflow } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
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

export interface MemoryEditDialogProps {
  open: boolean
  onClose: () => void
  memory: Memory
}

interface PatchPayload {
  scopeType?: MemoryFormState['scopeType']
  scopeId?: string | null
  title?: string
  bodyMd?: string
  tags?: string[]
}

function diffAgainst(seed: Memory, draft: MemoryFormState): PatchPayload {
  const out: PatchPayload = {}
  if (draft.scopeType !== seed.scopeType) out.scopeType = draft.scopeType
  // scopeId: compare nullable strings; PATCH must include it when scopeType
  // changes too so the schema's global ↔ null pair is consistent on the wire.
  const draftScopeId = draft.scopeType === 'global' ? null : draft.scopeId
  if ((draftScopeId ?? null) !== (seed.scopeId ?? null)) out.scopeId = draftScopeId ?? null
  if (out.scopeType !== undefined && out.scopeId === undefined) {
    // Always pair them on the wire so the backend never has to "guess"
    // intent — RFC-045 design.md §4.2 step 3 still synth-validates on the
    // server, but sending both is the documented happy path.
    out.scopeId = draftScopeId ?? null
  }
  if (draft.title.trim() !== seed.title) out.title = draft.title.trim()
  if (draft.bodyMd.trim() !== seed.bodyMd) out.bodyMd = draft.bodyMd.trim()
  // Tags compared order-independently (service layer does the same).
  const seedTags = [...seed.tags].sort()
  const draftTags = [...draft.tags].sort()
  const tagsEqual =
    seedTags.length === draftTags.length && seedTags.every((v, i) => v === draftTags[i])
  if (!tagsEqual) out.tags = draft.tags
  return out
}

export function MemoryEditDialog(props: MemoryEditDialogProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const f = useMemoryFormState({
    scopeType: props.memory.scopeType,
    scopeId: props.memory.scopeId,
    title: props.memory.title,
    bodyMd: props.memory.bodyMd,
    tags: props.memory.tags,
  })
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

  const update = useMutation<{ memory: Memory; changedFields: string[] }, ApiError, PatchPayload>({
    mutationFn: async (payload) => {
      return api.patch<{ memory: Memory; changedFields: string[] }>(
        `/api/memories/${encodeURIComponent(props.memory.id)}`,
        payload,
      )
    },
    onSuccess: (resp) => {
      const next = resp.memory
      // Eagerly write the freshly-returned memory into every cache that
      // hands a Memory object back to <MemoryEditDialog>. Without this,
      // re-opening the dialog immediately after save returns the stale
      // cached row (React Query returns the cached value first and
      // refetches in background — the dialog mounts faster than the
      // background fetch settles, so `useMemoryFormState`'s once-only
      // initializer captures the pre-edit data).
      //
      // - detail cache: read by the list-side <MemoryAllList> /
      //   <MemoryByScopeBrowser> / <MemoryScopedList> useQuery before they
      //   open the dialog. Write the full Memory directly so the next open
      //   sees v(N+1) without a round trip.
      // - candidates cache: <MemoryApprovalQueue> stores the full Memory in
      //   list items and seeds setEditing(mem) from that list. Map over
      //   the items and replace the one matching id.
      // - 'all' / 'scoped' lists hold MemorySummary (different shape) AND
      //   may need to remove the row when scope changed. Plain invalidate
      //   is safer than fragile eager edits there.
      qc.setQueryData(['memories', 'detail', next.id], { memory: next })
      qc.setQueriesData<{ items: Memory[] } | undefined>(
        { queryKey: ['memories', 'candidates'] },
        (old) =>
          old !== undefined ? { items: old.items.map((m) => (m.id === next.id ? next : m)) } : old,
      )
      void qc.invalidateQueries({ queryKey: ['memories', 'candidates'] })
      void qc.invalidateQueries({ queryKey: ['memories', 'all'] })
      void qc.invalidateQueries({ queryKey: ['memories', 'scoped'] })
      // Deliberately NOT invalidating the detail key: we just wrote the
      // server response into it, so a refetch would be wasted churn and
      // would re-introduce the stale-then-fresh race this fix exists to
      // eliminate.
      props.onClose()
    },
  })

  const handleSubmit = () => {
    if (isInvalid || update.isPending) return
    const diff = diffAgainst(props.memory, f.state)
    if (Object.keys(diff).length === 0) {
      // No-op locally → also no need to round-trip. Treat as close.
      props.onClose()
      return
    }
    update.mutate(diff)
  }

  return (
    <Dialog
      open={props.open}
      onClose={() => {
        if (update.isPending) return
        props.onClose()
      }}
      title={t('memory.editDialogTitle')}
      size="md"
      data-testid="memory-edit-dialog"
      footer={
        <>
          <button
            type="button"
            className="btn btn--sm"
            onClick={props.onClose}
            disabled={update.isPending}
            data-testid="memory-edit-dialog-cancel"
          >
            {t('memory.formCancel')}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={handleSubmit}
            disabled={isInvalid || update.isPending}
            data-testid="memory-edit-dialog-save"
          >
            {t('memory.formSave')}
          </button>
        </>
      }
    >
      {update.error !== null && update.error !== undefined && (
        <div className="error-box" data-testid="memory-edit-dialog-error">
          {update.error instanceof ApiError && update.error.code === 'memory-terminal-status'
            ? t('memory.error.terminalStatus')
            : describeApiError(update.error)}
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
        disabled={update.isPending}
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

export { diffAgainst as _diffAgainstForTests }
