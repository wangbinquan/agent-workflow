// RFC-194 T1 — pure data helpers for the Agent editor's input/output ports.
//
// Output ports are one logical value spread over three wire fields
// (`outputs`, `outputKinds`, and `outputWrapperPortNames`).  Keeping every
// mutation here makes rename/delete atomic, preserves sparse-update tombstones,
// and lets Dialog callers fail closed without partially changing their draft.

import {
  agentLaunchBlockers,
  AgentOutputKindSchema,
  DEFAULT_OUTPUT_KIND,
  type AgentInputPort,
  type AgentOutputKindsMap,
  type AgentRole,
} from '@agent-workflow/shared'

export const AGENT_PORT_NAME_RE = /^[a-z][a-z0-9_]*$/

export type AgentPortDirection = 'input' | 'output'

export interface ValidatePortNameOptions {
  raw: string
  direction: AgentPortDirection
  existingNames: readonly string[]
  editingIndex?: number
  originalName?: string
}

export type PortNameValidationResult =
  | { ok: true; value: string; legacyPassThrough: boolean }
  | { ok: false; reason: 'required' | 'format' | 'too-long' | 'duplicate' }

/**
 * Validate a newly-authored port identity while allowing a schema-readable,
 * unique legacy name to pass through byte-for-byte when it was not renamed.
 */
export function validatePortName({
  raw,
  direction,
  existingNames,
  editingIndex,
  originalName,
}: ValidatePortNameOptions): PortNameValidationResult {
  const unchanged = originalName !== undefined && raw === originalName
  const value = unchanged ? raw : raw.trim()

  // Inputs always retain their live schema's 1..128 boundary, including for
  // unchanged legacy values.  Outputs deliberately have no invented max.
  if (direction === 'input') {
    if (value.length === 0) return { ok: false, reason: 'required' }
    if (value.length > 128) return { ok: false, reason: 'too-long' }
  } else if (!unchanged && value.length === 0) {
    return { ok: false, reason: 'required' }
  }

  if (!unchanged && !AGENT_PORT_NAME_RE.test(value)) {
    return { ok: false, reason: 'format' }
  }

  const duplicate = existingNames.some((name, index) => index !== editingIndex && name === value)
  if (duplicate) return { ok: false, reason: 'duplicate' }

  return {
    ok: true,
    value,
    legacyPassThrough: unchanged && !AGENT_PORT_NAME_RE.test(value),
  }
}

export interface InputPortDraft {
  name: string
  kind: string
  required?: boolean
  description?: string
}

function compactInputPort(draft: InputPortDraft, originalName?: string): AgentInputPort {
  const name =
    originalName !== undefined && draft.name === originalName ? draft.name : draft.name.trim()
  const description = draft.description?.trim()
  return {
    name,
    kind: draft.kind,
    ...(draft.required === true ? { required: true } : {}),
    ...(description !== undefined && description.length > 0 ? { description } : {}),
  }
}

export function addInputPort(
  inputs: readonly AgentInputPort[],
  draft: InputPortDraft,
): AgentInputPort[] {
  return [...inputs, compactInputPort(draft)]
}

export function replaceInputPort(
  inputs: readonly AgentInputPort[],
  index: number,
  draft: InputPortDraft,
): AgentInputPort[] {
  const current = inputs[index]
  if (current === undefined) return [...inputs]
  const next = [...inputs]
  next[index] = compactInputPort(draft, current.name)
  return next
}

export function removeInputPort(
  inputs: readonly AgentInputPort[],
  index: number,
): AgentInputPort[] {
  if (index < 0 || index >= inputs.length) return [...inputs]
  return inputs.filter((_, currentIndex) => currentIndex !== index)
}

export interface OutputPortState {
  outputs: readonly string[]
  outputKinds?: Readonly<AgentOutputKindsMap>
  outputWrapperPortNames?: Readonly<Record<string, string>>
}

export interface MutableOutputPortState {
  outputs: string[]
  outputKinds?: AgentOutputKindsMap
  outputWrapperPortNames?: Record<string, string>
}

export interface OutputPortDraft {
  name: string
  kind: string
  /** undefined means the role-hidden field was not touched. */
  wrapperPortName?: string
}

export interface OutputPortMutationOptions {
  role: AgentRole
}

export type PortMutationFailureReason =
  | 'index-out-of-range'
  | 'name-invalid'
  | 'name-duplicate'
  | 'kind-invalid'
  | 'orphan-key-conflict'
  | 'wrapper-duplicate'

export type PortMutationResult =
  | { ok: true; state: MutableOutputPortState }
  | { ok: false; reason: PortMutationFailureReason }

export type OrphanSidecarSource = 'outputKinds' | 'outputWrapperPortNames'

export interface OrphanSidecarRef {
  source: OrphanSidecarSource
  key: string
}

const hasOwn = (record: object | undefined, key: string): boolean =>
  record !== undefined && Object.prototype.hasOwnProperty.call(record, key)

function setMapEntry<T extends string>(
  original: Readonly<Record<string, T>> | undefined,
  key: string,
  value: T | undefined,
): Record<string, T> | undefined {
  if (value === undefined) {
    if (!hasOwn(original, key)) return original === undefined ? undefined : { ...original }
    const next = { ...original }
    delete next[key]
    // Deliberately return {}, not undefined: an existing map whose final entry
    // was explicitly deleted must be sent as a sparse-update tombstone.
    return next
  }
  return { ...(original ?? {}), [key]: value }
}

function normalizeWrapperPortName(
  raw: string | undefined,
  nextName: string,
  previousValue: string | undefined,
): string | undefined {
  // normal-role edits do not surface this field; undefined is an explicit
  // "preserve" signal.  It also lets an aggregator no-op edit preserve a
  // legacy value byte-for-byte.
  if (raw === undefined) return previousValue
  if (previousValue !== undefined && raw === previousValue) return previousValue
  const value = raw.trim()
  return value.length === 0 || value === nextName ? undefined : value
}

function hasOrphanSidecarKey(state: OutputPortState, key: string): boolean {
  if (state.outputs.includes(key)) return false
  return hasOwn(state.outputKinds, key) || hasOwn(state.outputWrapperPortNames, key)
}

function wrapperValue(
  map: Readonly<Record<string, string>> | undefined,
  outputName: string,
): string {
  return map?.[outputName] ?? outputName
}

function duplicateEffectiveWrapperNames(
  outputs: readonly string[],
  map: Readonly<Record<string, string>> | undefined,
): Map<string, number[]> {
  const byName = new Map<string, number[]>()
  outputs.forEach((outputName, index) => {
    const effectiveName = wrapperValue(map, outputName)
    const indices = byName.get(effectiveName)
    if (indices === undefined) byName.set(effectiveName, [index])
    else indices.push(index)
  })
  for (const [name, indices] of byName) {
    if (indices.length < 2) byName.delete(name)
  }
  return byName
}

function applyOutputSidecars(args: {
  state: OutputPortState
  oldName?: string
  oldNameStillDeclared: boolean
  nextName: string
  nextKind: string
  wrapperPortName: string | undefined
  role: AgentRole
}): Pick<MutableOutputPortState, 'outputKinds' | 'outputWrapperPortNames'> {
  const { state, oldName, oldNameStillDeclared, nextName, nextKind, role } = args
  const originalWrapper =
    oldName === undefined ? undefined : state.outputWrapperPortNames?.[oldName]

  let outputKinds =
    oldName !== undefined && oldName !== nextName && !oldNameStillDeclared
      ? setMapEntry(state.outputKinds, oldName, undefined)
      : state.outputKinds === undefined
        ? undefined
        : { ...state.outputKinds }
  outputKinds = setMapEntry(
    outputKinds,
    nextName,
    nextKind === DEFAULT_OUTPUT_KIND ? undefined : nextKind,
  )

  let outputWrapperPortNames =
    oldName !== undefined && oldName !== nextName && !oldNameStillDeclared
      ? setMapEntry(state.outputWrapperPortNames, oldName, undefined)
      : state.outputWrapperPortNames === undefined
        ? undefined
        : { ...state.outputWrapperPortNames }

  const finalWrapper =
    role === 'aggregator'
      ? normalizeWrapperPortName(args.wrapperPortName, nextName, originalWrapper)
      : originalWrapper
  outputWrapperPortNames = setMapEntry(outputWrapperPortNames, nextName, finalWrapper)

  return { outputKinds, outputWrapperPortNames }
}

export function addOutputPort(
  state: OutputPortState,
  draft: OutputPortDraft,
  { role }: OutputPortMutationOptions,
): PortMutationResult {
  const nameResult = validatePortName({
    raw: draft.name,
    direction: 'output',
    existingNames: state.outputs,
  })
  if (!nameResult.ok) {
    return {
      ok: false,
      reason: nameResult.reason === 'duplicate' ? 'name-duplicate' : 'name-invalid',
    }
  }
  if (!AgentOutputKindSchema.safeParse(draft.kind).success) {
    return { ok: false, reason: 'kind-invalid' }
  }
  if (hasOrphanSidecarKey(state, nameResult.value)) {
    return { ok: false, reason: 'orphan-key-conflict' }
  }

  const outputs = [...state.outputs, nameResult.value]
  const sidecars = applyOutputSidecars({
    state,
    oldNameStillDeclared: false,
    nextName: nameResult.value,
    nextKind: draft.kind,
    wrapperPortName: draft.wrapperPortName,
    role,
  })
  if (
    role === 'aggregator' &&
    duplicateEffectiveWrapperNames(outputs, sidecars.outputWrapperPortNames).size > 0
  ) {
    return { ok: false, reason: 'wrapper-duplicate' }
  }
  return { ok: true, state: { outputs, ...sidecars } }
}

export function replaceOutputPort(
  state: OutputPortState,
  index: number,
  draft: OutputPortDraft,
  { role }: OutputPortMutationOptions,
): PortMutationResult {
  const oldName = state.outputs[index]
  if (oldName === undefined) return { ok: false, reason: 'index-out-of-range' }

  const nameResult = validatePortName({
    raw: draft.name,
    direction: 'output',
    existingNames: state.outputs,
    editingIndex: index,
    originalName: oldName,
  })
  if (!nameResult.ok) {
    return {
      ok: false,
      reason: nameResult.reason === 'duplicate' ? 'name-duplicate' : 'name-invalid',
    }
  }
  if (!AgentOutputKindSchema.safeParse(draft.kind).success) {
    return { ok: false, reason: 'kind-invalid' }
  }
  if (nameResult.value !== oldName && hasOrphanSidecarKey(state, nameResult.value)) {
    return { ok: false, reason: 'orphan-key-conflict' }
  }

  const outputs = [...state.outputs]
  outputs[index] = nameResult.value
  const oldNameStillDeclared = outputs.includes(oldName)
  const sidecars = applyOutputSidecars({
    state,
    oldName,
    oldNameStillDeclared,
    nextName: nameResult.value,
    nextKind: draft.kind,
    wrapperPortName: draft.wrapperPortName,
    role,
  })
  if (
    role === 'aggregator' &&
    duplicateEffectiveWrapperNames(outputs, sidecars.outputWrapperPortNames).size > 0
  ) {
    return { ok: false, reason: 'wrapper-duplicate' }
  }
  return { ok: true, state: { outputs, ...sidecars } }
}

export function removeOutputPort(state: OutputPortState, index: number): MutableOutputPortState {
  const name = state.outputs[index]
  if (name === undefined) {
    return {
      outputs: [...state.outputs],
      ...(state.outputKinds === undefined ? {} : { outputKinds: { ...state.outputKinds } }),
      ...(state.outputWrapperPortNames === undefined
        ? {}
        : { outputWrapperPortNames: { ...state.outputWrapperPortNames } }),
    }
  }

  const outputs = state.outputs.filter((_, currentIndex) => currentIndex !== index)
  if (outputs.includes(name)) {
    return {
      outputs,
      ...(state.outputKinds === undefined ? {} : { outputKinds: { ...state.outputKinds } }),
      ...(state.outputWrapperPortNames === undefined
        ? {}
        : { outputWrapperPortNames: { ...state.outputWrapperPortNames } }),
    }
  }
  return {
    outputs,
    outputKinds: setMapEntry(state.outputKinds, name, undefined),
    outputWrapperPortNames: setMapEntry(state.outputWrapperPortNames, name, undefined),
  }
}

export function findOrphanOutputSidecars(state: OutputPortState): OrphanSidecarRef[] {
  const declared = new Set(state.outputs)
  const refs: OrphanSidecarRef[] = []
  for (const key of Object.keys(state.outputKinds ?? {})) {
    if (!declared.has(key)) refs.push({ source: 'outputKinds', key })
  }
  for (const key of Object.keys(state.outputWrapperPortNames ?? {})) {
    if (!declared.has(key)) refs.push({ source: 'outputWrapperPortNames', key })
  }
  return refs
}

export function removeOrphanOutputSidecars(
  state: OutputPortState,
  refs: readonly OrphanSidecarRef[],
): MutableOutputPortState {
  const declared = new Set(state.outputs)
  let outputKinds = state.outputKinds === undefined ? undefined : { ...state.outputKinds }
  let outputWrapperPortNames =
    state.outputWrapperPortNames === undefined ? undefined : { ...state.outputWrapperPortNames }

  for (const ref of refs) {
    // A stale confirmation must never remove a sidecar that has since become
    // declared.  source+key also prevents a same-key cleanup in one map from
    // deleting the other map's independent value.
    if (declared.has(ref.key)) continue
    if (ref.source === 'outputKinds') {
      outputKinds = setMapEntry(outputKinds, ref.key, undefined)
    } else {
      outputWrapperPortNames = setMapEntry(outputWrapperPortNames, ref.key, undefined)
    }
  }

  return { outputs: [...state.outputs], outputKinds, outputWrapperPortNames }
}

export type AgentPortValidationIssueCode =
  | 'input-name-schema'
  | 'input-name-duplicate'
  | 'output-name-duplicate'
  | 'input-name-launch-blocked'
  | 'output-kind-invalid'
  | 'wrapper-name-duplicate'
  | 'reserved-port-sidecar-key'
  | 'orphan-output-kind'
  | 'orphan-wrapper-name'

export interface AgentPortValidationIssue {
  severity: 'error' | 'warning'
  repairTarget: 'ports' | 'advanced'
  code: AgentPortValidationIssueCode
  name?: string
  index?: number
  indices?: number[]
  key?: string
  source?: OrphanSidecarSource | 'frontmatterExtra'
  value?: unknown
}

export interface AgentPortValidationDraft {
  inputs?: ReadonlyArray<{ name: unknown }>
  outputs?: readonly string[]
  outputKinds?: Readonly<Record<string, unknown>>
  outputWrapperPortNames?: Readonly<Record<string, unknown>>
  role?: AgentRole
  frontmatterExtra?: Readonly<Record<string, unknown>>
}

export interface AgentPortValidationResult {
  valid: boolean
  issues: AgentPortValidationIssue[]
}

function duplicateIndices(values: readonly string[]): Map<string, number[]> {
  const result = new Map<string, number[]>()
  values.forEach((value, index) => {
    const indices = result.get(value)
    if (indices === undefined) result.set(value, [index])
    else indices.push(index)
  })
  for (const [value, indices] of result) {
    if (indices.length < 2) result.delete(value)
  }
  return result
}

const RESERVED_PORT_SIDECAR_KEYS = ['outputKinds', 'role', 'outputWrapperPortNames'] as const

/** Global repair gate shared by the form and both route-level Save actions. */
export function validateAgentPortState(draft: AgentPortValidationDraft): AgentPortValidationResult {
  const issues: AgentPortValidationIssue[] = []
  const inputs = draft.inputs ?? []
  const outputs = draft.outputs ?? []

  inputs.forEach((input, index) => {
    if (typeof input.name !== 'string' || input.name.length < 1 || input.name.length > 128) {
      issues.push({
        severity: 'error',
        repairTarget: 'ports',
        code: 'input-name-schema',
        index,
        ...(typeof input.name === 'string' ? { name: input.name } : {}),
      })
    }
  })
  // RFC-218 (design P2-3): the SHARED launch-blocker predicate, surfaced at
  // authoring time. A port whose name cannot ride a `{{token}}` (non-\w+, the
  // reserved `__…__` dunder family, record poison keys) makes the agent
  // impossible to launch manually — warn here (never block the save; the
  // read path stays lenient per RFC-166).
  inputs.forEach((input, index) => {
    if (typeof input.name !== 'string' || input.name.length < 1) return
    const blocked = agentLaunchBlockers([{ name: input.name, kind: 'string' }]).some(
      (b) => b.kind === 'invalid-port-name',
    )
    if (blocked) {
      issues.push({
        severity: 'warning',
        repairTarget: 'ports',
        code: 'input-name-launch-blocked',
        index,
        name: input.name,
      })
    }
  })
  const stringInputNames = inputs.map((input) =>
    typeof input.name === 'string' ? input.name : `\u0000invalid-input-${String(input.name)}`,
  )
  for (const [name, indices] of duplicateIndices(stringInputNames)) {
    if (name.startsWith('\u0000invalid-input-')) continue
    issues.push({
      severity: 'error',
      repairTarget: 'ports',
      code: 'input-name-duplicate',
      name,
      indices,
    })
  }
  for (const [name, indices] of duplicateIndices(outputs)) {
    issues.push({
      severity: 'error',
      repairTarget: 'ports',
      code: 'output-name-duplicate',
      name,
      indices,
    })
  }

  const declared = new Set(outputs)
  for (const [key, value] of Object.entries(draft.outputKinds ?? {})) {
    if (!AgentOutputKindSchema.safeParse(value).success) {
      issues.push({
        severity: 'error',
        repairTarget: 'ports',
        code: 'output-kind-invalid',
        key,
        source: 'outputKinds',
        value,
      })
    }
  }

  const wrapperMap: Record<string, string> = {}
  for (const [key, value] of Object.entries(draft.outputWrapperPortNames ?? {})) {
    if (typeof value === 'string') wrapperMap[key] = value
  }
  const wrapperDuplicates = duplicateEffectiveWrapperNames(outputs, wrapperMap)
  for (const [name, indices] of wrapperDuplicates) {
    issues.push({
      severity: draft.role === 'aggregator' ? 'error' : 'warning',
      // A normal agent intentionally hides the promotion editor. Its retained
      // mapping becomes editable only after switching role in Advanced.
      repairTarget: draft.role === 'aggregator' ? 'ports' : 'advanced',
      code: 'wrapper-name-duplicate',
      name,
      indices,
    })
  }

  for (const key of RESERVED_PORT_SIDECAR_KEYS) {
    if (!hasOwn(draft.frontmatterExtra, key)) continue
    issues.push({
      severity: 'error',
      repairTarget: 'advanced',
      code: 'reserved-port-sidecar-key',
      key,
      source: 'frontmatterExtra',
      value: draft.frontmatterExtra?.[key],
    })
  }

  for (const [key, value] of Object.entries(draft.outputKinds ?? {})) {
    if (declared.has(key)) continue
    issues.push({
      severity: 'warning',
      repairTarget: 'ports',
      code: 'orphan-output-kind',
      key,
      source: 'outputKinds',
      value,
    })
  }
  for (const [key, value] of Object.entries(draft.outputWrapperPortNames ?? {})) {
    if (declared.has(key)) continue
    issues.push({
      severity: 'warning',
      repairTarget: 'ports',
      code: 'orphan-wrapper-name',
      key,
      source: 'outputWrapperPortNames',
      value,
    })
  }

  return { valid: !issues.some((issue) => issue.severity === 'error'), issues }
}
