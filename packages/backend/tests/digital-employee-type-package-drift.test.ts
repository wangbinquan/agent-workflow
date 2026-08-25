/**
 * Locks the actionable failure surface of the built-in employee type package
 * digest guard (`employee-type-revision-drift`, see
 * `src/modules/digital-employee/infrastructure/sqliteAuthoringStore.ts`).
 *
 * Why this test exists: on 2026-08-21 `bun run dev` died at boot with the bare
 * line `development@1 changed without a revision bump` — no digests, no hint at
 * what to do next, and no test anywhere covering the branch. The daemon's
 * top-level handler prints `err.message` and nothing else (`src/main.ts`), so
 * the remediation has to live inside the message itself; `details` and logging
 * never reach the operator staring at the dead dev server. Keep these
 * assertions green so the guard cannot regress into an unactionable one-liner.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { employeeTypePackages } from '@/db/schema'
import { developmentEmployeeTypePackage } from '@/modules/development-automation/composition/employeeTypePackage'
import { DigitalEmployeeAuthoringService } from '@/modules/digital-employee/application/authoringService'
import type {
  ProgramArtifactPort,
  ToolConnectionCatalogPort,
} from '@/modules/digital-employee/composition/required-ports'
import type { ExecutionContractParticipant } from '@/modules/execution-contract/public/types'
import type { TypePackageRecord } from '@/modules/digital-employee/application/ports/authoringStore'
import {
  employeeTypePackageDescriptorSchema,
  packageDigest,
  type EmployeeTypeRuntimePackage,
} from '@/modules/digital-employee/domain/model'
import { createSqliteDigitalEmployeeAuthoringStore } from '@/modules/digital-employee/infrastructure/sqliteAuthoringStore'
import { withTypePackageDraftOverlay } from '@/modules/digital-employee/application/typePackageDraftOverlay'
import { DomainError } from '@/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const STALE_DIGEST = 'a'.repeat(64)

const descriptor = employeeTypePackageDescriptorSchema.parse(
  JSON.parse(developmentEmployeeTypePackage.descriptorJson) as unknown,
)
const currentDigest = packageDigest(descriptor)

function newStore() {
  return createSqliteDigitalEmployeeAuthoringStore(createInMemoryDb(MIGRATIONS))
}

function legacyDescriptor(): Record<string, unknown> {
  const legacy = structuredClone(descriptor) as unknown as Record<string, unknown>
  delete legacy.workStartWorkItemRef
  delete (legacy.authoringManifest as Record<string, unknown>).workIngresses
  const scheduling = new Map(
    (legacy.reactionRules as Record<string, unknown>[]).map((rule) => [
      rule.eventTypeId as string,
      {
        priority: rule.priority,
        preemptsContinuation: rule.preemptsContinuation,
      },
    ]),
  )
  legacy.eventTypes = (legacy.eventTypes as Record<string, unknown>[]).map((event) => ({
    ...event,
    ...(scheduling.get(event.eventTypeId as string) ?? {
      priority: 0,
      preemptsContinuation: false,
    }),
  }))
  legacy.reactionRules = (legacy.reactionRules as Record<string, unknown>[]).map(
    ({ priority: _priority, preemptsContinuation: _preemptsContinuation, ...rule }) => rule,
  )
  return legacy
}

function descriptorBeforePlanningBindingFields(): Record<string, unknown> {
  const frozen = structuredClone(descriptor) as unknown as Record<string, unknown>
  const authoringManifest = frozen.authoringManifest as Record<string, unknown>
  const workItems = authoringManifest.workItems as Record<string, unknown>[]
  const analyzeImplement = workItems.find(
    (workItem) => workItem.workItemRef === 'analyze-implement',
  )
  if (analyzeImplement === undefined) throw new Error('missing analyze-implement fixture')
  const humanReview = analyzeImplement.humanReview as Record<string, unknown> | null
  if (humanReview === null) throw new Error('missing analyze-implement humanReview fixture')
  delete humanReview.planningRoleRef
  delete humanReview.planningSlotRef
  return frozen
}

function record(descriptorDigest: string): TypePackageRecord {
  return { descriptor, descriptorDigest, state: 'published', registeredAt: 1_000 }
}

function captureDrift(run: () => void): DomainError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError)
    return error as DomainError
  }
  throw new Error('expected employee-type-revision-drift to be thrown')
}

describe('employee type package digest guard', () => {
  test('re-registering the identical descriptor is a no-op', () => {
    const store = newStore()
    store.ensureTypePackage(record(currentDigest))
    store.ensureTypePackage(record(currentDigest))
    expect(store.listTypePackages()).toHaveLength(1)
    expect(store.getTypePackage(descriptor.typeRef)?.descriptorDigest).toBe(currentDigest)
  })

  test('a frozen development@1 registration upgrades by appending development@10', () => {
    const store = newStore()
    const previous = structuredClone(descriptor)
    previous.typeRef.revision = 1
    store.ensureTypePackage({
      descriptor: previous,
      descriptorDigest: packageDigest(previous),
      state: 'published',
      registeredAt: 900,
    })

    store.ensureTypePackage(record(currentDigest))

    expect(store.listTypePackages().map((entry) => entry.descriptor.typeRef)).toEqual([
      { typeId: 'development', revision: 10 },
      { typeId: 'development', revision: 1 },
    ])
  })

  test('a historical task can still read its exact frozen responsibility map', () => {
    // Regression: EmployeeCase pins an exact type revision, but getType used
    // only the currently executable in-memory package registry. After a type
    // upgrade, /tasks/employee-cases/:id therefore rendered the timeline while
    // dropping the shared responsibility map with "employee type not found".
    const store = newStore()
    const historical = structuredClone(descriptor)
    historical.typeRef.revision = descriptor.typeRef.revision - 1
    historical.displayName = {
      ...historical.displayName,
      'en-US': 'Frozen historical development employee',
    }
    store.ensureTypePackage({
      descriptor: historical,
      descriptorDigest: packageDigest(historical),
      state: 'published',
      registeredAt: 900,
    })

    const service = new DigitalEmployeeAuthoringService({
      store,
      typePackages: [runtimePackage()],
      connectionCatalog: stubConnectionCatalog,
      programArtifacts: stubProgramArtifacts,
      executionContracts: unreachableExecutionContracts,
      now: () => 2_000,
    })

    expect(service.getType(historical.typeRef)).toEqual(historical)
    expect(service.getAuthoringManifest(historical.typeRef)).toEqual(historical.authoringManifest)
    expect(service.getType(descriptor.typeRef)).toEqual(descriptor)
  })

  test('an immutable revision-1 descriptor is projected without rewriting its frozen row', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const store = createSqliteDigitalEmployeeAuthoringStore(db)
    const legacy = legacyDescriptor()
    const frozenJson = JSON.stringify(legacy)
    const frozenDigest = 'b'.repeat(64)
    db.insert(employeeTypePackages)
      .values({
        typeId: 'development',
        revision: 1,
        descriptorJson: frozenJson,
        descriptorDigest: frozenDigest,
        state: 'published',
        registeredAt: 900,
      })
      .run()

    const projected = store.getTypePackage({ typeId: 'development', revision: 1 })

    expect(projected?.descriptor.workStartWorkItemRef).toBe('prepare-materials')
    expect(projected?.descriptor.authoringManifest.workIngresses).toEqual([])
    expect(projected?.descriptor.reactionRules[0]).toMatchObject({
      priority: descriptor.reactionRules[0]?.priority,
      preemptsContinuation: descriptor.reactionRules[0]?.preemptsContinuation,
    })
    expect(projected?.descriptor.eventTypes[0]).not.toHaveProperty('preemptsContinuation')
    expect(projected?.descriptorDigest).toBe(frozenDigest)
    const frozenRow = db
      .select({ descriptorJson: employeeTypePackages.descriptorJson })
      .from(employeeTypePackages)
      .get()
    expect(frozenRow?.descriptorJson).toBe(frozenJson)
  })

  test('historical planning bindings are projected from their frozen option and slot without rewriting the row', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const store = createSqliteDigitalEmployeeAuthoringStore(db)
    const historical = descriptorBeforePlanningBindingFields()
    const historicalTypeRef = {
      typeId: descriptor.typeRef.typeId,
      revision: descriptor.typeRef.revision - 1,
    }
    historical.typeRef = historicalTypeRef
    const frozenJson = JSON.stringify(historical)
    const frozenDigest = 'd'.repeat(64)
    db.insert(employeeTypePackages)
      .values({
        typeId: historicalTypeRef.typeId,
        revision: historicalTypeRef.revision,
        descriptorJson: frozenJson,
        descriptorDigest: frozenDigest,
        state: 'published',
        registeredAt: 900,
      })
      .run()

    const projected = store.getTypePackage(historicalTypeRef)
    const analyzeImplement = projected?.descriptor.authoringManifest.workItems.find(
      (item) => item.workItemRef === 'analyze-implement',
    )

    expect(analyzeImplement?.humanReview).toMatchObject({
      planningRoleRef: 'planning',
      planningSlotRef: 'plan',
    })
    expect(projected?.descriptorDigest).toBe(frozenDigest)
    const frozenRow = db
      .select({ descriptorJson: employeeTypePackages.descriptorJson })
      .from(employeeTypePackages)
      .get()
    expect(frozenRow?.descriptorJson).toBe(frozenJson)

    const service = new DigitalEmployeeAuthoringService({
      store: withTypePackageDraftOverlay(store),
      typePackages: [runtimePackage()],
      connectionCatalog: stubConnectionCatalog,
      programArtifacts: stubProgramArtifacts,
      executionContracts: unreachableExecutionContracts,
      now: () => 2_000,
    })
    expect(service.listTypes()).toEqual([descriptor])
    expect(
      service
        .getType(historicalTypeRef)
        .authoringManifest.workItems.find((item) => item.workItemRef === 'analyze-implement')
        ?.humanReview,
    ).toMatchObject({ planningRoleRef: 'planning', planningSlotRef: 'plan' })
  })

  test('an edited descriptor on a registered revision names both digests and both exits', () => {
    const store = newStore()
    store.ensureTypePackage(record(STALE_DIGEST))

    const error = captureDrift(() => {
      store.ensureTypePackage(record(currentDigest))
    })

    expect(error.code).toBe('employee-type-revision-drift')
    expect(error.status).toBe(409)
    // Which package, and which two descriptors disagree.
    expect(error.message).toContain(
      `${descriptor.typeRef.typeId}@${descriptor.typeRef.revision} changed without a revision bump`,
    )
    expect(error.message).toContain(STALE_DIGEST.slice(0, 12))
    expect(error.message).toContain(currentDigest.slice(0, 12))
    // Exit 1: publish the edit as a new revision.
    expect(error.message).toContain('typeRef.revision')
    // Exit 2: drop the stale registration (the dev-loop case) — spelled out as
    // runnable SQL, plus where to find the DB the statement applies to.
    expect(error.message).toContain(
      `DELETE FROM employee_type_packages WHERE type_id = '${descriptor.typeRef.typeId}' AND revision = ${descriptor.typeRef.revision};`,
    )
    expect(error.message).toContain('db ready path=')
    // Machine-readable duplicate for API/log consumers: full digests, untruncated.
    expect(error.details).toEqual({
      typeId: descriptor.typeRef.typeId,
      revision: descriptor.typeRef.revision,
      registeredDigest: STALE_DIGEST,
      currentDigest,
    })
  })

  test('drift aborts authoring-service construction, i.e. daemon boot', () => {
    const store = newStore()
    store.ensureTypePackage(record(STALE_DIGEST))

    const error = captureDrift(() => {
      new DigitalEmployeeAuthoringService({
        store,
        typePackages: [runtimePackage()],
        connectionCatalog: stubConnectionCatalog,
        programArtifacts: stubProgramArtifacts,
        executionContracts: unreachableExecutionContracts,
        now: () => 2_000,
      })
    })

    expect(error.code).toBe('employee-type-revision-drift')
    expect(error.message).toContain('DELETE FROM employee_type_packages')
  })

  test('the Bun-dev overlay serves the current draft without rewriting the frozen row', () => {
    const persistedStore = newStore()
    const frozenDescriptor = employeeTypePackageDescriptorSchema.parse({
      ...descriptor,
      displayName: {
        ...descriptor.displayName,
        'en-US': 'Frozen development employee',
      },
    })
    const frozenDigest = packageDigest(frozenDescriptor)
    persistedStore.ensureTypePackage({
      descriptor: frozenDescriptor,
      descriptorDigest: frozenDigest,
      state: 'published',
      registeredAt: 1_000,
    })
    const overlayStore = withTypePackageDraftOverlay(persistedStore)

    const service = new DigitalEmployeeAuthoringService({
      store: overlayStore,
      typePackages: [runtimePackage()],
      connectionCatalog: stubConnectionCatalog,
      programArtifacts: stubProgramArtifacts,
      executionContracts: unreachableExecutionContracts,
      now: () => 2_000,
    })

    expect(service.getType(descriptor.typeRef)).toEqual(descriptor)
    expect(service.listTypes()).toEqual([descriptor])
    expect(overlayStore.getTypePackage(descriptor.typeRef)).toMatchObject({
      descriptor,
      descriptorDigest: currentDigest,
    })
    expect(persistedStore.getTypePackage(descriptor.typeRef)).toMatchObject({
      descriptor: frozenDescriptor,
      descriptorDigest: frozenDigest,
      registeredAt: 1_000,
    })
  })

  test('the Bun-dev overlay boots over a same-revision row that predates newly required descriptor fields', () => {
    // Regression: a live Bun watch generation can freeze an intermediate
    // descriptor before a later edit adds required schema fields. The next
    // generation must select the current in-memory draft before attempting to
    // parse that immutable row with the newer schema; otherwise `bun dev`
    // aborts before the digest overlay can run.
    const db = createInMemoryDb(MIGRATIONS)
    const persistedStore = createSqliteDigitalEmployeeAuthoringStore(db)
    const frozenDescriptor = descriptorBeforePlanningBindingFields()
    // Keep this row unparseable even after the known historical planning-field
    // projection, so the test locks the overlay's schema-independent lookup
    // order rather than passing accidentally through that compatibility path.
    frozenDescriptor.watchGenerationDraftMarker = true
    const frozenJson = JSON.stringify(frozenDescriptor)
    const frozenDigest = 'c'.repeat(64)
    db.insert(employeeTypePackages)
      .values({
        typeId: descriptor.typeRef.typeId,
        revision: descriptor.typeRef.revision,
        descriptorJson: frozenJson,
        descriptorDigest: frozenDigest,
        state: 'published',
        registeredAt: 1_000,
      })
      .run()
    expect(() => persistedStore.getTypePackage(descriptor.typeRef)).toThrow()
    expect(persistedStore.listTypePackageRegistrations()).toHaveLength(1)
    const overlayStore = withTypePackageDraftOverlay(persistedStore)

    const service = new DigitalEmployeeAuthoringService({
      store: overlayStore,
      typePackages: [runtimePackage()],
      connectionCatalog: stubConnectionCatalog,
      programArtifacts: stubProgramArtifacts,
      executionContracts: unreachableExecutionContracts,
      now: () => 2_000,
    })

    expect(service.getType(descriptor.typeRef)).toEqual(descriptor)
    expect(service.listTypes()).toEqual([descriptor])
    expect(overlayStore.getTypePackage(descriptor.typeRef)).toMatchObject({
      descriptor,
      descriptorDigest: currentDigest,
    })
    const frozenRow = db
      .select({
        descriptorJson: employeeTypePackages.descriptorJson,
        descriptorDigest: employeeTypePackages.descriptorDigest,
        state: employeeTypePackages.state,
        registeredAt: employeeTypePackages.registeredAt,
      })
      .from(employeeTypePackages)
      .get()
    expect(frozenRow).toEqual({
      descriptorJson: frozenJson,
      descriptorDigest: frozenDigest,
      state: 'published',
      registeredAt: 1_000,
    })
  })

  test('only the explicit non-embedded Bun-dev command enables the overlay', () => {
    const backendPackage = JSON.parse(
      readFileSync(resolve(import.meta.dir, '..', 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> }
    expect(backendPackage.scripts.dev).toContain('AGENT_WORKFLOW_DEV_TYPE_PACKAGE_OVERLAY=1')
    expect(backendPackage.scripts.start).not.toContain('AGENT_WORKFLOW_DEV_TYPE_PACKAGE_OVERLAY')

    const start = readFileSync(resolve(import.meta.dir, '..', 'src', 'cli', 'start.ts'), 'utf8')
    expect(start).toMatch(
      /!IS_EMBEDDED\s*&&\s*devLockHandoffMs\(\) > 0\s*&&\s*process\.env\.AGENT_WORKFLOW_DEV_TYPE_PACKAGE_OVERLAY === '1'/,
    )
  })

  test('the daemon prints only err.message, so the remediation must live there', () => {
    // Source-level backstop for the coupling this whole file rests on: if the
    // top-level handler ever grows structured reporting, the guard message can
    // be trimmed — until then, dropping the hints leaves operators with nothing.
    const main = readFileSync(resolve(import.meta.dir, '..', 'src', 'main.ts'), 'utf8')
    expect(main).toContain('err instanceof Error ? err.message : String(err)')
  })
})

function runtimePackage(): EmployeeTypeRuntimePackage {
  return {
    descriptor,
    parseWorkScope: (input) => input,
    summarizeWorkScope: () => '',
    validateContractFixture: () => [],
  }
}

const stubConnectionCatalog: ToolConnectionCatalogPort = {
  resolve: () => null,
}
const stubProgramArtifacts: ProgramArtifactPort = {
  put: () => Promise.reject(new Error('program artifacts unused in this test')),
  read: () => null,
}
const unreachableExecutionContracts: ExecutionContractParticipant = {
  list: () => [],
  get: () => {
    throw new Error('drift aborts before execution-contract access')
  },
  validateExecutor: () => Promise.reject(new Error('drift aborts before contract validation')),
  validateAgentCandidates: () =>
    Promise.reject(new Error('drift aborts before candidate validation')),
  validateEnvelope: () => {
    throw new Error('drift aborts before output validation')
  },
}
