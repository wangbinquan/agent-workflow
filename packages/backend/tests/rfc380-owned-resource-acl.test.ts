// RFC-395 II-pre：用户夹具改接生产 identity-access 运行时，保留原用例意图。
// RFC-380: every owned-type ACL PUT emits the same post-commit revalidation on both providers.
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { afterEach, expect, test } from 'bun:test'
import { ulid } from 'ulid'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createUser } from './helpers/userFixture'
import { registerRevalidationTrigger, type RevocationReason } from '@/ws/revalidationHook'
import { createSession } from './helpers/auth/sessionStore'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
const now = 1700000000000
const RESOURCE_NAME = 'rfc380-acl-notification'
const resources = [
  {
    type: 'capability_template',
    base: '/api/capability-templates',
    seed: async (db: PersistenceDb, ownerUserId: string) => {
      const row = { id: ulid(), name: RESOURCE_NAME }
      const { capabilityTemplates } = tablesOf(db)
      await insertOne(db, capabilityTemplates, {
        ...row,
        description: 'acl matrix subject',
        capability: 'mr-review',
        scriptsJson: '{}',
        hooksJson: '[]',
        paramSchemaJson: '[]',
        paramDefaultsJson: '{}',
        agentBySlotJson: '{}',
        promptBySlotJson: '{}',
        paramsJson: '{}',
        stageContractVer: 1,
        ownerUserId,
        visibility: 'private',
        createdAt: now,
        updatedAt: now,
      })
      return row
    },
  },
  {
    type: 'action_template',
    base: '/api/code/action-templates',
    seed: async (db: PersistenceDb, ownerUserId: string) => {
      const row = { id: ulid(), name: RESOURCE_NAME }
      const { actionTemplates } = tablesOf(db)
      await insertOne(db, actionTemplates, {
        ...row,
        capabilityId: 'acl-matrix-capability',
        draftJson: '{}',
        publishedRevision: null,
        ownerUserId,
        visibility: 'private',
        createdAt: now,
        updatedAt: now,
      })
      return row
    },
  },
  {
    type: 'verification_profile',
    base: '/api/code/verification-profiles',
    seed: async (db: PersistenceDb, ownerUserId: string) => {
      const row = { id: ulid(), name: RESOURCE_NAME }
      const { verificationProfiles } = tablesOf(db)
      await insertOne(db, verificationProfiles, {
        ...row,
        draftJson: '{}',
        publishedRevision: null,
        ownerUserId,
        visibility: 'private',
        createdAt: now,
        updatedAt: now,
      })
      return row
    },
  },
  {
    type: 'digital_employee',
    base: '/api/code/digital-employees',
    seed: async (db: PersistenceDb, ownerUserId: string) => {
      const row = { id: ulid(), name: RESOURCE_NAME }
      const { digitalEmployees } = tablesOf(db)
      await insertOne(db, digitalEmployees, {
        ...row,
        draftJson: '{}',
        publishedRevision: null,
        ownerUserId,
        visibility: 'private',
        createdAt: now,
        updatedAt: now,
      })
      return row
    },
  },
  {
    type: 'automation_policy',
    base: '/api/code/automation-policies',
    seed: async (db: PersistenceDb, ownerUserId: string) => {
      const row = { id: ulid(), name: RESOURCE_NAME }
      const { automationPolicies } = tablesOf(db)
      await insertOne(db, automationPolicies, {
        ...row,
        draftJson: '{}',
        publishedRevision: null,
        ownerUserId,
        visibility: 'private',
        createdAt: now,
        updatedAt: now,
      })
      return row
    },
  },
] as const

describeEachProviderHttpApplication(
  'RFC-380 owned ACL notifications',
  { token: 'rfc380-token', tempPrefix: 'rfc380-acl-', opencodeVersion: null, dbVersion: 0 },
  (scope) => {
    afterEach(() => {
      registerRevalidationTrigger(async () => {})
    })
    for (const resource of resources)
      test(`${resource.type} PUT revalidates only after a successful commit`, async () => {
        const { app } = await scope.open()
        const db = scope.harness.db
        const user = await createUser(db, {
          username: 'rfc380_owner',
          displayName: 'Owner',
          role: 'admin',
          password: 'longEnoughPassword',
        })
        const { token } = await createSession({ db, userId: user.id })
        const row = await resource.seed(db, user.id)
        const reasons: RevocationReason[] = []
        registerRevalidationTrigger(async (reason) => {
          reasons.push(reason)
        })
        const request = () =>
          app.request(`${resource.base}/${row.id}/acl`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              expectedResourceId: row.id,
              expectedAclRevision: 0,
              visibility: 'public',
              grants: [],
            }),
          })
        const response = await request()
        expect(response.status, await response.text()).toBe(200)
        expect(reasons.filter((reason) => reason === 'resource-acl-changed')).toHaveLength(1)
        const committed = await app.request(`${resource.base}/${row.id}/acl`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        expect(await committed.json()).toMatchObject({ visibility: 'public', aclRevision: 1 })
        reasons.length = 0
        expect((await request()).status).toBe(409)
        expect(reasons).toEqual([])
      })
  },
)
