import { expect, test } from 'bun:test'
import { createRuntimeObservationQueries } from '../src/modules/runtime-management/application/runtimeObservationQueries'
import type { RuntimeRow } from '../src/modules/runtime-management/domain/runtimeProfile'

// A deleted/recreated runtime name must not inherit its predecessor's price identity.
test('RFC-371 pricing directory retains registry identity and revision without launch data', async () => {
  let reads = 0
  const row: RuntimeRow = {
    id: 'registration-1',
    name: 'same-name',
    protocol: 'opencode',
    model: 'provider/model',
    binaryPath: '/opt/runtime',
    configDirEnv: 'CUSTOM_CONFIG',
    configDirName: '.runtime',
    extraArgsJson: null,
    enabled: true,
    isSandbox: false,
    lastProbeJson: null,
    probeFence: 2,
    createdBy: null,
    createdAt: 1,
    updatedAt: 2,
    variant: null,
    temperature: null,
    steps: null,
    maxSteps: null,
  }
  const queries = createRuntimeObservationQueries({
    listRuntimes: async () => {
      reads++
      return [row]
    },
  })
  expect(await queries.directory()).toEqual({
    runtimes: [
      {
        registrationId: 'registration-1',
        name: 'same-name',
        configurationRevision: 2,
        protocol: 'opencode',
        model: 'provider/model',
        enabled: true,
      },
    ],
  })
  row.id = 'registration-2'
  row.probeFence = 0
  row.model = null
  row.enabled = false
  expect((await queries.directory()).runtimes[0]).toEqual({
    registrationId: 'registration-2',
    name: 'same-name',
    configurationRevision: 0,
    protocol: 'opencode',
    model: null,
    enabled: false,
  })
  expect(reads).toBe(2)
  expect(
    await createRuntimeObservationQueries({ listRuntimes: async () => [] }).directory(),
  ).toEqual({ runtimes: [] })
})
