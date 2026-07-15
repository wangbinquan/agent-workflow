// Workflows list — RFC-191 card gallery. Each card opens the xyflow editor
// at /workflows/$id (whole card = stretched link);「启动」deep-links the task
// wizard with the workflow preselected. Creation stays the QUICK-CREATE
// dialog (name + description only — the definition starts empty; all canvas
// editing happens on the editor page), mirroring the RFC-164 pattern.
// Delete / export live in the EDITOR header (RFC-191: no list-level delete).

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CreateWorkflow, Workflow } from '@agent-workflow/shared'
import { api, ApiError, extractErrorBody } from '@/api/client'
import { useResourceList } from '@/hooks/useResourceList'
import { describeApiError } from '@/i18n'
import { getBaseUrl, getToken } from '@/stores/auth'
import { QuickCreateDialog } from '@/components/QuickCreateDialog'
import { ResourceBadges } from '@/components/ResourceBadges'
import { ResourceGalleryPage, type GalleryCardItem } from '@/components/gallery/ResourceGalleryPage'
import { buildQuickCreateWorkflowPayload } from '@/lib/workflow-form'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workflows',
  component: WorkflowsPage,
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
  function setCreateOpenTracked(open: boolean): void {
    createOpenRef.current = open
    setCreateOpen(open)
  }
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

  function openCreate(): void {
    setCreateName('')
    setCreateDescription('')
    create.reset()
    setCreateOpenTracked(true)
  }

  const fileRef = useRef<HTMLInputElement | null>(null)
  const [importMsg, setImportMsg] = useState<string | null>(null)
  async function handleImport(file: File) {
    setImportMsg(null)
    const yaml = await file.text()
    try {
      await postYaml(yaml, 'fail')
      setImportMsg(t('workflows.importedAsNew'))
      void qc.invalidateQueries({ queryKey: ['workflows'] })
    } catch (err) {
      if (err instanceof ApiError && err.code === 'workflow-import-conflict') {
        const choice = window.prompt(t('workflows.conflictPrompt'), 'new')
        if (choice === 'overwrite' || choice === 'new') {
          await postYaml(yaml, choice)
          setImportMsg(
            choice === 'overwrite'
              ? t('workflows.workflowOverwritten')
              : t('workflows.importedAsNew'),
          )
          void qc.invalidateQueries({ queryKey: ['workflows'] })
        } else {
          setImportMsg(t('workflows.importCanceled'))
        }
      } else {
        // describeApiError maps coded failures (e.g. workflow-name-invalid on
        // a legacy free-form name) to the localized remediation text.
        setImportMsg(describeApiError(err))
      }
    }
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
              title: w.name,
              subtitle: w.description === '' ? undefined : w.description,
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
                  <span className="chip chip--tight">v{w.version}</span>
                  <span className="chip chip--tight">
                    {t('workflows.cardNodes', { n: w.definition.nodes.length })}
                  </span>
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

  return (
    <ResourceGalleryPage
      title={t('workflows.title')}
      headerActions={
        <>
          <input
            ref={fileRef}
            type="file"
            accept=".yaml,.yml,application/yaml,text/yaml"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleImport(file)
              e.target.value = ''
            }}
          />
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
            {t('workflows.importButton')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            ref={createTriggerRef}
            onClick={openCreate}
            data-testid="workflow-new-button"
          >
            {t('workflows.newButton')}
          </button>
        </>
      }
      notice={importMsg !== null && <div className="info-box info-box--muted">{importMsg}</div>}
      items={items}
      isLoading={isLoading}
      error={error}
      searchPlaceholder={t('common.searchEllipsis')}
      emptyListText={t('workflows.emptyList')}
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
    </ResourceGalleryPage>
  )
}

/** Exported for tests — hand-rolled fetch (text/yaml body + query param), so
 *  it must share the api client's FLAT/nested error decoding. */
export async function postYaml(
  yaml: string,
  onConflict: 'fail' | 'overwrite' | 'new',
): Promise<void> {
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
