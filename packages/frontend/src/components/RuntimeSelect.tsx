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
  /** A runtime name, or `null` for the "Inherit (global default)" option — null
   *  (not undefined) so the PATCH actually clears a saved override (RFC-117). */
  onChange: (next: string | null) => void
  ariaLabel: string
  /** RFC-156: disable the picker while its source value is still loading / failed
   *  to load, so a not-yet-resolved value can't be mistaken for "Inherit". */
  disabled?: boolean
}

export function RuntimeSelect({ value, onChange, ariaLabel, disabled }: Props) {
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
      disabled={disabled}
      onChange={(v) => onChange(v === '' ? null : v)}
      options={[
        { value: '', label: t('settings.runtimeInherit') },
        ...(selectableRuntimes.length > 0
          ? selectableRuntimes.map((r) => ({ value: r.name, label: r.name }))
          : fallback),
      ]}
    />
  )
}
