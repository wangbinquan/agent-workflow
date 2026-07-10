// RFC-004 → RFC-165 — one launch-form field for a non-upload workflow input.
//
// Extracted from routes/workflows.launch.tsx so the /tasks/new wizard renders
// the same input kinds (text / files / enum / git / raw fallback) from the
// same component. Driven solely by `definition.inputs[]` — input nodes on the
// canvas never become form fields by themselves.

import { useTranslation } from 'react-i18next'
import type { WorkflowInput } from '@agent-workflow/shared'
import { TextInput } from '@/components/Form'
import { EnumPicker } from '@/components/launch/EnumPicker'
import { FilesPicker } from '@/components/launch/FilesPicker'
import { GitPicker } from '@/components/launch/GitPicker'

export function DynamicInput({
  def,
  repoPath,
  sourceKind,
  value,
  onChange,
}: {
  def: WorkflowInput
  /** Local path of the matched cached clone ('' → pickers fall back to text). */
  repoPath: string
  sourceKind: 'path' | 'url'
  value: string
  onChange: (next: string) => void
}) {
  const { t } = useTranslation()
  if (def.kind === 'text') {
    const multiline = (def as Record<string, unknown>).multiline === true
    if (multiline) {
      return (
        <textarea
          className="form-input"
          rows={6}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required={def.required === true}
        />
      )
    }
    return <TextInput value={value} onChange={onChange} required={def.required === true} />
  }
  if (def.kind === 'files') {
    return (
      <FilesPicker
        def={def}
        repoPath={repoPath}
        sourceKind={sourceKind}
        value={value}
        onChange={onChange}
      />
    )
  }
  if (def.kind === 'enum') {
    return <EnumPicker def={def} value={value} onChange={onChange} />
  }
  if (def.kind === 'git') {
    return (
      <GitPicker
        def={def}
        repoPath={repoPath}
        sourceKind={sourceKind}
        value={value}
        onChange={onChange}
      />
    )
  }
  return (
    <TextInput
      value={value}
      onChange={onChange}
      placeholder={t('launch.rawInputPlaceholder', { kind: def.kind })}
    />
  )
}

/**
 * RFC-004: the launcher form is driven solely by `definition.inputs[]`. The
 * input nodes on the canvas don't show up as form fields by themselves — they
 * route the value at task-run time into the graph. Exporting this trivial
 * accessor pins the contract so a future refactor can't quietly switch the
 * launcher to "scan input nodes" and bypass the inputs[] declaration.
 */
export function launcherFieldDefs(
  def:
    | {
        inputs?: WorkflowInput[]
      }
    | undefined,
): WorkflowInput[] {
  return def?.inputs ?? []
}
