import { expect, spyOn, test } from 'bun:test'
import {
  bindNativeTaskAgentRunPurpose,
  runNativeTaskAgent,
} from '../src/modules/task-execution/infrastructure/local/nativeTaskAgentRun'
import type { RunNodeOptions } from '../src/modules/task-execution/infrastructure/local/nativeTaskAgentRunOptions'
import type { TaskAgentMaterialDeclaration } from '../src/modules/task-execution/application/ports/taskAgentMaterial'
import type { AgentSpawnPlan } from '../src/services/runtime/types'
import { getRuntimeDriver } from '../src/services/runtime'
import { emptyDeclaredManifest } from '../src/services/execution/agentInjection'
import { createLogger } from '../src/util/log'

function noRead(): never {
  throw new Error('premature native options read')
}

test('native Task purpose construction reads no option, registry, workspace or content', () => {
  const options = new Proxy({} as RunNodeOptions, { get: noRead })
  const purpose = bindNativeTaskAgentRunPurpose(options)
  expect(typeof purpose.selectMaterial).toBe('function')
  expect(typeof purpose.bindExecutionParticipants).toBe('function')
})

test('native runtime lookup remains after envelope nonce acknowledgement and outside material failure handling', async () => {
  let acknowledge!: (nonce: string) => void
  const nonce = new Promise<string>((resolve) => {
    acknowledge = resolve
  })
  const reads: string[] = []
  const options = {
    nodeRunPrompts: { store: noRead, read: noRead },
    portArtifacts: { archive: noRead, read: noRead },
    appHome: '/selected-native-compatibility-home',
    taskId: 'task',
    nodeRunId: 'run',
    log: createLogger('native-nonce-test'),
    persistence: {
      nodeRuns: {
        loadEnvelopeNonce() {
          reads.push('nonce')
          return nonce
        },
        set: noRead,
      },
    },
    get runtime() {
      reads.push('runtime')
      return 'unsupported-fixture-protocol'
    },
  } as unknown as RunNodeOptions
  const pending = runNativeTaskAgent(options)
  expect(reads).toEqual(['nonce'])
  acknowledge('')
  await expect(pending).rejects.toThrow("unknown runtime kind 'unsupported-fixture-protocol'")
  expect(reads).toEqual(['nonce', 'runtime'])
})

test('native material keeps fixture presence, early command, late evidence/diagnostics and cleanup receiver', async () => {
  const driver = getRuntimeDriver('opencode'),
    log = createLogger('native-task-material-test')
  const originalCommand = ['fixture-binary', 'original'],
    originalEnvironment = { SELECTED: 'original' }
  const laterEnvironment = { SELECTED: 'later' }
  const state = {
    cwd: '/original-working',
    binaryReads: 0,
    reports: [] as unknown[],
    mcpNames: ['early'],
  }
  const plan: AgentSpawnPlan = {
    cmd: originalCommand,
    env: originalEnvironment,
    declared: emptyDeclaredManifest(),
    get diagnostics() {
      return { originalFixtureFact: '保留', lateWorkingLabel: state.cwd }
    },
    get declaredMcpServers() {
      return state.mcpNames
    },
    cleanup() {
      expect(this).toBe(plan)
    },
  }
  const build = spyOn(driver, 'buildSpawn').mockImplementation(async (context) => {
    // Undefined alone omits the original fixture property.
    expect(Object.prototype.hasOwnProperty.call(context, 'binaryOverride')).toBe(false)
    expect(context.injection.skills).toBeUndefined()
    expect(context.cwd).toBe('/original-working')
    return plan
  })
  const normalize = () => ({ measurements: [], diagnostics: [] })
  const usage = spyOn(driver, 'prepareUsageNormalizer').mockImplementation((context) => {
    expect(context.env).toBe(laterEnvironment)
    return normalize
  })
  const report = spyOn(log, 'info').mockImplementation((message, fields) => {
    expect(message).toBe('spawning agent runtime')
    state.reports.push(fields)
  })
  try {
    const options = {
      appHome: '/selected-native-compatibility-home',
      taskId: 'task',
      nodeRunId: 'run',
      skills: undefined,
      get worktreePath() {
        return state.cwd
      },
      templateMeta: { repos: [] },
      get binaryOverride() {
        state.binaryReads++
        return undefined
      },
    } as unknown as RunNodeOptions
    const purpose = bindNativeTaskAgentRunPurpose(options),
      workspace = purpose.workspace
    const preparation = purpose.selectMaterial('opencode', workspace)
    preparation.prepareMounts()
    const declaration: TaskAgentMaterialDeclaration = {
      protocol: 'opencode',
      injection: { mcps: [] },
      prompt: '最终 prompt',
      agentName: 'agent',
      systemPrompt: 'persona',
      resolvedProfiles: [],
      freshAgentRun: true,
      nodeRunId: 'run',
      log,
      configDir: { env: 'SELECTED_CONFIG', name: '.selected' },
    }
    const compiled = await preparation.compile(declaration)
    const invocation = compiled.bind()
    expect(build).toHaveBeenCalledTimes(1)
    expect(state.binaryReads).toBe(1)
    plan.cmd = ['late-command']
    plan.env = laterEnvironment
    state.cwd = '/late-working'
    state.mcpNames = ['late']
    compiled.reportSpawn(log, { runtime: 'opencode', agentName: 'agent', nodeRunId: 'run' })
    expect(state.reports).toEqual([
      {
        runtime: 'opencode',
        bin: 'fixture-binary',
        agent: 'agent',
        cwd: '/late-working',
        nodeRunId: 'run',
        originalFixtureFact: '保留',
        lateWorkingLabel: '/late-working',
      },
    ])
    expect(compiled.readDeclaredMcpServers()).toBe(state.mcpNames)
    expect(invocation.evidence.prepareUsageNormalizer?.()).toBe(normalize)
    await invocation.lifecycle.cleanup?.()
  } finally {
    build.mockRestore()
    usage.mockRestore()
    report.mockRestore()
  }
})
