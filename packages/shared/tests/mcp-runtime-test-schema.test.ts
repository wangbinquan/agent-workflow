import { describe, expect, test } from 'bun:test'
import {
  McpRuntimeTestCreateRequestSchema,
  McpRuntimeTestEndRequestSchema,
  McpRuntimeTestMessageRequestSchema,
  McpRuntimeTestSessionDtoSchema,
  McpRuntimeTestWsMessageSchema,
} from '../src'

const HASH = 'a'.repeat(64)

describe('RFC-238 MCP runtime playground contracts', () => {
  test('create and message requests are strict, bounded, and versioned', () => {
    const create = {
      expectedMcpConfigHash: HASH,
      runtimeName: 'opencode',
      message: 'exercise this MCP',
      clientCreateId: 'create-1',
      clientMessageId: 'message-1',
    }
    expect(McpRuntimeTestCreateRequestSchema.parse(create)).toEqual(create)
    expect(
      McpRuntimeTestCreateRequestSchema.safeParse({ ...create, unexpected: true }).success,
    ).toBe(false)
    expect(
      McpRuntimeTestCreateRequestSchema.safeParse({ ...create, message: 'x'.repeat(65_537) })
        .success,
    ).toBe(false)

    const message = {
      message: 'continue',
      clientMessageId: 'message-2',
      expectedSessionVersion: 3,
    }
    expect(McpRuntimeTestMessageRequestSchema.parse(message)).toEqual(message)
    expect(
      McpRuntimeTestMessageRequestSchema.safeParse({
        ...message,
        expectedSessionVersion: -1,
      }).success,
    ).toBe(false)

    expect(McpRuntimeTestEndRequestSchema.parse({})).toEqual({})
    expect(McpRuntimeTestEndRequestSchema.safeParse({ force: true }).success).toBe(false)
  })

  test('session DTO rejects unknown lifecycle values and secret-bearing extras', () => {
    const session = {
      id: 'session-1',
      mcpId: 'mcp-1',
      status: 'active',
      endReason: null,
      runtime: { name: 'opencode', protocol: 'opencode' },
      mcpConfigHash: HASH,
      runtimeFingerprint: 'b'.repeat(64),
      nativeSessionReady: true,
      continuationBlockedReason: null,
      inFlightTurnId: null,
      sessionVersion: 2,
      idleDeadlineAt: 600_000,
      cleanupState: 'not-started',
      turns: [],
      eventCursor: 0,
      createdAt: 1,
      updatedAt: 2,
      endedAt: null,
    }
    expect(McpRuntimeTestSessionDtoSchema.safeParse(session).success).toBe(true)
    expect(
      McpRuntimeTestSessionDtoSchema.safeParse({
        ...session,
        status: 'paused',
      }).success,
    ).toBe(false)
    expect(
      McpRuntimeTestSessionDtoSchema.safeParse({
        ...session,
        mcpConfig: { env: { SECRET: 'must-not-cross-the-wire' } },
      }).success,
    ).toBe(false)
  })

  test('private WS locator is strict and carries no owner or transcript payload', () => {
    const locator = {
      type: 'mcp-runtime-test.updated',
      sessionId: 'session-1',
      sessionVersion: 3,
      inFlightTurnId: 'turn-2',
      turnStatus: 'running',
      eventCursor: 8,
      captureState: 'live',
    } as const
    expect(McpRuntimeTestWsMessageSchema.parse(locator)).toEqual(locator)
    expect(
      McpRuntimeTestWsMessageSchema.safeParse({
        ...locator,
        ownerUserId: 'must-not-cross-wire',
      }).success,
    ).toBe(false)
    expect(
      McpRuntimeTestWsMessageSchema.safeParse({
        ...locator,
        transcript: [{ secret: true }],
      }).success,
    ).toBe(false)
  })
})
