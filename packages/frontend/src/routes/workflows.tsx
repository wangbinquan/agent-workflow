// Workflows list. Each row links into the xyflow editor at /workflows/$id.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Workflow } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { getBaseUrl, getToken } from '@/stores/auth'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workflows',
  component: WorkflowsPage,
})

function WorkflowsPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery<Workflow[]>({
    queryKey: ['workflows'],
    queryFn: ({ signal }) => api.get('/api/workflows', undefined, signal),
  })

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/api/workflows/${encodeURIComponent(id)}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflows'] }),
  })

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
          <p className="page__hint">{t('workflows.hint')}</p>
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
          <Link to="/workflows/new" className="btn btn--primary">
            {t('workflows.newButton')}
          </Link>
        </div>
      </header>
      {importMsg !== null && <div className="info-box info-box--muted">{importMsg}</div>}

      {isLoading && <div className="muted">{t('common.loading')}</div>}
      {error !== null && error !== undefined && <ErrorBanner error={error} />}
      {del.error !== null && <ErrorBanner error={del.error} />}

      {!isLoading && data !== undefined && data.length === 0 && (
        <div className="muted">{t('workflows.emptyList')}</div>
      )}

      {data !== undefined && data.length > 0 && (
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('workflows.colName')}</th>
              <th>{t('workflows.colVersion')}</th>
              <th>{t('workflows.colId')}</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {data.map((w) => (
              <tr key={w.id}>
                <td>
                  <Link to="/workflows/$id" params={{ id: w.id }} className="data-table__link">
                    {w.name}
                  </Link>
                </td>
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
                    onConfirm={() => del.mutateAsync(w.id)}
                    danger
                    disabled={del.isPending}
                    size="sm"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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

function ErrorBanner({ error }: { error: unknown }) {
  const { t } = useTranslation()
  let msg = t('common.unknownError')
  if (error instanceof ApiError) msg = `${error.code}: ${error.message}`
  else if (error instanceof Error) msg = error.message
  return <div className="error-box">⚠ {msg}</div>
}
