// RFC-280 T3 — startup verification layer (services/execution/startupVerification.ts).
//
// Locks the three-state observation model (design-gate P1-4) and the
// reason-preserving MCP diff (P1-5): "cannot observe" must never read as
// "verified", and a failed MCP carries the runtime's own status/hint. Born from
// two 2026-08 incidents where a missing MCP surfaced only as the agent politely
// saying it had no such tool while the node reported success.

import { describe, expect, test } from 'bun:test'
import type { InventorySnapshot } from '@agent-workflow/shared'
import { emptyDeclaredManifest } from '@/services/execution/agentInjection'
import {
  declaredHasContent,
  observationFromClaudeInit,
  observationFromInventory,
  verifyStartup,
} from '@/services/execution/startupVerification'

function declaredWith(
  overrides: Partial<ReturnType<typeof emptyDeclaredManifest>>,
): ReturnType<typeof emptyDeclaredManifest> {
  return { ...emptyDeclaredManifest(), ...overrides }
}

describe('declaredHasContent', () => {
  test('empty manifest → false; any face → true', () => {
    expect(declaredHasContent(emptyDeclaredManifest())).toBe(false)
    expect(declaredHasContent(declaredWith({ mcpServers: ['m'] }))).toBe(true)
    expect(declaredHasContent(declaredWith({ skippedDisabledMcps: ['off'] }))).toBe(true)
    expect(declaredHasContent(declaredWith({ droppedParams: ['variant'] }))).toBe(true)
    expect(declaredHasContent(declaredWith({ unsupported: ['plugin:x'] }))).toBe(true)
  })
})

describe('verifyStartup (verified observation)', () => {
  const observation = {
    state: 'verified' as const,
    source: 'opencode-inventory' as const,
    mcpServers: [
      { name: 'ok', status: 'connected' },
      { name: 'broken', status: 'failed', hint: 'spawn ENOENT' },
    ],
    agents: ['helper'],
    skills: ['sk'],
    tools: ['Read'],
  }

  test('a connected MCP passes; a failed one carries status+hint; absent → missing', () => {
    const declared = declaredWith({ mcpServers: ['ok', 'broken', 'ghost'] })
    const v = verifyStartup(declared, observation)
    expect(v.observation).toBe('verified')
    expect(v.mcpUnusable).toEqual([
      { name: 'broken', status: 'failed', hint: 'spawn ENOENT' },
      { name: 'ghost', status: 'missing' },
    ])
  })

  test('skills/subagents/tools diff against their observed faces', () => {
    const declared = declaredWith({
      skills: ['sk', 'lost-skill'],
      subagents: ['helper', 'lost-agent'],
      tools: ['Read', 'Bash'],
    })
    const v = verifyStartup(declared, observation)
    expect(v.skillsMissing).toEqual(['lost-skill'])
    expect(v.subagentsMissing).toEqual(['lost-agent'])
    expect(v.toolsMissing).toEqual(['Bash'])
  })

  test('an unobserved face (undefined) is skipped, never reported missing', () => {
    const noFaces = {
      state: 'verified' as const,
      source: 'claude-init' as const,
      mcpServers: [],
    }
    const declared = declaredWith({ skills: ['sk'], subagents: ['a'], tools: ['Read'] })
    const v = verifyStartup(declared, noFaces)
    expect(v.skillsMissing).toEqual([])
    expect(v.subagentsMissing).toEqual([])
    expect(v.toolsMissing).toEqual([])
  })

  test('tools:null (unconstrained) never diffs the tools face', () => {
    const v = verifyStartup(declaredWith({ tools: null }), observation)
    expect(v.toolsMissing).toEqual([])
  })

  test('plugins face is never diffed here (specifier/name key mismatch → unobservable)', () => {
    const v = verifyStartup(declaredWith({ plugins: ['plg'] }), observation)
    expect(v.pluginsMissing).toEqual([])
  })
})

describe('verifyStartup (non-verified observations never fabricate results)', () => {
  test('unavailable/malformed propagate reason and keep every missing list empty', () => {
    const declared = declaredWith({ mcpServers: ['m'], skills: ['sk'] })
    for (const state of ['unavailable', 'malformed'] as const) {
      const v = verifyStartup(declared, { state, reason: 'x-reason' })
      expect(v.observation).toBe(state)
      expect(v.observationReason).toBe('x-reason')
      expect(v.mcpUnusable).toEqual([])
      expect(v.skillsMissing).toEqual([])
    }
  })
})

describe('observationFromInventory (opencode)', () => {
  test('null snapshot → unavailable(inventory-not-read)', () => {
    expect(observationFromInventory(null)).toEqual({
      state: 'unavailable',
      reason: 'inventory-not-read',
    })
  })

  test('captured:false routes parse-failed to malformed, others to unavailable', () => {
    const missing = {
      captured: false,
      reason: 'file-missing',
      message: null,
    } as InventorySnapshot
    expect(observationFromInventory(missing).state).toBe('unavailable')
    const malformed = {
      captured: false,
      reason: 'parse-failed',
      message: null,
    } as InventorySnapshot
    expect(observationFromInventory(malformed)).toEqual({
      state: 'malformed',
      reason: 'parse-failed',
    })
  })

  test('captured:true maps mcp status/hint and name lists', () => {
    const snap = {
      captured: true,
      schemaVersion: 1,
      capturedAt: 1,
      agents: [
        {
          name: 'helper',
          mode: 'subagent',
          modelProviderId: null,
          modelId: null,
          source: 'inline',
        },
      ],
      skills: [{ name: 'sk', source: 'inline', path: null, description: null }],
      mcps: [
        { name: 'ok', type: 'local', status: 'connected', hint: null },
        { name: 'bad', type: 'local', status: 'failed', hint: 'spawn ENOENT' },
      ],
      plugins: [],
    } as InventorySnapshot
    const obs = observationFromInventory(snap)
    expect(obs).toEqual({
      state: 'verified',
      source: 'opencode-inventory',
      mcpServers: [
        { name: 'ok', status: 'connected' },
        { name: 'bad', status: 'failed', hint: 'spawn ENOENT' },
      ],
      agents: ['helper'],
      skills: ['sk'],
    })
  })
})

describe('parseStartupInventory carries mcp_servers statuses (落差①/P1-5)', () => {
  test('init event yields tools/agents/skills AND per-server status verbatim', async () => {
    const { parseStartupInventory } = await import('@/services/runtime/claudeCode/events')
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      tools: ['Read', 'Bash'],
      agents: ['helper'],
      skills: [],
      mcp_servers: [
        { name: 'ok', status: 'connected' },
        { name: 'rag-search', status: 'failed' },
      ],
    })
    const inv = parseStartupInventory(line)
    expect(inv).not.toBeNull()
    expect(inv?.tools).toEqual(['Read', 'Bash'])
    expect(inv?.mcpServers).toEqual([
      { name: 'ok', status: 'connected' },
      { name: 'rag-search', status: 'failed' },
    ])
  })

  test('an init with only mcp_servers is still a real answer (not null)', async () => {
    const { parseStartupInventory } = await import('@/services/runtime/claudeCode/events')
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      mcp_servers: [{ name: 'x', status: 'pending' }],
    })
    expect(parseStartupInventory(line)?.mcpServers).toEqual([{ name: 'x', status: 'pending' }])
  })

  test('non-init lines and malformed JSON stay null', async () => {
    const { parseStartupInventory } = await import('@/services/runtime/claudeCode/events')
    expect(parseStartupInventory('{"type":"assistant"}')).toBeNull()
    expect(parseStartupInventory('not json')).toBeNull()
  })
})

describe('observationFromClaudeInit', () => {
  test('no init event → unavailable(no-init-event)', () => {
    expect(observationFromClaudeInit(null)).toEqual({
      state: 'unavailable',
      reason: 'no-init-event',
    })
  })

  test('captured init maps servers verbatim and keeps undefined faces undefined', () => {
    const obs = observationFromClaudeInit({
      mcpServers: [{ name: 'rag-search', status: 'failed' }],
      tools: ['Read'],
    })
    expect(obs).toEqual({
      state: 'verified',
      source: 'claude-init',
      mcpServers: [{ name: 'rag-search', status: 'failed' }],
      tools: ['Read'],
    })
  })
})

describe('applyPlaygroundVerification (RFC-280 T6 strict playground verdict)', () => {
  const cleanVerification = {
    observation: 'verified' as const,
    mcpUnusable: [],
    skillsMissing: [],
    subagentsMissing: [],
    toolsMissing: [],
    pluginsMissing: [],
  }

  test('unusable MCP fails an otherwise-succeeded turn with mcp-test-mcp-unusable', async () => {
    const { applyPlaygroundVerification } = await import('@/services/mcpRuntimeTest')
    expect(
      applyPlaygroundVerification('succeeded', null, {
        ...cleanVerification,
        mcpUnusable: [{ name: 'rag-search', status: 'failed' }],
      }),
    ).toEqual({ turnStatus: 'failed', failureCode: 'mcp-test-mcp-unusable' })
  })

  test('unobservable startup fails closed with mcp-test-verification-unavailable', async () => {
    const { applyPlaygroundVerification } = await import('@/services/mcpRuntimeTest')
    for (const observation of ['unavailable', 'malformed'] as const) {
      expect(
        applyPlaygroundVerification('succeeded', null, {
          ...cleanVerification,
          observation,
          observationReason: 'x',
        }),
      ).toEqual({ turnStatus: 'failed', failureCode: 'mcp-test-verification-unavailable' })
    }
  })

  test('durable failure codes take priority and are never overwritten', async () => {
    const { applyPlaygroundVerification } = await import('@/services/mcpRuntimeTest')
    expect(
      applyPlaygroundVerification('timed_out', 'mcp-test-turn-timeout', {
        ...cleanVerification,
        mcpUnusable: [{ name: 'x', status: 'failed' }],
      }),
    ).toEqual({ turnStatus: 'timed_out', failureCode: 'mcp-test-turn-timeout' })
  })

  test('a verified, connected run stays succeeded', async () => {
    const { applyPlaygroundVerification } = await import('@/services/mcpRuntimeTest')
    expect(applyPlaygroundVerification('succeeded', null, cleanVerification)).toEqual({
      turnStatus: 'succeeded',
      failureCode: null,
    })
  })
})
