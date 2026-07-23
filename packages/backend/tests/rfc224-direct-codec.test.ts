// RFC-224 regression lock: same-instance SSE correlation must bind exactly one
// caller and an ordered set of tool-loop assistant replies.

import { describe, expect, test } from 'bun:test'
import {
  DirectSessionCodec,
  serializeDirectJsonlRecord,
  type DirectCodecStep,
} from '@/services/runtime/opencode/directCodec'
import type {
  AssistantMessage,
  JsonObject,
  MessagePart,
  UserMessage,
  WireEvent,
  WithParts,
} from '@/services/runtime/opencode/directApiSchemas'

const sessionID = id('ses', 1)
const callerID = id('msg', 100)
const assistant1ID = id('msg', 101)
const assistant2ID = id('msg', 102)
const directory = '/private/tmp/rfc224-worktree'
const model = { providerID: 'openai', modelID: 'gpt-5.6', variant: 'high' }
const prompt = 'Implement the requested change.'

function id(prefix: 'ses' | 'msg' | 'prt' | 'evt' | 'per' | 'que', time: number, counter = 1) {
  const encoded = (BigInt(time) * 0x1000n + BigInt(counter)).toString(16).padStart(12, '0')
  return `${prefix}_${encoded}${'A'.repeat(14)}`
}

let eventCounter = 0
function wire(type: string, properties: JsonObject): WireEvent {
  eventCounter += 1
  return {
    id: id('evt', 1, eventCounter),
    type,
    properties,
  }
}

function user(): UserMessage {
  return {
    id: callerID,
    sessionID,
    role: 'user',
    time: { created: 100 },
    agent: 'worker',
    model,
  }
}

const zeroTokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

function assistant(
  messageID: string,
  input: {
    completed?: number
    agent?: string
    parentID?: string
    cwd?: string
    error?: { name: string; data: Record<string, never> }
  } = {},
): AssistantMessage {
  return {
    id: messageID,
    sessionID,
    role: 'assistant',
    time: {
      created: messageID === assistant1ID ? 101 : 102,
      ...(input.completed === undefined ? {} : { completed: input.completed }),
    },
    ...(input.error === undefined ? {} : { error: input.error }),
    parentID: input.parentID ?? callerID,
    modelID: model.modelID,
    providerID: model.providerID,
    mode: input.agent ?? 'worker',
    agent: input.agent ?? 'worker',
    path: { cwd: input.cwd ?? directory, root: directory },
    cost: 0,
    tokens: zeroTokens,
    variant: model.variant,
  }
}

function userPart(): MessagePart {
  return {
    id: id('prt', 100),
    sessionID,
    messageID: callerID,
    type: 'text',
    text: prompt,
  }
}

function textPart(messageID: string, input: { end?: number; partTime?: number } = {}): MessagePart {
  return {
    id: id('prt', input.partTime ?? (messageID === assistant1ID ? 101 : 102)),
    sessionID,
    messageID,
    type: 'text',
    text: `answer from ${messageID}`,
    time: { start: 1, ...(input.end === undefined ? {} : { end: input.end }) },
  }
}

function stepStart(messageID: string): MessagePart {
  return {
    id: id('prt', messageID === assistant1ID ? 101 : 102, 2),
    sessionID,
    messageID,
    type: 'step-start',
  }
}

function toolPart(messageID: string): MessagePart {
  return {
    id: id('prt', 101, 3),
    sessionID,
    messageID,
    type: 'tool',
    callID: 'call-1',
    tool: 'bash',
    state: {
      status: 'completed',
      input: { command: 'true' },
      output: '',
      title: 'Shell',
      metadata: {},
      time: { start: 1, end: 2 },
    },
  }
}

function reasoningPart(messageID: string): MessagePart {
  return {
    id: id('prt', 101, 4),
    sessionID,
    messageID,
    type: 'reasoning',
    text: 'thinking',
    time: { start: 1, end: 2 },
  }
}

function codec(overrides: Partial<ConstructorParameters<typeof DirectSessionCodec>[0]> = {}) {
  return new DirectSessionCodec({
    sessionID,
    callerMessageID: callerID,
    agent: 'worker',
    model,
    prompt,
    path: { cwd: directory, root: directory },
    now: () => 999,
    ...overrides,
  })
}

function ready(instance: DirectSessionCodec): void {
  expect(instance.consume(wire('server.connected', {})).state).toBe('ready')
  expect(instance.markPromptPosted().state).toBe('continue')
  expect(instance.consume(wire('message.updated', { sessionID, info: user() })).state).toBe(
    'continue',
  )
  expect(
    instance.consume(wire('message.part.updated', { sessionID, part: userPart(), time: 100 }))
      .state,
  ).toBe('continue')
}

function finishSingle(
  instance: DirectSessionCodec,
  order: 'idle-first' | 'response-first',
): DirectCodecStep {
  const started = assistant(assistant1ID)
  const completed = assistant(assistant1ID, { completed: 200 })
  const startPart = stepStart(assistant1ID)
  const answerPart = textPart(assistant1ID, { end: 2 })
  instance.consume(wire('message.updated', { sessionID, info: started }))
  const start = instance.consume(
    wire('message.part.updated', { sessionID, part: startPart, time: 101 }),
  )
  expect(start.records.map((record) => record.type)).toEqual(['step_start'])
  const text = instance.consume(
    wire('message.part.updated', { sessionID, part: answerPart, time: 102 }),
  )
  expect(text.records.map((record) => record.type)).toEqual(['text'])
  instance.consume(wire('message.updated', { sessionID, info: completed }))
  const response: WithParts = { info: completed, parts: [startPart, answerPart] }
  if (order === 'idle-first') {
    expect(
      instance.consume(wire('session.status', { sessionID, status: { type: 'idle' } })).state,
    ).toBe('idle')
    return instance.acceptPromptResponse(response)
  }
  expect(instance.acceptPromptResponse(response).state).toBe('continue')
  return instance.consume(wire('session.status', { sessionID, status: { type: 'idle' } }))
}

describe('RFC-224 direct session codec happy paths', () => {
  test.each(['idle-first', 'response-first'] as const)(
    'requires both strict final response and idle (%s)',
    (order) => {
      const instance = codec()
      ready(instance)
      expect(finishSingle(instance, order).state).toBe('success')
      expect(instance.result).toMatchObject({
        status: 'success',
        assistantIDs: [assistant1ID],
      })
    },
  )

  test('maps terminal parts to the v1.18.3 run --format json record shape', () => {
    const instance = codec({ thinking: true })
    ready(instance)
    instance.consume(wire('message.updated', { sessionID, info: assistant(assistant1ID) }))
    const parts = [
      toolPart(assistant1ID),
      stepStart(assistant1ID),
      {
        ...stepStart(assistant1ID),
        id: id('prt', 101, 5),
        type: 'step-finish' as const,
        reason: 'stop',
        cost: 0,
        tokens: zeroTokens,
      },
      textPart(assistant1ID, { end: 2 }),
      reasoningPart(assistant1ID),
    ]
    const records = parts.flatMap(
      (part, index) =>
        instance.consume(wire('message.part.updated', { sessionID, part, time: 110 + index }))
          .records,
    )
    expect(records.map((record) => record.type)).toEqual([
      'tool_use',
      'step_start',
      'step_finish',
      'text',
      'reasoning',
    ])
    expect(records.every((record) => record.timestamp === 999)).toBe(true)
    expect(records.every((record) => record.sessionID === sessionID)).toBe(true)
    expect(JSON.parse(serializeDirectJsonlRecord(records[0]!))).toEqual(records[0])
  })

  test('binds an ordered multi-step assistant set to the same caller', () => {
    const instance = codec()
    ready(instance)
    const firstPart = toolPart(assistant1ID)
    instance.consume(wire('message.updated', { sessionID, info: assistant(assistant1ID) }))
    instance.consume(wire('message.part.updated', { sessionID, part: firstPart, time: 1 }))
    instance.consume(
      wire('message.updated', {
        sessionID,
        info: assistant(assistant1ID, { completed: 200 }),
      }),
    )
    instance.consume(wire('message.updated', { sessionID, info: assistant(assistant2ID) }))
    const finalPart = textPart(assistant2ID, { end: 2 })
    instance.consume(wire('message.part.updated', { sessionID, part: finalPart, time: 2 }))
    const final = assistant(assistant2ID, { completed: 300 })
    instance.consume(wire('message.updated', { sessionID, info: final }))
    instance.acceptPromptResponse({ info: final, parts: [finalPart] })
    expect(
      instance.consume(wire('session.status', { sessionID, status: { type: 'idle' } })).state,
    ).toBe('success')
    expect(instance.result).toMatchObject({
      status: 'success',
      assistantIDs: [assistant1ID, assistant2ID],
    })
  })

  test('accepts deltas only after the part has been bound', () => {
    const instance = codec()
    ready(instance)
    instance.consume(wire('message.updated', { sessionID, info: assistant(assistant1ID) }))
    const partial = textPart(assistant1ID)
    instance.consume(wire('message.part.updated', { sessionID, part: partial, time: 1 }))
    expect(
      instance.consume(
        wire('message.part.delta', {
          sessionID,
          messageID: assistant1ID,
          partID: partial.id,
          field: 'text',
          delta: 'more',
        }),
      ).state,
    ).toBe('continue')
    const terminal = { ...partial, time: { start: 1, end: 2 } }
    expect(
      instance.consume(wire('message.part.updated', { sessionID, part: terminal, time: 2 }))
        .records[0]?.type,
    ).toBe('text')
  })
})

describe('RFC-224 direct session codec fail-closed correlation', () => {
  test('the first valid event must be server.connected', () => {
    const instance = codec()
    expect(instance.consume(wire('server.heartbeat', {}))).toMatchObject({
      state: 'failed',
      reason: 'first-event-not-server-connected',
    })
  })

  test('rejects duplicate caller messages/text and any other expected-session user', () => {
    const duplicate = codec()
    ready(duplicate)
    expect(duplicate.consume(wire('message.updated', { sessionID, info: user() }))).toMatchObject({
      state: 'failed',
      reason: 'caller-message-duplicate',
    })

    const other = codec()
    ready(other)
    expect(
      other.consume(
        wire('message.updated', {
          sessionID,
          info: { ...user(), id: id('msg', 103) },
        }),
      ),
    ).toMatchObject({ state: 'failed', reason: 'unexpected-user-message' })
  })

  test('rejects assistant parent/identity/order drift and a next step before completion', () => {
    const parent = codec()
    ready(parent)
    expect(
      parent.consume(
        wire('message.updated', {
          sessionID,
          info: assistant(assistant1ID, { parentID: id('msg', 99) }),
        }),
      ),
    ).toMatchObject({ state: 'failed', reason: 'assistant-parent-mismatch' })

    const identity = codec()
    ready(identity)
    expect(
      identity.consume(
        wire('message.updated', {
          sessionID,
          info: assistant(assistant1ID, { cwd: '/tmp/foreign' }),
        }),
      ),
    ).toMatchObject({ state: 'failed', reason: 'assistant-identity-mismatch' })

    const incomplete = codec()
    ready(incomplete)
    incomplete.consume(wire('message.updated', { sessionID, info: assistant(assistant1ID) }))
    expect(
      incomplete.consume(wire('message.updated', { sessionID, info: assistant(assistant2ID) })),
    ).toMatchObject({
      state: 'failed',
      reason: 'assistant-before-previous-complete',
    })
  })

  test('rejects unbound deltas and duplicate terminal emissions', () => {
    const delta = codec()
    ready(delta)
    delta.consume(wire('message.updated', { sessionID, info: assistant(assistant1ID) }))
    expect(
      delta.consume(
        wire('message.part.delta', {
          sessionID,
          messageID: assistant1ID,
          partID: id('prt', 101),
          field: 'text',
          delta: 'x',
        }),
      ),
    ).toMatchObject({ state: 'failed', reason: 'delta-before-part' })

    const duplicate = codec()
    ready(duplicate)
    duplicate.consume(wire('message.updated', { sessionID, info: assistant(assistant1ID) }))
    const part = textPart(assistant1ID, { end: 2 })
    duplicate.consume(wire('message.part.updated', { sessionID, part, time: 1 }))
    expect(
      duplicate.consume(wire('message.part.updated', { sessionID, part, time: 2 })),
    ).toMatchObject({ state: 'failed', reason: 'part-terminal-duplicate' })
  })

  test('foreign events are counted; unknown related events and overflow fail', () => {
    const instance = codec({ maxIgnoredEvents: 1 })
    ready(instance)
    expect(
      instance.consume(
        wire('session.status', {
          sessionID: id('ses', 2),
          status: { type: 'idle' },
        }),
      ),
    ).toMatchObject({ state: 'continue', ignoredEvents: 1 })
    expect(
      instance.consume(
        wire('session.status', {
          sessionID: id('ses', 3),
          status: { type: 'idle' },
        }),
      ),
    ).toMatchObject({ state: 'failed', reason: 'ignored-event-budget-exceeded' })

    const related = codec()
    ready(related)
    expect(related.consume(wire('future.event', { sessionID }))).toMatchObject({
      state: 'failed',
      reason: 'unexpected-related-event',
    })
  })

  test('permission/question/session errors are terminal and idle cannot recover failure', () => {
    const permission = codec()
    ready(permission)
    const failed = permission.consume(
      wire('permission.asked', {
        id: id('per', 1),
        sessionID,
        permission: 'bash',
        patterns: ['*'],
        metadata: {},
        always: [],
      }),
    )
    expect(failed).toMatchObject({ state: 'failed', reason: 'permission-requested' })
    expect(
      permission.consume(wire('session.status', { sessionID, status: { type: 'idle' } })),
    ).toMatchObject({ state: 'failed', reason: 'permission-requested' })

    const question = codec()
    ready(question)
    expect(
      question.consume(
        wire('question.asked', {
          id: id('que', 1),
          sessionID,
          questions: [],
        }),
      ),
    ).toMatchObject({ state: 'failed', reason: 'question-requested' })

    const errored = codec()
    ready(errored)
    const errorStep = errored.consume(
      wire('session.error', {
        sessionID,
        error: { name: 'UnknownError', data: { message: 'provider failed' } },
      }),
    )
    expect(errorStep).toMatchObject({ state: 'failed', reason: 'session-error' })
    expect(errorStep.records.map((record) => record.type)).toEqual(['error'])
  })

  test('strict final response must match the final SSE assistant and parts', () => {
    const instance = codec()
    ready(instance)
    const initial = assistant(assistant1ID)
    const completed = assistant(assistant1ID, { completed: 200 })
    const part = textPart(assistant1ID, { end: 2 })
    instance.consume(wire('message.updated', { sessionID, info: initial }))
    instance.consume(wire('message.part.updated', { sessionID, part, time: 1 }))
    instance.consume(wire('message.updated', { sessionID, info: completed }))
    instance.consume(wire('session.status', { sessionID, status: { type: 'idle' } }))
    expect(
      instance.acceptPromptResponse({
        info: completed,
        parts: [{ ...part, text: 'tampered' }],
      }),
    ).toMatchObject({ state: 'failed', reason: 'response-mismatch' })
  })

  test('stream drop before the joint success condition fails closed', () => {
    const instance = codec()
    ready(instance)
    expect(instance.streamEnded()).toMatchObject({
      state: 'failed',
      reason: 'stream-ended',
    })
  })
})
