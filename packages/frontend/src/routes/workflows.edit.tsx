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
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { RenameDialog } from '@/components/RenameDialog'
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
  const loadedWorkflowIdRef = useRef<string | null>(null)

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
    loadedWorkflowIdRef.current = id
  }, [id, query.data])

  // Name + description are edited ONLY through the rename dialog now (用户
  // 2026-07-13「把名称和描述修改收到重命名按钮内」); the canvas still
  // auto-saves the definition. Both channels PUT the same shape and settle the
  // same way (applySaved), so the header <h1> and the rename baseline stay in
  // sync no matter which one wrote.
  function putWorkflow(meta: { name: string; description: string }): Promise<Workflow> {
    if (draft === null) throw new Error('nothing to save')
    return api.put<Workflow>(`/api/workflows/${encodeURIComponent(id)}`, {
      name: meta.name,
      description: meta.description,
      definition: draft,
    })
  }
  function applySaved(wf: Workflow): void {
    qc.setQueryData(['workflows', id], wf)
    void qc.invalidateQueries({ queryKey: ['workflows'] })
    // Point the header + rename baseline at server truth. For an auto-save
    // these equal the current values (no-op); for a rename they adopt the new
    // name/description.
    setName(wf.name)
    setDescription(wf.description)
    lastSaved.current = { name: wf.name, description: wf.description, definition: wf.definition }
    setDirty(false)
  }

  // Auto-save channel — carries the CURRENT (last-saved) name/description
  // through unchanged alongside the edited definition.
  const save = useMutation({
    mutationFn: () => putWorkflow({ name, description }),
    onSuccess: applySaved,
  })

  // Rename dialog channel — the explicit name/description edit.
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameName, setRenameName] = useState('')
  const [renameDescription, setRenameDescription] = useState('')
  const renameTriggerRef = useRef<HTMLButtonElement | null>(null)
  const renameSave = useMutation({
    mutationFn: (meta: { name: string; description: string }) => putWorkflow(meta),
    onSuccess: (wf) => {
      applySaved(wf)
      setRenameOpen(false)
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
  // actual rename to an invalid value gates the dialog Save. `name` /
  // `description` are the last-saved baseline (they only change via a save), so
  // the dialog diffs against them directly; the same verdict drives BOTH the
  // inline name error and the Save button (grandfather preserved).
  const renameFieldError = workflowRenameError(renameName, name)
  const renameCanSave =
    renameFieldError === null && (renameName !== name || renameDescription !== description)

  // Auto-save when the user pauses for >1s after a canvas change (design.md
  // §4.1). name/description no longer change outside the rename dialog, so the
  // definition draft is the only auto-saved surface (the dialog owns name
  // validation, so the old rename guard here is gone).
  useEffect(() => {
    if (!dirty || draft === null) return
    const tt = setTimeout(() => save.mutate(), 1000)
    return () => clearTimeout(tt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, draft])

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
      <>
        {/* RFC parity with backend startTask: run static validation on
            click; only navigate to the launcher if there are no
            error-severity issues. Warnings still let the user through. */}
        <button
          type="button"
          className="btn btn--primary"
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
        {/* Name + description live behind this button (工作组同款重命名入口).
            Seed from lastSaved (a stable ref) so this memoized action never
            captures a stale name/description. */}
        <button
          type="button"
          className="btn btn--sm"
          ref={renameTriggerRef}
          onClick={() => {
            const cur = lastSaved.current
            if (cur !== null) {
              setRenameName(cur.name)
              setRenameDescription(cur.description)
            }
            setRenameOpen(true)
          }}
          data-testid="workflow-rename-button"
        >
          {t('editor.renameButton')}
        </button>
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
      </>
    ),
    [id, navigate, validate, del, t],
  )

  // Only an initial load failure owns the whole page. A background refetch can
  // fail while the editor holds an unsaved draft; keep that draft mounted and
  // surface the failure inline instead of replacing the canvas. The loaded id
  // guard also prevents a same-route id change from flashing the prior draft.
  if (draft === null || loadedWorkflowIdRef.current !== id) {
    if (query.error !== null && query.error !== undefined) {
      return (
        <div className="page">
          <PageHeader title={id} />
          <ErrorBanner
            error={query.error}
            action={
              <button type="button" className="btn btn--sm" onClick={() => void query.refetch()}>
                {t('common.retry')}
              </button>
            }
          />
        </div>
      )
    }
    return (
      <div className="page">
        <PageHeader title={id} />
        <LoadingState label={t('editor.loadingWorkflow')} />
      </div>
    )
  }

  return (
    <div className="page page--editor">
      <PageHeader
        title={name || id}
        meta={
          <>
            <code>{id}</code> · v{query.data?.version ?? '?'} ·{' '}
            {dirty
              ? save.isPending
                ? t('editor.statusSaving')
                : t('editor.statusUnsaved')
              : t('editor.statusSaved')}
          </>
        }
        actions={headerActions}
      />

      {query.error !== null && query.error !== undefined && (
        <ErrorBanner
          error={query.error}
          action={
            <button type="button" className="btn btn--sm" onClick={() => void query.refetch()}>
              {t('common.retry')}
            </button>
          }
        />
      )}
      {save.error !== null && save.error !== undefined && <ErrorBanner error={save.error} />}
      {validate.error !== null && validate.error !== undefined && (
        <ErrorBanner error={validate.error} />
      )}
      {agents.error !== null && agents.error !== undefined && <ErrorBanner error={agents.error} />}
      {remoteToast !== null && (
        <NoticeBanner
          tone="info"
          size="compact"
          action={
            <button type="button" className="btn btn--sm" onClick={() => setRemoteToast(null)}>
              {t('editor.remoteDismiss')}
            </button>
          }
        >
          {remoteToast}
        </NoticeBanner>
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
        <EditorSidebar
          agents={agents.data ?? []}
          onAdd={(item) => canvasRef.current?.addPaletteItemAtViewportCenter(item)}
        />
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

      <RenameDialog
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        title={t('editor.renameTitle')}
        testidPrefix="workflow"
        nameLabel={t('editor.fieldName')}
        nameHint={t('workflows.fieldNameHint')}
        name={renameName}
        onNameChange={setRenameName}
        nameError={renameFieldError !== null ? t(renameFieldError) : undefined}
        descriptionLabel={t('editor.fieldDescription')}
        description={renameDescription}
        onDescriptionChange={setRenameDescription}
        canSave={renameCanSave}
        pending={renameSave.isPending}
        submitError={
          renameSave.error !== null && renameSave.error !== undefined
            ? describeError(renameSave.error)
            : undefined
        }
        onSave={() => renameSave.mutate({ name: renameName, description: renameDescription })}
        triggerRef={renameTriggerRef}
      />
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
