// RFC-164 PR-1 → RFC-168 — workgroup CONFIG form. Since RFC-168 it renders
// inside the detail page's context panel (config state); members are managed
// by the gallery + member panel with immediate PUTs. This form only edits the
// config fields and the page passes the group's current members through on
// save (PUT is full-replace).
//
// free_collab forces the three collaboration switches to read as ON
// (disabled controls + notice) WITHOUT mutating the stored values — the
// shared resolveWorkgroupSwitches defines fc as all-on regardless of
// storage, so flipping back to leader_worker restores the user's choices.

import { useTranslation } from 'react-i18next'
import type { WorkgroupMode } from '@agent-workflow/shared'
import { WORKGROUP_MAX_ROUNDS_LIMIT } from '@agent-workflow/shared'
import { Field, NumberInput, Switch, TextArea } from '@/components/Form'
import { FormSection } from '@/components/FormSection'
import { Segmented } from '@/components/Segmented'
import type { WorkgroupConfigDraft } from '@/lib/workgroup-form'

export interface WorkgroupFormProps {
  value: WorkgroupConfigDraft
  onChange: (next: WorkgroupConfigDraft) => void
  /** Raw i18n error keys from the payload builder. */
  errors: Record<string, string>
}

export function WorkgroupForm({ value, onChange, errors }: WorkgroupFormProps) {
  const { t } = useTranslation()
  const set = <K extends keyof WorkgroupConfigDraft>(k: K, v: WorkgroupConfigDraft[K]): void => {
    onChange({ ...value, [k]: v })
  }

  const fc = value.mode === 'free_collab'
  // RFC-167: dynamic_workflow has no chatroom/turns — the three switches,
  // maxRounds and the completion gate don't apply (the confirm gate is built
  // into the generate→confirm→execute flow), so the whole switches section is
  // omitted rather than rendered as an empty header + "does-not-apply" notice.
  // The mode hint already says members are the orchestratable pool.
  const dyn = value.mode === 'dynamic_workflow'

  const modeHint = dyn
    ? t('workgroups.modeHintDynamicWorkflow')
    : fc
      ? t('workgroups.modeHintFreeCollab')
      : t('workgroups.modeHintLeaderWorker')

  return (
    <div className="workgroup-form">
      {/* Description moved to the header rename dialog (2026-07-13) — this
          section now carries only the charter/instructions. */}
      <FormSection title={t('workgroups.sectionBasics')}>
        <Field
          label={t('workgroups.fieldInstructions')}
          hint={t('workgroups.fieldInstructionsHint')}
        >
          <TextArea
            value={value.instructions}
            onChange={(v) => set('instructions', v)}
            rows={6}
            monospace
            maxLength={65536}
            data-testid="workgroup-field-instructions"
          />
        </Field>
      </FormSection>

      <FormSection title={t('workgroups.sectionMode')}>
        {/* `group` — Segmented is a composite control; the default <label>
            wrapper would hijack each option's accessible name. */}
        <Field
          label={t('workgroups.fieldMode')}
          group
          hint={modeHint}
          error={errors.mode !== undefined ? t(errors.mode) : undefined}
        >
          <Segmented<WorkgroupMode>
            value={value.mode}
            onChange={(v) => set('mode', v)}
            ariaLabel={t('workgroups.fieldMode')}
            testidPrefix="workgroup-mode"
            options={[
              { value: 'leader_worker', label: t('workgroups.modeLeaderWorker') },
              { value: 'free_collab', label: t('workgroups.modeFreeCollab') },
              { value: 'dynamic_workflow', label: t('workgroups.modeDynamicWorkflow') },
            ]}
          />
        </Field>
      </FormSection>

      {/* dynamic_workflow: no switches / maxRounds / completion gate apply, so
          the section is omitted entirely (see the `dyn` note above). Only
          leader_worker / free_collab render it. */}
      {!dyn && (
        <FormSection title={t('workgroups.sectionSwitches')}>
          {fc && (
            <p className="form-field__hint" data-testid="workgroup-fc-switches-notice">
              {t('workgroups.fcSwitchesNotice')}
            </p>
          )}
          <Switch
            checked={fc ? true : value.switches.shareOutputs}
            disabled={fc}
            onChange={(v) => set('switches', { ...value.switches, shareOutputs: v })}
            label={t('workgroups.fieldShareOutputs')}
            hint={t('workgroups.fieldShareOutputsHint')}
          />
          <Switch
            checked={fc ? true : value.switches.directMessages}
            disabled={fc}
            onChange={(v) => set('switches', { ...value.switches, directMessages: v })}
            label={t('workgroups.fieldDirectMessages')}
            hint={t('workgroups.fieldDirectMessagesHint')}
          />
          <Switch
            checked={fc ? true : value.switches.blackboard}
            disabled={fc}
            onChange={(v) => set('switches', { ...value.switches, blackboard: v })}
            label={t('workgroups.fieldBlackboard')}
            hint={t('workgroups.fieldBlackboardHint')}
          />

          <Field
            label={t('workgroups.fieldMaxRounds')}
            hint={t('workgroups.fieldMaxRoundsHint')}
            error={errors.maxRounds !== undefined ? t(errors.maxRounds) : undefined}
          >
            <NumberInput
              value={value.maxRounds}
              onChange={(v) => set('maxRounds', v)}
              min={1}
              max={WORKGROUP_MAX_ROUNDS_LIMIT}
              step={1}
              placeholder="1000"
              data-testid="workgroup-field-max-rounds"
            />
          </Field>

          <Switch
            checked={value.completionGate}
            onChange={(v) => set('completionGate', v)}
            label={t('workgroups.fieldCompletionGate')}
            hint={
              value.autonomous
                ? t('workgroups.fieldCompletionGateAutonomousHint')
                : t('workgroups.fieldCompletionGateHint')
            }
            disabled={value.autonomous}
          />

          {/* RFC-180「全自动」— master switch: no clarify invite + gate treated off
              + leader-idle auto-nudge. Grays out the gate above when on. */}
          <Switch
            checked={value.autonomous}
            onChange={(v) => set('autonomous', v)}
            label={t('workgroups.fieldAutonomous')}
            hint={t('workgroups.fieldAutonomousHint')}
          />
        </FormSection>
      )}
    </div>
  )
}
