// RFC-028 — MCP form widget shared by /mcps/new and /mcps/$name. Uses the
// same `<Field>` + `<TextInput>` primitives as AgentForm / SkillCreatePage
// so the three "new" pages look visually identical.
// RFC-151 PR-1 — the two hand-rolled chip-radio groups (type, oauthMode)
// now render the shared <Segmented> primitive (RFC-150 adoption set).

import { useTranslation } from 'react-i18next'
import { Field, Switch, TextArea, TextInput } from './Form'
import { Segmented } from './Segmented'
import { MCP_NAME_RE } from '@agent-workflow/shared'
import type { McpFormState } from '@/lib/mcp-form'

export interface McpFieldsProps {
  value: McpFormState
  onChange: (next: McpFormState) => void
  /** Edit mode locks name + type — they cannot change after create. */
  nameLocked?: boolean
  /** Build-time validation errors keyed by field id (`name`, `command`, ...). */
  errors: Record<string, string>
}

export function McpFields({ value, onChange, nameLocked, errors }: McpFieldsProps) {
  const { t } = useTranslation()
  const errorText = (field: string): string | undefined => {
    const key = errors[field]
    return key === undefined ? undefined : t(key)
  }
  const set = <K extends keyof McpFormState>(k: K, v: McpFormState[K]): void => {
    onChange({ ...value, [k]: v })
  }
  return (
    <div className="form-grid">
      <Field
        label={t('mcps.fieldName')}
        required
        hint={t('mcps.fieldNameHint')}
        error={errorText('name')}
        errorId="mcp-field-name-error"
      >
        <TextInput
          id="mcp-field-name"
          value={value.name}
          onChange={(v) => set('name', v)}
          placeholder="postgres-prod"
          disabled={nameLocked === true}
          required
          pattern={MCP_NAME_RE.source}
          aria-invalid={errors.name !== undefined}
          aria-describedby={errors.name !== undefined ? 'mcp-field-name-error' : undefined}
          aria-errormessage={errors.name !== undefined ? 'mcp-field-name-error' : undefined}
        />
      </Field>

      <Field label={t('mcps.fieldDescription')}>
        <TextInput value={value.description} onChange={(v) => set('description', v)} />
      </Field>

      {/* `group` — a Segmented is a composite control; wrapping it in the
          default <label> would hijack each option's accessible name. */}
      <Field label={t('mcps.fieldType')} group>
        <Segmented
          value={value.type}
          onChange={(v) => set('type', v)}
          ariaLabel={t('mcps.fieldType')}
          disabled={nameLocked === true}
          options={[
            { value: 'local', label: t('mcps.typeLocal') },
            { value: 'remote', label: t('mcps.typeRemote') },
          ]}
        />
      </Field>

      <Switch
        checked={value.enabled}
        onChange={(v) => set('enabled', v)}
        label={t('mcps.fieldEnabled')}
        hint={t('mcps.fieldEnabledHint')}
      />

      <p className="form-field__hint">{t('mcps.toolNamingHint')}</p>

      {value.type === 'local' && (
        <>
          <Field
            label={t('mcps.fieldCommand')}
            required
            hint={t('mcps.fieldCommandHint')}
            error={errorText('command')}
            errorId="mcp-field-command-error"
          >
            <TextInput
              id="mcp-field-command"
              value={value.command}
              onChange={(v) => set('command', v)}
              placeholder="uvx postgres-mcp"
              required
              aria-invalid={errors.command !== undefined}
              aria-describedby={
                errors.command !== undefined ? 'mcp-field-command-error' : undefined
              }
              aria-errormessage={
                errors.command !== undefined ? 'mcp-field-command-error' : undefined
              }
            />
          </Field>
          <Field label={t('mcps.fieldEnv')} hint={t('mcps.fieldEnvHint')}>
            <TextArea
              value={value.envText}
              onChange={(v) => set('envText', v)}
              rows={4}
              placeholder={'PG_URL=postgresql://localhost/x\nLOG_LEVEL=info'}
              monospace
            />
          </Field>
          <p className="form-field__hint">{t('mcps.cwdHint')}</p>
        </>
      )}

      {value.type === 'remote' && (
        <>
          <Field
            label={t('mcps.fieldUrl')}
            required
            hint={t('mcps.fieldUrlHint')}
            error={errorText('url')}
            errorId="mcp-field-url-error"
          >
            <TextInput
              id="mcp-field-url"
              value={value.url}
              onChange={(v) => set('url', v)}
              type="url"
              placeholder="https://mcp.example.com/sse"
              required
              aria-invalid={errors.url !== undefined}
              aria-describedby={errors.url !== undefined ? 'mcp-field-url-error' : undefined}
              aria-errormessage={errors.url !== undefined ? 'mcp-field-url-error' : undefined}
            />
          </Field>
          <Field label={t('mcps.fieldHeaders')} hint={t('mcps.fieldHeadersHint')}>
            <TextArea
              value={value.headersText}
              onChange={(v) => set('headersText', v)}
              rows={3}
              placeholder={'Authorization=Bearer xxx\nX-Trace-Id=abc'}
              monospace
            />
          </Field>
          <Field label={t('mcps.fieldOauth')} hint={t('mcps.fieldOauthHint')} group>
            <Segmented
              value={value.oauthMode}
              onChange={(v) => set('oauthMode', v)}
              ariaLabel={t('mcps.fieldOauth')}
              options={[
                { value: 'auto', label: t('mcps.oauthModeAuto') },
                { value: 'disabled', label: t('mcps.oauthModeDisabled') },
              ]}
            />
          </Field>
          <p className="form-field__hint">{t('mcps.oauthCliHint')}</p>
        </>
      )}

      <Field
        label={t('mcps.fieldTimeoutMs')}
        error={errorText('timeoutMs')}
        errorId="mcp-field-timeout-error"
      >
        <TextInput
          id="mcp-field-timeout"
          value={value.timeoutMsText}
          onChange={(v) => set('timeoutMsText', v)}
          placeholder="30000"
          aria-invalid={errors.timeoutMs !== undefined}
          aria-describedby={errors.timeoutMs !== undefined ? 'mcp-field-timeout-error' : undefined}
          aria-errormessage={errors.timeoutMs !== undefined ? 'mcp-field-timeout-error' : undefined}
        />
      </Field>
    </div>
  )
}
