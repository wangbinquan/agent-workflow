// RFC-117 — shared runtime-profile picker for the settings runtime selectors
// (memory distiller / commit-push / skill-fusion). Built on the same
// /api/runtimes data as the AgentForm runtime <Select> (via useRuntimesList), so
// the "select a runtime" experience is identical everywhere. An empty selection
// means "inherit the global default runtime" → onChange(undefined).

import { useTranslation } from 'react-i18next'
import { useRuntimesList } from '@/hooks/useRuntimesList'
import { Select } from './Select'

interface Props {
  value: string | null | undefined
  onChange: (next: string | undefined) => void
  ariaLabel: string
}

export function RuntimeSelect({ value, onChange, ariaLabel }: Props) {
  const { t } = useTranslation()
  const { selectableRuntimes, claudeEnabled } = useRuntimesList(value)
  // Fallback options when the registry hasn't loaded / is empty — the two
  // built-in protocol names (claude hidden when disabled), mirroring AgentForm.
  const fallback = claudeEnabled
    ? [
        { value: 'opencode', label: t('agentForm.runtimeOpencode') },
        { value: 'claude-code', label: t('agentForm.runtimeClaudeCode') },
      ]
    : [{ value: 'opencode', label: t('agentForm.runtimeOpencode') }]
  return (
    <Select<string>
      value={value ?? ''}
      ariaLabel={ariaLabel}
      onChange={(v) => onChange(v === '' ? undefined : v)}
      options={[
        { value: '', label: t('settings.runtimeInherit') },
        ...(selectableRuntimes.length > 0
          ? selectableRuntimes.map((r) => ({ value: r.name, label: r.name }))
          : fallback),
      ]}
    />
  )
}
