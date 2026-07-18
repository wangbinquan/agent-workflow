// input-node inspector branch (RFC-004/RFC-020) — extracted verbatim from
// the NodeInspector EditForm switch by RFC-146 T3.

import type { WorkflowInput } from '@agent-workflow/shared'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChipsInput } from '@/components/ChipsInput'
import { Field, Switch, TextArea, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'
import { patchInputDef, renameInputKey } from '../syncInputDefs'
import {
  atomicNodeInspectorChange,
  continuousNodeInspectorChange,
  InspectorHistoryBoundary,
  type InspectorChangeMeta,
} from './historyMeta'
import { NodeTitleField } from './NodeTitleField'
import type { EditProps } from './types'

export function InputEdit({
  node,
  definition,
  onPatch,
  onCommitDef,
  onHistoryBoundary,
}: EditProps) {
  const { t } = useTranslation()
  const rec = node as unknown as Record<string, unknown>
  const key = typeof rec.inputKey === 'string' ? rec.inputKey : ''
  const [keyDraft, setKeyDraft] = useState(key)
  useEffect(() => setKeyDraft(key), [key, node.id])
  // RFC-004: inputKey is the single source of truth for the launcher form
  // entry. Edits to the launcher field's kind / label / required /
  // description land on definition.inputs[].
  const inputDef: WorkflowInput | undefined = (definition.inputs ?? []).find((i) => i.key === key)
  const inputKind = (inputDef?.kind ?? 'text') as WorkflowInput['kind']
  const inputLabel = inputDef?.label ?? key
  const inputRequired = inputDef?.required ?? true
  const inputDescription = inputDef?.description ?? ''
  const normalizedKeyDraft = keyDraft.trim()
  const duplicateKey =
    definition.nodes.some(
      (candidate) =>
        candidate.id !== node.id &&
        candidate.kind === 'input' &&
        (candidate as unknown as Record<string, unknown>).inputKey === normalizedKeyDraft,
    ) ||
    (definition.inputs ?? []).some(
      (candidate) => candidate.key === normalizedKeyDraft && candidate.key !== key,
    )
  const inputKeyError =
    normalizedKeyDraft === ''
      ? t('inspector.fieldInputKeyRequired')
      : duplicateKey
        ? t('inspector.fieldInputKeyDuplicate', { key: normalizedKeyDraft })
        : undefined
  const inputKeyMeta = atomicNodeInspectorChange(node.id, 'inputKey', t('inspector.fieldInputKey'))
  const inputLabelMeta = continuousNodeInspectorChange(
    node.id,
    'input.label',
    t('inspector.fieldInputLabel'),
  )
  const inputDescriptionMeta = continuousNodeInspectorChange(
    node.id,
    'input.description',
    t('inspector.fieldInputDescription'),
  )
  return (
    <div className="form-grid">
      <NodeTitleField node={node} onPatch={onPatch} onHistoryBoundary={onHistoryBoundary} />
      <Field
        label={t('inspector.fieldInputKey')}
        required
        hint={t('inspector.fieldInputKeyHint')}
        error={inputKeyError}
        errorId={`input-key-error-${node.id}`}
      >
        <TextInput
          value={keyDraft}
          onChange={setKeyDraft}
          onBlur={() => {
            if (inputKeyError !== undefined) return
            if (normalizedKeyDraft === key) {
              setKeyDraft(key)
              return
            }
            onCommitDef(renameInputKey(definition, node.id, normalizedKeyDraft), inputKeyMeta)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.currentTarget.blur()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setKeyDraft(key)
              event.currentTarget.blur()
            }
          }}
          aria-invalid={inputKeyError === undefined ? undefined : true}
          aria-errormessage={inputKeyError === undefined ? undefined : `input-key-error-${node.id}`}
        />
      </Field>
      <Field label={t('inspector.fieldInputKind')} hint={t('inspector.fieldInputKindHint')}>
        <Select<WorkflowInput['kind']>
          value={inputKind}
          ariaLabel={t('inspector.fieldInputKind')}
          onChange={(v) =>
            onCommitDef(
              patchInputDef(definition, key, { kind: v }),
              atomicNodeInspectorChange(node.id, 'input.kind', t('inspector.fieldInputKind')),
            )
          }
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
          nodeId={node.id}
          def={inputDef ?? { kind: 'upload', key, label: inputLabel }}
          onPatch={(patch, meta) => onCommitDef(patchInputDef(definition, key, patch), meta)}
          onHistoryBoundary={onHistoryBoundary}
        />
      )}
      <Field label={t('inspector.fieldInputLabel')} hint={t('inspector.fieldInputLabelHint')}>
        <InspectorHistoryBoundary meta={inputLabelMeta} onBoundary={onHistoryBoundary}>
          <TextInput
            value={inputLabel}
            onChange={(v) =>
              onCommitDef(patchInputDef(definition, key, { label: v }), inputLabelMeta)
            }
          />
        </InspectorHistoryBoundary>
      </Field>
      <Field label={t('inspector.fieldInputRequired')}>
        <Switch
          checked={inputRequired}
          onChange={(c) =>
            onCommitDef(
              patchInputDef(definition, key, { required: c }),
              atomicNodeInspectorChange(
                node.id,
                'input.required',
                t('inspector.fieldInputRequired'),
              ),
            )
          }
          label={t('inspector.fieldInputRequired')}
        />
      </Field>
      <Field
        label={t('inspector.fieldInputDescription')}
        hint={t('inspector.fieldInputDescriptionHint')}
      >
        <InspectorHistoryBoundary meta={inputDescriptionMeta} onBoundary={onHistoryBoundary}>
          <TextArea
            value={inputDescription}
            rows={3}
            onChange={(v) =>
              onCommitDef(patchInputDef(definition, key, { description: v }), inputDescriptionMeta)
            }
          />
        </InspectorHistoryBoundary>
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
  nodeId,
  def,
  onPatch,
  onHistoryBoundary,
}: {
  nodeId: string
  def: WorkflowInput
  onPatch: (patch: Partial<WorkflowInput>, meta: InspectorChangeMeta) => void
  onHistoryBoundary: (meta: InspectorChangeMeta) => void
}) {
  const { t } = useTranslation()
  const rec = def as Record<string, unknown>
  const targetDir = typeof rec.targetDir === 'string' ? rec.targetDir : ''
  const acceptArr = Array.isArray(rec.accept) ? (rec.accept as string[]) : []
  const maxFileSize = typeof rec.maxFileSize === 'number' ? rec.maxFileSize : undefined
  const minCount = typeof rec.minCount === 'number' ? rec.minCount : undefined
  const maxCount = typeof rec.maxCount === 'number' ? rec.maxCount : undefined
  const targetDirInvalid =
    targetDir === '' ||
    targetDir.includes('..') ||
    targetDir.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(targetDir)
  const targetDirMeta = continuousNodeInspectorChange(
    nodeId,
    'input.targetDir',
    t('inspector.upload.targetDir'),
  )
  const acceptMeta = continuousNodeInspectorChange(
    nodeId,
    'input.accept',
    t('inspector.upload.accept'),
  )
  const maxFileSizeMeta = continuousNodeInspectorChange(
    nodeId,
    'input.maxFileSize',
    t('inspector.upload.maxFileSize'),
  )
  const minCountMeta = continuousNodeInspectorChange(
    nodeId,
    'input.minCount',
    t('inspector.upload.minCount'),
  )
  const maxCountMeta = continuousNodeInspectorChange(
    nodeId,
    'input.maxCount',
    t('inspector.upload.maxCount'),
  )
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
        <InspectorHistoryBoundary meta={targetDirMeta} onBoundary={onHistoryBoundary}>
          <TextInput
            value={targetDir}
            onChange={(v) =>
              onPatch({ ...(def as object), targetDir: v } as Partial<WorkflowInput>, targetDirMeta)
            }
            placeholder="inputs/refs"
          />
        </InspectorHistoryBoundary>
      </Field>
      <Field label={t('inspector.upload.accept')} hint={t('inspector.upload.acceptHint')}>
        <InspectorHistoryBoundary meta={acceptMeta} onBoundary={onHistoryBoundary}>
          <ChipsInput
            value={acceptArr}
            onChange={(next) =>
              onPatch({ ...(def as object), accept: next } as Partial<WorkflowInput>, acceptMeta)
            }
            placeholder=".pdf, image/*"
            testidPrefix="upload-accept"
          />
        </InspectorHistoryBoundary>
      </Field>
      <Field label={t('inspector.upload.maxFileSize')} hint={t('inspector.upload.maxFileSizeHint')}>
        <InspectorHistoryBoundary meta={maxFileSizeMeta} onBoundary={onHistoryBoundary}>
          <input
            className="form-input"
            type="number"
            min={1}
            value={maxFileSize ?? ''}
            onChange={(e) => {
              const raw = e.target.value
              const n = raw === '' ? undefined : Number(raw)
              onPatch(
                {
                  ...(def as object),
                  maxFileSize: n,
                } as Partial<WorkflowInput>,
                maxFileSizeMeta,
              )
            }}
            placeholder="52428800"
          />
        </InspectorHistoryBoundary>
      </Field>
      <Field label={t('inspector.upload.minCount')}>
        <InspectorHistoryBoundary meta={minCountMeta} onBoundary={onHistoryBoundary}>
          <input
            className="form-input"
            type="number"
            min={0}
            value={minCount ?? ''}
            onChange={(e) => {
              const raw = e.target.value
              const n = raw === '' ? undefined : Number(raw)
              onPatch({ ...(def as object), minCount: n } as Partial<WorkflowInput>, minCountMeta)
            }}
          />
        </InspectorHistoryBoundary>
      </Field>
      <Field label={t('inspector.upload.maxCount')}>
        <InspectorHistoryBoundary meta={maxCountMeta} onBoundary={onHistoryBoundary}>
          <input
            className="form-input"
            type="number"
            min={1}
            value={maxCount ?? ''}
            onChange={(e) => {
              const raw = e.target.value
              const n = raw === '' ? undefined : Number(raw)
              onPatch({ ...(def as object), maxCount: n } as Partial<WorkflowInput>, maxCountMeta)
            }}
          />
        </InspectorHistoryBoundary>
      </Field>
    </>
  )
}
