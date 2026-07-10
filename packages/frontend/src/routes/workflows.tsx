// Workflows list. Each row links into the xyflow editor at /workflows/$id.
// Creation is a QUICK-CREATE dialog (name + description only — the definition
// starts empty; all canvas editing happens on the editor page). Mirrors the
// RFC-164 workgroup list-page pattern.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CreateWorkflow, Workflow } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { useResourceList } from '@/hooks/useResourceList'
import { describeApiError } from '@/i18n'
import { getBaseUrl, getToken } from '@/stores/auth'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { ResourceNameCell } from '@/components/ResourceNameCell'
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
  // RFC-151 PR-3 — shared list shell: query + delete mutation + owner lookup.
  // The YAML import flow below stays page-specific.
  const { data, isLoading, error, del, owners } = useResourceList<Workflow>({
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
  // response lands later (the row still appears via the list invalidation).
  const createOpenRef = useRef(false)
  function setCreateOpenTracked(open: boolean): void {
    createOpenRef.current = open
    setCreateOpen(open)
  }
  const create = useMutation({
    mutationFn: (body: CreateWorkflow): Promise<Workflow> => api.post('/api/workflows', body),
    onSuccess: (wf) => {
      void qc.invalidateQueries({ queryKey: ['workflows'] })
      qc.setQueryData(['workflows', wf.id], wf)
      if (!createOpenRef.current) return
      setCreateOpenTracked(false)
      navigate({ to: '/workflows/$id', params: { id: wf.id } })
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
        setImportMsg(err instanceof Error ? err.message : String(err))
      }
    }
  }

  return (
    <div className="page">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('workflows.title')}</h1>
        </div>
        <div className="page__actions">
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
        </div>
      </header>
      {importMsg !== null && <div className="info-box info-box--muted">{importMsg}</div>}

      {isLoading && <LoadingState data-testid="workflows-loading" />}
      {error !== null && error !== undefined && <ErrorBanner error={error} />}
      {del.error !== null && <ErrorBanner error={del.error} />}

      {!isLoading && data !== undefined && data.length === 0 && (
        <EmptyState title={t('workflows.emptyList')} data-testid="workflows-empty" />
      )}

      {data !== undefined && data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('workflows.colName')}</th>
              <th>{t('workflows.colVersion')}</th>
              <th>{t('workflows.colId')}</th>
              <th aria-label={t('common.ariaActions')} />
            </tr>
          </thead>
          <tbody>
            {data.map((w) => (
              <tr key={w.id}>
                {/* RFC-151 PR-3: the shared cell adds data-table__nowrap (the
                    other resource lists already had it) — long workflow names
                    now stay single-line like every sibling list. */}
                <ResourceNameCell
                  to="/workflows/$id"
                  params={{ id: w.id }}
                  name={w.name}
                  visibility={w.visibility}
                  ownerUserId={w.ownerUserId}
                  owners={owners}
                />
                <td className="data-table__muted">v{w.version}</td>
                <td className="data-table__muted">
                  <code>{w.id}</code>
                </td>
                <td className="data-table__actions">
                  <Link to="/workflows/$id" params={{ id: w.id }} className="btn btn--sm">
                    {t('common.open')}
                  </Link>
                  <ConfirmButton
                    label={t('common.delete')}
                    onConfirm={() => del.mutateAsync(w)}
                    variant="danger"
                    disabled={del.isPending}
                    size="sm"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpenTracked(false)}
        title={t('editor.newTitle')}
        size="sm"
        triggerRef={createTriggerRef}
        data-testid="workflow-create-dialog"
        footer={
          <>
            {create.error !== null && create.error !== undefined && (
              <span className="form-actions__error">{describeApiError(create.error)}</span>
            )}
            <button type="button" className="btn" onClick={() => setCreateOpenTracked(false)}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={create.isPending || !builtCreate.ok}
              onClick={() => {
                if (builtCreate.ok) create.mutate(builtCreate.payload)
              }}
              data-testid="workflow-create-confirm"
            >
              {create.isPending ? t('editor.creating') : t('editor.create')}
            </button>
          </>
        }
      >
        {/* Required-ness is conveyed by the disabled Create button — a
            workflow name has no format rules, so there is no inline error. */}
        <Field label={t('editor.fieldName')} required>
          <TextInput
            value={createName}
            onChange={setCreateName}
            maxLength={256}
            required
            data-testid="workflow-create-name"
          />
        </Field>
        <Field label={t('editor.fieldDescription')}>
          <TextInput
            value={createDescription}
            onChange={setCreateDescription}
            data-testid="workflow-create-description"
          />
        </Field>
      </Dialog>
    </div>
  )
}

async function postYaml(yaml: string, onConflict: 'fail' | 'overwrite' | 'new'): Promise<void> {
  const base = getBaseUrl()
  const token = getToken()
  const url = new URL('/api/workflows/import', base)
  url.searchParams.set('onConflict', onConflict)
  const headers: Record<string, string> = { 'content-type': 'text/yaml' }
  if (token !== null) headers.Authorization = `Bearer ${token}`
  const res = await fetch(url.toString(), { method: 'POST', headers, body: yaml })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code: string; message: string }
    } | null
    const err = body?.error ?? {
      code: `http-${res.status}`,
      message: res.statusText || 'request failed',
    }
    throw new ApiError(res.status, err.code, err.message)
  }
}
