import type { UserPublic } from '@agent-workflow/shared'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'

import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, NumberInput, Switch, TextInput } from '@/components/Form'
import { UserPicker } from '@/components/UserPicker'

export interface TaskCreationAdvancedValues {
  readonly collaborators: readonly UserPublic[]
  readonly workingBranch: string
  /** Omitted when this task source does not expose the orchestration-only control. */
  readonly autoCommitPush?: boolean
  readonly maxDurationMin: number | undefined
  readonly maxTotalTokens: number | undefined
}

export interface TaskCreationAdvancedCapabilities {
  readonly collaborators: boolean
  readonly workingBranch: boolean
  readonly autoCommitPush?: boolean
  readonly limits: boolean
}

export interface TaskCreationAdvancedValidation {
  readonly workingBranchTrim: string
  readonly workingBranchInvalid: boolean
  readonly durationInvalid: boolean
  readonly tokensInvalid: boolean
  readonly valid: boolean
}

export function validateTaskCreationAdvancedValues(
  values: TaskCreationAdvancedValues,
  capabilities: TaskCreationAdvancedCapabilities,
  isValidBranchName: (value: string) => boolean,
): TaskCreationAdvancedValidation {
  const workingBranchTrim = values.workingBranch.trim()
  const workingBranchInvalid =
    capabilities.workingBranch && workingBranchTrim !== '' && !isValidBranchName(workingBranchTrim)
  const durationInvalid =
    capabilities.limits &&
    values.maxDurationMin !== undefined &&
    (!Number.isFinite(values.maxDurationMin) ||
      values.maxDurationMin <= 0 ||
      Math.round(values.maxDurationMin * 60_000) <= 0 ||
      !Number.isSafeInteger(Math.round(values.maxDurationMin * 60_000)))
  const tokensInvalid =
    capabilities.limits &&
    values.maxTotalTokens !== undefined &&
    (!Number.isSafeInteger(values.maxTotalTokens) || values.maxTotalTokens <= 0)
  return {
    workingBranchTrim,
    workingBranchInvalid,
    durationInvalid,
    tokensInvalid,
    valid: !workingBranchInvalid && !durationInvalid && !tokensInvalid,
  }
}

export function buildTaskCreationAdvancedSummary(input: {
  readonly values: TaskCreationAdvancedValues
  readonly capabilities: TaskCreationAdvancedCapabilities
  readonly t: TFunction
}): string[] {
  const { values, capabilities, t } = input
  const branch = values.workingBranch.trim()
  return [
    capabilities.collaborators && values.collaborators.length > 0
      ? t('taskWizard.summaryCollaborators', { count: values.collaborators.length })
      : null,
    capabilities.workingBranch && branch !== '' ? branch : null,
    capabilities.autoCommitPush && values.autoCommitPush === true
      ? t('launch.autoCommitPush.label')
      : null,
    capabilities.limits && values.maxDurationMin !== undefined
      ? `${t('taskWizard.maxDurationMin')}: ${values.maxDurationMin}`
      : null,
    capabilities.limits && values.maxTotalTokens !== undefined
      ? `${t('taskWizard.maxTotalTokens')}: ${values.maxTotalTokens}`
      : null,
  ].filter((item): item is string => item !== null)
}

export function TaskCreationWorkingBranchField(props: {
  readonly value: string
  readonly invalid: boolean
  readonly disabled?: boolean
  readonly onChange: (value: string) => void
}) {
  const { value, invalid, disabled = false, onChange } = props
  const { t } = useTranslation()

  return (
    <>
      <Field
        label={t('launch.workingBranch.label')}
        hint={invalid ? t('launch.workingBranch.invalid') : t('launch.workingBranch.hint')}
      >
        <TextInput
          value={value}
          onChange={onChange}
          maxLength={255}
          placeholder={t('launch.workingBranch.placeholder')}
          data-testid="wizard-working-branch"
          disabled={disabled}
        />
      </Field>
      {invalid ? (
        <ErrorBanner
          error={null}
          message={t('launch.workingBranch.invalid')}
          testid="wizard-branch-error"
        />
      ) : null}
    </>
  )
}

export function TaskCreationAdvancedSettings(props: {
  readonly values: TaskCreationAdvancedValues
  readonly capabilities: TaskCreationAdvancedCapabilities
  readonly validation: TaskCreationAdvancedValidation
  readonly actorUserId?: string
  readonly disabled?: boolean
  readonly onCollaboratorsChange: (users: UserPublic[]) => void
  readonly onAutoCommitPushChange?: (value: boolean) => void
  readonly onMaxDurationMinChange: (value: number | undefined) => void
  readonly onMaxTotalTokensChange: (value: number | undefined) => void
}) {
  const {
    values,
    capabilities,
    validation,
    actorUserId,
    disabled = false,
    onCollaboratorsChange,
    onAutoCommitPushChange,
    onMaxDurationMinChange,
    onMaxTotalTokensChange,
  } = props
  const { t } = useTranslation()

  return (
    <details className="launch-collapsible" data-testid="wizard-advanced">
      <summary>{t('taskWizard.advanced')}</summary>
      <div className="launch-collapsible__body">
        {capabilities.collaborators && actorUserId !== undefined ? (
          <Field label={t('members.users')} hint={t('members.hint')}>
            <UserPicker
              value={[...values.collaborators]}
              onChange={onCollaboratorsChange}
              excludeIds={[actorUserId]}
              testidPrefix="wizard-collaborators"
              disabled={disabled}
            />
          </Field>
        ) : null}
        {capabilities.autoCommitPush && values.autoCommitPush !== undefined ? (
          <Switch
            checked={values.autoCommitPush}
            onChange={(value) => onAutoCommitPushChange?.(value)}
            label={t('launch.autoCommitPush.label')}
            hint={t('launch.autoCommitPush.hint')}
            disabled={disabled}
          />
        ) : null}
        {capabilities.limits ? (
          <>
            <Field label={t('taskWizard.maxDurationMin')} hint={t('taskWizard.maxDurationMinHint')}>
              <NumberInput
                value={values.maxDurationMin}
                onChange={onMaxDurationMinChange}
                min={1}
                step={1}
                data-testid="wizard-max-duration"
                disabled={disabled}
              />
            </Field>
            <Field label={t('taskWizard.maxTotalTokens')} hint={t('taskWizard.maxTotalTokensHint')}>
              <NumberInput
                value={values.maxTotalTokens}
                onChange={onMaxTotalTokensChange}
                min={1}
                step={1}
                data-testid="wizard-max-tokens"
                disabled={disabled}
              />
            </Field>
            {validation.durationInvalid || validation.tokensInvalid ? (
              <ErrorBanner
                error={null}
                message={t('taskWizard.limitInvalid')}
                testid="wizard-limits-error"
              />
            ) : null}
          </>
        ) : null}
      </div>
    </details>
  )
}
