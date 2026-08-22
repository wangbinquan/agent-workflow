import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { buildActor } from '../src/auth/actor'
import { createInMemoryDb } from '../src/db/client'
import {
  employeeDefinitionRevisions,
  employeeDefinitions,
  employeeTypePackages,
} from '../src/db/schema'
import { createUser } from '../src/services/users'
import { assertTriggerSaveable } from '../src/services/webhook/triggerValidation'
import { ValidationError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('Webhook Digital Employee trigger validation', () => {
  test('malformed persisted definitions fail with deterministic validation codes, never raw JSON errors', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const owner = await createUser(db, {
      username: 'employee-trigger-owner',
      displayName: 'employee trigger owner',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    const actor = buildActor({
      user: {
        id: owner.id,
        username: owner.username,
        displayName: owner.displayName,
        role: owner.role,
        status: owner.status,
      },
      source: 'session',
    })
    const employeeId = ulid()
    const now = Date.now()
    await db.insert(employeeTypePackages).values({
      typeId: 'fixture',
      revision: 1,
      descriptorJson: JSON.stringify({
        workIntakeAuthoring: {
          acceptedKinds: ['body'],
          targetFields: [],
        },
      }),
      descriptorDigest: 'fixture-package',
      state: 'published',
      registeredAt: now,
    })
    await db.insert(employeeDefinitions).values({
      id: employeeId,
      name: 'fixture employee',
      typeId: 'fixture',
      typeRevision: 1,
      configurationJson: '{}',
      currentRevision: 1,
      ownerUserId: owner.id,
      visibility: 'private',
      createdAt: now,
      updatedAt: now,
    })
    await db.insert(employeeDefinitionRevisions).values({
      employeeId,
      revision: 1,
      contentJson: '{not-json',
      contentDigest: 'broken-definition',
      createdAt: now,
      createdBy: owner.id,
    })
    const candidate = {
      launchKind: 'digital-employee' as const,
      launchRefId: employeeId,
      launchPayload: { intakeKind: 'body' as const, target: {}, body: '处理问题' },
      eventTypes: ['pipeline_failed'] as const,
      autoRegisterRepos: false,
    }

    await expect(assertTriggerSaveable(db, actor, candidate, null)).rejects.toMatchObject({
      code: 'employee-definition-unavailable',
      status: 422,
    })

    await db
      .update(employeeDefinitionRevisions)
      .set({ contentJson: JSON.stringify({ schemaVersion: 1 }) })
      .where(eq(employeeDefinitionRevisions.employeeId, employeeId))
    await db
      .update(employeeTypePackages)
      .set({ descriptorJson: '{not-json' })
      .where(eq(employeeTypePackages.typeId, 'fixture'))

    let thrown: unknown
    try {
      await assertTriggerSaveable(db, actor, candidate, null)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ValidationError)
    expect(thrown).toMatchObject({
      code: 'employee-intake-contract-unavailable',
      status: 422,
    })
  })
})
