// Shared frontmatter + body form for /agents/new and /agents/$name.
// Lifts the entire CreateAgent payload to local state; submission is the
// parent's concern.

import { useTranslation } from 'react-i18next'
import type { CreateAgent } from '@agent-workflow/shared'
import { AGENT_NAME_RE } from '@agent-workflow/shared'
import { ChipsInput } from './ChipsInput'
import { Field, NumberInput, Switch, TextArea, TextInput } from './Form'
import { JsonField } from './JsonField'
import { MarkdownEditor } from './MarkdownEditor'

export interface AgentFormProps {
  value: CreateAgent
  onChange: (next: CreateAgent) => void
  /** When true the name input is read-only (editing an existing agent). */
  nameLocked?: boolean
}

const DEFAULT: CreateAgent = {
  name: '',
  description: '',
  outputs: [],
  readonly: false,
  permission: {},
  skills: [],
  frontmatterExtra: {},
  bodyMd: '',
}

export function emptyAgent(): CreateAgent {
  return structuredClone(DEFAULT)
}

export function AgentForm({ value, onChange, nameLocked }: AgentFormProps) {
  const { t } = useTranslation()
  function patch<K extends keyof CreateAgent>(key: K, next: CreateAgent[K]) {
    onChange({ ...value, [key]: next })
  }

  return (
    <div className="agent-form">
      <div className="form-grid">
        <Field label={t('agentForm.fieldName')} required hint={t('agentForm.fieldNameHint')}>
          <TextInput
            value={value.name}
            onChange={(v) => patch('name', v)}
            disabled={nameLocked === true}
            required
            pattern={AGENT_NAME_RE.source}
            placeholder={t('agentForm.fieldNamePlaceholder')}
          />
        </Field>

        <Field label={t('agentForm.fieldDescription')}>
          <TextInput
            value={value.description ?? ''}
            onChange={(v) => patch('description', v)}
            placeholder={t('agentForm.fieldDescriptionPlaceholder')}
          />
        </Field>

        <Field label={t('agentForm.fieldOutputs')} hint={t('agentForm.fieldOutputsHint')}>
          <ChipsInput
            value={value.outputs ?? []}
            onChange={(v) => patch('outputs', v)}
            placeholder={t('agentForm.fieldOutputsPlaceholder')}
            validate={(s) => (/^[a-z][a-z0-9_]*$/.test(s) ? null : t('agentForm.outputsValidate'))}
          />
        </Field>

        <Field label={t('agentForm.fieldSkills')} hint={t('agentForm.fieldSkillsHint')}>
          <ChipsInput
            value={value.skills ?? []}
            onChange={(v) => patch('skills', v)}
            placeholder={t('agentForm.fieldSkillsPlaceholder')}
          />
        </Field>

        <Switch
          checked={value.readonly === true}
          onChange={(v) => patch('readonly', v)}
          label={t('agentForm.fieldReadonly')}
          hint={t('agentForm.fieldReadonlyHint')}
        />

        <div className="form-grid form-grid--cols-3">
          <Field label={t('agentForm.fieldModel')}>
            <TextInput
              value={value.model ?? ''}
              onChange={(v) => patch('model', v === '' ? undefined : v)}
              placeholder={t('agentForm.modelPlaceholder')}
            />
          </Field>
          <Field label={t('agentForm.fieldVariant')}>
            <TextInput
              value={value.variant ?? ''}
              onChange={(v) => patch('variant', v === '' ? undefined : v)}
              placeholder={t('common.optionalPlaceholder')}
            />
          </Field>
          <Field label={t('agentForm.fieldTemperature')}>
            <NumberInput
              value={value.temperature}
              onChange={(v) => patch('temperature', v)}
              min={0}
              max={2}
              step={0.1}
              placeholder={t('agentForm.temperaturePlaceholder')}
            />
          </Field>
          <Field label={t('agentForm.fieldSteps')}>
            <NumberInput
              value={value.steps}
              onChange={(v) => patch('steps', v)}
              min={1}
              placeholder={t('common.optionalPlaceholder')}
            />
          </Field>
          <Field label={t('agentForm.fieldMaxSteps')}>
            <NumberInput
              value={value.maxSteps}
              onChange={(v) => patch('maxSteps', v)}
              min={1}
              placeholder={t('common.optionalPlaceholder')}
            />
          </Field>
        </div>

        <Field label={t('agentForm.fieldPermission')} hint={t('agentForm.fieldPermissionHint')}>
          <JsonField
            value={value.permission ?? {}}
            onChange={(v) => patch('permission', v)}
            placeholder={t('agentForm.permissionPlaceholder')}
            rows={5}
          />
        </Field>

        <Field
          label={t('agentForm.fieldFrontmatterExtra')}
          hint={t('agentForm.fieldFrontmatterExtraHint')}
        >
          <JsonField
            value={value.frontmatterExtra ?? {}}
            onChange={(v) => patch('frontmatterExtra', v)}
            placeholder={t('common.optionalPlaceholder')}
            rows={4}
          />
        </Field>

        <Field label={t('agentForm.fieldBody')}>
          <MarkdownEditor
            value={value.bodyMd ?? ''}
            onChange={(v) => patch('bodyMd', v)}
            placeholder={t('agentForm.bodyPlaceholder')}
          />
        </Field>

        {/* Quick raw-body fallback for users who don't want preview. */}
        <details className="form-details">
          <summary>{t('agentForm.rawBodySummary')}</summary>
          <TextArea
            value={value.bodyMd ?? ''}
            onChange={(v) => patch('bodyMd', v)}
            rows={6}
            monospace
          />
        </details>
      </div>
    </div>
  )
}
