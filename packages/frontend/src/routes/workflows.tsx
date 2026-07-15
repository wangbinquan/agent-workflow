// Workflows list — RFC-191 card gallery. Each card opens the xyflow editor
// at /workflows/$id (whole card = stretched link);「启动」deep-links the task
// wizard with the workflow preselected. Creation stays the QUICK-CREATE
// dialog (name + description only — the definition starts empty; all canvas
// editing happens on the editor page), mirroring the RFC-164 pattern.
// Delete / export live in the EDITOR header (RFC-191: no list-level delete).

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CreateWorkflow, Workflow } from '@agent-workflow/shared'
import { api, ApiError, extractErrorBody } from '@/api/client'
import { useResourceList } from '@/hooks/useResourceList'
import { describeApiError } from '@/i18n'
import { getBaseUrl, getToken } from '@/stores/auth'
import { QuickCreateDialog } from '@/components/QuickCreateDialog'
import { ResourceBadges } from '@/components/ResourceBadges'
import { WorkflowImportDialog, type WorkflowImportMode } from '@/components/WorkflowImportDialog'
import { ResourceGalleryPage, type GalleryCardItem } from '@/components/gallery/ResourceGalleryPage'
import { WORKFLOW_ICON } from '@/components/icons/resourceIcons'
import { buildQuickCreateWorkflowPayload } from '@/lib/workflow-form'
import { Route as RootRoute } from './__root'

export interface WorkflowsSearch extends Record<string, unknown> {
  create?: boolean
}

export function validateWorkflowsSearch(raw: Record<string, unknown>): WorkflowsSearch {
  const out: WorkflowsSearch = { ...raw }
  if (raw.create === true || raw.create === 1 || raw.create === '1') out.create = true
  else delete out.create
  return out
}

export function withoutWorkflowCreate(search: WorkflowsSearch): WorkflowsSearch {
  const next = { ...search }
  delete next.create
  return next
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workflows',
  component: WorkflowsPage,
  validateSearch: validateWorkflowsSearch,
})

// Retired creation URL — the full-page creator is gone, but old bookmarks /
// browser history may still open it. Redirect to the list page (the dialog
// lives there); registered before '/workflows/$id' so "new" never resolves
// as a workflow id.
export const NewRedirectRoute = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workflows/new',
  beforeLoad: () => {
    throw redirect({ to: '/workflows' })
  },
})

function WorkflowsPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const routeNavigate = Route.useNavigate()
  const search = Route.useSearch()
  const qc = useQueryClient()
  // RFC-151 PR-3 — shared list shell: query + owner lookup. The delete
  // mutation is unused here since RFC-191 (delete lives in the editor header).
  const { data, isLoading, error, owners } = useResourceList<Workflow>({
    queryKey: ['workflows'],
    endpoint: '/api/workflows',
    deleteBy: 'id',
  })

  // Quick create — name + description only; navigate straight into the
  // editor (where the empty definition gets built out) on success.
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const createTriggerRef = useRef<HTMLButtonElement | null>(null)
  // Mirrors createOpen for the mutation callback: dismissing the dialog while
  // a slow POST is in flight must NOT yank the user into the editor when the
  // response lands later (the card still appears via the list invalidation).
  const createOpenRef = useRef(false)
  const setCreateOpenTracked = useCallback((open: boolean): void => {
    createOpenRef.current = open
    setCreateOpen(open)
  }, [])
  const create = useMutation({
    mutationFn: (body: CreateWorkflow): Promise<Workflow> => api.post('/api/workflows', body),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ['workflows'] })
      qc.setQueryData(['workflows', created.id], created)
      if (!createOpenRef.current) return
      setCreateOpenTracked(false)
      navigate({ to: '/workflows/$id', params: { id: created.id } })
    },
  })
  const builtCreate = buildQuickCreateWorkflowPayload({
    name: createName,
    description: createDescription,
  })

  const resetCreate = create.reset
  const openCreate = useCallback((): void => {
    setCreateName('')
    setCreateDescription('')
    resetCreate()
    setCreateOpenTracked(true)
  }, [resetCreate, setCreateOpenTracked])

  // RFC-198 one-shot deep action. Replacing the flagged entry means closing,
  // refreshing the canonical URL, Back, and Forward cannot replay the dialog.
  // Functional search preserves adjacent/future search keys.
  const deepCreateConsumedRef = useRef(false)
  useEffect(() => {
    if (search.create !== true) {
      deepCreateConsumedRef.current = false
      return
    }
    if (deepCreateConsumedRef.current) return
    deepCreateConsumedRef.current = true
    openCreate()
    void routeNavigate({
      search: (previous) => withoutWorkflowCreate(previous),
      replace: true,
    })
  }, [openCreate, routeNavigate, search.create])

  const [importOpen, setImportOpen] = useState(false)
  const importTriggerRef = useRef<HTMLButtonElement | null>(null)
  async function importWorkflow(yaml: string, mode: WorkflowImportMode): Promise<void> {
    await postYaml(yaml, mode)
    await qc.invalidateQueries({ queryKey: ['workflows'] })
  }

  // Gallery items — updatedAt desc (freshest first). Node count derives from
  // the definition the list API already returns (schema defaults nodes: []).
  const items = useMemo<GalleryCardItem[] | undefined>(
    () =>
      data === undefined
        ? undefined
        : data
            .slice()
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((w) => ({
              key: w.id,
              kind: 'workflow' as const,
              title: w.name,
              subtitle: w.description === '' ? undefined : w.description,
              searchText: [
                `v${w.version}`,
                t('workflows.cardNodes', { count: w.definition.nodes.length }),
                w.visibility === 'private' ? t('acl.privateChip') : '',
                w.ownerUserId != null ? (owners.get(w.ownerUserId)?.displayName ?? '') : '',
              ].join(' '),
              subtitleFallback: t('workflows.noDescription'),
              badges: (
                <ResourceBadges
                  visibility={w.visibility}
                  ownerUserId={w.ownerUserId}
                  owners={owners}
                />
              ),
              meta: (
                <>
                  <span className="chip chip--tight">
                    {t('workflows.cardNodes', { count: w.definition.nodes.length })}
                  </span>
                  <span className="chip chip--tight">v{w.version}</span>
                </>
              ),
              updatedAt: w.updatedAt,
              to: '/workflows/$id' as const,
              params: { id: w.id },
              launch: { kind: 'workflow' as const, workflow: w.id },
              testid: `workflow-card-${w.name}`,
            })),
    [data, owners, t],
  )

  // The same stable primary action moves between the header (items / no-match)
  // and the genuine-empty state. Keeping one element also keeps Dialog focus
  // restoration pointed at whichever trigger is currently connected.
  const createAction = (
    <button
      type="button"
      className="btn btn--primary"
      ref={createTriggerRef}
      onClick={openCreate}
      data-testid="workflow-new-button"
    >
      {t('workflows.newButton')}
    </button>
  )
  const importActions = (
    <button
      ref={importTriggerRef}
      type="button"
      className="btn"
      onClick={() => setImportOpen(true)}
      data-testid="workflow-import-trigger"
    >
      {t('workflows.importButton')}
    </button>
  )

  return (
    <ResourceGalleryPage
      title={t('workflows.title')}
      headerActions={
        <>
          {importActions}
          {createAction}
        </>
      }
      emptyHeaderActions={importActions}
      emptyAction={createAction}
      emptyIcon={WORKFLOW_ICON}
      items={items}
      isLoading={isLoading}
      error={error}
      onRetry={() => void qc.invalidateQueries({ queryKey: ['workflows'] })}
      onClearSearch={() => undefined}
      clearSearchLabel={t('common.clearSearch')}
      searchPlaceholder={t('common.searchCards')}
      emptyListText={t('workflows.emptyList')}
      emptyDescription={t('workflows.emptyDescription')}
      emptyTestid="workflows-empty"
      loadingTestid="workflows-loading"
    >
      <QuickCreateDialog
        open={createOpen}
        onClose={() => setCreateOpenTracked(false)}
        title={t('editor.newTitle')}
        createLabel={t('workflows.createButton')}
        nameLabel={t('editor.fieldName')}
        nameHint={t('workflows.fieldNameHint')}
        descriptionLabel={t('editor.fieldDescription')}
        name={createName}
        onNameChange={setCreateName}
        description={createDescription}
        onDescriptionChange={setCreateDescription}
        nameError={
          createName !== '' && !builtCreate.ok && builtCreate.errors.name !== undefined
            ? t(builtCreate.errors.name)
            : undefined
        }
        canCreate={builtCreate.ok}
        pending={create.isPending}
        submitError={
          create.error !== null && create.error !== undefined
            ? describeApiError(create.error)
            : undefined
        }
        onCreate={() => {
          if (builtCreate.ok) create.mutate(builtCreate.payload)
        }}
        triggerRef={createTriggerRef}
        testidPrefix="workflow"
      />
      <WorkflowImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImport={importWorkflow}
        triggerRef={importTriggerRef}
      />
    </ResourceGalleryPage>
  )
}

/** Exported for tests — hand-rolled fetch (text/yaml body + query param), so
 *  it must share the api client's FLAT/nested error decoding. */
export async function postYaml(yaml: string, onConflict: WorkflowImportMode): Promise<void> {
  const base = getBaseUrl()
  const token = getToken()
  const url = new URL('/api/workflows/import', base)
  url.searchParams.set('onConflict', onConflict)
  const headers: Record<string, string> = { 'content-type': 'text/yaml' }
  if (token !== null) headers.Authorization = `Bearer ${token}`
  const res = await fetch(url.toString(), { method: 'POST', headers, body: yaml })
  if (!res.ok) {
    // Shared decoder: the daemon emits FLAT {ok:false, code, message} — the
    // old nested-only parse here degraded every import failure (including
    // the 409 conflict that drives the overwrite/new prompt) to `http-<n>`.
    const err = extractErrorBody(await res.json().catch(() => null), res)
    throw new ApiError(res.status, err.code, err.message, err.details)
  }
}
