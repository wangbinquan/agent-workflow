// RFC-234 §8 (T1) — locks the closed secret-slot projection and the credential
// scanner (Codex design-gate P0-2): argv, URL userinfo+query, plugin spec and
// option values are all covered; fixtures carry REAL-shaped secrets and the
// assertions prove zero leakage into any projected output.

import { describe, expect, test } from 'bun:test'
import {
  INTENT_REDACTED,
  INTENT_SECRET_SENTINEL,
  findNonSentinelSecretCarriers,
  looksHighEntropy,
  maskDiagnosticsText,
  maskFreeJsonSecrets,
  projectMcpForDump,
  projectPluginForDump,
  redactUrlForDump,
  scanForCredentialPatterns,
} from '../src/intentSecretSlots'
import {
  serializeMcpDump,
  serializePluginDump,
  serializeWorkgroupDump,
} from '../src/intent-dump-serialize'

const SECRET = 'sk-live-AAAABBBBCCCCDDDDEEEEFFFF11112222' // gitleaks:allow — deliberate fake credential fixture

describe('dump projections (OUT direction)', () => {
  test('mcp local: env values and argv[1:] fully redacted, argv[0] kept', () => {
    const dump = serializeMcpDump({
      handle: 'res#mcp#1',
      type: 'local',
      name: 'gh',
      description: 'github mcp',
      enabled: true,
      config: {
        command: ['npx', '-y', '@modelcontextprotocol/server-github', `--token=${SECRET}`],
        env: { GITHUB_TOKEN: SECRET, HOME: '/Users/someone' },
        timeoutMs: 30000,
      },
    })
    expect(dump).not.toContain(SECRET)
    expect(dump).not.toContain('/Users/someone')
    expect(dump).toContain('npx')
    expect(dump).toContain('GITHUB_TOKEN')
    expect(dump).toContain('timeoutMs: 30000')
  })

  test('mcp remote: url userinfo+query stripped, header values redacted', () => {
    const projected = projectMcpForDump({
      type: 'remote',
      name: 'r',
      description: '',
      enabled: true,
      config: {
        url: `https://user:${SECRET}@mcp.example.com/v1?access_token=${SECRET}`,
        headers: { Authorization: `Bearer ${SECRET}` },
        oauth: { clientSecret: SECRET },
      },
    })
    const text = JSON.stringify(projected)
    expect(text).not.toContain(SECRET)
    expect(text).toContain('mcp.example.com')
    expect(projected.config.oauth).toBe(INTENT_REDACTED)
  })

  test('plugin: spec token via git-url redactor, every option string masked', () => {
    const dump = serializePluginDump({
      handle: 'res#plugin#1',
      name: 'p',
      spec: `https://oauth2:${SECRET}@gitlab.example.com/g/p.git`,
      description: '',
      enabled: true,
      options: { endpoint: 'https://x.example.com', innocuousName: SECRET },
    })
    expect(dump).not.toContain(SECRET)
    expect(dump).toContain('gitlab.example.com')
  })

  test('workgroup dump: identity whitelist — user ids/usernames cannot leak', () => {
    // Fixture deliberately carries identity fields the serializer must drop by
    // construction (whitelist, not blocklist).
    const poisoned = {
      handle: 'res#workgroup#1',
      name: 'squad',
      description: '',
      instructions: 'do the thing',
      mode: 'leader_worker',
      leaderDisplayName: 'lead',
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 20,
      completionGate: true,
      members: [
        {
          memberType: 'agent' as const,
          agentHandle: 'res#agent#2',
          displayName: 'lead',
          roleDesc: 'leads',
          // identity poison (present on runtime rows, must never serialize):
          userId: 'user_01HXXXXXXXXXXXXXXXXXXXXX',
          agentId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          agentName: 'real-agent-name',
          ownerUserId: 'user_01HYYYYYYYYYYYYYYYYYYYYY',
        } as never,
        {
          memberType: 'human' as const,
          displayName: 'approver',
          roleDesc: 'approves',
          userId: 'user_01HZZZZZZZZZZZZZZZZZZZZZ',
        } as never,
      ],
    }
    const dump = serializeWorkgroupDump(poisoned)
    expect(dump).not.toContain('user_01H')
    expect(dump).not.toContain('01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(dump).not.toContain('real-agent-name')
    expect(dump).not.toContain('ownerUserId')
    expect(dump).toContain('res#agent#2')
    expect(dump).toContain('approver')
  })

  test('redactUrlForDump keeps endpoint shape, maskFreeJsonSecrets hits nested keys', () => {
    expect(redactUrlForDump('https://api.example.com/v1/path')).toBe(
      'https://api.example.com/v1/path',
    )
    const masked = maskFreeJsonSecrets({
      apiToken: SECRET,
      nested: { authHeader: SECRET, plain: 'keep-me' },
      list: [{ password: SECRET }],
    })
    const text = JSON.stringify(masked)
    expect(text).not.toContain(SECRET)
    expect(text).toContain('keep-me')
  })
})

describe('credential scanner (IN direction)', () => {
  test('flags url userinfo, query creds, flag creds and high-entropy strings', () => {
    const findings = scanForCredentialPatterns({
      a: `https://u:${SECRET}@host.com/x`,
      b: `https://host.com/cb?access_token=${SECRET}`,
      c: `run --token=${SECRET}`,
      d: SECRET,
      ok: 'a perfectly normal sentence about workflows',
      handle: 'res#agent#12',
    })
    const kinds = findings.map((f) => f.kind).sort()
    expect(kinds).toEqual([
      'flag-credential',
      'high-entropy',
      'url-query-credential',
      'url-userinfo',
    ])
    for (const f of findings) {
      expect(f.excerpt).not.toContain(SECRET)
    }
  })

  test('sentinel and redaction markers never match; pointers are precise', () => {
    expect(scanForCredentialPatterns({ env: { X: INTENT_SECRET_SENTINEL } })).toEqual([])
    expect(scanForCredentialPatterns({ env: { X: INTENT_REDACTED } })).toEqual([])
    const [finding] = scanForCredentialPatterns({ 'a/b': { c: SECRET } })
    expect(finding?.jsonPointer).toBe('/a~1b/c')
  })

  test('looksHighEntropy is conservative', () => {
    expect(looksHighEntropy('short')).toBe(false)
    expect(looksHighEntropy('this-is-a-long-kebab-case-resource-name-not-a-secret')).toBe(false)
    expect(looksHighEntropy(SECRET)).toBe(true)
  })

  test('findNonSentinelSecretCarriers: mcp env/headers must be sentinel-or-empty', () => {
    expect(
      findNonSentinelSecretCarriers({
        resourceType: 'mcp',
        payload: {
          type: 'local',
          config: { command: ['npx'], env: { A: INTENT_SECRET_SENTINEL, B: 'plaintext' } },
        },
      }),
    ).toEqual(['/payload/config/env/B'])
    expect(
      findNonSentinelSecretCarriers({
        resourceType: 'mcp',
        payload: { type: 'remote', config: { url: 'https://x', headers: { A: '' } } },
      }),
    ).toEqual([])
  })

  // Codex impl-gate P1-2 — the IN direction must cover the same closed set the
  // OUT projection redacts: argv credential flags / URL userinfo, plugin
  // options and free-JSON secret-named keys, and it must refuse redaction
  // markers being echoed back as real config.
  test('IN carriers cover argv, url userinfo, secret-named keys and refuse markers', () => {
    const argv = findNonSentinelSecretCarriers({
      resourceType: 'mcp',
      payload: {
        type: 'local',
        name: 'gh',
        config: { command: ['npx', '--token=hunter2', 'https://u:p@host/x'] },
      },
    })
    expect(argv).toContain('/payload/config/command/1')
    expect(argv).toContain('/payload/config/command/2')

    const url = findNonSentinelSecretCarriers({
      resourceType: 'mcp',
      payload: { type: 'remote', name: 'r', config: { url: 'https://user:pw@api.example.com/v1' } },
    })
    expect(url).toContain('/payload/config/url')

    // Plugin options + agent frontmatterExtra: secret-named keys anywhere.
    const plugin = findNonSentinelSecretCarriers({
      resourceType: 'plugin',
      payload: { name: 'p', spec: 'npm:x', options: { apiKey: 'hunter2' } },
    })
    expect(plugin).toContain('/payload/options/apiKey')
    const agent = findNonSentinelSecretCarriers({
      resourceType: 'agent',
      payload: { name: 'a', frontmatterExtra: { nested: { authToken: 'hunter2' } } },
    })
    expect(agent).toContain('/payload/frontmatterExtra/nested/authToken')

    // Sentinel and empty pass; a redaction marker echoed back is refused.
    expect(
      findNonSentinelSecretCarriers({
        resourceType: 'mcp',
        payload: {
          type: 'local',
          name: 'ok',
          config: { command: ['npx'], env: { TOKEN: INTENT_SECRET_SENTINEL, EMPTY: '' } },
        },
      }),
    ).toEqual([])
    expect(
      findNonSentinelSecretCarriers({
        resourceType: 'agent',
        payload: { name: 'a', bodyMd: `see ${INTENT_REDACTED}-arg-1` },
      }),
    ).toContain('/payload/bodyMd')
  })

  test('workflow routing key fields are public identifiers, not secret carriers', () => {
    const findings = findNonSentinelSecretCarriers({
      resourceType: 'workflow',
      payload: {
        name: 'flow',
        definition: {
          inputs: [
            { kind: 'text', key: 'goal', label: 'Goal' },
            { kind: 'text', key: 'context', label: 'Context' },
          ],
          nodes: [
            { id: 'goal', kind: 'input', inputKey: 'goal' },
            {
              id: 'context',
              kind: 'input',
              inputKey: 'context',
              privateKey: 'must-still-be-rejected',
            },
          ],
        },
      },
    })
    expect(findings).toEqual(['/payload/definition/nodes/1/privateKey'])

    expect(
      findNonSentinelSecretCarriers({
        resourceType: 'workflow',
        payload: {
          definition: {
            inputs: [{ key: INTENT_REDACTED }],
            nodes: [{ inputKey: INTENT_REDACTED }],
          },
        },
      }),
    ).toEqual(['/payload/definition/inputs/0/key', '/payload/definition/nodes/0/inputKey'])
  })

  test('maskDiagnosticsText scrubs stderr-style leaks', () => {
    const masked = maskDiagnosticsText(
      `fetch failed for https://u:${SECRET}@h.com/x?access_token=${SECRET} while running --token=${SECRET}`,
    )
    expect(masked).not.toContain(SECRET)
  })
})
