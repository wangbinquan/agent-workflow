// RFC-164 PR-5 — mid-run config dialog for a workgroup TASK (design §8.4).
// Edits the task's OWN config copy via PUT /api/workgroup-tasks/:id/config;
// the workgroup resource row is untouched and mode / leader / repo stay
// immutable (the leader row renders no remove control).
//
// The PUT body carries ONLY changed fields (buildWorkgroupConfigPatch —
// empty change set disables submit; the backend would 422
// `workgroup-config-empty`). Member additions reuse the PR-1b add-member
// dialogs (WorkgroupMemberCards) — here they STAGE rows into the patch
// instead of saving immediately; nested-dialog stacking is a supported
// Dialog contract (openDialogStack, tests/dialog-nested.test.tsx).

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkgroupRuntimeConfig } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { Field, NumberInput, Switch } from '@/components/Form'
import { StatusChip } from '@/components/StatusChip'
import { AgentMemberDialog, HumanMemberDialog } from '@/components/workgroup/WorkgroupMemberCards'
import { describeApiError } from '@/i18n'
import type { WorkgroupMemberRowState } from '@/lib/workgroup-form'
import {
  buildWorkgroupConfigPatch,
  isValidTaskMaxRounds,
  workgroupRoomKey,
  workgroupTaskConfigDraftFrom,
  type WorkgroupConfigMemberAdd,
} from '@/lib/workgroup-room'

export interface WorkgroupTaskConfigDialogProps {
  taskId: string
  config: WorkgroupRuntimeConfig
  /** Mount-on-open contract (like the member dialogs) — parent renders
   *  `{open && <WorkgroupTaskConfigDialog …>}` so every open seeds fresh. */
  onClose: () => void
}

export function WorkgroupTaskConfigDialog({
  taskId,
  config,
  onClose,
}: WorkgroupTaskConfigDialogProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const [draft, setDraft] = useState(() => workgroupTaskConfigDraftFrom(config))
  const [addAgentOpen, setAddAgentOpen] = useState(false)
  const [addHumanOpen, setAddHumanOpen] = useState(false)

  const fc = config.mode === 'free_collab'

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api.put<{ changes: string[] }>(
        `/api/workgroup-tasks/${encodeURIComponent(taskId)}/config`,
        patch,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: workgroupRoomKey(taskId) })
      onClose()
    },
  })

  const patch = buildWorkgroupConfigPatch(config, draft)
  const maxRoundsInvalid = !isValidTaskMaxRounds(draft.maxRounds)

  function toggleRemove(memberId: string): void {
    setDraft((d) => ({
      ...d,
      removeMemberIds: d.removeMemberIds.includes(memberId)
        ? d.removeMemberIds.filter((id) => id !== memberId)
        : [...d.removeMemberIds, memberId],
    }))
  }

  function stageAdd(row: WorkgroupMemberRowState): void {
    const add: WorkgroupConfigMemberAdd =
      row.memberType === 'agent'
        ? {
            memberType: 'agent',
            agentName: row.agentName.trim(),
            displayName: row.displayName.trim(),
            roleDesc: row.roleDesc,
          }
        : {
            memberType: 'human',
            userId: row.userId,
            displayName: row.displayName.trim(),
            roleDesc: row.roleDesc,
          }
    setDraft((d) => ({ ...d, addMembers: [...d.addMembers, add] }))
  }

  // Uniqueness pool for the add dialogs: the post-patch roster (kept members
  // + already staged adds) — mirrors the backend's duplicate check.
  const dialogOthers = [
    ...config.members
      .filter((m) => !draft.removeMemberIds.includes(m.id))
      .map((m) => ({ displayName: m.displayName })),
    ...draft.addMembers.map((m) => ({ displayName: m.displayName })),
  ]

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('workgroups.room.configTitle')}
      size="md"
      data-testid="workgroup-room-config-dialog"
      footer={
        <>
          {save.error !== null && save.error !== undefined && (
            <span className="form-actions__error" data-testid="wg-config-error">
              {describeApiError(save.error)}
            </span>
          )}
          {patch === null && (
            <span className="form-field__hint" data-testid="wg-config-empty-hint">
              {t('workgroups.room.configEmptyHint')}
            </span>
          )}
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={save.isPending || patch === null || maxRoundsInvalid}
            onClick={() => {
              if (patch !== null) save.mutate(patch)
            }}
            data-testid="wg-config-submit"
          >
            {save.isPending ? t('common.saving') : t('workgroups.room.configSubmit')}
          </button>
        </>
      }
    >
      {fc && (
        <p className="form-field__hint" data-testid="wg-config-fc-notice">
          {t('workgroups.fcSwitchesNotice')}
        </p>
      )}
      <Switch
        checked={fc ? true : draft.switches.shareOutputs}
        disabled={fc}
        onChange={(v) => setDraft((d) => ({ ...d, switches: { ...d.switches, shareOutputs: v } }))}
        label={t('workgroups.fieldShareOutputs')}
      />
      <Switch
        checked={fc ? true : draft.switches.directMessages}
        disabled={fc}
        onChange={(v) =>
          setDraft((d) => ({ ...d, switches: { ...d.switches, directMessages: v } }))
        }
        label={t('workgroups.fieldDirectMessages')}
      />
      <Switch
        checked={fc ? true : draft.switches.blackboard}
        disabled={fc}
        onChange={(v) => setDraft((d) => ({ ...d, switches: { ...d.switches, blackboard: v } }))}
        label={t('workgroups.fieldBlackboard')}
      />

      <Field
        label={t('workgroups.fieldMaxRounds')}
        hint={t('workgroups.fieldMaxRoundsHint')}
        error={maxRoundsInvalid ? t('workgroups.errors.maxRoundsInvalid') : undefined}
      >
        <NumberInput
          value={draft.maxRounds}
          onChange={(v) => setDraft((d) => ({ ...d, maxRounds: v }))}
          min={1}
          max={500}
          step={1}
          data-testid="wg-config-max-rounds"
        />
      </Field>

      <Switch
        checked={draft.completionGate}
        onChange={(v) => setDraft((d) => ({ ...d, completionGate: v }))}
        label={t('workgroups.fieldCompletionGate')}
        hint={t('workgroups.fieldCompletionGateHint')}
      />

      <div className="workgroup-room__config-members-title">
        {t('workgroups.room.configMembersTitle')}
      </div>
      <ul className="workgroup-room__config-members">
        {config.members.map((m) => {
          const isLeader = m.id === config.leaderMemberId
          const removing = draft.removeMemberIds.includes(m.id)
          return (
            <li
              key={m.id}
              className={removing ? 'workgroup-room__config-member--removing' : undefined}
              data-testid={`wg-config-member-${m.displayName}`}
            >
              <span className="workgroup-room__member-name">@{m.displayName}</span>
              <span className="chip chip--tight">
                {m.memberType === 'agent'
                  ? t('workgroups.memberTypeAgent')
                  : t('workgroups.memberTypeHuman')}
              </span>
              {isLeader && (
                <StatusChip kind="info" size="sm">
                  {t('workgroups.leaderBadge')}
                </StatusChip>
              )}
              {removing && (
                <StatusChip kind="warn" size="sm">
                  {t('workgroups.room.configWillRemove')}
                </StatusChip>
              )}
              {/* Leader is immutable mid-run (design §8.4) — no remove control. */}
              {!isLeader && (
                <button
                  type="button"
                  className="btn btn--xs"
                  onClick={() => toggleRemove(m.id)}
                  data-testid={`wg-config-remove-${m.displayName}`}
                >
                  {removing ? t('workgroups.room.configUndoRemove') : t('workgroups.memberRemove')}
                </button>
              )}
            </li>
          )
        })}
        {draft.addMembers.map((m, i) => (
          <li key={`add-${m.displayName}`} data-testid={`wg-config-add-${m.displayName}`}>
            <span className="workgroup-room__member-name">@{m.displayName}</span>
            <span className="chip chip--tight">
              {m.memberType === 'agent'
                ? t('workgroups.memberTypeAgent')
                : t('workgroups.memberTypeHuman')}
            </span>
            <StatusChip kind="success" size="sm">
              {t('workgroups.room.configNewChip')}
            </StatusChip>
            <button
              type="button"
              className="btn btn--xs"
              onClick={() =>
                setDraft((d) => ({ ...d, addMembers: d.addMembers.filter((_, j) => j !== i) }))
              }
              data-testid={`wg-config-unstage-${m.displayName}`}
            >
              {t('workgroups.memberRemove')}
            </button>
          </li>
        ))}
      </ul>
      <div className="workgroup-cards__actions">
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => setAddAgentOpen(true)}
          data-testid="wg-config-add-agent"
        >
          {t('workgroups.addAgentMember')}
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => setAddHumanOpen(true)}
          data-testid="wg-config-add-human"
        >
          {t('workgroups.addHumanMember')}
        </button>
      </div>

      {addAgentOpen && (
        <AgentMemberDialog
          others={dialogOthers}
          applying={false}
          applyError={null}
          onClose={() => setAddAgentOpen(false)}
          onSubmit={(row) => {
            stageAdd(row)
            setAddAgentOpen(false)
            return Promise.resolve()
          }}
        />
      )}
      {addHumanOpen && (
        <HumanMemberDialog
          others={dialogOthers}
          applying={false}
          applyError={null}
          onClose={() => setAddHumanOpen(false)}
          onSubmit={(row) => {
            stageAdd(row)
            setAddHumanOpen(false)
            return Promise.resolve()
          }}
        />
      )}
    </Dialog>
  )
}
