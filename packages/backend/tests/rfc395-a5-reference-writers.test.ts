// RFC-395 II-a A5: exercise each real writer with the same ordered/duplicate
// references; package alone deduplicates ID lists. Fixtures use A1 builders.
import { beforeEach, expect, test } from 'bun:test'
import { CreateAgentSchema, type CreateAgent } from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import type { VersionedIntentResourceChangesetPlan } from '@/modules/resource-catalog/public/types'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import { createAgentRepository } from '@/modules/resource-catalog/infrastructure/agentRepository'
import { createAgentPersistenceSemantics } from '@/modules/resource-catalog/infrastructure/agentPersistenceSemantics'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { composeDatabaseAgentResourceInventorySource } from '@/modules/resource-catalog/composition/agentResourceIntegrity'
import { createDigitalEmployeeAgentTemplateRepository } from '@/modules/resource-catalog/infrastructure/digitalEmployeeAgentTemplateCatalog'
import { createDemoResourceCatalogSeedPersistence } from '@/modules/resource-catalog/infrastructure/demoResourceCatalogSeed'
import { createIntentApplyResourcePortFactory } from '@/modules/resource-catalog/infrastructure/aggregateAdapters/intentApplyResourcePorts'
import { commitPostgresqlAgentPackageMutation } from '@/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationArms'
import { bindPostgresqlResourcePackageTransactionReader } from '@/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationParticipants'
import type { ResourcePackageArtifactContext } from '@/modules/resource-catalog/application/package/artifactOwners'
import { agentFixture, patchAgentFixture, readAgentFixtures } from './helpers/model'
import { describeEachProvider } from './helpers/eachProvider'

const OWNER = 'a5-writer-owner'
const authority = buildActor({
  source: 'pat',
  patId: 'a5',
  patScopes: [],
  user: { id: OWNER, username: OWNER, displayName: OWNER, role: 'admin', status: 'active' },
}) as unknown as DirectAuthenticatedAuthority
const request = authority as unknown as ResourceRequestContext
const references = {
  skills: [
    { kind: 'managed' as const, skillId: 's' },
    { kind: 'project' as const, name: 'local' },
    { kind: 'managed' as const, skillId: 's' },
  ],
  dependsOn: ['b', 'a', 'b'],
  mcp: ['m2', 'm1', 'm2'],
  plugins: ['p2', 'p1', 'p2'],
}
const expected = (dedupe: boolean) => ({
  skills: JSON.stringify(references.skills),
  dependsOn: JSON.stringify(dedupe ? ['b', 'a'] : references.dependsOn),
  mcp: JSON.stringify(dedupe ? ['m2', 'm1'] : references.mcp),
  plugins: JSON.stringify(dedupe ? ['p2', 'p1'] : references.plugins),
})
function unused<T extends object>(): T {
  return new Proxy({} as T, {
    get() {
      throw new Error('unrelated artifact port called')
    },
  })
}

// resolveChangeset replaces authored skill selectors with stable refs before prepare.
// The existing public plan payload type still names the authored selector shape.
const intentPayload = (value: CreateAgent) =>
  value as unknown as Extract<VersionedIntentResourceChangesetPlan, { kind: 'agent' }>['payload']

const packageContext: ResourcePackageArtifactContext = {
  actor: authority,
  authority: request,
  humanMemberMappings: [],
  secretInputs: [],
  ids: {
    mintCreate() {
      throw new Error('unexpected mint')
    },
    findCreate() {
      return null
    },
    listPending() {
      return []
    },
  },
}
const wirePayload = (value: CreateAgent) => ({
  ...value,
  skills: value.skills.map((ref) =>
    ref.kind === 'project' ? `project:${ref.name}` : `external:${ref.skillId}`,
  ),
  dependsOn: value.dependsOn.map((id) => `external:${id}`),
  mcp: value.mcp.map((id) => `external:${id}`),
  plugins: value.plugins.map((id) => `external:${id}`),
})

describeEachProvider('RFC-395 II-a A5 writer bytes', (harness) => {
  beforeEach(async () => {
    const { users, mcps, plugins, skills } = tablesOf(harness.db)
    for (const id of [OWNER, SYSTEM_USER_ID]) {
      await harness.db
        .insert(users)
        .values({ id, username: id, displayName: id, createdAt: 1, updatedAt: 1 })
        .onConflictDoNothing()
    }
    await agentFixture(harness.db, [
      { id: 'a', name: 'a' },
      { id: 'b', name: 'b' },
    ])
    for (const id of ['m1', 'm2'])
      await insertOne(harness.db, mcps, {
        id,
        name: id,
        type: 'local',
        config: '{"command":["echo"]}',
        createdAt: 1,
        updatedAt: 1,
      })
    for (const id of ['p1', 'p2'])
      await insertOne(harness.db, plugins, {
        id,
        name: id,
        spec: 'fixture@1.0.0',
        sourceKind: 'npm',
        cachedPath: '/tmp/a5-plugin',
        installedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      })
    await insertOne(harness.db, skills, {
      id: 's',
      name: 's',
      managedPath: '/tmp/a5-skill',
      createdAt: 1,
      updatedAt: 1,
    })
  })

  for (const writer of ['ordinary', 'intent', 'package', 'template', 'demo'] as const) {
    test(`${writer}: four kinds preserve the writer's exact bytes and dependency self code`, async () => {
      const input = CreateAgentSchema.parse({ name: writer, ...references })
      const id = `a5-${writer}`
      const verify = async () =>
        expect((await readAgentFixtures(harness.db, { id }))[0]).toMatchObject(
          expected(writer === 'package'),
        )
      const graphFailures = async (save: (dependsOn: string[]) => Promise<unknown>) => {
        await patchAgentFixture(harness.db, { id: 'b' }, { dependsOn: '["gone"]' })
        await expect(save(['b'])).rejects.toMatchObject({
          code: 'agent-dependency-not-found',
          message: "agent dependency 'gone' not found",
          status: 422,
        })
        await patchAgentFixture(harness.db, { id: 'b' }, { dependsOn: JSON.stringify([id]) })
        await expect(save(['b'])).rejects.toMatchObject({
          code: 'agent-dependency-cycle',
          message: 'agent dependency graph contains a cycle',
          status: 422,
        })
      }
      if (writer === 'ordinary') {
        const catalog = composeResourceCatalogFor({ db: harness.db })
        const repository = createAgentRepository({
          db: harness.db,
          id: () => id,
          now: () => 1,
          semantics: createAgentPersistenceSemantics({
            db: harness.db,
            authorization: catalog.authorization,
            resourceInventory: composeDatabaseAgentResourceInventorySource({
              db: harness.db,
              authorization: catalog.authorization,
            }),
            runtimeProfiles: {
              async get() {
                return null
              },
            },
          }),
        })
        const created = await repository.create(authority, input)
        await verify()
        const changed = await repository.update(
          authority,
          id,
          { ...references, description: 'updated' },
          { expectedUpdatedAt: created.updatedAt, expectedAclRevision: created.aclRevision ?? 0 },
        )
        await expect(
          repository.update(
            authority,
            id,
            { dependsOn: [id] },
            { expectedUpdatedAt: changed.updatedAt, expectedAclRevision: changed.aclRevision ?? 0 },
          ),
        ).rejects.toMatchObject({
          code: 'agent-dependency-self',
          message: 'agent cannot depend on itself',
        })
        await graphFailures((dependsOn) =>
          repository.update(
            authority,
            id,
            { dependsOn },
            {
              expectedUpdatedAt: changed.updatedAt,
              expectedAclRevision: changed.aclRevision ?? 0,
            },
          ),
        )
      } else if (writer === 'intent') {
        const port = createIntentApplyResourcePortFactory({
          db: harness.db,
          now: () => 1,
          mcpLifecycle: unused(),
          pluginArtifacts: unused(),
          skillArtifacts: unused(),
        }).create({ actor: authority, authority: request }).agent
        const plan = {
          kind: 'agent' as const,
          operationId: id,
          action: 'create' as const,
          resourceId: id,
          fromCopy: false,
          payload: intentPayload(input),
        }
        const context = {
          pendingIds: new Set([id]),
          pendingAgentNames: new Map<string, string>(),
          clientMutationId: id,
        }
        const prepared = await port.prepare(plan, context)
        const commitContext = {
          bundleCreatedNames: { workflow: new Set<string>(), workgroup: new Set<string>() },
        }
        await harness.session.transaction((transaction) =>
          port.commitInTransaction({
            transaction,
            authority: request,
            plan,
            prepared,
            context: commitContext,
          }),
        )
        await verify()
        const update = {
          kind: 'agent' as const,
          operationId: id + '-update',
          action: 'update' as const,
          resourceId: id,
          expectedRevision: { kind: 'agent' as const, updatedAt: 1, aclRevision: 0 },
          payload: intentPayload({ ...input, description: 'updated' }),
        }
        await harness.session.transaction(async (transaction) =>
          port.commitInTransaction({
            transaction,
            authority: request,
            plan: update,
            prepared: await port.prepare(update, context),
            context: commitContext,
          }),
        )
        const selfPlan = {
          ...plan,
          resourceId: 'self',
          payload: intentPayload({ ...input, name: 'self', dependsOn: ['self'] }),
        }
        const selfPrepared = await port.prepare(selfPlan, {
          ...context,
          pendingIds: new Set(['self']),
        })
        await expect(
          harness.session.transaction((transaction) =>
            port.commitInTransaction({
              transaction,
              authority: request,
              plan: selfPlan,
              prepared: selfPrepared,
              context: commitContext,
            }),
          ),
        ).rejects.toMatchObject({
          code: 'agent-dependency-cycle',
          message: 'agent dependency graph contains a cycle',
        })
        const missingPlan = {
          ...plan,
          resourceId: 'missing',
          payload: intentPayload({ ...input, name: 'missing', dependsOn: ['gone'] }),
        }
        const missingPrepared = await port.prepare(missingPlan, {
          ...context,
          pendingIds: new Set(['missing']),
        })
        await expect(
          harness.session.transaction((transaction) =>
            port.commitInTransaction({
              transaction,
              authority: request,
              plan: missingPlan,
              prepared: missingPrepared,
              context: commitContext,
            }),
          ),
        ).rejects.toMatchObject({
          code: 'acl-missing-refs',
          message: "you do not have access to: agent 'gone'",
          details: { missing: [{ type: 'agent', id: 'gone' }] },
        })
        await patchAgentFixture(harness.db, { id: 'b' }, { dependsOn: JSON.stringify([id]) })
        const current = (await readAgentFixtures(harness.db, { id }))[0]!
        const cyclePlan = {
          ...update,
          expectedRevision: {
            kind: 'agent' as const,
            updatedAt: current.updatedAt,
            aclRevision: current.aclRevision,
          },
          payload: intentPayload({ ...input, dependsOn: ['b'] }),
        }
        const cyclePrepared = await port.prepare(cyclePlan, context)
        await expect(
          harness.session.transaction((transaction) =>
            port.commitInTransaction({
              transaction,
              authority: request,
              plan: cyclePlan,
              prepared: cyclePrepared,
              context: commitContext,
            }),
          ),
        ).rejects.toMatchObject({
          code: 'agent-dependency-cycle',
          message: 'agent dependency graph contains a cycle',
          status: 422,
        })
      } else if (writer === 'package') {
        await harness.session.transaction((transaction) =>
          commitPostgresqlAgentPackageMutation({
            transaction,
            reader: bindPostgresqlResourcePackageTransactionReader(transaction, authority),
            context: packageContext,
            mutation: { kind: 'agent-create', opId: id, slug: id, payload: wirePayload(input) },
            resourceId: id,
            pendingNames: new Map(),
            id: () => id,
            now: () => 1,
          }),
        )
        await verify()
        await harness.session.transaction((transaction) =>
          commitPostgresqlAgentPackageMutation({
            transaction,
            reader: bindPostgresqlResourcePackageTransactionReader(transaction, authority),
            context: packageContext,
            mutation: {
              kind: 'agent-update',
              opId: id + '-update',
              target: `external:${id}`,
              expect: { expectedUpdatedAt: 1, expectedAclRevision: 0 },
              payload: wirePayload({ ...input, description: 'updated' }),
            },
            resourceId: id,
            pendingNames: new Map(),
            id: () => id,
            now: () => 1,
          }),
        )
        const changed = (await readAgentFixtures(harness.db, { id }))[0]!
        await expect(
          harness.session.transaction((transaction) =>
            commitPostgresqlAgentPackageMutation({
              transaction,
              reader: bindPostgresqlResourcePackageTransactionReader(transaction, authority),
              context: packageContext,
              mutation: {
                kind: 'agent-update',
                opId: id + '-self',
                target: `external:${id}`,
                expect: {
                  expectedUpdatedAt: changed.updatedAt,
                  expectedAclRevision: changed.aclRevision,
                },
                payload: wirePayload({ ...input, dependsOn: [id] }),
              },
              resourceId: id,
              pendingNames: new Map(),
              id: () => id,
              now: () => 1,
            }),
          ),
        ).rejects.toMatchObject({
          code: 'agent-dependency-self',
          message: 'agent cannot depend on itself',
        })
        await graphFailures((dependsOn) =>
          harness.session.transaction((transaction) =>
            commitPostgresqlAgentPackageMutation({
              transaction,
              reader: bindPostgresqlResourcePackageTransactionReader(transaction, authority),
              context: packageContext,
              mutation: {
                kind: 'agent-update',
                opId: id + '-invalid-graph',
                target: `external:${id}`,
                expect: {
                  expectedUpdatedAt: changed.updatedAt,
                  expectedAclRevision: changed.aclRevision,
                },
                payload: wirePayload({ ...input, dependsOn }),
              },
              resourceId: id,
              pendingNames: new Map(),
              id: () => id,
              now: () => 1,
            }),
          ),
        )
      } else if (writer === 'template') {
        const repository = createDigitalEmployeeAgentTemplateRepository(harness.db)
        await repository.createBuiltin({ id, definition: input })
        await verify()
        const current = (await repository.get(id))!
        await repository.updateBuiltin({
          id,
          patch: { ...references, description: 'updated' },
          expectedUpdatedAt: current.updatedAt,
          expectedAclRevision: current.aclRevision ?? 0,
        })
        const changed = (await repository.get(id))!
        await expect(
          repository.updateBuiltin({
            id,
            patch: { dependsOn: [id] },
            expectedUpdatedAt: changed.updatedAt,
            expectedAclRevision: changed.aclRevision ?? 0,
          }),
        ).rejects.toMatchObject({
          code: 'agent-dependency-self',
          message: 'agent cannot depend on itself',
        })
        await graphFailures((dependsOn) =>
          repository.updateBuiltin({
            id,
            patch: { dependsOn },
            expectedUpdatedAt: changed.updatedAt,
            expectedAclRevision: changed.aclRevision ?? 0,
          }),
        )
      } else {
        await createDemoResourceCatalogSeedPersistence(harness.db).seed({
          marker: { kind: 'initial-demo-offer', ownerUserId: OWNER, offeredAt: 1 },
          agent: { id, value: input },
          workflows: [],
        })
      }
      await verify()
    })
  }
})
