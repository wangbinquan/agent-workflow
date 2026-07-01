// RFC-029-T1: zod discriminated union & per-asset schemas.

import { describe, expect, test } from 'bun:test'
import {
  InventoryAgentSchema,
  InventoryMcpSchema,
  InventoryPluginSchema,
  InventorySkillSchema,
  InventorySnapshotCapturedSchema,
  InventorySnapshotMissingSchema,
  InventorySnapshotSchema,
} from '../src/inventory'

describe('InventorySnapshotSchema', () => {
  test('accepts a fully populated captured snapshot', () => {
    const parsed = InventorySnapshotSchema.parse({
      captured: true,
      schemaVersion: 1,
      capturedAt: 1700000000000,
      agents: [
        {
          name: 'reviewer',
          mode: 'primary',
          modelProviderId: 'anthropic',
          modelId: 'claude-opus-4-7',
          source: 'inline',
        },
      ],
      skills: [{ name: 'foo', source: 'managed', path: '/tmp/foo', description: null }],
      mcps: [{ name: 'memcache', type: 'local', status: 'connected', hint: null }],
      plugins: [{ specifier: 'file:///tmp/p.mjs', source: 'inline' }],
    })
    expect(parsed.captured).toBe(true)
    if (parsed.captured) {
      expect(parsed.agents).toHaveLength(1)
      expect(parsed.mcps[0]!.status).toBe('connected')
    }
  })

  test('accepts a captured:false missing snapshot with each reason code', () => {
    for (const reason of [
      'file-missing',
      'parse-failed',
      'opencode-pure-mode',
      'plugin-load-failed',
      'dump-plugin-internal-error',
      'non-agent-kind',
      // RFC-062: in-flight reason for running runs whose inventory.json hasn't
      // been persisted to the DB column yet.
      'in-flight',
    ] as const) {
      const parsed = InventorySnapshotMissingSchema.parse({
        captured: false,
        reason,
        message: null,
      })
      expect(parsed.reason).toBe(reason)
    }
  })

  test('discriminator routes captured:false even when extra fields present', () => {
    const parsed = InventorySnapshotSchema.parse({
      captured: false,
      reason: 'file-missing',
      message: 'inventory.json not found',
    })
    expect(parsed.captured).toBe(false)
    if (!parsed.captured) expect(parsed.message).toBe('inventory.json not found')
  })

  test('rejects unknown captured value', () => {
    expect(() =>
      InventorySnapshotSchema.parse({ captured: 'maybe', reason: 'file-missing' }),
    ).toThrow()
  })

  test('captured:true requires schemaVersion === 1', () => {
    expect(() =>
      InventorySnapshotCapturedSchema.parse({
        captured: true,
        schemaVersion: 2,
        capturedAt: 0,
        agents: [],
        skills: [],
        mcps: [],
        plugins: [],
      }),
    ).toThrow()
  })

  test('captured:false rejects unknown reason code', () => {
    expect(() =>
      InventorySnapshotMissingSchema.parse({
        captured: false,
        reason: 'unknown-error',
        message: null,
      }),
    ).toThrow()
  })

  test('InventoryAgentSchema enforces required fields', () => {
    expect(() =>
      InventoryAgentSchema.parse({
        name: 'a',
        mode: 'primary',
        modelProviderId: null,
        modelId: null,
        // source missing
      }),
    ).toThrow()
  })

  test('InventorySkillSchema allows nullable path & description', () => {
    const parsed = InventorySkillSchema.parse({
      name: 's',
      source: 'managed',
      path: null,
      description: null,
    })
    expect(parsed.path).toBeNull()
    expect(parsed.description).toBeNull()
  })

  test('InventoryMcpSchema preserves arbitrary status strings (forward-compat)', () => {
    const parsed = InventoryMcpSchema.parse({
      name: 'm',
      type: 'remote',
      status: 'brand-new-status',
      hint: null,
    })
    expect(parsed.status).toBe('brand-new-status')
  })

  test('InventoryPluginSchema rejects missing specifier', () => {
    expect(() => InventoryPluginSchema.parse({ source: 'inline' })).toThrow()
  })
})
