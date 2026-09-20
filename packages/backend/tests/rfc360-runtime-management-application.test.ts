// RFC-360: the moved use cases preserve management behavior over both real databases.
// Effects are injected; registry writes/receipt storage use the actual provider implementation.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createRuntimeProfileConfigurationCommands } from '../src/modules/runtime-management/application/runtimeConfiguration'
import { createRuntimeManagement } from '../src/modules/runtime-management/application/runtimeManagement'
import type {
  RuntimeManagementConfig,
  RuntimeManagementDependencies,
  RuntimeSmokeRequest,
} from '../src/modules/runtime-management/application/ports/runtimeManagement'
import type { RuntimeSmokeResult } from '../src/modules/runtime-management/public/types'
import { composeRuntimeRegistryOperations } from './helpers/runtimeRegistryComposition'
import { composeRuntimeRegistryOperations as composeRegistry } from '../src/modules/runtime-management/composition/runtimeRegistry'
import { composeRuntimeProfileParticipants } from '../src/modules/resource-catalog/composition/runtimeProfileParticipants'
import { runtimes } from '../src/db/schema'
import { describeEachProvider } from './helpers/eachProvider'

const advisoryFailure: RuntimeSmokeResult = {
  outcome: 'model-call-failed',
  conforms: false,
  detail: 'fixture model is unavailable',
  sawNonce: false,
  sawEnvelope: false,
  exitCode: 1,
}

describeEachProvider('RFC-360 runtime management application', (harness) => {
  async function setup() {
    const registry = composeRuntimeRegistryOperations(harness.db)
    await registry.seedBuiltinRuntimes()
    let currentConfig: RuntimeManagementConfig = {
      defaultRuntime: 'opencode',
      opencodePath: 'first-opencode',
      claudeCodePath: 'first-claude',
    }
    const probes: RuntimeSmokeRequest[] = []
    const models: { protocol: string; binary: string; refresh: boolean }[] = []
    let reconciles = 0
    const dependencies: RuntimeManagementDependencies = {
      registry,
      config: {
        current: () => currentConfig,
        withProbeReceiptFence: (action) => action(),
      },
      drivers: {
        resolveBinary: (row, config) =>
          row.binaryPath ??
          (row.protocol === 'opencode' ? config.opencodePath : config.claudeCodePath) ??
          row.protocol,
        async probeStatus(protocol, binary) {
          return {
            binary,
            version: 'fixture-version',
            compatible: protocol === 'opencode',
            ran: true,
          }
        },
        async smoke(input) {
          probes.push(input)
          return advisoryFailure
        },
        assertSpawnCapabilities() {},
      },
      modelDiscovery: {
        resolveBinary: (protocol, binaryPath, config) =>
          binaryPath ??
          (protocol === 'opencode' ? config.opencodePath : config.claudeCodePath) ??
          protocol,
        async list(protocol, binary, refresh) {
          models.push({ protocol, binary, refresh })
          return { binary, models: [{ id: `${protocol}-model` }], cached: false }
        },
      },
      tests: {
        eligible: (row) => row.protocol === 'opencode',
        async reconcile() {
          reconciles++
        },
      },
      statusProbeTimeoutMs: 5000,
      beforeProbeReceipt() {},
    }
    return {
      registry,
      dependencies,
      application: createRuntimeManagement(dependencies),
      probes,
      models,
      setConfig(next: RuntimeManagementConfig) {
        currentConfig = next
      },
      reconciles: () => reconciles,
    }
  }

  test('root-injected invalidation failure rolls back the registry update', async () => {
    const participants = composeRuntimeProfileParticipants()
    let calls = 0
    const registry = composeRegistry(harness.db, {
      ...participants,
      testInvalidation: {
        ...participants.testInvalidation,
        async invalidate(transaction, input) {
          await participants.testInvalidation.invalidate(transaction, input)
          calls++
          throw new Error('root-injected-invalidation-failed')
        },
      },
    })
    await registry.createRuntime({ name: 'root-injection', protocol: 'opencode' })
    const before = await registry.getRuntime('root-injection')
    await expect(
      registry.updateRuntime('root-injection', { binaryPath: '/changed/runtime' }),
    ).rejects.toThrow('root-injected-invalidation-failed')
    expect(calls).toBe(1)
    expect(await registry.getRuntime('root-injection')).toEqual(before)
  })

  test('config default validation keeps disabled, unchanged and unknown-name behavior', async () => {
    const h = await setup()
    await h.registry.createRuntime({ name: 'disabled-profile', protocol: 'opencode' })
    await h.registry.setRuntimeEnabled('disabled-profile', false, 'opencode')
    const commands = createRuntimeProfileConfigurationCommands(h.registry)
    await expect(
      commands.validateDefaultChange({ previous: 'opencode', next: 'disabled-profile' }),
    ).rejects.toMatchObject({
      code: 'runtime-disabled',
      message: "cannot make disabled runtime 'disabled-profile' the default; enable it first",
    })
    await expect(
      commands.validateDefaultChange({ previous: 'disabled-profile', next: 'disabled-profile' }),
    ).resolves.toBeUndefined()
    await expect(
      commands.validateDefaultChange({ previous: 'opencode', next: 'not-registered' }),
    ).resolves.toBeUndefined()
    expect((await h.registry.getRuntime('disabled-profile'))?.enabled).toBe(false)
  })

  test('advisory probe failure still saves the full profile and returns its persisted receipt', async () => {
    const h = await setup()
    const created = await h.application.profiles.create({
      name: 'custom-claude',
      protocol: 'claude-code',
      binaryPath: 'custom-claude-bin',
      model: 'model-one',
      variant: 'variant-one',
      temperature: 0.25,
      steps: 3,
      maxSteps: 9,
      isSandbox: true,
      extraArgs: ['--custom-model', 'fast'],
      configDirName: 'custom-config',
      configDirEnv: 'CUSTOM_CLAUDE_CONFIG',
    })
    expect(created.smoke).toEqual(advisoryFailure)
    expect(created.runtime).toMatchObject({
      name: 'custom-claude',
      model: 'model-one',
      variant: 'variant-one',
      temperature: 0.25,
      steps: 3,
      maxSteps: 9,
      isSandbox: true,
      extraArgs: ['--custom-model', 'fast'],
      lastProbe: advisoryFailure,
      configDirName: 'custom-config',
      configDirEnv: 'CUSTOM_CLAUDE_CONFIG',
    })
    expect(h.probes).toHaveLength(1)
    expect(h.probes[0]).toMatchObject({
      binaryPath: 'custom-claude-bin',
      model: 'model-one',
      isSandbox: true,
    })
    expect(await h.registry.getRuntime('custom-claude')).not.toBeNull()
    await h.application.profiles.update('custom-claude', { model: 'model-two' })
    expect(h.reconciles()).toBe(1)
    expect(
      (await h.application.queries.list()).runtimes.find((row) => row.name === 'custom-claude'),
    ).toMatchObject({
      model: 'model-two',
      lastProbe: null,
      capabilities: { mcpRuntimeTestV1: false },
    })
  })

  test('real runtime named claude wins over alias; subsequent model and status queries read current config', async () => {
    const h = await setup()
    await h.registry.createRuntime({
      name: 'claude',
      protocol: 'opencode',
      binaryPath: 'custom-opencode',
    })
    await h.application.models.list({ runtime: 'claude', refresh: true })
    expect(h.models[0]).toEqual({ protocol: 'opencode', binary: 'custom-opencode', refresh: true })
    await h.application.models.list({ refresh: false })
    expect(h.models[1]?.binary).toBe('first-opencode')
    h.setConfig({
      defaultRuntime: 'claude',
      opencodePath: 'second-opencode',
      claudeCodePath: 'second-claude',
    })
    await h.application.models.list({ refresh: false })
    expect(h.models[2]?.binary).toBe('second-opencode')
    const status = await h.application.queries.status()
    expect(status.runtimes.find((row) => row.name === 'claude')).toMatchObject({
      isDefault: true,
      binary: 'custom-opencode',
      state: 'ready',
    })
    expect(status.runtimes.find((row) => row.name === 'opencode')?.binary).toBe('second-opencode')
  })

  test('registered probe keeps its original target when config changes during the effect', async () => {
    const h = await setup()
    h.dependencies.drivers.smoke = async (input) => {
      h.probes.push(input)
      h.setConfig({ opencodePath: 'changed-while-probing' })
      return advisoryFailure
    }
    await expect(
      h.application.diagnostics.probe({ kind: 'registered', name: 'opencode' }),
    ).rejects.toMatchObject({ code: 'runtime-probe-stale' })
    expect(h.probes[0]?.binaryPath).toBe('first-opencode')
    expect((await h.registry.getRuntime('opencode'))?.lastProbeJson).toBeNull()
  })

  test('disabled rows stay in list but leave live status; model failure retains its original error wire', async () => {
    const h = await setup()
    await h.application.profiles.setEnabled('claude-code', false)
    expect(h.reconciles()).toBe(1)
    expect((await h.application.queries.list()).runtimes.map((row) => row.name)).toContain(
      'claude-code',
    )
    expect((await h.application.queries.status()).runtimes.map((row) => row.name)).not.toContain(
      'claude-code',
    )
    h.dependencies.modelDiscovery.list = async () => {
      throw new Error('model service unavailable')
    }
    expect(await h.application.models.list({ runtime: 'opencode', refresh: false })).toEqual({
      kind: 'unavailable',
      error: {
        ok: false,
        code: 'opencode-models-failed',
        message: 'model service unavailable',
        runtime: 'opencode',
      },
    })
    const stored = await harness.db
      .select()
      .from(runtimes)
      .where(eq(runtimes.name, 'claude-code'))
      .get()
    expect(stored?.enabled).toBe(false)
  })
})
