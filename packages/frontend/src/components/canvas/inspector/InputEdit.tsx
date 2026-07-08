// input-node inspector branch (RFC-004/RFC-020) — extracted verbatim from
// the NodeInspector EditForm switch by RFC-146 T3.

import type { WorkflowInput } from '@agent-workflow/shared'
import { useTranslation } from 'react-i18next'
import { Field, Switch, TextArea, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'
import { patchInputDef, renameInputKey } from '../syncInputDefs'
import { NodeTitleField } from './NodeTitleField'
import type { EditProps } from './types'

export function InputEdit({ node, definition, onPatch, onCommitDef }: EditProps) {
  const { t } = useTranslation()
  const rec = node as unknown as Record<string, unknown>
  const key = typeof rec.inputKey === 'string' ? rec.inputKey : ''
  // RFC-004: inputKey is the single source of truth for the launcher form
  // entry. Edits to the launcher field's kind / label / required /
  // description land on definition.inputs[].
  const inputDef: WorkflowInput | undefined = (definition.inputs ?? []).find((i) => i.key === key)
  const inputKind = (inputDef?.kind ?? 'text') as WorkflowInput['kind']
  const inputLabel = inputDef?.label ?? key
  const inputRequired = inputDef?.required ?? true
  const inputDescription = inputDef?.description ?? ''
  return (
    <div className="form-grid">
      <NodeTitleField node={node} onPatch={onPatch} />
      <Field label={t('inspector.fieldInputKey')} required hint={t('inspector.fieldInputKeyHint')}>
        <TextInput
          value={key}
          onChange={(v) => {
            if (v.length === 0 || v === key) return
            onCommitDef(renameInputKey(definition, node.id, v))
          }}
        />
      </Field>
      <Field label={t('inspector.fieldInputKind')} hint={t('inspector.fieldInputKindHint')}>
        <Select<WorkflowInput['kind']>
          value={inputKind}
          ariaLabel={t('inspector.fieldInputKind')}
          onChange={(v) => onCommitDef(patchInputDef(definition, key, { kind: v }))}
          options={[
            { value: 'text', label: 'text' },
            { value: 'files', label: 'files' },
            { value: 'enum', label: 'enum' },
            { value: 'git', label: 'git' },
            { value: 'upload', label: 'upload' },
          ]}
        />
      </Field>
      {inputKind === 'upload' && (
        <UploadInputFields
          def={inputDef ?? { kind: 'upload', key, label: inputLabel }}
          onPatch={(patch) => onCommitDef(patchInputDef(definition, key, patch))}
        />
      )}
      <Field label={t('inspector.fieldInputLabel')} hint={t('inspector.fieldInputLabelHint')}>
        <TextInput
          value={inputLabel}
          onChange={(v) => onCommitDef(patchInputDef(definition, key, { label: v }))}
        />
      </Field>
      <Field label={t('inspector.fieldInputRequired')}>
        <Switch
          checked={inputRequired}
          onChange={(c) => onCommitDef(patchInputDef(definition, key, { required: c }))}
          label={t('inspector.fieldInputRequired')}
        />
      </Field>
      <Field
        label={t('inspector.fieldInputDescription')}
        hint={t('inspector.fieldInputDescriptionHint')}
      >
        <TextArea
          value={inputDescription}
          rows={3}
          onChange={(v) => onCommitDef(patchInputDef(definition, key, { description: v }))}
        />
      </Field>
    </div>
  )
}

/**
 * RFC-020: per-input editor for `kind: 'upload'` launcher fields. Mirrors
 * UploadInputSchema in @agent-workflow/shared so anything the editor saves
 * round-trips through the strict-on-write validator.
 */
function UploadInputFields({
  def,
  onPatch,
}: {
  def: WorkflowInput
  onPatch: (patch: Partial<WorkflowInput>) => void
}) {
  const { t } = useTranslation()
  const rec = def as Record<string, unknown>
  const targetDir = typeof rec.targetDir === 'string' ? rec.targetDir : ''
  const acceptArr = Array.isArray(rec.accept) ? (rec.accept as string[]) : []
  const acceptText = acceptArr.join(', ')
  const maxFileSize = typeof rec.maxFileSize === 'number' ? rec.maxFileSize : undefined
  const minCount = typeof rec.minCount === 'number' ? rec.minCount : undefined
  const maxCount = typeof rec.maxCount === 'number' ? rec.maxCount : undefined
  const targetDirInvalid =
    targetDir === '' ||
    targetDir.includes('..') ||
    targetDir.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(targetDir)
  return (
    <>
      <Field
        label={t('inspector.upload.targetDir')}
        hint={
          targetDirInvalid
            ? t('inspector.upload.targetDirError')
            : t('inspector.upload.targetDirHint')
        }
        required
      >
        <TextInput
          value={targetDir}
          onChange={(v) => onPatch({ ...(def as object), targetDir: v } as Partial<WorkflowInput>)}
          placeholder="inputs/refs"
        />
      </Field>
      <Field label={t('inspector.upload.accept')} hint={t('inspector.upload.acceptHint')}>
        <TextInput
          value={acceptText}
          onChange={(v) => {
            const next = v
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s !== '')
            onPatch({ ...(def as object), accept: next } as Partial<WorkflowInput>)
          }}
          placeholder=".pdf, image/*"
        />
      </Field>
      <Field label={t('inspector.upload.maxFileSize')} hint={t('inspector.upload.maxFileSizeHint')}>
        <input
          className="form-input"
          type="number"
          min={1}
          value={maxFileSize ?? ''}
          onChange={(e) => {
            const raw = e.target.value
            const n = raw === '' ? undefined : Number(raw)
            onPatch({
              ...(def as object),
              maxFileSize: n,
            } as Partial<WorkflowInput>)
          }}
          placeholder="52428800"
        />
      </Field>
      <Field label={t('inspector.upload.minCount')}>
        <input
          className="form-input"
          type="number"
          min={0}
          value={minCount ?? ''}
          onChange={(e) => {
            const raw = e.target.value
            const n = raw === '' ? undefined : Number(raw)
            onPatch({ ...(def as object), minCount: n } as Partial<WorkflowInput>)
          }}
        />
      </Field>
      <Field label={t('inspector.upload.maxCount')}>
        <input
          className="form-input"
          type="number"
          min={1}
          value={maxCount ?? ''}
          onChange={(e) => {
            const raw = e.target.value
            const n = raw === '' ? undefined : Number(raw)
            onPatch({ ...(def as object), maxCount: n } as Partial<WorkflowInput>)
          }}
        />
      </Field>
    </>
  )
}
