// RFC-168 T4 — shared member-draft hooks + field groups, extracted from the
// former dialog bodies so the SAME fields serve two shells:
//   - the detail page's context panel (AddMemberPanelBody, WorkgroupContextPanel)
//   - the mid-run nested dialogs (AgentMemberDialog / HumanMemberDialog in
//     WorkgroupMemberCards.tsx, reused by WorkgroupTaskConfigDialog)
// Behavior contract both shells rely on (design §8.1): fresh-mount draft
// (hooks hold useState — shells mount-on-open / key-remount), `others` drives
// displayName uniqueness, the alias auto-follows the agent name / picked user
// until hand-edited, and buildRow() emits a validated row.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UserPublic } from '@agent-workflow/shared'
import { AgentCapabilityCard } from '@/components/agent/AgentCapabilityCard'
import { Field, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'
import { UserPicker } from '@/components/UserPicker'
import { useAgentsList } from '@/hooks/useAgentsList'
import {
  deriveMemberAlias,
  makeAgentMemberRow,
  makeHumanMemberRow,
  sanitizeMemberAlias,
  validateMemberDraft,
  type WorkgroupMemberRowState,
} from '@/lib/workgroup-form'

export type MemberDraftOthers = ReadonlyArray<Pick<WorkgroupMemberRowState, 'displayName'>>

function fieldError(t: (k: string) => string, key: string | undefined): string | undefined {
  return key === undefined ? undefined : t(key)
}

// ---------------------------------------------------------------------------
// Agent member draft
// ---------------------------------------------------------------------------

export interface AgentMemberDraft {
  agentName: string
  displayName: string
  roleDesc: string
  setAgentName: (v: string) => void
  setDisplayName: (v: string) => void
  setRoleDesc: (v: string) => void
  errors: Record<string, string>
  invalid: boolean
  buildRow: () => WorkgroupMemberRowState
}

export function useAgentMemberDraft(others: MemberDraftOthers): AgentMemberDraft {
  const [agentName, setAgentName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [aliasTouched, setAliasTouched] = useState(false)
  const [roleDesc, setRoleDesc] = useState('')

  const errors = validateMemberDraft(
    { memberType: 'agent', agentName, userId: '', displayName },
    others,
  )
  return {
    agentName,
    displayName,
    roleDesc,
    setAgentName: (v) => {
      setAgentName(v)
      // The alias defaults to the agent name until hand-edited.
      if (!aliasTouched) setDisplayName(sanitizeMemberAlias(v))
    },
    setDisplayName: (v) => {
      setAliasTouched(true)
      setDisplayName(v)
    },
    setRoleDesc,
    errors,
    invalid: Object.keys(errors).length > 0,
    buildRow: () => makeAgentMemberRow({ agentName, displayName, roleDesc }),
  }
}

export function AgentMemberFields({ draft }: { draft: AgentMemberDraft }) {
  const { t } = useTranslation()
  const { agents } = useAgentsList()
  return (
    <>
      {/* RFC-168 UI 一致性 — pick an existing agent through the shared Select
          (RFC-036 popover, searchable), matching the single-agent launch
          wizard and the canvas agent-single inspector. The former native
          <datalist>+<TextInput> was the only such widget in the frontend and
          clashed with every other dropdown; agent references are launch-time
          validated, so restricting the picker to real agents loses nothing. */}
      <Field label={t('workgroups.memberFieldAgent')} required>
        <Select<string>
          value={draft.agentName}
          onChange={draft.setAgentName}
          options={agents.map((a) => ({ value: a.name, label: a.name }))}
          searchable
          placeholder={t('workgroups.memberAgentPlaceholder')}
          ariaLabel={t('workgroups.memberFieldAgent')}
          data-testid="workgroup-agent-name-input"
        />
      </Field>
      {/* RFC-166 §4.2 — preview the picked agent's real capability (what the
          leader will see in the roster) as the name is selected. */}
      {(() => {
        const picked = agents.find((a) => a.name === draft.agentName)
        return picked !== undefined ? (
          <div className="workgroup-agent-preview">
            <AgentCapabilityCard agent={picked} compact />
          </div>
        ) : null
      })()}
      <Field
        label={t('workgroups.memberFieldDisplayName')}
        required
        hint={t('workgroups.memberDisplayNamePlaceholder')}
        error={draft.displayName !== '' ? fieldError(t, draft.errors.displayName) : undefined}
      >
        <TextInput
          value={draft.displayName}
          onChange={draft.setDisplayName}
          maxLength={64}
          data-testid="workgroup-member-displayname-input"
        />
      </Field>
      <Field label={t('workgroups.memberFieldRole')} hint={t('workgroups.memberRolePlaceholder')}>
        <TextInput
          value={draft.roleDesc}
          onChange={draft.setRoleDesc}
          maxLength={2048}
          data-testid="workgroup-member-role-input"
        />
      </Field>
    </>
  )
}

// ---------------------------------------------------------------------------
// Human member draft
// ---------------------------------------------------------------------------

export interface HumanMemberDraft {
  picked: UserPublic[]
  displayName: string
  roleDesc: string
  setPicked: (next: UserPublic[]) => void
  setDisplayName: (v: string) => void
  setRoleDesc: (v: string) => void
  errors: Record<string, string>
  invalid: boolean
  /** null until a user is picked (submit stays disabled via `invalid`). */
  buildRow: () => WorkgroupMemberRowState | null
}

export function useHumanMemberDraft(others: MemberDraftOthers): HumanMemberDraft {
  const [picked, setPicked] = useState<UserPublic[]>([])
  const [displayName, setDisplayName] = useState('')
  const [aliasTouched, setAliasTouched] = useState(false)
  const [roleDesc, setRoleDesc] = useState('')
  const user = picked[0]

  const errors = validateMemberDraft(
    { memberType: 'human', agentName: '', userId: user?.id ?? '', displayName },
    others,
  )
  return {
    picked,
    displayName,
    roleDesc,
    setPicked: (next) => {
      setPicked(next)
      const nextUser = next[0]
      // The alias defaults to the picked user's (sanitized) name until
      // hand-edited; RFC-099 keeps raw user ids out of prompts.
      if (!aliasTouched) setDisplayName(nextUser ? deriveMemberAlias(nextUser) : '')
    },
    setDisplayName: (v) => {
      setAliasTouched(true)
      setDisplayName(v)
    },
    setRoleDesc,
    errors,
    invalid: Object.keys(errors).length > 0,
    buildRow: () =>
      user === undefined ? null : makeHumanMemberRow({ userId: user.id, displayName, roleDesc }),
  }
}

export function HumanMemberFields({ draft }: { draft: HumanMemberDraft }) {
  const { t } = useTranslation()
  return (
    <>
      <Field label={t('workgroups.memberFieldUser')} required>
        <UserPicker
          value={draft.picked}
          single
          placeholder={t('workgroups.memberUserPlaceholder')}
          testidPrefix="workgroup-member-user"
          onChange={draft.setPicked}
        />
      </Field>
      <Field
        label={t('workgroups.memberFieldDisplayName')}
        required
        hint={t('workgroups.memberDisplayNamePlaceholder')}
        error={draft.displayName !== '' ? fieldError(t, draft.errors.displayName) : undefined}
      >
        <TextInput
          value={draft.displayName}
          onChange={draft.setDisplayName}
          maxLength={64}
          data-testid="workgroup-member-displayname-input"
        />
      </Field>
      <Field label={t('workgroups.memberFieldRole')} hint={t('workgroups.memberRolePlaceholder')}>
        <TextInput
          value={draft.roleDesc}
          onChange={draft.setRoleDesc}
          maxLength={2048}
          data-testid="workgroup-member-role-input"
        />
      </Field>
    </>
  )
}
