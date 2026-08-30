// RFC-348 — intent changeset additions driven by the capability-teaching audit:
//   - agent `branchPorts` (RFC-306) joins IntentAgentPayloadSchema (D5); before
//     this the strict payload rejected it, so the intent builder could not
//     author conditional branches at all;
//   - remote MCP `oauth` becomes authorable (user decision ②, D2): same keys as
//     the platform McpOAuthConfigSchema, `false` disables, and `clientSecret`
//     is a secret carrier — literal values are flagged exactly like env/header
//     values, the confirm-time slot supplies the real secret;
//   - the dump projection keeps `oauth` readable (only `clientSecret` is
//     redacted) instead of collapsing the whole block to ‹redacted›.
import { describe, expect, test } from 'bun:test'
import {
  INTENT_REDACTED,
  INTENT_SECRET_SENTINEL,
  IntentAgentPayloadSchema,
  IntentMcpPayloadSchema,
  findNonSentinelSecretCarriers,
  projectMcpForDump,
} from '../src'

const agentBase = {
  name: 'auditor',
  description: 'audits diffs',
  outputs: ['findings'],
  bodyMd: '# role',
}
const remoteBase = {
  type: 'remote' as const,
  name: 'docs-mcp',
  description: 'remote docs',
  config: {
    url: 'https://mcp.example.test/sse',
    headers: { Authorization: INTENT_SECRET_SENTINEL },
  },
}

describe('RFC-348 agent branchPorts', () => {
  test('accepts branchPorts as a string array', () => {
    const parsed = IntentAgentPayloadSchema.safeParse({ ...agentBase, branchPorts: ['findings'] })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.branchPorts).toEqual(['findings'])
  })

  test('still rejects unknown top-level keys (strict payload)', () => {
    expect(IntentAgentPayloadSchema.safeParse({ ...agentBase, systemPrompt: 'x' }).success).toBe(
      false,
    )
  })
})

describe('RFC-348 remote MCP oauth', () => {
  test('accepts an explicit client with the secret sentinel, and `false`', () => {
    const explicit = IntentMcpPayloadSchema.safeParse({
      ...remoteBase,
      config: {
        ...remoteBase.config,
        oauth: { clientId: 'cid', clientSecret: INTENT_SECRET_SENTINEL, scope: 'read' },
      },
    })
    expect(explicit.success).toBe(true)
    const disabled = IntentMcpPayloadSchema.safeParse({
      ...remoteBase,
      config: { ...remoteBase.config, oauth: false },
    })
    expect(disabled.success).toBe(true)
  })

  test('rejects unknown oauth keys and oauth on a local server', () => {
    expect(
      IntentMcpPayloadSchema.safeParse({
        ...remoteBase,
        config: { ...remoteBase.config, oauth: { clientId: 'cid', tokenUrl: 'https://x' } },
      }).success,
    ).toBe(false)
    expect(
      IntentMcpPayloadSchema.safeParse({
        type: 'local',
        name: 'local-mcp',
        description: 'd',
        config: { command: ['node', 'server.js'], oauth: false },
      }).success,
    ).toBe(false)
  })

  test('a literal clientSecret is a non-sentinel secret carrier; sentinel and empty are not', () => {
    const literal = findNonSentinelSecretCarriers({
      resourceType: 'mcp',
      payload: {
        ...remoteBase,
        config: { ...remoteBase.config, oauth: { clientSecret: 'hunter2' } },
      },
    })
    expect(literal).toContain('/payload/config/oauth/clientSecret')
    for (const value of [INTENT_SECRET_SENTINEL, '']) {
      const ok = findNonSentinelSecretCarriers({
        resourceType: 'mcp',
        payload: {
          ...remoteBase,
          config: { ...remoteBase.config, oauth: { clientSecret: value } },
        },
      })
      expect(ok).not.toContain('/payload/config/oauth/clientSecret')
    }
    const disabled = findNonSentinelSecretCarriers({
      resourceType: 'mcp',
      payload: { ...remoteBase, config: { ...remoteBase.config, oauth: false } },
    })
    expect(disabled).not.toContain('/payload/config/oauth/clientSecret')
  })

  test('dump projection keeps oauth readable and redacts only clientSecret', () => {
    const projected = projectMcpForDump({
      type: 'remote',
      name: 'docs-mcp',
      description: 'remote docs',
      enabled: true,
      config: {
        url: 'https://mcp.example.test/sse',
        oauth: {
          clientId: 'cid',
          clientSecret: 'stored-secret',
          scope: 'read',
          redirectUri: 'https://app/cb',
        },
      },
    }) as { config: { oauth?: unknown } }
    expect(projected.config.oauth).toEqual({
      clientId: 'cid',
      clientSecret: INTENT_REDACTED,
      scope: 'read',
      redirectUri: 'https://app/cb',
    })
    const disabled = projectMcpForDump({
      type: 'remote',
      name: 'docs-mcp',
      description: 'remote docs',
      enabled: true,
      config: { url: 'https://mcp.example.test/sse', oauth: false },
    }) as { config: { oauth?: unknown } }
    expect(disabled.config.oauth).toBe(false)
    const absent = projectMcpForDump({
      type: 'remote',
      name: 'docs-mcp',
      description: 'remote docs',
      enabled: true,
      config: { url: 'https://mcp.example.test/sse' },
    }) as { config: { oauth?: unknown } }
    expect(absent.config.oauth).toBeUndefined()
  })
})
