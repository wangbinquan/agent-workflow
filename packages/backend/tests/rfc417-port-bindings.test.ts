// RFC-417: the hosted (CrewStation) task run scope and the execution owner's adapter logic moved from composition into
// task-execution infrastructure as standalone functions. These cases lock what composition used to do inline and now
// only wires: the capability cache window and in-flight sharing, the per-profile capability judgement, owner-routed
// helper commands, the command reconciliation loop, the three Intent scratch release branches, and the run scope
// (workspace references, helper-backed seeds / observation / validation, invocation ID and the managed-skill staging
// rule down to the platform material request). The recovery proof stays in composition: RFC-328 lets only
// composition/bootRecovery.ts mint it.
import { expect, test } from 'bun:test'
import {
  createCachedHostedCapabilities,
  hostedProfileCapability,
} from '@/modules/task-execution/infrastructure/crewstation/hostedCapabilities'
import { createOwnerRoutedWorkspaceHelper } from '@/modules/task-execution/infrastructure/crewstation/executionWorkspaces'
import { createHostedWorkspaceCommandReconciliation } from '@/modules/task-execution/infrastructure/crewstation/workspaceCommandReconciliation'
import { createHostedIntentScratchRelease } from '@/modules/task-execution/infrastructure/crewstation/intentScratchRelease'
import { openHostedTaskAgentRun } from '@/modules/task-execution/infrastructure/crewstation/taskAgentRunScope'
import { createHostedAgentParticipants } from '@/modules/task-execution/infrastructure/crewstation/agentInvocationPreparation'
import { sha256Hex } from '@/util/hash'
import { createLogger } from '@/util/log'

const capabilitiesOf = (marker: string) =>
  ({
    marker,
    agentProfiles: [
      {
        agentProfileId: 'p1',
        capabilities: { nativeConfigVersion: 1, startupInventoryVersion: 0 },
      },
    ],
  }) as never

test('the capability cache serves one read per 30 s window and shares an in-flight read', async () => {
  let now = 1_000
  let reads = 0
  let release: (value: never) => void = () => undefined
  const cached = createCachedHostedCapabilities(
    () => {
      reads += 1
      return new Promise<never>((resolve) => {
        release = resolve
      })
    },
    () => now,
  )
  const first = cached()
  const second = cached()
  expect(reads).toBe(1)
  const a = capabilitiesOf('a')
  release(a)
  expect(await first).toBe(a)
  expect(await second).toBe(a)
  now += 29_999
  expect(await cached()).toBe(a)
  expect(reads).toBe(1)
  now += 1
  const third = cached()
  expect(reads).toBe(2)
  const b = capabilitiesOf('b')
  release(b)
  expect(await third).toBe(b)
})

test('a profile capability counts only for the same profile at version 1', async () => {
  const capability = hostedProfileCapability(async () => capabilitiesOf('a'))
  expect(await capability('nativeConfigVersion')('p1')).toBe(true)
  expect(await capability('nativeConfigVersion')('p2')).toBe(false)
  expect(await capability('startupInventoryVersion')('p1')).toBe(false)
  expect(await capability('materialObjectsVersion')('p1')).toBe(false)
})

test('helper commands address the physical owner of the logical task', async () => {
  const calls: unknown[][] = []
  const helper = createOwnerRoutedWorkspaceHelper(
    {
      call: async (...args: unknown[]) => {
        calls.push(['call', ...args])
        return 'called' as never
      },
      recover: async (...args: unknown[]) => {
        calls.push(['recover', ...args])
        return null
      },
    } as never,
    async (taskId) => (taskId === 'child' ? 'parent' : taskId),
  )
  expect(await helper.call('child', 'git-control', { path: '/w' }, { operationId: 'op-1' })).toBe(
    'called',
  )
  expect(await helper.recover('child', 'op-1')).toBeNull()
  expect(calls).toEqual([
    ['call', 'parent', 'git-control', { path: '/w' }, { operationId: 'op-1' }],
    ['recover', 'parent', 'op-1'],
  ])
})

test('command reconciliation logs a failed pass, keeps its identity and stops on abort', async () => {
  const warns: unknown[][] = []
  let passes = 0
  const owner = createHostedWorkspaceCommandReconciliation({
    commands: {
      reconcile: async () => {
        passes += 1
        throw new Error('rfc417-boom')
      },
    } as never,
    log: { warn: (...args: unknown[]) => void warns.push(args) },
  })
  expect(owner.id).toBe('hosted-workspace-command-reconciliation')
  const controller = new AbortController()
  const running = owner.run(controller.signal)
  controller.abort()
  await running
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(passes).toBe(1)
  expect(warns).toEqual([
    ['hosted workspace command reconciliation failed', { reason: 'rfc417-boom' }],
  ])
  const aborted = new AbortController()
  aborted.abort()
  await owner.run(aborted.signal)
  expect(passes).toBe(1)
})

function scratchRelease(input: { settled: boolean; parent: boolean; removed: boolean }) {
  const events: unknown[][] = []
  const release = createHostedIntentScratchRelease({
    executions: {
      workspaceSettled: async (...args: unknown[]) => {
        events.push(['settled', ...args])
        return input.settled
      },
    } as never,
    helper: {
      call: async (...args: unknown[]) => {
        events.push(['helper', ...args])
        return { removed: input.removed } as never
      },
    } as never,
    workspaces: { find: async () => (input.parent ? { businessTaskId: 'biz' } : null) },
  })
  return { release, events }
}

test('Intent scratch is released only after its executions settled, through the helper', async () => {
  const key = sha256Hex('turn-1')
  const unsettled = scratchRelease({ settled: false, parent: true, removed: true })
  await expect(unsettled.release.removeIntentScratch('turn-1')).rejects.toThrow(
    'hosted-intent-scratch-execution-unsettled',
  )
  expect(unsettled.events).toEqual([['settled', 'system:intent', `/work/system/intent/${key}`]])
  const orphan = scratchRelease({ settled: true, parent: false, removed: true })
  expect(await orphan.release.removeIntentScratch('turn-1')).toBeUndefined()
  expect(orphan.events).toHaveLength(1)
  const refused = scratchRelease({ settled: true, parent: true, removed: false })
  await expect(refused.release.removeIntentScratch('turn-1')).rejects.toThrow(
    'hosted-intent-scratch-release-failed',
  )
  const released = scratchRelease({ settled: true, parent: true, removed: true })
  await released.release.removeIntentScratch('turn-1')
  expect(released.events[1]).toEqual([
    'helper',
    'system:intent',
    'system-workspace',
    { method: 'release', namespace: 'intent', key },
    { operationId: 'intent-scratch:turn-1:retention' },
  ])
})

function runScope(skills: readonly Record<string, unknown>[]) {
  const helperCalls: unknown[][] = []
  const materials: unknown[][] = []
  const info: unknown[][] = []
  const nodeRunPrompts = { marker: 'prompts' } as never
  const portArtifacts = { marker: 'artifacts' } as never
  const participants = createHostedAgentParticipants()
  const input = {
    executions: { find: async () => null },
    profiles: [{ protocol: 'opencode', model: null, agentProfileId: 'p1' }],
    api: {
      createMaterial: async (...args: unknown[]) => {
        materials.push(args)
        return { materialId: 'material-1' }
      },
    },
    fence: { current: () => 'fence-1' },
    helper: {
      call: async (...args: unknown[]) => {
        helperCalls.push(args)
        return 'helped'
      },
    },
    skills: {
      readTree: async (skill: unknown) => {
        helperCalls.push(['readTree', skill])
        return [{ path: 'SKILL.md', bytes: new TextEncoder().encode('hello') }]
      },
    },
    locate: (reference: string) => ({ taskId: `phys-of-${reference}`, path: `/work/${reference}` }),
    reference: (taskId: string, path: string) => `ref:${taskId}:${path}`,
  } as never
  const purpose = openHostedTaskAgentRun(
    input,
    {
      binding: { nodeRunPrompts, portArtifacts },
      physical: { businessTaskId: 'biz-1' },
      participants,
    },
    {
      taskId: 'task-1',
      nodeRunId: 'nr-1',
      workspaceRef: 'ws',
      material: { skills } as never,
      runtimeBinding: undefined,
      taskMountRefs: () => ['mount-a'],
    },
  )
  const log = { ...createLogger('rfc417'), info: (...args: unknown[]) => void info.push(args) }
  const declaration = {
    protocol: 'opencode',
    injection: { mcps: [] },
    prompt: 'do it',
    agentName: 'worker',
    systemPrompt: 'system',
    resolvedProfiles: [],
    freshAgentRun: false,
    nodeRunId: 'nr-1',
    log,
  } as never
  return {
    purpose,
    helperCalls,
    materials,
    info,
    nodeRunPrompts,
    portArtifacts,
    participants,
    declaration,
    log,
  }
}

test('the hosted run scope keeps its references, helper calls, invocation ID and participants', async () => {
  const run = runScope([])
  const { purpose } = run
  expect(purpose.invocationId).toBe('hosted-agent:nr-1')
  expect(purpose.nodeRunPrompts).toBe(run.nodeRunPrompts)
  expect(purpose.portArtifacts).toBe(run.portArtifacts)
  expect(purpose.outputWorkspaceRef).toBe('ws')
  expect(purpose.workspace.workspace).toEqual({
    owner: 'source-control',
    reference: 'ws',
    version: null,
  })
  expect(purpose.workspace.runContent).toEqual({
    owner: 'runtime-management',
    reference: 'ref:phys-of-ws:/work/runs/task-1/nr-1',
    version: null,
  })
  expect(purpose.workspace.retainedRef).toBe('ref:phys-of-ws:/work/runs/task-1/nr-1')
  expect(purpose.bindExecutionParticipants).toBe(run.participants.bind)
  await purpose.workspace.prepare([{ path: 'seed.txt', content: 'x' }])
  // The fake helper answers every call with the same marker; the scope returns the helper's answer unchanged.
  expect(await purpose.gitControlObservation.capture()).toBe('helped' as never)
  expect(
    await purpose.outputValidation.resolve({
      rawContent: 'raw',
      kind: 'text',
      port: 'out',
      workspaceRef: 'other',
    } as never),
  ).toBe('helped' as never)
  expect(run.helperCalls).toEqual([
    [
      'task-1',
      'write-seeds',
      { path: '/work/runs/task-1/nr-1', files: [{ path: 'seed.txt', content: 'x' }] },
      { operationId: 'agent-content:nr-1' },
    ],
    ['phys-of-ws', 'git-control', { path: '/work/ws' }],
    [
      'phys-of-ws',
      'validate-output',
      { rawContent: 'raw', kind: 'text', port: 'out', worktreePath: '/work/other' },
    ],
  ])
})

test('the hosted run scope stages only versioned managed skills into the platform material', async () => {
  const run = runScope([
    { name: 'managed-a', sourceKind: 'managed', skillId: 'skill-a', contentVersion: 3 },
    { name: 'project-b', sourceKind: 'project' },
  ])
  const material = run.purpose.selectMaterial('opencode', run.purpose.workspace)
  material.prepareMounts()
  const compiled = await material.compile(run.declaration)
  expect(run.helperCalls).toEqual([
    ['readTree', { id: 'skill-a', name: 'managed-a', contentVersion: 3 }],
  ])
  expect(run.materials).toHaveLength(1)
  const [businessTaskId, request] = run.materials[0] as [string, Record<string, unknown>]
  expect(businessTaskId).toBe('biz-1')
  expect(request.skills).toEqual([{ path: 'managed-a/SKILL.md', content: 'hello' }])
  expect(request.fence).toBe('fence-1')
  expect(compiled.readDeclaredMcpServers()).toEqual([])
  expect(compiled.detectPluginLoadFailure('any line')).toBeNull()
  compiled.reportSpawn(run.log as never, { pid: 1 } as never)
  expect(run.info).toEqual([['crewstation agent execution', { pid: 1, businessTaskId: 'biz-1' }]])
})

test('a managed skill without a content version is refused before any platform request', async () => {
  const run = runScope([{ name: 'managed-a', sourceKind: 'managed', skillId: 'skill-a' }])
  const material = run.purpose.selectMaterial('opencode', run.purpose.workspace)
  material.prepareMounts()
  await expect(material.compile(run.declaration)).rejects.toThrow('hosted-skill-version-required')
  expect(run.materials).toEqual([])
})
