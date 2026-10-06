// RFC-370: ordinary Runtime management forwards selected targets on both real
// databases. Native fixtures keep their original observation and receiver.
import { expect, test } from 'bun:test'
import { composeRuntimeManagement } from '../src/modules/runtime-management/composition/runtimeManagement'
import { composeLocalRuntimeManagement } from '../src/modules/task-execution/composition/localRuntimeManagement'
import { createLocalRuntimeManagementEffects } from '../src/modules/runtime-management/infrastructure/local/runtimeManagementEffects'
import { createLocalRuntimeDiagnosticTargets } from '../src/modules/runtime-management/composition/runtimeDiagnosticTargets'
import type {
  RuntimeDiagnosticTarget,
  RuntimeDriverManagementPort,
  RuntimeManagementConfig,
  RuntimeManagementConfigPort,
  RuntimeManagementEffects,
  RuntimeManagementDependencies,
  RuntimeModelDiscoveryPort,
  RuntimeSmokeRequest,
  RuntimeTestManagementPort,
} from '../src/modules/runtime-management/application/ports/runtimeManagement'
import type { RuntimeRow } from '../src/modules/runtime-management/application/ports/runtimeRegistry'
import type {
  RuntimeKind,
  RuntimeSmokeResult,
} from '../src/modules/runtime-management/public/types'
import type { SmokeOptions } from '../src/services/runtimeSmoke'
import { composeRuntimeRegistryOperations } from './helpers/runtimeRegistryComposition'
import { describeEachProvider } from './helpers/eachProvider'

const conforming: RuntimeSmokeResult = {
  outcome: 'conforms',
  conforms: true,
  detail: 'selected execution',
  sawNonce: true,
  sawEnvelope: false,
  exitCode: 0,
}

describeEachProvider('RFC-370 complete selected Runtime diagnostic family', (harness) => {
  async function setup() {
    const registry = composeRuntimeRegistryOperations(harness.db)
    await registry.seedBuiltinRuntimes()
    const calls: string[] = [],
      resolved: RuntimeDiagnosticTarget[] = [],
      captured: RuntimeDiagnosticTarget[] = []
    const status: RuntimeDiagnosticTarget[] = [],
      smoke: RuntimeSmokeRequest[] = [],
      models: RuntimeDiagnosticTarget[] = []
    let current: RuntimeManagementConfig = {
      defaultRuntime: 'opencode',
      opencodePath: 'revision-one',
    }
    let onSmoke: (() => void) | undefined,
      resolveError: Error | undefined,
      listError: Error | undefined
    function target(protocol: RuntimeKind, revision: string): RuntimeDiagnosticTarget {
      return Object.freeze({
        protocol,
        label: `display-only:${protocol}`,
        receiptKey: revision,
        runtimeBinding: Object.freeze({
          owner: 'runtime-management',
          reference: `remote:${revision}`,
          version: 19,
        }),
      })
    }
    class Configuration implements RuntimeManagementConfigPort {
      async current() {
        expect<Configuration>(this).toBe(configuration)
        calls.push('config')
        return current
      }
      async withProbeReceiptFence<T>(action: () => Promise<T>) {
        expect<Configuration>(this).toBe(configuration)
        calls.push('fence')
        return action()
      }
    }
    const configuration = new Configuration()
    class Drivers implements RuntimeDriverManagementPort {
      resolveTarget(
        row: Pick<RuntimeRow, 'protocol' | 'binaryPath'>,
        config: RuntimeManagementConfig,
      ) {
        expect<Drivers>(this).toBe(drivers)
        const selected = target(
          row.protocol,
          `${config.opencodePath}:${row.binaryPath ?? 'default'}`,
        )
        resolved.push(selected)
        return selected
      }
      capture(input: { protocol: () => RuntimeKind; binaryPath: string }) {
        expect<Drivers>(this).toBe(drivers)
        const selected = target(input.protocol(), `captured:${input.binaryPath}`)
        captured.push(selected)
        return selected
      }
      async probeStatus(
        protocol: RuntimeKind,
        selected: RuntimeDiagnosticTarget,
        timeoutMs: number,
      ) {
        expect<Drivers>(this).toBe(drivers)
        expect(selected.protocol).toBe(protocol)
        expect(timeoutMs).toBe(731)
        expect(resolved).toContain(selected)
        status.push(selected)
        return { binary: selected.label, version: 'remote-version', compatible: true, ran: true }
      }
      async smoke(request: RuntimeSmokeRequest) {
        expect<Drivers>(this).toBe(drivers)
        expect([...resolved, ...captured]).toContain(request.target)
        expect(request).not.toHaveProperty('binaryPath')
        expect(request.target.label).toStartWith('display-only:')
        smoke.push(request)
        onSmoke?.()
        return conforming
      }
      assertSpawnCapabilities() {
        expect<Drivers>(this).toBe(drivers)
        calls.push('capabilities')
      }
    }
    const drivers = new Drivers()
    class Models implements RuntimeModelDiscoveryPort {
      resolveTarget(protocol: RuntimeKind, binary: string | null, config: RuntimeManagementConfig) {
        expect<Models>(this).toBe(discovery)
        if (resolveError) throw resolveError
        const selected = target(protocol, `model:${config.opencodePath}:${binary ?? 'default'}`)
        models.push(selected)
        return selected
      }
      async list(protocol: RuntimeKind, selected: RuntimeDiagnosticTarget, refresh: boolean) {
        expect<Models>(this).toBe(discovery)
        expect(selected.protocol).toBe(protocol)
        expect(models.at(-1)).toBe(selected)
        expect(refresh).toBe(true)
        if (listError) throw listError
        return { binary: 'private-native-value', models: [{ id: 'remote-model' }], cached: false }
      }
    }
    const discovery = new Models()
    class Tests implements RuntimeTestManagementPort {
      eligible(row: RuntimeRow) {
        expect<Tests>(this).toBe(tests)
        return row.protocol === 'opencode'
      }
      async reconcile() {
        expect<Tests>(this).toBe(tests)
        calls.push('reconcile')
      }
    }
    const tests = new Tests()
    class Effects implements RuntimeManagementEffects {
      readonly config = configuration
      readonly drivers = drivers
      readonly modelDiscovery = discovery
      readonly tests = tests
      readonly statusProbeTimeoutMs = 731
      readonly protocols = ['claude-code'] as const
      #receipts = 0
      beforeProbeReceipt() {
        expect<Effects>(this).toBe(effects)
        this.#receipts++
        calls.push('before-receipt')
      }
      receipts() {
        return this.#receipts
      }
    }
    const effects = new Effects()
    return {
      registry,
      effects,
      management: composeRuntimeManagement({ runtimeRegistry: registry, effects }),
      calls,
      resolved,
      captured,
      status,
      smoke,
      models,
      setConfig(config: RuntimeManagementConfig) {
        current = config
      },
      duringSmoke(action: () => void) {
        onSmoke = action
      },
      rejectResolve(error: Error) {
        resolveError = error
      },
      rejectList(error: Error) {
        listError = error
      },
    }
  }

  test('required prototype effects supply the protocol view, status target and model target unchanged', async () => {
    const h = await setup()
    expect(h.management.runtimes.protocols).toBe(h.effects.protocols)
    const listed = await h.management.runtimes.queries.list()
    expect(listed.runtimes.length).toBeGreaterThan(0)
    expect(listed.runtimes.every((row) => row.binaryPath === null)).toBe(true)
    expect(h.resolved.every((target) => target.label.startsWith('display-only:'))).toBe(true)
    const status = await h.management.runtimes.queries.status()
    expect(
      status.runtimes.every((row) => row.state === 'ready' && row.version === 'remote-version'),
    ).toBe(true)
    expect(h.status.length).toBe(status.runtimes.length)
    const models = await h.management.models.list({ runtime: 'claude', refresh: true })
    expect(models).toEqual({
      kind: 'listed',
      models: {
        binary: 'display-only:claude-code',
        models: [{ id: 'remote-model' }],
        cached: false,
      },
    })
  })

  test('unsaved and registered diagnostics forward the actual owner target and retain authored fields', async () => {
    const h = await setup(),
      extraArgs = ['custom-flag', '']
    await h.management.runtimes.diagnostics.probe({
      kind: 'unsaved',
      protocol: 'opencode',
      binaryPath: 'authored-only',
      model: 'test-model',
      isSandbox: true,
      extraArgs,
    })
    expect(h.smoke[0]?.target).toBe(h.captured[0])
    expect(h.smoke[0]?.extraArgs).toBe(extraArgs)
    expect(h.smoke[0]).toMatchObject({
      protocol: 'opencode',
      model: 'test-model',
      isSandbox: true,
      config: { opencodePath: 'revision-one' },
    })
    await h.registry.createRuntime({
      name: 'remote-profile',
      protocol: 'opencode',
      binaryPath: 'authored-profile',
      model: 'test-model',
      extraArgs,
    })
    await h.management.runtimes.diagnostics.probe({ kind: 'registered', name: 'remote-profile' })
    expect(h.smoke[1]?.target).toBe(h.resolved.at(-2))
    expect(h.effects.receipts()).toBe(1)
    expect(h.calls.slice(-3)).toEqual(['fence', 'config', 'before-receipt'])
    expect(
      JSON.parse((await h.registry.getRuntime('remote-profile'))!.lastProbeJson!).smoke,
    ).toEqual(conforming)
    // Display labels differ from receipt identities; valid cached results must remain visible.
    expect(
      (await h.management.runtimes.queries.list()).runtimes.find(
        (row) => row.name === 'remote-profile',
      )?.lastProbe,
    ).toEqual(conforming)
  })

  test('the explicit native root preserves the original before-probe fixture application receiver', async () => {
    const h = await setup()
    let receipts = 0
    function before(this: RuntimeManagementDependencies) {
      expect(this.registry).toBe(h.registry)
      expect(this.config).toBe(h.effects.config)
      expect(this.beforeProbeReceipt).toBe(before)
      expect(Object.keys(this)).toEqual([
        'registry',
        'config',
        'drivers',
        'modelDiscovery',
        'tests',
        'statusProbeTimeoutMs',
        'beforeProbeReceipt',
      ])
      receipts++
    }
    const management = composeLocalRuntimeManagement({
      runtimeRegistry: h.registry,
      configuration: h.effects.config,
      runtimeTests: { async reconcileDurableIntents() {} },
      appHome() {
        throw new Error('a fixture must not allocate a native smoke workspace')
      },
      runtimeDiagnosticTestDependencies: {
        smokeRuntime: async () => conforming,
        beforeRuntimeProbeCache: before,
      },
    })
    expect(
      await management.runtimes.diagnostics.probe({ kind: 'registered', name: 'opencode' }),
    ).toEqual({ smoke: conforming })
    expect(receipts).toBe(1)
    expect(h.effects.receipts()).toBe(0)
  })

  test('registry selection errors precede effect and native configuration reads', async () => {
    const h = await setup(),
      calls: string[] = [],
      failure = new Error('registry-selection-failed')
    expect(() =>
      composeRuntimeManagement({
        get runtimeRegistry() {
          calls.push('registry')
          throw failure
        },
        get effects() {
          calls.push('effects')
          return h.effects
        },
      }),
    ).toThrow(failure)
    expect(calls).toEqual(['registry'])
    calls.length = 0
    expect(() =>
      composeLocalRuntimeManagement({
        get runtimeRegistry() {
          calls.push('registry')
          throw failure
        },
        get configuration() {
          calls.push('configuration')
          return h.effects.config
        },
        runtimeTests: { async reconcileDurableIntents() {} },
        appHome() {
          calls.push('home')
          throw new Error('not reached')
        },
      }),
    ).toThrow(failure)
    expect(calls).toEqual(['registry'])
  })

  test('receiptKey changes still reject a stale registered result and never cache it', async () => {
    const h = await setup()
    await h.registry.createRuntime({ name: 'stale-profile', protocol: 'opencode' })
    h.duringSmoke(() => h.setConfig({ defaultRuntime: 'opencode', opencodePath: 'revision-two' }))
    await expect(
      h.management.runtimes.diagnostics.probe({ kind: 'registered', name: 'stale-profile' }),
    ).rejects.toMatchObject({ code: 'runtime-probe-stale' })
    expect(h.calls).not.toContain('before-receipt')
    expect((await h.registry.getRuntime('stale-profile'))?.lastProbeJson).toBeNull()
  })

  test('model target resolution stays outside the list error boundary; selected listing errors retain the old response', async () => {
    const h = await setup(),
      failure = new Error('target-resolution-failed')
    h.rejectResolve(failure)
    await expect(h.management.models.list({ refresh: true })).rejects.toBe(failure)
    const other = await setup()
    other.rejectList(new Error('model-list-failed'))
    expect(await other.management.models.list({ runtime: 'claude', refresh: true })).toEqual({
      kind: 'unavailable',
      error: {
        ok: false,
        code: 'opencode-models-failed',
        message: 'model-list-failed',
        runtime: 'claude',
      },
    })
  })
})

test('RFC-370 native diagnostic fixture preserves lookup order, optional absence and the old drivers receiver', async () => {
  const calls: string[] = [],
    targets = createLocalRuntimeDiagnosticTargets()
  const config: RuntimeManagementConfigPort = {
    current: () => ({}),
    withProbeReceiptFence: (action) => action(),
  }
  let received: SmokeOptions | undefined,
    fixtureCalls = 0,
    normalCalls = 0
  const before = () => undefined
  const diagnostics = {
    get smokeRuntime() {
      calls.push('smoke')
      return async function (this: unknown, input: SmokeOptions) {
        expect(this).toBe(effects.drivers)
        fixtureCalls++
        received = input
        return conforming
      }
    },
    get probeTimeoutMsForTest() {
      calls.push('timeout')
      return 291
    },
    get beforeRuntimeProbeCache() {
      calls.push('before')
      return before
    },
  }
  class Smoke {
    async run() {
      expect<Smoke>(this).toBe(normal)
      normalCalls++
      return conforming
    }
  }
  const normal = new Smoke()
  const effects = createLocalRuntimeManagementEffects({
    configuration: config,
    runtimeTests: { async reconcileDurableIntents() {} },
    targets,
    smoke: normal,
    get runtimeDiagnosticTestDependencies() {
      calls.push('diagnostics')
      return diagnostics
    },
  })
  expect(calls).toEqual(['diagnostics', 'smoke', 'diagnostics', 'timeout', 'diagnostics', 'before'])
  expect(effects.statusProbeTimeoutMs).toBe(291)
  expect(effects.beforeProbeReceipt).toBe(before)
  const target = targets.capture({ protocol: () => 'opencode', binaryPath: 'original-binary' })
  const authored = { opencodePath: 'original-config' }
  await effects.drivers.smoke({ protocol: 'opencode', target, config: authored, isSandbox: false })
  expect(fixtureCalls).toBe(1)
  expect(received?.binaryPath).toBe('original-binary')
  expect(received?.config).toBe(authored)
  expect(received?.isSandbox).toBe(false)
  expect(received).not.toHaveProperty('extraArgs')
  expect(received).not.toHaveProperty('model')
  expect(normalCalls).toBe(0)
  const selected = createLocalRuntimeManagementEffects({
    configuration: config,
    runtimeTests: { async reconcileDurableIntents() {} },
    targets,
    smoke: normal,
  })
  await selected.drivers.smoke({ protocol: 'opencode', target, config: authored, isSandbox: false })
  expect(normalCalls).toBe(1)
})
