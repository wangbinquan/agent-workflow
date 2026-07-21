// RFC-164/RFC-168 studio, hardened by RFC-201 T3.3.
//
// The workgroup endpoint is a full-document replace and regenerates every
// member id. Config and the complete member collection therefore live in two
// route-owned edit scopes but share one composite save transaction. Member
// panels are controlled views over that route draft: switching cards, Close,
// Escape and blank-area deselection never unmount the owned edit.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { UpdateWorkgroup, Workgroup } from '@agent-workflow/shared'
import { WORKGROUP_NAME_RE, workgroupLaunchReadiness } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { DetailHeaderActions } from '@/components/DetailHeaderActions'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { RenameDialog } from '@/components/RenameDialog'
import { UnsavedChangesGuard } from '@/components/split/UnsavedChangesGuard'
import {
  WorkgroupContextPanel,
  type WorkgroupPanelState,
  type WorkgroupTransientDraftState,
} from '@/components/workgroup/WorkgroupContextPanel'
import { WorkgroupMemberGallery } from '@/components/workgroup/WorkgroupMemberGallery'
import { describeApiError } from '@/i18n'
import {
  aggregateEditScopeStates,
  createEditScopeState,
  defaultEditScopeSemanticEqual,
  editScopeReducer,
  type EditScopeEvent,
  type EditScopeSemanticEqual,
  type EditScopeState,
} from '@/lib/edit-scope'
import {
  addMember,
  buildCompositeUpdatePayload,
  patchMember,
  reconcileWorkgroupSaveResponse,
  removeMember,
  setLeader,
  workgroupToConfigDraft,
  workgroupToMembersState,
  type WorkgroupConfigDraft,
  type WorkgroupMemberRowState,
  type WorkgroupMembersState,
  type WorkgroupSaveReconcileResult,
} from '@/lib/workgroup-form'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workgroups/$name',
  component: WorkgroupDetailPage,
  // A different resource is the only automatic draft reset boundary.
  remountDeps: ({ params }) => params,
})

let saveRequestSequence = 0

function nextSaveRequestId(name: string): string {
  saveRequestSequence += 1
  return `workgroup:${name}:${Date.now()}:${saveRequestSequence}`
}

function focusCardButton(key: string): void {
  document
    .querySelector<HTMLElement>(`[data-member-key="${CSS.escape(key)}"] .workgroup-card__open`)
    ?.focus()
}

interface ScopeController<T> {
  state: EditScopeState<T>
  ref: RefObject<EditScopeState<T>>
  dispatch: (event: EditScopeEvent<T>) => EditScopeState<T>
  replace: (next: EditScopeState<T>) => EditScopeState<T>
  semanticEqual: EditScopeSemanticEqual<T>
}

function useOwnedEditScope<T>(
  initial: T,
  semanticEqual: EditScopeSemanticEqual<T> = defaultEditScopeSemanticEqual,
): ScopeController<T> {
  const [state, setState] = useState(() => createEditScopeState(initial))
  const ref = useRef(state)
  ref.current = state

  const replace = useCallback((next: EditScopeState<T>) => {
    ref.current = next
    setState(next)
    return next
  }, [])
  const dispatch = useCallback(
    (event: EditScopeEvent<T>) => replace(editScopeReducer(ref.current, event, semanticEqual)),
    [replace, semanticEqual],
  )
  return { state, ref, dispatch, replace, semanticEqual }
}

const workgroupMembersSemanticEqual: EditScopeSemanticEqual<WorkgroupMembersState> = (
  left,
  right,
) =>
  left.leaderKey === right.leaderKey &&
  left.members.length === right.members.length &&
  left.members.every((member, index) => {
    const other = right.members[index]
    return (
      other !== undefined &&
      member.key === other.key &&
      member.memberType === other.memberType &&
      member.agentName === other.agentName &&
      member.userId === other.userId &&
      member.displayName === other.displayName &&
      member.roleDesc === other.roleDesc
    )
  })

interface SaveAttempt {
  requestId: string
  configRevision: number
  membersRevision: number
  configSubmitted: WorkgroupConfigDraft
  membersSubmitted: WorkgroupMembersState
  configWasDirty: boolean
  membersWereDirty: boolean
}

interface SaveVariables {
  attempt: SaveAttempt
  payload: UpdateWorkgroup
}

interface SaveReceipt {
  response: Workgroup
  reconciled: Extract<WorkgroupSaveReconcileResult, { ok: true }>
}

class WorkgroupReceiptMismatchError extends Error {
  constructor(
    readonly response: Workgroup,
    readonly reason: string,
  ) {
    super(`workgroup save response did not match the submitted document (${reason})`)
    this.name = 'WorkgroupReceiptMismatchError'
  }
}

function settlePassiveParticipant<T>(
  state: EditScopeState<T>,
  submittedRevision: number,
  persisted: T,
  semanticEqual: EditScopeSemanticEqual<T>,
): EditScopeState<T> {
  const caughtUp = state.revision === submittedRevision
  const draft = caughtUp ? persisted : state.draft
  return {
    ...state,
    baseline: persisted,
    draft,
    dirty: !semanticEqual(draft, persisted),
    staleRemote: undefined,
    submitError: undefined,
  }
}

function remapMatchingRemoteMembers(
  local: WorkgroupMembersState,
  remote: Workgroup,
): WorkgroupMembersState {
  const built = buildCompositeUpdatePayload(workgroupToConfigDraft(remote), local, remote)
  if (!built.ok) return workgroupToMembersState(remote)
  const reconciled = reconcileWorkgroupSaveResponse(built.payload, local, remote)
  return reconciled.ok ? reconciled.members : workgroupToMembersState(remote)
}

function WorkgroupDetailPage() {
  const { name } = Route.useParams()
  const query = useQuery<Workgroup>({
    queryKey: ['workgroups', name],
    queryFn: ({ signal }) =>
      api.get(`/api/workgroups/${encodeURIComponent(name)}`, undefined, signal),
  })

  if (query.data === undefined) {
    if (query.error !== null && query.error !== undefined) {
      return (
        <div className="page">
          <PageHeader title={name} />
          <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
        </div>
      )
    }
    return (
      <div className="page">
        <PageHeader title={name} />
        <LoadingState />
      </div>
    )
  }

  return (
    <WorkgroupEditor
      key={query.data.id}
      name={name}
      group={query.data}
      queryError={query.error}
      refetch={() => query.refetch().then((result) => result.data)}
    />
  )
}

function WorkgroupEditor(props: {
  name: string
  group: Workgroup
  queryError: unknown
  refetch: () => Promise<Workgroup | undefined>
}) {
  const { t } = useTranslation()
  const { name } = props
  const navigate = useNavigate()
  const qc = useQueryClient()
  const config = useOwnedEditScope(workgroupToConfigDraft(props.group))
  const members = useOwnedEditScope(
    workgroupToMembersState(props.group),
    workgroupMembersSemanticEqual,
  )
  const [panel, setPanel] = useState<WorkgroupPanelState>({ kind: 'config' })
  const [focusOn, setFocusOn] = useState<'field' | 'title' | 'none'>('field')
  const panelRef = useRef(panel)
  panelRef.current = panel
  const lastDirectReceiptRef = useRef<Workgroup | null>(null)
  const initialGroupRef = useRef(props.group)
  const remoteEpochRef = useRef(0)
  const ambiguousAttemptRef = useRef<SaveVariables | null>(null)
  // TanStack's isPending is render-lagged; this ref closes the same-tick
  // double-click window before a second full-replace can be prepared.
  const saveInFlightRef = useRef(false)

  const cleanTransient = useRef<WorkgroupTransientDraftState>({
    dirty: false,
    valid: true,
    discard: () => undefined,
  })
  const transientRef = useRef(cleanTransient.current)
  const [transient, setTransient] = useState(cleanTransient.current)
  const reportTransient = useCallback((next: WorkgroupTransientDraftState) => {
    transientRef.current = next
    setTransient((current) =>
      current.dirty === next.dirty && current.valid === next.valid ? current : next,
    )
  }, [])

  const [savedFlash, setSavedFlash] = useState(false)
  const [authoritativeConflict, setAuthoritativeConflict] = useState<Workgroup | null>(null)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (savedTimer.current !== null) clearTimeout(savedTimer.current)
    },
    [],
  )
  function clearSavedFlash(): void {
    if (savedTimer.current !== null) clearTimeout(savedTimer.current)
    savedTimer.current = null
    setSavedFlash(false)
  }

  function applyValidity(
    configState: EditScopeState<WorkgroupConfigDraft>,
    membersState: EditScopeState<WorkgroupMembersState>,
  ): {
    configState: EditScopeState<WorkgroupConfigDraft>
    membersState: EditScopeState<WorkgroupMembersState>
    built: ReturnType<typeof buildCompositeUpdatePayload>
  } {
    const built = buildCompositeUpdatePayload(configState.draft, membersState.draft, props.group)
    const errorKeys = built.ok ? [] : Object.keys(built.errors)
    const unknownError = errorKeys.some(
      (key) =>
        key !== 'mode' && key !== 'maxRounds' && key !== 'leader' && !key.startsWith('member-'),
    )
    const configInvalid =
      unknownError || errorKeys.includes('mode') || errorKeys.includes('maxRounds')
    const membersInvalid =
      unknownError ||
      errorKeys.includes('leader') ||
      errorKeys.some((key) => key.startsWith('member-'))
    return {
      configState: editScopeReducer(configState, {
        type: 'validity',
        validity: configInvalid ? 'invalid' : 'valid',
        ...(configInvalid ? { firstInvalidTarget: 'workgroup-config' } : {}),
      }),
      membersState: editScopeReducer(membersState, {
        type: 'validity',
        validity: membersInvalid ? 'invalid' : 'valid',
        ...(membersInvalid ? { firstInvalidTarget: 'workgroup-members' } : {}),
      }),
      built,
    }
  }

  function editDrafts(options: {
    config?: WorkgroupConfigDraft
    members?: WorkgroupMembersState
  }): {
    configState: EditScopeState<WorkgroupConfigDraft>
    membersState: EditScopeState<WorkgroupMembersState>
    built: ReturnType<typeof buildCompositeUpdatePayload>
  } {
    let configState = config.ref.current
    let membersState = members.ref.current
    if (options.config !== undefined) {
      configState = editScopeReducer(configState, { type: 'edit', draft: options.config })
    }
    if (options.members !== undefined) {
      membersState = editScopeReducer(
        membersState,
        { type: 'edit', draft: options.members },
        workgroupMembersSemanticEqual,
      )
    }
    const validated = applyValidity(configState, membersState)
    config.replace(validated.configState)
    members.replace(validated.membersState)
    clearSavedFlash()
    return validated
  }

  function settleSuccess<T>(
    controller: ScopeController<T>,
    wasDirty: boolean,
    requestId: string,
    submittedRevision: number,
    persisted: T,
  ): EditScopeState<T> {
    const next = wasDirty
      ? editScopeReducer(
          controller.ref.current,
          {
            type: 'submit-success',
            requestId,
            submittedRevision,
            persisted,
          },
          controller.semanticEqual,
        )
      : settlePassiveParticipant(
          controller.ref.current,
          submittedRevision,
          persisted,
          controller.semanticEqual,
        )
    return controller.replace(next)
  }

  function settleError<T>(
    controller: ScopeController<T>,
    wasDirty: boolean,
    requestId: string,
    submittedRevision: number,
    error: unknown,
    ambiguous: boolean,
  ): void {
    if (!wasDirty) return
    controller.dispatch({
      type: 'submit-error',
      requestId,
      submittedRevision,
      error,
      outcome: ambiguous ? 'ambiguous' : 'definitive',
    })
  }

  /**
   * Settle an outcome-unknown full-replace from a read issued specifically for
   * that attempt.  A fresh read is authoritative even when it differs from the
   * submitted document: that mismatch means the attempt did not become the
   * current server value and must unlock as a normal dirty-vs-remote state.
   */
  function reconcileAmbiguousAttempt(variables: SaveVariables, remote: Workgroup): boolean {
    if (ambiguousAttemptRef.current !== variables) return false

    const issuedEpoch = ++remoteEpochRef.current
    const reconciled = reconcileWorkgroupSaveResponse(
      variables.payload,
      variables.attempt.membersSubmitted,
      remote,
    )
    const remoteConfig = reconciled.ok ? reconciled.config : workgroupToConfigDraft(remote)
    const remoteMembers = reconciled.ok
      ? reconciled.members
      : remapMatchingRemoteMembers(members.ref.current.baseline, remote)
    const { attempt } = variables
    setAuthoritativeConflict(reconciled.ok ? null : remote)

    config.dispatch({
      type: 'remote-read',
      remote: remoteConfig,
      issuedEpoch,
      reconciliation: {
        requestId: attempt.requestId,
        submittedRevision: attempt.configRevision,
      },
    })
    members.dispatch({
      type: 'remote-read',
      remote: remoteMembers,
      issuedEpoch,
      reconciliation: {
        requestId: attempt.requestId,
        submittedRevision: attempt.membersRevision,
      },
    })
    ambiguousAttemptRef.current = null
    lastDirectReceiptRef.current = remote
    save.reset()
    return true
  }

  const save = useMutation<SaveReceipt, unknown, SaveVariables>({
    mutationFn: async (variables) => {
      const response = await api.put<Workgroup>(
        `/api/workgroups/${encodeURIComponent(name)}`,
        variables.payload,
      )
      const reconciled = reconcileWorkgroupSaveResponse(
        variables.payload,
        variables.attempt.membersSubmitted,
        response,
      )
      if (!reconciled.ok) {
        throw new WorkgroupReceiptMismatchError(response, reconciled.reason)
      }
      return { response, reconciled }
    },
    onSuccess: ({ response, reconciled }, { attempt }) => {
      const configCaughtUp = config.ref.current.revision === attempt.configRevision
      const membersCaughtUp = members.ref.current.revision === attempt.membersRevision
      settleSuccess(
        config,
        attempt.configWasDirty,
        attempt.requestId,
        attempt.configRevision,
        reconciled.config,
      )
      settleSuccess(
        members,
        attempt.membersWereDirty,
        attempt.requestId,
        attempt.membersRevision,
        reconciled.members,
      )
      ambiguousAttemptRef.current = null
      setAuthoritativeConflict(null)
      lastDirectReceiptRef.current = response
      qc.setQueryData(['workgroups', name], response)
      void qc.invalidateQueries({ queryKey: ['workgroups'], exact: true })

      if (configCaughtUp && membersCaughtUp) {
        clearSavedFlash()
        setSavedFlash(true)
        savedTimer.current = setTimeout(() => setSavedFlash(false), 2000)
      }
    },
    onError: (error, variables) => {
      // 4xx proves the full-replace did not commit. Transport loss, 5xx and a
      // semantically mismatched 200 cannot prove that, so both scopes fail
      // closed and only a matching authoritative refetch may reconcile them.
      const definitive = error instanceof ApiError && error.status >= 400 && error.status < 500
      const ambiguous = !definitive
      const { attempt } = variables
      settleError(
        config,
        attempt.configWasDirty,
        attempt.requestId,
        attempt.configRevision,
        error,
        ambiguous,
      )
      settleError(
        members,
        attempt.membersWereDirty,
        attempt.requestId,
        attempt.membersRevision,
        error,
        ambiguous,
      )
      ambiguousAttemptRef.current = ambiguous ? variables : null
      if (ambiguous) {
        void props.refetch().then((remote) => {
          if (remote !== undefined) reconcileAmbiguousAttempt(variables, remote)
        })
      }
    },
  })

  function startSave(
    options: {
      membersDraft?: WorkgroupMembersState
      allowTransient?: boolean
    } = {},
  ): Promise<boolean> {
    if (saveInFlightRef.current || ambiguousAttemptRef.current !== null) {
      return Promise.resolve(false)
    }
    const prepared =
      options.membersDraft === undefined
        ? applyValidity(config.ref.current, members.ref.current)
        : editDrafts({ members: options.membersDraft })
    if (options.membersDraft === undefined) {
      config.replace(prepared.configState)
      members.replace(prepared.membersState)
    }
    if (!prepared.built.ok) return Promise.resolve(false)
    if (transientRef.current.dirty && options.allowTransient !== true) return Promise.resolve(false)
    if (!prepared.configState.dirty && !prepared.membersState.dirty) return Promise.resolve(false)

    const requestId = nextSaveRequestId(name)
    const attempt: SaveAttempt = {
      requestId,
      configRevision: prepared.configState.revision,
      membersRevision: prepared.membersState.revision,
      configSubmitted: prepared.configState.draft,
      membersSubmitted: prepared.membersState.draft,
      configWasDirty: prepared.configState.dirty,
      membersWereDirty: prepared.membersState.dirty,
    }
    if (attempt.configWasDirty) {
      config.replace(
        editScopeReducer(prepared.configState, {
          type: 'begin-submit',
          requestId,
          submittedRevision: attempt.configRevision,
        }),
      )
    }
    if (attempt.membersWereDirty) {
      members.replace(
        editScopeReducer(prepared.membersState, {
          type: 'begin-submit',
          requestId,
          submittedRevision: attempt.membersRevision,
        }),
      )
    }
    saveInFlightRef.current = true
    return save
      .mutateAsync({ attempt, payload: prepared.built.payload })
      .then(() => true)
      .catch(() => false)
      .finally(() => {
        saveInFlightRef.current = false
      })
  }

  // Clean remote rows follow. Dirty rows keep their local draft and expose the
  // remote as stale. A matching ambiguous attempt is the only read allowed to
  // conclude an outcome-unknown save.
  useEffect(() => {
    const remote = props.group
    if (remote === initialGroupRef.current) return
    if (remote === lastDirectReceiptRef.current) {
      lastDirectReceiptRef.current = null
      return
    }

    const ambiguous = ambiguousAttemptRef.current
    if (ambiguous !== null && reconcileAmbiguousAttempt(ambiguous, remote)) return

    const issuedEpoch = ++remoteEpochRef.current
    const remoteConfig = workgroupToConfigDraft(remote)
    const remoteMembers = remapMatchingRemoteMembers(members.ref.current.baseline, remote)

    const configHasConflict =
      config.ref.current.dirty &&
      !config.semanticEqual(remoteConfig, config.ref.current.baseline) &&
      !config.semanticEqual(remoteConfig, config.ref.current.draft)
    const membersHaveConflict =
      members.ref.current.dirty &&
      !members.semanticEqual(remoteMembers, members.ref.current.baseline) &&
      !members.semanticEqual(remoteMembers, members.ref.current.draft)
    if (configHasConflict || membersHaveConflict) setAuthoritativeConflict(remote)

    config.dispatch({ type: 'remote-read', remote: remoteConfig, issuedEpoch })
    members.dispatch({ type: 'remote-read', remote: remoteMembers, issuedEpoch })
    // Scope controllers are ref-backed and stable. The resource receipt is the
    // sole trigger; including reducer snapshots would replay one read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.group])

  const built = buildCompositeUpdatePayload(config.state.draft, members.state.draft, props.group)
  const registry = aggregateEditScopeStates([
    config.state,
    members.state,
    {
      dirty: transient.dirty,
      validity: transient.valid ? 'valid' : 'invalid',
      ...(transient.valid ? {} : { firstInvalidTarget: 'workgroup-add-member' }),
    },
  ])
  const outcomeUnknown = registry.outcomeUnknown || ambiguousAttemptRef.current !== null
  const dirtyRef = useRef<string | null>(null)
  const busyRef = useRef(false)
  const deleteInFlightRef = useRef(false)
  const renameInFlightRef = useRef(false)
  dirtyRef.current = registry.dirty ? name : null
  busyRef.current =
    save.isPending ||
    saveInFlightRef.current ||
    deleteInFlightRef.current ||
    renameInFlightRef.current ||
    outcomeUnknown

  function releaseAuxiliaryBusy(ref: RefObject<boolean>): void {
    ref.current = false
    busyRef.current =
      save.isPending ||
      saveInFlightRef.current ||
      deleteInFlightRef.current ||
      renameInFlightRef.current ||
      outcomeUnknown
  }

  const effectivePanel: WorkgroupPanelState =
    panel.kind === 'member' &&
    !members.state.draft.members.some((member) => member.key === panel.key)
      ? { kind: 'config' }
      : panel

  function applyPanel(
    next: WorkgroupPanelState,
    focus: 'field' | 'title' | 'none' = 'field',
  ): void {
    setFocusOn(focus)
    setPanel(next)
  }

  function changePanel(
    next: WorkgroupPanelState,
    focus: 'field' | 'title' | 'none' = 'field',
  ): void {
    if (saveInFlightRef.current) return
    applyPanel(next, focus)
  }

  function closePanel(): void {
    const previous = panelRef.current
    changePanel({ kind: 'config' })
    if (saveInFlightRef.current) return
    if (previous.kind === 'member') focusCardButton(previous.key)
    else if (previous.kind === 'add') {
      document
        .querySelector<HTMLElement>(
          `[data-testid="workgroup-add-${previous.memberType === 'agent' ? 'agent' : 'human'}-member"]`,
        )
        ?.focus()
    }
  }

  function onSelectCard(key: string): void {
    if (panel.kind === 'member' && panel.key === key) closePanel()
    else changePanel({ kind: 'member', key })
  }

  function onPatchMember(key: string, patch: { displayName?: string; roleDesc?: string }): void {
    editDrafts({ members: patchMember(members.ref.current.draft, key, patch) })
  }

  function onSetLeader(key: string): void {
    const next = setLeader(members.ref.current.draft, key)
    void startSave({ membersDraft: next })
  }

  async function onRemoveMember(key: string): Promise<void> {
    const current = members.ref.current.draft
    const index = current.members.findIndex((member) => member.key === key)
    const next = removeMember(current, key)
    applyPanel({ kind: 'config' })
    const saved = await startSave({ membersDraft: next })
    if (!saved) return
    const neighbor = next.members[Math.min(Math.max(index, 0), next.members.length - 1)]
    if (neighbor !== undefined) setTimeout(() => focusCardButton(neighbor.key), 0)
  }

  async function onAddMember(row: WorkgroupMemberRowState): Promise<void> {
    const next = addMember(members.ref.current.draft, row)
    applyPanel({ kind: 'member', key: row.key }, 'title')
    await startSave({ membersDraft: next, allowTransient: true })
  }

  const del = useMutation({
    mutationFn: () => api.delete(`/api/workgroups/${encodeURIComponent(name)}`),
    onSuccess: () => {
      // Self-navigation must observe a released synchronous guard token.
      releaseAuxiliaryBusy(deleteInFlightRef)
      void qc.invalidateQueries({ queryKey: ['workgroups'] })
      navigate({ to: '/workgroups' })
    },
    onSettled: () => releaseAuxiliaryBusy(deleteInFlightRef),
  })

  function startDelete(): Promise<unknown> {
    deleteInFlightRef.current = true
    busyRef.current = true
    return del.mutateAsync()
  }

  const [renameOpen, setRenameOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const renameTriggerRef = useRef<HTMLButtonElement | null>(null)
  const rename = useMutation({
    mutationFn: (variables: { newName: string; description: string }): Promise<Workgroup> =>
      api.post<Workgroup>(`/api/workgroups/${encodeURIComponent(name)}/rename`, variables),
    onSuccess: (workgroup) => {
      releaseAuxiliaryBusy(renameInFlightRef)
      void qc.invalidateQueries({ queryKey: ['workgroups'], exact: true })
      qc.setQueryData(['workgroups', workgroup.name], workgroup)
      setRenameOpen(false)
      if (workgroup.name !== name) {
        navigate({ to: '/workgroups/$name', params: { name: workgroup.name } })
      }
    },
    onSettled: () => releaseAuxiliaryBusy(renameInFlightRef),
  })

  function startRename(): void {
    renameInFlightRef.current = true
    busyRef.current = true
    rename.mutate({ newName, description: newDescription })
  }
  const renameNameValid =
    newName.length > 0 && newName.length <= 128 && WORKGROUP_NAME_RE.test(newName)
  const renameCanSave =
    renameNameValid && (newName !== name || newDescription !== props.group.description)

  const readiness = workgroupLaunchReadiness(props.group)
  const configErrors = built.ok ? {} : built.errors
  const mutationPending = save.isPending || del.isPending || rename.isPending || outcomeUnknown
  const destructiveDisabled = registry.dirty || mutationPending
  const saveDisabled =
    mutationPending ||
    outcomeUnknown ||
    !built.ok ||
    transient.dirty ||
    (!config.state.dirty && !members.state.dirty)

  function adoptAuthoritativeConflict(): void {
    if (
      authoritativeConflict === null ||
      saveInFlightRef.current ||
      save.isPending ||
      outcomeUnknown
    ) {
      return
    }
    transientRef.current.discard()
    const remoteConfig = workgroupToConfigDraft(authoritativeConflict)
    const remoteMembers = remapMatchingRemoteMembers(
      members.ref.current.baseline,
      authoritativeConflict,
    )
    config.replace(
      editScopeReducer(config.ref.current, { type: 'discard', baseline: remoteConfig }),
    )
    members.replace(
      editScopeReducer(
        members.ref.current,
        { type: 'discard', baseline: remoteMembers },
        members.semanticEqual,
      ),
    )
    transientRef.current = cleanTransient.current
    setTransient(cleanTransient.current)
    setAuthoritativeConflict(null)
    save.reset()
  }

  return (
    <div className="page page--split">
      <DetailHeaderActions
        title={name}
        acl={{
          resourceBaseUrl: `/api/workgroups/${encodeURIComponent(name)}`,
          invalidateKey: ['workgroups'],
        }}
        save={{
          label: savedFlash
            ? t('workgroups.configSaved')
            : save.isPending
              ? t('common.saving')
              : t('workgroups.saveAll'),
          onClick: () => void startSave(),
          disabled: saveDisabled,
          title: transient.dirty
            ? t('workgroups.finishAddingBeforeSave')
            : configErrors.mode !== undefined
              ? t(configErrors.mode)
              : undefined,
          testid: 'workgroup-save-button',
        }}
        del={{
          label: t('common.delete'),
          onConfirm: startDelete,
          disabled: del.isPending || destructiveDisabled,
        }}
        extra={
          <>
            {readiness.ready && (
              <Link
                to="/tasks/new"
                search={{ kind: 'workgroup', workgroup: name }}
                className="btn"
                data-testid="workgroup-launch-button"
              >
                {t('workgroups.launchButton')}
              </Link>
            )}
            <button
              type="button"
              className="btn"
              ref={renameTriggerRef}
              disabled={destructiveDisabled}
              onClick={() => {
                setNewName(name)
                setNewDescription(props.group.description)
                setRenameOpen(true)
              }}
              data-testid="workgroup-rename-button"
            >
              {t('workgroups.renameButton')}
            </button>
          </>
        }
        errors={[save.error, del.error]}
      />

      {props.queryError !== null && props.queryError !== undefined && (
        <ErrorBanner error={props.queryError} onRetry={() => void props.refetch()} />
      )}

      {authoritativeConflict !== null && (
        <NoticeBanner
          tone="warning"
          size="compact"
          title={t('settings.staleTitle')}
          action={
            <button type="button" className="btn btn--sm" onClick={adoptAuthoritativeConflict}>
              {t('settings.staleDiscard')}
            </button>
          }
        >
          {t('settings.staleBody')}
        </NoticeBanner>
      )}

      {(!readiness.ready || readiness.warnings.length > 0) && (
        <div
          className="info-box info-box--muted workgroup-readiness"
          role="status"
          data-testid="workgroup-readiness-banner"
        >
          {readiness.reasons.map((reason) => (
            <span key={reason}>
              {reason === 'no-agent-member'
                ? t('workgroups.readiness.noAgentMember')
                : t('workgroups.readiness.leaderMissing')}
            </span>
          ))}
          {readiness.warnings.map((warning) => (
            <span key={warning}>{t('workgroups.readiness.noNonLeaderWorker')}</span>
          ))}
        </div>
      )}

      <div className="split">
        <aside className="split__list">
          <div className="workgroup-rail__head">
            <span className="workgroup-rail__title">{t('workgroups.sectionMembers')}</span>
            <span className="workgroup-rail__count">{members.state.draft.members.length}</span>
          </div>
          <button
            type="button"
            className={
              'btn btn--primary workgroup-config-entry' +
              (effectivePanel.kind === 'config' ? ' is-selected' : '')
            }
            aria-expanded={effectivePanel.kind === 'config'}
            aria-controls="workgroup-context-panel"
            onClick={() => changePanel({ kind: 'config' })}
            data-testid="workgroup-config-entry"
          >
            <span className="split-card__name">
              <span aria-hidden="true">⚙ </span>
              {t('workgroups.panelConfigTitle')}
            </span>
          </button>
          <div
            className="split__cards"
            data-testid="workgroup-member-scroll"
            onClick={(event) => {
              if (effectivePanel.kind !== 'member') return
              const target = event.target as HTMLElement
              if (target.closest('[data-member-key], button, a, input') !== null) return
              closePanel()
            }}
          >
            <WorkgroupMemberGallery
              group={props.group}
              membersState={members.state.draft}
              selectedKey={effectivePanel.kind === 'member' ? effectivePanel.key : null}
              onSelectCard={onSelectCard}
            />
          </div>
          <div className="workgroup-rail__add">
            <button
              type="button"
              className="btn btn--sm"
              disabled={save.isPending}
              onClick={() => changePanel({ kind: 'add', memberType: 'agent' })}
              data-testid="workgroup-add-agent-member"
            >
              {t('workgroups.addAgentMember')}
            </button>
            {config.state.draft.mode !== 'dynamic_workflow' && (
              <button
                type="button"
                className="btn btn--sm"
                disabled={save.isPending}
                onClick={() => changePanel({ kind: 'add', memberType: 'human' })}
                data-testid="workgroup-add-human-member"
              >
                {t('workgroups.addHumanMember')}
              </button>
            )}
          </div>
        </aside>
        <section className="split__detail" data-testid="split-detail">
          <WorkgroupContextPanel
            group={{ ...props.group, mode: config.state.draft.mode }}
            panel={effectivePanel}
            focusOn={focusOn}
            applying={save.isPending}
            applyError={save.error}
            onClose={closePanel}
            configDraft={config.state.draft}
            configErrors={configErrors}
            onConfigChange={(next) => editDrafts({ config: next })}
            membersState={members.state.draft}
            membersBaseline={members.state.baseline}
            onPatchMember={onPatchMember}
            onSaveMember={() => startSave()}
            onSetLeader={onSetLeader}
            onRemoveMember={onRemoveMember}
            onAddMember={onAddMember}
            onTransientDraftState={reportTransient}
          />
        </section>
      </div>

      <RenameDialog
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        title={t('workgroups.renameTitle')}
        testidPrefix="workgroup"
        nameLabel={t('workgroups.renameField')}
        nameHint={t('workgroups.fieldNameHint')}
        namePattern={WORKGROUP_NAME_RE.source}
        name={newName}
        onNameChange={setNewName}
        descriptionLabel={t('workgroups.fieldDescription')}
        description={newDescription}
        onDescriptionChange={setNewDescription}
        descriptionMaxLength={4096}
        canSave={renameCanSave}
        pending={rename.isPending}
        submitError={
          rename.error !== null && rename.error !== undefined
            ? describeApiError(rename.error)
            : undefined
        }
        onSave={startRename}
        triggerRef={renameTriggerRef}
      />

      <UnsavedChangesGuard
        dirtyRef={dirtyRef}
        busyRef={busyRef}
        onDiscard={() => {
          if (saveInFlightRef.current || outcomeUnknown) return false
          transientRef.current.discard()
          config.replace(editScopeReducer(config.ref.current, { type: 'discard' }))
          members.replace(editScopeReducer(members.ref.current, { type: 'discard' }))
          transientRef.current = cleanTransient.current
          dirtyRef.current = null
          applyPanel({ kind: 'config' })
          return true
        }}
      />
    </div>
  )
}
