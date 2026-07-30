// RFC-234 §1.1 (T2) — locks the frozen system-agent permission profiles
// (Codex design-gate P0-1 resolution):
//
//  1. Default ('all-deny') keeps the RFC-224 permission tail BYTE-IDENTICAL —
//     every pre-RFC-234 caller (distiller / smoke / commit-push) is unchanged.
//  2. 'intent-read-v1' flips ONLY read/grep/glob to allow, with the SAME key
//     set and SAME insertion order (the ordered Agent.Info rule tail is
//     qualified shape — order is load-bearing, hermetic.ts §buildControlled…).
//  3. Anything outside the closed read-only set is an identity failure — a
//     bash/write/network allow has no spelling.
//  4. The claude-code driver fails CLOSED on any non-default profile (it
//     cannot enforce narrowed tools).

import { describe, expect, test } from 'bun:test'
import {
  SYSTEM_READ_ONLY_TOOLS,
  buildControlledOpencodeConfig,
  type SystemReadOnlyTool,
} from '../src/services/runtime/opencode/hermetic'
import { claudeCodeDriver } from '../src/services/runtime/claudeCode/driver'
import {
  SYSTEM_PERMISSION_PROFILES,
  isSystemPermissionProfile,
} from '../src/services/runtime/types'

const baseInput = {
  name: 'aw-intent-builder',
  prompt: 'persona',
  description: 'agent-workflow verified system invocation',
  model: 'anthropic/claude-sonnet-5',
  options: {},
  userPermission: {},
  toolOutputPattern: '/private/store/xdg-data/opencode/tool-output/*',
  shellPath: '/bin/false',
  allowShell: false,
  mcp: {},
}

function agentPermission(config: Record<string, unknown>): Record<string, unknown> {
  const agents = config.agent as Record<string, { permission: Record<string, unknown> }>
  const entry = agents['aw-intent-builder']
  if (entry === undefined) throw new Error('agent entry missing')
  return entry.permission
}

describe('RFC-234 system permission profiles', () => {
  test('frozen enum shape', () => {
    expect(SYSTEM_PERMISSION_PROFILES).toEqual(['all-deny', 'intent-read-v1'])
    expect(isSystemPermissionProfile('all-deny')).toBe(true)
    expect(isSystemPermissionProfile('intent-read-v1')).toBe(true)
    expect(isSystemPermissionProfile('intent-write-v1')).toBe(false)
    expect(isSystemPermissionProfile(undefined)).toBe(false)
    expect(SYSTEM_READ_ONLY_TOOLS).toEqual(['read', 'grep', 'glob'])
  })

  test('default tail is byte-identical to the RFC-224 all-deny shape', () => {
    const permission = agentPermission(
      buildControlledOpencodeConfig(baseInput) as Record<string, unknown>,
    )
    expect(JSON.stringify(permission)).toBe(
      JSON.stringify({
        bash: 'deny',
        read: 'deny',
        edit: 'deny',
        write: 'deny',
        apply_patch: 'deny',
        grep: 'deny',
        glob: 'deny',
        skill: 'deny',
        task: 'deny',
        webfetch: 'deny',
        websearch: 'deny',
        lsp: 'deny',
        external_directory: {
          '/private/store/xdg-data/opencode/tool-output/*': 'deny',
          '*': 'deny',
        },
      }),
    )
  })

  test('intent-read-v1: same key order, only read/grep/glob flip to allow', () => {
    const denyTail = agentPermission(
      buildControlledOpencodeConfig(baseInput) as Record<string, unknown>,
    )
    const readTail = agentPermission(
      buildControlledOpencodeConfig({
        ...baseInput,
        allowedReadOnlyTools: SYSTEM_READ_ONLY_TOOLS,
      }) as Record<string, unknown>,
    )
    // Insertion order is load-bearing: the KEY SEQUENCE must be identical.
    expect(Object.keys(readTail)).toEqual(Object.keys(denyTail))
    expect(readTail.read).toBe('allow')
    expect(readTail.grep).toBe('allow')
    expect(readTail.glob).toBe('allow')
    // Everything that writes / spawns / reaches the network stays denied.
    expect(readTail.bash).toBe('deny')
    expect(readTail.edit).toBe('deny')
    expect(readTail.write).toBe('deny')
    expect(readTail.apply_patch).toBe('deny')
    expect(readTail.skill).toBe('deny')
    expect(readTail.task).toBe('deny')
    expect(readTail.webfetch).toBe('deny')
    expect(readTail.websearch).toBe('deny')
    expect(readTail.lsp).toBe('deny')
    expect(readTail.external_directory).toEqual({
      '/private/store/xdg-data/opencode/tool-output/*': 'deny',
      '*': 'deny',
    })
  })

  test('tools outside the closed read-only set are an identity failure', () => {
    for (const tool of ['write', 'edit', 'bash', 'webfetch', 'task']) {
      expect(() =>
        buildControlledOpencodeConfig({
          ...baseInput,
          allowedReadOnlyTools: [tool as SystemReadOnlyTool],
        }),
      ).toThrow()
    }
  })

  test('claude-code driver fails closed on UNDECLARED narrowed profiles', async () => {
    // RFC-237 flipped 'intent-read-v1' from rejected to materialized (the
    // declared-control branch — argv/env/seal locked in
    // rfc237-claude-intent-readonly-spawn.test.ts). The fail-closed contract
    // survives for anything the driver does NOT declare.
    const ctx = {
      agentName: 'aw-intent-builder',
      systemPrompt: 'p',
      prompt: 'u',
      worktreePath: '/tmp/wt',
      runDir: '/tmp/run',
      systemPermissionProfile: 'not-a-declared-profile' as never,
    }
    await expect(claudeCodeDriver.buildSpawn(ctx)).rejects.toThrow(
      /cannot enforce system permission profile 'not-a-declared-profile'/,
    )
    // And the declaration set is exactly the reviewed one — a driver-side
    // widening shows up here before any admission gate sees it.
    expect(claudeCodeDriver.narrowedSystemPermissionProfiles).toEqual(['intent-read-v1'])
  })
})
