// Dependency migration: preserve sparse writes, stored wire shapes and validation contracts.
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { ConfigPatchSchema, ConfigSchema, DEFAULT_CONFIG } from '../src/schemas/config'
import { CreateAgentSchema, UpdateAgentSchema } from '../src/schemas/agent'
import { PatchOidcProviderBodySchema } from '../src/schemas/oidcProvider'
import { ExecutionStatusSchema } from '../src/schemas/executionStatus'
import { HostedBackupIdSchema } from '../src/schemas/hostedBackup'
import { UpdateOwnProfileBodySchema } from '../src/schemas/user'
import { TaskWsMessageSchema } from '../src/schemas/ws'
import { formatChangesetIssues } from '../src/schemas/intentChangeset'
import { sparsePatch } from '../src/schemas/sparsePatch'
import { utf16MinLength, utf16MaxLength, utf16Length } from '../src/schemas/utf16Length'
import { TaskNameSchema, TaskSchema } from '../src/schemas/task'
import { GraphContentRefSchema } from '../src/schemas/graphDesign'

describe('Zod 4 wire compatibility', () => {
  test('existing string limits keep UTF-16 units, boundary issues and JSON Schema bounds', () => {
    const min = z.string().check(utf16MinLength(2))
    const max = z.string().check(utf16MaxLength(2))
    const exact = z.string().check(utf16Length(2))
    for (const value of ['😀', 'ab', '\ud83d\ude00']) {
      expect(min.safeParse(value).success).toBe(true)
      expect(max.safeParse(value).success).toBe(true)
      expect(exact.safeParse(value).success).toBe(true)
    }
    expect(min.safeParse('a').success).toBe(false)
    expect(max.safeParse('😀a').success).toBe(false)
    expect(exact.safeParse('😀a').success).toBe(false)
    expect(exact.safeParse('a').success).toBe(false)
    expect(min.safeParse(null).success).toBe(false)
    expect(max.safeParse(3).success).toBe(false)
    expect(TaskNameSchema.safeParse('😀'.repeat(127) + 'a').success).toBe(true)
    expect(TaskNameSchema.safeParse('😀'.repeat(128)).success).toBe(false)
    const failure = z
      .object({ name: z.string().check(utf16MaxLength(2, 'old limit')) })
      .safeParse({ name: '😀a' })
    expect(failure.success).toBe(false)
    if (!failure.success)
      expect(failure.error.issues).toEqual([
        {
          origin: 'string',
          code: 'too_big',
          maximum: 2,
          inclusive: true,
          path: ['name'],
          message: 'old limit',
        },
      ])
    expect(z.toJSONSchema(z.string().check(utf16MinLength(2), utf16MaxLength(4)))).toMatchObject({
      type: 'string',
      minLength: 2,
      maxLength: 4,
    })
    expect(z.toJSONSchema(exact)).toMatchObject({ type: 'string', minLength: 2, maxLength: 2 })
  })

  test('PATCH schemas preserve absent and explicit undefined fields without applying create defaults', () => {
    for (const schema of [ConfigPatchSchema, UpdateAgentSchema, PatchOidcProviderBodySchema]) {
      expect(schema.parse({})).toEqual({})
    }
    expect(ConfigPatchSchema.parse({ language: 'en-US' })).toEqual({ language: 'en-US' })
    expect(UpdateAgentSchema.parse({ description: 'changed' })).toEqual({ description: 'changed' })
    expect(UpdateAgentSchema.parse({ description: undefined })).toEqual({ description: undefined })
    expect(UpdateAgentSchema.parse({ runtime: null })).toEqual({ runtime: null })
    expect(ConfigSchema.parse(DEFAULT_CONFIG)).toEqual(DEFAULT_CONFIG)
    expect(CreateAgentSchema.parse({ name: 'sample' })).toMatchObject({
      description: '',
      outputs: [],
      skills: [],
      mcp: [],
      plugins: [],
      bodyMd: '',
    })
  })

  test('sparse defaults preserve nested parsing and all original validators', () => {
    const schema = sparsePatch(
      z
        .object({
          value: z.string().min(2).default('ok'),
          nested: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
        })
        .strict(),
    )
    expect(schema.parse({})).toEqual({})
    expect(schema.parse({ nested: {} })).toEqual({ nested: { enabled: true } })
    expect(schema.safeParse({ value: 'x' }).success).toBe(false)
    expect(schema.safeParse({ extra: true }).success).toBe(false)
  })

  test('enum-key records stay sparse and still reject unknown execution groups', () => {
    const status = { mode: 'standalone', state: 'active', reason: null }
    expect(ExecutionStatusSchema.parse({ ...status, unavailableGroups: { task: 'busy' } })).toEqual(
      { ...status, unavailableGroups: { task: 'busy' } },
    )
    expect(
      ExecutionStatusSchema.parse({ ...status, unavailableGroups: {} }).unavailableGroups,
    ).toEqual({})
    expect(
      ExecutionStatusSchema.safeParse({ ...status, unavailableGroups: { bogus: 'busy' } }).success,
    ).toBe(false)
  })

  test('UUID-compatible identifiers retain the v3 generic hex pattern', () => {
    for (const backupId of [
      '00000000-0000-0000-0000-000000000000',
      'ABCDEFAB-1234-0000-0000-123456789ABC',
    ]) {
      expect(HostedBackupIdSchema.parse({ backupId })).toEqual({ backupId })
    }
    expect(HostedBackupIdSchema.safeParse({ backupId: 'not-a-uuid' }).success).toBe(false)
  })

  test('email normalization and the accepted/rejected address corpus stay stable', () => {
    const parse = (email: string) =>
      UpdateOwnProfileBodySchema.safeParse({ displayName: 'User', gitName: 'User', email })
    for (const email of ['a.b+tag@example.com', "o'neil@example.co.uk", 'A_B@example.com']) {
      const result = parse(email)
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.email).toBe(email.toLowerCase())
    }
    for (const email of [
      '.a@example.com',
      'a..b@example.com',
      'a.@example.com',
      'a@localhost',
      'a@example.c',
    ]) {
      expect(parse(email).success).toBe(false)
    }
  })

  test('unknown object payloads retain omission, explicit undefined, null and arbitrary JSON', () => {
    // The event payload is intentionally opaque and was optional under Zod 3.
    const schema = TaskWsMessageSchema.options[5]
    const event = { type: 'event', event: 'test', payload: undefined }
    // Narrow to the actual exported event payload contract through its shape.
    const payload = schema.shape.payload
    expect(z.object({ payload }).parse({})).toEqual({})
    expect(z.object({ payload }).parse({ payload: null })).toEqual({ payload: null })
    expect(z.object({ payload }).parse({ payload: { nested: [1, true] } })).toEqual({
      payload: { nested: [1, true] },
    })
    expect(z.object({ payload }).parse({ payload: event.payload })).toEqual({ payload: undefined })
  })

  test('union issue expansion retains nested field paths and useful branch messages', () => {
    const schema = z.object({
      entry: z.union([
        z.object({ name: z.string() }),
        z.object({ count: z.number(), other: z.string() }),
      ]),
    })
    const result = schema.safeParse({ entry: { name: 3 } })
    expect(result.success).toBe(false)
    if (!result.success)
      expect(formatChangesetIssues(result.error.issues)).toEqual([
        'entry.name: Invalid input: expected string, received number',
      ])
  })

  test('v4 numeric limits and default issue wording are explicit', () => {
    for (const value of [Infinity, -Infinity, NaN]) {
      expect(z.number().safeParse(value).success).toBe(false)
      expect(TaskSchema.shape.workflowVersion.safeParse(value).success).toBe(false)
    }
    for (const value of [Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1]) {
      expect(z.number().int().safeParse(value).success).toBe(false)
    }
    expect(z.number().int().parse(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER)
    const contentRef = { id: 'revision', digest: 'a'.repeat(64), revision: Number.MAX_SAFE_INTEGER }
    expect(GraphContentRefSchema.parse(contentRef)).toEqual(contentRef)
    expect(
      GraphContentRefSchema.safeParse({ ...contentRef, revision: Number.MAX_SAFE_INTEGER + 1 })
        .success,
    ).toBe(false)
    const result = z.object({ value: z.string() }).safeParse({})
    expect(result.success).toBe(false)
    if (!result.success)
      expect(result.error.issues).toEqual([
        {
          expected: 'string',
          code: 'invalid_type',
          path: ['value'],
          message: 'Invalid input: expected string, received undefined',
        },
      ])
  })
})
