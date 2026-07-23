// RFC-168 T1/T3/T4 — the detail page's right-hand CONTEXT PANEL. Three states
// (design §1.3):
//   config — the workgroup config form (route-owned draft + composite Save All)
//   member — the selected member's editor: alias / role joins that same
//            composite draft; set-leader / remove also submit one full replace;
//            plus a read-only capability card + a jump to
//            /agents/$name (D2: "编辑 agent" = editing the MEMBER; the agent
//            definition itself is edited on its own page)
//   add    — the add-member form (same MemberFields the mid-run dialogs use)
//
// Focus contract (design §6, F8): on entering member/add the first input (or
// the title, after an add-success handoff) receives focus; Esc is handled on
// the panel container — not document — so it never races a Dialog (F9).

import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from '@tanstack/react-router'
import type { Workgroup } from '@agent-workflow/shared'
import { AgentCapabilityCard } from '@/components/agent/AgentCapabilityCard'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Field, TextInput } from '@/components/Form'
import { StatusChip } from '@/components/StatusChip'
import { useAgentsList } from '@/hooks/useAgentsList'
import { useUserLookup } from '@/hooks/useUserLookup'
import { ErrorBanner } from '@/components/ErrorBanner'
import {
  validateMemberDraft,
  type WorkgroupConfigDraft,
  type WorkgroupMemberRowState,
  type WorkgroupMembersState,
} from '@/lib/workgroup-form'
import {
  AgentMemberFields,
  HumanMemberFields,
  useAgentMemberDraft,
  useHumanMemberDraft,
  type AgentMemberDraft,
  type HumanMemberDraft,
} from './MemberFields'
import { WorkgroupForm } from './WorkgroupForm'

export type WorkgroupPanelState =
  | { kind: 'config' }
  | { kind: 'member'; key: string }
  | { kind: 'add'; memberType: 'agent' | 'human' }

export interface WorkgroupTransientDraftState {
  dirty: boolean
  valid: boolean
  discard: () => void
}

export interface WorkgroupContextPanelProps {
  group: Workgroup
  /** Effective state — the page already collapsed dangling member keys. */
  panel: WorkgroupPanelState
  /** Panel-mount focus target (F8): 'field' on card activation, 'title'
   *  after an add-success handoff (the user just typed the alias —
   *  re-focusing it would be odd), 'none' after save/set-leader re-selection
   *  (a verified receipt can remap regenerated server ids; stealing focus from
   *  the clicked button would be jarring). */
  focusOn: 'field' | 'title' | 'none'
  applying: boolean
  applyError: unknown
  onClose: () => void
  configDraft: WorkgroupConfigDraft | undefined
  configErrors: Record<string, string>
  onConfigChange: (d: WorkgroupConfigDraft, meta?: { immediate?: boolean }) => void
  membersState: WorkgroupMembersState
  onPatchMember: (key: string, patch: { displayName?: string; roleDesc?: string }) => void
  onSetLeader: (key: string) => void
  onRemoveMember: (key: string) => Promise<void>
  onAddMember: (row: WorkgroupMemberRowState) => Promise<void>
  onTransientDraftState: (state: WorkgroupTransientDraftState) => void
}

export function WorkgroupContextPanel(props: WorkgroupContextPanelProps) {
  const { t } = useTranslation()
  const { panel } = props
  const state = props.membersState
  const row =
    panel.kind === 'member' ? (state.members.find((m) => m.key === panel.key) ?? null) : null

  // Add-command drafts remain mounted in the context-panel owner even when
  // the user switches/ closes/ Escapes away. They report into the route's
  // composite registry so route leave cannot silently drop an unfinished add.
  const addAgentDraft = useAgentMemberDraft(state.members)
  const addHumanDraft = useHumanMemberDraft(state.members)
  const resetAgentDraft = addAgentDraft.reset
  const resetHumanDraft = addHumanDraft.reset
  const { onTransientDraftState } = props
  const discardTransient = useCallback(() => {
    resetAgentDraft()
    resetHumanDraft()
  }, [resetAgentDraft, resetHumanDraft])
  const transientDirty = addAgentDraft.dirty || addHumanDraft.dirty
  const transientValid =
    (!addAgentDraft.dirty || !addAgentDraft.invalid) &&
    (!addHumanDraft.dirty || !addHumanDraft.invalid)
  useEffect(() => {
    onTransientDraftState({
      dirty: transientDirty,
      valid: transientValid,
      discard: discardTransient,
    })
  }, [discardTransient, onTransientDraftState, transientDirty, transientValid])

  const titleRef = useRef<HTMLHeadingElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)

  // Focus on entering member/add (or switching between members) — keyed by
  // the panel CONTENT identity so re-renders inside one state (including
  // server-id regeneration on sibling writes) never re-steal focus.
  const identity =
    panel.kind === 'member'
      ? `member:${row === null ? 'gone' : row.key}`
      : panel.kind === 'add'
        ? `add:${panel.memberType}`
        : 'config'
  useEffect(() => {
    if (panel.kind === 'config' || props.focusOn === 'none') return
    if (props.focusOn === 'title') {
      titleRef.current?.focus()
      return
    }
    bodyRef.current
      ?.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]), textarea')
      ?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity])

  const title =
    panel.kind === 'config'
      ? t('workgroups.panelConfigTitle')
      : panel.kind === 'member'
        ? (row?.displayName ?? '')
        : panel.memberType === 'agent'
          ? t('workgroups.addAgentTitle')
          : t('workgroups.addHumanTitle')

  return (
    <aside
      id="workgroup-context-panel"
      className="workgroup-panel"
      aria-label={t('workgroups.panelAria')}
      data-testid="workgroup-context-panel"
      onKeyDown={(e) => {
        // F9 — panel-scoped Esc: fires only while focus lives INSIDE the
        // panel, so Dialog-layer Esc (rename / delete confirm, focus-trapped
        // elsewhere) never lands here.
        if (e.key === 'Escape' && panel.kind !== 'config') {
          e.stopPropagation()
          props.onClose()
        }
      }}
    >
      <div className="workgroup-panel__head">
        <h2 className="workgroup-panel__title" tabIndex={-1} ref={titleRef}>
          {title}
        </h2>
        {panel.kind !== 'config' && (
          <button
            type="button"
            className="btn btn--sm"
            onClick={props.onClose}
            data-testid="workgroup-panel-close"
          >
            {t('workgroups.panelClose')}
          </button>
        )}
      </div>

      <div className="workgroup-panel__body" ref={bodyRef}>
        {panel.kind === 'config' && props.configDraft !== undefined && (
          <WorkgroupForm
            value={props.configDraft}
            onChange={props.onConfigChange}
            errors={props.configErrors}
            /* RFC-207 — from the DRAFT roster, not the server receipt: while a
               human add/removal is in flight (or failed), the two disagree and
               the gate/budget controls must match what the next save submits. */
            hasHumanMember={state.members.some((m) => m.memberType === 'human')}
          />
        )}

        {panel.kind === 'member' && row !== null && (
          <MemberBody
            key={row.key}
            row={row}
            others={state.members.filter((m) => m.key !== row.key)}
            isLeader={state.leaderKey === row.key}
            showLeaderControls={props.group.mode === 'leader_worker'}
            applying={props.applying}
            applyError={props.applyError}
            onChange={(patch) => props.onPatchMember(row.key, patch)}
            onSetLeader={() => props.onSetLeader(row.key)}
            onRemove={() => props.onRemoveMember(row.key)}
          />
        )}

        {panel.kind === 'add' &&
          (panel.memberType === 'agent' ? (
            <AddAgentBody
              key="add-agent"
              draft={addAgentDraft}
              applying={props.applying}
              applyError={props.applyError}
              onSubmit={props.onAddMember}
              onCancel={props.onClose}
            />
          ) : (
            <AddHumanBody
              key="add-human"
              draft={addHumanDraft}
              applying={props.applying}
              applyError={props.applyError}
              onSubmit={props.onAddMember}
              onCancel={props.onClose}
            />
          ))}
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// member state — alias/role editor + actions + read-only capability card
// ---------------------------------------------------------------------------

function MemberBody(props: {
  row: WorkgroupMemberRowState
  others: ReadonlyArray<Pick<WorkgroupMemberRowState, 'displayName'>>
  isLeader: boolean
  showLeaderControls: boolean
  applying: boolean
  applyError: unknown
  onChange: (patch: { displayName?: string; roleDesc?: string }) => void
  onSetLeader: () => void
  onRemove: () => Promise<void>
}) {
  const { t } = useTranslation()
  const { row } = props
  const errors = validateMemberDraft(row, props.others)
  const agentsList = useAgentsList({ enabled: row.memberType === 'agent' })
  const agent =
    row.memberType === 'agent' ? agentsList.agents.find((a) => a.name === row.agentName) : undefined
  const users = useUserLookup([row.memberType === 'human' ? row.userId : null])
  const reference =
    row.memberType === 'agent' ? row.agentName : (users.get(row.userId)?.displayName ?? row.userId)

  return (
    <div className="workgroup-panel__member">
      <div className="workgroup-panel__meta">
        <span className="chip chip--tight">
          {row.memberType === 'agent'
            ? t('workgroups.memberTypeAgent')
            : t('workgroups.memberTypeHuman')}
        </span>
        {props.isLeader && props.showLeaderControls && (
          <StatusChip kind="info" size="sm" data-testid="workgroup-leader-badge">
            {t('workgroups.leaderBadge')}
          </StatusChip>
        )}
        <span className="workgroup-card__ref" title={reference}>
          {reference}
        </span>
      </div>

      <Field
        label={t('workgroups.memberFieldDisplayName')}
        required
        hint={t('workgroups.memberDisplayNamePlaceholder')}
        error={errors.displayName !== undefined ? t(errors.displayName) : undefined}
      >
        <TextInput
          value={row.displayName}
          onChange={(displayName) => props.onChange({ displayName })}
          maxLength={64}
          data-testid="workgroup-member-displayname-input"
        />
      </Field>
      <Field label={t('workgroups.memberFieldRole')} hint={t('workgroups.memberRolePlaceholder')}>
        <TextInput
          value={row.roleDesc}
          onChange={(roleDesc) => props.onChange({ roleDesc })}
          maxLength={2048}
          data-testid="workgroup-member-role-input"
        />
      </Field>

      <div className="workgroup-panel__actions">
        {props.showLeaderControls && row.memberType === 'agent' && !props.isLeader && (
          <button
            type="button"
            className="btn btn--sm"
            onClick={props.onSetLeader}
            data-testid={`workgroup-set-leader-${row.displayName}`}
          >
            {t('workgroups.setLeaderButton')}
          </button>
        )}
        <ConfirmButton
          label={t('workgroups.memberRemove')}
          onConfirm={props.onRemove}
          variant="danger"
          size="sm"
        />
      </div>

      {props.applyError != null && (
        <ErrorBanner error={props.applyError} testid="workgroup-panel-error" />
      )}

      {row.memberType === 'agent' && (
        <div className="workgroup-panel__capability">
          {agent !== undefined ? (
            <AgentCapabilityCard agent={agent} />
          ) : agentsList.loaded ? (
            <StatusChip kind="warn" size="sm" data-testid="workgroup-panel-agent-missing">
              {t('workgroups.agentMissing')}
            </StatusChip>
          ) : null}
          {agent !== undefined && (
            <Link
              to="/agents/$name"
              params={{ name: row.agentName }}
              className="workgroup-panel__agent-link"
              data-testid="workgroup-edit-agent-link"
            >
              {t('workgroups.editAgentDefinition')}
            </Link>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// add state — same MemberFields the mid-run dialog shells use
// ---------------------------------------------------------------------------

interface AddBodyProps {
  applying: boolean
  applyError: unknown
  onSubmit: (row: WorkgroupMemberRowState) => Promise<void>
  onCancel: () => void
}

function AddActions(props: {
  confirmTestid: string
  invalid: boolean
  applying: boolean
  applyError: unknown
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  return (
    <>
      <div className="workgroup-panel__actions">
        <button
          type="button"
          className="btn btn--sm btn--primary"
          disabled={props.invalid}
          onClick={props.onConfirm}
          data-testid={props.confirmTestid}
        >
          {t('workgroups.addMemberConfirm')}
        </button>
        <button type="button" className="btn btn--sm" onClick={props.onCancel}>
          {t('common.cancel')}
        </button>
      </div>
      {props.applyError != null && (
        <ErrorBanner error={props.applyError} testid="workgroup-panel-error" />
      )}
    </>
  )
}

function AddAgentBody(props: AddBodyProps & { draft: AgentMemberDraft }) {
  const { draft } = props
  return (
    <div className="workgroup-panel__add" data-testid="workgroup-panel-add">
      <AgentMemberFields draft={draft} />
      <AddActions
        confirmTestid="workgroup-add-agent-confirm"
        invalid={draft.invalid}
        applying={props.applying}
        applyError={props.applyError}
        onConfirm={() => {
          const row = draft.buildRow()
          draft.reset()
          void props.onSubmit(row)
        }}
        onCancel={props.onCancel}
      />
    </div>
  )
}

function AddHumanBody(props: AddBodyProps & { draft: HumanMemberDraft }) {
  const { draft } = props
  return (
    <div className="workgroup-panel__add" data-testid="workgroup-panel-add">
      <HumanMemberFields draft={draft} />
      <AddActions
        confirmTestid="workgroup-add-human-confirm"
        invalid={draft.invalid}
        applying={props.applying}
        applyError={props.applyError}
        onConfirm={() => {
          const row = draft.buildRow()
          if (row !== null) {
            draft.reset()
            void props.onSubmit(row)
          }
        }}
        onCancel={props.onCancel}
      />
    </div>
  )
}
