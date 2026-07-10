// RFC-164 PR-1 — card-style member management for the /workgroups/$name page
// (multica Members-zone style). One <Card> per member: displayName title +
// type chip + reference + roleDesc, with Edit / Remove / Set-leader actions.
//
// Every operation is read-current → pure change (lib/workgroup-form ops) →
// PUT full document, driven by the page through `onApply` (resolves true on
// success so dialogs know when to close). Cards render from the SERVER row
// (`group`), never from the config draft — config edits stay pending until
// the header Save, member changes commit immediately.

import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent, UserPublic, Workgroup } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Card } from '@/components/Card'
import { ConfirmButton } from '@/components/ConfirmButton'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { Field, TextInput } from '@/components/Form'
import { StatusChip } from '@/components/StatusChip'
import { UserPicker } from '@/components/UserPicker'
import { useUserLookup } from '@/hooks/useUserLookup'
import { describeApiError } from '@/i18n'
import {
  addMember,
  deriveMemberAlias,
  makeAgentMemberRow,
  makeHumanMemberRow,
  patchMember,
  removeMember,
  sanitizeMemberAlias,
  setLeader,
  validateMemberDraft,
  workgroupToMembersState,
  type WorkgroupMembersState,
  type WorkgroupMemberRowState,
} from '@/lib/workgroup-form'

export interface WorkgroupMemberCardsProps {
  group: Workgroup
  /** A member PUT is in flight — actions disable while true. */
  applying: boolean
  /** Last member-op failure (also listed in the page header error row). */
  applyError: unknown
  /** Applies a members-state change via PUT; resolves true on success. */
  onApply: (next: WorkgroupMembersState) => Promise<boolean>
}

export function WorkgroupMemberCards(props: WorkgroupMemberCardsProps) {
  const { t } = useTranslation()
  const state = useMemo(() => workgroupToMembersState(props.group), [props.group])
  const showLeaderControls = props.group.mode === 'leader_worker'
  // Human references render the platform user's public name (ids are shown
  // only as a last-resort fallback while the lookup is in flight).
  const users = useUserLookup(
    state.members.map((m) => (m.memberType === 'human' ? m.userId : null)),
  )

  const [addAgentOpen, setAddAgentOpen] = useState(false)
  const [addHumanOpen, setAddHumanOpen] = useState(false)
  const [editKey, setEditKey] = useState<string | null>(null)

  const editRow = editKey === null ? null : (state.members.find((m) => m.key === editKey) ?? null)

  return (
    <div className="workgroup-cards-zone">
      {state.members.length === 0 && (
        <EmptyState
          size="compact"
          title={t('workgroups.membersEmpty')}
          data-testid="workgroup-members-empty"
        />
      )}

      {state.members.length > 0 && (
        <ul className="workgroup-cards">
          {state.members.map((m) => {
            const isLeader = state.leaderKey === m.key
            const reference =
              m.memberType === 'agent'
                ? m.agentName
                : (users.get(m.userId)?.displayName ?? m.userId)
            return (
              <li key={m.key}>
                <Card
                  data-testid={`workgroup-card-${m.displayName}`}
                  header={
                    <div className="workgroup-card__head">
                      <h3 className="workgroup-card__title">{m.displayName}</h3>
                      <span className="chip chip--tight">
                        {m.memberType === 'agent'
                          ? t('workgroups.memberTypeAgent')
                          : t('workgroups.memberTypeHuman')}
                      </span>
                      {showLeaderControls && isLeader && (
                        <StatusChip kind="info" size="sm" data-testid="workgroup-leader-badge">
                          {t('workgroups.leaderBadge')}
                        </StatusChip>
                      )}
                    </div>
                  }
                  footer={
                    <div className="workgroup-card__actions">
                      <button
                        type="button"
                        className="btn btn--sm"
                        disabled={props.applying}
                        onClick={() => setEditKey(m.key)}
                        data-testid={`workgroup-member-edit-${m.displayName}`}
                      >
                        {t('workgroups.memberEdit')}
                      </button>
                      {showLeaderControls && m.memberType === 'agent' && !isLeader && (
                        <button
                          type="button"
                          className="btn btn--sm"
                          disabled={props.applying}
                          onClick={() => void props.onApply(setLeader(state, m.key))}
                          data-testid={`workgroup-set-leader-${m.displayName}`}
                        >
                          {t('workgroups.setLeaderButton')}
                        </button>
                      )}
                      <ConfirmButton
                        label={t('workgroups.memberRemove')}
                        onConfirm={() => props.onApply(removeMember(state, m.key))}
                        variant="danger"
                        size="sm"
                        disabled={props.applying}
                      />
                    </div>
                  }
                >
                  <div className="workgroup-card__ref" title={reference}>
                    {reference}
                  </div>
                  {m.roleDesc !== '' && <p className="workgroup-card__role">{m.roleDesc}</p>}
                </Card>
              </li>
            )
          })}
        </ul>
      )}

      <div className="workgroup-cards__actions">
        <button
          type="button"
          className="btn btn--sm"
          disabled={props.applying}
          onClick={() => setAddAgentOpen(true)}
          data-testid="workgroup-add-agent-member"
        >
          {t('workgroups.addAgentMember')}
        </button>
        <button
          type="button"
          className="btn btn--sm"
          disabled={props.applying}
          onClick={() => setAddHumanOpen(true)}
          data-testid="workgroup-add-human-member"
        >
          {t('workgroups.addHumanMember')}
        </button>
      </div>

      {/* Dialogs mount on open so every open starts from a fresh draft. */}
      {addAgentOpen && (
        <AgentMemberDialog
          others={state.members}
          applying={props.applying}
          applyError={props.applyError}
          onClose={() => setAddAgentOpen(false)}
          onSubmit={async (row) => {
            if (await props.onApply(addMember(state, row))) setAddAgentOpen(false)
          }}
        />
      )}
      {addHumanOpen && (
        <HumanMemberDialog
          others={state.members}
          applying={props.applying}
          applyError={props.applyError}
          onClose={() => setAddHumanOpen(false)}
          onSubmit={async (row) => {
            if (await props.onApply(addMember(state, row))) setAddHumanOpen(false)
          }}
        />
      )}
      {editRow !== null && (
        <EditMemberDialog
          member={editRow}
          others={state.members.filter((m) => m.key !== editRow.key)}
          applying={props.applying}
          applyError={props.applyError}
          onClose={() => setEditKey(null)}
          onSubmit={async (patch) => {
            if (await props.onApply(patchMember(state, editRow.key, patch))) setEditKey(null)
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dialogs — the add-agent / add-human dialogs are ALSO reused by the RFC-164
// PR-5 mid-run config dialog (WorkgroupTaskConfigDialog), which stages the
// submitted row into its PUT patch instead of an immediate resource save.
// Contract: `onSubmit` receives a validated WorkgroupMemberRowState; `others`
// feeds the displayName-uniqueness check.
// ---------------------------------------------------------------------------

export interface MemberDialogCommonProps {
  others: ReadonlyArray<Pick<WorkgroupMemberRowState, 'displayName'>>
  applying: boolean
  applyError: unknown
  onClose: () => void
}

function fieldError(t: (k: string) => string, key: string | undefined): string | undefined {
  return key === undefined ? undefined : t(key)
}

export function AgentMemberDialog(
  props: MemberDialogCommonProps & { onSubmit: (row: WorkgroupMemberRowState) => Promise<void> },
) {
  const { t } = useTranslation()
  const [agentName, setAgentName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [aliasTouched, setAliasTouched] = useState(false)
  const [roleDesc, setRoleDesc] = useState('')

  const agentsQ = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: ({ signal }) => api.get('/api/agents', undefined, signal),
  })

  const errors = validateMemberDraft(
    { memberType: 'agent', agentName, userId: '', displayName },
    props.others,
  )
  const invalid = Object.keys(errors).length > 0

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t('workgroups.addAgentTitle')}
      size="sm"
      data-testid="workgroup-add-agent-dialog"
      footer={
        <>
          {props.applyError != null && (
            <span className="form-actions__error">{describeApiError(props.applyError)}</span>
          )}
          <button type="button" className="btn" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={invalid || props.applying}
            onClick={() =>
              void props.onSubmit(makeAgentMemberRow({ agentName, displayName, roleDesc }))
            }
            data-testid="workgroup-add-agent-confirm"
          >
            {t('workgroups.addMemberConfirm')}
          </button>
        </>
      }
    >
      <datalist id="workgroup-agent-names">
        {(agentsQ.data ?? []).map((a) => (
          <option key={a.name} value={a.name} />
        ))}
      </datalist>
      <Field
        label={t('workgroups.memberFieldAgent')}
        required
        hint={t('workgroups.memberAgentPlaceholder')}
        error={agentName !== '' ? fieldError(t, errors.agentName) : undefined}
      >
        <TextInput
          value={agentName}
          onChange={(v) => {
            setAgentName(v)
            // The alias defaults to the agent name until hand-edited.
            if (!aliasTouched) setDisplayName(sanitizeMemberAlias(v))
          }}
          list="workgroup-agent-names"
          data-testid="workgroup-agent-name-input"
        />
      </Field>
      <Field
        label={t('workgroups.memberFieldDisplayName')}
        required
        hint={t('workgroups.memberDisplayNamePlaceholder')}
        error={displayName !== '' ? fieldError(t, errors.displayName) : undefined}
      >
        <TextInput
          value={displayName}
          onChange={(v) => {
            setAliasTouched(true)
            setDisplayName(v)
          }}
          maxLength={64}
          data-testid="workgroup-member-displayname-input"
        />
      </Field>
      <Field label={t('workgroups.memberFieldRole')} hint={t('workgroups.memberRolePlaceholder')}>
        <TextInput
          value={roleDesc}
          onChange={setRoleDesc}
          maxLength={2048}
          data-testid="workgroup-member-role-input"
        />
      </Field>
    </Dialog>
  )
}

export function HumanMemberDialog(
  props: MemberDialogCommonProps & { onSubmit: (row: WorkgroupMemberRowState) => Promise<void> },
) {
  const { t } = useTranslation()
  const [picked, setPicked] = useState<UserPublic[]>([])
  const [displayName, setDisplayName] = useState('')
  const [aliasTouched, setAliasTouched] = useState(false)
  const [roleDesc, setRoleDesc] = useState('')
  const user = picked[0]

  const errors = validateMemberDraft(
    { memberType: 'human', agentName: '', userId: user?.id ?? '', displayName },
    props.others,
  )
  const invalid = Object.keys(errors).length > 0

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t('workgroups.addHumanTitle')}
      size="sm"
      data-testid="workgroup-add-human-dialog"
      footer={
        <>
          {props.applyError != null && (
            <span className="form-actions__error">{describeApiError(props.applyError)}</span>
          )}
          <button type="button" className="btn" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={invalid || props.applying}
            onClick={() => {
              if (user === undefined) return
              void props.onSubmit(makeHumanMemberRow({ userId: user.id, displayName, roleDesc }))
            }}
            data-testid="workgroup-add-human-confirm"
          >
            {t('workgroups.addMemberConfirm')}
          </button>
        </>
      }
    >
      <Field label={t('workgroups.memberFieldUser')} required>
        <UserPicker
          value={picked}
          single
          placeholder={t('workgroups.memberUserPlaceholder')}
          testidPrefix="workgroup-member-user"
          onChange={(next) => {
            setPicked(next)
            const nextUser = next[0]
            // The alias defaults to the picked user's (sanitized) name until
            // hand-edited; RFC-099 keeps raw user ids out of prompts.
            if (!aliasTouched) setDisplayName(nextUser ? deriveMemberAlias(nextUser) : '')
          }}
        />
      </Field>
      <Field
        label={t('workgroups.memberFieldDisplayName')}
        required
        hint={t('workgroups.memberDisplayNamePlaceholder')}
        error={displayName !== '' ? fieldError(t, errors.displayName) : undefined}
      >
        <TextInput
          value={displayName}
          onChange={(v) => {
            setAliasTouched(true)
            setDisplayName(v)
          }}
          maxLength={64}
          data-testid="workgroup-member-displayname-input"
        />
      </Field>
      <Field label={t('workgroups.memberFieldRole')} hint={t('workgroups.memberRolePlaceholder')}>
        <TextInput
          value={roleDesc}
          onChange={setRoleDesc}
          maxLength={2048}
          data-testid="workgroup-member-role-input"
        />
      </Field>
    </Dialog>
  )
}

function EditMemberDialog(
  props: MemberDialogCommonProps & {
    member: WorkgroupMemberRowState
    onSubmit: (patch: { displayName: string; roleDesc: string }) => Promise<void>
  },
) {
  const { t } = useTranslation()
  const [displayName, setDisplayName] = useState(props.member.displayName)
  const [roleDesc, setRoleDesc] = useState(props.member.roleDesc)

  const errors = validateMemberDraft({ ...props.member, displayName }, props.others)
  const invalid = Object.keys(errors).length > 0

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t('workgroups.editMemberTitle')}
      size="sm"
      data-testid="workgroup-edit-member-dialog"
      footer={
        <>
          {props.applyError != null && (
            <span className="form-actions__error">{describeApiError(props.applyError)}</span>
          )}
          <button type="button" className="btn" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={invalid || props.applying}
            onClick={() => void props.onSubmit({ displayName, roleDesc })}
            data-testid="workgroup-edit-member-confirm"
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      <Field
        label={t('workgroups.memberFieldDisplayName')}
        required
        hint={t('workgroups.memberDisplayNamePlaceholder')}
        error={fieldError(t, errors.displayName)}
      >
        <TextInput
          value={displayName}
          onChange={setDisplayName}
          maxLength={64}
          data-testid="workgroup-member-displayname-input"
        />
      </Field>
      <Field label={t('workgroups.memberFieldRole')} hint={t('workgroups.memberRolePlaceholder')}>
        <TextInput
          value={roleDesc}
          onChange={setRoleDesc}
          maxLength={2048}
          data-testid="workgroup-member-role-input"
        />
      </Field>
    </Dialog>
  )
}
