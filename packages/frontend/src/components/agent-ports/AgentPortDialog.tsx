// RFC-194 T3 — transactional add/edit dialog shared by agent input/output ports.
// The parent owns only committed arrays/maps; every intermediate value stays local
// so Cancel, ×, Escape, and stale/helper failures never leak a partial mutation.

import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import {
  AgentOutputKindSchema,
  DEFAULT_OUTPUT_KIND,
  isRegisteredKindString,
  type AgentInputPort,
  type AgentRole,
} from '@agent-workflow/shared'
import { Dialog } from '@/components/Dialog'
import { Field, Switch, TextArea, TextInput } from '@/components/Form'
import { KindSelect } from '@/components/KindSelect'
import {
  addInputPort,
  addOutputPort,
  replaceInputPort,
  replaceOutputPort,
  validatePortName,
  type MutableOutputPortState,
  type OutputPortState,
  type PortMutationFailureReason,
} from '@/lib/agent-ports'

export type AgentPortDialogMode = { kind: 'add' } | { kind: 'edit'; index: number }

interface AgentPortDialogCommonProps {
  open: boolean
  mode: AgentPortDialogMode
  onClose: () => void
  triggerRef?: RefObject<HTMLElement | null>
  /** Stable test anchor. Defaults to `agent-port`. */
  testidPrefix?: string
  /** The route already owns the page's sole live port-validation alert. */
  hasExternalPortAlert?: boolean
}

export interface InputAgentPortDialogProps extends AgentPortDialogCommonProps {
  direction: 'input'
  inputs: readonly AgentInputPort[]
  onCommit: (inputs: AgentInputPort[]) => void
}

export interface OutputAgentPortDialogProps extends AgentPortDialogCommonProps {
  direction: 'output'
  outputState: OutputPortState
  role: AgentRole
  onCommit: (state: MutableOutputPortState) => void
}

export type AgentPortDialogProps = InputAgentPortDialogProps | OutputAgentPortDialogProps

export interface AgentPortDialogDraft {
  name: string
  kind: string
  required: boolean
  description: string
  wrapperPortName: string
}

interface LocalState {
  draft: AgentPortDialogDraft
  originalName?: string
  originalTargetSnapshot?: string
  staleAtOpen: boolean
}

function emptyDraft(): AgentPortDialogDraft {
  return {
    name: '',
    kind: DEFAULT_OUTPUT_KIND,
    required: false,
    description: '',
    wrapperPortName: '',
  }
}

function mapEntrySnapshot(
  map: Readonly<Record<string, unknown>> | undefined,
  key: string,
): readonly unknown[] {
  return map !== undefined && Object.prototype.hasOwnProperty.call(map, key)
    ? [true, map[key]]
    : [false]
}

/**
 * Captures every persisted field this transaction can replace for its target.
 * A clean-follow query refresh may keep the same port name while changing its
 * kind/metadata sidecars; comparing only the name would let the stale local
 * draft overwrite that newer server state on Save.
 */
function targetSnapshot(props: AgentPortDialogProps): string | undefined {
  if (props.mode.kind !== 'edit') return undefined
  if (props.direction === 'input') {
    const port = props.inputs[props.mode.index]
    if (port === undefined) return undefined
    return JSON.stringify([
      'input',
      port.name,
      port.kind,
      Object.prototype.hasOwnProperty.call(port, 'required'),
      port.required,
      Object.prototype.hasOwnProperty.call(port, 'description'),
      port.description,
    ])
  }

  const name = props.outputState.outputs[props.mode.index]
  if (name === undefined) return undefined
  return JSON.stringify([
    'output',
    name,
    mapEntrySnapshot(props.outputState.outputKinds, name),
    mapEntrySnapshot(props.outputState.outputWrapperPortNames, name),
    props.role,
  ])
}

function seedLocalState(props: AgentPortDialogProps): LocalState {
  if (props.mode.kind === 'add') {
    return { draft: emptyDraft(), staleAtOpen: false }
  }

  if (props.direction === 'input') {
    const port = props.inputs[props.mode.index]
    if (port === undefined) return { draft: emptyDraft(), staleAtOpen: true }
    return {
      originalName: port.name,
      originalTargetSnapshot: targetSnapshot(props),
      staleAtOpen: false,
      draft: {
        name: port.name,
        kind: port.kind === '' ? DEFAULT_OUTPUT_KIND : port.kind,
        required: port.required === true,
        description: port.description ?? '',
        wrapperPortName: '',
      },
    }
  }

  const name = props.outputState.outputs[props.mode.index]
  if (name === undefined) return { draft: emptyDraft(), staleAtOpen: true }
  return {
    originalName: name,
    originalTargetSnapshot: targetSnapshot(props),
    staleAtOpen: false,
    draft: {
      ...emptyDraft(),
      name,
      kind: props.outputState.outputKinds?.[name] ?? DEFAULT_OUTPUT_KIND,
      wrapperPortName: props.outputState.outputWrapperPortNames?.[name] ?? '',
    },
  }
}

function effectiveDraftWrapperName(args: {
  raw: string
  nextName: string
  originalWrapper: string | undefined
}): string {
  const { raw, nextName, originalWrapper } = args
  if (originalWrapper !== undefined && raw === originalWrapper) return originalWrapper
  const trimmed = raw.trim()
  return trimmed === '' || trimmed === nextName ? nextName : trimmed
}

function hasEffectiveWrapperDuplicate(args: {
  props: OutputAgentPortDialogProps
  draft: AgentPortDialogDraft
  nextName: string
  originalName: string | undefined
}): boolean {
  const { props, draft, nextName, originalName } = args
  if (props.role !== 'aggregator') return false

  const candidateIndex =
    props.mode.kind === 'add' ? props.outputState.outputs.length : props.mode.index
  const outputs = [...props.outputState.outputs]
  if (props.mode.kind === 'add') outputs.push(nextName)
  else outputs[candidateIndex] = nextName

  const originalWrapper =
    originalName === undefined
      ? undefined
      : props.outputState.outputWrapperPortNames?.[originalName]
  const candidateWrapper = effectiveDraftWrapperName({
    raw: draft.wrapperPortName,
    nextName,
    originalWrapper,
  })
  const seen = new Set<string>()
  for (let index = 0; index < outputs.length; index += 1) {
    const outputName = outputs[index]
    if (outputName === undefined) continue
    const effectiveName =
      index === candidateIndex
        ? candidateWrapper
        : (props.outputState.outputWrapperPortNames?.[outputName] ?? outputName)
    if (seen.has(effectiveName)) return true
    seen.add(effectiveName)
  }
  return false
}

export function AgentPortDialog(props: AgentPortDialogProps) {
  const { t } = useTranslation()
  const [local, setLocal] = useState<LocalState>(() => seedLocalState(props))
  const [kindValid, setKindValid] = useState(() => isRegisteredKindString(local.draft.kind))
  const [kindTouched, setKindTouched] = useState(false)
  const [nameTouched, setNameTouched] = useState(false)
  const [wrapperTouched, setWrapperTouched] = useState(false)
  const [submitFailure, setSubmitFailure] = useState<PortMutationFailureReason | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const latestPropsRef = useRef(props)
  latestPropsRef.current = props

  const nameErrorId = useId()
  const kindLabelId = useId()
  const requiredLabelId = useId()
  const wrapperErrorId = useId()

  const identity =
    props.mode.kind === 'add'
      ? `${props.direction}:add`
      : `${props.direction}:edit:${props.mode.index}`

  // Re-seed only when a dialog opens or its direction/mode/index identity
  // changes. Parent renders while the transaction is open must not erase the
  // user's local edits.
  useEffect(() => {
    if (!props.open) return
    const seeded = seedLocalState(latestPropsRef.current)
    setLocal(seeded)
    setKindValid(isRegisteredKindString(seeded.draft.kind))
    setKindTouched(false)
    setNameTouched(false)
    setWrapperTouched(false)
    setSubmitFailure(seeded.staleAtOpen ? 'index-out-of-range' : null)
  }, [props.open, identity])

  const draft = local.draft
  const existingNames =
    props.direction === 'input' ? props.inputs.map((port) => port.name) : props.outputState.outputs
  const nameResult = validatePortName({
    raw: draft.name,
    direction: props.direction,
    existingNames,
    ...(props.mode.kind === 'edit'
      ? { editingIndex: props.mode.index, originalName: local.originalName }
      : {}),
  })
  const targetStale =
    local.staleAtOpen ||
    (props.mode.kind === 'edit' && targetSnapshot(props) !== local.originalTargetSnapshot)

  const nameValidationError = nameResult.ok
    ? undefined
    : nameResult.reason === 'required'
      ? t('agentForm.ports.errorRequired')
      : nameResult.reason === 'format'
        ? t('agentForm.ports.errorFormat')
        : nameResult.reason === 'too-long'
          ? t('agentForm.ports.errorTooLong')
          : t('agentForm.ports.errorDuplicate')
  const helperNameError =
    submitFailure === 'orphan-key-conflict'
      ? t('agentForm.ports.errorOrphanConflict')
      : submitFailure === 'name-duplicate'
        ? t('agentForm.ports.errorDuplicate')
        : submitFailure === 'name-invalid'
          ? t('agentForm.ports.errorFormat')
          : undefined
  const showNameValidation = props.mode.kind === 'edit' || nameTouched
  const nameError = helperNameError ?? (showNameValidation ? nameValidationError : undefined)

  const wrapperDuplicate =
    props.direction === 'output' && nameResult.ok
      ? hasEffectiveWrapperDuplicate({
          props,
          draft,
          nextName: nameResult.value,
          originalName: local.originalName,
        })
      : false
  const wrapperError =
    props.direction === 'output' && props.role === 'aggregator'
      ? submitFailure === 'wrapper-duplicate' || wrapperDuplicate
        ? t('agentForm.ports.errorWrapperDuplicate')
        : undefined
      : undefined

  const kindSchemaValid = AgentOutputKindSchema.safeParse(draft.kind).success
  const kindSchemaError =
    kindValid && !kindSchemaValid ? t('agentForm.ports.errorKindInvalid') : undefined
  const generalError =
    targetStale || submitFailure === 'index-out-of-range'
      ? t('agentForm.ports.errorStale')
      : undefined

  const descriptionValid = draft.description.length <= 2048
  const canSave =
    !targetStale &&
    submitFailure === null &&
    nameResult.ok &&
    kindValid &&
    kindSchemaValid &&
    !wrapperDuplicate &&
    descriptionValid
  const prefix = props.testidPrefix ?? 'agent-port'

  const title =
    props.direction === 'input'
      ? props.mode.kind === 'add'
        ? t('agentForm.ports.addInputDialogTitle')
        : t('agentForm.ports.editInputDialogTitle')
      : props.mode.kind === 'add'
        ? t('agentForm.ports.addOutputDialogTitle')
        : t('agentForm.ports.editOutputDialogTitle')

  const nameHint =
    nameResult.ok && nameResult.legacyPassThrough
      ? t('agentForm.ports.legacyWarning')
      : props.mode.kind === 'edit' && draft.name !== local.originalName
        ? t('agentForm.ports.renameWarning')
        : undefined

  function patchDraft(patch: Partial<AgentPortDialogDraft>) {
    setLocal((current) => ({ ...current, draft: { ...current.draft, ...patch } }))
    setSubmitFailure(null)
  }

  function commit() {
    setNameTouched(true)
    setSubmitFailure(null)
    if (targetStale) {
      setSubmitFailure('index-out-of-range')
      return
    }
    if (!canSave || !nameResult.ok) return

    if (props.direction === 'input') {
      const nextDraft = {
        name: nameResult.value,
        kind: draft.kind,
        required: draft.required,
        description: draft.description,
      }
      const inputs =
        props.mode.kind === 'add'
          ? addInputPort(props.inputs, nextDraft)
          : replaceInputPort(props.inputs, props.mode.index, nextDraft)
      props.onCommit(inputs)
      props.onClose()
      return
    }

    const nextDraft = {
      name: nameResult.value,
      kind: draft.kind,
      wrapperPortName: props.role === 'aggregator' ? draft.wrapperPortName : undefined,
    }
    const result =
      props.mode.kind === 'add'
        ? addOutputPort(props.outputState, nextDraft, { role: props.role })
        : replaceOutputPort(props.outputState, props.mode.index, nextDraft, { role: props.role })
    if (!result.ok) {
      setSubmitFailure(result.reason)
      return
    }
    props.onCommit(result.state)
    props.onClose()
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={title}
      size="md"
      initialFocusRef={nameInputRef}
      triggerRef={props.triggerRef}
      closeOnOverlayClick={false}
      data-testid={`${prefix}-dialog`}
      footer={
        <>
          {generalError !== undefined && (
            <span
              className="form-actions__error"
              role={props.hasExternalPortAlert === true ? undefined : 'alert'}
            >
              {generalError}
            </span>
          )}
          <button
            type="button"
            className="btn"
            onClick={props.onClose}
            data-testid={`${prefix}-cancel`}
          >
            {t('agentForm.ports.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canSave}
            onClick={commit}
            data-testid={`${prefix}-save`}
          >
            {props.mode.kind === 'add'
              ? t('agentForm.ports.saveAdd')
              : t('agentForm.ports.saveEdit')}
          </button>
        </>
      }
    >
      <div className="agent-port-dialog__fields">
        <Field
          label={t('agentForm.ports.fieldName')}
          hint={nameHint}
          error={nameError}
          errorId={nameErrorId}
          errorLive={nameTouched && props.hasExternalPortAlert !== true}
          required
        >
          <TextInput
            inputRef={nameInputRef}
            value={draft.name}
            onChange={(name) => {
              setNameTouched(true)
              patchDraft({ name })
            }}
            maxLength={props.direction === 'input' ? 128 : undefined}
            aria-invalid={nameError !== undefined}
            aria-describedby={nameError === undefined ? undefined : nameErrorId}
            data-testid={`${prefix}-name`}
          />
        </Field>

        <Field label={t('agentForm.ports.fieldKind')} labelId={kindLabelId} group>
          <KindSelect
            value={draft.kind}
            onChange={(kind) => patchDraft({ kind })}
            onValidityChange={setKindValid}
            ariaLabel={t('agentForm.ports.fieldKind')}
            contextLabel={draft.name.trim() === '' ? undefined : draft.name}
            validationError={kindSchemaError}
            errorLive={kindTouched && props.hasExternalPortAlert !== true}
            onEdit={() => setKindTouched(true)}
            testidPrefix={`${prefix}-kind`}
          />
        </Field>

        {props.direction === 'input' && (
          <>
            <Field label={t('agentForm.ports.fieldRequired')} labelId={requiredLabelId} group>
              <Switch
                checked={draft.required}
                onChange={(required) => patchDraft({ required })}
                aria-label={t('agentForm.ports.fieldRequired')}
                data-testid={`${prefix}-required`}
              />
            </Field>
            <Field
              label={t('agentForm.ports.fieldDescription')}
              hint={t('agentForm.ports.fieldDescriptionHint')}
            >
              <TextArea
                value={draft.description}
                onChange={(description) => patchDraft({ description })}
                rows={4}
                maxLength={2048}
                data-testid={`${prefix}-description`}
              />
            </Field>
          </>
        )}

        {props.direction === 'output' && props.role === 'aggregator' && (
          <Field
            label={t('agentForm.ports.fieldWrapperName')}
            hint={t('agentForm.ports.fieldWrapperNameHint')}
            error={wrapperError}
            errorId={wrapperErrorId}
            errorLive={wrapperTouched && props.hasExternalPortAlert !== true}
          >
            <TextInput
              value={draft.wrapperPortName}
              onChange={(wrapperPortName) => {
                setWrapperTouched(true)
                patchDraft({ wrapperPortName })
              }}
              aria-invalid={wrapperError !== undefined}
              aria-describedby={wrapperError === undefined ? undefined : wrapperErrorId}
              data-testid={`${prefix}-wrapper`}
            />
          </Field>
        )}
      </div>
    </Dialog>
  )
}
