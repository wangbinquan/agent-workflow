// RFC-045/RFC-342 — memory content edit + candidate scope move dialog.
//
// Opens from row-level [Edit] buttons in Approval Queue / All / By-scope.
// On Save, content goes through PATCH while a candidate scope change goes
// through the dedicated versioned POST /move command. Approved/archived scope
// is visibly frozen; their content remains editable.
//
// RFC-151 PR-4: chrome (Dialog + footer + scope-option queries + validation
// gate) lives in the shared <MemoryDialogShell>; this file keeps only the
// edit-side specifics — entity-seeded form, Move/content command planning,
// stale-race eager cache writes and terminal-status error copy.

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
  title?: string
  bodyMd?: string
  tags?: string[]
}

interface MovePayload {
  expectedVersion: number
  scopeType: MemoryFormState['scopeType']
  scopeId: string | null
}

interface EditPlan {
  patch: PatchPayload
  move?: MovePayload
}

function planAgainst(seed: Memory, draft: MemoryFormState): EditPlan {
  const patch: PatchPayload = {}
  const draftScopeId = draft.scopeType === 'global' ? null : draft.scopeId
  const scopeChanged =
    draft.scopeType !== seed.scopeType || (draftScopeId ?? null) !== (seed.scopeId ?? null)
  const move = scopeChanged
    ? {
        expectedVersion: seed.version,
        scopeType: draft.scopeType,
        scopeId: draftScopeId ?? null,
      }
    : undefined
  if (draft.title.trim() !== seed.title) patch.title = draft.title.trim()
  if (draft.bodyMd.trim() !== seed.bodyMd) patch.bodyMd = draft.bodyMd.trim()
  // Tags compared order-independently (service layer does the same).
  const seedTags = [...seed.tags].sort()
  const draftTags = [...draft.tags].sort()
  const tagsEqual =
    seedTags.length === draftTags.length && seedTags.every((v, i) => v === draftTags[i])
  if (!tagsEqual) patch.tags = draft.tags
  return { patch, ...(move === undefined ? {} : { move }) }
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

  const update = useMutation<{ memory: Memory; changedFields: string[] }, ApiError, EditPlan>({
    mutationFn: async (plan) => {
      if (memory === undefined) throw new Error('memory detail is not loaded')
      let current = memory
      const changedFields: string[] = []
      if (plan.move !== undefined) {
        const beforeMove = current
        const moved = await api.post<{ memory: Memory; moved: boolean }>(
          `/api/memories/${encodeURIComponent(memory.id)}/move`,
          plan.move,
        )
        current = moved.memory
        if (moved.moved) {
          if (beforeMove.scopeType !== current.scopeType) changedFields.push('scopeType')
          if (beforeMove.scopeId !== current.scopeId) changedFields.push('scopeId')
        }
      }
      if (Object.keys(plan.patch).length > 0) {
        const patched = await api.patch<{ memory: Memory; changedFields: string[] }>(
          `/api/memories/${encodeURIComponent(memory.id)}`,
          plan.patch,
        )
        current = patched.memory
        changedFields.push(...patched.changedFields)
      }
      return { memory: current, changedFields }
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
    onError: () => {
      // A combined candidate save is two explicit commands. If Move commits
      // and the following content PATCH fails, force every consumer to refetch
      // the durable scope instead of retaining the pre-move cache.
      void qc.invalidateQueries({ queryKey: ['memories', 'detail', memoryId] })
      void qc.invalidateQueries({ queryKey: ['memories', 'candidates'] })
      void qc.invalidateQueries({ queryKey: ['memories', 'all'] })
      void qc.invalidateQueries({ queryKey: ['memories', 'scoped'] })
    },
  })

  const handleSubmit = () => {
    if (memory === undefined) return
    const plan = planAgainst(memory, f.state)
    if (plan.move === undefined && Object.keys(plan.patch).length === 0) {
      // No-op locally → also no need to round-trip. Treat as close.
      props.onClose()
      return
    }
    update.mutate(plan)
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
      scopeDisabled={memory !== undefined && memory.status !== 'candidate'}
      scopeDisabledReason={
        memory !== undefined && memory.status !== 'candidate'
          ? t('memory.form.scopeMoveCandidateOnly')
          : undefined
      }
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

export { planAgainst as _planAgainstForTests }
