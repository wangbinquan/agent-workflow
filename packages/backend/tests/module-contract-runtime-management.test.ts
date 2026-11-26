import { expect, test } from 'bun:test'
import { createRuntimeManagement } from '@/modules/runtime-management/application/runtimeManagement'
import type { RuntimeManagementDependencies } from '@/modules/runtime-management/application/ports/runtimeManagement'
import { createLocalRuntimeDiagnosticTargets } from '@/modules/runtime-management/composition/runtimeDiagnosticTargets'
import { describeEachProvider } from './helpers/eachProvider'
import { composeRuntimeRegistryOperations } from './helpers/runtimeRegistryComposition'

describeEachProvider('runtime-management status query contract', (harness) => {
  test('status probes all enabled profiles concurrently once and preserves registry order after reversed completion', async () => {
    const registry = composeRuntimeRegistryOperations(harness.db)
    await registry.seedBuiltinRuntimes()
    await registry.createRuntime({
      name: 'extra-profile',
      protocol: 'opencode',
      binaryPath: 'extra-binary',
    })
    const expected = (await registry.listRuntimes()).filter((row) => row.enabled)
    const targets = createLocalRuntimeDiagnosticTargets()
    let configReads = 0
    let holdProbes = true
    const entered: { binary: string; timeout: number; resolve: () => void }[] = []
    let firstEntered!: () => void
    const started = new Promise<void>((resolve) => {
      firstEntered = resolve
    })
    const dependencies: RuntimeManagementDependencies = {
      registry,
      config: {
        current: async () => {
          configReads++
          return { defaultRuntime: 'extra-profile' }
        },
        withProbeReceiptFence: (action) => action(),
      },
      drivers: {
        resolveTarget: (row) =>
          targets.capture({
            protocol: () => row.protocol,
            binaryPath: row.binaryPath ?? row.protocol,
          }),
        capture: (input) => targets.capture(input),
        async probeStatus(_protocol, target, timeout) {
          const binary = targets.binary(target)
          if (holdProbes) {
            await new Promise<void>((resolve) => {
              entered.push({ binary, timeout, resolve })
              firstEntered()
            })
          }
          return {
            binary,
            version: 'test-version',
            compatible: binary !== 'extra-binary',
            ran: true,
          }
        },
        async smoke() {
          throw new Error('status must not invoke smoke/model calls')
        },
        assertSpawnCapabilities() {},
      },
      modelDiscovery: {
        resolveTarget() {
          throw new Error('status must not discover models')
        },
        async list() {
          throw new Error('status must not discover models')
        },
      },
      tests: {
        eligible: () => true,
        async reconcile() {
          throw new Error('status is read-only')
        },
      },
      statusProbeTimeoutMs: 1234,
      beforeProbeReceipt() {
        throw new Error('status does not issue receipts')
      },
    }
    const application = createRuntimeManagement(dependencies)
    expect((await application.queries.list()).runtimes).toHaveLength(expected.length)
    expect(entered).toEqual([])
    configReads = 0
    const pending = application.queries.status()
    await Promise.race([started, pending])
    try {
      expect(entered).toHaveLength(expected.length)
      expect(configReads).toBe(1)
      expect(entered.map((call) => call.timeout)).toEqual(expected.map(() => 1234))
    } finally {
      holdProbes = false
      for (const call of [...entered].reverse()) call.resolve()
      await pending
    }
    const result = await pending
    expect(result.runtimes.map((row) => row.name)).toEqual(expected.map((row) => row.name))
    expect(result.runtimes.find((row) => row.name === 'extra-profile')).toMatchObject({
      state: 'protocol-incompatible',
      isDefault: true,
      ok: false,
    })
  })
})
