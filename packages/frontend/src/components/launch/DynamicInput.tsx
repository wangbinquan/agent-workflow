// RFC-004 → RFC-165 — one launch-form field for a non-upload workflow input.
//
// Extracted from routes/workflows.launch.tsx so the /tasks/new wizard renders
// the same input kinds (text / files / enum / git / raw fallback) from the
// same component. Driven solely by `definition.inputs[]` — input nodes on the
// canvas never become form fields by themselves.

import { useTranslation } from 'react-i18next'
import type { WorkflowInput } from '@agent-workflow/shared'
import { ChipsInput } from '@/components/ChipsInput'
import { TextArea, TextInput } from '@/components/Form'
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
    const rec = def as Record<string, unknown>
    // RFC-218: carry the wire cap into the control — no "green form, 422 on
    // submit" (design P2-4). Derived agent-port defs always set it.
    const maxLength = typeof rec.maxLength === 'number' ? rec.maxLength : undefined
    // RFC-218: `list<string|markdown>` agent ports — one chip per item,
    // newline-joined wire value (matches the upload/files packing convention).
    if (rec.presentation === 'chips') {
      const items = value === '' ? [] : value.split('\n')
      return (
        <ChipsInput
          value={items}
          onChange={(next) => onChange(next.join('\n'))}
          validate={
            maxLength !== undefined
              ? (token) =>
                  [...items, token].join('\n').length > maxLength
                    ? t('launch.inputTooLong', { max: maxLength })
                    : null
              : undefined
          }
          testidPrefix={`wizard-input-${def.key}`}
        />
      )
    }
    const multiline = rec.multiline === true
    if (multiline) {
      return (
        <TextArea
          rows={6}
          value={value}
          onChange={onChange}
          required={def.required === true}
          maxLength={maxLength}
        />
      )
    }
    return (
      <TextInput
        value={value}
        onChange={onChange}
        required={def.required === true}
        maxLength={maxLength}
      />
    )
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
