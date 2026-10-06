import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG_DIR_PROFILE, type Agent } from '@agent-workflow/shared'
import { composeLocalTaskAgentMaterialReferences } from '../src/modules/resource-catalog/composition/taskAgentMaterialReferences'
import type { TaskAgentInjectionSnapshot } from '../src/modules/resource-catalog/application/ports/taskAgentMaterialReferences'
import { composeLocalTaskAgentRunFamily } from '../src/modules/task-execution/composition/localTaskAgentRunFamily'
import { runTaskAgentWithFamily } from '../src/modules/task-execution/composition/taskAgentRunFamily'
import type {
  TaskAgentRunFamily,
  TaskAgentRunScope,
} from '../src/modules/task-execution/application/ports/taskAgentRunFamily'
import type { TaskAgentRunPolicy } from '../src/modules/task-execution/application/ports/taskAgentRun'
import type { TaskAgentRunPurpose } from '../src/modules/task-execution/application/ports/taskAgentMaterial'
import type { AgentInvocationBinding } from '../src/modules/task-execution/application/ports/agentInvocation'
import type { NodeRunRuntimePersistence } from '../src/modules/task-execution/application/ports/nodeRunRuntimePersistence'
import type { RuntimeExecutionQueries } from '../src/modules/runtime-management/public/queries'
import { getRuntimeDriver } from '../src/services/runtime'
import { createLogger } from '../src/util/log'

function noRead(): never {
  throw new Error('unselected family operation')
}
function agent(): Agent {
  return {
    id: 'selected-family-agent',
    name: 'selected-family-agent',
    description: '',
    outputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: 'selected persona',
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
  }
}

test('Resource Catalog preserves ordered project/managed declarations and native plugin identity behind content references', () => {
  const home = join(tmpdir(), 'selected-owner-home')
  const selected = composeLocalTaskAgentMaterialReferences({ appHome: home })
  const snapshot: TaskAgentInjectionSnapshot = {
    kind: 'agent-injection',
    root: agent(),
    dependents: [],
    mcps: [],
    skills: [
      { kind: 'managed', skillId: 'first-id', name: 'first', contentVersion: 7 },
      { kind: 'project', name: 'project' },
      { kind: 'managed', skillId: 'last-id', name: 'last', contentVersion: 9 },
    ],
    plugins: [
      {
        id: 'one',
        name: 'one',
        options: { value: 'original' },
        enabled: true,
        runtimeSpecifier: 'file:///native-plugin/main.js',
        resolvedVersion: '8.2',
      },
      {
        id: 'two',
        name: 'two',
        options: {},
        enabled: false,
        runtimeSpecifier: 'file:///disabled-plugin/main.js',
        resolvedVersion: null,
      },
    ],
  }
  const material = selected.references.references(snapshot)
  expect(material.skills.map((skill) => skill.name)).toEqual(['first', 'project', 'last'])
  expect(material.skills.map((skill) => skill.content.version)).toEqual([7, null, 9])
  expect(material.plugins.map((plugin) => plugin.declaration.enabled)).toEqual([true, false])
  expect(material.plugins.map((plugin) => plugin.content.version)).toEqual(['8.2', null])
  expect(selected.contents.skill(material.skills[0]!)).toEqual({
    name: 'first',
    sourceKind: 'managed',
    skillId: 'first-id',
    contentVersion: 7,
    sourcePath: join(home, 'skills', 'first-id', 'files'),
  })
  expect(selected.contents.skill(material.skills[1]!)).toEqual({
    name: 'project',
    sourceKind: 'project',
  })
  expect(selected.contents.plugin(material.plugins[0]!)).toBe(snapshot.plugins[0])
  expect(selected.contents.plugin(material.plugins[1]!)).toBe(snapshot.plugins[1])
  expect('sourcePath' in material.skills[0]!).toBe(false)
  expect('runtimeSpecifier' in material.plugins[0]!.declaration).toBe(false)
})

test('normal family entry selects one whole purpose, waits for the original nonce and keeps mount references lazy', async () => {
  const calls: string[] = [],
    scopes: TaskAgentRunScope[] = []
  let acknowledge!: (value: string) => void
  const nonce = new Promise<string>((resolve) => {
    acknowledge = resolve
  })
  const selectedError = new Error('selected material choice failed')
  const workspace = {
    workspace: { owner: 'source-control' as const, reference: 'working:selected', version: 1 },
    runContent: { owner: 'runtime-management' as const, reference: 'run:selected', version: 1 },
    retainedRef: 'retained:selected',
    prepare: noRead,
    discard: noRead,
  }
  const purpose: TaskAgentRunPurpose = {
    workspace,
    nodeRunPrompts: { store: noRead, read: noRead },
    portArtifacts: { archive: noRead, read: noRead },
    outputWorkspaceRef: workspace.workspace.reference,
    outputValidation: { resolve: noRead },
    gitControlObservation: { capture: noRead },
    selectMaterial(runtime, received) {
      calls.push('material')
      expect(runtime).toBe('opencode')
      expect(received).toBe(workspace)
      throw selectedError
    },
    bindExecutionParticipants: noRead,
  }
  const family: TaskAgentRunFamily = {
    runtimeBindings: { resolve: noRead, ofSession: noRead, internal: noRead },
    materialReferences: { references: noRead },
    open(scope) {
      expect(this).toBe(family)
      calls.push('open')
      scopes.push(scope)
      return purpose
    },
  }
  let mountReads = 0
  const policy = {
    taskId: 'task-selected',
    nodeRunId: 'run-selected',
    runtime: 'opencode',
    log: createLogger('selected-family-nonce'),
    persistence: {
      nodeRuns: {
        loadEnvelopeNonce() {
          calls.push('nonce')
          return nonce
        },
      },
    },
    templateMeta: {
      get repos() {
        mountReads++
        return [{ worktreePath: 'workspace:first' }, { worktreePath: 'workspace:second' }]
      },
    },
  } as unknown as TaskAgentRunPolicy
  const material = Object.freeze({ skills: Object.freeze([]), plugins: Object.freeze([]) })
  const runtimeBinding = Object.freeze({
    owner: 'runtime-management' as const,
    reference: 'runtime:selected',
    version: 1,
  })
  const pending = runTaskAgentWithFamily(family, policy, {
    workspaceRef: 'workspace:chosen',
    material,
    runtimeBinding,
  })
  expect(calls).toEqual(['open', 'nonce'])
  expect(mountReads).toBe(0)
  expect(scopes).toHaveLength(1)
  expect(scopes[0]!.material).toBe(material)
  expect(scopes[0]!.runtimeBinding).toBe(runtimeBinding)
  expect(scopes[0]!.taskId).toBe('task-selected')
  expect(scopes[0]!.nodeRunId).toBe('run-selected')
  acknowledge('persisted-nonce')
  await expect(pending).rejects.toBe(selectedError)
  expect(calls).toEqual(['open', 'nonce', 'material'])
  expect(mountReads).toBe(0)
  expect(scopes[0]!.taskMountRefs()).toEqual(['workspace:first', 'workspace:second'])
  expect(mountReads).toBe(1)
})

for (const protocol of ['opencode', 'claude-code'] as const) {
  test(`local normal family compiles ${protocol} through the selected native definition without legacy buildSpawn`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'aw-task-family-'))
    const working = join(home, 'working')
    mkdirSync(working)
    const legacy = spyOn(getRuntimeDriver(protocol), 'buildSpawn').mockImplementation(noRead)
    let invocation: AgentInvocationBinding | undefined
    try {
      const family = composeLocalTaskAgentRunFamily({
        appHome: home,
        nodeRunRuntime: new Proxy({} as NodeRunRuntimePersistence, { get: noRead }),
        runtimeRegistry: new Proxy({} as RuntimeExecutionQueries, { get: noRead }),
        nodeRunPrompts: { store: noRead, read: noRead },
        portArtifacts: { archive: noRead, read: noRead },
        binaryOverride: [process.execPath, '-e', 'process.exit(0)'],
      })
      const purpose = family.open({
        taskId: 'task',
        nodeRunId: 'run',
        workspaceRef: working,
        material: { skills: [], plugins: [] },
        runtimeBinding: null,
        taskMountRefs: () => [],
      })
      const workspace = purpose.workspace
      const preparation = purpose.selectMaterial(protocol, workspace)
      preparation.prepareMounts()
      const compiled = await preparation.compile({
        protocol,
        injection: { agent: agent(), dependents: [], mcps: [] },
        prompt: 'selected prompt',
        agentName: agent().name,
        systemPrompt: 'selected persona',
        resolvedProfiles: [],
        freshAgentRun: true,
        nodeRunId: 'run',
        log: createLogger('selected-local-family'),
        configDir: DEFAULT_CONFIG_DIR_PROFILE[protocol],
      })
      invocation = compiled.bind()
      expect(legacy).not.toHaveBeenCalled()
      expect(invocation.workspace.workspace.reference).toBe(workspace.workspace.reference)
      expect(typeof invocation.bindExecution).toBe('function')
      expect(purpose.outputWorkspaceRef).toBe(workspace.workspace.reference)
    } finally {
      await invocation?.lifecycle.cleanup?.()
      legacy.mockRestore()
      rmSync(home, { recursive: true, force: true })
    }
  })
}
