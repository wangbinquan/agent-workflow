import { expect, test } from 'bun:test'
import { createTaskAgentMaterialPreparation } from '../src/modules/task-execution/composition/taskAgentMaterialPreparation'
import type {
  AgentInvocationPreparation,
  CompiledAgentInvocation,
} from '../src/modules/task-execution/application/ports/agentInvocationPreparation'
import type {
  AgentMaterialIntent,
  AgentMaterialWorkspace,
} from '../src/modules/runtime-management/public/participants'
import type { TaskAgentMaterialDeclaration } from '../src/modules/task-execution/application/ports/taskAgentMaterial'
import {
  emptyDeclaredManifest,
  EMPTY_RUNTIME_PROFILE,
} from '../src/services/execution/agentInjection'
import { createLogger } from '../src/util/log'

function unused(): never {
  throw new Error('unused preparation member')
}

test('normal Task preparation retains ordered profiles, omitted config, receiver and one selected compilation', async () => {
  const calls: string[] = [],
    intents: AgentMaterialIntent[] = []
  const workspace: AgentMaterialWorkspace = {
    workspace: { owner: 'source-control', reference: 'working:r17', version: 17 },
    runContent: { owner: 'runtime-management', reference: 'run:r7', version: 7 },
    retainedRef: 'retained:r7',
    prepare: unused,
    discard: unused,
  }
  const compiled: CompiledAgentInvocation = {
    materialRef: 'material:r2',
    declared: emptyDeclaredManifest(),
    evidenceCapabilities: {
      usageNormalizer: false,
      nativeUsageCapture: false,
      spanCapture: false,
      sessionCapture: true,
      inventory: false,
      finalEvents: false,
      liveCapture: false,
      sessionSinkCapture: false,
    },
    bind: unused,
  }
  const preparation: AgentInvocationPreparation = {
    workspace,
    async compile(intent) {
      expect(this).toBe(preparation)
      calls.push('compile')
      intents.push(intent)
      return compiled
    },
  }
  const resources = {
    injection: { plugins: [], skills: [] },
    prepareMounts() {
      expect(this).toBe(resources)
      calls.push('mounts')
      return [workspace.workspace]
    },
  }
  const diagnostics = {
    readDeclaredMcpServers(material: CompiledAgentInvocation) {
      expect(this).toBe(diagnostics)
      expect(material).toBe(compiled)
      calls.push('mcp')
      return ['late-declared']
    },
    reportSpawn(material: CompiledAgentInvocation) {
      expect(this).toBe(diagnostics)
      expect(material).toBe(compiled)
      calls.push('report')
    },
    detectPluginLoadFailure(material: CompiledAgentInvocation, line: string) {
      expect(this).toBe(diagnostics)
      expect(material).toBe(compiled)
      return { pluginName: 'selected-plugin', message: line }
    },
  }
  const task = createTaskAgentMaterialPreparation({ preparation, resources, diagnostics })
  const profiles = [
    ['root', EMPTY_RUNTIME_PROFILE],
    ['dep-b', { ...EMPTY_RUNTIME_PROFILE, model: 'b' }],
    ['dep-a', { ...EMPTY_RUNTIME_PROFILE, model: 'a' }],
  ] as const
  const declaration: TaskAgentMaterialDeclaration = {
    protocol: 'opencode',
    injection: { mcps: [] },
    prompt: '原最终 prompt',
    agentName: 'root',
    systemPrompt: '角色',
    injectedMemoryBlock: null,
    resolvedProfiles: profiles,
    freshAgentRun: false,
    resumeSessionId: 'session:selected',
    gitUserName: 'author',
    gitUserEmail: 'author@example.com',
    nodeRunId: 'run-1',
    log: createLogger('task-material-test'),
  }
  expect(calls).toEqual([])
  task.prepareMounts()
  const handle = await task.compile(declaration)
  expect(calls).toEqual(['mounts', 'compile'])
  expect(intents).toHaveLength(1)
  expect(intents[0]?.resolvedProfiles).toBe(profiles)
  expect(intents[0]?.taskMounts).toEqual([workspace.workspace])
  expect(intents[0]).not.toHaveProperty('configDir')
  expect(intents[0]).not.toHaveProperty('runtimeBinding')
  expect(handle.declared).toBe(compiled.declared)
  expect(handle.evidenceCapabilities).toBe(compiled.evidenceCapabilities)
  expect(handle.readDeclaredMcpServers()).toEqual(['late-declared'])
  handle.reportSpawn(declaration.log, {
    runtime: 'opencode',
    agentName: 'root',
    nodeRunId: 'run-1',
  })
  expect(handle.detectPluginLoadFailure('原错误')).toEqual({
    pluginName: 'selected-plugin',
    message: '原错误',
  })
  expect(calls).toEqual(['mounts', 'compile', 'mcp', 'report'])
})

test('mount preparation rejects outside the compile call and compilation retains the selected rejection', async () => {
  const mountError = new Error('selected mount rejection'),
    compileError = new Error('selected compile rejection')
  const preparation: AgentInvocationPreparation = {
    workspace: {
      workspace: { owner: 'source-control', reference: 'working:r17', version: 17 },
      runContent: { owner: 'runtime-management', reference: 'run:r7', version: 7 },
      retainedRef: 'retained:r7',
      prepare: unused,
      discard: unused,
    },
    async compile() {
      throw compileError
    },
  }
  const resources = {
    injection: {},
    prepareMounts(): never {
      throw mountError
    },
  }
  const task = createTaskAgentMaterialPreparation({
    preparation,
    resources,
    diagnostics: {
      readDeclaredMcpServers: unused,
      reportSpawn: unused,
      detectPluginLoadFailure: unused,
    },
  })
  expect(() => task.prepareMounts()).toThrow(mountError)
  await expect(
    task.compile({
      protocol: 'opencode',
      injection: { mcps: [] },
      prompt: '',
      agentName: '',
      systemPrompt: '',
      resolvedProfiles: [],
      freshAgentRun: true,
      nodeRunId: 'run',
      log: createLogger('task-compile-rejection'),
    }),
  ).rejects.toBe(compileError)
})

test('normal Task preparation forwards prototype resource getters without replacing business injection', async () => {
  const calls: string[] = []
  const skills: NonNullable<AgentMaterialIntent['injection']['skills']> = [
    {
      name: 'selected-skill',
      sourceKind: 'managed',
      content: { owner: 'resource-catalog', reference: 'skill:selected-v7', version: 7 },
    },
  ]
  const plugins: NonNullable<AgentMaterialIntent['injection']['plugins']> = [
    {
      declaration: { id: 'plugin', name: 'selected-plugin', options: {}, enabled: true },
      content: { owner: 'resource-catalog', reference: 'plugin:selected-v3', version: 3 },
    },
  ]
  class ResourceInjection {
    readonly mcps = []
    #references = { skills, plugins }
    get plugins() {
      calls.push('plugins')
      return this.#references.plugins
    }
    get skills() {
      calls.push('skills')
      return this.#references.skills
    }
  }
  const selected = new ResourceInjection()
  const coreMcps: AgentMaterialIntent['injection']['mcps'] = []
  let received: AgentMaterialIntent | undefined
  const preparation: AgentInvocationPreparation = {
    workspace: {
      workspace: { owner: 'source-control', reference: 'working:selected', version: 1 },
      runContent: { owner: 'runtime-management', reference: 'run:selected', version: 1 },
      retainedRef: 'retained:selected',
      prepare: unused,
      discard: unused,
    },
    async compile(intent) {
      received = intent
      return {
        materialRef: 'material:selected',
        declared: emptyDeclaredManifest(),
        evidenceCapabilities: {
          usageNormalizer: false,
          nativeUsageCapture: false,
          spanCapture: false,
          sessionCapture: false,
          inventory: false,
          finalEvents: false,
          liveCapture: false,
          sessionSinkCapture: false,
        },
        bind: unused,
      }
    },
  }
  const task = createTaskAgentMaterialPreparation({
    preparation,
    resources: {
      get injection() {
        calls.push('resources')
        return selected
      },
      prepareMounts() {
        return []
      },
    },
    diagnostics: {
      readDeclaredMcpServers: unused,
      reportSpawn: unused,
      detectPluginLoadFailure: unused,
    },
  })
  expect(calls).toEqual([])
  task.prepareMounts()
  await task.compile({
    protocol: 'opencode',
    injection: {
      get mcps() {
        calls.push('mcps')
        return coreMcps
      },
    },
    prompt: '',
    agentName: '',
    systemPrompt: '',
    resolvedProfiles: [],
    freshAgentRun: true,
    nodeRunId: 'run',
    log: createLogger('task-resource-getters'),
  })
  expect(calls).toEqual(['mcps', 'resources', 'plugins', 'skills'])
  expect(received?.injection.mcps).toBe(coreMcps)
  expect(received?.injection.mcps).not.toBe(selected.mcps)
  expect(received?.injection.plugins).toBe(plugins)
  expect(received?.injection.skills).toBe(skills)
})
