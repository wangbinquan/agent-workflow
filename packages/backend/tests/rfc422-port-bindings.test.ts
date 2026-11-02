// RFC-422: the run family openers moved from task-execution composition into infrastructure, receiving other modules'
// implementations through task-execution's provider ports. These cases drive each opener through its family with
// fake providers and lock the moved behavior: the local system agent's content reference checks and missing persona
// contents, the local smoke binding its workspace at materialize from the app home, the hosted system agent's
// invocation id (derived from the observation demand when there is one) and release judgment, and the hosted probe's
// shared smoke workspace, release judgment and budget.
import { expect, test } from 'bun:test'
import { sha256Hex } from '@/util/hash'
import { createLocalSystemAgentRunFamily } from '@/modules/task-execution/infrastructure/local/systemAgentRunFamily'
import { createLocalRuntimeSmokeRunFamily } from '@/modules/task-execution/infrastructure/local/runtimeSmokeRunFamily'
import { createHostedSystemAgentRunFamily } from '@/modules/task-execution/infrastructure/crewstation/systemAgentRunFamily'
import {
  createHostedRuntimeSmokeProbe,
  HOSTED_RUNTIME_PROBE_BUDGET_MS,
} from '@/modules/task-execution/infrastructure/crewstation/runtimeSmokeRunFamily'
import type { NativeMaterialContents } from '@/modules/task-execution/infrastructure/local/nativeRunFamilyProviders'

const log = { warn() {}, info() {}, error() {}, debug() {} }

function failingWorkspace(extra: Record<string, unknown> = {}) {
  return {
    retainedRef: 'retained-1',
    prepare() {
      throw new Error('no scratch')
    },
    discard() {},
    ...extra,
  }
}

test('the local system agent opener checks content references and offers no persona skill or plugin', async () => {
  const workspaceRef = { owner: 'source-control', reference: 'ws', version: null }
  const runRef = { owner: 'runtime-management', reference: 'run', version: null }
  const captured: { contents?: NativeMaterialContents } = {}
  const bindRuntime = () => 'bound'
  const family = createLocalSystemAgentRunFamily({ appHome: () => '/home' }, {
    runtimes: { contents: { runtimeBinary: () => '/bin/agent' }, bindRuntime },
    contents: {
      workspaces: {},
      contents: { forget() {} },
      open: () => ({
        workspace: failingWorkspace({ workspace: workspaceRef, runContent: runRef }),
        locations: { workingDirectory: '/work', runDirectory: '/run' },
      }),
      parent: () => '/parent',
      bindFixtureRetainedResult() {},
    },
    materialDefinitions: () => ({
      protocol: { sentinel: 'protocol' },
      evidenceHooks: {},
      createCompiler(contents: NativeMaterialContents) {
        captured.contents = contents
        return { compiler: { compile: async () => ({}) }, nativePlan: () => ({}) }
      },
    }),
  } as never)
  expect(family.bindRuntime).toBe(bindRuntime as never)
  const result = await family.family.run({
    feature: 'probe',
    protocol: 'opencode',
    workspaceScope: {},
    log,
  } as never)
  expect(result.status).toBe('spawn-failed')
  const contents = captured.contents!
  expect(contents.workspace(workspaceRef as never)).toBe('/work')
  expect(() => contents.workspace({ ...workspaceRef } as never)).toThrow(
    'system-working-content-reference-unavailable',
  )
  expect(contents.runContent(runRef as never)).toBe('/run')
  expect(() => contents.runContent({ ...runRef } as never)).toThrow(
    'system-run-content-reference-unavailable',
  )
  expect(contents.runtimeBinary({} as never)).toBe('/bin/agent')
  expect(() => contents.skill({} as never)).toThrow('system-persona-skill-content-unavailable')
  expect(() => contents.plugin({} as never)).toThrow('system-persona-plugin-content-unavailable')
})

test('the local smoke opener binds the smoke workspace at materialize, from the app home', async () => {
  const bound: unknown[] = []
  const family = createLocalRuntimeSmokeRunFamily(
    {
      appHome: () => '/home',
      targets: { runtimeBinding: () => ({}), contents: { runtimeBinary: () => '/bin' } },
    } as never,
    {
      materialWorkspaces: (request: unknown) => {
        bound.push(request)
        return {
          workspace: failingWorkspace(),
          locations: { workingDirectory: '/w', runDirectory: '/r' },
        }
      },
      materialDefinitions: () => {
        throw new Error('material not selected before compile')
      },
      bindProtocol: () => ({}),
    } as never,
  )
  await expect(family.run({ protocol: 'opencode', target: {}, log } as never)).rejects.toThrow(
    'no scratch',
  )
  expect(bound).toEqual([{ kind: 'smoke', appHome: '/home' }])
})

function hostedContents() {
  const opened: { invocationId: string; scope: unknown }[] = []
  const captures: unknown[] = []
  const judged: {
    canRelease?: (taskId: string, invocationId: string, path: string) => Promise<boolean>
  } = {}
  const factory = (input: {
    canRelease: (taskId: string, invocationId: string, path: string) => Promise<boolean>
  }) => {
    judged.canRelease = input.canRelease
    return {
      workspaces: {
        capture(scope: unknown) {
          captures.push(scope)
          return scope
        },
      },
      contents: { forget() {} },
      open(request: { invocationId: string; scope: unknown }) {
        opened.push(request)
        return { workspace: failingWorkspace(), taskId: 'system:shared', cwd: '/work/system' }
      },
    }
  }
  return { opened, captures, judged, factory }
}

function hostedExecutions() {
  const found: string[] = []
  const state: { execution: { state: string } | null } = { execution: null }
  return {
    found,
    state,
    executions: {
      async find(id: string) {
        found.push(id)
        return state.execution
      },
      async workspaceSettled() {
        return true
      },
    },
  }
}

test('the hosted system agent opener derives its invocation id from the demand and judges release by the execution', async () => {
  const { opened, judged, factory } = hostedContents()
  const { found, state, executions } = hostedExecutions()
  const family = createHostedSystemAgentRunFamily(
    { executions, helper: {}, reference: () => 'ref' } as never,
    {},
    { contents: factory } as never,
  )
  const demand = { kind: 'review', originalId: 'run-1', originalAttempt: 'attempt-1' }
  await family.run({
    feature: 'narrate',
    workspaceScope: {},
    observationDemand: demand,
    log,
  } as never)
  expect(opened[0]!.invocationId).toBe(
    sha256Hex(JSON.stringify(['narrate', 'review', 'run-1', 'attempt-1'])),
  )
  await family.run({ feature: 'narrate', workspaceScope: {}, log } as never)
  expect(opened[1]!.invocationId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  )
  expect(await judged.canRelease!('system:intent', 'inv-1', '/work')).toBe(true)
  expect(found).toEqual(['agent:system:intent:system:inv-1'])
  state.execution = { state: 'running' }
  expect(await judged.canRelease!('system:intent', 'inv-1', '/work')).toBe(false)
  state.execution = { state: 'settled' }
  expect(await judged.canRelease!('system:intent', 'inv-1', '/work')).toBe(true)
})

test('the hosted probe opens its smoke in the shared system workspace within the probe budget', async () => {
  const { opened, captures, judged, factory } = hostedContents()
  const { found, state, executions } = hostedExecutions()
  const probe = createHostedRuntimeSmokeProbe(
    { executions, helper: {}, reference: () => 'ref' } as never,
    {},
    { contents: factory } as never,
  )
  await expect(
    probe({ protocol: 'opencode', target: { runtimeBinding: null }, log } as never),
  ).rejects.toThrow('no scratch')
  expect(captures).toEqual([{ namespace: 'shared' }])
  expect(opened[0]!.invocationId).toMatch(/^smoke-[0-9a-f-]{36}$/)
  expect(await judged.canRelease!('system:shared', 'smoke-1', '/work')).toBe(true)
  expect(found).toEqual(['agent:system:shared:smoke-1'])
  state.execution = { state: 'running' }
  expect(await judged.canRelease!('system:shared', 'smoke-1', '/work')).toBe(false)
  expect(HOSTED_RUNTIME_PROBE_BUDGET_MS).toBe(240_000)
})
