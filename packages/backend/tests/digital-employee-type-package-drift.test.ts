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

  test('a frozen development@1 registration upgrades by appending development@2', () => {
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
      { typeId: 'development', revision: 2 },
      { typeId: 'development', revision: 1 },
    ])
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
  resolve: () => Promise.resolve(null),
}
const stubProgramArtifacts: ProgramArtifactPort = {
  put: () => Promise.reject(new Error('program artifacts unused in this test')),
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
