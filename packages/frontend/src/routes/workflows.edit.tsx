// Workflow editor route — /workflows/$id. Creation happens in the /workflows
// list page's quick-create dialog (RFC-164 workgroup pattern); the editor owns
// every detail edit of the (initially empty) definition.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  Agent,
  CreateWorkflow,
  Plugin,
  Skill,
  WorkflowDefinition,
  WorkflowDetail,
  WorkflowDraftSnapshot,
  WorkflowValidationIssue,
  WorkflowValidationReceipt,
} from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { describeApiError } from '@/i18n'
import { describeValidationIssue } from '@/i18n/errors'
import { EditorSidebar } from '@/components/canvas/EditorSidebar'
import { EdgeInspector } from '@/components/canvas/EdgeInspector'
import { NodeInspector } from '@/components/canvas/NodeInspector'
import type { InspectorChangeMeta } from '@/components/canvas/inspector/historyMeta'
import { healFieldEdgeConsistency } from '@/components/canvas/connectionSync'
import { syncInputDefs } from '@/components/canvas/syncInputDefs'
import { clearWrapperSize } from '@/components/canvas/wrapperOps'
import {
  WorkflowCanvas,
  type WorkflowCanvasChangeMeta,
  type WorkflowCanvasHandle,
} from '@/components/canvas/WorkflowCanvas'
import type { CanvasSelection } from '@/components/canvas/nodes/types'
import { workflowNameError, workflowRenameError } from '@/lib/workflow-form'
import { makeWorkflowDeleteRequest } from '@/lib/workflow-save-wire'
import {
  downloadWorkflowLocalDraft,
  downloadWorkflowServerExport,
} from '@/lib/workflow-draft-export'
import { isWorkflowDraftUnsafeToLeave } from '@/lib/workflow-editor-draft'
import { AclDialogButton } from '@/components/AclPanel'
import { ConfirmButton } from '@/components/ConfirmButton'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { QuickCreateDialog } from '@/components/QuickCreateDialog'
import { RenameDialog } from '@/components/RenameDialog'
import { UnsavedChangesGuard } from '@/components/split/UnsavedChangesGuard'
import { WorkflowDraftStatus } from '@/components/workflow-editor/WorkflowDraftStatus'
import {
  useWorkflowEditorDraft,
  WorkflowEnsureSavedError,
  type WorkflowSavedDraft,
} from '@/hooks/useWorkflowEditorDraft'
import { useWorkflowSync } from '@/hooks/useWorkflowSync'
import { Route as RootRoute } from './__root'

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

export function workflowDeleteConfirmationKey(
  workflowId: string,
  serverVersion: number | null,
  localRevision: number,
  dirty: boolean,
): string {
  return JSON.stringify([workflowId, serverVersion, localRevision, dirty])
}

interface WorkflowValidationBinding {
  localRevision: number
  inventorySignature: string
  receipt: WorkflowValidationReceipt
}

export type WorkflowValidationStaleReason = 'draft' | 'inventory' | null

/**
 * A secret-free observation key for the three resource inventories consumed
 * by backend validation. The backend receipt remains authoritative; this key
 * only makes an already-rendered result visibly stale when React Query later
 * observes a semantic inventory change.
 */
export function workflowValidationInventorySignature(
  agents: readonly Agent[] | undefined,
  skills: readonly Skill[] | undefined,
  plugins: readonly Plugin[] | undefined,
): string {
  return JSON.stringify({
    agents:
      agents
        ?.map((agent) => [agent.id, agent.name, agent.updatedAt] as const)
        .sort((left, right) => left[0].localeCompare(right[0])) ?? null,
    skills:
      skills
        ?.map((skill) => [skill.id, skill.name, skill.contentVersion, skill.updatedAt] as const)
        .sort((left, right) => left[0].localeCompare(right[0])) ?? null,
    plugins:
      plugins
        ?.map(
          (plugin) =>
            [
              plugin.id,
              plugin.name,
              plugin.enabled,
              plugin.resolvedVersion,
              plugin.updatedAt,
            ] as const,
        )
        .sort((left, right) => left[0].localeCompare(right[0])) ?? null,
  })
}

export function workflowValidationStaleReason(
  binding: WorkflowValidationBinding | null,
  current: {
    localRevision: number
    workflowVersion: number
    snapshotHash: string
    inventorySignature: string
  },
): WorkflowValidationStaleReason {
  if (binding === null) return null
  if (
    binding.localRevision !== current.localRevision ||
    binding.receipt.revision.version !== current.workflowVersion ||
    binding.receipt.revision.snapshotHash !== current.snapshotHash
  ) {
    return 'draft'
  }
  return binding.inventorySignature === current.inventorySignature ? null : 'inventory'
}

class WorkflowActionRevisionChangedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowActionRevisionChangedError'
  }
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
  const query = useQuery<WorkflowDetail>({
    queryKey: ['workflows', id],
    queryFn: ({ signal }) => api.get(`/api/workflows/${encodeURIComponent(id)}`, undefined, signal),
  })

  // The controller needs a real server revision to establish its first CAS
  // base. Never manufacture an initial snapshot from a healed/local draft.
  if (query.data === undefined) {
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
    <WorkflowEditorLoaded
      key={id}
      workflowId={id}
      initial={query.data}
      observedDetail={query.data}
      queryError={query.error}
      onRefetch={() => void query.refetch()}
    />
  )
}

export interface WorkflowEditorLoadedProps {
  workflowId: string
  /** Immutable first server detail; the component is keyed by workflow id. */
  initial: WorkflowDetail
  /** Latest React Query observation. It is reducer input, never local state. */
  observedDetail: WorkflowDetail
  queryError: unknown
  onRefetch: () => void
}

/**
 * RFC-199 B2 route adapter. The controller is the sole owner of editable
 * name/description/definition state and of every PUT. React Query and WS are
 * observations only; neither is allowed to assign the local draft directly.
 * Exported so the route/controller seam can be exercised with a real hook in
 * focused integration tests without booting the full application router.
 */
export function WorkflowEditorLoaded({
  workflowId,
  initial,
  observedDetail,
  queryError,
  onRefetch,
}: WorkflowEditorLoadedProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [connection, setConnection] = useState({ connected: false, connectionEpoch: 0 })
  const controller = useWorkflowEditorDraft({
    initial,
    connected: connection.connected,
    connectionEpoch: connection.connectionEpoch,
  })
  const sync = useWorkflowSync({
    workflowId,
    currentVersion: controller.state.serverRevision.version,
    inFlightMutationId: controller.inFlightMutationId,
    onFrame: controller.remoteFrame,
  })
  const syncConnected = sync.connected
  const syncConnectionEpoch = sync.connectionEpoch

  // useWorkflowSync needs the current controller callbacks/mutation id in the
  // same render, while the controller consumes the socket state on the next
  // render. This one-render projection avoids a circular hook dependency and
  // still turns every physical OPEN epoch into a reconciliation wake.
  useEffect(() => {
    setConnection((previous) =>
      previous.connected === syncConnected && previous.connectionEpoch === syncConnectionEpoch
        ? previous
        : { connected: syncConnected, connectionEpoch: syncConnectionEpoch },
    )
  }, [syncConnected, syncConnectionEpoch])

  const agents = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: ({ signal }) => api.get('/api/agents', undefined, signal),
    refetchOnWindowFocus: 'always',
    refetchInterval: 15_000,
  })
  const skills = useQuery<Skill[]>({
    queryKey: ['skills'],
    queryFn: ({ signal }) => api.get('/api/skills', undefined, signal),
    refetchOnWindowFocus: 'always',
    refetchInterval: 15_000,
  })
  const plugins = useQuery<Plugin[]>({
    queryKey: ['plugins'],
    queryFn: ({ signal }) => api.get('/api/plugins', undefined, signal),
    refetchOnWindowFocus: 'always',
    refetchInterval: 15_000,
  })
  const inventorySignature = workflowValidationInventorySignature(
    agents.data,
    skills.data,
    plugins.data,
  )
  const inventorySignatureRef = useRef(inventorySignature)
  inventorySignatureRef.current = inventorySignature

  // RFC-004/RFC-007 compatibility healing is a LOCAL transaction performed
  // once after the controller has captured the untouched server revision.
  const healedInitialRef = useRef(false)
  const commitDraft = controller.commit
  useEffect(() => {
    if (healedInitialRef.current) return
    healedInitialRef.current = true
    const healed = healLoadedDefinition(initial.definition)
    if (healed === initial.definition) return
    commitDraft(
      {
        name: initial.name,
        description: initial.description,
        definition: healed,
      },
      {
        source: 'starter',
        label: 'Heal loaded workflow',
        transaction: 'single',
        historyMode: 'reset',
      },
    )
  }, [commitDraft, initial])

  // Query results are observations. A clean controller may adopt them; a
  // dirty controller may enter conflict; active reconciliation gets first
  // refusal inside the reducer. There is deliberately no setDraft/setName.
  const observeRemoteDetail = controller.remoteDetail
  useEffect(() => {
    observeRemoteDetail(observedDetail)
  }, [observeRemoteDetail, observedDetail])

  // A background 403/404 must not unmount or relabel the retained local draft
  // as "deleted". The explicit workflow.deleted frame is the only delete fact.
  const observeInaccessible = controller.remoteInaccessible
  useEffect(() => {
    if (isWorkflowAccessLoss(queryError)) observeInaccessible(queryError)
  }, [observeInaccessible, queryError])

  // Publish accepted receipts/clean remote adoption back into Query cache so
  // the rest of the application sees the controller's exact server revision.
  const publishedRevisionRef = useRef(`${initial.version}:${initial.snapshotHash}`)
  useEffect(() => {
    const revision = controller.state.serverRevision
    const snapshot = controller.state.server
    const signature = `${revision.version}:${revision.snapshotHash}`
    // A dirty foreign observation updates React Query before it enters the
    // reducer. Conflict intentionally keeps state.server at the old base; do
    // not write that base back over the newer cache row. Only a controller-
    // accepted server revision (receipt/clean follow/load remote) is publishable.
    if (signature === publishedRevisionRef.current) return
    publishedRevisionRef.current = signature
    qc.setQueryData<WorkflowDetail>(['workflows', workflowId], (current) => {
      // Query may already hold a later foreign observation by the time a save
      // receipt's React effect runs. Cache publication is monotonic: never
      // replace a newer version (or an impossible same-version/different-hash
      // observation) with this controller render's older accepted revision.
      if (
        current !== undefined &&
        (current.version > revision.version ||
          (current.version === revision.version && current.snapshotHash !== revision.snapshotHash))
      ) {
        return current
      }
      if (
        current !== undefined &&
        current.version === revision.version &&
        current.snapshotHash === revision.snapshotHash
      ) {
        return current
      }
      return {
        ...(current ?? initial),
        id: workflowId,
        name: snapshot.name,
        description: snapshot.description,
        definition: snapshot.definition,
        version: revision.version,
        snapshotHash: revision.snapshotHash,
        updatedAt: revision.updatedAt,
      }
    })
    void qc.invalidateQueries({ queryKey: ['workflows'], exact: true })
  }, [controller.state.server, controller.state.serverRevision, initial, qc, workflowId])

  const [selection, setSelection] = useState<CanvasSelection | null>(null)
  const draft = controller.state.local.definition
  const selectedNodeId = selection?.kind === 'node' ? selection.id : null
  const selectedEdge =
    selection?.kind === 'edge'
      ? (draft.edges.find((edge) => edge.id === selection.id) ?? null)
      : null
  const canvasRef = useRef<WorkflowCanvasHandle | null>(null)
  const closeInspector = () => {
    canvasRef.current?.clearSelection()
    setSelection(null)
  }
  const commitDefinition = (
    definition: WorkflowDefinition,
    meta?: WorkflowCanvasChangeMeta | InspectorChangeMeta,
  ): void => {
    const inspectorMeta = meta !== undefined && 'source' in meta ? meta : undefined
    const canvasMeta = meta !== undefined && !('source' in meta) ? meta : undefined
    const hasSelectionBefore =
      canvasMeta !== undefined &&
      Object.prototype.hasOwnProperty.call(canvasMeta, 'selectionBefore')
    const hasSelectionAfter =
      canvasMeta !== undefined && Object.prototype.hasOwnProperty.call(canvasMeta, 'selectionAfter')
    controller.commit(
      { ...controller.state.local, definition },
      {
        source: inspectorMeta?.source ?? 'canvas',
        label: meta?.label ?? t('editor.history.canvasEdit'),
        transaction: inspectorMeta?.transaction ?? 'single',
        ...(inspectorMeta?.mergeKey !== undefined ? { mergeKey: inspectorMeta.mergeKey } : {}),
        ...(inspectorMeta?.historyBoundary !== undefined
          ? { historyBoundary: inspectorMeta.historyBoundary }
          : {}),
        selectionBefore: hasSelectionBefore ? (canvasMeta?.selectionBefore ?? null) : selection,
        selectionAfter: hasSelectionAfter ? (canvasMeta?.selectionAfter ?? null) : selection,
      },
    )
  }

  // History restores semantic selection/focus only. Pan/zoom remains owned by
  // xyflow and is deliberately absent from the composite snapshot.
  const draftRef = useRef(draft)
  draftRef.current = draft
  const historySelectionHintRef = useRef(controller.selectionHint)
  historySelectionHintRef.current = controller.selectionHint
  const selectionHintRevision = controller.state.history.selectionHintRevision
  useEffect(() => {
    const hint = historySelectionHintRef.current
    const currentDraft = draftRef.current
    if (hint?.kind === 'workflow') {
      setSelection(null)
      canvasRef.current?.clearSelection()
      return
    }
    const restored: CanvasSelection | null =
      hint?.kind === 'node' && currentDraft.nodes.some((node) => node.id === hint.id)
        ? { kind: 'node', id: hint.id }
        : hint?.kind === 'edge' && currentDraft.edges.some((edge) => edge.id === hint.id)
          ? { kind: 'edge', id: hint.id }
          : null
    setSelection(restored)
    canvasRef.current?.restoreSelection(restored)
  }, [selectionHintRevision])

  // Remote adoption does not publish an Undo/Redo restoration token. It may,
  // however, remove the currently-inspected object; prune only that stale
  // selection without focusing the canvas or disturbing a still-live field.
  useEffect(() => {
    if (selection === null) return
    const stillExists =
      selection.kind === 'node'
        ? draft.nodes.some((node) => node.id === selection.id)
        : draft.edges.some((edge) => edge.id === selection.id)
    if (stillExists) return
    setSelection(null)
    canvasRef.current?.clearSelection()
  }, [draft.edges, draft.nodes, selection])

  // Name and description are one composite local transaction. The controller,
  // not this dialog, decides when/how that snapshot is persisted.
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameName, setRenameName] = useState('')
  const [renameDescription, setRenameDescription] = useState('')
  const renameTriggerRef = useRef<HTMLButtonElement | null>(null)
  const renameFieldError = workflowRenameError(renameName, controller.state.local.name)
  const renameCanSave =
    renameFieldError === null &&
    (renameName !== controller.state.local.name ||
      renameDescription !== controller.state.local.description)

  const unsafeNavigationRef = useRef<string | null>(null)
  const unsafe = isWorkflowDraftUnsafeToLeave(controller.state)
  unsafeNavigationRef.current = unsafe
    ? JSON.stringify([
        workflowId,
        controller.state.revision,
        controller.state.phase,
        controller.state.serverRevision.version,
      ])
    : null

  const del = useMutation({
    mutationFn: ({ expectedVersion }: { expectedVersion: number }) =>
      api.deleteJson<void>(
        `/api/workflows/${encodeURIComponent(workflowId)}`,
        makeWorkflowDeleteRequest(expectedVersion),
      ),
    onSuccess: () => {
      // Delete is an explicit local-discard decision. Clear the synchronous
      // guard before navigating so the success path cannot block itself.
      unsafeNavigationRef.current = null
      void qc.invalidateQueries({ queryKey: ['workflows'] })
      void navigate({ to: '/workflows' })
    },
    onError: (error) => {
      // A delete CAS conflict invalidates the confirmation summary/key. The
      // next click must confirm against the newly observed server version.
      if (error instanceof ApiError && error.status === 409) onRefetch()
    },
  })
  const deleteExpectedVersion =
    controller.state.conflict?.current?.version ?? controller.state.serverRevision.version
  const deleteConfirmationKey = workflowDeleteConfirmationKey(
    workflowId,
    deleteExpectedVersion,
    controller.state.revision,
    unsafe,
  )

  const validate = useMutation({
    mutationFn: ({ saved, signal }: { saved: WorkflowSavedDraft; signal: AbortSignal }) =>
      api.post<WorkflowValidationReceipt>(
        `/api/workflows/${encodeURIComponent(workflowId)}/validate`,
        {
          expectedVersion: saved.server.version,
          expectedSnapshotHash: saved.server.snapshotHash,
        },
        signal,
      ),
  })
  const [validationBinding, setValidationBinding] = useState<WorkflowValidationBinding | null>(null)
  const validationStale = workflowValidationStaleReason(validationBinding, {
    localRevision: controller.state.revision,
    workflowVersion: controller.state.serverRevision.version,
    snapshotHash: controller.state.serverRevision.snapshotHash,
    inventorySignature,
  })

  const exactActionRef = useRef<'validate' | 'export' | 'launch' | null>(null)
  const exactActionAbortRef = useRef<AbortController | null>(null)
  const [validatePending, setValidatePending] = useState(false)
  const [exportPending, setExportPending] = useState(false)
  const [preparingLaunch, setPreparingLaunch] = useState(false)
  const [actionError, setActionError] = useState<unknown>(null)
  const draftStatusFocusRef = useRef<HTMLDivElement | null>(null)
  const actionErrorFocusRef = useRef<HTMLDivElement | null>(null)
  const focusActionErrorAfterRenderRef = useRef(false)

  const focusDraftStatus = (): void => {
    draftStatusFocusRef.current?.focus()
  }
  const recordExactActionError = (error: unknown): void => {
    if (
      (error instanceof WorkflowEnsureSavedError && error.reason === 'cancelled') ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      setActionError(null)
      return
    }
    if (
      error instanceof ApiError &&
      (error.code === 'workflow-validation-stale' || error.code === 'workflow-version-mismatch')
    ) {
      onRefetch()
    }
    if (error instanceof WorkflowEnsureSavedError) {
      // The save controller already exposes the durable recovery Notice. Keep
      // one source of truth and focus it instead of duplicating a transient
      // action error above the canvas.
      setActionError(null)
      focusDraftStatus()
      return
    }
    focusActionErrorAfterRenderRef.current = true
    setActionError(error)
  }
  useEffect(() => {
    if (actionError === null || actionError === undefined) return
    if (!focusActionErrorAfterRenderRef.current) return
    focusActionErrorAfterRenderRef.current = false
    actionErrorFocusRef.current?.focus()
  }, [actionError])
  const bindValidation = (
    saved: WorkflowSavedDraft,
    receipt: WorkflowValidationReceipt,
    inventorySignatureAtRequest: string,
  ): void => {
    setValidationBinding({
      localRevision: saved.revision,
      // Bind the receipt to the inventory observation that authorized the
      // request. If a query refresh lands while validation is in flight, the
      // response is immediately stale instead of being relabelled current.
      inventorySignature: inventorySignatureAtRequest,
      receipt,
    })
  }
  const assertActionRevision = (saved: WorkflowSavedDraft): void => {
    if (!controller.isSavedDraftCurrent(saved)) {
      throw new WorkflowActionRevisionChangedError(t('editor.actionDraftChanged'))
    }
  }
  const runExactValidation = async (
    saved: WorkflowSavedDraft,
    signal: AbortSignal,
  ): Promise<WorkflowValidationReceipt> => {
    const inventorySignatureAtRequest = inventorySignatureRef.current
    const receipt = await validate.mutateAsync({ saved, signal })
    if (
      receipt.revision.workflowId !== workflowId ||
      receipt.revision.version !== saved.server.version ||
      receipt.revision.snapshotHash !== saved.server.snapshotHash
    ) {
      throw new WorkflowActionRevisionChangedError(t('editor.actionRevisionMismatch'))
    }
    bindValidation(saved, receipt, inventorySignatureAtRequest)
    return receipt
  }
  const handleValidate = async (): Promise<void> => {
    if (exactActionRef.current !== null) return
    const abort = new AbortController()
    exactActionRef.current = 'validate'
    exactActionAbortRef.current = abort
    setValidatePending(true)
    setActionError(null)
    try {
      const saved = await controller.ensureSaved({ signal: abort.signal })
      await runExactValidation(saved, abort.signal)
    } catch (error) {
      recordExactActionError(error)
    } finally {
      if (exactActionAbortRef.current === abort) exactActionAbortRef.current = null
      exactActionRef.current = null
      setValidatePending(false)
    }
  }
  const handleExport = async (): Promise<void> => {
    if (exactActionRef.current !== null) return
    const abort = new AbortController()
    exactActionRef.current = 'export'
    exactActionAbortRef.current = abort
    setExportPending(true)
    setActionError(null)
    try {
      const saved = await controller.ensureSaved({ signal: abort.signal })
      const blob = await api.getBlob(
        `/api/workflows/${encodeURIComponent(workflowId)}/export`,
        {
          expectedVersion: saved.server.version,
          expectedSnapshotHash: saved.server.snapshotHash,
        },
        abort.signal,
      )
      assertActionRevision(saved)
      downloadWorkflowServerExport(blob, saved.snapshot.name)
    } catch (error) {
      recordExactActionError(error)
    } finally {
      if (exactActionAbortRef.current === abort) exactActionAbortRef.current = null
      exactActionRef.current = null
      setExportPending(false)
    }
  }
  const handleLaunch = async (): Promise<void> => {
    if (exactActionRef.current !== null) return
    const abort = new AbortController()
    exactActionRef.current = 'launch'
    exactActionAbortRef.current = abort
    const frozenRevision = controller.state.revision
    setPreparingLaunch(true)
    setActionError(null)
    try {
      const saved = await controller.ensureSaved({ signal: abort.signal })
      if (saved.revision !== frozenRevision) {
        throw new WorkflowActionRevisionChangedError(t('editor.actionDraftChanged'))
      }
      const receipt = await runExactValidation(saved, abort.signal)
      const hasBlocking = receipt.issues.some((issue) => (issue.severity ?? 'error') === 'error')
      if (hasBlocking) return
      assertActionRevision(saved)
      // The exact save/validate fence is the user's explicit handoff. Clear
      // the synchronous guard before the legacy redirect changes routes.
      unsafeNavigationRef.current = null
      await navigate({
        to: '/workflows/$id/launch',
        params: { id: workflowId },
        search: { version: saved.server.version },
      })
    } catch (error) {
      recordExactActionError(error)
    } finally {
      if (exactActionAbortRef.current === abort) exactActionAbortRef.current = null
      exactActionRef.current = null
      setPreparingLaunch(false)
    }
  }

  useEffect(
    () => () => {
      exactActionAbortRef.current?.abort()
    },
    [],
  )

  // Conflict/terminal save-copy is a real CreateWorkflow using the captured
  // full local snapshot. Suggested name and description stay editable.
  const [copyOpen, setCopyOpen] = useState(false)
  const copyOpenRef = useRef(false)
  const [copySnapshot, setCopySnapshot] = useState<WorkflowDraftSnapshot | null>(null)
  const [copyName, setCopyName] = useState('')
  const [copyDescription, setCopyDescription] = useState('')
  const copyCreate = useMutation({
    mutationFn: (body: CreateWorkflow): Promise<WorkflowDetail> => api.post('/api/workflows', body),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ['workflows'] })
      qc.setQueryData(['workflows', created.id], created)
      if (!copyOpenRef.current) return
      copyOpenRef.current = false
      setCopyOpen(false)
      unsafeNavigationRef.current = null
      void navigate({ to: '/workflows/$id', params: { id: created.id } })
    },
  })
  const resetCopyCreate = copyCreate.reset
  const copyIntent = controller.intent
  const clearCopyIntent = controller.clearIntent
  useEffect(() => {
    if (copyIntent?.type !== 'save-copy') return
    setCopySnapshot(copyIntent.snapshot)
    setCopyName(copyIntent.suggestedName)
    setCopyDescription(copyIntent.snapshot.description)
    resetCopyCreate()
    copyOpenRef.current = true
    setCopyOpen(true)
    clearCopyIntent()
  }, [clearCopyIntent, copyIntent, resetCopyCreate])
  const copyNameError = workflowNameError(copyName)
  const copyCanCreate = copySnapshot !== null && copyNameError === null
  const undoLabel = controller.canUndo
    ? t('editor.history.undoIntent', {
        label:
          controller.state.history.entries[controller.state.history.cursor - 1]?.intent ??
          t('editor.history.canvasEdit'),
      })
    : t('editor.history.undo')
  const redoLabel = controller.canRedo
    ? t('editor.history.redoIntent', {
        label:
          controller.state.history.entries[controller.state.history.cursor]?.intent ??
          t('editor.history.canvasEdit'),
      })
    : t('editor.history.redo')

  const headerActions = (
    <>
      <button
        type="button"
        className="btn btn--sm workflow-history-action"
        onClick={controller.undo}
        disabled={!controller.canUndo}
        title={undoLabel}
        data-testid="workflow-undo"
      >
        <span aria-hidden="true">↶</span>
        <span className="workflow-history-action__label">{undoLabel}</span>
      </button>
      <button
        type="button"
        className="btn btn--sm workflow-history-action"
        onClick={controller.redo}
        disabled={!controller.canRedo}
        title={redoLabel}
        data-testid="workflow-redo"
      >
        <span aria-hidden="true">↷</span>
        <span className="workflow-history-action__label">{redoLabel}</span>
      </button>
      <button
        type="button"
        className="btn btn--primary"
        onClick={() => void handleLaunch()}
        disabled={exactActionRef.current !== null}
      >
        {preparingLaunch ? t('editor.preparingLaunch') : t('editor.launch')}
      </button>
      {preparingLaunch && (
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => exactActionAbortRef.current?.abort()}
          data-testid="workflow-launch-cancel"
        >
          {t('common.cancel')}
        </button>
      )}
      <button
        type="button"
        className="btn btn--sm"
        onClick={() => void handleValidate()}
        disabled={exactActionRef.current !== null}
      >
        {validatePending ? t('editor.validating') : t('editor.validate')}
      </button>
      <button
        type="button"
        className="btn btn--sm"
        title={t('editor.exportTitle')}
        onClick={() => void handleExport()}
        disabled={exactActionRef.current !== null}
      >
        {exportPending ? t('editor.exporting') : t('editor.exportYaml')}
      </button>
      <button
        type="button"
        className="btn btn--sm"
        ref={renameTriggerRef}
        onClick={() => {
          setRenameName(controller.state.local.name)
          setRenameDescription(controller.state.local.description)
          setRenameOpen(true)
        }}
        data-testid="workflow-rename-button"
      >
        {t('editor.renameButton')}
      </button>
      <AclDialogButton
        resourceBaseUrl={`/api/workflows/${encodeURIComponent(workflowId)}`}
        invalidateKey={['workflows']}
        size="sm"
      />
      <ConfirmButton
        label={t('common.delete')}
        confirmationKey={deleteConfirmationKey}
        onConfirm={() => del.mutateAsync({ expectedVersion: deleteExpectedVersion })}
        variant="danger"
        disabled={
          del.isPending ||
          controller.state.phase === 'inaccessible' ||
          controller.state.phase === 'deleted'
        }
        size="sm"
      />
    </>
  )

  const backgroundQueryError =
    queryError !== null && queryError !== undefined && !isWorkflowAccessLoss(queryError)

  return (
    <div className="page page--editor">
      <PageHeader
        title={controller.state.local.name || workflowId}
        meta={
          <>
            <code>{workflowId}</code> · v{controller.state.serverRevision.version}
          </>
        }
        actions={headerActions}
      />

      {backgroundQueryError && (
        <ErrorBanner
          error={queryError}
          action={
            <button type="button" className="btn btn--sm" onClick={onRefetch}>
              {t('common.retry')}
            </button>
          }
        />
      )}
      {/* RFC-203 T2: the scheduled-reference list (visibleScheduled +
          hiddenCount) now renders via ErrorBanner's shared <ErrorDetails>
          — the RFC-202 call-site-local renderer moved there. */}
      {del.error !== null && del.error !== undefined && <ErrorBanner error={del.error} />}
      {actionError !== null && actionError !== undefined && (
        <div ref={actionErrorFocusRef} tabIndex={-1} data-testid="workflow-action-error-focus">
          <ErrorBanner error={actionError} />
        </div>
      )}
      {agents.error !== null && agents.error !== undefined && <ErrorBanner error={agents.error} />}

      <div ref={draftStatusFocusRef} tabIndex={-1} data-testid="workflow-draft-status-focus">
        <WorkflowDraftStatus
          state={controller.state}
          onRetryNow={controller.retry}
          onSaveCopy={controller.requestCopy}
          onLoadRemote={controller.confirmLoadRemote}
          onOverwriteRemote={controller.confirmOverwrite}
          onExportLocal={() => downloadWorkflowLocalDraft(controller.state.local)}
          onRetryAccess={controller.retryAccess}
          onReturnToList={() => {
            // The terminal Notice action is itself the user's explicit decision
            // to leave the retained local draft; do not make it confirm twice.
            unsafeNavigationRef.current = null
            void navigate({ to: '/workflows' })
          }}
          canSaveCopy
        />
      </div>

      {validationBinding !== null && (
        <ValidationPanel
          result={validationBinding.receipt}
          stale={validationStale}
          onAutoFitWrapper={(wrapperId) => {
            const next = clearWrapperSize(draft, wrapperId)
            if (next !== draft) commitDefinition(next)
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
            workflowId={workflowId}
            definition={draft}
            agents={agents.data ?? []}
            onSelect={setSelection}
            onChange={commitDefinition}
            canUndo={controller.canUndo}
            canRedo={controller.canRedo}
            onUndo={controller.undo}
            onRedo={controller.redo}
          />
        </div>
        {selectedEdge !== null ? (
          <EdgeInspector
            edge={selectedEdge}
            definition={draft}
            onChange={commitDefinition}
            onClose={closeInspector}
          />
        ) : (
          <NodeInspector
            definition={draft}
            selectedNodeId={selectedNodeId}
            agents={agents.data ?? []}
            onChange={commitDefinition}
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
        pending={false}
        onSave={() => {
          if (!renameCanSave) return
          controller.commit(
            {
              ...controller.state.local,
              name: renameName,
              description: renameDescription,
            },
            {
              source: 'metadata',
              label: t('editor.history.rename'),
              transaction: 'single',
              selectionBefore: selection,
              selectionAfter: { kind: 'workflow', field: 'name' },
            },
          )
          setRenameOpen(false)
        }}
        triggerRef={renameTriggerRef}
      />

      <QuickCreateDialog
        open={copyOpen}
        onClose={() => {
          copyOpenRef.current = false
          setCopyOpen(false)
          copyCreate.reset()
        }}
        title={t('editor.draftStatus.saveCopy')}
        createLabel={t('editor.draftStatus.saveCopy')}
        nameLabel={t('editor.fieldName')}
        nameHint={t('workflows.fieldNameHint')}
        descriptionLabel={t('editor.fieldDescription')}
        name={copyName}
        onNameChange={setCopyName}
        description={copyDescription}
        onDescriptionChange={setCopyDescription}
        nameError={copyName.length > 0 && copyNameError !== null ? t(copyNameError) : undefined}
        canCreate={copyCanCreate}
        pending={copyCreate.isPending}
        submitError={
          copyCreate.error !== null && copyCreate.error !== undefined
            ? describeApiError(copyCreate.error)
            : undefined
        }
        onCreate={() => {
          if (copySnapshot === null || !copyCanCreate) return
          copyCreate.mutate({
            name: copyName,
            description: copyDescription,
            definition: copySnapshot.definition,
          })
        }}
        testidPrefix="workflow-copy"
      />

      <UnsavedChangesGuard dirtyRef={unsafeNavigationRef} />
    </div>
  )
}

function isWorkflowAccessLoss(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 403 || error.status === 404)
}

/**
 * RFC-004 added a `severity` field to ValidationIssue. The default ('error')
 * stays blocking; only entries explicitly tagged 'warning' fall into the
 * non-blocking bucket. Exported pure for testing.
 */
export function partitionIssues(issues: WorkflowValidationIssue[]): {
  errors: WorkflowValidationIssue[]
  warnings: WorkflowValidationIssue[]
} {
  const errors: WorkflowValidationIssue[] = []
  const warnings: WorkflowValidationIssue[] = []
  for (const i of issues) {
    if (i.severity === 'warning') warnings.push(i)
    else errors.push(i)
  }
  return { errors, warnings }
}

function ValidationPanel({
  result,
  stale,
  onAutoFitWrapper,
}: {
  result: { ok: boolean; issues: WorkflowValidationIssue[] }
  stale: WorkflowValidationStaleReason
  onAutoFitWrapper?: (wrapperId: string) => void
}) {
  const { t } = useTranslation()
  const { errors, warnings } = partitionIssues(result.issues)
  return (
    <div>
      {stale !== null ? (
        <div className="validation-panel validation-panel--warn" data-testid="validation-stale">
          {t(stale === 'draft' ? 'editor.validationStaleDraft' : 'editor.validationStaleInventory')}
        </div>
      ) : errors.length === 0 ? (
        <div className="validation-panel validation-panel--ok">{t('editor.validationOk')}</div>
      ) : (
        <div className="validation-panel validation-panel--bad">
          <div className="validation-panel__title">
            {t('editor.validationIssues', { n: errors.length })}
          </div>
          <ul>
            {errors.map((i, idx) => (
              <ValidationIssueRow issue={i} key={`e-${idx}`} />
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
              <ValidationIssueRow issue={i} key={`w-${idx}`}>
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
              </ValidationIssueRow>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// RFC-203 T3c — localized title line; the raw validator message (which carries
// the node/edge ids) folds into the same row so location info is never lost.
function ValidationIssueRow({
  issue,
  children,
}: {
  issue: WorkflowValidationIssue
  children?: ReactNode
}) {
  const { t } = useTranslation()
  const described = describeValidationIssue(issue)
  return (
    <li>
      <code>{issue.code}</code> — {described.title}
      {children}
      <details className="error-details__raw">
        <summary>{t('errorDetails.rawSummary')}</summary>
        <pre>{described.raw}</pre>
      </details>
    </li>
  )
}
