// RFC-031 — plugin form widget shared by /plugins/new and /plugins/$id.
// Uses the same `<Field>` / `<TextInput>` / `<TextArea>` / `<Switch>` primitives
// as McpFields / AgentForm so the three "new" pages look visually identical.

import { useTranslation } from 'react-i18next'
import { PLUGIN_NAME_RE } from '@agent-workflow/shared'
import type { PluginFormState } from '@/lib/plugin-form'
import { Field, Switch, TextArea, TextInput } from './Form'

export interface PluginFieldsProps {
  value: PluginFormState
  onChange: (next: PluginFormState) => void
  /** Edit mode locks the name — it can only change via the rename endpoint. */
  nameLocked?: boolean
  /** Build-time validation errors keyed by field id (`name`, `spec`, `options`). */
  errors: Record<string, string>
}

const PLUGIN_ERROR_FIELD_IDS = {
  name: 'plugin-field-name',
  spec: 'plugin-field-spec',
  options: 'plugin-field-options',
} as const

export function focusFirstPluginFieldError(errors: Record<string, string>): void {
  const key = (
    Object.keys(PLUGIN_ERROR_FIELD_IDS) as Array<keyof typeof PLUGIN_ERROR_FIELD_IDS>
  ).find((candidate) => errors[candidate] !== undefined)
  if (key === undefined || typeof window === 'undefined') return
  window.setTimeout(() => document.getElementById(PLUGIN_ERROR_FIELD_IDS[key])?.focus(), 0)
}

export function PluginFields({ value, onChange, nameLocked, errors }: PluginFieldsProps) {
  const { t } = useTranslation()
  const nameError = errors.name === undefined ? undefined : t(errors.name)
  const specError = errors.spec === undefined ? undefined : t(errors.spec)
  const optionsError = errors.options === undefined ? undefined : t(errors.options)
  const set = <K extends keyof PluginFormState>(k: K, v: PluginFormState[K]): void => {
    onChange({ ...value, [k]: v })
  }
  return (
    <div className="form-grid">
      {/* data-testid anchors: plugin-form-name plugin-form-spec plugin-form-options */}
      <Field
        label={t('plugins.fieldName')}
        required
        error={nameError}
        errorId="plugin-field-name-error"
      >
        <TextInput
          id="plugin-field-name"
          data-testid="plugin-form-name"
          value={value.name}
          onChange={(v) => set('name', v)}
          placeholder="dd-trace"
          disabled={nameLocked === true}
          required
          pattern={PLUGIN_NAME_RE.source}
          aria-invalid={nameError === undefined ? undefined : true}
          aria-describedby={nameError === undefined ? undefined : 'plugin-field-name-error'}
          aria-errormessage={nameError === undefined ? undefined : 'plugin-field-name-error'}
        />
      </Field>

      <Field
        label={t('plugins.fieldSpec')}
        required
        hint={t('plugins.fieldSpecHint')}
        error={specError}
        errorId="plugin-field-spec-error"
      >
        <TextInput
          id="plugin-field-spec"
          data-testid="plugin-form-spec"
          value={value.spec}
          onChange={(v) => set('spec', v)}
          placeholder="@scope/pkg@1.2.3   ./local/plugin.ts   github:org/repo"
          required
          aria-invalid={specError === undefined ? undefined : true}
          aria-describedby={specError === undefined ? undefined : 'plugin-field-spec-error'}
          aria-errormessage={specError === undefined ? undefined : 'plugin-field-spec-error'}
        />
      </Field>

      <Field label={t('plugins.fieldDescription')}>
        <TextInput
          id="plugin-field-description"
          value={value.description}
          onChange={(v) => set('description', v)}
        />
      </Field>

      <Field
        label={t('plugins.fieldOptions')}
        hint={t('plugins.fieldOptionsHint')}
        error={optionsError}
        errorId="plugin-field-options-error"
      >
        <TextArea
          id="plugin-field-options"
          data-testid="plugin-form-options"
          value={value.optionsJson}
          onChange={(v) => set('optionsJson', v)}
          rows={6}
          placeholder='{ "apiKey": "..." }'
          monospace
          aria-invalid={optionsError === undefined ? undefined : true}
          aria-describedby={optionsError === undefined ? undefined : 'plugin-field-options-error'}
          aria-errormessage={optionsError === undefined ? undefined : 'plugin-field-options-error'}
        />
      </Field>

      <Field label={t('plugins.fieldEnabled')}>
        <Switch
          checked={value.enabled}
          onChange={(v) => set('enabled', v)}
          label={t('plugins.fieldEnabled')}
        />
      </Field>
    </div>
  )
}
