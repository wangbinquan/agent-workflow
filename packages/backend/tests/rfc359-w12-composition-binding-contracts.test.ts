// RFC-359 W12 —— required composition inputs keep their constructed capability in the result
// type. These tests execute the returned capabilities on both database engines; the assignments
// also run through the repository typecheck, including the optional-input counterexamples.

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  composeDigitalEmployee,
  composePostgresqlDigitalEmployee,
  type ComposeDigitalEmployeeOptions,
  type ComposePostgresqlDigitalEmployeeOptions,
  type DigitalEmployeeCompositionOptions,
  type DigitalEmployeeModuleWithRuntime,
} from '@/modules/digital-employee/composition'
import type { ExecutionContractParticipant } from '@/modules/execution-contract/public/types'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import {
  composeMemoryOperationsFor,
  composePostgresqlMemoryOperations,
  composeSqliteMemoryOperations,
  type ComposeMemoryOperationsOptions,
  type MemoryOperationsWithCatalog,
} from '@/modules/memory/composition'
import { composeResourceScopeAccessParticipant } from '@/modules/resource-catalog/composition/resourceScopeAuthorization'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { describeEachProvider } from './helpers/eachProvider'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function appHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'aw-rfc359-w12-composition-'))
  roots.push(root)
  return root
}

function unexpectedExecution(): never {
  throw new Error('The composition binding fixture does not execute employee work or distill jobs')
}

const executionContracts: ExecutionContractParticipant = {
  list: () => [],
  get: unexpectedExecution,
  validateExecutor: unexpectedExecution,
  validateAgentCandidates: unexpectedExecution,
  validateEnvelope: unexpectedExecution,
}

const runtime: NonNullable<DigitalEmployeeCompositionOptions['runtime']> = {
  eventCenter: {
    subscribe: unexpectedExecution,
    unsubscribe: unexpectedExecution,
    observe: unexpectedExecution,
    pendingDeliveries: async () => [],
    acceptDelivery: unexpectedExecution,
  },
  execution: {
    launch: unexpectedExecution,
    inspect: unexpectedExecution,
    cancel: unexpectedExecution,
  },
  codecs: [],
}

describeEachProvider('RFC-359 W12 —— composition binding contracts', (harness) => {
  test('memory: a catalog binding yields a usable catalog through every composition name', async () => {
    const options = {
      db: harness.db,
      reviewedArtifacts: { read: unexpectedExecution },
      catalogBinding: {
        contexts: composeIdentityAccess(harness.db).contexts,
        authorization: composeResourceScopeAccessParticipant(),
      },
    }
    // Every entry must typecheck without a cast or a catalog-presence check.
    const modules: readonly MemoryOperationsWithCatalog[] = [
      composeMemoryOperationsFor(options),
      composeSqliteMemoryOperations(options),
      composePostgresqlMemoryOperations(options),
    ]
    for (const [index, module] of modules.entries()) {
      const created = await module.catalog.commands.createManual({
        scopeType: 'global',
        scopeId: null,
        title: `Composition binding ${index}`,
        bodyMd: 'Stored through the catalog returned by the full memory composition.',
      })
      expect((await module.catalog.queries.getById(created.id))?.memory).toMatchObject({
        id: created.id,
        title: `Composition binding ${index}`,
        status: 'candidate',
      })
      expect(Object.isFrozen(module)).toBe(true)
      await module.catalog.commands.delete(created.id)
      expect(await module.catalog.queries.getById(created.id)).toBeNull()
    }
  })

  test('memory: omitted or optional bindings keep the distill-only contract', async () => {
    const options = { db: harness.db, reviewedArtifacts: { read: unexpectedExecution } }
    const omitted = composeMemoryOperationsFor(options)
    const optionalInput: ComposeMemoryOperationsOptions = options
    const optional = composeMemoryOperationsFor(optionalInput)
    // @ts-expect-error An omitted binding does not promise a catalog.
    const omittedAsComplete: MemoryOperationsWithCatalog = omitted
    // @ts-expect-error An optional input does not promise a catalog either.
    const optionalAsComplete: MemoryOperationsWithCatalog = optional
    void omittedAsComplete
    void optionalAsComplete
    for (const module of [
      omitted,
      optional,
      composeSqliteMemoryOperations(options),
      composePostgresqlMemoryOperations(options),
      composeMemoryOperationsFor({ ...options, catalogBinding: undefined }),
    ]) {
      expect(module.catalog).toBeUndefined()
      expect(Object.hasOwn(module, 'catalog')).toBe(false)
      expect(await module.distillQueries.listJobs()).toEqual([])
    }
  })

  test('digital employee: a runtime binding yields real queries and idle workers', async () => {
    const options = {
      db: harness.db,
      appHome: appHome(),
      typePackages: [],
      executionContracts,
      runtime,
    }
    const neutral: DigitalEmployeeModuleWithRuntime = composeDigitalEmployee(options)
    await neutral.maintenance.ready()
    // The historical PG name delegates to the same provider-neutral implementation. As in the
    // W7 composition fixtures, exercise that name on both harness clients as well.
    const historical: DigitalEmployeeModuleWithRuntime = composePostgresqlDigitalEmployee({
      ...options,
      db: harness.db as PostgresqlDatabaseClient,
    })
    await historical.maintenance.ready()
    for (const module of [neutral, historical]) {
      expect(JSON.parse(await module.runtime.queries.listCases())).toEqual([])
      expect(JSON.parse(await module.runtime.queries.listTerminalOutcomeGroups())).toEqual([])
      expect(await module.runtime.queries.findByExternalSubject('fixture', 'missing')).toBeNull()
      expect(await module.runtime.worker.runOneOutbox()).toBe('idle')
      expect(await module.runtime.worker.pumpOneDelivery()).toBe(false)
      expect(await module.runtime.worker.planOneReaction()).toBeNull()
      expect(await module.runtime.worker.inspectOneExecution()).toBe('idle')
      expect(await module.runtime.worker.publishOneChannelResult()).toBe('idle')
    }
  })

  test('digital employee: omitted or optional runtime keeps the authoring-only contract', async () => {
    const options = {
      db: harness.db,
      appHome: appHome(),
      typePackages: [],
      executionContracts,
    }
    const omitted = composeDigitalEmployee(options)
    await omitted.maintenance.ready()
    const optionalInput: ComposeDigitalEmployeeOptions = options
    const optional = composeDigitalEmployee(optionalInput)
    await optional.maintenance.ready()
    const historicalInput: ComposePostgresqlDigitalEmployeeOptions = {
      ...options,
      db: harness.db as PostgresqlDatabaseClient,
    }
    const historical = composePostgresqlDigitalEmployee(historicalInput)
    await historical.maintenance.ready()
    // @ts-expect-error An omitted runtime does not promise the runtime capability.
    const omittedAsComplete: DigitalEmployeeModuleWithRuntime = omitted
    // @ts-expect-error An optional runtime must remain nullable.
    const optionalAsComplete: DigitalEmployeeModuleWithRuntime = optional
    // @ts-expect-error The historical provider name preserves the same nullable contract.
    const historicalAsComplete: DigitalEmployeeModuleWithRuntime = historical
    void omittedAsComplete
    void optionalAsComplete
    void historicalAsComplete
    for (const module of [omitted, optional, historical]) {
      expect(module.runtime).toBeNull()
      expect(await module.queries.listEmployees()).toEqual([])
      expect(await module.inputUploads.sweepExpired()).toBe(0)
    }
  })
})
