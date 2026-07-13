// RFC-031 — same shape as McpsPicker, but pointed at /api/plugins. Lets the
// user pick from existing plugin rows instead of typing names by hand. Falls
// back to a plain ChipsInput when the plugin list fails to load so the agent
// form stays usable.
//
// RFC-151 PR-2: thin config shell over the shared <ResourcePicker>.

import { useTranslation } from 'react-i18next'
import type { Plugin } from '@agent-workflow/shared'
import { ResourcePicker } from './ResourcePicker'

export const PLUGINS_QUERY_KEY = ['plugins'] as const

interface Props {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
}

export function PluginsPicker({ value, onChange, placeholder }: Props) {
  const { t } = useTranslation()
  return (
    <ResourcePicker<Plugin>
      value={value}
      onChange={onChange}
      queryKey={PLUGINS_QUERY_KEY}
      endpoint="/api/plugins"
      // Only offer enabled plugins; the save-time guard rejects references to
      // disabled rows so suggesting them would mislead the operator. (A plugin
      // that was selected and later disabled still shows — checked — via the
      // ResourcePicker union, so it can be un-checked.)
      filter={(p) => p.enabled}
      labelFn={(p) => p.name}
      descriptionFn={(p) => {
        const parts: string[] = []
        if (p.description) parts.push(p.description)
        if (p.resolvedVersion !== null) parts.push(`v${p.resolvedVersion}`)
        return parts.length > 0 ? parts.join(' · ') : undefined
      }}
      ariaLabel={t('agentForm.fieldPlugins')}
      placeholder={placeholder}
      testid="plugins-picker-select"
      labels={{
        loading: t('agentForm.pluginsPickerLoading'),
        empty: t('agentForm.pluginsPickerEmpty'),
        loadFailed: t('agentForm.pluginsPickerLoadFailed'),
      }}
    />
  )
}
