// Workflow editor route — handles both /workflows/new and /workflows/$id.
// M2 scope: pan/zoom canvas with delete-key removal. Sidebar drag-create
// arrives in P-2-05; per-kind node renderers in P-2-04.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent, Workflow, WorkflowDefinition } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { getBaseUrl, getToken } from '@/stores/auth'
import { EditorSidebar } from '@/components/canvas/EditorSidebar'
import { NodeInspector } from '@/components/canvas/NodeInspector'
import { WorkflowCanvas } from '@/components/canvas/WorkflowCanvas'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Field, TextInput } from '@/components/Form'
import { useWorkflowSync } from '@/hooks/useWorkflowSync'
import { Route as RootRoute } from './__root'

function exportUrl(id: string): string {
  const base = getBaseUrl()
  const token = getToken()
  const url = new URL(`/api/workflows/${encodeURIComponent(id)}/export`, base)
  if (token !== null) url.searchParams.set('token', token)
  return url.toString()
}

const EMPTY_DEF: WorkflowDefinition = {
  $schema_version: 1,
  inputs: [],
  nodes: [],
  edges: [],
}

// /workflows/new ------------------------------------------------------------

export const NewRoute = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workflows/new',
  component: WorkflowNewPage,
})

function WorkflowNewPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [definition, setDefinition] = useState<WorkflowDefinition>(EMPTY_DEF)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const agents = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: ({ signal }) => api.get('/api/agents', undefined, signal),
  })

  const create = useMutation({
    mutationFn: () => api.post<Workflow>('/api/workflows', { name, description, definition }),
    onSuccess: (wf) => {
      void qc.invalidateQueries({ queryKey: ['workflows'] })
      navigate({ to: '/workflows/$id', params: { id: wf.id } })
    },
  })

  return (
    <div className="page page--editor">
      <header className="page__header page__header--row">
        <div>
          <h1>{t('editor.newTitle')}</h1>
          <p className="page__hint">{t('editor.newHint')}</p>
        </div>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => create.mutate()}
          disabled={name === '' || create.isPending}
        >
          {create.isPending ? t('editor.creating') : t('editor.create')}
        </button>
      </header>
      <div className="form-grid form-grid--cols-2">
        <Field label={t('editor.fieldName')} required>
          <TextInput value={name} onChange={setName} required />
        </Field>
        <Field label={t('editor.fieldDescription')}>
          <TextInput value={description} onChange={setDescription} />
        </Field>
      </div>
      {create.error !== null && create.error !== undefined && (
        <div className="error-box">{describeError(create.error)}</div>
      )}
      <div className="editor-layout editor-layout--with-inspector">
        <EditorSidebar agents={agents.data ?? []} />
        <div className="canvas-frame">
          <WorkflowCanvas
            definition={definition}
            onChange={setDefinition}
            onSelect={setSelectedId}
            agents={agents.data ?? []}
          />
        </div>
        <NodeInspector
          definition={definition}
          selectedNodeId={selectedId}
          agents={agents.data ?? []}
          onChange={setDefinition}
          onClose={() => setSelectedId(null)}
        />
      </div>
    </div>
  )
}

// /workflows/$id ------------------------------------------------------------

export const EditRoute = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workflows/$id',
  component: WorkflowEditPage,
})

function WorkflowEditPage() {
  const { t } = useTranslation()
  const { id } = EditRoute.useParams()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [draft, setDraft] = useState<WorkflowDefinition | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [dirty, setDirty] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const lastSaved = useRef<{
    name: string
    description: string
    definition: WorkflowDefinition
  } | null>(null)

  const query = useQuery<Workflow>({
    queryKey: ['workflows', id],
    queryFn: ({ signal }) => api.get(`/api/workflows/${encodeURIComponent(id)}`, undefined, signal),
  })
  const agents = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: ({ signal }) => api.get('/api/agents', undefined, signal),
  })

  useEffect(() => {
    if (query.data === undefined) return
    if (lastSaved.current?.definition === query.data.definition) return
    setDraft(query.data.definition)
    setName(query.data.name)
    setDescription(query.data.description)
    setDirty(false)
    lastSaved.current = {
      name: query.data.name,
      description: query.data.description,
      definition: query.data.definition,
    }
  }, [query.data])

  const save = useMutation({
    mutationFn: () => {
      if (draft === null) throw new Error('nothing to save')
      return api.put<Workflow>(`/api/workflows/${encodeURIComponent(id)}`, {
        name,
        description,
        definition: draft,
      })
    },
    onSuccess: (wf) => {
      qc.setQueryData(['workflows', id], wf)
      void qc.invalidateQueries({ queryKey: ['workflows'] })
      lastSaved.current = { name: wf.name, description: wf.description, definition: wf.definition }
      setDirty(false)
    },
  })

  const del = useMutation({
    mutationFn: () => api.delete(`/api/workflows/${encodeURIComponent(id)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workflows'] })
      navigate({ to: '/workflows' })
    },
  })

  const validate = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; issues: Array<{ code: string; message: string }> }>(
        `/api/workflows/${encodeURIComponent(id)}/validate`,
      ),
  })

  // Auto-save when the user pauses for >1s after a change (design.md §4.1).
  useEffect(() => {
    if (!dirty || draft === null) return
    const tt = setTimeout(() => save.mutate(), 1000)
    return () => clearTimeout(tt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, name, description, draft])

  // Toast banner state for remote edits (other tabs / clients).
  const [remoteToast, setRemoteToast] = useState<string | null>(null)
  useWorkflowSync({
    workflowId: id,
    currentVersion: query.data?.version ?? null,
    onRemoteUpdate: (v) => setRemoteToast(t('editor.remoteUpdated', { version: v })),
    onRemoteDelete: () => setRemoteToast(t('editor.remoteDeleted')),
  })

  const headerActions = useMemo(
    () => (
      <div className="page__actions">
        <Link to="/workflows/$id/launch" params={{ id }} className="btn btn--sm btn--primary">
          {t('editor.launch')}
        </Link>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => validate.mutate()}
          disabled={validate.isPending}
        >
          {validate.isPending ? t('editor.validating') : t('editor.validate')}
        </button>
        <a
          href={exportUrl(id)}
          target="_blank"
          rel="noreferrer"
          className="btn btn--sm"
          title={t('editor.exportTitle')}
        >
          {t('editor.exportYaml')}
        </a>
        <ConfirmButton
          label={t('common.delete')}
          onConfirm={() => del.mutateAsync()}
          danger
          disabled={del.isPending}
        />
      </div>
    ),
    [id, validate, del, t],
  )

  if (query.isLoading || draft === null)
    return <div className="page muted">{t('editor.loadingWorkflow')}</div>
  if (query.error !== null && query.error !== undefined)
    return <div className="page error-box">{describeError(query.error)}</div>

  return (
    <div className="page page--editor">
      <header className="page__header page__header--row">
        <div>
          <h1>{name || id}</h1>
          <p className="page__hint">
            <code>{id}</code> · v{query.data?.version ?? '?'} ·{' '}
            {dirty
              ? save.isPending
                ? t('editor.statusSaving')
                : t('editor.statusUnsaved')
              : t('editor.statusSaved')}
          </p>
        </div>
        {headerActions}
      </header>

      <div className="form-grid form-grid--cols-2">
        <Field label={t('editor.fieldName')} required>
          <TextInput
            value={name}
            onChange={(v) => {
              setName(v)
              setDirty(true)
            }}
            required
          />
        </Field>
        <Field label={t('editor.fieldDescription')}>
          <TextInput
            value={description}
            onChange={(v) => {
              setDescription(v)
              setDirty(true)
            }}
          />
        </Field>
      </div>

      {save.error !== null && save.error !== undefined && (
        <div className="error-box">{describeError(save.error)}</div>
      )}
      {remoteToast !== null && (
        <div className="info-box">
          {remoteToast}{' '}
          <button type="button" className="info-box__action" onClick={() => setRemoteToast(null)}>
            {t('editor.remoteDismiss')}
          </button>
        </div>
      )}
      {validate.data !== undefined && validate.error === null && (
        <ValidationPanel result={validate.data} />
      )}

      <div className="editor-layout editor-layout--with-inspector">
        <EditorSidebar agents={agents.data ?? []} />
        <div className="canvas-frame">
          <WorkflowCanvas
            definition={draft}
            agents={agents.data ?? []}
            onSelect={setSelectedId}
            onChange={(next) => {
              setDraft(next)
              setDirty(true)
            }}
          />
        </div>
        <NodeInspector
          definition={draft}
          selectedNodeId={selectedId}
          agents={agents.data ?? []}
          onChange={(next) => {
            setDraft(next)
            setDirty(true)
          }}
          onClose={() => setSelectedId(null)}
        />
      </div>
    </div>
  )
}

function ValidationPanel({
  result,
}: {
  result: { ok: boolean; issues: Array<{ code: string; message: string }> }
}) {
  const { t } = useTranslation()
  if (result.ok) {
    return <div className="validation-panel validation-panel--ok">{t('editor.validationOk')}</div>
  }
  return (
    <div className="validation-panel validation-panel--bad">
      <div className="validation-panel__title">
        {t('editor.validationIssues', { n: result.issues.length })}
      </div>
      <ul>
        {result.issues.map((i, idx) => (
          <li key={idx}>
            <code>{i.code}</code> — {i.message}
          </li>
        ))}
      </ul>
    </div>
  )
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}
