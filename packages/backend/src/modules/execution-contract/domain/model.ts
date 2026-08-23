import { z } from 'zod'

export interface LocalizedContractText {
  'zh-CN': string
  'en-US': string
}

export interface ExecutionContractRef {
  contractId: string
  version: number
}

export interface ExecutionContractField {
  path: string
  label: LocalizedContractText
  description: LocalizedContractText
  valueType: 'string' | 'number' | 'boolean' | 'enum' | 'object' | 'array' | 'json'
  required: boolean
  source: 'platform' | 'work-input' | 'event' | 'context' | 'artifact'
  condition: LocalizedContractText | null
  example: string | null
}

export interface ExecutionContractSchemaGuide {
  schemaId: string
  displayName: LocalizedContractText
  description: LocalizedContractText
  topLevelFields: string[]
  /** Small, author-selected business surface shown before the full envelope. */
  primaryFieldPaths: string[]
  fields: ExecutionContractField[]
  exampleJson: string
}

interface ExecutionContractTransportGuide {
  inputLocation: string
  outputLocation: string
  /** Exact executor port. Omitted guides keep the legacy agent-result port. */
  outputPort?: string
  /** Optional scheduler port kind for non-envelope artifacts such as path<md>. */
  outputKind?: string
  inputInstruction: LocalizedContractText
  outputInstruction: LocalizedContractText
}

export interface ExecutionContractGuide {
  schemaVersion: 1
  outputMode: 'envelope' | 'artifact-path'
  contractRef: ExecutionContractRef
  displayName: LocalizedContractText
  description: LocalizedContractText
  input: ExecutionContractSchemaGuide
  output: ExecutionContractSchemaGuide
  allowedExecutorKinds: Array<'agent' | 'workflow' | 'program'>
  transports: {
    agent: ExecutionContractTransportGuide | null
    workflow: ExecutionContractTransportGuide | null
    program: ExecutionContractTransportGuide | null
  }
}

/** Narrow cross-context projection; the full authoring guide stays serialized. */
export interface ExecutionContractRuntimeView {
  schemaVersion: 1
  outputMode: 'envelope' | 'artifact-path'
  contractRef: ExecutionContractRef
  displayName: LocalizedContractText
  description: LocalizedContractText
  inputSchemaId: string
  outputSchemaId: string
  outputTopLevelFields: string[]
  allowedExecutorKinds: Array<'agent' | 'workflow' | 'program'>
  agentOutputPort: string | null
  agentOutputKind: string | null
  guideJson: string
}

interface ExactExecutionContractResourceRef {
  id: string
  revision: number
}

export type ExecutionContractImplementation =
  | { kind: 'agent'; agentRef: ExactExecutionContractResourceRef }
  | { kind: 'workflow'; workflowRef: ExactExecutionContractResourceRef }
  | {
      kind: 'program'
      runtimeKind: 'bash' | 'node' | 'python'
      executableArtifactRef: string
      executableDigest: string
      parameterValuesRef: string | null
      runtimeProfileRef: ExactExecutionContractResourceRef
    }

export interface ExecutionContractCheck {
  code: string
  ok: boolean
  detail: string
}

export interface ExecutionContractValidationReceipt {
  schemaVersion: 1
  contractRef: ExecutionContractRef
  status: 'valid' | 'invalid'
  checks: ExecutionContractCheck[]
}

export interface ExecutionContractAgentCandidateReceipt {
  agentRef: ExactExecutionContractResourceRef
  validationReceipt: ExecutionContractValidationReceipt
}

const machineIdSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)

export const localizedContractTextSchema = z
  .object({ 'zh-CN': z.string().min(1).max(2_000), 'en-US': z.string().min(1).max(2_000) })
  .strict()

export const executionContractRefSchema = z
  .object({ contractId: machineIdSchema, version: z.number().int().positive() })
  .strict()

export const executionContractFieldSchema = z
  .object({
    path: z.string().min(1).max(300),
    label: localizedContractTextSchema,
    description: localizedContractTextSchema,
    valueType: z.enum(['string', 'number', 'boolean', 'enum', 'object', 'array', 'json']),
    required: z.boolean(),
    source: z.enum(['platform', 'work-input', 'event', 'context', 'artifact']),
    condition: localizedContractTextSchema.nullable().default(null),
    example: z.string().max(2_000).nullable().default(null),
  })
  .strict()

function fieldValue(
  record: Record<string, unknown>,
  path: string,
): {
  readonly present: boolean
  readonly value: unknown
} {
  let current: unknown = record
  for (const segment of path.split('.')) {
    if (
      current === null ||
      typeof current !== 'object' ||
      Array.isArray(current) ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return { present: false, value: undefined }
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return { present: true, value: current }
}

function valueMatchesFieldType(value: unknown, type: ExecutionContractField['valueType']): boolean {
  if (type === 'json') return true
  if (type === 'string' || type === 'enum') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'array') return Array.isArray(value)
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fieldShapeIssues(
  fields: readonly ExecutionContractField[],
  record: Record<string, unknown>,
): string[] {
  const issues: string[] = []
  for (const field of fields) {
    const result = fieldValue(record, field.path)
    if (!result.present) {
      if (field.required) issues.push(`${field.path} is required`)
      continue
    }
    if (result.value === null && !field.required) continue
    if (!valueMatchesFieldType(result.value, field.valueType)) {
      issues.push(`${field.path} must be ${field.valueType}`)
    }
  }
  return issues
}

export const executionContractSchemaGuideSchema = z
  .object({
    schemaId: machineIdSchema,
    displayName: localizedContractTextSchema,
    description: localizedContractTextSchema,
    topLevelFields: z.array(machineIdSchema).min(1).max(100),
    primaryFieldPaths: z.array(z.string().min(1).max(300)).max(20).default([]),
    fields: z.array(executionContractFieldSchema).min(1).max(200),
    exampleJson: z
      .string()
      .min(2)
      .max(128 * 1024),
  })
  .strict()
  .superRefine((value, ctx) => {
    let exampleRecord: Record<string, unknown> | null = null
    try {
      const example = JSON.parse(value.exampleJson) as unknown
      if (example === null || typeof example !== 'object' || Array.isArray(example)) {
        ctx.addIssue({
          code: 'custom',
          path: ['exampleJson'],
          message: 'example must be an object',
        })
      } else {
        exampleRecord = example as Record<string, unknown>
      }
    } catch {
      ctx.addIssue({ code: 'custom', path: ['exampleJson'], message: 'example must be valid JSON' })
    }
    if (new Set(value.topLevelFields).size !== value.topLevelFields.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['topLevelFields'],
        message: 'top-level field names must be unique',
      })
    }
    if (new Set(value.fields.map((field) => field.path)).size !== value.fields.length) {
      ctx.addIssue({ code: 'custom', path: ['fields'], message: 'field paths must be unique' })
    }
    if (new Set(value.primaryFieldPaths).size !== value.primaryFieldPaths.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['primaryFieldPaths'],
        message: 'primary field paths must be unique',
      })
    }
    for (const primaryPath of value.primaryFieldPaths) {
      if (!value.fields.some((field) => field.path === primaryPath)) {
        ctx.addIssue({
          code: 'custom',
          path: ['primaryFieldPaths'],
          message: `primary field ${primaryPath} must have a field guide`,
        })
      }
    }
    for (const topLevelField of value.topLevelFields) {
      if (!value.fields.some((field) => field.path === topLevelField)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields'],
          message: `top-level field ${topLevelField} must have a field guide`,
        })
      }
    }
    for (const field of value.fields) {
      const root = field.path.split('.')[0]!
      if (!value.topLevelFields.includes(root)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields'],
          message: `field guide ${field.path} is outside topLevelFields`,
        })
      }
    }
    if (exampleRecord !== null) {
      const actual = sortedKeys(exampleRecord)
      const expected = [...value.topLevelFields].sort((left, right) => left.localeCompare(right))
      if (
        actual.length !== expected.length ||
        actual.some((field, index) => field !== expected[index])
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['exampleJson'],
          message: 'example top-level fields must exactly match topLevelFields',
        })
      }
      for (const issue of fieldShapeIssues(value.fields, exampleRecord)) {
        ctx.addIssue({ code: 'custom', path: ['exampleJson'], message: issue })
      }
    }
  })

const transportGuideSchema = z
  .object({
    inputLocation: z.string().min(1).max(200),
    outputLocation: z.string().min(1).max(200),
    outputPort: machineIdSchema.optional(),
    outputKind: z.string().min(1).max(100).optional(),
    inputInstruction: localizedContractTextSchema,
    outputInstruction: localizedContractTextSchema,
  })
  .strict()

export const executionContractGuideSchema = z
  .object({
    schemaVersion: z.literal(1),
    outputMode: z.enum(['envelope', 'artifact-path']).default('envelope'),
    contractRef: executionContractRefSchema,
    displayName: localizedContractTextSchema,
    description: localizedContractTextSchema,
    input: executionContractSchemaGuideSchema,
    output: executionContractSchemaGuideSchema,
    allowedExecutorKinds: z.array(z.enum(['agent', 'workflow', 'program'])).max(3),
    transports: z
      .object({
        agent: transportGuideSchema.nullable(),
        workflow: transportGuideSchema.nullable(),
        program: transportGuideSchema.nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.allowedExecutorKinds).size !== value.allowedExecutorKinds.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['allowedExecutorKinds'],
        message: 'allowed executor kinds must be unique',
      })
    }
    for (const kind of ['agent', 'workflow', 'program'] as const) {
      const allowed = value.allowedExecutorKinds.includes(kind)
      if (allowed !== (value.transports[kind] !== null)) {
        ctx.addIssue({
          code: 'custom',
          path: ['transports', kind],
          message: allowed
            ? 'allowed executor requires a transport'
            : 'disallowed executor has a transport',
        })
      }
    }
    for (const field of ['schemaVersion', 'roundRef', 'executionNonce']) {
      if (!value.input.topLevelFields.includes(field)) {
        ctx.addIssue({
          code: 'custom',
          path: ['input', 'topLevelFields'],
          message: `input envelope must include ${field}`,
        })
      }
    }
    if (value.outputMode === 'envelope') {
      for (const field of ['schemaVersion', 'roundRef', 'executionNonce', 'status', 'summary']) {
        if (!value.output.topLevelFields.includes(field)) {
          ctx.addIssue({
            code: 'custom',
            path: ['output', 'topLevelFields'],
            message: `output envelope must include ${field}`,
          })
        }
      }
    }
  })

export interface ExecutionContractRegistration {
  readonly contractRef: ExecutionContractRef
  readonly guideJson: string
}

const exactResourceRefSchema = z
  .object({ id: z.string().min(1), revision: z.number().int().positive() })
  .strict()

/**
 * RFC-317 T45（DE-08）—— agent 变体单独具名。
 *
 * 消费侧（task-execution 的规划工具）需要「这一处的 implementation 必须是 agent 形态」。
 * 变体内联在联合里时，那边只能**再手抄一份**——而手抄的那份必然过期：内核收紧
 * `agentRef` 或改名，消费侧不会红，它会安静地按旧形状解析。提取成具名 schema 后，
 * 联合与消费侧共用同一个对象。
 */
export const executionContractAgentImplementationSchema = z
  .object({ kind: z.literal('agent'), agentRef: exactResourceRefSchema })
  .strict()

export const executionContractImplementationSchema = z.discriminatedUnion('kind', [
  executionContractAgentImplementationSchema,
  z.object({ kind: z.literal('workflow'), workflowRef: exactResourceRefSchema }).strict(),
  z
    .object({
      kind: z.literal('program'),
      runtimeKind: z.enum(['bash', 'node', 'python']),
      executableArtifactRef: z.string().min(1),
      executableDigest: z.string().regex(/^[a-f0-9]{64}$/),
      parameterValuesRef: z.string().min(1).nullable(),
      runtimeProfileRef: exactResourceRefSchema,
    })
    .strict(),
])

export const executionContractCheckSchema = z
  .object({ code: machineIdSchema, ok: z.boolean(), detail: z.string().max(4_000) })
  .strict()

export const executionContractValidationReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    contractRef: executionContractRefSchema,
    status: z.enum(['valid', 'invalid']),
    checks: z.array(executionContractCheckSchema).min(1),
  })
  .strict()

export const executionContractAgentCandidateReceiptSchema = z
  .object({
    agentRef: exactResourceRefSchema,
    validationReceipt: executionContractValidationReceiptSchema,
  })
  .strict()

export function executionContractRefKey(ref: ExecutionContractRef): string {
  return `${ref.contractId}@${ref.version}`
}

export function parseExecutionContractRef(value: string): ExecutionContractRef {
  const at = value.lastIndexOf('@')
  if (at <= 0) throw new Error('execution contract ref must use <contractId>@<version>')
  return executionContractRefSchema.parse({
    contractId: value.slice(0, at),
    version: Number(value.slice(at + 1)),
  })
}

function sortedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).sort((left, right) => left.localeCompare(right))
}

function parseContractEnvelope(kind: 'input' | 'output', json: string): Record<string, unknown> {
  let decoded: unknown
  try {
    decoded = JSON.parse(json) as unknown
  } catch {
    throw new Error(`${kind} must be one JSON object without Markdown or surrounding prose`)
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error(`${kind} must be one JSON object`)
  }
  return decoded as Record<string, unknown>
}

function validateEnvelopeShape(input: {
  readonly kind: 'input' | 'output'
  readonly schema: ExecutionContractSchemaGuide
  readonly record: Record<string, unknown>
}): void {
  const actual = sortedKeys(input.record)
  const expected = [...input.schema.topLevelFields].sort((left, right) => left.localeCompare(right))
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    const missing = expected.filter((field) => !actual.includes(field))
    const extra = actual.filter((field) => !expected.includes(field))
    throw new Error(
      `${input.kind} fields do not match ${input.schema.schemaId}; missing=[${missing.join(',')}], extra=[${extra.join(',')}]`,
    )
  }
  const issues = fieldShapeIssues(input.schema.fields, input.record)
  if (issues.length > 0) {
    throw new Error(
      `${input.kind} values do not match ${input.schema.schemaId}; ${issues.join('; ')}`,
    )
  }
}

function validateEnvelopeIdentity(input: {
  readonly kind: 'input' | 'output'
  readonly record: Record<string, unknown>
  readonly roundRef: string
  readonly executionNonce: string
}): void {
  if (input.record.schemaVersion !== 1) {
    throw new Error(`${input.kind} schemaVersion must equal 1`)
  }
  if (input.record.roundRef !== input.roundRef) {
    throw new Error(`${input.kind} roundRef does not match this run`)
  }
  if (input.record.executionNonce !== input.executionNonce) {
    throw new Error(`${input.kind} executionNonce does not match this run`)
  }
}

export function validateExactContractInput(input: {
  readonly guide: ExecutionContractGuide
  readonly roundRef: string
  readonly executionNonce: string
  readonly inputJson: string
}): string {
  const record = parseContractEnvelope('input', input.inputJson)
  validateEnvelopeShape({ kind: 'input', schema: input.guide.input, record })
  validateEnvelopeIdentity({ kind: 'input', record, ...input })
  return JSON.stringify(record)
}

export function validateExactContractOutput(input: {
  readonly guide: ExecutionContractGuide
  readonly roundRef: string
  readonly executionNonce: string
  readonly outputJson: string
}): string {
  if (input.guide.outputMode === 'artifact-path') {
    const artifactPath = input.outputJson.trim()
    if (artifactPath === '' || artifactPath.includes('\n') || artifactPath.includes('\r')) {
      throw new Error('output must be one non-empty artifact path without surrounding prose')
    }
    return artifactPath
  }
  const record = parseContractEnvelope('output', input.outputJson)
  validateEnvelopeShape({ kind: 'output', schema: input.guide.output, record })
  validateEnvelopeIdentity({ kind: 'output', record, ...input })
  if (!['ok', 'needs-input', 'blocked'].includes(String(record.status))) {
    throw new Error('output status must be ok, needs-input, or blocked')
  }
  if (typeof record.summary !== 'string' || record.summary.trim() === '') {
    throw new Error('output summary must be a non-empty string')
  }
  return JSON.stringify(record)
}

export const EXECUTION_CONTRACT_RESULT_PORT = 'agent-result'
export const EXECUTION_CONTRACT_SCRIPT_INPUT_PORT = 'contract-input'
export const EXECUTION_CONTRACT_SCRIPT_INPUT_ENV = 'AW_PORT_CONTRACT_INPUT'
export const EXECUTION_CONTRACT_SCRIPT_INPUT_FILE_ENV = 'AW_PORT_FILE_CONTRACT_INPUT'

export function buildExecutionContractAgentPrompt(input: {
  readonly guide: ExecutionContractRuntimeView
  readonly roundRef: string
  readonly executionNonce: string
  readonly toolSlotRef: string
  readonly semanticValidatorId: string
  readonly inputEnvelopeJson: string
  /** Frozen effect closure selected for this exact reaction round. */
  readonly allowedEffectKinds?: readonly string[]
  readonly policyLines: readonly string[]
  readonly previousError: string | null
}): string {
  const authoredGuide = executionContractGuideSchema.parse(
    JSON.parse(input.guide.guideJson) as unknown,
  )
  const outputExample = (() => {
    if (input.guide.outputMode !== 'envelope') return null
    const decoded = JSON.parse(authoredGuide.output.exampleJson) as Record<string, unknown>
    return JSON.stringify(
      {
        ...decoded,
        schemaVersion: 1,
        roundRef: input.roundRef,
        executionNonce: input.executionNonce,
      },
      null,
      2,
    )
  })()
  const effectInstructions =
    input.guide.outputMode !== 'envelope'
      ? []
      : [
          'effectSuggestions must be an array of string effect IDs; never encode an effect as an object.',
          ...(input.allowedEffectKinds === undefined
            ? []
            : input.allowedEffectKinds.length === 0
              ? ['This frozen contract allows no effect IDs, so return effectSuggestions: [].']
              : [
                  `This frozen contract allows only these effect IDs: ${input.allowedEffectKinds
                    .map((effect) => JSON.stringify(effect))
                    .join(', ')}. Use only these exact strings, or [] when no effect is needed.`,
                ]),
        ]
  const outputInstructions =
    input.guide.outputMode === 'artifact-path'
      ? [
          `Return only one artifact path through ${input.guide.agentOutputPort ?? 'the declared output port'}.`,
          'Do not return an envelope, Markdown wrapper, or surrounding prose.',
        ]
      : [
          `Return only one JSON object through ${input.guide.agentOutputPort ?? EXECUTION_CONTRACT_RESULT_PORT}.`,
          `Copy schemaVersion=1, roundRef=${JSON.stringify(input.roundRef)}, and executionNonce=${JSON.stringify(input.executionNonce)} exactly.`,
          `The output must contain exactly these top-level fields: ${input.guide.outputTopLevelFields.join(', ')}.`,
          'Set status to exactly "ok", "needs-input", or "blocked". For successful completion use "ok", never "succeeded" or another synonym.',
          ...effectInstructions,
          'Use the following authored example as the exact JSON value shape; replace only business content while preserving field types.',
          'OUTPUT_SCHEMA_EXAMPLE_JSON',
          outputExample!,
          'Never wrap the JSON in Markdown and never add text before or after it.',
        ]
  return [
    `You are executing frozen platform contract ${executionContractRefKey(input.guide.contractRef)}.`,
    ...input.policyLines,
    `Input schema: ${input.guide.inputSchemaId}. Output schema: ${input.guide.outputSchemaId}.`,
    ...outputInstructions,
    `The platform selected tool slot ${JSON.stringify(input.toolSlotRef)}; do not select another tool or slot.`,
    `Semantic validator: ${input.semanticValidatorId}.`,
    ...(input.previousError === null
      ? []
      : [
          '',
          `The previous output was rejected: ${input.previousError}`,
          'Correct the reported contract violation and return a complete replacement object.',
        ]),
    '',
    'INPUT_ENVELOPE_JSON',
    input.inputEnvelopeJson,
  ].join('\n')
}
