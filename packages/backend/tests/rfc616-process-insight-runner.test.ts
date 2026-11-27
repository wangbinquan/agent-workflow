// RFC-616 §9.3 — the model call of a text-theme analysis.
//
// The analysis runs on the ordinary system-agent family, so its consumption is
// recorded by run observation like any other platform call. Locks: the call is
// declared as system work of kind `process-insight`, owned by whoever asked and
// attached to no task; the runtime is the one chosen in settings, falling back
// to the default runtime through the registry's rule for internal agents, and is
// read at the moment of each call; the answer is the run's text; a run that did
// not end well is reported with its reason; retained content is always let go.
import { describe, expect, test } from 'bun:test'
import { composeProcessInsightRunner } from '@/modules/task-execution/composition/processInsightRunner'
import { emptySystemAgentOutputEvidence } from '@/modules/task-execution/application/systemAgentRun'
import type {
  PreparedSystemAgentRunResult,
  SystemAgentRunFamily,
  SystemAgentRunRequest,
} from '@/modules/task-execution/public/participants'
import type { RuntimeExecutionQueries } from '@/modules/runtime-management/public/queries'
import type { ResolvedRuntimeProfile } from '@/modules/runtime-management/public/types'

const runtimeBinding = Object.freeze({
  owner: 'runtime-management',
  reference: 'runtime:profile-7',
  version: '7',
})

function profile(name: string): ResolvedRuntimeProfile {
  return {
    name,
    protocol: 'claude-code',
    binaryPath: `/opt/${name}/bin`,
    configDir: { env: 'CLAUDE_CONFIG_DIR', name: '.claude' },
    model: `${name}-model`,
    variant: null,
    temperature: null,
    steps: null,
    maxSteps: null,
    isSandbox: true,
  }
}

function result(over: Partial<PreparedSystemAgentRunResult> = {}): PreparedSystemAgentRunResult {
  return {
    status: 'ok',
    exitCode: 0,
    eventText: '{"groups":[]}',
    stderrTail: '',
    durationMs: 12,
    retainedRef: 'retained:run-1',
    scratchRetained: false,
    outputEvidence: emptySystemAgentOutputEvidence(),
    ...over,
  }
}

function setup(next: () => PreparedSystemAgentRunResult = result) {
  const runs: SystemAgentRunRequest[] = []
  const resolved: unknown[] = []
  const forgotten: string[] = []
  const settings = { runtimeName: null as string | null, defaultRuntime: 'main' as string | null }
  const family: SystemAgentRunFamily = {
    workspaces: {
      capture: (input) => Object.freeze({ namespace: input.namespace, name: input.name }),
      withName: (scope, name) => Object.freeze({ namespace: scope.namespace, name }),
    },
    async run(request) {
      runs.push(request)
      return next()
    },
    retainedContents: {
      forget(input) {
        forgotten.push(input.retainedRef)
      },
      release: () => ({ removed: true }),
    },
  }
  const registry = {
    async resolveInternalAgentRuntime(input: {
      runtimeName?: string | null
      defaultRuntime?: string | null
    }) {
      resolved.push(input)
      return profile(input.runtimeName ?? input.defaultRuntime ?? 'builtin')
    },
  } as unknown as RuntimeExecutionQueries
  const runner = composeProcessInsightRunner({
    registry,
    binding: {
      family,
      // What the session's binding does: the executable path becomes an opaque runtime reference.
      bindRuntime: ({ binaryPath: _binaryPath, ...rest }) => ({ ...rest, runtimeBinding }),
    },
    runtimeSelection: async () => ({ ...settings }),
  })
  return { runner, runs, resolved, forgotten, settings }
}

const request = {
  analysisId: 'an-1',
  attempt: 1,
  prompt: 'Group these review comments.',
  ownerUserId: 'alice',
  subjectName: 'Requirement to merge',
}

describe('RFC-616 process insight runner', () => {
  test('the call is system work of kind process-insight, owned by the requester and tied to no task', async () => {
    const { runner, runs } = setup()
    expect(await runner.run(request)).toEqual({ ok: true, answer: '{"groups":[]}' })
    expect(runs).toHaveLength(1)
    const run = runs[0]!
    expect(run.feature).toBe('process-insight')
    expect(run.agentName).toBe('process-insight')
    expect(run.observationDemand).toEqual({
      kind: 'process-insight',
      originalId: 'an-1',
      originalAttempt: 'an-1:1',
      name: '过程主题分析 · Requirement to merge',
      ownerUserId: 'alice',
      purpose: 'system',
    })
    expect(run.observationDemand).not.toHaveProperty('parentTaskId')
    expect(run.prompt).toBe('Group these review comments.')
    // The agent is told to analyse text only; the instruction is the platform's, not the requester's.
    expect(run.systemPrompt).toContain('you do not perform tasks, read files or call tools')
    expect(run.workspaceScope).toEqual({ namespace: 'shared', name: undefined })
    expect(run.timeoutMs).toBe(600_000)
  })

  test('a retry is a second call with its own attempt identity; a scheduled analysis has no owner', async () => {
    const { runner, runs } = setup()
    await runner.run({ ...request, attempt: 2, ownerUserId: null })
    expect(runs[0]!.observationDemand).toEqual({
      kind: 'process-insight',
      originalId: 'an-1',
      originalAttempt: 'an-1:2',
      name: '过程主题分析 · Requirement to merge',
      purpose: 'system',
    })
  })

  test('the runtime is the configured one, else the default, read at the moment of each call', async () => {
    const { runner, runs, resolved, settings } = setup()
    await runner.run(request)
    settings.runtimeName = 'analysis'
    await runner.run(request)
    settings.runtimeName = null
    settings.defaultRuntime = null
    await runner.run(request)
    expect(resolved).toEqual([
      { runtimeName: null, defaultRuntime: 'main' },
      { runtimeName: 'analysis', defaultRuntime: 'main' },
      { runtimeName: null, defaultRuntime: null },
    ])
    expect(runs.map((run) => run.model)).toEqual(['main-model', 'analysis-model', 'builtin-model'])
    expect(runs[1]).toMatchObject({
      protocol: 'claude-code',
      runtimeBinding,
      configDirEnv: 'CLAUDE_CONFIG_DIR',
      configDirName: '.claude',
      isSandbox: true,
    })
    // The executable path never reaches the family.
    expect(Object.hasOwn(runs[1]!, 'binaryPath')).toBe(false)
    expect(Object.hasOwn(runs[1]!, 'runtimeObservationIdentity')).toBe(false)
  })

  test('a run that did not end well is reported with its reason', async () => {
    const timeout = setup(() => result({ status: 'timeout', stderrTail: 'no output for 600 s' }))
    expect(await timeout.runner.run(request)).toEqual({
      ok: false,
      code: 'run-timeout',
      message: 'no output for 600 s',
    })
    const refused = setup(() =>
      result({ status: 'result-error', resultError: 'API key is not valid', stderrTail: 'tail' }),
    )
    expect(await refused.runner.run(request)).toEqual({
      ok: false,
      code: 'run-result-error',
      message: 'API key is not valid',
    })
  })

  test('retained content is let go whether the run ended well or not', async () => {
    const good = setup()
    await good.runner.run(request)
    expect(good.forgotten).toEqual(['retained:run-1'])
    const bad = setup(() => result({ status: 'exit-nonzero', retainedRef: 'retained:run-2' }))
    await bad.runner.run(request)
    expect(bad.forgotten).toEqual(['retained:run-2'])
  })
})
