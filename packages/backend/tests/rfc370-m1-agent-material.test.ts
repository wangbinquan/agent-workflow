import { composeHostedTaskMaterialReferences } from '@/modules/task-execution/composition/crewstationTaskRunSelection'
import { expect, test } from 'bun:test'
import type { Agent } from '@agent-workflow/shared'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  AgentMaterialIntent,
  AgentMaterialWorkspace,
} from '@/modules/runtime-management/public/participants'
import { createHostedAgentInvocationPreparation } from '@/modules/task-execution/composition/crewstationAgentInvocation'
import type { HostedExecution } from '@/modules/task-execution/infrastructure/crewstation/execution'
import type { HostedExecutionBinding } from '@/modules/task-execution/infrastructure/crewstation/executionStore'
import type {
  CrewStationBusinessExecution,
  CreateBusinessMaterial,
} from '@/platform/crewstation/businessExecution'
import { createLogger } from '@/util/log'
import { emptyDeclaredManifest } from '@/services/execution/agentInjection'
import { createHostedGitAgentEnvironment } from '@/modules/source-control/composition/crewstationGitCredentials'

const unavailable = (): never => {
  throw new Error('unexpected native effect')
}
const profile = (model: string | null) => ({
  model,
  variant: null,
  temperature: null,
  steps: null,
  maxSteps: null,
  isSandbox: false,
})
const workspace: AgentMaterialWorkspace = {
  workspace: {
    owner: 'source-control',
    reference: 'cs-workspace:task/worktrees/task',
    version: null,
  },
  runContent: {
    owner: 'runtime-management',
    reference: 'cs-workspace:task/runs/task/run',
    version: null,
  },
  retainedRef: 'cs-workspace:task/runs/task/run',
  prepare: async () => undefined,
  discard: async () => undefined,
}
const intent = (): AgentMaterialIntent => ({
  protocol: 'opencode',
  injection: { mcps: [] },
  prompt: 'user prompt',
  agentName: 'agent',
  systemPrompt: 'definition',
  injectedMemoryBlock: 'memory',
  resolvedProfiles: [],
  workspace: workspace.workspace,
  runContent: workspace.runContent,
  freshAgentRun: true,
  nodeRunId: 'run',
  log: createLogger('hosted-agent-test'),
})
function fixture(
  existing: HostedExecutionBinding | null = null,
  overrides: Partial<Parameters<typeof createHostedAgentInvocationPreparation>[0]> = {},
) {
  const materials: CreateBusinessMaterial[] = []
  const executions: HostedExecution = {
    workspaceSettled: async () => true,
    find: async () => existing,
    run: unavailable,
    adopt: unavailable,
    cancel: unavailable,
    observing: () => false,
  }
  const api: CrewStationBusinessExecution = {
    createTask: unavailable,
    getTask: unavailable,
    closeTask: unavailable,
    finalizeTask: unavailable,
    pauseTask: unavailable,
    resumeTask: unavailable,
    listSubtasks: unavailable,
    async createMaterial(_task, material) {
      materials.push(material)
      return { materialId: 'material', digest: 'digest', sizeBytes: 12 }
    },
    submitSubtask: unavailable,
    getSubtask: unavailable,
    cancelSubtask: unavailable,
    events: unavailable,
    streamEvents: unavailable,
    readFile: unavailable,
    listFiles: unavailable,
  }
  const preparation = createHostedAgentInvocationPreparation({
    db: {} as PersistenceDb,
    fence: {
      current: () => ({ epoch: 1, leaseId: 'lease', instanceId: 'instance' }),
      assertHeld: unavailable,
    },
    api,
    executions,
    taskId: 'task',
    businessTaskId: 'parent',
    cwd: '/work/worktrees/task',
    workspace,
    profiles: [{ protocol: 'opencode', model: null, agentProfileId: 'profile' }],
    skillFiles: async () => [{ path: 'skill/SKILL.md', content: 'skill body' }],
    ...overrides,
  })
  return { preparation, materials, executions }
}

test('hosted Agent material preserves definition, memory, selected skills and stable upload identity', async () => {
  const f = fixture()
  const input: AgentMaterialIntent = {
    ...intent(),
    injection: {
      mcps: [],
      skills: [
        {
          name: 'skill',
          sourceKind: 'managed',
          skillId: 'skill',
          contentVersion: 1,
          content: { owner: 'resource-catalog', reference: 'skill', version: 1 },
        },
      ],
    },
  }
  const prepared = await f.preparation.compile(input)
  await f.preparation.compile(input)
  expect(f.materials[0]).toMatchObject({
    systemPrompt: 'definition\n\nmemory',
    skills: [{ path: 'skill/SKILL.md', content: 'skill body' }],
  })
  expect(f.materials[0]?.requestKey).toBe(f.materials[1]?.requestKey)
  expect(prepared.evidenceCapabilities).toMatchObject({
    usageMeter: true,
    inventory: false,
    sessionCapture: false,
  })
})

test('Agent material includes Git identity and Secret references in its frozen request digest', async () => {
  const materialEnvironment = createHostedGitAgentEnvironment(
    JSON.stringify([
      {
        kind: 'http',
        url: 'https://git.example.test/team/repo.git',
        username: 'developer',
        passwordSecretId: '01a1428d-05f5-7000-9af3-aef7382bfe08', // gitleaks:allow — a CS Secret resource id
      },
    ]),
  )
  const f = fixture(null, { materialEnvironment })
  const input = { ...intent(), gitUserName: 'AW Developer', gitUserEmail: 'dev@example.test' }
  await f.preparation.compile(input)
  await f.preparation.compile(input)
  await f.preparation.compile({ ...input, gitUserEmail: 'changed@example.test' })
  expect(f.materials[0]!.env).toEqual(materialEnvironment(input))
  expect(f.materials[0]!.requestKey).toBe(f.materials[1]!.requestKey)
  expect(f.materials[0]!.requestKey).not.toBe(f.materials[2]!.requestKey)
})

test('unsupported model options and missing model mappings fail before platform submission', async () => {
  const f = fixture()
  await expect(f.preparation.compile({ ...intent(), extraArgs: ['--unmapped'] })).rejects.toThrow(
    'runtime arguments',
  )
  await expect(
    f.preparation.compile({ ...intent(), injection: { mcps: [], profile: profile('other') } }),
  ).rejects.toThrow('hosted-runtime-profile-unmapped')
  await expect(
    f.preparation.compile({
      ...intent(),
      injection: { mcps: [], profile: { ...profile(null), temperature: 0.5 } },
    }),
  ).rejects.toThrow('model options')
  expect(f.materials).toHaveLength(0)
})

const agent: Agent = {
  id: 'agent',
  name: 'agent',
  description: '',
  outputs: [],
  dependsOn: [],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  mcp: [],
  plugins: [],
  frontmatterExtra: {},
  bodyMd: 'body',
  schemaVersion: 1,
  createdAt: 1,
  updatedAt: 1,
}
test('every M1 unavailable material is rejected before upload, while disabled declarations remain harmless', async () => {
  const mcp = {
    id: 'mcp',
    name: 'mcp',
    description: '',
    type: 'remote' as const,
    config: { url: 'https://example.invalid/mcp' },
    enabled: true,
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  }
  const plugin = {
    declaration: { id: 'plugin', name: 'plugin', options: {}, enabled: true },
    content: { owner: 'resource-catalog' as const, reference: 'plugin', version: 1 },
  }
  const cases: readonly (readonly [Partial<AgentMaterialIntent>, string])[] = [
    [{ injection: { mcps: [mcp] } }, 'MCP'],
    [{ injection: { mcps: [], plugins: [plugin] } }, 'plugins'],
    [{ injection: { mcps: [], dependents: [agent] } }, 'subagents'],
    [
      { injection: { mcps: [], agent: { ...agent, permission: { edit: 'deny' } } } },
      'agent permissions',
    ],
    [
      {
        injection: { mcps: [], agent: { ...agent, frontmatterExtra: { tools: { bash: false } } } },
      },
      'Agent frontmatter',
    ],
    [{ extraArgs: ['--custom-option'] }, 'runtime arguments'],
  ]
  for (const [change, message] of cases) {
    const f = fixture()
    await expect(f.preparation.compile({ ...intent(), ...change })).rejects.toThrow(message)
    expect(f.materials).toHaveLength(0)
  }
  const f = fixture()
  await f.preparation.compile({
    ...intent(),
    injection: {
      mcps: [{ ...mcp, enabled: false }],
      plugins: [{ ...plugin, declaration: { ...plugin.declaration, enabled: false } }],
    },
  })
  expect(f.materials).toHaveLength(1)
})

test('material size limits reject multi-byte content before platform upload', async () => {
  const f = fixture()
  await expect(
    f.preparation.compile({ ...intent(), systemPrompt: '中'.repeat(400_000) }),
  ).rejects.toThrow('hosted-material-exceeds-platform-limit')
  expect(f.materials).toHaveLength(0)
})

test('restart uses the accepted material and original Agent request even when deployment mappings change', async () => {
  const original: HostedExecutionBinding = {
    executionId: 'agent:task:run',
    taskId: 'task',
    nodeRunId: 'run',
    businessTaskId: 'parent',
    requestKey: 'key',
    request: {
      kind: 'agent',
      name: 'original',
      agentProfileId: 'old-profile',
      materialId: 'original-material',
      prompt: 'original-prompt',
    },
    subtaskId: 'subtask',
    attempt: 1,
    materialDigest: 'digest',
    lastCursor: null,
    result: null,
    state: 'running',
    cancelRequested: false,
    cancelReason: null,
    epoch: 1,
    createdAt: Date.now(),
    agentContext: {
      version: 1,
      protocol: 'opencode',
      startupInventory: true,
      declared: { ...emptyDeclaredManifest(), skills: ['original-skill'] },
    },
  }
  const f = fixture(original, {
    materialEnvironment: unavailable,
    nativeConfigAvailable: unavailable,
    materialObjectsAvailable: unavailable,
    startupInventoryAvailable: unavailable,
    pluginFiles: unavailable,
    skillFiles: unavailable,
    materialFiles: { stage: unavailable, published: unavailable },
  })
  let adopted: string | undefined
  f.executions.adopt = async (executionId) => {
    adopted = executionId
    return {
      binding: original,
      timedOut: false,
      cancelled: false,
      result: {
        exitCode: 0,
        reason: 'completed',
        stdout: '',
        stderr: '',
        truncated: false,
        finalCursor: 'final',
      },
      settle: async () => undefined,
    }
  }
  const prepared = await f.preparation.compile({
    ...intent(),
    injection: { mcps: [], profile: profile('now-unmapped') },
  })
  expect(prepared.materialRef).toBe('original-material')
  expect(prepared.declared.skills).toEqual(['original-skill'])
  expect(f.materials).toHaveLength(0)
  const invocation = await prepared.bind()
  expect(invocation.protocol.capabilities.startupObservation).toBe('init-event')
  expect(
    (
      await invocation.execute(
        {},
        {
          record: async () => undefined,
          diagnostic: async () => undefined,
          checkpoint: async () => undefined,
        },
      )
    ).result,
  ).toBe('ok')
  expect(adopted).toBe(original.executionId)
})

test('hosted task material keeps the frozen plugin generation rather than resolving current metadata', () => {
  const references = composeHostedTaskMaterialReferences()
  const snapshot = {
    kind: 'agent-injection' as const,
    root: {} as Parameters<typeof references.references>[0]['root'],
    dependents: [],
    mcps: [],
    skills: [],
    plugins: [
      {
        id: 'plugin',
        name: 'plugin',
        enabled: true,
        options: {},
        runtimeSpecifier: 'file://cs-plugin:plugin/GENERATION/index.js',
        resolvedVersion: '1.0.0',
      },
    ],
  }
  const material = references.references(snapshot)
  snapshot.plugins[0]!.runtimeSpecifier = 'file://cs-plugin:plugin/NEXT/index.js'
  expect(material.plugins[0]!.content.reference).toBe('cs-plugin:plugin/GENERATION/index.js')
})

test('adoption of a profile-only execution never uploads a replacement material', async () => {
  const original: HostedExecutionBinding = {
    executionId: 'agent:task:run',
    taskId: 'task',
    nodeRunId: 'run',
    businessTaskId: 'parent',
    requestKey: 'accepted-key',
    request: {
      kind: 'agent',
      name: 'original',
      agentProfileId: 'old-profile',
      prompt: 'original-prompt',
    },
    subtaskId: 'subtask',
    attempt: 1,
    materialDigest: null,
    lastCursor: null,
    result: null,
    state: 'running',
    cancelRequested: false,
    cancelReason: null,
    epoch: 1,
    createdAt: 1,
  }
  const f = fixture(original)
  const compiled = await f.preparation.compile({
    ...intent(),
    injection: { mcps: [], profile: profile('now-unmapped') },
  })
  expect(f.materials).toHaveLength(0)
  expect(compiled.materialRef).toBe('hosted-execution:agent:task:run')
  expect((await compiled.bind()).materialRef).toBe(compiled.materialRef)
  expect(compiled.declared.unsupported).toContain('hosted-declaration-not-recorded')
  expect(original.request).not.toHaveProperty('materialId')
})

test('M2 native preparation stages binary skill objects and records material publication before binding', async () => {
  const events: string[] = []
  const bytes = new Uint8Array([0, 255, 128])
  const f = fixture(null, {
    nativeConfigAvailable: async () => true,
    materialObjectsAvailable: async () => true,
    startupInventoryAvailable: async () => true,
    skillFiles: async () => [{ path: 'skill/data.bin', bytes }],
    materialFiles: {
      async stage(request) {
        expect(request).toMatchObject({
          executionId: 'agent:task:run',
          taskId: 'task',
          businessTaskId: 'parent',
          files: [{ path: 'skill/data.bin', bytes }],
        })
        events.push('staged')
        return [
          {
            path: 'skill/data.bin',
            object: { objectId: 'object', sha256: 'a'.repeat(64), size: 3 },
          },
        ]
      },
      async published(executionId, materialId) {
        expect(executionId).toBe('agent:task:run')
        expect(materialId).toBe('material')
        expect(f.materials).toHaveLength(1)
        events.push('published')
      },
    },
  })
  const prepared = await f.preparation.compile({
    ...intent(),
    injection: {
      mcps: [],
      skills: [
        {
          name: 'skill',
          sourceKind: 'managed',
          content: { owner: 'resource-catalog', reference: 'skill', version: 1 },
        },
      ],
    },
  })
  expect(events).toEqual(['staged', 'published'])
  expect(f.materials[0]).toMatchObject({
    nativeConfig: {
      version: 1,
      protocol: 'opencode',
      agent: { name: 'agent', body: 'definition\n\nmemory' },
    },
    skills: [{ path: 'skill/data.bin', object: { objectId: 'object', size: 3 } }],
  })
  expect(f.materials[0]).not.toHaveProperty('systemPrompt')
  expect(prepared.declared.skills).toEqual(['skill'])
})
