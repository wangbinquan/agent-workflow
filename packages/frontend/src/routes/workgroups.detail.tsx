// RFC-225 — workgroup detail studio with one versioned autosave writer.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ulid } from 'ulid'
import type {
  SaveWorkgroupReceipt,
  WorkgroupDetail,
  WorkgroupDraftSnapshot,
} from '@agent-workflow/shared'
import { WORKGROUP_NAME_RE, workgroupLaunchReadiness } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { AclPanel } from '@/components/AclPanel'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { RenameDialog } from '@/components/RenameDialog'
import { UnsavedChangesGuard } from '@/components/split/UnsavedChangesGuard'
import {
  WorkgroupContextPanel,
  type WorkgroupPanelState,
  type WorkgroupTransientDraftState,
} from '@/components/workgroup/WorkgroupContextPanel'
import { WorkgroupDraftStatus } from '@/components/workgroup/WorkgroupDraftStatus'
import { WorkgroupMemberGallery } from '@/components/workgroup/WorkgroupMemberGallery'
import { useOwnedEditScope } from '@/hooks/useOwnedEditScope'
import { useActor } from '@/hooks/useActor'
import { useWorkgroupAutosave, type WorkgroupSaveContext } from '@/hooks/useWorkgroupAutosave'
import { useWorkgroupSync } from '@/hooks/useWorkgroupSync'
import {
  editScopeReducer,
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
} from '@/lib/workgroup-form'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/workgroups/$name',
  component: WorkgroupDetailPage,
  remountDeps: ({ params }) => params,
})

function focusCardButton(key: string): void {
  document
    .querySelector<HTMLElement>(`[data-member-key="${CSS.escape(key)}"] .workgroup-card__open`)
    ?.focus()
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
      member.agentId === other.agentId &&
      member.agentName === other.agentName &&
      member.userId === other.userId &&
      member.displayName === other.displayName &&
      member.roleDesc === other.roleDesc
    )
  })

const cleanTransient: WorkgroupTransientDraftState = {
  dirty: false,
  valid: true,
  discard: () => undefined,
}

function settleScope<T>(
  state: EditScopeState<T>,
  submittedRevision: number,
  persisted: T,
  semanticEqual: EditScopeSemanticEqual<T>,
): EditScopeState<T> {
  const draft = state.revision === submittedRevision ? persisted : state.draft
  return {
    ...state,
    baseline: persisted,
    draft,
    dirty: !semanticEqual(draft, persisted),
    validity: 'valid',
    staleRemote: undefined,
    submitError: undefined,
  }
}

function WorkgroupDetailPage() {
  const { name } = Route.useParams()
  const query = useQuery<WorkgroupDetail>({
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
      routeName={name}
      initial={query.data}
      observed={query.data}
      queryError={query.error}
      refetch={() => query.refetch().then((result) => result.data)}
    />
  )
}

export function WorkgroupEditor(props: {
  routeName: string
  initial: WorkgroupDetail
  observed: WorkgroupDetail
  queryError: unknown
  refetch: () => Promise<WorkgroupDetail | undefined>
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const actor = useActor()
  const config = useOwnedEditScope(workgroupToConfigDraft(props.initial))
  const members = useOwnedEditScope(
    workgroupToMembersState(props.initial),
    workgroupMembersSemanticEqual,
  )
  const [panel, setPanel] = useState<WorkgroupPanelState>({ kind: 'config' })
  const [focusOn, setFocusOn] = useState<'field' | 'title' | 'none'>('field')
  const panelRef = useRef(panel)
  panelRef.current = panel
  const transientRef = useRef(cleanTransient)
  const [transient, setTransient] = useState(cleanTransient)
  const resumeAutosaveRef = useRef<() => void>(() => undefined)
  const dirtyRef = useRef<string | null>(null)
  const busyRef = useRef(false)
  const lastSettledScopeRevisionRef = useRef({
    version: props.initial.version,
    snapshotHash: props.initial.snapshotHash,
  })

  const built = buildCompositeUpdatePayload(config.state.draft, members.state.draft, props.initial)
  const blockReason = transient.dirty
    ? ('transient-member' as const)
    : !built.ok
      ? ('invalid' as const)
      : null

  const reportTransient = useCallback((next: WorkgroupTransientDraftState) => {
    const wasDirty = transientRef.current.dirty
    transientRef.current = next
    setTransient((current) =>
      current.dirty === next.dirty && current.valid === next.valid ? current : next,
    )
    if (wasDirty && !next.dirty) queueMicrotask(() => resumeAutosaveRef.current())
  }, [])

  const publishDetail = useCallback(
    (detail: WorkgroupDetail) => {
      queryClient.setQueryData(['workgroups', props.routeName], detail)
      queryClient.setQueryData(['workgroups', detail.name], detail)
      queryClient.setQueryData(['workgroups', detail.id], detail)
      void queryClient.invalidateQueries({ queryKey: ['workgroups'], exact: true })
    },
    [props.routeName, queryClient],
  )

  const settleReceipt = useCallback(
    (receipt: SaveWorkgroupReceipt, context: WorkgroupSaveContext | undefined) => {
      const submitted = context?.membersSubmitted as WorkgroupMembersState | undefined
      const reconciled =
        submitted === undefined
          ? null
          : reconcileWorkgroupSaveResponse(receipt.snapshot, submitted, receipt.workgroup)
      const persistedConfig =
        reconciled?.ok === true ? reconciled.config : workgroupToConfigDraft(receipt.workgroup)
      const persistedMembers =
        reconciled?.ok === true ? reconciled.members : workgroupToMembersState(receipt.workgroup)

      if (context === undefined) {
        config.replace(
          settleScope(
            config.ref.current,
            config.ref.current.revision,
            persistedConfig,
            config.semanticEqual,
          ),
        )
        members.replace(
          settleScope(
            members.ref.current,
            members.ref.current.revision,
            persistedMembers,
            members.semanticEqual,
          ),
        )
      } else {
        config.replace(
          settleScope(
            config.ref.current,
            context.configRevision,
            persistedConfig,
            config.semanticEqual,
          ),
        )
        members.replace(
          settleScope(
            members.ref.current,
            context.membersRevision,
            persistedMembers,
            members.semanticEqual,
          ),
        )
      }
      lastSettledScopeRevisionRef.current = receipt.revision
      publishDetail(receipt.workgroup)
    },
    [config, members, publishDetail],
  )

  const [connection, setConnection] = useState({ connected: false, connectionEpoch: 0 })
  const [copyIntent, setCopyIntent] = useState<WorkgroupDraftSnapshot | null>(null)
  const [copyName, setCopyName] = useState('')
  const [copyDescription, setCopyDescription] = useState('')
  const copyTriggerRef = useRef<HTMLButtonElement | null>(null)
  const controller = useWorkgroupAutosave({
    initial: props.initial,
    blockReason,
    connected: connection.connected,
    connectionEpoch: connection.connectionEpoch,
    onReceipt: settleReceipt,
    onRemoteDetail: publishDetail,
    onIntent: (intent) => {
      if (intent.type !== 'save-copy') return
      setCopyIntent(intent.snapshot)
      setCopyName(intent.suggestedName.slice(0, 128))
      setCopyDescription(intent.snapshot.description)
    },
  })
  const { remoteInaccessible } = controller
  const sync = useWorkgroupSync({
    workgroupId: props.initial.id,
    currentVersion: controller.state.serverRevision.version,
    inFlightMutationId: controller.inFlightMutationId,
    onFrame: controller.remoteFrame,
  })

  useEffect(() => {
    setConnection((current) =>
      current.connected === sync.connected && current.connectionEpoch === sync.connectionEpoch
        ? current
        : { connected: sync.connected, connectionEpoch: sync.connectionEpoch },
    )
  }, [sync.connected, sync.connectionEpoch])

  useEffect(() => {
    controller.remoteDetail(props.observed)
    if (
      props.observed.version === lastSettledScopeRevisionRef.current.version &&
      props.observed.snapshotHash === lastSettledScopeRevisionRef.current.snapshotHash
    ) {
      return
    }
    if (config.ref.current.dirty || members.ref.current.dirty || transientRef.current.dirty) {
      return
    }
    config.replace(
      editScopeReducer(config.ref.current, {
        type: 'discard',
        baseline: workgroupToConfigDraft(props.observed),
      }),
    )
    members.replace(
      editScopeReducer(
        members.ref.current,
        { type: 'discard', baseline: workgroupToMembersState(props.observed) },
        members.semanticEqual,
      ),
    )
    lastSettledScopeRevisionRef.current = {
      version: props.observed.version,
      snapshotHash: props.observed.snapshotHash,
    }
    // Controller callbacks and ref-backed scope owners are stable; the query
    // receipt is the only observation trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.observed])

  useEffect(() => {
    if (
      controller.state.phase !== 'clean' ||
      props.observed.version !== controller.state.serverRevision.version ||
      props.observed.snapshotHash !== controller.state.serverRevision.snapshotHash ||
      (lastSettledScopeRevisionRef.current.version === props.observed.version &&
        lastSettledScopeRevisionRef.current.snapshotHash === props.observed.snapshotHash) ||
      (!config.ref.current.dirty && !members.ref.current.dirty)
    ) {
      return
    }
    transientRef.current.discard()
    transientRef.current = cleanTransient
    setTransient(cleanTransient)
    config.replace(
      editScopeReducer(config.ref.current, {
        type: 'discard',
        baseline: workgroupToConfigDraft(props.observed),
      }),
    )
    members.replace(
      editScopeReducer(
        members.ref.current,
        { type: 'discard', baseline: workgroupToMembersState(props.observed) },
        members.semanticEqual,
      ),
    )
    lastSettledScopeRevisionRef.current = {
      version: props.observed.version,
      snapshotHash: props.observed.snapshotHash,
    }
  }, [
    config,
    controller.state.phase,
    controller.state.serverRevision.snapshotHash,
    controller.state.serverRevision.version,
    members,
    props.observed,
  ])

  useEffect(() => {
    if (isAccessLoss(props.queryError)) remoteInaccessible(props.queryError)
  }, [props.queryError, remoteInaccessible])

  useEffect(() => {
    const serverName = controller.state.server.name
    if (controller.state.phase !== 'clean' || serverName === props.routeName) return
    void navigate({
      to: '/workgroups/$name',
      params: { name: serverName },
      replace: true,
    })
  }, [controller.state.phase, controller.state.server.name, navigate, props.routeName])

  function applyValidity(
    configState: EditScopeState<WorkgroupConfigDraft>,
    memberState: EditScopeState<WorkgroupMembersState>,
  ) {
    const candidate = buildCompositeUpdatePayload(
      configState.draft,
      memberState.draft,
      props.initial,
    )
    const errorKeys = candidate.ok ? [] : Object.keys(candidate.errors)
    const configInvalid =
      errorKeys.includes('mode') ||
      errorKeys.includes('maxRounds') ||
      errorKeys.some((key) => !key.startsWith('member-') && key !== 'leader')
    const membersInvalid =
      errorKeys.includes('leader') || errorKeys.some((key) => key.startsWith('member-'))
    return {
      configState: editScopeReducer(configState, {
        type: 'validity',
        validity: configInvalid ? 'invalid' : 'valid',
        ...(configInvalid ? { firstInvalidTarget: 'workgroup-config' } : {}),
      }),
      membersState: editScopeReducer(memberState, {
        type: 'validity',
        validity: membersInvalid ? 'invalid' : 'valid',
        ...(membersInvalid ? { firstInvalidTarget: 'workgroup-members' } : {}),
      }),
      candidate,
    }
  }

  function commitPrepared(prepared: ReturnType<typeof applyValidity>, immediate: boolean): void {
    if (!prepared.candidate.ok || transientRef.current.dirty) return
    controller.commit(
      prepared.candidate.payload,
      {
        configRevision: prepared.configState.revision,
        membersRevision: prepared.membersState.revision,
        configWasDirty: prepared.configState.dirty,
        membersWasDirty: prepared.membersState.dirty,
        membersSubmitted: prepared.membersState.draft,
      },
      { immediate },
    )
  }

  function editDrafts(
    next: { config?: WorkgroupConfigDraft; members?: WorkgroupMembersState },
    immediate = false,
  ): void {
    let configState = config.ref.current
    let memberState = members.ref.current
    if (next.config !== undefined) {
      configState = editScopeReducer(configState, { type: 'edit', draft: next.config })
    }
    if (next.members !== undefined) {
      memberState = editScopeReducer(
        memberState,
        { type: 'edit', draft: next.members },
        members.semanticEqual,
      )
    }
    const prepared = applyValidity(configState, memberState)
    config.replace(prepared.configState)
    members.replace(prepared.membersState)
    commitPrepared(prepared, immediate)
  }

  resumeAutosaveRef.current = () => {
    const prepared = applyValidity(config.ref.current, members.ref.current)
    config.replace(prepared.configState)
    members.replace(prepared.membersState)
    commitPrepared(prepared, true)
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

  function closePanel(): void {
    const previous = panelRef.current
    applyPanel({ kind: 'config' })
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
    else applyPanel({ kind: 'member', key })
  }

  function onSetLeader(key: string): void {
    editDrafts({ members: setLeader(members.ref.current.draft, key) }, true)
  }

  async function onRemoveMember(key: string): Promise<void> {
    const current = members.ref.current.draft
    const index = current.members.findIndex((member) => member.key === key)
    const next = removeMember(current, key)
    applyPanel({ kind: 'config' })
    editDrafts({ members: next }, true)
    const neighbor = next.members[Math.min(Math.max(index, 0), next.members.length - 1)]
    if (neighbor !== undefined) setTimeout(() => focusCardButton(neighbor.key), 0)
  }

  async function onAddMember(row: WorkgroupMemberRowState): Promise<void> {
    editDrafts({ members: addMember(members.ref.current.draft, row) }, true)
    applyPanel({ kind: 'member', key: row.key }, 'title')
  }

  const del = useMutation({
    mutationFn: async (confirm: string) => {
      const saved = await controller.ensureSaved()
      if (!controller.isSavedDraftCurrent(saved)) throw new Error('workgroup changed before delete')
      await api.deleteJson(`/api/workgroups/${encodeURIComponent(saved.snapshot.name)}`, {
        confirm,
        expectedVersion: saved.server.version,
        clientMutationId: ulid(),
      })
    },
    onSuccess: () => {
      dirtyRef.current = null
      busyRef.current = false
      void queryClient.invalidateQueries({ queryKey: ['workgroups'] })
      void navigate({ to: '/workgroups' })
    },
    onError: () => {
      busyRef.current = false
    },
  })

  const launch = useMutation({
    mutationFn: async () => {
      const saved = await controller.ensureSaved()
      if (!controller.isSavedDraftCurrent(saved)) throw new Error('workgroup changed before launch')
      return saved
    },
    onSuccess: (saved) => {
      dirtyRef.current = null
      busyRef.current = false
      void navigate({
        to: '/tasks/new',
        search: {
          kind: 'workgroup',
          workgroup: saved.snapshot.name,
          workgroupVersion: saved.server.version,
        },
      })
    },
    onError: () => {
      busyRef.current = false
    },
  })

  const copy = useMutation({
    mutationFn: async () => {
      if (copyIntent === null) throw new Error('missing workgroup copy draft')
      return api.post<WorkgroupDetail>('/api/workgroups', {
        ...copyIntent,
        name: copyName,
        description: copyDescription,
      })
    },
    onSuccess: (created) => {
      dirtyRef.current = null
      busyRef.current = false
      publishDetail(created)
      setCopyIntent(null)
      void navigate({ to: '/workgroups/$name', params: { name: created.name } })
    },
    onError: () => {
      busyRef.current = false
    },
  })

  const [headerSurface, setHeaderSurface] = useState<
    'actions' | 'rename' | 'acl' | 'delete' | null
  >(null)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null)
  const renameNameValid =
    newName.length > 0 && newName.length <= 128 && WORKGROUP_NAME_RE.test(newName)
  const renameCanSave =
    renameNameValid &&
    (newName !== config.state.draft.name || newDescription !== config.state.draft.description)

  const readiness = workgroupLaunchReadiness({
    mode: config.state.draft.mode,
    leaderMemberId: members.state.draft.leaderKey,
    members: members.state.draft.members.map((member) => ({
      id: member.key,
      memberType: member.memberType,
    })),
  })
  const configErrors = built.ok ? {} : built.errors
  const unsafe =
    config.state.dirty ||
    members.state.dirty ||
    transient.dirty ||
    controller.state.phase !== 'clean'
  const busy =
    controller.state.phase === 'saving' ||
    controller.state.phase === 'reconciling' ||
    del.isPending ||
    launch.isPending ||
    copy.isPending
  dirtyRef.current = unsafe ? props.routeName : null
  busyRef.current = busy
  const deleteDisabled =
    blockReason !== null ||
    controller.state.phase !== 'clean' ||
    controller.state.transport === 'offline' ||
    del.isPending ||
    launch.isPending
  const launchDisabled =
    blockReason !== null ||
    controller.state.transport === 'offline' ||
    controller.state.phase === 'error' ||
    controller.state.phase === 'conflict' ||
    controller.state.phase === 'inaccessible' ||
    controller.state.phase === 'deleted' ||
    del.isPending ||
    launch.isPending

  return (
    <div className="page page--split">
      <PageHeader
        className="editor-page-header editor-page-header--workgroup"
        title={config.state.draft.name || props.routeName}
        meta={
          <>
            <code>{props.initial.id}</code> · v{controller.state.serverRevision.version}
          </>
        }
        actions={
          <>
            <button
              type="button"
              className="btn btn--primary"
              disabled={!readiness.ready || launchDisabled}
              onClick={() => {
                busyRef.current = true
                launch.mutate()
              }}
              data-testid="workgroup-launch-button"
            >
              {launch.isPending ? t('common.saving') : t('workgroups.launchButton')}
            </button>
            <button
              ref={moreTriggerRef}
              type="button"
              className="btn"
              onClick={() => setHeaderSurface('actions')}
              data-testid="workgroup-more-actions"
            >
              {t('editor.nodeActions.more')}
            </button>
          </>
        }
      />

      {[del.error, launch.error, copy.error]
        .filter((error) => error !== null && error !== undefined)
        .map((error, index) => (
          <ErrorBanner error={error} key={index} />
        ))}

      {props.queryError !== null &&
        props.queryError !== undefined &&
        !isAccessLoss(props.queryError) && (
          <ErrorBanner error={props.queryError} onRetry={() => void props.refetch()} />
        )}

      <div className="workgroup-editor-status-stack" data-testid="workgroup-status-stack">
        <WorkgroupDraftStatus
          state={controller.state}
          onRetryNow={controller.retry}
          onSaveCopy={controller.requestCopy}
          onLoadRemote={async () => {
            transientRef.current.discard()
            transientRef.current = cleanTransient
            setTransient(cleanTransient)
            await controller.confirmLoadRemote()
          }}
          onOverwriteRemote={controller.confirmOverwrite}
          onReturnToList={() => void navigate({ to: '/workgroups' })}
        />

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
      </div>

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
            onClick={() => applyPanel({ kind: 'config' })}
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
              group={props.observed}
              membersState={members.state.draft}
              selectedKey={effectivePanel.kind === 'member' ? effectivePanel.key : null}
              onSelectCard={onSelectCard}
            />
          </div>
          <div className="workgroup-rail__add">
            <button
              type="button"
              className="btn btn--sm"
              onClick={() => applyPanel({ kind: 'add', memberType: 'agent' })}
              data-testid="workgroup-add-agent-member"
            >
              {t('workgroups.addAgentMember')}
            </button>
            {config.state.draft.mode !== 'dynamic_workflow' && (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => applyPanel({ kind: 'add', memberType: 'human' })}
                data-testid="workgroup-add-human-member"
              >
                {t('workgroups.addHumanMember')}
              </button>
            )}
          </div>
        </aside>
        <section className="split__detail" data-testid="split-detail">
          <WorkgroupContextPanel
            group={{ ...props.observed, mode: config.state.draft.mode }}
            panel={effectivePanel}
            focusOn={focusOn}
            applying={controller.state.phase === 'saving'}
            applyError={controller.state.phase === 'error' ? controller.state.error : null}
            onClose={closePanel}
            configDraft={config.state.draft}
            configErrors={configErrors}
            onConfigChange={(next, meta) => editDrafts({ config: next }, meta?.immediate ?? false)}
            membersState={members.state.draft}
            onPatchMember={(key, patch) =>
              editDrafts({ members: patchMember(members.ref.current.draft, key, patch) })
            }
            onSetLeader={onSetLeader}
            onRemoveMember={onRemoveMember}
            onAddMember={onAddMember}
            onTransientDraftState={reportTransient}
          />
        </section>
      </div>

      <Dialog
        open={headerSurface === 'actions'}
        onClose={() => setHeaderSurface(null)}
        title={t('workgroups.actionsTitle')}
        triggerRef={moreTriggerRef}
        data-testid="workgroup-actions-dialog"
      >
        <div className="workflow-editor-action-list">
          <button
            type="button"
            className="workflow-editor-action-list__item"
            disabled={
              controller.state.phase === 'inaccessible' || controller.state.phase === 'deleted'
            }
            onClick={() => {
              setNewName(config.ref.current.draft.name)
              setNewDescription(config.ref.current.draft.description)
              setHeaderSurface('rename')
            }}
            data-testid="workgroup-rename-button"
          >
            <strong>{t('workgroups.renameButton')}</strong>
            <span>{t('workgroups.renameActionHint')}</span>
          </button>
          {actor.data !== null && actor.data !== undefined && actor.data.source !== 'daemon' && (
            <button
              type="button"
              className="workflow-editor-action-list__item"
              disabled={
                controller.state.phase === 'inaccessible' || controller.state.phase === 'deleted'
              }
              onClick={() => setHeaderSurface('acl')}
              data-testid="workgroup-acl-button"
            >
              <strong>{t('acl.title')}</strong>
              <span>{t('workgroups.aclActionHint')}</span>
            </button>
          )}
          <button
            type="button"
            className="workflow-editor-action-list__item workflow-editor-action-list__item--danger"
            disabled={deleteDisabled}
            onClick={() => setHeaderSurface('delete')}
            data-testid="workgroup-delete-button"
          >
            <strong>{t('common.delete')}</strong>
            <span>{t('workgroups.deleteActionHint')}</span>
          </button>
        </div>
      </Dialog>

      <Dialog
        open={headerSurface === 'acl'}
        onClose={() => setHeaderSurface(null)}
        title={t('acl.title')}
        triggerRef={moreTriggerRef}
        data-testid="workgroup-acl-dialog"
      >
        <AclPanel
          resourceBaseUrl={`/api/workgroups/${encodeURIComponent(controller.state.server.name)}`}
          invalidateKey={['workgroups']}
          onSaved={() => setHeaderSurface(null)}
          onCancel={() => setHeaderSurface(null)}
        />
      </Dialog>

      <ConfirmDialog
        open={headerSurface === 'delete'}
        onClose={() => setHeaderSurface(null)}
        title={t('common.deleteConfirm.title', { name: controller.state.server.name })}
        description={t('common.deleteConfirm.body')}
        confirmLabel={t('common.delete')}
        tone="danger"
        triggerRef={moreTriggerRef}
        confirmInput={{
          expected: controller.state.server.name,
          label: t('common.deleteConfirm.inputLabel', {
            name: controller.state.server.name,
          }),
          placeholder: controller.state.server.name,
        }}
        onConfirm={(context) => {
          busyRef.current = true
          return del.mutateAsync(context?.typedConfirm ?? '')
        }}
      />

      <RenameDialog
        open={headerSurface === 'rename'}
        onClose={() => setHeaderSurface(null)}
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
        pending={false}
        onSave={() => {
          if (!renameCanSave) return
          editDrafts(
            {
              config: {
                ...config.ref.current.draft,
                name: newName,
                description: newDescription,
              },
            },
            true,
          )
          setHeaderSurface(null)
        }}
        triggerRef={moreTriggerRef}
      />

      <RenameDialog
        open={copyIntent !== null}
        onClose={() => setCopyIntent(null)}
        title={t('editor.draftStatus.saveCopy')}
        testidPrefix="workgroup-copy"
        nameLabel={t('workgroups.fieldName')}
        nameHint={t('workgroups.fieldNameHint')}
        namePattern={WORKGROUP_NAME_RE.source}
        name={copyName}
        onNameChange={setCopyName}
        descriptionLabel={t('workgroups.fieldDescription')}
        description={copyDescription}
        onDescriptionChange={setCopyDescription}
        descriptionMaxLength={4096}
        canSave={
          copyIntent !== null &&
          copyName.length > 0 &&
          copyName.length <= 128 &&
          WORKGROUP_NAME_RE.test(copyName)
        }
        pending={copy.isPending}
        submitError={copy.error === null ? undefined : String(copy.error)}
        onSave={() => {
          busyRef.current = true
          copy.mutate()
        }}
        triggerRef={copyTriggerRef}
      />

      <UnsavedChangesGuard
        dirtyRef={dirtyRef}
        busyRef={busyRef}
        onDiscard={() => {
          if (busyRef.current) return false
          transientRef.current.discard()
          config.replace(editScopeReducer(config.ref.current, { type: 'discard' }))
          members.replace(
            editScopeReducer(members.ref.current, { type: 'discard' }, members.semanticEqual),
          )
          transientRef.current = cleanTransient
          dirtyRef.current = null
          return true
        }}
      />
    </div>
  )
}

function isAccessLoss(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.status === 404)
}
