// RFC-030 T1: contract tests for the MCP probe wire format.
//
// These pin the schema the backend persists and the front-end consumes:
//   - tool name is required; title/description/inputSchema optional and free-form
//   - errorCode enum is closed (no string drift); 'mcp-disabled' is included
//     because routes layer needs to map it to 422 by referencing the same enum
//   - probe schema is strict (catches accidental added keys) and accepts the
//     three plausible states: ok+full / ok+partial / error
//
// If a future edit loosens any of these, that's a wire-format break — the
// front-end (e.g. McpInventoryPanel) and runtime probe code will silently
// disagree about whether `null` or absence means "not probed yet".

import { describe, expect, test } from 'bun:test'
import {
  McpProbeErrorCode,
  McpProbeOperationReceiptSchema,
  McpProbeSchema,
  McpPromptInfoSchema,
  McpResourceInfoSchema,
  McpResourceTemplateInfoSchema,
  McpToolInfoSchema,
} from '../src'

describe('McpToolInfoSchema', () => {
  test('accepts minimal { name } with no metadata', () => {
    const r = McpToolInfoSchema.safeParse({ name: 'query' })
    expect(r.success).toBe(true)
  })

  test('accepts full shape with arbitrary inputSchema', () => {
    const r = McpToolInfoSchema.safeParse({
      name: 'query',
      title: 'Query',
      description: 'Run SQL',
      inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] },
    })
    expect(r.success).toBe(true)
  })

  test('rejects empty name and unknown keys', () => {
    expect(McpToolInfoSchema.safeParse({ name: '' }).success).toBe(false)
    expect(McpToolInfoSchema.safeParse({ name: 'q', extra: 1 }).success).toBe(false)
  })
})

describe('McpResourceInfoSchema / McpResourceTemplateInfoSchema', () => {
  test('resource requires uri only', () => {
    expect(McpResourceInfoSchema.safeParse({ uri: 'file:///a' }).success).toBe(true)
    expect(McpResourceInfoSchema.safeParse({ uri: '' }).success).toBe(false)
  })

  test('template requires uriTemplate only', () => {
    expect(McpResourceTemplateInfoSchema.safeParse({ uriTemplate: 'file:///{x}' }).success).toBe(
      true,
    )
    expect(McpResourceTemplateInfoSchema.safeParse({}).success).toBe(false)
  })
})

describe('McpPromptInfoSchema', () => {
  test('accepts prompt with arguments[]', () => {
    const r = McpPromptInfoSchema.safeParse({
      name: 'summarize',
      arguments: [{ name: 'topic', required: true }],
    })
    expect(r.success).toBe(true)
  })

  test('argument requires name', () => {
    expect(
      McpPromptInfoSchema.safeParse({
        name: 'p',
        arguments: [{ description: 'no name' }],
      }).success,
    ).toBe(false)
  })
})

describe('McpProbeErrorCode', () => {
  test('encloses exactly the documented 7 values', () => {
    const expected = new Set([
      'connect-failed',
      'handshake-failed',
      'auth-required',
      'timeout',
      'partial',
      'internal-error',
      'mcp-disabled',
    ])
    // The runtime enum exposes its options via `.options` in zod v3.
    const got = new Set((McpProbeErrorCode as unknown as { options: string[] }).options)
    expect(got).toEqual(expected)
  })

  test('rejects values outside the enum', () => {
    for (const bad of ['ok', 'error', '', 'CONNECT-FAILED', 'unknown']) {
      expect(McpProbeErrorCode.safeParse(bad).success).toBe(false)
    }
  })
})

describe('McpProbeSchema', () => {
  const base = {
    id: 'pb_01',
    mcpId: 'm_01',
    mcpName: 'postgres-prod',
    status: 'ok' as const,
    latencyMs: 1832,
    handshakeMs: 412,
    serverInfo: { name: 'postgres-mcp', version: '1.2.0' },
    protocolVersion: '2024-11-05',
    capabilities: { tools: { listChanged: true } },
    tools: [{ name: 'query' }],
    resources: [],
    resourceTemplates: [],
    prompts: [],
    errorCode: null,
    errorMessage: null,
    errorDetail: null,
    startedAt: 1_700_000_000_000,
    finishedAt: 1_700_000_001_832,
    updatedAt: 1_700_000_001_832,
  }

  test('happy ok shape parses', () => {
    expect(McpProbeSchema.safeParse(base).success).toBe(true)
  })

  test('partial: ok status + errorCode partial + null lists', () => {
    const partial = {
      ...base,
      status: 'ok' as const,
      tools: [{ name: 't1' }],
      resources: null, // server doesn't implement resources/list
      errorCode: 'partial' as const,
      errorMessage: 'resources/list: MethodNotFound',
      errorDetail: { partialFailures: [{ method: 'resources/list', message: 'MethodNotFound' }] },
    }
    expect(McpProbeSchema.safeParse(partial).success).toBe(true)
  })

  test('error: status=error + all lists null + errorCode set', () => {
    const errd = {
      ...base,
      status: 'error' as const,
      handshakeMs: null,
      serverInfo: null,
      protocolVersion: null,
      capabilities: null,
      tools: null,
      resources: null,
      resourceTemplates: null,
      prompts: null,
      errorCode: 'connect-failed' as const,
      errorMessage: 'spawn uvx ENOENT',
      errorDetail: { stderr: 'uvx: command not found' },
    }
    expect(McpProbeSchema.safeParse(errd).success).toBe(true)
  })

  test('rejects unknown keys (strict)', () => {
    const r = McpProbeSchema.safeParse({ ...base, weirdField: 1 })
    expect(r.success).toBe(false)
  })

  test('operation receipt extends the strict persisted row with the exact config hash', () => {
    expect(
      McpProbeOperationReceiptSchema.safeParse({
        ...base,
        configHashUsed: 'a'.repeat(64),
      }).success,
    ).toBe(true)
    expect(
      McpProbeOperationReceiptSchema.safeParse({
        ...base,
        configHashUsed: 'not-a-sha256',
      }).success,
    ).toBe(false)
  })

  test('rejects negative latency / non-integer timestamps', () => {
    expect(McpProbeSchema.safeParse({ ...base, latencyMs: -1 }).success).toBe(false)
    expect(McpProbeSchema.safeParse({ ...base, startedAt: 1.5 }).success).toBe(false)
  })

  test('serverInfo strict: rejects unknown keys', () => {
    const r = McpProbeSchema.safeParse({
      ...base,
      serverInfo: { name: 'x', version: '1', extra: 1 },
    })
    expect(r.success).toBe(false)
  })
})
