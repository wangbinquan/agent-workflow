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
import { WG_CLARIFY_BUDGET_DEFAULT, WORKGROUP_MAX_ROUNDS_LIMIT } from '@agent-workflow/shared'
import { Field, NumberInput, Switch, TextArea } from '@/components/Form'
import { FormSection } from '@/components/FormSection'
import { Segmented } from '@/components/Segmented'
import type { WorkgroupConfigDraft } from '@/lib/workgroup-form'

export interface WorkgroupFormProps {
  /**
   * RFC-207 — does the roster being edited contain a human member? Drives the
   * completion gate and the ask-back budget, both of which are meaningless
   * without someone to ask or confirm. Comes from the DRAFT roster, not the
   * last server receipt: mid-edit the two disagree, and the switch must match
   * what the next save will submit.
   */
  hasHumanMember: boolean
  value: WorkgroupConfigDraft
  onChange: (next: WorkgroupConfigDraft) => void
  /** Raw i18n error keys from the payload builder. */
  errors: Record<string, string>
}

export function WorkgroupForm({ value, onChange, errors, hasHumanMember }: WorkgroupFormProps) {
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
              hasHumanMember
                ? t('workgroups.fieldCompletionGateHint')
                : t('workgroups.fieldCompletionGateNoHumanHint')
            }
            disabled={!hasHumanMember}
          />

          {/* RFC-207 — ask-back budget per asker. Meaningless without a human on
              the roster (nobody to ask), so it grays out alongside the gate. */}
          <Field
            label={t('workgroups.fieldClarifyBudget')}
            hint={
              hasHumanMember
                ? t('workgroups.fieldClarifyBudgetHint')
                : t('workgroups.fieldClarifyBudgetNoHumanHint')
            }
          >
            <NumberInput
              value={value.clarifyBudget}
              onChange={(v) => set('clarifyBudget', v ?? WG_CLARIFY_BUDGET_DEFAULT)}
              min={0}
              max={50}
              disabled={!hasHumanMember}
            />
          </Field>

          {/* RFC-185 D4 — opt-in leader fan-out (leader_worker only: it is a
              leader dispatch capability). OFF keeps the original protocol. */}
          {value.mode === 'leader_worker' && (
            <Switch
              checked={value.fanOut}
              onChange={(v) => set('fanOut', v)}
              label={t('workgroups.fieldFanOut')}
              hint={t('workgroups.fieldFanOutHint')}
              data-testid="workgroup-field-fanout"
            />
          )}
        </FormSection>
      )}
    </div>
  )
}
