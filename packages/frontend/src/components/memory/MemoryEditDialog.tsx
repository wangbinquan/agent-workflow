// RFC-045 — admin edit memory dialog.
//
// Opens from row-level [Edit] buttons in Approval Queue / All / By-scope.
// On Save: PATCH /api/memories/:id  (perm=memory:edit). Service layer
// version-bumps + publishes memory.updated only when ≥1 field actually
// changed; this UI also computes a client-side diff so the PATCH body
// stays minimal.
//
// RFC-151 PR-4: chrome (Dialog + footer + scope-option queries + validation
// gate) lives in the shared <MemoryDialogShell>; this file keeps only the
// edit-side specifics — entity-seeded form, diff → PATCH submit, the
// stale-race eager cache writes and the terminal-status error copy.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { Memory } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { describeApiError } from '@/i18n'
import { MemoryDialogShell } from './MemoryDialogShell'
import { useMemoryFormState, type MemoryFormState } from './MemoryFormFields'

interface MemoryEditDialogBaseProps {
  open: boolean
  onClose: () => void
}

export type MemoryEditDialogProps = MemoryEditDialogBaseProps &
  ({ memory: Memory; memoryId?: never } | { memoryId: string; memory?: never })

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
  const suppliedMemory = 'memory' in props ? props.memory : undefined
  const memoryId = suppliedMemory?.id ?? props.memoryId ?? ''
  const detail = useQuery<{ memory: Memory }>({
    queryKey: ['memories', 'detail', memoryId],
    queryFn: ({ signal }) =>
      api.get<{ memory: Memory }>(
        `/api/memories/${encodeURIComponent(memoryId)}`,
        undefined,
        signal,
      ),
    enabled: props.open && suppliedMemory === undefined,
  })
  const memory = suppliedMemory ?? detail.data?.memory
  const f = useMemoryFormState({
    scopeType: suppliedMemory?.scopeType,
    scopeId: suppliedMemory?.scopeId,
    title: suppliedMemory?.title,
    bodyMd: suppliedMemory?.bodyMd,
    tags: suppliedMemory?.tags,
  })
  const seededVersionRef = useRef(
    suppliedMemory === undefined ? null : `${suppliedMemory.id}:${suppliedMemory.version}`,
  )
  const resetForm = f.reset

  useLayoutEffect(() => {
    if (memory === undefined) return
    const versionKey = `${memory.id}:${memory.version}`
    if (seededVersionRef.current === versionKey) return
    seededVersionRef.current = versionKey
    resetForm({
      scopeType: memory.scopeType,
      scopeId: memory.scopeId,
      title: memory.title,
      bodyMd: memory.bodyMd,
      tags: memory.tags,
    })
  }, [memory, resetForm])

  const update = useMutation<{ memory: Memory; changedFields: string[] }, ApiError, PatchPayload>({
    mutationFn: async (payload) => {
      if (memory === undefined) throw new Error('memory detail is not loaded')
      return api.patch<{ memory: Memory; changedFields: string[] }>(
        `/api/memories/${encodeURIComponent(memory.id)}`,
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
    if (memory === undefined) return
    const diff = diffAgainst(memory, f.state)
    if (Object.keys(diff).length === 0) {
      // No-op locally → also no need to round-trip. Treat as close.
      props.onClose()
      return
    }
    update.mutate(diff)
  }

  return (
    <MemoryDialogShell
      open={props.open}
      onClose={props.onClose}
      title={t('memory.editDialogTitle')}
      testid="memory-edit-dialog"
      form={f}
      pending={update.isPending}
      errorText={
        update.error !== null && update.error !== undefined
          ? update.error instanceof ApiError && update.error.code === 'memory-terminal-status'
            ? t('memory.error.terminalStatus')
            : describeApiError(update.error)
          : null
      }
      onSubmit={handleSubmit}
      contentState={
        memory !== undefined
          ? undefined
          : detail.error !== null
            ? { status: 'error', error: detail.error, onRetry: () => void detail.refetch() }
            : { status: 'loading' }
      }
    />
  )
}

export { diffAgainst as _diffAgainstForTests }
