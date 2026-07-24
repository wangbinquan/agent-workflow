// RFC-224 / RFC-227 — behavior-qualified OpenCode direct-HTTP schemas.
//
// These schemas deliberately do not import the OpenCode SDK. The verified
// runtime is an external executable, and accepting an SDK's widened response
// shape would silently weaken the execution-identity boundary. The codec id
// names observed behavior, not an OpenCode release/version range.

import { z } from 'zod'

export const OPENCODE_DIRECT_PROTOCOL_CODEC = 'opencode-direct-v1' as const
export const SESSION_INVENTORY_PAGE_SIZE = 100 as const

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const ASCENDING_ID_TIME_MASK = 0xffffffffffffn
const MESSAGE_ID_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const PART_ID_RE = /^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const SESSION_ID_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const EVENT_ID_RE = /^evt_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const PERMISSION_ID_RE = /^per_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const QUESTION_ID_RE = /^que_[0-9a-f]{12}[0-9A-Za-z]{14}$/

const nonEmptyString = z.string().min(1)
const finite = z.number().finite()
const nonNegativeInteger = z.number().int().nonnegative()

export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

const POISON_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

function isJsonValue(value: unknown, seen: Set<object> = new Set()): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true
  }
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (Array.isArray(value)) {
    const valid = value.every((entry) => isJsonValue(entry, seen))
    seen.delete(value)
    return valid
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    seen.delete(value)
    return false
  }
  for (const [key, entry] of Object.entries(value)) {
    if (POISON_KEYS.has(key) || !isJsonValue(entry, seen)) {
      seen.delete(value)
      return false
    }
  }
  seen.delete(value)
  return true
}

export const JsonValueSchema = z.custom<JsonValue>(isJsonValue, 'expected finite JSON value')
export const JsonObjectSchema = z.custom<JsonObject>(
  (value) =>
    isJsonValue(value) && value !== null && !Array.isArray(value) && typeof value === 'object',
  'expected plain JSON object',
)

export const MessageIdSchema = z.string().regex(MESSAGE_ID_RE)
export const PartIdSchema = z.string().regex(PART_ID_RE)
export const SessionIdSchema = z.string().regex(SESSION_ID_RE)
export const EventIdSchema = z.string().regex(EVENT_ID_RE)
export const PermissionIdSchema = z.string().regex(PERMISSION_ID_RE)
export const QuestionIdSchema = z.string().regex(QUESTION_ID_RE)

export type MessageId = z.infer<typeof MessageIdSchema>
export type SessionId = z.infer<typeof SessionIdSchema>

export const ModelCreateRefSchema = z
  .object({
    providerID: nonEmptyString,
    id: nonEmptyString,
    variant: nonEmptyString.optional(),
  })
  .strict()

export const ModelPromptRefSchema = z
  .object({
    providerID: nonEmptyString,
    modelID: nonEmptyString,
  })
  .strict()

export const PermissionRuleSchema = z
  .object({
    permission: nonEmptyString,
    pattern: z.string(),
    action: z.enum(['allow', 'deny', 'ask']),
  })
  .strict()

export const ROOT_SESSION_PERMISSION_RULES = Object.freeze([
  Object.freeze({ permission: 'question', pattern: '*', action: 'deny' as const }),
  Object.freeze({ permission: 'plan_enter', pattern: '*', action: 'deny' as const }),
  Object.freeze({ permission: 'plan_exit', pattern: '*', action: 'deny' as const }),
])

export const CreateSessionRequestSchema = z
  .object({
    title: nonEmptyString,
    agent: nonEmptyString,
    model: ModelCreateRefSchema,
    permission: z.tuple([PermissionRuleSchema, PermissionRuleSchema, PermissionRuleSchema]),
  })
  .strict()

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>

export const PromptRequestSchema = z
  .object({
    messageID: MessageIdSchema,
    agent: nonEmptyString,
    model: ModelPromptRefSchema,
    variant: nonEmptyString.optional(),
    parts: z.tuple([
      z
        .object({
          type: z.literal('text'),
          text: z.string(),
        })
        .strict(),
    ]),
  })
  .strict()

export type PromptRequest = z.infer<typeof PromptRequestSchema>

const SessionTimeSchema = z
  .object({
    created: nonNegativeInteger,
    updated: nonNegativeInteger,
    compacting: nonNegativeInteger.optional(),
    archived: finite.optional(),
  })
  .strict()

const TokenCountsSchema = z
  .object({
    input: finite,
    output: finite,
    reasoning: finite,
    cache: z.object({ read: finite, write: finite }).strict(),
  })
  .strict()

const SessionSummarySchema = z
  .object({
    additions: finite,
    deletions: finite,
    files: finite,
    diffs: z.array(JsonObjectSchema).optional(),
  })
  .strict()

const SessionShareSchema = z.object({ url: z.string() }).strict()

const SessionRevertSchema = z
  .object({
    messageID: MessageIdSchema,
    partID: PartIdSchema.optional(),
    snapshot: z.string().optional(),
    diff: z.string().optional(),
  })
  .strict()

export const SessionInfoSchema = z
  .object({
    id: SessionIdSchema,
    slug: nonEmptyString,
    projectID: nonEmptyString,
    workspaceID: nonEmptyString.optional(),
    directory: nonEmptyString,
    // The qualified root-session shape uses the exact empty string. Child
    // sessions carry a non-empty relative path; the higher-level identity
    // comparator pins which form is admissible for the requested session.
    path: z.string().optional(),
    parentID: SessionIdSchema.optional(),
    summary: SessionSummarySchema.optional(),
    cost: finite.optional(),
    tokens: TokenCountsSchema.optional(),
    share: SessionShareSchema.optional(),
    title: z.string(),
    agent: nonEmptyString.optional(),
    model: ModelCreateRefSchema.optional(),
    version: nonEmptyString,
    metadata: JsonObjectSchema.optional(),
    time: SessionTimeSchema,
    permission: z.array(PermissionRuleSchema).optional(),
    revert: SessionRevertSchema.optional(),
  })
  .strict()

const ProjectSummarySchema = z
  .object({
    id: nonEmptyString,
    name: z.string().optional(),
    worktree: nonEmptyString,
  })
  .strict()

export const GlobalSessionInfoSchema = SessionInfoSchema.extend({
  project: ProjectSummarySchema.nullable(),
}).strict()

export type SessionInfo = z.infer<typeof SessionInfoSchema>
export type GlobalSessionInfo = z.infer<typeof GlobalSessionInfoSchema>

const MessageTimeSchema = z
  .object({
    created: nonNegativeInteger,
    completed: nonNegativeInteger.optional(),
  })
  .strict()

const UserMessageTimeSchema = z.object({ created: nonNegativeInteger }).strict()

const NamedErrorSchema = z
  .object({
    name: nonEmptyString,
    data: JsonObjectSchema,
  })
  .strict()

export const UserMessageSchema = z
  .object({
    id: MessageIdSchema,
    sessionID: SessionIdSchema,
    role: z.literal('user'),
    time: UserMessageTimeSchema,
    format: JsonObjectSchema.optional(),
    summary: JsonObjectSchema.optional(),
    agent: nonEmptyString,
    model: z
      .object({
        providerID: nonEmptyString,
        modelID: nonEmptyString,
        variant: nonEmptyString.optional(),
      })
      .strict(),
    system: z.string().optional(),
    tools: z.record(z.boolean()).optional(),
  })
  .strict()

export const AssistantMessageSchema = z
  .object({
    id: MessageIdSchema,
    sessionID: SessionIdSchema,
    role: z.literal('assistant'),
    time: MessageTimeSchema,
    error: NamedErrorSchema.optional(),
    parentID: MessageIdSchema,
    modelID: nonEmptyString,
    providerID: nonEmptyString,
    mode: nonEmptyString,
    agent: nonEmptyString,
    path: z.object({ cwd: nonEmptyString, root: nonEmptyString }).strict(),
    summary: z.boolean().optional(),
    cost: finite,
    tokens: TokenCountsSchema,
    structured: JsonValueSchema.optional(),
    variant: nonEmptyString.optional(),
    finish: z.string().optional(),
  })
  .strict()

export const MessageInfoSchema = z.discriminatedUnion('role', [
  UserMessageSchema,
  AssistantMessageSchema,
])

const PartBaseSchema = {
  id: PartIdSchema,
  sessionID: SessionIdSchema,
  messageID: MessageIdSchema,
}

const PartTimeSchema = z
  .object({
    start: nonNegativeInteger,
    end: nonNegativeInteger.optional(),
  })
  .strict()

export const TextPartSchema = z
  .object({
    ...PartBaseSchema,
    type: z.literal('text'),
    text: z.string(),
    synthetic: z.boolean().optional(),
    ignored: z.boolean().optional(),
    time: PartTimeSchema.optional(),
    metadata: JsonObjectSchema.optional(),
  })
  .strict()

export const ReasoningPartSchema = z
  .object({
    ...PartBaseSchema,
    type: z.literal('reasoning'),
    text: z.string(),
    metadata: JsonObjectSchema.optional(),
    time: PartTimeSchema,
  })
  .strict()

const FileSourceTextSchema = z.object({ value: z.string(), start: finite, end: finite }).strict()
const RangeSchema = z
  .object({
    start: z.object({ line: nonNegativeInteger, character: nonNegativeInteger }).strict(),
    end: z.object({ line: nonNegativeInteger, character: nonNegativeInteger }).strict(),
  })
  .strict()
const FileSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('file'), path: z.string(), text: FileSourceTextSchema }).strict(),
  z
    .object({
      type: z.literal('symbol'),
      path: z.string(),
      range: RangeSchema,
      name: z.string(),
      kind: nonNegativeInteger,
      text: FileSourceTextSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal('resource'),
      clientName: z.string(),
      uri: z.string(),
      text: FileSourceTextSchema,
    })
    .strict(),
])

export const FilePartSchema = z
  .object({
    ...PartBaseSchema,
    type: z.literal('file'),
    mime: nonEmptyString,
    filename: z.string().optional(),
    url: z.string(),
    source: FileSourceSchema.optional(),
  })
  .strict()

const ToolStateSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('pending'),
      input: JsonObjectSchema,
      raw: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal('running'),
      input: JsonObjectSchema,
      title: z.string().optional(),
      metadata: JsonObjectSchema.optional(),
      time: z.object({ start: nonNegativeInteger }).strict(),
    })
    .strict(),
  z
    .object({
      status: z.literal('completed'),
      input: JsonObjectSchema,
      output: z.string(),
      title: z.string(),
      metadata: JsonObjectSchema,
      time: z
        .object({
          start: nonNegativeInteger,
          end: nonNegativeInteger,
          compacted: nonNegativeInteger.optional(),
        })
        .strict(),
      attachments: z.array(FilePartSchema).optional(),
    })
    .strict(),
  z
    .object({
      status: z.literal('error'),
      input: JsonObjectSchema,
      error: z.string(),
      metadata: JsonObjectSchema.optional(),
      time: z.object({ start: nonNegativeInteger, end: nonNegativeInteger }).strict(),
    })
    .strict(),
])

export const ToolPartSchema = z
  .object({
    ...PartBaseSchema,
    type: z.literal('tool'),
    callID: nonEmptyString,
    tool: nonEmptyString,
    state: ToolStateSchema,
    metadata: JsonObjectSchema.optional(),
  })
  .strict()

export const StepStartPartSchema = z
  .object({
    ...PartBaseSchema,
    type: z.literal('step-start'),
    snapshot: z.string().optional(),
  })
  .strict()

export const StepFinishPartSchema = z
  .object({
    ...PartBaseSchema,
    type: z.literal('step-finish'),
    reason: z.string(),
    snapshot: z.string().optional(),
    cost: finite,
    tokens: TokenCountsSchema,
  })
  .strict()

const OtherPartSchemas = [
  z.object({ ...PartBaseSchema, type: z.literal('snapshot'), snapshot: z.string() }).strict(),
  z
    .object({
      ...PartBaseSchema,
      type: z.literal('patch'),
      hash: z.string(),
      files: z.array(z.string()),
    })
    .strict(),
  z
    .object({
      ...PartBaseSchema,
      type: z.literal('agent'),
      name: z.string(),
      source: z
        .object({ value: z.string(), start: nonNegativeInteger, end: nonNegativeInteger })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...PartBaseSchema,
      type: z.literal('compaction'),
      auto: z.boolean(),
      overflow: z.boolean().optional(),
      tail_start_id: MessageIdSchema.optional(),
    })
    .strict(),
  z
    .object({
      ...PartBaseSchema,
      type: z.literal('subtask'),
      prompt: z.string(),
      description: z.string(),
      agent: z.string(),
      model: ModelPromptRefSchema.optional(),
      command: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...PartBaseSchema,
      type: z.literal('retry'),
      attempt: nonNegativeInteger,
      error: NamedErrorSchema,
      time: z.object({ created: nonNegativeInteger }).strict(),
    })
    .strict(),
] as const

export const MessagePartSchema = z.discriminatedUnion('type', [
  TextPartSchema,
  ReasoningPartSchema,
  FilePartSchema,
  ToolPartSchema,
  StepStartPartSchema,
  StepFinishPartSchema,
  ...OtherPartSchemas,
])

export const WithPartsSchema = z
  .object({
    info: MessageInfoSchema,
    parts: z.array(MessagePartSchema),
  })
  .strict()

export type UserMessage = z.infer<typeof UserMessageSchema>
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>
export type MessagePart = z.infer<typeof MessagePartSchema>
export type WithParts = z.infer<typeof WithPartsSchema>

export const WireEventSchema = z
  .object({
    id: EventIdSchema,
    type: nonEmptyString.max(128),
    properties: JsonObjectSchema,
  })
  .strict()

export type WireEvent = z.infer<typeof WireEventSchema>

export const ServerConnectedPropertiesSchema = z.object({}).strict()
export const ServerHeartbeatPropertiesSchema = z.object({}).strict()
export const MessageUpdatedPropertiesSchema = z
  .object({
    sessionID: SessionIdSchema,
    info: MessageInfoSchema,
  })
  .strict()
export const MessagePartUpdatedPropertiesSchema = z
  .object({
    sessionID: SessionIdSchema,
    part: MessagePartSchema,
    time: finite,
  })
  .strict()
export const MessagePartDeltaPropertiesSchema = z
  .object({
    sessionID: SessionIdSchema,
    messageID: MessageIdSchema,
    partID: PartIdSchema,
    field: nonEmptyString,
    delta: z.string(),
  })
  .strict()
export const SessionStatusPropertiesSchema = z
  .object({
    sessionID: SessionIdSchema,
    status: z.discriminatedUnion('type', [
      z.object({ type: z.literal('idle') }).strict(),
      z.object({ type: z.literal('busy') }).strict(),
      z
        .object({
          type: z.literal('retry'),
          attempt: nonNegativeInteger,
          message: z.string(),
          action: JsonObjectSchema.optional(),
          next: nonNegativeInteger,
        })
        .strict(),
    ]),
  })
  .strict()
export const SessionErrorPropertiesSchema = z
  .object({
    sessionID: SessionIdSchema.optional(),
    error: NamedErrorSchema,
  })
  .strict()
export const PermissionAskedPropertiesSchema = z
  .object({
    id: PermissionIdSchema,
    sessionID: SessionIdSchema,
    permission: nonEmptyString,
    patterns: z.array(z.string()),
    metadata: JsonObjectSchema,
    always: z.array(z.string()),
    tool: z.object({ messageID: MessageIdSchema, callID: z.string() }).strict().optional(),
  })
  .strict()
const QuestionOptionSchema = z.object({ label: z.string(), description: z.string() }).strict()
const QuestionInfoSchema = z
  .object({
    question: z.string(),
    header: z.string(),
    options: z.array(QuestionOptionSchema),
    multiple: z.boolean().optional(),
    custom: z.boolean().optional(),
  })
  .strict()
export const QuestionAskedPropertiesSchema = z
  .object({
    id: QuestionIdSchema,
    sessionID: SessionIdSchema,
    questions: z.array(QuestionInfoSchema),
    tool: z.object({ messageID: MessageIdSchema, callID: z.string() }).strict().optional(),
  })
  .strict()

export class DirectApiValidationError extends Error {
  readonly context: string
  readonly reason: string
  readonly pointer?: string

  constructor(context: string, reason: string, pointer?: string) {
    super(
      `OpenCode direct API ${context}: ${reason}${pointer === undefined ? '' : ` at ${pointer}`}`,
    )
    this.name = 'DirectApiValidationError'
    this.context = context
    this.reason = reason
    this.pointer = pointer
  }
}

function jsonPointer(path: Array<string | number>): string {
  if (path.length === 0) return ''
  return `/${path.map((part) => String(part).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`
}

export function parseDirectApiValue<T>(schema: z.ZodType<T>, value: unknown, context: string): T {
  const parsed = schema.safeParse(value)
  if (parsed.success) return parsed.data
  const first = parsed.error.issues[0]
  throw new DirectApiValidationError(
    context,
    first?.code === 'unrecognized_keys' ? 'unexpected-field' : 'schema-mismatch',
    first === undefined ? undefined : jsonPointer(first.path),
  )
}

export interface SelectedModel {
  providerID: string
  modelID: string
  variant?: string
}

export interface SessionIdentityExpectation {
  sessionID?: string
  directory: string
  title: string
  agent: string
  model: SelectedModel
  projectID?: string
  /** Root sessions must expose the exact upstream sessionPath(worktree,cwd). */
  path?: string
}

export function buildCreateSessionRequest(input: {
  title: string
  agent: string
  model: SelectedModel
}): CreateSessionRequest {
  return parseDirectApiValue(
    CreateSessionRequestSchema,
    {
      title: input.title,
      agent: input.agent,
      model: {
        providerID: input.model.providerID,
        id: input.model.modelID,
        ...(input.model.variant === undefined ? {} : { variant: input.model.variant }),
      },
      permission: ROOT_SESSION_PERMISSION_RULES.map((rule) => ({ ...rule })),
    },
    'create-request',
  )
}

export function buildPromptRequest(input: {
  messageID: string
  agent: string
  model: SelectedModel
  prompt: string
}): PromptRequest {
  return parseDirectApiValue(
    PromptRequestSchema,
    {
      messageID: input.messageID,
      agent: input.agent,
      model: {
        providerID: input.model.providerID,
        modelID: input.model.modelID,
      },
      ...(input.model.variant === undefined ? {} : { variant: input.model.variant }),
      parts: [{ type: 'text', text: input.prompt }],
    },
    'prompt-request',
  )
}

function samePermissionRules(actual: readonly z.infer<typeof PermissionRuleSchema>[]): boolean {
  if (actual.length !== ROOT_SESSION_PERMISSION_RULES.length) return false
  return actual.every((rule, index) => {
    const expected = ROOT_SESSION_PERMISSION_RULES[index]
    return (
      expected !== undefined &&
      rule.permission === expected.permission &&
      rule.pattern === expected.pattern &&
      rule.action === expected.action
    )
  })
}

function mismatch(context: string, pointer: string): never {
  throw new DirectApiValidationError(context, 'identity-mismatch', pointer)
}

export function validateSessionIdentity<T extends SessionInfo | GlobalSessionInfo>(
  session: T,
  expected: SessionIdentityExpectation,
  context = 'session',
): T {
  if (expected.sessionID !== undefined && session.id !== expected.sessionID)
    mismatch(context, '/id')
  if (session.directory !== expected.directory) mismatch(context, '/directory')
  if (session.title !== expected.title) mismatch(context, '/title')
  if (session.agent !== expected.agent) mismatch(context, '/agent')
  if (session.projectID.length === 0) mismatch(context, '/projectID')
  if (expected.projectID !== undefined && session.projectID !== expected.projectID) {
    mismatch(context, '/projectID')
  }
  if (
    session.model?.providerID !== expected.model.providerID ||
    session.model.id !== expected.model.modelID ||
    session.model.variant !== expected.model.variant
  ) {
    mismatch(context, '/model')
  }
  if (session.permission === undefined || !samePermissionRules(session.permission)) {
    mismatch(context, '/permission')
  }
  if (session.path !== (expected.path ?? '')) mismatch(context, '/path')
  const forbiddenOptionalFields = [
    ['parentID', session.parentID],
    ['workspaceID', session.workspaceID],
    ['share', session.share],
    ['revert', session.revert],
    ['metadata', session.metadata],
  ] as const
  for (const [field, value] of forbiddenOptionalFields) {
    if (value !== undefined) mismatch(context, `/${field}`)
  }
  return session
}

export function parseAndValidateCreatedSession(
  value: unknown,
  expected: SessionIdentityExpectation,
): SessionInfo {
  return validateSessionIdentity(
    parseDirectApiValue(SessionInfoSchema, value, 'create-response'),
    expected,
    'create-response',
  )
}

export interface InventoryPage {
  sessions: GlobalSessionInfo[]
  nextCursor: number | null
}

export function parseInventoryCursor(value: string | null): number | null {
  if (value === null) return null
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new DirectApiValidationError(
      'session-inventory',
      'invalid-cursor',
      '/headers/x-next-cursor',
    )
  }
  const cursor = Number(value)
  if (!Number.isSafeInteger(cursor) || cursor < 0) {
    throw new DirectApiValidationError(
      'session-inventory',
      'invalid-cursor',
      '/headers/x-next-cursor',
    )
  }
  return cursor
}

/**
 * Validates the lossy time.updated cursor protocol used by
 * `/experimental/session`. Duplicate IDs/timestamps, non-decreasing cursors,
 * and equal timestamp boundaries fail closed.
 */
export class SessionInventoryAccumulator {
  readonly #pageSize: number
  readonly #sessions: GlobalSessionInfo[] = []
  readonly #ids = new Set<string>()
  readonly #timestamps = new Set<number>()
  readonly #cursors = new Set<number>()
  #expectedCursor: number | null = null
  #complete = false

  constructor(pageSize: number = SESSION_INVENTORY_PAGE_SIZE) {
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
      throw new TypeError('pageSize must be a positive safe integer')
    }
    this.#pageSize = pageSize
  }

  get complete(): boolean {
    return this.#complete
  }

  get nextCursor(): number | null {
    return this.#complete ? null : this.#expectedCursor
  }

  addPage(
    value: unknown,
    nextCursorHeader: string | null,
    requestedCursor?: number,
  ): InventoryPage {
    if (this.#complete) {
      throw new DirectApiValidationError('session-inventory', 'page-after-complete')
    }
    if ((requestedCursor ?? null) !== this.#expectedCursor) {
      throw new DirectApiValidationError('session-inventory', 'unexpected-request-cursor')
    }
    const sessions = parseDirectApiValue(
      z.array(GlobalSessionInfoSchema).max(this.#pageSize),
      value,
      'session-inventory',
    )
    const nextCursor = parseInventoryCursor(nextCursorHeader)

    let priorTimestamp: number | undefined
    for (const session of sessions) {
      const timestamp = session.time.updated
      if (priorTimestamp !== undefined && timestamp > priorTimestamp) {
        throw new DirectApiValidationError('session-inventory', 'out-of-order', '/time/updated')
      }
      if (requestedCursor !== undefined && timestamp >= requestedCursor) {
        throw new DirectApiValidationError(
          'session-inventory',
          'ambiguous-page-boundary',
          '/time/updated',
        )
      }
      if (this.#ids.has(session.id)) {
        throw new DirectApiValidationError('session-inventory', 'duplicate-session', '/id')
      }
      if (this.#timestamps.has(timestamp)) {
        throw new DirectApiValidationError(
          'session-inventory',
          'duplicate-timestamp',
          '/time/updated',
        )
      }
      this.#ids.add(session.id)
      this.#timestamps.add(timestamp)
      priorTimestamp = timestamp
      this.#sessions.push(session)
    }

    if (nextCursor === null) {
      this.#complete = true
      this.#expectedCursor = null
    } else {
      if (sessions.length !== this.#pageSize || sessions.length === 0) {
        throw new DirectApiValidationError('session-inventory', 'invalid-next-cursor')
      }
      if (
        this.#cursors.has(nextCursor) ||
        (requestedCursor !== undefined && nextCursor >= requestedCursor)
      ) {
        throw new DirectApiValidationError('session-inventory', 'cursor-loop')
      }
      const boundary = sessions.at(-1)?.time.updated
      if (boundary !== nextCursor) {
        throw new DirectApiValidationError('session-inventory', 'cursor-boundary-mismatch')
      }
      this.#cursors.add(nextCursor)
      this.#expectedCursor = nextCursor
    }
    return { sessions, nextCursor }
  }

  finish(expected: SessionIdentityExpectation & { sessionID: string }): GlobalSessionInfo {
    if (!this.#complete) {
      throw new DirectApiValidationError('session-inventory', 'incomplete')
    }
    const matches = this.#sessions.filter((session) => session.id === expected.sessionID)
    if (matches.length !== 1 || matches[0] === undefined) {
      throw new DirectApiValidationError('session-inventory', 'session-not-unique', '/id')
    }
    return validateSessionIdentity(matches[0], expected, 'session-inventory')
  }
}

export function validateLatestMessageInventory(
  value: unknown,
  expectedSessionID: string,
): WithParts | null {
  const list = parseDirectApiValue(z.array(WithPartsSchema).max(1), value, 'message-inventory')
  const message = list[0]
  if (message === undefined) return null
  if (message.info.sessionID !== expectedSessionID) {
    throw new DirectApiValidationError(
      'message-inventory',
      'identity-mismatch',
      '/0/info/sessionID',
    )
  }
  for (let index = 0; index < message.parts.length; index += 1) {
    const part = message.parts[index]
    if (
      part === undefined ||
      part.sessionID !== expectedSessionID ||
      part.messageID !== message.info.id
    ) {
      throw new DirectApiValidationError(
        'message-inventory',
        'identity-mismatch',
        `/0/parts/${index}`,
      )
    }
  }
  return message
}

export interface AscendingMessageIdParts {
  timestampMs: number
  counter: number
  random: string
}

export function decodeAscendingMessageId(value: string): AscendingMessageIdParts {
  const id = parseDirectApiValue(MessageIdSchema, value, 'message-id')
  const encoded = BigInt(`0x${id.slice(4, 16)}`)
  return {
    timestampMs: Number(encoded / 0x1000n),
    counter: Number(encoded % 0x1000n),
    random: id.slice(16),
  }
}

export function compareAscendingMessageIds(left: string, right: string): number {
  const a = parseDirectApiValue(MessageIdSchema, left, 'message-id')
  const b = parseDirectApiValue(MessageIdSchema, right, 'message-id')
  return a < b ? -1 : a > b ? 1 : 0
}

export type RandomBytesSource = (size: number) => Uint8Array

export function encodeAscendingMessageId(input: {
  timestampMs: number
  counter: number
  randomBytes: Uint8Array
}): MessageId {
  if (
    !Number.isSafeInteger(input.timestampMs) ||
    input.timestampMs < 0 ||
    !Number.isSafeInteger(input.counter) ||
    input.counter <= 0 ||
    input.counter >= 0x1000
  ) {
    throw new DirectApiValidationError('message-id', 'invalid-time-or-counter')
  }
  if (input.randomBytes.byteLength !== 14) {
    throw new DirectApiValidationError('message-id', 'invalid-random-length')
  }
  // The qualified ascending-id behavior writes the low six bytes of
  // `BigInt(timestampMs) * 0x1000 + counter`. It does not reject modern epoch
  // milliseconds even though the intermediate exceeds 48 bits; each emitted
  // byte masks the corresponding low-order octet. Reproduce that truncation
  // exactly or every real Date.now() value fails before the first POST.
  const encoded =
    (BigInt(input.timestampMs) * 0x1000n + BigInt(input.counter)) & ASCENDING_ID_TIME_MASK
  const hex = encoded.toString(16).padStart(12, '0')
  let suffix = ''
  for (const byte of input.randomBytes) suffix += BASE62[byte % 62]
  return parseDirectApiValue(MessageIdSchema, `msg_${hex}${suffix}`, 'message-id')
}

/**
 * Instance-local implementation of the `opencode-direct-v1`
 * `Identifier.ascending("message")` behavior. The launcher still waits for a
 * millisecond strictly after the latest stored message and for the following
 * millisecond before POSTing; this class only owns the behavior codec.
 */
export class AscendingMessageIdGenerator {
  readonly #randomBytes: RandomBytesSource
  #lastTimestamp = 0
  #counter = 0

  constructor(randomBytes: RandomBytesSource) {
    this.#randomBytes = randomBytes
  }

  create(timestampMs: number): MessageId {
    if (timestampMs !== this.#lastTimestamp) {
      this.#lastTimestamp = timestampMs
      this.#counter = 0
    }
    this.#counter += 1
    if (this.#counter >= 0x1000) {
      throw new DirectApiValidationError('message-id', 'counter-overflow')
    }
    return encodeAscendingMessageId({
      timestampMs,
      counter: this.#counter,
      randomBytes: this.#randomBytes(14),
    })
  }
}

export function assertMessageIdAfterHistory(
  candidate: string,
  existingMessageIds: readonly string[],
): void {
  parseDirectApiValue(MessageIdSchema, candidate, 'message-id')
  let previous: string | undefined
  for (const id of existingMessageIds) {
    parseDirectApiValue(MessageIdSchema, id, 'message-history')
    if (previous !== undefined && compareAscendingMessageIds(previous, id) >= 0) {
      throw new DirectApiValidationError('message-history', 'not-strictly-ascending')
    }
    previous = id
  }
  if (previous !== undefined && compareAscendingMessageIds(previous, candidate) >= 0) {
    throw new DirectApiValidationError('message-history', 'caller-not-after-history')
  }
}
