// RFC-224/227 — deterministic `opencode-direct-v1` correlation state machine
// for the behavior-qualified direct HTTP + SSE protocol. It mirrors
// `run --format json` output without inheriting CLI fallback behavior.

import {
  AssistantMessageSchema,
  MessagePartDeltaPropertiesSchema,
  MessagePartUpdatedPropertiesSchema,
  MessageUpdatedPropertiesSchema,
  PermissionAskedPropertiesSchema,
  QuestionAskedPropertiesSchema,
  ServerConnectedPropertiesSchema,
  ServerHeartbeatPropertiesSchema,
  SessionErrorPropertiesSchema,
  SessionIdSchema,
  SessionStatusPropertiesSchema,
  WireEventSchema,
  WithPartsSchema,
  compareAscendingMessageIds,
  parseDirectApiValue,
  type AssistantMessage,
  type JsonObject,
  type MessagePart,
  type SelectedModel,
  type WireEvent,
  type WithParts,
} from './directApiSchemas'

export type DirectJsonlRecord =
  | {
      type: 'tool_use' | 'step_start' | 'step_finish' | 'text' | 'reasoning'
      timestamp: number
      sessionID: string
      part: MessagePart
    }
  | {
      type: 'error'
      timestamp: number
      sessionID: string
      error: JsonObject
    }

type MappedPartRecordType = Exclude<DirectJsonlRecord['type'], 'error'>

export type DirectCodecStep =
  | {
      state: 'continue' | 'ready' | 'idle' | 'success'
      records: DirectJsonlRecord[]
      ignoredEvents: number
    }
  | {
      state: 'failed'
      reason: DirectCodecFailureReason
      records: DirectJsonlRecord[]
      ignoredEvents: number
    }

export type DirectCodecFailureReason =
  | 'first-event-not-server-connected'
  | 'duplicate-server-connected'
  | 'server-disposed'
  | 'event-before-prompt'
  | 'event-after-idle'
  | 'schema-mismatch'
  | 'caller-message-duplicate'
  | 'caller-message-mismatch'
  | 'caller-text-duplicate'
  | 'caller-text-mismatch'
  | 'unexpected-user-message'
  | 'assistant-parent-mismatch'
  | 'assistant-identity-mismatch'
  | 'assistant-id-order'
  | 'assistant-before-previous-complete'
  | 'assistant-before-caller'
  | 'assistant-stale-update'
  | 'assistant-completion-regressed'
  | 'assistant-error'
  | 'part-before-message'
  | 'part-after-assistant-complete'
  | 'part-owner-mismatch'
  | 'part-terminal-duplicate'
  | 'delta-before-part'
  | 'unexpected-related-event'
  | 'session-error'
  | 'permission-requested'
  | 'question-requested'
  | 'response-duplicate'
  | 'response-mismatch'
  | 'stream-ended'
  | 'ignored-event-budget-exceeded'
  | 'invalid-clock'

export interface DirectCodecOptions {
  sessionID: string
  callerMessageID: string
  agent: string
  model: SelectedModel
  prompt: string
  path: {
    cwd: string
    root: string
  }
  thinking?: boolean
  now?: () => number
  maxIgnoredEvents?: number
}

export type DirectCodecResult =
  | {
      status: 'pending'
      ready: boolean
      promptPosted: boolean
      idle: boolean
      assistantIDs: readonly string[]
      ignoredEvents: number
    }
  | {
      status: 'failure'
      reason: DirectCodecFailureReason
      assistantIDs: readonly string[]
      ignoredEvents: number
    }
  | {
      status: 'success'
      final: WithParts
      assistantIDs: readonly string[]
      ignoredEvents: number
    }

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`
}

function identityOfAssistant(info: AssistantMessage): string {
  return canonicalJson({
    id: info.id,
    sessionID: info.sessionID,
    role: info.role,
    parentID: info.parentID,
    modelID: info.modelID,
    providerID: info.providerID,
    mode: info.mode,
    agent: info.agent,
    path: info.path,
    variant: info.variant,
    created: info.time.created,
  })
}

function isTerminalPart(part: MessagePart, thinking: boolean): MappedPartRecordType | null {
  if (
    part.type === 'tool' &&
    (part.state.status === 'completed' || part.state.status === 'error')
  ) {
    return 'tool_use'
  }
  if (part.type === 'step-start') return 'step_start'
  if (part.type === 'step-finish') return 'step_finish'
  // Match the qualified run behavior: it checks truthiness, not merely
  // presence, of `time.end`.
  if (part.type === 'text' && Boolean(part.time?.end)) return 'text'
  if (part.type === 'reasoning' && Boolean(part.time.end) && thinking) return 'reasoning'
  return null
}

function parseProperties<T>(
  schema: Parameters<typeof parseDirectApiValue<T>>[0],
  value: unknown,
  context: string,
): T {
  return parseDirectApiValue(schema, value, context)
}

export class DirectSessionCodec {
  readonly #options: Required<Pick<DirectCodecOptions, 'thinking' | 'now' | 'maxIgnoredEvents'>> &
    Omit<DirectCodecOptions, 'thinking' | 'now' | 'maxIgnoredEvents'>
  #ready = false
  #promptPosted = false
  #callerSeen = false
  #callerTextSeen = false
  #idle = false
  #response: WithParts | null = null
  #failure: DirectCodecFailureReason | null = null
  #success: WithParts | null = null
  #ignoredEvents = 0
  readonly #assistants: AssistantMessage[] = []
  readonly #partOwners = new Map<string, string>()
  readonly #latestParts = new Map<string, MessagePart>()
  readonly #terminalParts = new Set<string>()

  constructor(options: DirectCodecOptions) {
    const sessionID = parseDirectApiValue(SessionIdSchema, options.sessionID, 'session-id')
    if (
      options.agent.length === 0 ||
      options.model.providerID.length === 0 ||
      options.model.modelID.length === 0 ||
      options.path.cwd.length === 0 ||
      options.path.root.length === 0
    ) {
      throw new TypeError('DirectSessionCodec identity fields must not be empty')
    }
    // Reuse the assistant schema's ID codec without inventing a looser caller
    // spelling. The remaining fields are intentionally synthetic.
    parseDirectApiValue(
      AssistantMessageSchema.shape.parentID,
      options.callerMessageID,
      'caller-message-id',
    )
    const maxIgnoredEvents = options.maxIgnoredEvents ?? 10_000
    if (!Number.isSafeInteger(maxIgnoredEvents) || maxIgnoredEvents < 0) {
      throw new TypeError('maxIgnoredEvents must be a non-negative safe integer')
    }
    this.#options = {
      ...options,
      sessionID,
      thinking: options.thinking ?? false,
      now: options.now ?? Date.now,
      maxIgnoredEvents,
    }
  }

  get result(): DirectCodecResult {
    const assistantIDs = this.#assistants.map((assistant) => assistant.id)
    if (this.#failure !== null) {
      return {
        status: 'failure',
        reason: this.#failure,
        assistantIDs,
        ignoredEvents: this.#ignoredEvents,
      }
    }
    if (this.#success !== null) {
      return {
        status: 'success',
        final: this.#success,
        assistantIDs,
        ignoredEvents: this.#ignoredEvents,
      }
    }
    return {
      status: 'pending',
      ready: this.#ready,
      promptPosted: this.#promptPosted,
      idle: this.#idle,
      assistantIDs,
      ignoredEvents: this.#ignoredEvents,
    }
  }

  markPromptPosted(): DirectCodecStep {
    if (this.#failure !== null) return this.#step([])
    if (!this.#ready || this.#promptPosted || this.#idle) {
      return this.#fail('event-before-prompt')
    }
    this.#promptPosted = true
    return this.#step([])
  }

  consume(event: WireEvent): DirectCodecStep {
    if (this.#failure !== null || this.#success !== null) return this.#step([])
    let parsedEvent: WireEvent
    try {
      parsedEvent = parseDirectApiValue(WireEventSchema, event, 'sse-event')
    } catch {
      return this.#fail('schema-mismatch')
    }

    if (!this.#ready) {
      if (parsedEvent.type !== 'server.connected') {
        return this.#fail('first-event-not-server-connected')
      }
      try {
        parseProperties(ServerConnectedPropertiesSchema, parsedEvent.properties, 'server.connected')
      } catch {
        return this.#fail('schema-mismatch')
      }
      this.#ready = true
      return this.#step([], 'ready')
    }

    if (parsedEvent.type === 'server.connected') return this.#fail('duplicate-server-connected')
    if (parsedEvent.type === 'server.instance.disposed') return this.#fail('server-disposed')
    if (parsedEvent.type === 'server.heartbeat') {
      try {
        parseProperties(ServerHeartbeatPropertiesSchema, parsedEvent.properties, 'server.heartbeat')
      } catch {
        return this.#fail('schema-mismatch')
      }
      return this.#step([])
    }

    try {
      if (parsedEvent.type === 'message.updated') {
        return this.#messageUpdated(parsedEvent.properties)
      }
      if (parsedEvent.type === 'message.part.updated') {
        return this.#partUpdated(parsedEvent.properties)
      }
      if (parsedEvent.type === 'message.part.delta') {
        return this.#partDelta(parsedEvent.properties)
      }
      if (parsedEvent.type === 'session.status') {
        return this.#sessionStatus(parsedEvent.properties)
      }
      if (parsedEvent.type === 'session.error') {
        return this.#sessionError(parsedEvent.properties)
      }
      if (parsedEvent.type === 'permission.asked') {
        return this.#permissionAsked(parsedEvent.properties)
      }
      if (parsedEvent.type === 'question.asked') {
        return this.#questionAsked(parsedEvent.properties)
      }
    } catch {
      return this.#fail('schema-mismatch')
    }

    if (this.#isRelated(parsedEvent.properties)) {
      return this.#fail('unexpected-related-event')
    }
    return this.#ignore()
  }

  acceptPromptResponse(value: unknown): DirectCodecStep {
    if (this.#failure !== null || this.#success !== null) return this.#step([])
    if (this.#response !== null) return this.#fail('response-duplicate')
    if (!this.#promptPosted) return this.#fail('event-before-prompt')
    let response: WithParts
    try {
      response = parseDirectApiValue(WithPartsSchema, value, 'prompt-response')
    } catch {
      return this.#fail('schema-mismatch')
    }
    if (
      response.info.role !== 'assistant' ||
      response.info.sessionID !== this.#options.sessionID ||
      response.info.parentID !== this.#options.callerMessageID ||
      !this.#matchesAssistantIdentity(response.info) ||
      response.info.time.completed === undefined ||
      response.info.error !== undefined
    ) {
      return this.#fail('response-mismatch')
    }
    const ids = new Set<string>()
    for (const part of response.parts) {
      if (
        part.sessionID !== this.#options.sessionID ||
        part.messageID !== response.info.id ||
        ids.has(part.id)
      ) {
        return this.#fail('response-mismatch')
      }
      ids.add(part.id)
    }
    this.#response = response
    return this.#maybeComplete([])
  }

  streamEnded(): DirectCodecStep {
    if (this.#success !== null || this.#failure !== null) return this.#step([])
    return this.#fail('stream-ended')
  }

  #messageUpdated(value: unknown): DirectCodecStep {
    const properties = parseProperties(MessageUpdatedPropertiesSchema, value, 'message.updated')
    if (properties.sessionID !== properties.info.sessionID) {
      return this.#fail('schema-mismatch')
    }
    if (properties.sessionID !== this.#options.sessionID) return this.#ignore()
    if (!this.#promptPosted) return this.#fail('event-before-prompt')
    if (this.#idle) return this.#fail('event-after-idle')

    const info = properties.info
    if (info.role === 'user') {
      if (info.id !== this.#options.callerMessageID) {
        return this.#fail('unexpected-user-message')
      }
      if (this.#callerSeen) return this.#fail('caller-message-duplicate')
      if (
        info.agent !== this.#options.agent ||
        info.model.providerID !== this.#options.model.providerID ||
        info.model.modelID !== this.#options.model.modelID ||
        info.model.variant !== this.#options.model.variant ||
        info.system !== undefined ||
        info.tools !== undefined ||
        info.format !== undefined ||
        info.summary !== undefined
      ) {
        return this.#fail('caller-message-mismatch')
      }
      this.#callerSeen = true
      return this.#step([])
    }

    const existingIndex = this.#assistants.findIndex((assistant) => assistant.id === info.id)
    if (existingIndex === -1) {
      if (!this.#callerSeen || !this.#callerTextSeen) {
        return this.#fail('assistant-before-caller')
      }
      const previous = this.#assistants.at(-1)
      if (
        compareAscendingMessageIds(info.id, this.#options.callerMessageID) <= 0 ||
        (previous !== undefined && compareAscendingMessageIds(info.id, previous.id) <= 0)
      ) {
        return this.#fail('assistant-id-order')
      }
      if (previous !== undefined && previous.time.completed === undefined) {
        return this.#fail('assistant-before-previous-complete')
      }
      if (info.parentID !== this.#options.callerMessageID) {
        return this.#fail('assistant-parent-mismatch')
      }
      if (!this.#matchesAssistantIdentity(info)) {
        return this.#fail('assistant-identity-mismatch')
      }
      if (info.error !== undefined) return this.#fail('assistant-error')
      this.#assistants.push(info)
      return this.#step([])
    }

    if (existingIndex !== this.#assistants.length - 1) {
      return this.#fail('assistant-stale-update')
    }
    const previous = this.#assistants[existingIndex]
    if (previous === undefined || identityOfAssistant(previous) !== identityOfAssistant(info)) {
      return this.#fail('assistant-identity-mismatch')
    }
    if (previous.time.completed !== undefined && info.time.completed !== previous.time.completed) {
      return this.#fail('assistant-completion-regressed')
    }
    if (info.error !== undefined) return this.#fail('assistant-error')
    this.#assistants[existingIndex] = info
    return this.#maybeComplete([])
  }

  #partUpdated(value: unknown): DirectCodecStep {
    const properties = parseProperties(
      MessagePartUpdatedPropertiesSchema,
      value,
      'message.part.updated',
    )
    const part = properties.part
    if (properties.sessionID !== part.sessionID) return this.#fail('schema-mismatch')
    if (properties.sessionID !== this.#options.sessionID) return this.#ignore()
    if (!this.#promptPosted) return this.#fail('event-before-prompt')
    if (this.#idle) return this.#fail('event-after-idle')

    if (part.messageID === this.#options.callerMessageID) {
      if (!this.#callerSeen) return this.#fail('part-before-message')
      if (this.#callerTextSeen || this.#partOwners.has(part.id)) {
        return this.#fail('caller-text-duplicate')
      }
      if (
        part.type !== 'text' ||
        part.text !== this.#options.prompt ||
        part.synthetic !== undefined ||
        part.ignored !== undefined ||
        part.time !== undefined ||
        part.metadata !== undefined
      ) {
        return this.#fail('caller-text-mismatch')
      }
      this.#callerTextSeen = true
      this.#partOwners.set(part.id, part.messageID)
      this.#latestParts.set(part.id, part)
      return this.#step([])
    }

    const assistantIndex = this.#assistants.findIndex(
      (assistant) => assistant.id === part.messageID,
    )
    if (assistantIndex === -1) {
      return this.#fail('part-before-message')
    }
    if (assistantIndex !== this.#assistants.length - 1) {
      return this.#fail('assistant-stale-update')
    }
    const ownerAssistant = this.#assistants[assistantIndex]
    if (ownerAssistant?.time.completed !== undefined) {
      return this.#fail('part-after-assistant-complete')
    }
    const existingOwner = this.#partOwners.get(part.id)
    if (existingOwner !== undefined && existingOwner !== part.messageID) {
      return this.#fail('part-owner-mismatch')
    }
    this.#partOwners.set(part.id, part.messageID)
    this.#latestParts.set(part.id, part)
    const type = isTerminalPart(part, this.#options.thinking)
    if (type === null) return this.#step([])
    if (this.#terminalParts.has(part.id)) return this.#fail('part-terminal-duplicate')
    this.#terminalParts.add(part.id)
    const timestamp = this.#timestamp()
    if (timestamp === null) return this.#fail('invalid-clock')
    return this.#step([{ type, timestamp, sessionID: this.#options.sessionID, part }])
  }

  #partDelta(value: unknown): DirectCodecStep {
    const properties = parseProperties(
      MessagePartDeltaPropertiesSchema,
      value,
      'message.part.delta',
    )
    if (properties.sessionID !== this.#options.sessionID) return this.#ignore()
    if (!this.#promptPosted) return this.#fail('event-before-prompt')
    if (this.#idle) return this.#fail('event-after-idle')
    const assistantIndex = this.#assistants.findIndex(
      (assistant) => assistant.id === properties.messageID,
    )
    if (properties.messageID === this.#options.callerMessageID || assistantIndex === -1) {
      return this.#fail('part-before-message')
    }
    if (assistantIndex !== this.#assistants.length - 1) {
      return this.#fail('assistant-stale-update')
    }
    if (this.#assistants[assistantIndex]?.time.completed !== undefined) {
      return this.#fail('part-after-assistant-complete')
    }
    if (this.#partOwners.get(properties.partID) !== properties.messageID) {
      return this.#fail('delta-before-part')
    }
    return this.#step([])
  }

  #sessionStatus(value: unknown): DirectCodecStep {
    const properties = parseProperties(SessionStatusPropertiesSchema, value, 'session.status')
    if (properties.sessionID !== this.#options.sessionID) return this.#ignore()
    if (!this.#promptPosted) return this.#fail('event-before-prompt')
    if (this.#idle) return this.#fail('event-after-idle')
    if (properties.status.type !== 'idle') return this.#step([])
    this.#idle = true
    return this.#maybeComplete([], 'idle')
  }

  #sessionError(value: unknown): DirectCodecStep {
    const properties = parseProperties(SessionErrorPropertiesSchema, value, 'session.error')
    if (properties.sessionID !== undefined && properties.sessionID !== this.#options.sessionID) {
      return this.#ignore()
    }
    const timestamp = this.#timestamp()
    if (timestamp === null) return this.#fail('invalid-clock')
    const record: DirectJsonlRecord = {
      type: 'error',
      timestamp,
      sessionID: this.#options.sessionID,
      error: properties.error,
    }
    return this.#fail('session-error', [record])
  }

  #permissionAsked(value: unknown): DirectCodecStep {
    const properties = parseProperties(PermissionAskedPropertiesSchema, value, 'permission.asked')
    if (properties.sessionID !== this.#options.sessionID) return this.#ignore()
    return this.#fail('permission-requested')
  }

  #questionAsked(value: unknown): DirectCodecStep {
    const properties = parseProperties(QuestionAskedPropertiesSchema, value, 'question.asked')
    if (properties.sessionID !== this.#options.sessionID) return this.#ignore()
    return this.#fail('question-requested')
  }

  #matchesAssistantIdentity(info: AssistantMessage): boolean {
    return (
      info.sessionID === this.#options.sessionID &&
      info.parentID === this.#options.callerMessageID &&
      info.agent === this.#options.agent &&
      info.mode === this.#options.agent &&
      info.providerID === this.#options.model.providerID &&
      info.modelID === this.#options.model.modelID &&
      info.variant === this.#options.model.variant &&
      info.path.cwd === this.#options.path.cwd &&
      info.path.root === this.#options.path.root
    )
  }

  #maybeComplete(
    records: DirectJsonlRecord[],
    pendingState: 'continue' | 'idle' = 'continue',
  ): DirectCodecStep {
    if (!this.#idle || this.#response === null) return this.#step(records, pendingState)
    const last = this.#assistants.at(-1)
    if (
      !this.#callerSeen ||
      !this.#callerTextSeen ||
      last === undefined ||
      last.time.completed === undefined ||
      this.#response.info.role !== 'assistant' ||
      this.#response.info.id !== last.id ||
      canonicalJson(this.#response.info) !== canonicalJson(last)
    ) {
      return this.#fail('response-mismatch', records)
    }
    const expectedParts = [...this.#latestParts.values()].filter(
      (part) => part.messageID === last.id,
    )
    if (expectedParts.length !== this.#response.parts.length) {
      return this.#fail('response-mismatch', records)
    }
    for (const part of this.#response.parts) {
      const latest = this.#latestParts.get(part.id)
      if (
        latest === undefined ||
        latest.messageID !== last.id ||
        canonicalJson(latest) !== canonicalJson(part)
      ) {
        return this.#fail('response-mismatch', records)
      }
    }
    this.#success = this.#response
    return this.#step(records, 'success')
  }

  #isRelated(properties: JsonObject): boolean {
    const sessionID = properties.sessionID
    if (sessionID === this.#options.sessionID) return true
    const messageID = properties.messageID
    if (
      messageID === this.#options.callerMessageID ||
      this.#assistants.some((assistant) => assistant.id === messageID)
    ) {
      return true
    }
    const info = properties.info
    if (info !== null && typeof info === 'object' && !Array.isArray(info)) {
      const id = info.id
      if (
        id === this.#options.callerMessageID ||
        this.#assistants.some((assistant) => assistant.id === id)
      ) {
        return true
      }
    }
    const part = properties.part
    if (part !== null && typeof part === 'object' && !Array.isArray(part)) {
      const owner = part.messageID
      if (
        owner === this.#options.callerMessageID ||
        this.#assistants.some((assistant) => assistant.id === owner)
      ) {
        return true
      }
    }
    return false
  }

  #ignore(): DirectCodecStep {
    this.#ignoredEvents += 1
    if (this.#ignoredEvents > this.#options.maxIgnoredEvents) {
      return this.#fail('ignored-event-budget-exceeded')
    }
    return this.#step([])
  }

  #timestamp(): number | null {
    const value = this.#options.now()
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }

  #fail(reason: DirectCodecFailureReason, records: DirectJsonlRecord[] = []): DirectCodecStep {
    this.#failure ??= reason
    return this.#step(records)
  }

  #step(
    records: DirectJsonlRecord[],
    state: 'continue' | 'ready' | 'idle' | 'success' = 'continue',
  ): DirectCodecStep {
    if (this.#failure !== null) {
      return {
        state: 'failed',
        reason: this.#failure,
        records,
        ignoredEvents: this.#ignoredEvents,
      }
    }
    if (this.#success !== null) {
      return { state: 'success', records, ignoredEvents: this.#ignoredEvents }
    }
    return { state, records, ignoredEvents: this.#ignoredEvents }
  }
}

export function serializeDirectJsonlRecord(record: DirectJsonlRecord): string {
  return `${JSON.stringify(record)}\n`
}
