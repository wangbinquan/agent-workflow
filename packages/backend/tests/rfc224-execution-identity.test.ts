// RFC-224 regression lock: opencode's final /config and /agent responses are
// treated as hostile JSON. Every comparison failure must identify only a JSON
// Pointer, never the prompt/MCP/provider secret which differed.

import { describe, expect, test } from 'bun:test'
import {
  businessOpencodeIdentityDigest,
  canonicalizeIdentity,
  ExecutionIdentityError,
  firstIdentityDifference,
  identityDigest,
  verifyExecutionIdentity,
  type VerifyExecutionIdentityInput,
} from '@/services/runtime/opencode/executionIdentity'

type JsonObject = Record<string, unknown>

function clone<T>(value: T): T {
  return structuredClone(value)
}

function controlledAgent(infos: unknown[]): JsonObject {
  const info = infos.find(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as JsonObject).name === 'worker',
  )
  if (info === undefined) throw new Error('fixture has no worker')
  return info as JsonObject
}

function makeInput(): VerifyExecutionIdentityInput & {
  expectedInlineConfig: JsonObject
  effectiveConfig: JsonObject
  agents: JsonObject[]
} {
  const permission = {
    '*': 'allow',
    question: 'deny',
  }
  const agentPermission = {
    edit: 'deny',
    bash: {
      'git *': 'allow',
      'rm *': 'deny',
    },
    read: 'deny',
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
      '/private/xdg/opencode/tool-output/*': 'deny',
      '*': 'deny',
    },
  }
  const agentEntry = {
    prompt: 'private prompt',
    description: 'implementation worker',
    permission: agentPermission,
    options: { outputs: ['result'], nested: { stable: true } },
    model: 'openai/gpt-5.6',
    variant: 'high',
    temperature: 0.25,
    top_p: 0.9,
    color: '#123ABC',
    steps: 17,
    mode: 'primary',
    hidden: false,
  }
  const mcp = {
    local_tools: {
      type: 'local',
      enabled: true,
      command: ['bun', 'tool.ts'],
      environment: { API_TOKEN: 'mcp-local-secret' },
      timeout: 4_000,
    },
    remote_docs: {
      type: 'remote',
      enabled: true,
      url: 'https://mcp.example.test',
      headers: { Authorization: 'Bearer mcp-remote-secret' },
      oauth: {
        clientId: 'client',
        clientSecret: 'oauth-secret',
        scope: 'read',
      },
      timeout: 5_000,
    },
  }
  const expectedInlineConfig = {
    share: 'disabled',
    autoupdate: false,
    snapshot: false,
    formatter: false,
    lsp: false,
    compaction: { auto: false },
    shell: '/private/seal/sh',
    instructions: [],
    skills: { paths: [], urls: [] },
    agent: { worker: agentEntry },
    permission,
    mcp,
    plugin: [],
  }
  const effectiveConfig = clone(expectedInlineConfig)
  const worker = {
    name: 'worker',
    description: agentEntry.description,
    mode: agentEntry.mode,
    native: false,
    hidden: agentEntry.hidden,
    topP: agentEntry.top_p,
    temperature: agentEntry.temperature,
    color: agentEntry.color,
    permission: [
      { permission: 'read', pattern: '*', action: 'allow' },
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'question', pattern: '*', action: 'deny' },
      { permission: 'edit', pattern: '*', action: 'deny' },
      { permission: 'bash', pattern: 'git *', action: 'allow' },
      { permission: 'bash', pattern: 'rm *', action: 'deny' },
      { permission: 'read', pattern: '*', action: 'deny' },
      { permission: 'write', pattern: '*', action: 'deny' },
      { permission: 'apply_patch', pattern: '*', action: 'deny' },
      { permission: 'grep', pattern: '*', action: 'deny' },
      { permission: 'glob', pattern: '*', action: 'deny' },
      { permission: 'skill', pattern: '*', action: 'deny' },
      { permission: 'task', pattern: '*', action: 'deny' },
      { permission: 'webfetch', pattern: '*', action: 'deny' },
      { permission: 'websearch', pattern: '*', action: 'deny' },
      { permission: 'lsp', pattern: '*', action: 'deny' },
      {
        permission: 'external_directory',
        pattern: '/private/xdg/opencode/tool-output/*',
        action: 'deny',
      },
      {
        permission: 'external_directory',
        pattern: '*',
        action: 'deny',
      },
    ],
    model: { providerID: 'openai', modelID: 'gpt-5.6' },
    variant: agentEntry.variant,
    prompt: agentEntry.prompt,
    options: agentEntry.options,
    steps: agentEntry.steps,
  }
  const agents = [
    {
      name: 'build',
      description: 'native',
      mode: 'primary',
      native: true,
      permission: [],
      options: {},
    },
    worker,
  ]
  return {
    expectedInlineConfig,
    effectiveConfig,
    agents,
    selectedAgentName: 'worker',
  }
}

function identityError(fn: () => unknown): ExecutionIdentityError {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionIdentityError)
    return error as ExecutionIdentityError
  }
  throw new Error('expected ExecutionIdentityError')
}

describe('RFC-224 canonical identity JSON', () => {
  test('sorts object keys by Unicode code point and retains array order', () => {
    const astral = '\u{10000}'
    const privateUse = '\uE000'
    expect(canonicalizeIdentity({ [astral]: 1, [privateUse]: 2, a: [3, 2, 1] })).toBe(
      `{"a":[3,2,1],"${privateUse}":2,"${astral}":1}`,
    )
    expect(canonicalizeIdentity([2, 1])).not.toBe(canonicalizeIdentity([1, 2]))
  })

  test('object insertion order is semantic-free for canonical bytes and digest', () => {
    const first = { outer: { z: 1, a: 2 }, list: [{ b: true, a: false }] }
    const second = { list: [{ a: false, b: true }], outer: { a: 2, z: 1 } }
    expect(canonicalizeIdentity(first)).toBe(canonicalizeIdentity(second))
    expect(identityDigest(first)).toBe(identityDigest(second))
  })

  test('does not trim strings or normalize prompt line endings', () => {
    const prompt = '  keep leading space\r\nand CRLF\n'
    expect(canonicalizeIdentity(prompt)).toBe(JSON.stringify(prompt))
    expect(identityDigest(prompt)).not.toBe(identityDigest(prompt.trim().replaceAll('\r\n', '\n')))
  })

  test('first difference is a JSON Pointer and escapes its segments', () => {
    expect(firstIdentityDifference({ 'a/b~c': { x: 1 } }, { 'a/b~c': { x: 2 } })).toBe('/a~1b~0c/x')
    expect(firstIdentityDifference([1, 2], [1, 3])).toBe('/1')
    expect(firstIdentityDifference({ a: 1 }, { a: 1 })).toBeNull()
  })

  const invalidValues: Array<[string, () => unknown, string]> = [
    ['undefined', () => ({ value: undefined }), '/value'],
    ['NaN', () => ({ value: Number.NaN }), '/value'],
    ['Infinity', () => [Number.POSITIVE_INFINITY], '/0'],
    ['bigint', () => 1n, ''],
    ['function', () => ({ fn: () => undefined }), '/fn'],
    ['date instance', () => new Date(0), ''],
    [
      'sparse array',
      () => {
        const sparse = new Array(2)
        sparse[1] = 'present'
        return sparse
      },
      '/0',
    ],
    [
      'array extra property',
      () => {
        const array = [1] as number[] & { extra?: number }
        array.extra = 2
        return array
      },
      '',
    ],
    [
      'accessor',
      () => {
        const value: JsonObject = {}
        Object.defineProperty(value, 'secret', {
          enumerable: true,
          get: () => 'must-not-run',
        })
        return value
      },
      '/secret',
    ],
    [
      'symbol key',
      () => {
        const value: JsonObject = {}
        Object.defineProperty(value, Symbol('hidden'), {
          enumerable: true,
          value: 1,
        })
        return value
      },
      '',
    ],
  ]

  test.each(invalidValues)('rejects non-JSON value: %s', (_name, make, expectedPath) => {
    const error = identityError(() => canonicalizeIdentity(make()))
    expect(error.code).toBe('execution-identity-mismatch')
    expect(error.path).toBe(expectedPath)
  })

  test.each(['__proto__', 'prototype', 'constructor'])(
    'rejects prototype-poisoning key %s',
    (key) => {
      const value = JSON.parse(`{"safe":{"${key}":"do-not-log"}}`)
      const error = identityError(() => canonicalizeIdentity(value))
      expect(error.path).toBe(`/safe/${key}`)
      expect(error.message).not.toContain('do-not-log')
    },
  )

  test('accepts a null-prototype plain JSON record', () => {
    const value = Object.create(null) as Record<string, number>
    value.b = 2
    value.a = 1
    expect(canonicalizeIdentity(value)).toBe('{"a":1,"b":2}')
  })
})

describe('RFC-224 stable business owner identity', () => {
  const model = { providerID: 'openai', modelID: 'gpt-5.6' }
  const build = 'a'.repeat(64)
  const wrapperDigest = 'b'.repeat(64)

  function config(sealRoot: string, digest = wrapperDigest): JsonObject {
    return {
      shell: `${sealRoot}/shell/sh`,
      mcp: {
        tools: {
          type: 'local',
          enabled: true,
          command: [`${sealRoot}/mcp/${digest}/run`],
          timeout: 4_000,
        },
      },
      agent: { worker: { permission: { bash: 'allow' } } },
    }
  }

  test('normalizes only attempt-local seal roots while retaining the MCP semantic digest', () => {
    const first = businessOpencodeIdentityDigest({
      config: config('/private/app/runs/task/run-1/opencode-identity-seal'),
      agent: 'worker',
      model,
      binaryDigest: build,
      sealRoot: '/private/app/runs/task/run-1/opencode-identity-seal',
    })
    const resumed = businessOpencodeIdentityDigest({
      config: config('/private/app/runs/task/run-2/opencode-identity-seal'),
      agent: 'worker',
      model,
      binaryDigest: build,
      sealRoot: '/private/app/runs/task/run-2/opencode-identity-seal',
    })
    const changedMcp = businessOpencodeIdentityDigest({
      config: config('/private/app/runs/task/run-2/opencode-identity-seal', 'c'.repeat(64)),
      agent: 'worker',
      model,
      binaryDigest: build,
      sealRoot: '/private/app/runs/task/run-2/opencode-identity-seal',
    })
    expect(resumed).toBe(first)
    expect(changedMcp).not.toBe(first)
  })

  test('rejects an unsealed shell or malformed local-MCP wrapper path', () => {
    const sealRoot = '/private/app/runs/task/run-1/opencode-identity-seal'
    const unsealedShell = config(sealRoot)
    unsealedShell.shell = '/tmp/sh'
    expect(() =>
      businessOpencodeIdentityDigest({
        config: unsealedShell,
        agent: 'worker',
        model,
        binaryDigest: build,
        sealRoot,
      }),
    ).toThrow()

    const malformedMcp = config(sealRoot)
    ;((malformedMcp.mcp as JsonObject).tools as JsonObject).command = [
      `${sealRoot}/mcp/name-only/run`,
    ]
    expect(() =>
      businessOpencodeIdentityDigest({
        config: malformedMcp,
        agent: 'worker',
        model,
        binaryDigest: build,
        sealRoot,
      }),
    ).toThrow()
  })
})

describe('RFC-224 final config identity', () => {
  test('accepts exact controlled config and returns deterministic non-secret digests', () => {
    const input = makeInput()
    const first = verifyExecutionIdentity(input)
    const second = verifyExecutionIdentity(clone(input))
    expect(first).toEqual(second)
    expect(first.controlledAgentNames).toEqual(['worker'])
    expect(first.configDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(first.agentInfoSeal).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(first)).not.toContain('secret')
  })

  test.each([
    ['share', 'manual'],
    ['autoupdate', true],
    ['snapshot', true],
    ['formatter', {}],
    ['lsp', {}],
    ['compaction', { auto: true }],
    ['shell', '/tmp/unsealed-sh'],
    ['instructions', ['repo/AGENTS.md']],
    ['skills', { paths: ['/repo/skills'], urls: [] }],
  ])('rejects top-level security mutation: %s', (field, value) => {
    const input = makeInput()
    input.effectiveConfig[field] = value
    expect(identityError(() => verifyExecutionIdentity(input)).path).toStartWith(`/config/${field}`)
  })

  test('allows only exact pinned harmless defaults and rejects unknown top-level config', () => {
    const input = makeInput()
    input.effectiveConfig.command = {}
    input.effectiveConfig.mode = {}
    input.effectiveConfig.username = 'unknown'
    expect(() => verifyExecutionIdentity(input)).not.toThrow()

    const command = makeInput()
    command.effectiveConfig.command = { build: { command: ['evil'] } }
    expect(identityError(() => verifyExecutionIdentity(command)).path).toBe('/config/command/build')

    const unknown = makeInput()
    unknown.effectiveConfig.experimental = { override: true }
    expect(identityError(() => verifyExecutionIdentity(unknown)).path).toBe('/config/experimental')
  })

  test('does not treat /config object key order as permission semantics', () => {
    const input = makeInput()
    input.effectiveConfig.permission = {
      question: 'deny',
      '*': 'allow',
    }
    const effectiveAgent = (input.effectiveConfig.agent as JsonObject).worker as JsonObject
    effectiveAgent.permission = Object.fromEntries(
      Object.entries(effectiveAgent.permission as JsonObject).reverse(),
    )
    expect(() => verifyExecutionIdentity(input)).not.toThrow()
  })

  test('still rejects missing, extra, or changed global permission values', () => {
    const changed = makeInput()
    changed.effectiveConfig.permission = { '*': 'deny', question: 'deny' }
    expect(identityError(() => verifyExecutionIdentity(changed)).path).toBe('/config/permission/*')

    const missing = makeInput()
    missing.effectiveConfig.permission = { '*': 'allow' }
    expect(identityError(() => verifyExecutionIdentity(missing)).path).toBe(
      '/config/permission/question',
    )

    const extra = makeInput()
    extra.effectiveConfig.permission = {
      '*': 'allow',
      question: 'deny',
      bash: 'allow',
    }
    expect(identityError(() => verifyExecutionIdentity(extra)).path).toBe('/config/permission/bash')
  })

  const rawAgentMutations: Array<[string, (entry: JsonObject) => void, string]> = [
    ['prompt', (entry) => (entry.prompt = 'changed'), '/config/agent/worker/prompt'],
    ['description', (entry) => (entry.description = 'changed'), '/config/agent/worker/description'],
    ['model', (entry) => (entry.model = 'other/model'), '/config/agent/worker/model'],
    ['variant', (entry) => (entry.variant = 'low'), '/config/agent/worker/variant'],
    ['temperature', (entry) => (entry.temperature = 0.75), '/config/agent/worker/temperature'],
    ['top_p', (entry) => (entry.top_p = 0.1), '/config/agent/worker/top_p'],
    ['color', (entry) => (entry.color = '#FFFFFF'), '/config/agent/worker/color'],
    [
      'options',
      (entry) => (entry.options = { outputs: ['other'] }),
      '/config/agent/worker/options/nested',
    ],
    ['steps', (entry) => (entry.steps = 99), '/config/agent/worker/steps'],
    ['mode', (entry) => (entry.mode = 'subagent'), '/config/agent/worker/mode'],
    ['hidden', (entry) => (entry.hidden = true), '/config/agent/worker/hidden'],
    [
      'permission',
      (entry) => (entry.permission = { edit: 'allow' }),
      '/config/agent/worker/permission/apply_patch',
    ],
    ['disable', (entry) => (entry.disable = true), '/config/agent/worker/disable'],
    ['unknown field', (entry) => (entry.unknown = 'override'), '/config/agent/worker/unknown'],
  ]

  test.each(rawAgentMutations)(
    'rejects effective raw agent mutation: %s',
    (_name, mutate, expectedPath) => {
      const input = makeInput()
      const entry = ((input.effectiveConfig.agent as JsonObject).worker ?? {}) as JsonObject
      mutate(entry)
      const error = identityError(() => verifyExecutionIdentity(input))
      expect(error.path).toBe(expectedPath)
    },
  )

  test('accepts the version-fixed maxSteps -> steps and tools -> permission normalization', () => {
    const input = makeInput()
    const expectedEntry = (input.expectedInlineConfig.agent as JsonObject).worker as JsonObject
    const effectiveEntry = (input.effectiveConfig.agent as JsonObject).worker as JsonObject
    delete expectedEntry.steps
    expectedEntry.maxSteps = 17
    delete effectiveEntry.steps
    effectiveEntry.maxSteps = 17
    effectiveEntry.steps = 17

    expectedEntry.tools = { write: false, grep: true }
    effectiveEntry.tools = { write: false, grep: true }
    effectiveEntry.permission = {
      edit: 'deny',
      grep: 'allow',
      ...(effectiveEntry.permission as JsonObject),
    }
    const effectiveAgent = controlledAgent(input.agents)
    const rules = effectiveAgent.permission as JsonObject[]
    const grepRuleIndex = rules.findIndex(
      (rule) => rule.permission === 'grep' && rule.pattern === '*',
    )
    const grepRule = rules.splice(grepRuleIndex, 1)[0]!
    rules.splice(4, 0, grepRule)
    expect(() => verifyExecutionIdentity(input)).not.toThrow()
  })

  test('rejects missing and extra configured non-native agents', () => {
    const missing = makeInput()
    delete (missing.effectiveConfig.agent as JsonObject).worker
    expect(identityError(() => verifyExecutionIdentity(missing)).path).toBe('/config/agent/worker')

    const extra = makeInput()
    ;(extra.effectiveConfig.agent as JsonObject).rogue = {
      prompt: 'rogue',
      permission: {},
      options: {},
    }
    expect(identityError(() => verifyExecutionIdentity(extra)).path).toBe('/config/agent/rogue')
  })

  test('allows native config keys but never a controlled native registry name', () => {
    const input = makeInput()
    ;(input.effectiveConfig.agent as JsonObject).plan = { mode: 'primary' }
    expect(() => verifyExecutionIdentity(input)).not.toThrow()

    const reserved = makeInput()
    ;(reserved.expectedInlineConfig.agent as JsonObject).build = (
      reserved.expectedInlineConfig.agent as JsonObject
    ).worker
    expect(identityError(() => verifyExecutionIdentity(reserved)).path).toBe('/config/agent/build')
  })

  const mcpMutations: Array<[string, (mcp: JsonObject) => void]> = [
    ['local type', (mcp) => ((mcp.local_tools as JsonObject).type = 'remote')],
    [
      'local command order',
      (mcp) => ((mcp.local_tools as JsonObject).command = ['tool.ts', 'bun']),
    ],
    [
      'local environment',
      (mcp) => (((mcp.local_tools as JsonObject).environment as JsonObject).API_TOKEN = 'changed'),
    ],
    ['local timeout', (mcp) => ((mcp.local_tools as JsonObject).timeout = 1)],
    ['local enabled', (mcp) => ((mcp.local_tools as JsonObject).enabled = false)],
    ['remote url', (mcp) => ((mcp.remote_docs as JsonObject).url = 'https://evil.test')],
    [
      'remote header',
      (mcp) => (((mcp.remote_docs as JsonObject).headers as JsonObject).Authorization = 'changed'),
    ],
    [
      'remote oauth',
      (mcp) => (((mcp.remote_docs as JsonObject).oauth as JsonObject).clientId = 'changed'),
    ],
    ['remote timeout', (mcp) => ((mcp.remote_docs as JsonObject).timeout = 1)],
    ['remote enabled', (mcp) => ((mcp.remote_docs as JsonObject).enabled = false)],
    ['unknown field', (mcp) => ((mcp.remote_docs as JsonObject).unknown = true)],
  ]

  test.each(mcpMutations)('rejects complete MCP mutation: %s', (_name, mutate) => {
    const input = makeInput()
    mutate(input.effectiveConfig.mcp as JsonObject)
    const error = identityError(() => verifyExecutionIdentity(input))
    expect(error.path.startsWith('/config/mcp/')).toBe(true)
  })

  test('rejects missing and extra MCP entries, including disabled external entries', () => {
    const missing = makeInput()
    delete (missing.effectiveConfig.mcp as JsonObject).local_tools
    expect(identityError(() => verifyExecutionIdentity(missing)).path).toBe(
      '/config/mcp/local_tools',
    )

    const extra = makeInput()
    ;(extra.effectiveConfig.mcp as JsonObject).external = { enabled: false }
    expect(identityError(() => verifyExecutionIdentity(extra)).path).toBe('/config/mcp/external')
  })

  test('requires both expected and effective plugin lists to be empty', () => {
    const external = makeInput()
    external.effectiveConfig.plugin = ['file:///repo/.opencode/plugin.js']
    expect(identityError(() => verifyExecutionIdentity(external)).path).toBe('/config/plugin/0')

    const injected = makeInput()
    injected.expectedInlineConfig.plugin = ['file:///managed/plugin.js']
    expect(identityError(() => verifyExecutionIdentity(injected)).path).toBe('/config/plugin/0')
  })
})

describe('RFC-224 Agent.Info mapping and same-instance seal', () => {
  const infoMutations: Array<[string, (info: JsonObject) => void, string]> = [
    ['name', (info) => (info.name = 'renamed'), '/agent/renamed'],
    ['native', (info) => (info.native = true), '/agent/worker/native'],
    ['subagent', (info) => (info.mode = 'subagent'), '/agent/worker/mode'],
    ['hidden', (info) => (info.hidden = true), '/agent/worker/hidden'],
    ['prompt', (info) => (info.prompt = 'changed'), '/agent/worker/prompt'],
    ['description', (info) => (info.description = 'changed'), '/agent/worker/description'],
    [
      'model provider',
      (info) => ((info.model as JsonObject).providerID = 'other'),
      '/agent/worker/model/providerID',
    ],
    [
      'model id',
      (info) => ((info.model as JsonObject).modelID = 'other'),
      '/agent/worker/model/modelID',
    ],
    ['variant', (info) => (info.variant = 'low'), '/agent/worker/variant'],
    ['temperature', (info) => (info.temperature = 0.5), '/agent/worker/temperature'],
    ['topP', (info) => (info.topP = 0.2), '/agent/worker/topP'],
    ['color', (info) => (info.color = '#000000'), '/agent/worker/color'],
    ['options', (info) => (info.options = { outputs: [] }), '/agent/worker/options/nested'],
    ['steps', (info) => (info.steps = 1), '/agent/worker/steps'],
  ]

  test.each(infoMutations)(
    'rejects version-fixed Agent.Info mutation: %s',
    (_name, mutate, expectedPath) => {
      const input = makeInput()
      mutate(controlledAgent(input.agents))
      const error = identityError(() => verifyExecutionIdentity(input))
      expect(error.path).toBe(expectedPath)
    },
  )

  test('rejects missing fields, unknown fields, duplicate names, and extra non-native agents', () => {
    const missing = makeInput()
    delete controlledAgent(missing.agents).prompt
    expect(identityError(() => verifyExecutionIdentity(missing)).path).toBe('/agent/worker/prompt')

    const unknown = makeInput()
    controlledAgent(unknown.agents).futureField = true
    expect(identityError(() => verifyExecutionIdentity(unknown)).path).toBe(
      '/agent/worker/futureField',
    )

    const duplicate = makeInput()
    duplicate.agents.push(clone(controlledAgent(duplicate.agents)))
    expect(identityError(() => verifyExecutionIdentity(duplicate)).path).toBe('/agent/worker')

    const extra = makeInput()
    extra.agents.push({
      name: 'rogue',
      mode: 'all',
      native: false,
      permission: [],
      options: {},
    })
    expect(identityError(() => verifyExecutionIdentity(extra)).path).toBe('/agent/rogue')

    const spoofedNative = makeInput()
    spoofedNative.agents.push({
      name: 'rogue',
      mode: 'primary',
      native: true,
      permission: [],
      options: {},
    })
    expect(identityError(() => verifyExecutionIdentity(spoofedNative)).path).toBe('/agent/rogue')
  })

  test('rejects selected-agent fallback and a missing selected registry entry', () => {
    const fallback = makeInput()
    fallback.selectedAgentName = 'missing'
    expect(identityError(() => verifyExecutionIdentity(fallback)).path).toBe('/agent/missing')

    const missing = makeInput()
    missing.agents = missing.agents.filter((info) => info.name !== 'worker')
    expect(identityError(() => verifyExecutionIdentity(missing)).path).toBe('/agent/worker')
  })

  test('permission rules preserve order and require the controlled tail', () => {
    const reordered = makeInput()
    const permission = controlledAgent(reordered.agents).permission as JsonObject[]
    ;[permission[1], permission[2]] = [permission[2] as JsonObject, permission[1] as JsonObject]
    expect(identityError(() => verifyExecutionIdentity(reordered)).path).toBe(
      '/agent/worker/permission/1/action',
    )

    const extraTail = makeInput()
    ;(controlledAgent(extraTail.agents).permission as JsonObject[]).push({
      permission: 'bash',
      pattern: '*',
      action: 'allow',
    })
    expect(identityError(() => verifyExecutionIdentity(extraTail)).path).toStartWith(
      '/agent/worker/permission/',
    )
  })

  test('rejects every rule after the final controlled external_directory deny', () => {
    const exact = makeInput()
    expect(() => verifyExecutionIdentity(exact)).not.toThrow()

    const dynamic = makeInput()
    ;(controlledAgent(dynamic.agents).permission as JsonObject[]).push({
      permission: 'external_directory',
      pattern: '/tmp/another/*',
      action: 'allow',
    })
    expect(() => verifyExecutionIdentity(dynamic)).toThrow(ExecutionIdentityError)

    const changed = makeInput()
    const rules = controlledAgent(changed.agents).permission as JsonObject[]
    ;(rules.at(-1) as JsonObject).action = 'allow'
    expect(() => verifyExecutionIdentity(changed)).toThrow(ExecutionIdentityError)
  })

  test('expands permission HOME only from explicit pure-function input', () => {
    const input = makeInput()
    const entry = (input.expectedInlineConfig.agent as JsonObject).worker as JsonObject
    entry.permission = { read: { '~/private/*': 'deny' } }
    const effectiveEntry = (input.effectiveConfig.agent as JsonObject).worker as JsonObject
    effectiveEntry.permission = { read: { '~/private/*': 'deny' } }
    controlledAgent(input.agents).permission = [
      { permission: '*', pattern: '*', action: 'allow' },
      { permission: 'question', pattern: '*', action: 'deny' },
      { permission: 'read', pattern: '/home/runner/private/*', action: 'deny' },
    ]
    expect(identityError(() => verifyExecutionIdentity(input)).path).toBe(
      '/config/agent/worker/permission/read/~0~1private~1*',
    )
    input.permissionHome = '/home/runner'
    expect(() => verifyExecutionIdentity(input)).not.toThrow()
  })

  test('second Agent.Info response must have the identical complete canonical seal', () => {
    const input = makeInput()
    input.secondAgents = clone(input.agents)
    const secondWorker = controlledAgent(input.secondAgents as unknown[])
    ;(secondWorker.options as JsonObject).nested = { stable: false }
    const error = identityError(() => verifyExecutionIdentity(input))
    expect(error.code).toBe('execution-identity-instance-changed')
    expect(error.path).toBe('/agent/worker/options/nested/stable')

    const nativeDrift = makeInput()
    nativeDrift.secondAgents = clone(nativeDrift.agents)
    const native = (nativeDrift.secondAgents as JsonObject[]).find(
      (agent) => agent.name === 'build',
    )!
    native.description = 'changed native baseline'
    const nativeError = identityError(() => verifyExecutionIdentity(nativeDrift))
    expect(nativeError.code).toBe('execution-identity-instance-changed')
    expect(nativeError.path).toBe('/agent/build/description')
  })

  test('normalizes pinned Agent.Info null optionals as absent, but not non-null drift', () => {
    const input = makeInput()
    const expected = (input.expectedInlineConfig.agent as JsonObject).worker as JsonObject
    const info = controlledAgent(input.agents)
    for (const field of ['description', 'hidden', 'temperature', 'color', 'variant', 'steps']) {
      delete expected[field === 'topP' ? 'top_p' : field]
      delete ((input.effectiveConfig.agent as JsonObject).worker as JsonObject)[
        field === 'topP' ? 'top_p' : field
      ]
      info[field] = null
    }
    expect(() => verifyExecutionIdentity(input)).not.toThrow()

    info.color = '#FFFFFF'
    expect(identityError(() => verifyExecutionIdentity(input)).path).toBe('/agent/worker/color')
  })
})

describe('RFC-224 secret-safe failures', () => {
  test('MCP headers, OAuth values, environment, and prompts never enter errors', () => {
    const cases: Array<[string, (input: ReturnType<typeof makeInput>) => void]> = [
      [
        'mcp-remote-secret',
        (input) => {
          const remote = (input.effectiveConfig.mcp as JsonObject).remote_docs as JsonObject
          ;(remote.headers as JsonObject).Authorization = 'different'
        },
      ],
      [
        'oauth-secret',
        (input) => {
          const remote = (input.effectiveConfig.mcp as JsonObject).remote_docs as JsonObject
          ;(remote.oauth as JsonObject).clientSecret = 'different'
        },
      ],
      [
        'mcp-local-secret',
        (input) => {
          const local = (input.effectiveConfig.mcp as JsonObject).local_tools as JsonObject
          ;(local.environment as JsonObject).API_TOKEN = 'different'
        },
      ],
      [
        'private prompt',
        (input) => {
          controlledAgent(input.agents).prompt = 'different'
        },
      ],
    ]

    for (const [secret, mutate] of cases) {
      const input = makeInput()
      mutate(input)
      const error = identityError(() => verifyExecutionIdentity(input))
      const rendered = `${error.message}\n${JSON.stringify(error)}\n${error.stack ?? ''}`
      expect(rendered).not.toContain(secret)
      expect(Object.keys(error).sort()).toEqual(['code', 'name', 'path'])
    }
  })
})
