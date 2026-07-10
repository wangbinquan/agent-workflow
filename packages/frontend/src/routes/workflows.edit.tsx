// Workflow editor route — /workflows/$id. Creation happens in the /workflows
// list page's quick-create dialog (RFC-164 workgroup pattern); the editor owns
// every detail edit of the (initially empty) definition.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent, Workflow, WorkflowDefinition } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { getBaseUrl, getToken } from '@/stores/auth'
import { EditorSidebar } from '@/components/canvas/EditorSidebar'
import { EdgeInspector } from '@/components/canvas/EdgeInspector'
import { NodeInspector } from '@/components/canvas/NodeInspector'
import { healFieldEdgeConsistency } from '@/components/canvas/connectionSync'
import { syncInputDefs } from '@/components/canvas/syncInputDefs'
import { clearWrapperSize } from '@/components/canvas/wrapperOps'
import { WorkflowCanvas, type WorkflowCanvasHandle } from '@/components/canvas/WorkflowCanvas'
import type { CanvasSelection } from '@/components/canvas/nodes/types'
import { workflowRenameError } from '@/lib/workflow-form'
import { AclDialogButton } from '@/components/AclPanel'
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

/**
 * Class list for the editor's grid container. The `--with-inspector`
 * variant locks a 480px third column for the inspector drawer; we only
 * apply it when a node is actually selected, otherwise the empty grid
 * track squeezes the canvas down to ~0px on narrow viewports.
 *
 * Exported for unit testing — see tests/canvas-editor-layout.test.ts.
 */
export function editorLayoutClass(selectedNodeId: string | null): string {
  return selectedNodeId !== null ? 'editor-layout editor-layout--with-inspector' : 'editor-layout'
}

/**
 * RFC-004: heal old workflow definitions on editor load. Pre-RFC the editor
 * never registered input-node inputKeys in `definition.inputs[]`, leaving
 * launcher forms empty. Running this once on load surfaces the correct
 * inputs[] back into the draft; the existing 1s auto-save then writes it
 * back to the daemon. No backend migration needed.
 *
 * RFC-007: also reconcile review.inputSource / output.ports[].bind against
 * the canvas edges. Pre-RFC-007 these were authored only through the form;
 * opening such a workflow once materializes the visual edges (and writes
 * back fields for YAML-imported edges that lacked field values). Both
 * passes return the input reference unchanged when there's nothing to fix,
 * so the auto-save useEffect only fires when work was actually done.
 *
 * Exported pure for testing — see tests/canvas-edit-old-workflow.test.tsx.
 */
export function healLoadedDefinition(def: WorkflowDefinition): WorkflowDefinition {
  const synced = syncInputDefs(def.inputs ?? [], def.nodes)
  const afterInputs =
    synced === (def.inputs ?? []) ? def : ({ ...def, inputs: synced } as WorkflowDefinition)
  return healFieldEdgeConsistency(afterInputs)
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
  const [selection, setSelection] = useState<CanvasSelection | null>(null)
  const selectedNodeId = selection?.kind === 'node' ? selection.id : null
  const selectedEdge =
    selection?.kind === 'edge' && draft !== null
      ? (draft.edges.find((e) => e.id === selection.id) ?? null)
      : null
  const canvasRef = useRef<WorkflowCanvasHandle | null>(null)
  const closeInspector = () => {
    canvasRef.current?.clearSelection()
    setSelection(null)
  }
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
    // RFC-004: pre-flight heal so old workflows whose inputs[] never got
    // populated by the editor regain working launcher fields on the next
    // auto-save (no backend migration; opening the workflow once fixes it).
    const healed = healLoadedDefinition(query.data.definition)
    setDraft(healed)
    setName(query.data.name)
    setDescription(query.data.description)
    setDirty(healed !== query.data.definition)
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
      api.post<{ ok: boolean; issues: ValidationIssue[] }>(
        `/api/workflows/${encodeURIComponent(id)}/validate`,
      ),
  })

  // 2026-07-10 naming unification: renames follow the workgroup slug rules.
  // An UNCHANGED (possibly legacy free-form) name never blocks — only an
  // actual rename to an invalid value parks auto-save with a field error.
  const renameError = workflowRenameError(name, lastSaved.current?.name ?? name)

  // Auto-save when the user pauses for >1s after a change (design.md §4.1).
  useEffect(() => {
    if (!dirty || draft === null) return
    if (workflowRenameError(name, lastSaved.current?.name ?? name) !== null) return
    const tt = setTimeout(() => save.mutate(), 1000)
    return () => clearTimeout(tt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, name, description, draft])

  // Toast banner state for remote workflow deletion. Remote *update*
  // notifications used to surface a toast here too, but they fired on
  // every auto-save's own WS echo (the broadcaster re-delivers our save
  // back to us as a "remote" update). Re-fetch handling already updates
  // the view via react-query; suppress the noisy toast and keep the
  // delete-elsewhere signal which is genuinely user-actionable.
  const [remoteToast, setRemoteToast] = useState<string | null>(null)
  useWorkflowSync({
    workflowId: id,
    currentVersion: query.data?.version ?? null,
    onRemoteDelete: () => setRemoteToast(t('editor.remoteDeleted')),
  })

  const headerActions = useMemo(
    () => (
      <div className="page__actions">
        {/* RFC parity with backend startTask: run static validation on
            click; only navigate to the launcher if there are no
            error-severity issues. Warnings still let the user through. */}
        <button
          type="button"
          className="btn btn--sm btn--primary"
          onClick={() => {
            validate
              .mutateAsync()
              .then((result) => {
                const hasBlocking = result.issues.some((i) => (i.severity ?? 'error') === 'error')
                if (hasBlocking) return
                navigate({ to: '/tasks/new', search: { kind: 'workflow', workflow: id } })
              })
              .catch(() => {
                /* network/server error already surfaced via validate.error */
              })
          }}
          disabled={validate.isPending}
        >
          {validate.isPending ? t('editor.validating') : t('editor.launch')}
        </button>
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
        <AclDialogButton
          resourceBaseUrl={`/api/workflows/${encodeURIComponent(id)}`}
          invalidateKey={['workflows']}
          size="sm"
        />
        <ConfirmButton
          label={t('common.delete')}
          onConfirm={() => del.mutateAsync()}
          variant="danger"
          disabled={del.isPending}
          size="sm"
        />
      </div>
    ),
    [id, navigate, validate, del, t],
  )

  // Error must win over the draft===null loading guard: a failed GET (bad id,
  // deleted workflow, expired bookmark) never populates the draft, and the
  // old order left the page on the loading state forever.
  if (query.error !== null && query.error !== undefined)
    return <div className="page error-box">{describeError(query.error)}</div>
  if (query.isLoading || draft === null)
    return <div className="page muted">{t('editor.loadingWorkflow')}</div>

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
        <Field
          label={t('editor.fieldName')}
          required
          error={renameError !== null ? t(renameError) : undefined}
        >
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
        <ValidationPanel
          result={validate.data}
          onAutoFitWrapper={(wrapperId) => {
            // RFC-016: inline Auto-fit clears wrapper.size so the next render
            // recomputes the bbox from current inner-node positions.
            const next = clearWrapperSize(draft, wrapperId)
            if (next === draft) return
            setDraft(next)
            setDirty(true)
          }}
        />
      )}

      <div className={editorLayoutClass(selection?.id ?? null)}>
        <EditorSidebar agents={agents.data ?? []} />
        <div className="canvas-frame">
          <WorkflowCanvas
            ref={canvasRef}
            definition={draft}
            agents={agents.data ?? []}
            onSelect={setSelection}
            onChange={(next) => {
              setDraft(next)
              setDirty(true)
            }}
          />
        </div>
        {selectedEdge !== null ? (
          <EdgeInspector
            edge={selectedEdge}
            definition={draft}
            onChange={(next) => {
              setDraft(next)
              setDirty(true)
            }}
            onClose={closeInspector}
          />
        ) : (
          <NodeInspector
            definition={draft}
            selectedNodeId={selectedNodeId}
            agents={agents.data ?? []}
            onChange={(next) => {
              setDraft(next)
              setDirty(true)
            }}
            onClose={closeInspector}
          />
        )}
      </div>
    </div>
  )
}

interface ValidationIssue {
  code: string
  message: string
  severity?: 'error' | 'warning'
  /** Pointer into the definition (e.g. wrapper id). Used by RFC-016
   * Auto-fit inline action to know which wrapper to reset. */
  pointer?: string
}

/**
 * RFC-004 added a `severity` field to ValidationIssue. The default ('error')
 * stays blocking; only entries explicitly tagged 'warning' fall into the
 * non-blocking bucket. Exported pure for testing.
 */
export function partitionIssues(issues: ValidationIssue[]): {
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
} {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []
  for (const i of issues) {
    if (i.severity === 'warning') warnings.push(i)
    else errors.push(i)
  }
  return { errors, warnings }
}

function ValidationPanel({
  result,
  onAutoFitWrapper,
}: {
  result: { ok: boolean; issues: ValidationIssue[] }
  onAutoFitWrapper?: (wrapperId: string) => void
}) {
  const { t } = useTranslation()
  const { errors, warnings } = partitionIssues(result.issues)
  return (
    <div>
      {errors.length === 0 ? (
        <div className="validation-panel validation-panel--ok">{t('editor.validationOk')}</div>
      ) : (
        <div className="validation-panel validation-panel--bad">
          <div className="validation-panel__title">
            {t('editor.validationIssues', { n: errors.length })}
          </div>
          <ul>
            {errors.map((i, idx) => (
              <li key={`e-${idx}`}>
                <code>{i.code}</code> — {i.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="validation-panel validation-panel--warn">
          <div className="validation-panel__title">
            {t('editor.validationWarnings', { n: warnings.length })}
          </div>
          <ul>
            {warnings.map((i, idx) => (
              <li key={`w-${idx}`}>
                <code>{i.code}</code> — {i.message}
                {i.code === 'wrapper-children-outside-bounds' &&
                i.pointer !== undefined &&
                onAutoFitWrapper !== undefined ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="validation-panel__action"
                      onClick={() => onAutoFitWrapper(i.pointer as string)}
                    >
                      {t('editor.validationAutoFitWrapper')}
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}
