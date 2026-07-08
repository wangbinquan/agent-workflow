// RFC-028 — same shape as SkillsPicker, but pointed at /api/mcps. Lets the
// user pick from existing MCP rows instead of typing names by hand. Falls
// back to a plain ChipsInput when the MCP list fails to load (the agent form
// must stay usable even if the daemon's MCP endpoint is temporarily broken).
//
// RFC-151 PR-2: thin config shell over the shared <ResourcePicker>, which
// runs the TanStack query (api.get(endpoint)) with the key pinned here.

import { useTranslation } from 'react-i18next'
import type { Mcp } from '@agent-workflow/shared'
import { ResourcePicker } from './ResourcePicker'

export const MCPS_QUERY_KEY = ['mcps'] as const

interface Props {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
}

export function McpsPicker({ value, onChange, placeholder }: Props) {
  const { t } = useTranslation()
  return (
    <ResourcePicker<Mcp>
      value={value}
      onChange={onChange}
      queryKey={MCPS_QUERY_KEY}
      endpoint="/api/mcps"
      labelFn={(m) => (m.description ? `${m.name} — ${m.description}` : m.name)}
      placeholder={placeholder}
      testid="mcps-picker-select"
      labels={{
        loading: t('agentForm.mcpsPickerLoading'),
        empty: t('agentForm.mcpsPickerEmpty'),
        pick: t('agentForm.mcpsPickerLabel'),
        loadFailed: t('agentForm.mcpsPickerLoadFailed'),
      }}
    />
  )
}
