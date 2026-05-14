// Workflow editor route — handles both /workflows/new and /workflows/$id.
// M2 scope: pan/zoom canvas with delete-key removal. Sidebar drag-create
// arrives in P-2-05; per-kind node renderers in P-2-04.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Workflow, WorkflowDefinition } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { WorkflowCanvas } from '@/components/canvas/WorkflowCanvas'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Field, TextInput } from '@/components/Form'
import { Route as RootRoute } from './__root'

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
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [definition, setDefinition] = useState<WorkflowDefinition>(EMPTY_DEF)

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
          <h1>New workflow</h1>
          <p className="page__hint">Drag-create from the sidebar arrives in P-2-05.</p>
        </div>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => create.mutate()}
          disabled={name === '' || create.isPending}
        >
          {create.isPending ? 'Creating…' : 'Create'}
        </button>
      </header>
      <div className="form-grid form-grid--cols-2">
        <Field label="Name" required>
          <TextInput value={name} onChange={setName} required />
        </Field>
        <Field label="Description">
          <TextInput value={description} onChange={setDescription} />
        </Field>
      </div>
      {create.error !== null && create.error !== undefined && (
        <div className="error-box">{describeError(create.error)}</div>
      )}
      <div className="canvas-frame">
        <WorkflowCanvas definition={definition} onChange={setDefinition} />
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
  const { id } = EditRoute.useParams()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [draft, setDraft] = useState<WorkflowDefinition | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [dirty, setDirty] = useState(false)
  const lastSaved = useRef<{
    name: string
    description: string
    definition: WorkflowDefinition
  } | null>(null)

  const query = useQuery<Workflow>({
    queryKey: ['workflows', id],
    queryFn: ({ signal }) => api.get(`/api/workflows/${encodeURIComponent(id)}`, undefined, signal),
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

  // Auto-save when the user pauses for >800ms after a change.
  useEffect(() => {
    if (!dirty || draft === null) return
    const t = setTimeout(() => save.mutate(), 800)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, name, description, draft])

  const headerActions = useMemo(
    () => (
      <div className="page__actions">
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => validate.mutate()}
          disabled={validate.isPending}
        >
          {validate.isPending ? 'Validating…' : 'Validate'}
        </button>
        <ConfirmButton
          label="Delete"
          onConfirm={() => del.mutateAsync()}
          danger
          disabled={del.isPending}
        />
      </div>
    ),
    [validate, del],
  )

  if (query.isLoading || draft === null) return <div className="page muted">Loading workflow…</div>
  if (query.error !== null && query.error !== undefined)
    return <div className="page error-box">{describeError(query.error)}</div>

  return (
    <div className="page page--editor">
      <header className="page__header page__header--row">
        <div>
          <h1>{name || id}</h1>
          <p className="page__hint">
            <code>{id}</code> · v{query.data?.version ?? '?'} ·{' '}
            {dirty ? (save.isPending ? 'saving…' : 'unsaved') : 'saved'}
          </p>
        </div>
        {headerActions}
      </header>

      <div className="form-grid form-grid--cols-2">
        <Field label="Name" required>
          <TextInput
            value={name}
            onChange={(v) => {
              setName(v)
              setDirty(true)
            }}
            required
          />
        </Field>
        <Field label="Description">
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
      {validate.data !== undefined && validate.error === null && (
        <ValidationPanel result={validate.data} />
      )}

      <div className="canvas-frame">
        <WorkflowCanvas
          definition={draft}
          onChange={(next) => {
            setDraft(next)
            setDirty(true)
          }}
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
  if (result.ok) {
    return <div className="validation-panel validation-panel--ok">✓ valid</div>
  }
  return (
    <div className="validation-panel validation-panel--bad">
      <div className="validation-panel__title">{result.issues.length} issue(s)</div>
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
