// RFC-225 — workgroup autosave coordinator.
//
// Workgroups and workflows share the same revision protocol: one immutable
// editable snapshot, one version CAS, single-flight saves, queued-latest,
// response-loss reconciliation and explicit conflict recovery. Reuse the
// proven RFC-199 controller by adapting the workgroup snapshot into its opaque
// `definition` field. The adapter supplies the workgroup canonical hash and
// workgroup HTTP transport, so workflow wire bytes never escape this module.

import { useCallback, useMemo, useRef } from 'react'
import type {
  SaveWorkgroupReceipt,
  UpdateWorkgroup,
  WorkgroupDetail,
  WorkgroupDraftSnapshot,
  WorkgroupMutationId,
  WorkgroupRevision,
  WorkgroupSnapshotHash,
  WorkflowDetail,
  WorkflowDraftSnapshot,
} from '@agent-workflow/shared'
import {
  WorkgroupDraftSnapshotSchema,
  WorkgroupRevisionSchema,
  WG_CLARIFY_BUDGET_DEFAULT,
  serializeWorkgroupEditableSnapshotV1,
} from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import {
  useWorkflowEditorDraft,
  WorkflowEnsureSavedError,
  type WorkflowEditorDraftControllerTransport,
  type WorkflowEditorDraftIntent,
} from '@/hooks/useWorkflowEditorDraft'
import type {
  WorkflowDraftFailure,
  WorkflowDraftPhase,
  WorkflowDraftTransport,
  WorkflowRemoteSnapshot,
} from '@/lib/workflow-editor-draft'
import { sha256Hex } from '@/lib/sha256'
import type { WorkgroupSyncFrame } from './useWorkgroupSync'

export type WorkgroupDraftBlockReason = 'invalid' | 'transient-member'
export type WorkgroupDraftPhase = WorkflowDraftPhase | 'blocked'

export interface WorkgroupSaveContext {
  configRevision: number
  membersRevision: number
  configWasDirty: boolean
  membersWasDirty: boolean
  /** Route-owned rows retain stable local keys across server row replacement. */
  membersSubmitted: unknown
}

export interface WorkgroupAutosaveState {
  workgroupId: string
  local: WorkgroupDraftSnapshot
  server: WorkgroupDraftSnapshot
  serverRevision: WorkgroupRevision
  revision: number
  savedRevision: number
  phase: WorkgroupDraftPhase
  transport: WorkflowDraftTransport
  error: WorkflowDraftFailure | null
  conflict: {
    reason: 'save-conflict' | 'remote-observed'
    current: WorkgroupRevision | null
    snapshot: WorkgroupDraftSnapshot | null
  } | null
  inFlight: {
    revision: number
    expectedVersion: number
    clientMutationId: WorkgroupMutationId
    snapshot: WorkgroupDraftSnapshot
    snapshotHash: WorkgroupSnapshotHash
  } | null
  queuedRevision: number | null
  blockReason: WorkgroupDraftBlockReason | null
}

export interface WorkgroupSavedDraft {
  revision: number
  server: WorkgroupRevision
  snapshot: WorkgroupDraftSnapshot
}

export interface UseWorkgroupAutosaveOptions {
  initial: WorkgroupDetail
  blockReason: WorkgroupDraftBlockReason | null
  connected?: boolean
  connectionEpoch?: number
  debounceMs?: number
  transport?: {
    save(workgroupId: string, input: UpdateWorkgroup): Promise<SaveWorkgroupReceipt>
    fetch(workgroupId: string): Promise<WorkgroupDetail>
  }
  onReceipt?: (receipt: SaveWorkgroupReceipt, context: WorkgroupSaveContext | undefined) => void
  /** Publishes authoritative GET observations to React Query without making
   *  the cache a second draft owner. */
  onRemoteDetail?: (detail: WorkgroupDetail) => void
  onIntent?: (
    intent:
      | {
          type: 'confirm-load-remote'
          current: WorkgroupRevision | null
        }
      | {
          type: 'confirm-overwrite'
          snapshot: WorkgroupDraftSnapshot
          current: WorkgroupRevision | null
        }
      | {
          type: 'save-copy'
          snapshot: WorkgroupDraftSnapshot
          suggestedName: string
        },
  ) => void
}

export interface WorkgroupAutosaveController {
  state: WorkgroupAutosaveState
  inFlightMutationId: WorkgroupMutationId | null
  commit(
    snapshot: WorkgroupDraftSnapshot,
    context: WorkgroupSaveContext,
    options?: { immediate?: boolean },
  ): void
  retry(): void
  remoteFrame(frame: WorkgroupSyncFrame): void
  remoteDetail(detail: WorkgroupDetail): void
  remoteInaccessible(error?: unknown): void
  confirmLoadRemote(): Promise<void>
  confirmOverwrite(): Promise<void>
  requestCopy(): void
  ensureSaved(options?: { signal?: AbortSignal }): Promise<WorkgroupSavedDraft>
  isSavedDraftCurrent(saved: WorkgroupSavedDraft): boolean
}

export function useWorkgroupAutosave(
  options: UseWorkgroupAutosaveOptions,
): WorkgroupAutosaveController {
  const optionsRef = useRef(options)
  optionsRef.current = options
  const blockReasonRef = useRef(options.blockReason)
  blockReasonRef.current = options.blockReason
  const contextBySnapshotRef = useRef(new Map<string, WorkgroupSaveContext>())

  const workflowTransport = useMemo<WorkflowEditorDraftControllerTransport>(
    () => ({
      save: async (workgroupId, input) => {
        const snapshot = decodeSnapshot(input.snapshot)
        let receipt: SaveWorkgroupReceipt
        try {
          receipt = await (optionsRef.current.transport ?? DEFAULT_TRANSPORT).save(workgroupId, {
            expectedVersion: input.expectedVersion,
            clientMutationId: input.clientMutationId,
            snapshot,
          })
        } catch (error) {
          throw normalizeSaveError(error)
        }
        const receiptHash = (await sha256Hex(
          new TextEncoder().encode(serializeWorkgroupEditableSnapshotV1(receipt.snapshot)),
        )) as WorkgroupSnapshotHash
        if (
          receipt.revision.workgroupId !== workgroupId ||
          receipt.clientMutationId !== input.clientMutationId ||
          receipt.requestedBaseVersion !== input.expectedVersion ||
          snapshotKey(receipt.snapshot) !== snapshotKey(snapshot) ||
          snapshotKey(projectWorkgroupDetailSnapshot(receipt.workgroup)) !==
            snapshotKey(receipt.snapshot) ||
          receipt.workgroup.id !== workgroupId ||
          receipt.workgroup.version !== receipt.revision.version ||
          receipt.workgroup.snapshotHash !== receipt.revision.snapshotHash ||
          receiptHash !== receipt.revision.snapshotHash
        ) {
          throw new Error('workgroup save receipt does not match the submitted snapshot')
        }
        const context = contextBySnapshotRef.current.get(snapshotKey(snapshot))
        optionsRef.current.onReceipt?.(receipt, context)
        return {
          clientMutationId: receipt.clientMutationId,
          requestedBaseVersion: receipt.requestedBaseVersion,
          revision: {
            workflowId: receipt.revision.workgroupId,
            version: receipt.revision.version,
            snapshotHash: receipt.revision.snapshotHash,
            updatedAt: receipt.revision.updatedAt,
          },
          snapshot: encodeSnapshot(receipt.snapshot),
          outcome: receipt.outcome,
        }
      },
      fetch: async (workgroupId) => {
        const detail = await (optionsRef.current.transport ?? DEFAULT_TRANSPORT).fetch(workgroupId)
        optionsRef.current.onRemoteDetail?.(detail)
        return detailAsWorkflowDetail(detail)
      },
    }),
    [],
  )

  const base = useWorkflowEditorDraft({
    initial: remoteAsWorkflow(options.initial),
    transport: workflowTransport,
    debounceMs: options.debounceMs,
    autosaveSuspended: options.blockReason !== null,
    connected: options.connected,
    connectionEpoch: options.connectionEpoch,
    hashSnapshot: async (snapshot) =>
      (await sha256Hex(
        new TextEncoder().encode(serializeWorkgroupEditableSnapshotV1(decodeSnapshot(snapshot))),
      )) as WorkgroupSnapshotHash,
    onIntent: (intent) => {
      const mapped = mapIntent(intent)
      if (mapped !== null) optionsRef.current.onIntent?.(mapped)
    },
  })

  const commit = useCallback(
    (
      snapshot: WorkgroupDraftSnapshot,
      context: WorkgroupSaveContext,
      commitOptions?: { immediate?: boolean },
    ): void => {
      const parsed = WorkgroupDraftSnapshotSchema.parse(snapshot)
      contextBySnapshotRef.current.set(snapshotKey(parsed), context)
      base.commit(encodeSnapshot(parsed))
      if (commitOptions?.immediate === true) base.retry()
    },
    [base],
  )

  const remoteFrame = useCallback(
    (frame: WorkgroupSyncFrame): void => {
      if (frame.type === 'workgroup.deleted') {
        base.remoteFrame({
          type: 'workflow.deleted',
          workflowId: frame.workgroupId,
          clientMutationId: frame.clientMutationId,
          deletedVersion: frame.deletedVersion,
        })
        return
      }
      base.remoteFrame({
        type: 'workflow.updated',
        workflowId: frame.workgroupId,
        clientMutationId: frame.clientMutationId,
        version: frame.version,
        snapshotHash: frame.snapshotHash,
        updatedAt: frame.updatedAt,
      })
    },
    [base],
  )

  const state = mapState(base.state, options.blockReason)
  return {
    state,
    inFlightMutationId: base.inFlightMutationId as WorkgroupMutationId | null,
    commit,
    retry: base.retry,
    remoteFrame,
    remoteDetail: (detail) => base.remoteDetail(detailAsWorkflowDetail(detail)),
    remoteInaccessible: base.remoteInaccessible,
    confirmLoadRemote: base.confirmLoadRemote,
    confirmOverwrite: base.confirmOverwrite,
    requestCopy: base.requestCopy,
    ensureSaved: async (ensureOptions) => {
      if (blockReasonRef.current !== null) {
        throw new WorkflowEnsureSavedError('unavailable', base.state.transport)
      }
      const saved = await base.ensureSaved(ensureOptions)
      return {
        revision: saved.revision,
        server: {
          workgroupId: saved.server.workflowId,
          version: saved.server.version,
          snapshotHash: saved.server.snapshotHash,
          updatedAt: saved.server.updatedAt,
        },
        snapshot: decodeSnapshot(saved.snapshot),
      }
    },
    isSavedDraftCurrent: (saved) =>
      base.isSavedDraftCurrent({
        revision: saved.revision,
        server: {
          workflowId: saved.server.workgroupId,
          version: saved.server.version,
          snapshotHash: saved.server.snapshotHash,
          updatedAt: saved.server.updatedAt,
        },
        snapshot: encodeSnapshot(saved.snapshot),
      }),
  }
}

const DEFAULT_TRANSPORT = {
  async save(workgroupId: string, input: UpdateWorkgroup): Promise<SaveWorkgroupReceipt> {
    return api.put<SaveWorkgroupReceipt>(
      `/api/workgroups/${encodeURIComponent(workgroupId)}`,
      input,
    )
  },
  async fetch(workgroupId: string): Promise<WorkgroupDetail> {
    return api.get<WorkgroupDetail>(`/api/workgroups/${encodeURIComponent(workgroupId)}`)
  },
}

const EMPTY_WORKFLOW_DEFINITION = {
  $schema_version: 4 as const,
  inputs: [],
  nodes: [],
  edges: [],
}

function encodeSnapshot(snapshot: WorkgroupDraftSnapshot): WorkflowDraftSnapshot {
  return {
    name: snapshot.name,
    description: JSON.stringify(snapshot),
    definition: EMPTY_WORKFLOW_DEFINITION,
  }
}

function decodeSnapshot(snapshot: WorkflowDraftSnapshot): WorkgroupDraftSnapshot {
  return WorkgroupDraftSnapshotSchema.parse(JSON.parse(snapshot.description))
}

function snapshotKey(snapshot: WorkgroupDraftSnapshot): string {
  return serializeWorkgroupEditableSnapshotV1(snapshot)
}

function remoteAsWorkflow(detail: WorkgroupDetail): WorkflowRemoteSnapshot {
  return {
    revision: {
      workflowId: detail.id,
      version: detail.version,
      snapshotHash: detail.snapshotHash ?? '0'.repeat(64),
      updatedAt: detail.updatedAt,
    },
    snapshot: encodeSnapshot(projectWorkgroupDetailSnapshot(detail)),
  }
}

function detailAsWorkflowDetail(detail: WorkgroupDetail): WorkflowDetail {
  return {
    id: detail.id,
    name: detail.name,
    description: JSON.stringify(projectWorkgroupDetailSnapshot(detail)),
    definition: EMPTY_WORKFLOW_DEFINITION,
    version: detail.version,
    schemaVersion: 1,
    snapshotHash: detail.snapshotHash ?? '0'.repeat(64),
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
  }
}

export function projectWorkgroupDetailSnapshot(detail: WorkgroupDetail): WorkgroupDraftSnapshot {
  const ordered = [...detail.members].sort((left, right) => left.sortOrder - right.sortOrder)
  const leader = ordered.find((member) => member.id === detail.leaderMemberId)
  const members = ordered.map((member) => {
    if (member.memberType === 'agent') {
      const agentId = member.agentId
      if (typeof agentId !== 'string' || agentId.trim().length === 0) {
        // RFC-223 PR7: agentName is a display snapshot, never a recoverable
        // identity. Refuse the remote document before it can enter autosave,
        // overwrite, or save-copy state.
        throw new Error(`workgroup agent member ${member.id} is missing canonical agentId`)
      }
      return {
        memberType: 'agent' as const,
        agentId,
        displayName: member.displayName,
        roleDesc: member.roleDesc,
      }
    }
    return {
      memberType: 'human' as const,
      userId: member.userId ?? '',
      displayName: member.displayName,
      roleDesc: member.roleDesc,
    }
  })
  return WorkgroupDraftSnapshotSchema.parse({
    name: detail.name,
    description: detail.description,
    instructions: detail.instructions,
    mode: detail.mode,
    ...(detail.mode === 'leader_worker' && leader !== undefined
      ? { leaderDisplayName: leader.displayName }
      : {}),
    switches: detail.switches,
    maxRounds: detail.maxRounds,
    completionGate: detail.completionGate,
    clarifyBudget: detail.clarifyBudget ?? WG_CLARIFY_BUDGET_DEFAULT,
    fanOut: detail.fanOut ?? false,
    members,
  })
}

function mapState(
  state: ReturnType<typeof useWorkflowEditorDraft>['state'],
  blockReason: WorkgroupDraftBlockReason | null,
): WorkgroupAutosaveState {
  const canProjectBlocked =
    blockReason !== null &&
    (state.phase === 'clean' || state.phase === 'dirty' || state.phase === 'error')
  return {
    workgroupId: state.workflowId,
    local: decodeSnapshot(state.local),
    server: decodeSnapshot(state.server),
    serverRevision: {
      workgroupId: state.serverRevision.workflowId,
      version: state.serverRevision.version,
      snapshotHash: state.serverRevision.snapshotHash,
      updatedAt: state.serverRevision.updatedAt,
    },
    revision: state.revision,
    savedRevision: state.savedRevision,
    phase: canProjectBlocked ? 'blocked' : state.phase,
    transport: state.transport,
    error: state.error,
    conflict:
      state.conflict === null
        ? null
        : {
            reason: state.conflict.reason,
            current:
              state.conflict.current === null
                ? null
                : {
                    workgroupId: state.conflict.current.workflowId,
                    version: state.conflict.current.version,
                    snapshotHash: state.conflict.current.snapshotHash,
                    updatedAt: state.conflict.current.updatedAt,
                  },
            snapshot:
              state.conflict.snapshot === null ? null : decodeSnapshot(state.conflict.snapshot),
          },
    inFlight:
      state.inFlight === null
        ? null
        : {
            revision: state.inFlight.revision,
            expectedVersion: state.inFlight.expectedVersion,
            clientMutationId: state.inFlight.clientMutationId,
            snapshot: decodeSnapshot(state.inFlight.snapshot),
            snapshotHash: state.inFlight.snapshotHash,
          },
    queuedRevision: state.queuedRevision,
    blockReason,
  }
}

function mapIntent(
  intent: WorkflowEditorDraftIntent,
): Parameters<NonNullable<UseWorkgroupAutosaveOptions['onIntent']>>[0] | null {
  if (intent.type === 'confirm-load-remote') {
    return { type: intent.type, current: mapRevision(intent.current) }
  }
  if (intent.type === 'confirm-overwrite') {
    return {
      type: intent.type,
      snapshot: decodeSnapshot(intent.snapshot),
      current: mapRevision(intent.current),
    }
  }
  return {
    type: intent.type,
    snapshot: decodeSnapshot(intent.snapshot),
    suggestedName: intent.suggestedName,
  }
}

function mapRevision(
  revision: WorkflowRemoteSnapshot['revision'] | null,
): WorkgroupRevision | null {
  return revision === null
    ? null
    : {
        workgroupId: revision.workflowId,
        version: revision.version,
        snapshotHash: revision.snapshotHash,
        updatedAt: revision.updatedAt,
      }
}

function normalizeSaveError(error: unknown): unknown {
  if (!(error instanceof ApiError) || error.status !== 409) return error
  if (error.code !== 'workgroup-version-conflict') {
    // A duplicate rename or a scheduled-reference refusal is definitive; it
    // is not a remote-document conflict with load/overwrite recovery.
    return new ApiError(422, error.code, error.message, error.details)
  }
  if (typeof error.details !== 'object' || error.details === null) return error
  const parsed = WorkgroupRevisionSchema.safeParse((error.details as { current?: unknown }).current)
  if (!parsed.success) return error
  return new ApiError(error.status, error.code, error.message, {
    current: {
      workflowId: parsed.data.workgroupId,
      version: parsed.data.version,
      snapshotHash: parsed.data.snapshotHash,
      updatedAt: parsed.data.updatedAt,
    },
  })
}
