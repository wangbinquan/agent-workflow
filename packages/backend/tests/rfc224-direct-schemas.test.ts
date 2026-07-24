// RFC-224/RFC-227 regression lock: direct OpenCode requests/responses must stay
// strict to the opencode-direct-v1 behavior contract. Reported release text is
// telemetry, not protocol identity or an admission boundary.

import { describe, expect, test } from 'bun:test'
import {
  AscendingMessageIdGenerator,
  DirectApiValidationError,
  GlobalSessionInfoSchema,
  ROOT_SESSION_PERMISSION_RULES,
  SessionInfoSchema,
  SessionInventoryAccumulator,
  assertMessageIdAfterHistory,
  buildCreateSessionRequest,
  buildPromptRequest,
  decodeAscendingMessageId,
  encodeAscendingMessageId,
  parseAndValidateCreatedSession,
  parseDirectApiValue,
  validateLatestMessageInventory,
} from '@/services/runtime/opencode/directApiSchemas'

const directory = '/private/tmp/rfc224-worktree'
const sessionID = 'ses_000000001001AAAAAAAAAAAAAA'
const callerID = 'msg_000000064001BBBBBBBBBBBBBB'

function session(
  input: {
    id?: string
    updated?: number
    title?: string
    global?: boolean
  } = {},
) {
  const base = {
    id: input.id ?? sessionID,
    slug: 'quiet-moon',
    projectID: 'project-1',
    directory,
    path: '',
    title: input.title ?? 'agent-workflow:run-1',
    agent: 'worker',
    model: { providerID: 'openai', id: 'gpt-5.6' },
    version: '1.18.3',
    time: { created: 1, updated: input.updated ?? 10 },
    permission: ROOT_SESSION_PERMISSION_RULES.map((rule) => ({ ...rule })),
  }
  return input.global ? { ...base, project: null } : base
}

describe('RFC-224 direct API request/response schemas', () => {
  test('create and prompt builders preserve the intentionally different model keys', () => {
    const create = buildCreateSessionRequest({
      title: 'agent-workflow:run-1',
      agent: 'worker',
      model: { providerID: 'openai', modelID: 'gpt-5.6', variant: 'high' },
    })
    expect(create).toEqual({
      title: 'agent-workflow:run-1',
      agent: 'worker',
      model: { providerID: 'openai', id: 'gpt-5.6', variant: 'high' },
      permission: [
        { permission: 'question', pattern: '*', action: 'deny' },
        { permission: 'plan_enter', pattern: '*', action: 'deny' },
        { permission: 'plan_exit', pattern: '*', action: 'deny' },
      ],
    })

    const prompt = buildPromptRequest({
      messageID: callerID,
      agent: 'worker',
      model: { providerID: 'openai', modelID: 'gpt-5.6', variant: 'high' },
      prompt: 'Do the work.',
    })
    expect(prompt).toEqual({
      messageID: callerID,
      agent: 'worker',
      model: { providerID: 'openai', modelID: 'gpt-5.6' },
      variant: 'high',
      parts: [{ type: 'text', text: 'Do the work.' }],
    })
    expect(prompt).not.toHaveProperty('noReply')
    expect(prompt).not.toHaveProperty('tools')
    expect(prompt).not.toHaveProperty('system')
    expect(prompt).not.toHaveProperty('format')
  })

  test('strict schemas reject unknown routing/control fields without echoing values', () => {
    const secret = 'secret-routing-value'
    let error: unknown
    try {
      parseDirectApiValue(SessionInfoSchema, { ...session(), workspace: secret }, 'create-response')
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(DirectApiValidationError)
    expect(String(error)).not.toContain(secret)
    expect((error as DirectApiValidationError).reason).toBe('unexpected-field')
  })

  test('created session enforces semantic identity while accepting version telemetry drift', () => {
    const expected = {
      directory,
      title: 'agent-workflow:run-1',
      agent: 'worker',
      model: { providerID: 'openai', modelID: 'gpt-5.6' },
    }
    expect(parseAndValidateCreatedSession(session(), expected).projectID).toBe('project-1')
    expect(() =>
      parseAndValidateCreatedSession({ ...session(), parentID: sessionID }, expected),
    ).toThrow('identity-mismatch')
    expect(() =>
      parseAndValidateCreatedSession(
        { ...session(), permission: [...ROOT_SESSION_PERMISSION_RULES].reverse() },
        expected,
      ),
    ).toThrow('identity-mismatch')
    expect(
      parseAndValidateCreatedSession({ ...session(), version: 'custom-fork-999' }, expected)
        .version,
    ).toBe('custom-fork-999')
  })

  test('plain JSON values reject cycles, poison keys, non-finite numbers, and class instances', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const poison = JSON.parse('{"__proto__":{"polluted":true}}')
    for (const bad of [
      { ...session(), metadata: cycle },
      { ...session(), metadata: poison },
      { ...session(), metadata: { bad: Number.POSITIVE_INFINITY } },
      { ...session(), metadata: new Date() },
    ]) {
      expect(() => parseDirectApiValue(SessionInfoSchema, bad, 'session')).toThrow(
        'schema-mismatch',
      )
    }
  })
})

describe('RFC-224 direct ascending message ID codec', () => {
  test('encodes and decodes the exact 12-hex + 14-base62 layout', () => {
    const id = encodeAscendingMessageId({
      timestampMs: 1,
      counter: 1,
      randomBytes: new Uint8Array(14),
    })
    expect(id).toBe('msg_00000000100100000000000000')
    expect(decodeAscendingMessageId(id)).toEqual({
      timestampMs: 1,
      counter: 1,
      random: '00000000000000',
    })
  })

  test('matches the direct-codec low-six-byte truncation for real epoch milliseconds', () => {
    const timestampMs = Date.now()
    const id = encodeAscendingMessageId({
      timestampMs,
      counter: 1,
      randomBytes: new Uint8Array(14),
    })
    const expectedEncoded = (BigInt(timestampMs) * 0x1000n + 1n) & 0xffffffffffffn
    expect(id).toBe(`msg_${expectedEncoded.toString(16).padStart(12, '0')}00000000000000`)
    expect(decodeAscendingMessageId(id)).toEqual({
      timestampMs: Number(BigInt(timestampMs) & 0xfffffffffn),
      counter: 1,
      random: '00000000000000',
    })
  })

  test('instance generator increments counters and resets them on a new millisecond', () => {
    const generator = new AscendingMessageIdGenerator(
      () => new Uint8Array(Array.from({ length: 14 }, () => 61)),
    )
    const first = generator.create(100)
    const second = generator.create(100)
    const third = generator.create(101)
    expect(decodeAscendingMessageId(first).counter).toBe(1)
    expect(decodeAscendingMessageId(second).counter).toBe(2)
    expect(decodeAscendingMessageId(third).counter).toBe(1)
    expect(first.endsWith('zzzzzzzzzzzzzz')).toBe(true)
    expect(first < second && second < third).toBe(true)
  })

  test('history and caller IDs must be strictly increasing', () => {
    const generator = new AscendingMessageIdGenerator(() => new Uint8Array(14))
    const old = generator.create(50)
    const latest = generator.create(51)
    const caller = generator.create(52)
    expect(() => assertMessageIdAfterHistory(caller, [old, latest])).not.toThrow()
    expect(() => assertMessageIdAfterHistory(latest, [old, latest])).toThrow(
      'caller-not-after-history',
    )
    expect(() => assertMessageIdAfterHistory(caller, [latest, old])).toThrow(
      'not-strictly-ascending',
    )
  })

  test('invalid counter/random/timestamp inputs fail closed', () => {
    expect(() =>
      encodeAscendingMessageId({
        timestampMs: 1,
        counter: 0,
        randomBytes: new Uint8Array(14),
      }),
    ).toThrow('invalid-time-or-counter')
    expect(() =>
      encodeAscendingMessageId({
        timestampMs: 1,
        counter: 1,
        randomBytes: new Uint8Array(13),
      }),
    ).toThrow('invalid-random-length')
  })
})

describe('RFC-224 lossy cursor inventory validator', () => {
  test('accepts strictly descending pages and returns the exact owner session', () => {
    const accumulator = new SessionInventoryAccumulator(2)
    const wanted = session({ id: sessionID, updated: 9, global: true })
    const page1 = [
      session({
        id: 'ses_000000002001AAAAAAAAAAAAAA',
        updated: 10,
        global: true,
      }),
      wanted,
    ]
    expect(parseDirectApiValue(GlobalSessionInfoSchema, wanted, 'fixture').id).toBe(sessionID)
    expect(accumulator.addPage(page1, '9').nextCursor).toBe(9)
    expect(
      accumulator.addPage(
        [
          session({
            id: 'ses_000000003001AAAAAAAAAAAAAA',
            updated: 8,
            global: true,
          }),
        ],
        null,
        9,
      ).nextCursor,
    ).toBeNull()
    expect(
      accumulator.finish({
        sessionID,
        directory,
        title: 'agent-workflow:run-1',
        agent: 'worker',
        model: { providerID: 'openai', modelID: 'gpt-5.6' },
        projectID: 'project-1',
      }).id,
    ).toBe(sessionID)
  })

  test('rejects duplicate timestamps, IDs, cursor loops, and equal boundaries', () => {
    const duplicateTime = new SessionInventoryAccumulator(2)
    expect(() =>
      duplicateTime.addPage(
        [
          session({ id: sessionID, updated: 10, global: true }),
          session({
            id: 'ses_000000002001AAAAAAAAAAAAAA',
            updated: 10,
            global: true,
          }),
        ],
        '10',
      ),
    ).toThrow('duplicate-timestamp')

    const equalBoundary = new SessionInventoryAccumulator(1)
    equalBoundary.addPage([session({ updated: 10, global: true })], '10')
    expect(() =>
      equalBoundary.addPage(
        [
          session({
            id: 'ses_000000002001AAAAAAAAAAAAAA',
            updated: 10,
            global: true,
          }),
        ],
        null,
        10,
      ),
    ).toThrow('ambiguous-page-boundary')

    const loop = new SessionInventoryAccumulator(1)
    loop.addPage([session({ updated: 10, global: true })], '10')
    expect(() =>
      loop.addPage(
        [
          session({
            id: 'ses_000000002001AAAAAAAAAAAAAA',
            updated: 9,
            global: true,
          }),
        ],
        '10',
        10,
      ),
    ).toThrow('cursor-loop')
  })

  test('latest-message inventory accepts zero/one same-session message only', () => {
    expect(validateLatestMessageInventory([], sessionID)).toBeNull()
    expect(() =>
      validateLatestMessageInventory(
        [
          {
            info: {
              id: callerID,
              sessionID,
              role: 'user',
              time: { created: 1 },
              agent: 'worker',
              model: { providerID: 'openai', modelID: 'gpt-5.6' },
            },
            parts: [],
          },
          {
            info: {
              id: 'msg_000000065001BBBBBBBBBBBBBB',
              sessionID,
              role: 'user',
              time: { created: 2 },
              agent: 'worker',
              model: { providerID: 'openai', modelID: 'gpt-5.6' },
            },
            parts: [],
          },
        ],
        sessionID,
      ),
    ).toThrow('schema-mismatch')
  })
})
