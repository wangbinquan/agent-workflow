// RFC-370 M2 / CS RFC-040: a hosted invocation must carry the same frozen
// Agent, dependency and plugin content; no host CLI or current plugin lookup.
import { expect, test } from 'bun:test'
import type { Agent, Mcp } from '@agent-workflow/shared'
import type { AgentMaterialIntent } from '@/modules/runtime-management/public/participants'
import { compileHostedNativeMaterial } from '@/modules/task-execution/infrastructure/crewstation/nativeMaterial'
import { createHostedNativePluginReader } from '@/modules/resource-catalog/composition/crewstationNativePlugin'
import { createCrewStationBusinessExecution } from '@/platform/crewstation/businessExecution'
import { EMPTY_RUNTIME_PROFILE } from '@/services/execution/agentInjection'
import { createLogger } from '@/util/log'

const agent: Agent = {
  id: 'root-id',
  name: 'root',
  description: 'Review',
  outputs: [],
  dependsOn: [],
  syncOutputsOnIterate: true,
  permission: { bash: 'deny' },
  skills: [],
  mcp: [],
  plugins: [],
  frontmatterExtra: {},
  bodyMd: 'raw body',
  schemaVersion: 1,
  createdAt: 1,
  updatedAt: 1,
}
const mcp: Mcp = {
  id: 'mcp',
  name: 'docs',
  description: '',
  type: 'remote',
  enabled: true,
  config: {
    url: 'https://mcp.example.test',
    headers: { authorization: 'private-test-token' },
    timeoutMs: 2500,
  },
  schemaVersion: 1,
  createdAt: 1,
  updatedAt: 1,
}
const plugin = {
  declaration: { id: 'plugin-id', name: 'plugin', enabled: true, options: {} },
  content: {
    owner: 'resource-catalog' as const,
    reference: 'cs-plugin:plugin-id/generation/package',
    version: '1.0.0',
  },
}
const reference = { owner: 'source-control' as const, reference: 'task/workspace', version: null }
const intent = (): AgentMaterialIntent => ({
  protocol: 'opencode',
  injection: { mcps: [], agent },
  prompt: 'user instruction',
  agentName: 'root',
  systemPrompt: 'compiled root',
  injectedMemoryBlock: 'retained memory',
  resolvedProfiles: [],
  workspace: reference,
  runContent: reference,
  freshAgentRun: true,
  nodeRunId: 'node',
  log: createLogger('native-material-test'),
})

test('OpenCode material keeps root memory, per-agent parameters, MCP env and selected dependencies', async () => {
  const helper = {
    ...agent,
    id: 'helper',
    name: 'helper',
    bodyMd: 'helper body',
    permission: { edit: 'allow' as const },
  }
  const profile = {
    ...EMPTY_RUNTIME_PROFILE,
    model: 'provider/model',
    variant: 'fast',
    temperature: 0.2,
    steps: 20,
  }
  const local: Mcp = {
    ...mcp,
    id: 'local',
    name: 'local',
    type: 'local',
    config: { command: ['node', './tool.mjs'], env: { API_TOKEN: 'private-env' }, timeoutMs: 1000 },
  }
  const result = await compileHostedNativeMaterial(
    {
      ...intent(),
      resolvedProfiles: [['helper', { ...profile, temperature: 0.1 }]],
      injection: {
        agent,
        mcps: [mcp, local, mcp, { ...mcp, id: 'off', name: 'off', enabled: false }],
        profile,
        dependents: [agent, helper, helper],
        skills: [
          { name: 'managed', sourceKind: 'managed', content: reference },
          { name: 'repo-discovered', sourceKind: 'project', content: reference },
        ],
      },
    },
    {},
  )
  expect(result.nativeConfig.agent).toEqual({
    name: 'root',
    body: 'compiled root\n\nretained memory',
    options: {
      description: 'Review',
      permission: { bash: 'deny' },
      variant: 'fast',
      temperature: 0.2,
      steps: 20,
    },
  })
  expect(result.nativeConfig.subagents).toHaveLength(1)
  expect(result.nativeConfig.subagents[0]).toMatchObject({
    name: 'helper',
    body: 'helper body',
    options: { temperature: 0.1, permission: { edit: 'allow' } },
  })
  expect(result.nativeConfig.subagents[0]?.options).not.toHaveProperty('model')
  expect(result.nativeConfig.mcp).toEqual([
    { name: 'docs', type: 'remote', ...mcp.config },
    { name: 'local', type: 'local', ...local.config },
  ])
  expect(result.declared).toMatchObject({
    mcpServers: ['docs', 'local'],
    subagents: ['helper'],
    skills: ['managed'],
    skippedDisabledMcps: ['off'],
  })
})

test('native plugin material comes from its frozen generation and carries complete object and link facts', async () => {
  const requests: string[] = []
  const read = createHostedNativePluginReader({
    async read(reference) {
      requests.push(reference)
      return {
        version: 2,
        pluginId: 'plugin-id',
        generationId: 'generation',
        requestedSpec: 'pkg@1',
        sourceKind: 'npm',
        resolvedVersion: '1.0.0',
        sourceIdentity: 'integrity',
        entry: '.',
        files: [
          {
            kind: 'file',
            path: 'index.mjs',
            mode: 0o755,
            object: { id: 'object', sha256: 'a'.repeat(64), size: 2_000_000 },
          },
          { kind: 'symlink', path: 'entry.mjs', target: 'index.mjs' },
        ],
      }
    },
  })
  const result = await compileHostedNativeMaterial(
    {
      ...intent(),
      injection: {
        mcps: [],
        plugins: [
          plugin,
          plugin,
          { ...plugin, declaration: { ...plugin.declaration, id: 'disabled', enabled: false } },
        ],
      },
    },
    { pluginFiles: read },
  )
  expect(requests).toEqual([plugin.content.reference])
  expect(result.nativeConfig.plugins).toEqual([
    {
      name: 'plugin',
      entry: 'package',
      files: [
        {
          kind: 'file',
          path: 'package/index.mjs',
          mode: 0o755,
          object: { objectId: 'object', sha256: 'a'.repeat(64), size: 2_000_000 },
        },
        { kind: 'symlink', path: 'package/entry.mjs', target: 'index.mjs' },
      ],
    },
  ])
  expect(result.declared.plugins).toEqual(['plugin'])
  await expect(
    read({ ...plugin, content: { ...plugin.content, version: '2.0.0' } }),
  ).rejects.toThrow('generation-mismatch')
  await expect(
    read({ ...plugin, declaration: { ...plugin.declaration, id: 'other' } }),
  ).rejects.toThrow('generation-mismatch')
  await expect(
    read({ ...plugin, content: { ...plugin.content, owner: 'source-control' } }),
  ).rejects.toThrow('owner-mismatch')
})

test('unrepresentable configuration is rejected explicitly, never silently reduced to the root profile', async () => {
  await expect(
    compileHostedNativeMaterial({ ...intent(), extraArgs: ['--custom'] }, {}),
  ).rejects.toThrow('platform-owned')
  await expect(
    compileHostedNativeMaterial(
      {
        ...intent(),
        injection: { mcps: [], profile: { ...EMPTY_RUNTIME_PROFILE, isSandbox: true } },
      },
      {},
    ),
  ).rejects.toThrow('platform-owned')
  await expect(
    compileHostedNativeMaterial(
      {
        ...intent(),
        resolvedProfiles: [['helper', { ...EMPTY_RUNTIME_PROFILE, model: 'other/model' }]],
        injection: { mcps: [], dependents: [{ ...agent, name: 'helper' }] },
      },
      {},
    ),
  ).rejects.toThrow('dependent model mapping')
  await expect(
    compileHostedNativeMaterial(
      { ...intent(), injection: { mcps: [mcp, { ...mcp, id: 'different-resource' }] } },
      {},
    ),
  ).rejects.toThrow('two different MCP resources')
  await expect(
    compileHostedNativeMaterial({ ...intent(), injection: { mcps: [], plugins: [plugin] } }, {}),
  ).rejects.toThrow('content-owner-unavailable')
})

test('business transport forwards native materials and object descriptors without legacy prompt substitution', async () => {
  const calls: Array<{ path: string; body: unknown }> = []
  const api = createCrewStationBusinessExecution({
    get: async () => {
      throw new Error('unexpected GET')
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      calls.push({ path, body })
      return { materialId: 'material', digest: 'digest', sizeBytes: 20 } as T
    },
    stream: () => {
      throw new Error('unexpected stream')
    },
  })
  const { nativeConfig } = await compileHostedNativeMaterial(intent(), {})
  const skills = [
    {
      path: 'data/payload.bin',
      object: { objectId: 'object', sha256: 'a'.repeat(64), size: 2_000_000 },
    },
  ]
  await api.createMaterial('parent', {
    requestKey: 'request',
    fence: { epoch: 1, instanceId: 'instance', leaseId: 'lease' },
    nativeConfig,
    skills,
  })
  expect(calls).toEqual([
    {
      path: '/v3/business-tasks/parent/materials',
      body: {
        requestKey: 'request',
        fence: { epoch: 1, instanceId: 'instance', leaseId: 'lease' },
        nativeConfig,
        skills,
        env: {},
      },
    },
  ])
})

test('OpenCode preserves OAuth and non-empty plugin options through the portable contract', async () => {
  const configured = {
    ...plugin,
    declaration: { ...plugin.declaration, options: { nested: { flag: true, token: 'fixture' } } },
  }
  const result = await compileHostedNativeMaterial(
    {
      ...intent(),
      injection: {
        mcps: [{ ...mcp, config: { ...mcp.config, oauth: false } }],
        plugins: [configured],
      },
    },
    {
      pluginFiles: async (entry) => ({
        name: entry.declaration.name,
        entry: 'package/entry.mjs',
        files: [{ kind: 'file', path: 'package/entry.mjs', content: 'export default {}' }],
        options: entry.declaration.options,
      }),
    },
  )
  expect(result.nativeConfig.mcp[0]).toHaveProperty('oauth', false)
  expect(result.nativeConfig.plugins[0]?.options).toEqual(configured.declaration.options)
})

test('OpenCode dependent models compile to authorized platform references while preserving original per-agent options', async () => {
  const id = '01a1436b-6137-7000-9938-1d16f43e6e94'
  const requested: Array<[string, string]> = []
  const input = {
    ...intent(),
    resolvedProfiles: [
      ['helper', { ...EMPTY_RUNTIME_PROFILE, model: 'other/model', temperature: 0.1 }],
    ] as AgentMaterialIntent['resolvedProfiles'],
    injection: {
      mcps: [],
      profile: { ...EMPTY_RUNTIME_PROFILE, model: 'root/model' },
      dependents: [
        { ...agent, name: 'helper' },
        { ...agent, name: 'inherit' },
      ],
    },
  }
  const result = await compileHostedNativeMaterial(input, {
    async dependentAgentProfile(model, name) {
      requested.push([model, name])
      return id
    },
  })
  expect(requested).toEqual([['other/model', 'helper']])
  expect(result.nativeConfig.subagents[0]).toMatchObject({
    agentProfileId: id,
    options: { temperature: 0.1 },
  })
  expect(result.nativeConfig.agent).not.toHaveProperty('agentProfileId')
  expect(result.nativeConfig.subagents[1]).not.toHaveProperty('agentProfileId')
  expect(result.nativeConfig.subagents[0]?.options).not.toHaveProperty('model')
  await expect(
    compileHostedNativeMaterial(input, {
      async dependentAgentProfile() {
        throw new Error('hosted-runtime-profile-unmapped: other/model')
      },
    }),
  ).rejects.toThrow('hosted-runtime-profile-unmapped')
  await expect(
    compileHostedNativeMaterial(input, {
      async dependentAgentProfile() {
        throw new Error('nativeModelMappingVersion unavailable')
      },
    }),
  ).rejects.toThrow('nativeModelMappingVersion')
})
