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
  maskScriptEnvValues,
  maskWorkflowScriptEnv,
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
    // RFC-348 D2 — oauth is authorable now: only `clientSecret` is redacted, the
    // rest of the block (clientId / scope / redirectUri) survives so an update
    // can echo it back.
    expect(projected.config.oauth).toEqual({ clientSecret: INTENT_REDACTED })
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

// RFC-253 T28 — the `script-node-env` carrier: workflow definitions became
// credential-bearing the day script nodes landed. Locks all three faces:
// OUT (dump masking), IN (sentinel-or-empty), diagnostics (known-value scrub).
describe('RFC-253 T28 — script-node env carrier', () => {
  const definition = {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'in1', kind: 'input', inputKey: 'context' },
      {
        id: 's1',
        kind: 'script',
        language: 'python',
        script: 'print(1)',
        env: { API_TOKEN: SECRET, LOG_LEVEL: 'debug' },
      },
      { id: 'a1', kind: 'agent-single', agentId: 'A1', env: { NOT_A_SCRIPT: 'stays' } },
    ],
    edges: [],
  }

  test('maskWorkflowScriptEnv: values collapse, keys survive, other kinds untouched', () => {
    const out = maskWorkflowScriptEnv(definition) as typeof definition
    const script = out.nodes[1] as { env: Record<string, string> }
    expect(script.env).toEqual({ API_TOKEN: INTENT_REDACTED, LOG_LEVEL: INTENT_REDACTED })
    // Non-script nodes are NOT carriers — their fields ride verbatim.
    expect((out.nodes[2] as { env: Record<string, string> }).env).toEqual({
      NOT_A_SCRIPT: 'stays',
    })
    expect(out.nodes[0]).toBe(definition.nodes[0])
    expect(JSON.stringify(out)).not.toContain(SECRET)
    // Input untouched (pure).
    expect((definition.nodes[1] as { env: Record<string, string> }).env.API_TOKEN).toBe(SECRET)
  })

  test('maskWorkflowScriptEnv: custom marker serves the token read projection', () => {
    const out = maskWorkflowScriptEnv(definition, '***') as typeof definition
    expect((out.nodes[1] as { env: Record<string, string> }).env.API_TOKEN).toBe('***')
  })

  // `__proto__` is a legal environment variable name and survives JSON.parse as
  // an own property. Building the masked map by assignment would hit the legacy
  // prototype setter and DROP the key — invisible in the dump, and a silent
  // shape change on YAML export → import.
  test('maskWorkflowScriptEnv: a __proto__ env key survives masking', () => {
    const parsed = JSON.parse(
      '{"nodes":[{"kind":"script","env":{"__proto__":"ordinary-secret-42","NORMAL":"x"}}]}',
    ) as { nodes: Array<{ env: Record<string, string> }> }
    const out = maskWorkflowScriptEnv(parsed, '***') as typeof parsed
    expect(Object.keys(out.nodes[0]!.env)).toEqual(['__proto__', 'NORMAL'])
    expect(Object.values(out.nodes[0]!.env)).toEqual(['***', '***'])
    expect(JSON.stringify(out)).not.toContain('ordinary-secret-42')
  })

  test('maskWorkflowScriptEnv: same reference when nothing needs masking', () => {
    const noScript = { nodes: [{ id: 'x', kind: 'input', inputKey: 'k' }] }
    expect(maskWorkflowScriptEnv(noScript)).toBe(noScript)
    const noEnv = { nodes: [{ id: 's', kind: 'script', language: 'bash', script: 'true' }] }
    expect(maskWorkflowScriptEnv(noEnv)).toBe(noEnv)
    // Malformed shapes pass through instead of throwing.
    expect(maskWorkflowScriptEnv(null)).toBe(null)
    expect(maskWorkflowScriptEnv({ nodes: 'not-an-array' })).toEqual({ nodes: 'not-an-array' })
    const badEnv = { nodes: [{ kind: 'script', env: 'not-a-record' }] }
    expect(maskWorkflowScriptEnv(badEnv)).toBe(badEnv)
  })

  test('IN: literal script env values are refused, sentinel and empty pass', () => {
    const carriers = findNonSentinelSecretCarriers({
      resourceType: 'workflow',
      payload: {
        definition: {
          nodes: [
            { id: 'in1', kind: 'input', inputKey: 'context' },
            {
              id: 's1',
              kind: 'script',
              env: {
                LITERAL: 'hunter2-value',
                FILLED_LATER: INTENT_SECRET_SENTINEL,
                EMPTY_OK: '',
                'we/ird~key': 'x',
              },
            },
          ],
        },
      },
    })
    expect(carriers).toEqual([
      '/payload/definition/nodes/1/env/LITERAL',
      '/payload/definition/nodes/1/env/we~1ird~0key',
    ])
  })

  test('IN: a non-script node env is not a structural carrier', () => {
    expect(
      findNonSentinelSecretCarriers({
        resourceType: 'workflow',
        payload: {
          definition: { nodes: [{ id: 'a1', kind: 'agent-single', env: { PLAIN: 'value' } }] },
        },
      }),
    ).toEqual([])
  })

  test('maskScriptEnvValues: known values scrub out of diagnostics', () => {
    const env = { A: 'longer-secret-value', B: 'secret-value' }
    const masked = maskScriptEnvValues(`boom: longer-secret-value then secret-value`, env)
    expect(masked).not.toContain('longer-secret-value')
    expect(masked).not.toContain('secret-value')
    expect(masked).toContain(INTENT_REDACTED)
  })

  // EVERY non-empty env value is a carrier — the earlier draft skipped values
  // under six characters, and asserted the survivor, which locked a real hole
  // in: `DEPLOY_PIN=73921` passes every env validator.
  test('maskScriptEnvValues: a short value is masked where it stands alone', () => {
    expect(maskScriptEnvValues('fatal: 73921', { DEPLOY_PIN: '73921' })).toBe(
      `fatal: ${INTENT_REDACTED}`,
    )
  })

  // …but only as a token. Substring-replacing a one-character value would turn
  // the diagnostics into noise while hiding nothing the reader lacks.
  test('maskScriptEnvValues: a short value does not shred surrounding prose', () => {
    const masked = maskScriptEnvValues('attempt 10 of 3, code 1 here', { RETRY: '1' })
    expect(masked).toBe(`attempt 10 of 3, code ${INTENT_REDACTED} here`)
  })

  // Short values go through a RegExp, so a value carrying regex metacharacters
  // must be escaped — otherwise `1.5` would also collapse `125`.
  test('maskScriptEnvValues: regex metacharacters in a short value are literal', () => {
    expect(maskScriptEnvValues('code 125 seen', { RATE: '1.5' })).toBe('code 125 seen')
    expect(maskScriptEnvValues('rate 1.5 seen', { RATE: '1.5' })).toBe(
      `rate ${INTENT_REDACTED} seen`,
    )
  })

  // The ordering above is load-bearing but the assertions there do NOT pin it:
  // a shortest-first implementation leaves `longer-‹redacted›` and still
  // satisfies every `not.toContain` (it no longer contains the whole value).
  // This input distinguishes them — one value is a strict suffix of the other,
  // so a wrong order leaks the prefix of a real secret.
  test('maskScriptEnvValues: a value containing another collapses whole', () => {
    const masked = maskScriptEnvValues('AAAAAAsecret', { A: 'AAAAAAsecret', B: 'secret' })
    expect(masked).toBe(INTENT_REDACTED)
  })

  test('maskScriptEnvValues: no-op on empty env', () => {
    expect(maskScriptEnvValues('unchanged', {})).toBe('unchanged')
  })

  // A non-string env value still reaches storage: a stored definition parses
  // through the permissive WorkflowNodeSchema, not ScriptNodeSchema. The MCP
  // branch refuses non-strings, and this one claims to mirror it.
  test('IN: non-string env values are carriers too', () => {
    expect(
      findNonSentinelSecretCarriers({
        resourceType: 'workflow',
        payload: {
          definition: {
            nodes: [{ id: 's1', kind: 'script', env: { DB: ['postgres://u:p@h/db'], N: 12345 } }],
          },
        },
      }),
    ).toEqual(['/payload/definition/nodes/0/env/DB', '/payload/definition/nodes/0/env/N'])
  })
})
