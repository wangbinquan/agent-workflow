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

export function PluginFields({ value, onChange, nameLocked, errors }: PluginFieldsProps) {
  const { t } = useTranslation()
  const set = <K extends keyof PluginFormState>(k: K, v: PluginFormState[K]): void => {
    onChange({ ...value, [k]: v })
  }
  return (
    <div className="form-grid">
      {/* data-testid anchors: plugin-form-name plugin-form-spec plugin-form-options */}
      <Field label={t('plugins.fieldName')} required>
        <TextInput
          value={value.name}
          onChange={(v) => set('name', v)}
          placeholder="dd-trace"
          disabled={nameLocked === true}
          required
          pattern={PLUGIN_NAME_RE.source}
        />
        {errors.name !== undefined && <span className="form-field__error">{errors.name}</span>}
      </Field>

      <Field label={t('plugins.fieldSpec')} required hint={t('plugins.fieldSpecHint')}>
        <TextInput
          value={value.spec}
          onChange={(v) => set('spec', v)}
          placeholder="@scope/pkg@1.2.3   ./local/plugin.ts   github:org/repo"
          required
        />
        {errors.spec !== undefined && <span className="form-field__error">{errors.spec}</span>}
      </Field>

      <Field label={t('plugins.fieldDescription')}>
        <TextInput value={value.description} onChange={(v) => set('description', v)} />
      </Field>

      <Field label={t('plugins.fieldOptions')} hint={t('plugins.fieldOptionsHint')}>
        <TextArea
          value={value.optionsJson}
          onChange={(v) => set('optionsJson', v)}
          rows={6}
          placeholder='{ "apiKey": "..." }'
          monospace
        />
        {errors.options !== undefined && (
          <span className="form-field__error">{errors.options}</span>
        )}
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
