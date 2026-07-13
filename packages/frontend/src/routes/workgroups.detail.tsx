// RFC-164 PR-1 → RFC-168 — /workgroups/$name: the workgroup STUDIO.
// Members are the page's main zone (card gallery); a sticky context panel on
// the right shows the group CONFIG while nothing is selected and switches to
// the selected member's editor (alias / role / leader / remove + read-only
// capability card) on card click. Adding a member uses the same panel spot.
//
//   - Config stays a draft saved via the header Save (PUT passes the group's
//     CURRENT members through unchanged — full-document replace). Saving no
//     longer navigates away; the button flashes "saved" only when the draft
//     was not edited while the PUT was in flight (design F2).
//   - Member operations commit immediately: read current → pure change
//     (lib/workgroup-form ops) → PUT, single-flight (design F5); the fresh
//     row is written back eagerly so the gallery re-renders from server truth.
// Header keeps the /mcps/$name action shape: ACL + Save + Delete, plus the
// Rename button + <RenameDialog> (name + description edited together, POST
// …/rename saves both atomically — PUT cannot change the name, and description
// now rides along here rather than on the config form, 2026-07-13).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UpdateWorkgroup, Workgroup } from '@agent-workflow/shared'
import { WORKGROUP_NAME_RE, workgroupLaunchReadiness } from '@agent-workflow/shared'
import { useNavigate } from '@tanstack/react-router'
import { api } from '@/api/client'
import { useDraftFromQuery } from '@/hooks/useDraftFromQuery'
import { describeApiError } from '@/i18n'
import { DetailHeaderActions } from '@/components/DetailHeaderActions'
import { RenameDialog } from '@/components/RenameDialog'
import { LoadingState } from '@/components/LoadingState'
import {
  WorkgroupContextPanel,
  type WorkgroupPanelState,
} from '@/components/workgroup/WorkgroupContextPanel'
import { WorkgroupMemberGallery } from '@/components/workgroup/WorkgroupMemberGallery'
import {
  addMember,
  buildConfigUpdatePayload,
  buildMembersUpdatePayload,
  patchMember,
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
})

/** Focus a member card's open-button (title). Cards live in the gallery and
 *  never unmount on panel changes, so a synchronous lookup is safe. */
function focusCardButton(key: string): void {
  document
    .querySelector<HTMLElement>(`[data-member-key="${CSS.escape(key)}"] .workgroup-card__open`)
    ?.focus()
}

/** The backend's full-replace PUT REGENERATES every member id
 *  (services/workgroups.ts §1.2), so after ANY member operation the selected
 *  key must be re-resolved in the fresh row by wire-normalized content (F4:
 *  the wire trims displayName/agentName; displayName is unique per group so
 *  the composite key cannot collide). */
function findMemberKeyByContent(
  fresh: Workgroup,
  probe: { memberType: 'agent' | 'human'; agentName: string; userId: string; displayName: string },
): string | null {
  const hit = workgroupToMembersState(fresh).members.find(
    (m) =>
      m.memberType === probe.memberType &&
      (probe.memberType === 'agent'
        ? m.agentName === probe.agentName.trim()
        : m.userId === probe.userId) &&
      m.displayName === probe.displayName.trim(),
  )
  return hit?.key ?? null
}

function WorkgroupDetailPage() {
  const { t } = useTranslation()
  const { name } = Route.useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const query = useQuery<Workgroup>({
    queryKey: ['workgroups', name],
    queryFn: ({ signal }) =>
      api.get(`/api/workgroups/${encodeURIComponent(name)}`, undefined, signal),
  })
  const group = query.data

  // RFC-151 PR-4 — hydrate-once CONFIG draft (members live outside the draft:
  // the gallery renders them straight from the query row, so member PUTs can
  // never clobber pending config edits).
  const {
    draft: form,
    setDraft: setForm,
    loaded,
  } = useDraftFromQuery(group, workgroupToConfigDraft)

  // ---------------------------------------------------------------------
  // Panel selection (RFC-168 §1.3). `focusOn` steers the panel's mount focus:
  // card click → first field; add-success handoff → panel title (F8).
  // ---------------------------------------------------------------------
  const [panel, setPanel] = useState<WorkgroupPanelState>({ kind: 'config' })
  const [focusOn, setFocusOn] = useState<'field' | 'title' | 'none'>('field')
  // onSuccess callbacks need the CURRENT panel + the PRE-WRITE group row
  // (Codex impl-gate P1: re-resolve the selection after a config save).
  const panelRef = useRef(panel)
  panelRef.current = panel
  const groupRef = useRef(group)
  groupRef.current = group

  // A concurrently-removed member collapses the panel back to config at
  // render time (no effect needed — derived state).
  const effectivePanel: WorkgroupPanelState =
    panel.kind === 'member' && group !== undefined && !group.members.some((m) => m.id === panel.key)
      ? { kind: 'config' }
      : panel

  function putWorkgroup(payload: UpdateWorkgroup): Promise<Workgroup> {
    return api.put<Workgroup>(`/api/workgroups/${encodeURIComponent(name)}`, payload)
  }

  // ---------------------------------------------------------------------
  // Config save — stays on the page; "saved" flashes ONLY when the draft was
  // not edited while the PUT was in flight (F2: never lie about new edits).
  // ---------------------------------------------------------------------
  const [savedFlash, setSavedFlash] = useState(false)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const submittedDraftRef = useRef<WorkgroupConfigDraft | undefined>(undefined)
  const formRef = useRef(form)
  formRef.current = form
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

  const save = useMutation({
    mutationFn: putWorkgroup,
    onSuccess: (w) => {
      // Codex impl-gate P1 — a config save passes members through but the
      // backend REGENERATES their ids; without re-resolving, an open member
      // editor would read as "member deleted", collapse to config and drop
      // its unsaved draft. Resolve against the PRE-WRITE row (groupRef holds
      // it until the cache write below re-renders).
      const p = panelRef.current
      if (p.kind === 'member' && groupRef.current !== undefined) {
        const prev = workgroupToMembersState(groupRef.current).members.find((m) => m.key === p.key)
        const nextKey = prev !== undefined ? findMemberKeyByContent(w, prev) : null
        // Content identity is unchanged, so the member body neither remounts
        // nor re-steals focus; a null hit falls through to the derived
        // config collapse (member truly gone).
        if (nextKey !== null) setPanel({ kind: 'member', key: nextKey })
      }
      void qc.invalidateQueries({ queryKey: ['workgroups'] })
      qc.setQueryData(['workgroups', name], w)
      // Draft objects are replaced on every edit — reference equality means
      // "untouched since submit".
      if (formRef.current === submittedDraftRef.current) {
        clearSavedFlash()
        setSavedFlash(true)
        savedTimer.current = setTimeout(() => setSavedFlash(false), 2000)
      }
    },
  })

  // Member-card operations share one PUT channel (single-flight — every write
  // entry point disables while `membersMut.isPending`); the fresh row is
  // written back eagerly so the gallery re-renders from server truth.
  const membersMut = useMutation({
    mutationFn: putWorkgroup,
    onSuccess: (w) => {
      void qc.invalidateQueries({ queryKey: ['workgroups'] })
      qc.setQueryData(['workgroups', name], w)
    },
  })

  /** Resolves the fresh server row on success, null on validation/API error
   *  (surfaced via membersMut.error in the header row + panel error line). */
  async function applyMembers(next: WorkgroupMembersState): Promise<Workgroup | null> {
    if (group === undefined) return null
    const built = buildMembersUpdatePayload(group, next)
    if (!built.ok) return null
    try {
      return await membersMut.mutateAsync(built.payload)
    } catch {
      return null
    }
  }

  // F5 — error ownership: switching panels resets the shared mutation error
  // so a failure never lingers on an unrelated member's panel. Internal
  // post-settlement moves (reselect after PUT / remove) use this directly —
  // the render closure's isPending may still read true right after an await,
  // so they must bypass the freeze guard below.
  function applyPanel(
    next: WorkgroupPanelState,
    focus: 'field' | 'title' | 'none' = 'field',
  ): void {
    membersMut.reset()
    setFocusOn(focus)
    setPanel(next)
  }

  // Codex impl-gate P1 — while a member PUT is IN FLIGHT the panel is frozen
  // for USER entry points (card click / close / Esc / add buttons):
  // `reset()` clears isPending without cancelling the request, so switching
  // mid-flight would re-arm every write entry and allow a second concurrent
  // full-replace built from a stale row (lost-update on reorder).
  function changePanel(
    next: WorkgroupPanelState,
    focus: 'field' | 'title' | 'none' = 'field',
  ): void {
    if (membersMut.isPending) return
    applyPanel(next, focus)
  }

  function closePanel(): void {
    const prev = panel
    changePanel({ kind: 'config' })
    // F8 — focus returns to the trigger: the member's card, or the add button.
    if (prev.kind === 'member') focusCardButton(prev.key)
    else if (prev.kind === 'add') {
      document
        .querySelector<HTMLElement>(
          `[data-testid="workgroup-add-${prev.memberType === 'agent' ? 'agent' : 'human'}-member"]`,
        )
        ?.focus()
    }
  }

  function onSelectCard(key: string): void {
    if (panel.kind === 'member' && panel.key === key) {
      closePanel() // same card toggles back to config
      return
    }
    changePanel({ kind: 'member', key })
  }

  /** PUT regenerates member ids — keep the edited member selected by
   *  re-resolving its fresh key from content (`findMemberKeyByContent`).
   *  focus 'none': the panel body remounts under the new key; stealing focus
   *  back to the first field after a button click would be jarring. */
  function reselectAfterPut(
    fresh: Workgroup,
    probe: {
      memberType: 'agent' | 'human'
      agentName: string
      userId: string
      displayName: string
    },
  ): void {
    const nextKey = findMemberKeyByContent(fresh, probe)
    if (nextKey !== null) applyPanel({ kind: 'member', key: nextKey }, 'none')
    else applyPanel({ kind: 'config' })
  }

  async function onSaveMember(
    key: string,
    patch: { displayName: string; roleDesc: string },
  ): Promise<boolean> {
    if (group === undefined) return false
    const state = workgroupToMembersState(group)
    const row = state.members.find((m) => m.key === key)
    const fresh = await applyMembers(patchMember(state, key, patch))
    if (fresh === null) return false
    if (row !== undefined) reselectAfterPut(fresh, { ...row, displayName: patch.displayName })
    return true
  }

  function onSetLeader(key: string): void {
    if (group === undefined) return
    const state = workgroupToMembersState(group)
    const row = state.members.find((m) => m.key === key)
    void applyMembers(setLeader(state, key)).then((fresh) => {
      if (fresh !== null && row !== undefined) reselectAfterPut(fresh, row)
    })
  }

  async function onRemoveMember(key: string): Promise<void> {
    if (group === undefined) return
    const state = workgroupToMembersState(group)
    const idx = state.members.findIndex((m) => m.key === key)
    const fresh = await applyMembers(removeMember(state, key))
    if (fresh === null) return
    applyPanel({ kind: 'config' })
    // F8 — focus the neighbor card (same position, else the new last one).
    // Deferred one tick: the fresh row's regenerated ids only reach the DOM
    // after React re-renders from the cache write.
    const remaining = workgroupToMembersState(fresh).members
    const neighbor = remaining[Math.min(Math.max(idx, 0), remaining.length - 1)]
    if (neighbor !== undefined) setTimeout(() => focusCardButton(neighbor.key), 0)
  }

  async function onAddMember(row: WorkgroupMemberRowState): Promise<void> {
    if (group === undefined) return
    const fresh = await applyMembers(addMember(workgroupToMembersState(group), row))
    if (fresh === null) return // error shown in the panel; draft kept for retry
    // F4 — keep the NEW member selected (title-focused, F8).
    const key = findMemberKeyByContent(fresh, row)
    if (key !== null) applyPanel({ kind: 'member', key }, 'title')
    else applyPanel({ kind: 'config' })
  }

  const del = useMutation({
    mutationFn: () => api.delete(`/api/workgroups/${encodeURIComponent(name)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['workgroups'] })
      navigate({ to: '/workgroups' })
    },
  })

  // Rename dialog state — name + description edited together (2026-07-13, atomic
  // POST …/rename), then move to the new detail URL only if the name changed.
  const [renameOpen, setRenameOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDescription, setNewDescription] = useState('')
  const renameTriggerRef = useRef<HTMLButtonElement | null>(null)
  const rename = useMutation({
    mutationFn: (vars: { newName: string; description: string }): Promise<Workgroup> =>
      api.post<Workgroup>(`/api/workgroups/${encodeURIComponent(name)}/rename`, vars),
    onSuccess: (w) => {
      void qc.invalidateQueries({ queryKey: ['workgroups'] })
      qc.setQueryData(['workgroups', w.name], w)
      setRenameOpen(false)
      // Description lives on the server row; the config draft passes it through
      // (buildConfigUpdatePayload), so there's nothing to re-sync locally.
      if (w.name !== name) navigate({ to: '/workgroups/$name', params: { name: w.name } })
    },
  })
  const renameNameValid =
    newName.length > 0 && newName.length <= 128 && WORKGROUP_NAME_RE.test(newName)
  const renameCanSave =
    renameNameValid && (newName !== name || newDescription !== (group?.description ?? ''))

  // Live pre-validation — the config draft blocks Save only on real field
  // errors (决策 #21: no leader / no members are launch problems, not save
  // problems — the readiness banner communicates them instead).
  const built =
    form !== undefined && group !== undefined ? buildConfigUpdatePayload(form, group) : undefined
  const configErrors = built !== undefined && !built.ok ? built.errors : {}
  const readiness = group !== undefined ? workgroupLaunchReadiness(group) : null

  if (query.isLoading)
    return (
      <div className="page">
        <LoadingState />
      </div>
    )
  if (query.error !== null && query.error !== undefined)
    return <div className="page error-box">{describeApiError(query.error)}</div>

  return (
    <div className="page page--split">
      <DetailHeaderActions
        acl={{
          resourceBaseUrl: `/api/workgroups/${encodeURIComponent(name)}`,
          invalidateKey: ['workgroups'],
        }}
        save={{
          label: savedFlash
            ? t('workgroups.configSaved')
            : save.isPending
              ? t('common.saving')
              : t('common.save'),
          onClick: () => {
            if (built !== undefined && built.ok && form !== undefined) {
              submittedDraftRef.current = form
              save.mutate(built.payload)
            }
          },
          disabled: save.isPending || !loaded || built === undefined || !built.ok,
          title: configErrors.mode !== undefined ? t(configErrors.mode) : undefined,
          testid: 'workgroup-save-button',
        }}
        del={{
          label: t('common.delete'),
          onConfirm: () => del.mutateAsync(),
          disabled: del.isPending,
        }}
        extra={
          <>
            {/* RFC-164 PR-4: launch entry — only when the shared readiness
                oracle says the group can actually start a task. */}
            {readiness !== null && readiness.ready && (
              <Link
                to="/tasks/new"
                search={{ kind: 'workgroup', workgroup: name }}
                className="btn btn--primary"
                data-testid="workgroup-launch-button"
              >
                {t('workgroups.launchButton')}
              </Link>
            )}
            <button
              type="button"
              className="btn"
              ref={renameTriggerRef}
              onClick={() => {
                setNewName(name)
                setNewDescription(group?.description ?? '')
                setRenameOpen(true)
              }}
              data-testid="workgroup-rename-button"
            >
              {t('workgroups.renameButton')}
            </button>
          </>
        }
        errors={[save.error, del.error, membersMut.error]}
      >
        <div>
          <h1>{name}</h1>
        </div>
      </DetailHeaderActions>

      {readiness !== null && !readiness.ready && (
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
        </div>
      )}

      {group !== undefined && (
        <div className="split">
          <aside className="split__list">
            {/* RFC-171: rail head + config entry live ABOVE the scroll area
                (fixed) so the config entry never scrolls away with the cards
                (design-gate Codex#1). */}
            <div className="workgroup-rail__head">
              <span className="workgroup-rail__title">{t('workgroups.sectionMembers')}</span>
              <span className="workgroup-rail__count">{group.members.length}</span>
            </div>
            <button
              type="button"
              className={
                'split-card workgroup-config-entry' +
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
            {/* Member cards scroll here. Blank-area click deselects (desktop
                selection grammar, RFC-168 user 2026-07-11); clicks landing on
                a card ([data-member-key]) or a control are swallowed by the
                closest() guard. Keyboard users have the panel Esc. */}
            <div
              className="split__cards"
              data-testid="workgroup-member-scroll"
              onClick={(e) => {
                if (effectivePanel.kind !== 'member') return
                const target = e.target as HTMLElement
                if (target.closest('[data-member-key], button, a, input') !== null) return
                closePanel()
              }}
            >
              <WorkgroupMemberGallery
                group={group}
                selectedKey={effectivePanel.kind === 'member' ? effectivePanel.key : null}
                onSelectCard={onSelectCard}
              />
            </div>
            {/* Add entries pinned at the rail foot (mirrors the /agents
                "+ new" position; RFC-167 hides add-human in dynamic mode). */}
            <div className="workgroup-rail__add">
              <button
                type="button"
                className="btn btn--sm"
                disabled={membersMut.isPending}
                onClick={() => changePanel({ kind: 'add', memberType: 'agent' })}
                data-testid="workgroup-add-agent-member"
              >
                {t('workgroups.addAgentMember')}
              </button>
              {group.mode !== 'dynamic_workflow' && (
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={membersMut.isPending}
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
              group={group}
              panel={effectivePanel}
              focusOn={focusOn}
              applying={membersMut.isPending}
              applyError={membersMut.error}
              onClose={closePanel}
              configDraft={form}
              configErrors={configErrors}
              onConfigChange={(next) => {
                if (savedFlash) clearSavedFlash()
                setForm(next)
              }}
              onSaveMember={onSaveMember}
              onSetLeader={onSetLeader}
              onRemoveMember={onRemoveMember}
              onAddMember={onAddMember}
            />
          </section>
        </div>
      )}

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
        onSave={() => rename.mutate({ newName, description: newDescription })}
        triggerRef={renameTriggerRef}
      />
    </div>
  )
}
