// RFC-383: session identity, initialization and selected program reads, with former SQLite/PG controls.
import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeDaemonDigitalEmployeeModules } from '@/cli/daemonModules/digitalEmployee'
import { composeDaemonDevelopmentAutomationModules } from '@/cli/daemonModules/developmentAutomation'
import { composeSqliteApplicationDeps, createComposedApp } from '@/server'
import { createSecretBoxFromKey } from '@/auth/secretBox'
import { composeUnstartedApplication } from './helpers/providerHttpApplication'
import * as employeeComposition from '@/modules/digital-employee/composition'
import * as authoringStore from '@/modules/digital-employee/infrastructure/authoringStore'
import * as reactionComposition from '@/modules/task-execution/composition/digitalEmployeeExecution'
import * as agentComposition from '@/modules/task-execution/composition/agentActionExecution'
import * as fixtureComposition from '@/modules/task-execution/composition/executionContractFixture'
import { createProgramArtifactStore } from '@/modules/digital-employee/composition'
import { developmentEmployeeTypePackage } from '@/modules/development-automation/composition/employeeTypePackage'
import {
  employeeTypePackageDescriptorSchema,
  packageDigest,
} from '@/modules/digital-employee/domain/model'
import { describeEachProvider } from './helpers/eachProvider'
import { employeeAutomationFixture } from './helpers/daemonEmployeeAutomationBundle'
import { seedBundleTask } from './helpers/daemonTaskExecutionBundle'
import { composeTaskCancellation } from '@/modules/task-execution/composition/taskCancellation'
const homes: string[] = []
function home() {
  const p = mkdtempSync(join(tmpdir(), 'rfc383-'))
  homes.push(p)
  return p
}
afterEach(() => {
  for (const p of homes.splice(0)) rmSync(p, { recursive: true, force: true })
})

describeEachProvider('RFC-383 employee and development session bundles', (harness) => {
  test('construction is passive; complete frozen bundles share host tasks and the one writer', async () => {
    const f = employeeAutomationFixture(harness, home())
    const statements = harness.recordStatements()
    const timer = spyOn(globalThis, 'setTimeout'),
      interval = spyOn(globalThis, 'setInterval')
    const employeeSpy = spyOn(employeeComposition, 'composeDigitalEmployee')
    const reactionSpy = spyOn(reactionComposition, 'composeReactionExecutionProvider')
    const agentSpy = spyOn(agentComposition, 'composeAgentActionExecution')
    try {
      const employee = composeDaemonDigitalEmployeeModules(f.employeeInput)
      const automation = composeDaemonDevelopmentAutomationModules({
        ...f.automationInput,
        writerCutover: employee.writerCutover,
      })
      expect(statements.statements).toHaveLength(0)
      expect(timer).not.toHaveBeenCalled()
      expect(interval).not.toHaveBeenCalled()
      expect(Object.isFrozen(employee)).toBe(true)
      expect(Object.isFrozen(automation)).toBe(true)
      expect(Object.keys(employee).sort()).toEqual(
        [
          'module',
          'executionContracts',
          'platformTools',
          'writerCutover',
          'workStart',
          'taskCatalogSource',
          'platformInventory',
          'caseDetailProjection',
          'activityOperations',
          'routePersistence',
          'reactionExecution',
        ].sort(),
      )
      expect(Object.keys(automation).sort()).toEqual(
        [
          'admissionLookup',
          'automation',
          'missionOperations',
          'missionInputUploads',
          'sweepWakesWhileDraining',
          'recoverWhileDraining',
        ].sort(),
      )
      expect(employee.module).not.toBe(f.employee.module)
      expect(employee.writerCutover).not.toBe(f.employee.writerCutover)
      expect(employeeSpy.mock.calls[0]![0].writerCutover).toBe(employee.writerCutover)
      for (const key of ['launch', 'resolveActor', 'resourceAuthorityFor', 'readModels'] as const) {
        expect(reactionSpy.mock.calls[0]![0][key]).toBe(f.taskExecution.hostTasks[key])
        expect(agentSpy.mock.calls[0]![0][key]).toBe(f.taskExecution.hostTasks[key])
      }
      statements.stop()
      const analysis = spyOn(employee.writerCutover, 'analyze')
      try {
        await employee.module.queries.getMigrationStatus()
        expect(analysis).toHaveBeenCalledTimes(1)
      } finally {
        analysis.mockRestore()
      }
    } finally {
      statements.stop()
      timer.mockRestore()
      interval.mockRestore()
      employeeSpy.mockRestore()
      reactionSpy.mockRestore()
      agentSpy.mockRestore()
    }
  })
  for (const former of [true, false]) {
    test(`${former ? 'former SQLite split' : 'shared session'}: HTTP authoring after boot ${former ? 'initializes twice' : 'reuses initialized module'}`, async () => {
      const f = employeeAutomationFixture(harness, home())
      const original = authoringStore.createDigitalEmployeeAuthoringPersistence
      let initializations = 0
      const persistence = spyOn(
        authoringStore,
        'createDigitalEmployeeAuthoringPersistence',
      ).mockImplementation((db) => {
        const store = original(db)
        return {
          ...store,
          async ensureTypePackage(...args) {
            initializations++
            return store.ensureTypePackage(...args)
          },
        }
      })
      try {
        const session = composeDaemonDigitalEmployeeModules(f.employeeInput)
        const http = former ? composeDaemonDigitalEmployeeModules(f.employeeInput) : session
        await session.module.maintenance.ready()
        const afterBoot = initializations
        await http.module.queries.listTypes()
        expect(afterBoot).toBe(1)
        expect(initializations).toBe(former ? 2 : 1)
        expect(http.module === session.module).toBe(!former)
        expect(http.activityOperations === session.activityOperations).toBe(!former)
      } finally {
        persistence.mockRestore()
      }
    })
    test(`${former ? 'former SQLite split' : 'shared session'}: initialization failure is ${former ? 'cached on HTTP after successful boot' : 'a boot failure'}`, async () => {
      const f = employeeAutomationFixture(harness, home())
      if (former) await f.employee.module.maintenance.ready()
      const original = authoringStore.createDigitalEmployeeAuthoringPersistence
      let attempts = 0
      const persistence = spyOn(
        authoringStore,
        'createDigitalEmployeeAuthoringPersistence',
      ).mockImplementation((db) => ({
        ...original(db),
        async ensureTypePackage() {
          attempts++
          throw new Error('initialization-unavailable')
        },
      }))
      try {
        const session = composeDaemonDigitalEmployeeModules(f.employeeInput)
        if (former) {
          await expect(session.module.queries.listTypes()).rejects.toThrow(
            'initialization-unavailable',
          )
          await expect(session.module.queries.listTypes()).rejects.toThrow(
            'initialization-unavailable',
          )
        } else
          await expect(session.module.maintenance.ready()).rejects.toThrow(
            'initialization-unavailable',
          )
        expect(attempts).toBe(1)
      } finally {
        persistence.mockRestore()
      }
    })
    test(`${former ? 'former PG missing policy' : 'bundle forwards overlay'}: development type package drift at authoring-ready`, async () => {
      const f = employeeAutomationFixture(harness, home())
      const descriptor = employeeTypePackageDescriptorSchema.parse(
        JSON.parse(developmentEmployeeTypePackage.descriptorJson),
      )
      const old = {
        ...descriptor,
        description: { 'zh-CN': '旧开发类型包', 'en-US': 'persisted previous development package' },
      }
      await authoringStore.createDigitalEmployeeAuthoringPersistence(harness.db).ensureTypePackage({
        descriptor: old,
        descriptorDigest: packageDigest(old),
        state: 'published',
        registeredAt: 1,
      })
      const bundle = composeDaemonDigitalEmployeeModules({
        ...f.employeeInput,
        typePackageDriftPolicy: former ? undefined : 'draft-overlay',
      })
      if (former)
        await expect(bundle.module.maintenance.ready()).rejects.toMatchObject({
          code: 'employee-type-revision-drift',
        })
      else {
        await bundle.module.maintenance.ready()
        expect(await bundle.module.queries.listTypes()).not.toHaveLength(0)
      }
    })
    test(`${former ? 'former SQLite omitted stores' : 'bundle selected stores'}: reaction and execution fixture read the selected program`, async () => {
      const f = employeeAutomationFixture(harness, home())
      const store = createProgramArtifactStore(home())
      let reads = 0
      const selected = {
        ...store,
        async read() {
          reads++
          return { source: 'console.log("ok")', parameterValues: null }
        },
      }
      const reaction = spyOn(reactionComposition, 'composeReactionExecutionProvider'),
        fixtures = spyOn(fixtureComposition, 'createExecutionContractProgramFixtureAdapter')
      try {
        composeDaemonDigitalEmployeeModules({
          ...f.employeeInput,
          adapters: { employeePrograms: selected },
        })
        const reactionInput = reaction.mock.calls[0]![0],
          fixtureInput = fixtures.mock.calls[0]![0]
        expect(reactionInput.programs).toBe(fixtureInput.programs)
        const implementation = {
          kind: 'program' as const,
          runtimeKind: 'node' as const,
          executableArtifactRef: 'selected-only',
          executableDigest: 'abc',
          parameterValuesRef: null,
          runtimeProfileRef: { id: 'runtime', revision: 1 },
        }
        // Former S supplied neither source, causing both consumers to use the file fallback.
        const { createFileProgramToolSource } =
          await import('@/modules/task-execution/infrastructure/local/fileProgramToolSource')
        const reactionPrograms = former
          ? createFileProgramToolSource(f.employeeInput.appHome)
          : reactionInput.programs!
        const fixturePrograms = former
          ? createFileProgramToolSource(f.employeeInput.appHome)
          : fixtureInput.programs!
        expect((await reactionPrograms.read(implementation)).kind).toBe(former ? 'failed' : 'ok')
        expect((await fixturePrograms.read(implementation)).kind).toBe(former ? 'failed' : 'ok')
        expect(reads).toBe(former ? 0 : 2)
      } finally {
        reaction.mockRestore()
        fixtures.mockRestore()
      }
    })
  }
  for (const former of [true, false]) {
    test(`${former ? 'former provider host environment' : 'session host cancellation'}: cancellation stops the same running token`, async () => {
      const appHome = home(),
        f = employeeAutomationFixture(harness, appHome)
      const entered = Promise.withResolvers<AbortSignal>()
      f.tasks.schedulerDriver.drive = async (request) => {
        entered.resolve(request.signal)
        await new Promise<void>((resolve) =>
          request.signal.addEventListener('abort', () => resolve(), { once: true }),
        )
      }
      const seeded = await seedBundleTask(harness, appHome)
      await f.taskExecution.coordinator.submit({
        taskId: seeded.taskId,
        intentId: seeded.intentId,
        completionMode: 'background',
      })
      const signal = await entered.promise
      const registry = f.taskExecution.executionModule.runtimeRegistry
      const token = registry.tokenForTask(seeded.taskId)!
      const cancellation = spyOn(f.taskExecution.cancellation, 'cancel')
      try {
        // Former SQLite constructed the facade per call, but it already reached the same registry.
        // Former PG used its session cancellation participant directly.
        const formerFacade = former && harness.applicationBinding.provider === 'sqlite'
        if (formerFacade) await composeTaskCancellation(harness.db).cancel(seeded.taskId)
        else if (former)
          await f.taskExecution.cancellation.cancel({
            taskId: seeded.taskId,
            cause: { kind: 'user' },
          })
        else await f.taskExecution.hostTasks.cancelTask(seeded.taskId)
        await registry.awaitReleasedSettled(seeded.taskId)
        expect(signal.aborted).toBe(true)
        expect(f.taskExecution.isTaskActive(seeded.taskId)).toBe(false)
        expect(cancellation).toHaveBeenCalledTimes(formerFacade ? 0 : 1)
        if (!formerFacade)
          expect(cancellation).toHaveBeenCalledWith({
            taskId: seeded.taskId,
            cause: { kind: 'user' },
          })
        expect((await seeded.row()).status).toBe('canceled')
      } finally {
        cancellation.mockRestore()
        registry.requestStop(token, { kind: 'user' })
        await registry.awaitReleasedSettled(seeded.taskId)
      }
    })
  }
})

// This injection seam exists only on SQLite; the bundle behavior above runs on both providers.
describeEachProvider(
  'RFC-383 SQLite HTTP uses the initialized session',
  (harness) => {
    test('HTTP authoring and migration reads preserve the injected module, writer and mission operations', async () => {
      const binding = harness.applicationBinding
      if (binding.provider !== 'sqlite') throw new Error('SQLite injection boundary required')
      const appHome = home(),
        f = employeeAutomationFixture(harness, appHome),
        token = 'rfc383-http'
      await f.employee.platformTools.load()
      await f.employee.module.maintenance.ready()
      await f.employee.writerCutover.activate()
      const constructEmployee = spyOn(employeeComposition, 'composeDigitalEmployee')
      const opened = await composeUnstartedApplication((scope) => {
        const composed = composeSqliteApplicationDeps(
          {
            db: binding.db,
            appHome,
            configPath: join(appHome, 'config.json'),
            token,
            dbVersion: 0,
            opencodeVersion: null,
            secretBox: createSecretBoxFromKey(Buffer.alloc(32, 8)),
            digitalEmployeeModules: f.employee,
            developmentAutomationModules: f.automation,
          },
          scope,
        )
        expect(composed.digitalEmployeeModules).toBe(f.employee)
        expect(composed.developmentAutomationModules).toBe(f.automation)
        expect(composed.digitalEmployeeModules.writerCutover).toBe(f.employee.writerCutover)
        expect(composed.developmentAutomationModules.missionOperations).toBe(
          f.automation.missionOperations,
        )
        return { app: createComposedApp(composed) }
      })
      try {
        for (const path of [
          '/api/digital-employee-types',
          '/api/digital-employees/migration-status',
        ]) {
          const response = await opened.app.request(path, {
            headers: { Authorization: `Bearer ${token}` },
          })
          expect(response.status, await response.clone().text()).toBe(200)
          if (path.endsWith('migration-status'))
            expect(await response.json()).toMatchObject({ writer: { mode: 'os-active' } })
        }
        expect(constructEmployee).not.toHaveBeenCalled()
      } finally {
        constructEmployee.mockRestore()
        await opened.dispose()
      }
    })
  },
  { providers: ['sqlite'] },
)
