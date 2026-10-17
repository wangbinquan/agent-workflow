// RFC-370 M2: use exact platform profile mappings and their compatibility
// receipts; never claim a binary version or inspect a service-host executable.
import { expect, test } from 'bun:test'
import {
  createCrewStationRuntimeManagementEffects,
  type HostedRuntimeCapabilities,
} from '@/modules/runtime-management/composition/crewstationRuntimeManagement'

test('hosted model/status views follow tested profiles, and probe target identity tracks revisions', async () => {
  const id = '01a13e6d-3e00-7000-9e3c-6a69d77164b3'
  let capabilities: HostedRuntimeCapabilities = {
    protocolVersion: 3,
    releaseId: 'release',
    agentProfiles: [
      {
        agentProfileId: id,
        computeProfileId: id,
        profileRevision: 2,
        capabilities: { events: true, mcp: true, usage: 'incremental' },
      },
    ],
  }
  let smokes = 0
  const effects = createCrewStationRuntimeManagementEffects({
    profiles: [{ protocol: 'opencode', model: 'vendor/model', agentProfileId: id }],
    initialCapabilities: capabilities,
    capabilities: async () => capabilities,
    configuration: { current: () => ({}), withProbeReceiptFence: (action) => action() },
    runtimeTests: { reconcileDurableIntents: async () => undefined },
    smoke: async () => {
      smokes++
      return {
        outcome: 'conforms',
        conforms: true,
        detail: 'real fixture turn',
        sawNonce: true,
        sawEnvelope: false,
        exitCode: 0,
      }
    },
  })
  const row = { protocol: 'opencode' as const, binaryPath: null, model: 'vendor/model' }
  const target = effects.drivers.resolveTarget(row, {})
  expect(await effects.drivers.probeStatus('opencode', target, 1000)).toEqual({
    binary: 'cs-agent:opencode',
    version: null,
    ran: true,
    compatible: true,
  })
  expect((await effects.modelDiscovery.list('opencode', target, true)).models).toEqual([
    { id: 'vendor/model' },
  ])
  await effects.drivers.smoke({
    protocol: 'opencode',
    target,
    config: {},
    model: 'vendor/model',
    isSandbox: false,
  })
  expect(smokes).toBe(1)
  expect(() =>
    effects.drivers.capture({ protocol: () => 'opencode', binaryPath: '/host/bin/opencode' }),
  ).toThrow('managed-by-crewstation')
  await expect(
    effects.drivers.smoke({
      protocol: 'opencode',
      target,
      config: {},
      model: 'unmapped',
      isSandbox: false,
    }),
  ).rejects.toThrow('unmapped')
  capabilities = {
    ...capabilities,
    agentProfiles: [
      {
        ...capabilities.agentProfiles[0]!,
        profileRevision: 3,
        capabilities: { events: false, mcp: false, usage: 'none' },
      },
    ],
  }
  expect((await effects.drivers.probeStatus('opencode', target, 1000)).compatible).toBe(false)
  expect(effects.drivers.resolveTarget(row, {}).receiptKey).not.toBe(target.receiptKey)
  expect((await effects.modelDiscovery.list('opencode', target, true)).models).toEqual([])
  await expect(
    effects.drivers.smoke({
      protocol: 'opencode',
      target,
      config: {},
      model: 'vendor/model',
      isSandbox: false,
    }),
  ).rejects.toThrow('not-tested')
  expect(smokes).toBe(1)
})
