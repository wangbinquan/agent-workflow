// RFC-002: dropdown of existing skills above the chip input. Lets the user
// pick from /api/skills instead of having to remember the exact skill name.
// Falls back to plain ChipsInput when the skills list fails to load, so the
// agent form remains usable.
//
// RFC-151 PR-2: thin config shell over the shared <ResourcePicker>.

import { useTranslation } from 'react-i18next'
import type { Skill } from '@agent-workflow/shared'
import { ResourcePicker } from './ResourcePicker'

export const SKILLS_QUERY_KEY = ['skills'] as const

interface Props {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
}

export function SkillsPicker({ value, onChange, placeholder }: Props) {
  const { t } = useTranslation()
  return (
    <ResourcePicker<Skill>
      value={value}
      onChange={onChange}
      queryKey={SKILLS_QUERY_KEY}
      endpoint="/api/skills"
      labelFn={(s) => (s.description ? `${s.name} — ${s.description}` : s.name)}
      placeholder={placeholder}
      labels={{
        loading: t('agentForm.skillsPickerLoading'),
        empty: t('agentForm.skillsPickerEmpty'),
        pick: t('agentForm.skillsPickerLabel'),
        loadFailed: t('agentForm.skillsPickerLoadFailed'),
      }}
    />
  )
}
