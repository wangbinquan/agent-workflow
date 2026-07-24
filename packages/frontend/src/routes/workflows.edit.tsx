// Workflow editor route — /workflows/$id. Creation happens in the /workflows
// list page's quick-create dialog (RFC-164 workgroup pattern); the editor owns
// every detail edit of the (initially empty) definition.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  Agent,
  CreateWorkflow,
  Plugin,
  Skill,
  WorkflowDefinition,
  WorkflowDetail,
  WorkflowDraftSnapshot,
  WorkflowValidationReceipt,
} from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { describeApiError } from '@/i18n'
import { EditorPaletteContent, EditorSidebar } from '@/components/canvas/EditorSidebar'
import { EdgeInspector } from '@/components/canvas/EdgeInspector'
import { NodeInspector } from '@/components/canvas/NodeInspector'
import { nodeTitle } from '@/components/canvas/nodeTitle'
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
import { AclPanel } from '@/components/AclPanel'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Dialog } from '@/components/Dialog'
import { LoadingState } from '@/components/LoadingState'
import { ManagedLiveRegionProvider } from '@/components/ManagedLiveRegion'
import { PageHeader } from '@/components/PageHeader'
import { QuickCreateDialog } from '@/components/QuickCreateDialog'
import { RenameDialog } from '@/components/RenameDialog'
import { UnsavedChangesGuard } from '@/components/split/UnsavedChangesGuard'
import {
  WorkflowDraftStatus,
  WorkflowDraftStatusSummary,
  workflowDraftHasNotice,
} from '@/components/workflow-editor/WorkflowDraftStatus'
import { WorkflowStarterDialog } from '@/components/workflow-editor/WorkflowStarterDialog'
import { ValidationPanel } from '@/components/workflow-editor/ValidationPanel'
export { partitionValidationIssues as partitionIssues } from '@/components/workflow-editor/ValidationPanel'
import {
  useWorkflowEditorDraft,
  WorkflowEnsureSavedError,
  type WorkflowSavedDraft,
} from '@/hooks/useWorkflowEditorDraft'
import { useWorkflowSync } from '@/hooks/useWorkflowSync'
import { useActor } from '@/hooks/useActor'
import { planWorkflowIssueNavigation } from '@/lib/workflow-inspector-target'
import {
  useWorkflowEditorWorkspaceMode,
  workspaceHasInspectorRail,
  workspaceHasPaletteRail,
  type WorkflowEditorWorkspaceMode,
} from '@/lib/workflow-editor-workspace'
import { Route as RootRoute } from './__root'

/**
 * Class list for the editor's grid container. The `--with-inspector`
 * variant locks a 480px third column for the inspector drawer; we only
 * apply it when a node is actually selected, otherwise the empty grid
 * track squeezes the canvas down to ~0px on narrow viewports.
 *
 * Exported for unit testing — see tests/canvas-editor-layout.test.ts.
 */
export function editorLayoutClass(
  selectedNodeId: string | null,
  mode: WorkflowEditorWorkspaceMode = 'wide',
): string {
  return [
    'editor-layout',
    `editor-layout--${mode}`,
    selectedNodeId !== null && workspaceHasInspectorRail(mode)
      ? 'editor-layout--with-inspector'
      : null,
  ]
    .filter(Boolean)
    .join(' ')
}

type EditorModalSurface =
  | 'none'
  | 'palette'
  | 'inspector'
  | 'starter'
  | 'actions'
  | 'rename'
  | 'acl'
  | 'delete'
  | 'validation'
  | 'save-copy'
  | 'canvas-owned'

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
          <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
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
  const actor = useActor()
  const workspaceMode = useWorkflowEditorWorkspaceMode()
  const hasPaletteRail = workspaceHasPaletteRail(workspaceMode)
  const hasInspectorRail = workspaceHasInspectorRail(workspaceMode)
  const [modalSurface, setModalSurface] = useState<EditorModalSurface>('none')
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
  const selectedNode =
    selectedNodeId === null
      ? null
      : (draft.nodes.find((node) => node.id === selectedNodeId) ?? null)
  const selectedEdge =
    selection?.kind === 'edge'
      ? (draft.edges.find((edge) => edge.id === selection.id) ?? null)
      : null
  const canvasRef = useRef<WorkflowCanvasHandle | null>(null)
  const [inspectorFocusRequest, setInspectorFocusRequest] = useState<{
    requestId: number
    focusId: string
  } | null>(null)
  const starterTriggerRef = useRef<HTMLElement | null>(null)
  const paletteTriggerRef = useRef<HTMLButtonElement | null>(null)
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null)
  const paletteSearchRef = useRef<HTMLInputElement | null>(null)
  const canvasFrameRef = useRef<HTMLDivElement | null>(null)
  const openStarter = (trigger: HTMLElement): void => {
    starterTriggerRef.current = trigger
    setModalSurface('starter')
  }
  const closeInspector = () => {
    canvasRef.current?.clearSelection()
    setSelection(null)
    setModalSurface((current) => (current === 'inspector' ? 'none' : current))
  }

  useEffect(() => {
    setModalSurface((current) => {
      if (current === 'palette' && hasPaletteRail) return 'none'
      if (current === 'inspector' && (selection === null || hasInspectorRail)) return 'none'
      if (current === 'none' && selection !== null && !hasInspectorRail) return 'inspector'
      return current
    })
  }, [hasInspectorRail, hasPaletteRail, selection])
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
  const [renameName, setRenameName] = useState('')
  const [renameDescription, setRenameDescription] = useState('')
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
    mutationFn: ({ expectedVersion, confirm }: { expectedVersion: number; confirm: string }) =>
      api.deleteJson<void>(
        `/api/workflows/${encodeURIComponent(workflowId)}`,
        makeWorkflowDeleteRequest(expectedVersion, confirm),
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
  const [draftStatusFocusRequest, setDraftStatusFocusRequest] = useState(0)
  const draftStatusVisible = workflowDraftHasNotice(controller.state)

  const focusDraftStatus = (): void => {
    setDraftStatusFocusRequest((request) => request + 1)
  }
  useEffect(() => {
    if (draftStatusFocusRequest === 0 || !draftStatusVisible) return
    draftStatusFocusRef.current?.focus()
  }, [draftStatusFocusRequest, draftStatusVisible])

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
        { signal: abort.signal },
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
      setModalSurface('none')
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
    canvasRef.current?.closeModalSurface?.()
    copyOpenRef.current = true
    setModalSurface('save-copy')
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
      {/* With the palette rail visible (wide) the sidebar IS the add-step
        entry, so the header button only renders when the rail is absent —
        there it is the sole free-insert entry (390 mobile e2e locks this;
        HTML5 drag is unavailable there). Header duplicate removed on wide by
        user decision, 2026-07-21. */}
      {!hasPaletteRail && (
        <button
          type="button"
          className="btn btn--sm"
          data-testid="workflow-add-step"
          ref={paletteTriggerRef}
          onClick={() => setModalSurface('palette')}
        >
          + {t('editor.nodePicker.addButton')}
        </button>
      )}
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
        ref={moreTriggerRef}
        type="button"
        className="btn"
        onClick={() => setModalSurface('actions')}
        data-testid="workflow-more-actions"
      >
        {t('editor.nodeActions.more')}
      </button>
    </>
  )

  const backgroundQueryError =
    queryError !== null && queryError !== undefined && !isWorkflowAccessLoss(queryError)
  const inspectorDialogTitle =
    selectedEdge !== null
      ? t('inspector.edgeTitle')
      : selectedNode !== null
        ? nodeTitle(selectedNode)
        : t('inspector.tabEdit')
  const renderInspector = (chrome: 'rail' | 'content') =>
    selectedEdge !== null ? (
      <EdgeInspector
        chrome={chrome}
        edge={selectedEdge}
        definition={draft}
        agents={agents.data ?? []}
        focusRequest={inspectorFocusRequest}
        onReconnect={(edgeId, trigger) => {
          setModalSurface('canvas-owned')
          canvasRef.current?.openEdgeReconnect(edgeId, trigger)
        }}
        onChange={commitDefinition}
        onClose={closeInspector}
      />
    ) : selectedNode !== null ? (
      <NodeInspector
        chrome={chrome}
        definition={draft}
        selectedNodeId={selectedNode.id}
        agents={agents.data ?? []}
        focusRequest={inspectorFocusRequest}
        onChange={commitDefinition}
        onClose={closeInspector}
        onConnect={
          chrome === 'content'
            ? (nodeId, trigger) => {
                setModalSurface('canvas-owned')
                canvasRef.current?.openConnection(nodeId, trigger)
              }
            : undefined
        }
      />
    ) : null

  return (
    <ManagedLiveRegionProvider>
      <div className="page page--editor">
        <PageHeader
          className="editor-page-header"
          title={controller.state.local.name || workflowId}
          meta={
            <div className="editor-resource-meta">
              <span className="editor-resource-meta__revision">
                <code className="editor-resource-meta__id">{workflowId}</code>
                <span className="editor-resource-meta__version">
                  {' · v'}
                  {controller.state.serverRevision.version}
                </span>
              </span>
              <WorkflowDraftStatusSummary state={controller.state} />
            </div>
          }
          actions={headerActions}
        />

        {backgroundQueryError && <ErrorBanner error={queryError} onRetry={onRefetch} />}
        {/* RFC-203 T2: the scheduled-reference list (visibleScheduled +
          hiddenCount) now renders via ErrorBanner's shared <ErrorDetails>
          — the RFC-202 call-site-local renderer moved there. */}
        {actionError !== null && actionError !== undefined && (
          <div ref={actionErrorFocusRef} tabIndex={-1} data-testid="workflow-action-error-focus">
            <ErrorBanner error={actionError} />
          </div>
        )}
        {agents.error !== null && agents.error !== undefined && (
          <ErrorBanner error={agents.error} />
        )}

        {draftStatusVisible && (
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
        )}

        <div
          className={editorLayoutClass(selection?.id ?? null, workspaceMode)}
          data-workspace-mode={workspaceMode}
        >
          {hasPaletteRail ? (
            <EditorSidebar
              agents={agents.data ?? []}
              initialFocusRef={paletteSearchRef}
              onAdd={(item) => canvasRef.current?.addPaletteItemAtViewportCenter(item)}
            />
          ) : null}
          <div ref={canvasFrameRef} className="canvas-frame" tabIndex={-1}>
            <WorkflowCanvas
              ref={canvasRef}
              surface="editor"
              workflowId={workflowId}
              definition={draft}
              agents={agents.data ?? []}
              onSelect={(nextSelection) => {
                setSelection(nextSelection)
                if (!hasInspectorRail) {
                  setModalSurface(nextSelection === null ? 'none' : 'inspector')
                }
              }}
              onChange={commitDefinition}
              canUndo={controller.canUndo}
              canRedo={controller.canRedo}
              onUndo={controller.undo}
              onRedo={controller.redo}
              onStartFromTemplate={openStarter}
              onModalSurfaceChange={(surface) => {
                setModalSurface(
                  surface === null
                    ? selection !== null && !hasInspectorRail
                      ? 'inspector'
                      : 'none'
                    : 'canvas-owned',
                )
              }}
              validationIssues={
                validationBinding !== null && validationStale === null
                  ? validationBinding.receipt.issues
                  : undefined
              }
            />
            {validationBinding !== null && (
              <ValidationPanel
                result={validationBinding.receipt}
                stale={validationStale}
                definition={draft}
                open={modalSurface === 'validation'}
                onOpenChange={(open) => setModalSurface(open ? 'validation' : 'none')}
                validating={validatePending}
                onRevalidate={() => void handleValidate()}
                onNavigate={(target) => {
                  const plan = planWorkflowIssueNavigation(target, draft)
                  if (plan.selection === null || plan.focusId === null) return
                  setSelection(plan.selection)
                  canvasRef.current?.focusSelection(plan.selection)
                  if (!hasInspectorRail) setModalSurface('inspector')
                  setInspectorFocusRequest((current) => ({
                    requestId: (current?.requestId ?? 0) + 1,
                    focusId: plan.focusId as string,
                  }))
                }}
                onAutoFitWrapper={(wrapperId) => {
                  const next = clearWrapperSize(draft, wrapperId)
                  if (next !== draft) commitDefinition(next)
                }}
              />
            )}
          </div>
          {hasInspectorRail ? renderInspector('rail') : null}
        </div>

        <Dialog
          open={modalSurface === 'palette'}
          onClose={() => setModalSurface('none')}
          title={t('editor.nodePicker.title')}
          initialFocusRef={paletteSearchRef}
          triggerRef={paletteTriggerRef}
          restoreFocusFallbackRef={canvasFrameRef}
          panelClassName={`workflow-editor-surface-dialog workflow-editor-surface-dialog--${workspaceMode}`}
          data-testid="workflow-editor-palette-surface"
        >
          <EditorPaletteContent
            agents={agents.data ?? []}
            initialFocusRef={paletteSearchRef}
            showDragGrip={false}
            onAdd={(item) => {
              canvasRef.current?.addPaletteItemAtViewportCenter(item)
              setModalSurface('none')
            }}
          />
        </Dialog>

        <Dialog
          open={modalSurface === 'inspector' && selection !== null}
          onClose={closeInspector}
          title={inspectorDialogTitle}
          restoreFocusFallbackRef={canvasFrameRef}
          panelClassName={`workflow-editor-surface-dialog workflow-editor-surface-dialog--${workspaceMode}`}
          data-testid="workflow-editor-inspector-surface"
        >
          {renderInspector('content')}
        </Dialog>

        <Dialog
          open={modalSurface === 'actions'}
          onClose={() => setModalSurface('none')}
          title={t('editor.actionsTitle')}
          triggerRef={moreTriggerRef}
          data-testid="workflow-actions-dialog"
        >
          <div className="workflow-editor-action-list">
            <button
              type="button"
              className="workflow-editor-action-list__item"
              disabled={exactActionRef.current !== null}
              onClick={() => {
                setModalSurface('none')
                void handleExport()
              }}
            >
              <strong>{exportPending ? t('editor.exporting') : t('editor.exportYaml')}</strong>
              <span>{t('editor.exportTitle')}</span>
            </button>
            <button
              type="button"
              className="workflow-editor-action-list__item"
              onClick={() => {
                setRenameName(controller.state.local.name)
                setRenameDescription(controller.state.local.description)
                setModalSurface('rename')
              }}
              data-testid="workflow-rename-button"
            >
              <strong>{t('editor.renameButton')}</strong>
              <span>{t('editor.renameActionHint')}</span>
            </button>
            {actor.data !== null && actor.data !== undefined && actor.data.source !== 'daemon' ? (
              <button
                type="button"
                className="workflow-editor-action-list__item"
                onClick={() => setModalSurface('acl')}
                data-testid="workflow-acl-button"
              >
                <strong>{t('acl.title')}</strong>
                <span>{t('editor.aclActionHint')}</span>
              </button>
            ) : null}
            <button
              type="button"
              className="workflow-editor-action-list__item workflow-editor-action-list__item--danger"
              disabled={
                controller.state.phase === 'inaccessible' || controller.state.phase === 'deleted'
              }
              onClick={() => setModalSurface('delete')}
              data-testid="workflow-delete-button"
            >
              <strong>{t('common.delete')}</strong>
              <span>{t('editor.deleteActionHint')}</span>
            </button>
          </div>
        </Dialog>

        <Dialog
          open={modalSurface === 'acl'}
          onClose={() => setModalSurface('none')}
          title={t('acl.title')}
          triggerRef={moreTriggerRef}
          data-testid="workflow-acl-dialog"
        >
          <AclPanel
            resourceBaseUrl={`/api/workflows/${encodeURIComponent(workflowId)}`}
            invalidateKey={['workflows']}
            onSaved={() => setModalSurface('none')}
            onCancel={() => setModalSurface('none')}
          />
        </Dialog>

        <ConfirmDialog
          key={deleteConfirmationKey}
          open={modalSurface === 'delete'}
          title={t('editor.deleteTitle')}
          description={t('editor.deleteDescription', {
            name: controller.state.local.name || workflowId,
            version: deleteExpectedVersion,
          })}
          confirmLabel={t('common.delete')}
          tone="danger"
          triggerRef={moreTriggerRef}
          confirmInput={{
            expected: controller.state.local.name || workflowId,
            label: t('common.deleteConfirm.inputLabel', {
              name: controller.state.local.name || workflowId,
            }),
            placeholder: controller.state.local.name || workflowId,
          }}
          onClose={() => setModalSurface('none')}
          onConfirm={async (ctx) => {
            await del.mutateAsync({
              expectedVersion: deleteExpectedVersion,
              confirm: ctx?.typedConfirm ?? '',
            })
          }}
        />

        <RenameDialog
          open={modalSurface === 'rename'}
          onClose={() => setModalSurface('none')}
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
            setModalSurface('none')
          }}
          triggerRef={moreTriggerRef}
        />

        <QuickCreateDialog
          open={modalSurface === 'save-copy'}
          onClose={() => {
            copyOpenRef.current = false
            setModalSurface('none')
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

        <WorkflowStarterDialog
          open={modalSurface === 'starter'}
          workflowId={workflowId}
          definition={draft}
          agents={agents.data ?? []}
          inventorySignature={inventorySignature}
          triggerRef={starterTriggerRef}
          onClose={() => setModalSurface('none')}
          onUseBlank={() => {
            setModalSurface('none')
            window.setTimeout(() => {
              if (hasPaletteRail) paletteSearchRef.current?.focus()
              else setModalSurface('palette')
            }, 0)
          }}
          onApply={(definition) => {
            const nextSelection: CanvasSelection | null = definition.nodes.some(
              (node) => node.id === 'starter_input',
            )
              ? { kind: 'node', id: 'starter_input' }
              : null
            commitDefinition(definition, {
              label: t('editor.history.applyStarter'),
              selectionBefore: selection,
              selectionAfter: nextSelection,
            })
            setSelection(nextSelection)
            window.requestAnimationFrame(() => {
              canvasRef.current?.restoreSelection(nextSelection)
              if (nextSelection !== null && !hasInspectorRail) setModalSurface('inspector')
            })
          }}
        />

        <UnsavedChangesGuard dirtyRef={unsafeNavigationRef} />
      </div>
    </ManagedLiveRegionProvider>
  )
}

function isWorkflowAccessLoss(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 403 || error.status === 404)
}
