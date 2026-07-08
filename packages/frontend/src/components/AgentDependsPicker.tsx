// RFC-022: dropdown of existing agents above the chip input. Mirror of
// SkillsPicker. Lets the form author pick the closure members from
// /api/agents instead of typing names; self-name is filtered out because
// the save-time guard refuses self-references.
//
// RFC-151 PR-2: thin config shell over the shared <ResourcePicker>.

import { useTranslation } from 'react-i18next'
import type { Agent } from '@agent-workflow/shared'
import { ResourcePicker } from './ResourcePicker'

export const AGENTS_QUERY_KEY = ['agents'] as const

interface Props {
  value: string[]
  onChange: (next: string[]) => void
  /** Name of the agent being edited — excluded from the dropdown so the form
   *  cannot offer "select self" (which the save-time guard would reject). */
  selfName?: string
  placeholder?: string
}

export function AgentDependsPicker({ value, onChange, selfName, placeholder }: Props) {
  const { t } = useTranslation()
  return (
    <ResourcePicker<Agent>
      value={value}
      onChange={onChange}
      queryKey={AGENTS_QUERY_KEY}
      endpoint="/api/agents"
      filter={(a, existing) => !existing.has(a.name) && a.name !== selfName}
      labelFn={(a) => (a.description ? `${a.name} — ${a.description}` : a.name)}
      placeholder={placeholder}
      labels={{
        loading: t('agentForm.dependsPickerLoading'),
        empty: t('agentForm.dependsPickerEmpty'),
        pick: t('agentForm.dependsPickerLabel'),
        loadFailed: t('agentForm.dependsPickerLoadFailed'),
      }}
    />
  )
}
