// RFC-379: construction does no work; templates must be seeded before loading platform tools.
import { expect, test, spyOn } from 'bun:test'
import { DigitalEmployeeAuthoringService } from '../src/modules/digital-employee/application/authoringService'
import { MrTerminalControlWorker } from '../src/modules/integration/application/mrTerminalControlWorker'
import { mintSourceTerminationEffectCapability } from '../src/modules/task-execution/application/sourceTerminationCapability'
import { composeDigitalEmployeeBuiltinToolCatalog } from '../src/modules/task-execution/composition/digitalEmployeeBuiltinToolCatalog'
import { composeDigitalEmployeeAgentTemplateCatalogFor } from '../src/modules/resource-catalog/composition/digitalEmployeeAgentTemplateCatalog'
import { composeDigitalEmployeeAgentTemplateCatalogParticipant } from '../src/modules/digital-employee/composition/agentTemplateCatalog'
import { developmentEmployeeTypePackage } from '../src/modules/development-automation/composition/employeeTypePackage'
import { ensureDigitalEmployeeAgentTemplates } from '../src/services/digitalEmployeeAgentTemplates'
import { composeEventCenter } from '../src/modules/event-center/composition'
import { describeEachProvider } from './helpers/eachProvider'
import { lifecycleFixture } from './helpers/daemonLifecycle'

test('authoring waits for initialize/ready; concurrent calls share initialization and rejection', async () => {
  let reads = 0
  const error = new Error('initialization failed')
  const service = new DigitalEmployeeAuthoringService({
    typePackages: [],
    store: {
      listTypePackageRegistrations: async () => {
        reads++
        throw error
      },
    },
  } as unknown as ConstructorParameters<typeof DigitalEmployeeAuthoringService>[0])
  expect(reads).toBe(0)
  const first = service.initialize(),
    second = service.initialize()
  expect(first).toBe(second)
  await expect(first).rejects.toThrow(error)
  await expect(service.ready()).rejects.toThrow(error)
  expect(reads).toBe(1)
})
test('MR boot reconciliation does not arm the interval; resume owns the timer', async () => {
  let reconciled = 0
  const worker = new MrTerminalControlWorker(
    { claimNextDue: async () => null } as unknown as ConstructorParameters<
      typeof MrTerminalControlWorker
    >[0],
    {
      reconcileStaleOnBoot: () => {
        reconciled++
      },
      supervisor: { abortAll: () => [] },
    } as unknown as ConstructorParameters<typeof MrTerminalControlWorker>[1],
    { apply: async () => [] },
    mintSourceTerminationEffectCapability,
  )
  const intervals = spyOn(globalThis, 'setInterval')
  try {
    await worker.reconcileOnBoot()
    expect(reconciled).toBe(1)
    expect(intervals).not.toHaveBeenCalled()
    worker.resume()
    expect(intervals).toHaveBeenCalledTimes(1)
  } finally {
    await worker.stop()
    intervals.mockRestore()
  }
})

test('MR recovery persists retry state without arming a retry timer before resume', async () => {
  let due = true
  const worker = new MrTerminalControlWorker(
    {
      async claimNextDue() {
        if (!due) return null
        due = false
        return { id: 'effect', attemptCount: 0 }
      },
      async finishAttempt() {},
    } as unknown as ConstructorParameters<typeof MrTerminalControlWorker>[0],
    {
      reconcileStaleOnBoot() {},
      supervisor: { abortAll: () => [] },
      async hasLaunchBarrier() {
        return true
      },
    } as unknown as ConstructorParameters<typeof MrTerminalControlWorker>[1],
    { apply: async () => [] },
    mintSourceTerminationEffectCapability,
  )
  const timers = spyOn(globalThis, 'setTimeout')
  try {
    await worker.reconcileOnBoot()
    expect(timers).not.toHaveBeenCalled()
  } finally {
    await worker.stop()
    timers.mockRestore()
  }
})

describeEachProvider('RFC-379 fresh catalog boot regression', (harness) => {
  test('a holder composed against a fresh database sees template tools after prepare', async () => {
    const templates = composeDigitalEmployeeAgentTemplateCatalogFor(
      harness.db,
      composeDigitalEmployeeAgentTemplateCatalogParticipant,
    )
    const catalog = composeDigitalEmployeeBuiltinToolCatalog({
      agentTemplates: templates,
      typePackageDescriptorJsons: [developmentEmployeeTypePackage.descriptorJson],
    })
    const fixture = lifecycleFixture(harness.applicationBinding.provider)
    fixture.input.steps['employee-agent-templates'] = () =>
      ensureDigitalEmployeeAgentTemplates(templates).then(() => undefined)
    fixture.input.steps['employee-tool-catalog'] = () => catalog.load()
    expect(() =>
      catalog.listJson(
        JSON.stringify(
          (JSON.parse(developmentEmployeeTypePackage.descriptorJson) as { typeRef: unknown })
            .typeRef,
        ),
        'repair-feedback',
      ),
    ).toThrow('not-loaded')
    await fixture.compose().runPhase('prepare')
    const tools = JSON.parse(
      catalog.listJson(
        JSON.stringify(
          (JSON.parse(developmentEmployeeTypePackage.descriptorJson) as { typeRef: unknown })
            .typeRef,
        ),
        'repair-feedback',
      ),
    ) as unknown[]
    expect(tools.length).toBeGreaterThan(0)
    await catalog.load()
    expect(
      JSON.parse(
        catalog.listJson(
          JSON.stringify(
            (JSON.parse(developmentEmployeeTypePackage.descriptorJson) as { typeRef: unknown })
              .typeRef,
          ),
          'repair-feedback',
        ),
      ),
    ).toEqual(tools)
  })
  test('event catalog registration is explicit and idempotent', async () => {
    const module = await composeEventCenter({
      db: harness.db,
      automation: { kind: 'observation-only' },
      typePackageDescriptorJsons: [developmentEmployeeTypePackage.descriptorJson],
    })
    const before = await module.queries.catalog.catalogJson()
    await module.initialize()
    const after = await module.queries.catalog.catalogJson()
    expect(after).not.toBe(before)
    await module.initialize()
    expect(await module.queries.catalog.catalogJson()).toBe(after)
  })
})
