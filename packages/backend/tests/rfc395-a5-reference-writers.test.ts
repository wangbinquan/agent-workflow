import { legacyContentRef } from '@/platform/content/contentRef'
import { contentRowColumns } from '@/platform/content/infrastructure/contentStore'
import { composeSubjectTaskReferencePort } from '@/modules/task-execution/composition'
// RFC-395 II-a A5: exercise each real writer with the same ordered/duplicate
// references. Fixtures use A1 builders.
//
// RFC-401 A1 (design §2.4, user-confirmed 2026-11-02): every writer goes through the one Agent
// mutation participant, so all of them now deduplicate the four reference fields (first occurrence
// wins, input order kept) and report the same dependency-graph errors. Before A1 only the package
// writer deduplicated ID lists, and Intent reported self-dependency as a cycle and a missing
// dependency as `acl-missing-refs`.
import { beforeEach, expect, test } from 'bun:test'
import { CreateAgentSchema, type CreateAgent } from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import type {
  AgentPackageMutation,
  VersionedIntentResourceChangesetPlan,
} from '@/modules/resource-catalog/public/types'
import type { ResourceRequestContext } from '@/modules/resource-catalog/public/participants'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import { createAgentRepository } from '@/modules/resource-catalog/infrastructure/agentRepository'
import { createAgentPersistenceSemantics } from '@/modules/resource-catalog/infrastructure/agentPersistenceSemantics'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { createDigitalEmployeeAgentTemplateRepository } from '@/modules/resource-catalog/infrastructure/digitalEmployeeAgentTemplateCatalog'
import { createDemoResourceCatalogSeedPersistence } from '@/modules/resource-catalog/infrastructure/demoResourceCatalogSeed'
import { createIntentApplyResourcePortFactory } from '@/modules/resource-catalog/infrastructure/aggregateAdapters/intentApplyResourcePorts'
import {
  commitPostgresqlAgentPackageMutation,
  resourcePackageAgentBatch,
} from '@/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationArms'
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
const deduplicated = {
  skills: JSON.stringify([references.skills[0], references.skills[1]]),
  dependsOn: JSON.stringify(['b', 'a']),
  mcp: JSON.stringify(['m2', 'm1']),
  plugins: JSON.stringify(['p2', 'p1']),
}
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
    const { users, mcps, plugins } = tablesOf(harness.db),
      { skills } = tablesOf(harness.db)
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
      ...contentRowColumns(legacyContentRef('skill-path', 'local-file', '/tmp/a5-skill')),
      createdAt: 1,
      updatedAt: 1,
    })
  })

  interface Writer {
    create(input: CreateAgent): Promise<unknown>
    /** Replace the whole definition at the current revision. */
    update?(next: CreateAgent): Promise<unknown>
  }

  const current = async (id: string) => (await readAgentFixtures(harness.db, { id }))[0]!

  function writerFor(
    writer: 'ordinary' | 'intent' | 'package' | 'template' | 'demo',
    id: string,
  ): Writer {
    if (writer === 'ordinary') {
      const catalog = composeResourceCatalogFor({ db: harness.db })
      const repository = createAgentRepository({
        db: harness.db,
        id: () => id,
        now: () => 1,
        semantics: createAgentPersistenceSemantics({
          taskReferences: composeSubjectTaskReferencePort,
          db: harness.db,
          authorization: catalog.authorization,
        }),
        runtimes: {
          async get() {
            return null
          },
        },
      })
      return {
        create: (input) => repository.create(authority, input),
        async update(next) {
          const { name: _name, ...patch } = next
          const row = await current(id)
          return repository.update(authority, id, patch, {
            expectedUpdatedAt: row.updatedAt,
            expectedAclRevision: row.aclRevision,
          })
        },
      }
    }
    if (writer === 'intent') {
      const port = createIntentApplyResourcePortFactory({
        db: harness.db,
        now: () => 1,
        mcpLifecycle: unused(),
        pluginArtifacts: unused(),
        skillArtifacts: unused(),
      }).create({ actor: authority, authority: request }).agent
      const commit = async (
        plan: Extract<VersionedIntentResourceChangesetPlan, { kind: 'agent' }>,
        dependsOn: readonly string[],
      ) => {
        const prepared = await port.prepare(plan, {
          pendingIds: new Set(plan.action === 'create' ? [plan.resourceId] : []),
          pendingAgentNames: new Map<string, string>(),
          agentDependencies: new Map([[plan.resourceId, dependsOn]]),
          clientMutationId: plan.operationId,
        })
        return harness.session.transaction((transaction) =>
          port.commitInTransaction({
            transaction,
            authority: request,
            plan,
            prepared,
            context: {
              bundleCreatedNames: { workflow: new Set<string>(), workgroup: new Set<string>() },
            },
          }),
        )
      }
      let operation = 0
      return {
        create: (input) =>
          commit(
            {
              kind: 'agent',
              operationId: `${id}-${operation++}`,
              action: 'create',
              resourceId: id,
              fromCopy: false,
              payload: intentPayload(input),
            },
            input.dependsOn,
          ),
        async update(next) {
          const row = await current(id)
          return commit(
            {
              kind: 'agent',
              operationId: `${id}-${operation++}`,
              action: 'update',
              resourceId: id,
              expectedRevision: {
                kind: 'agent',
                updatedAt: row.updatedAt,
                aclRevision: row.aclRevision,
              },
              payload: intentPayload(next),
            },
            next.dependsOn,
          )
        },
      }
    }
    if (writer === 'package') {
      const commit = (mutation: AgentPackageMutation) =>
        harness.session.transaction(async (transaction) => {
          const reader = bindPostgresqlResourcePackageTransactionReader(transaction, authority)
          return commitPostgresqlAgentPackageMutation({
            transaction,
            reader,
            context: packageContext,
            mutation,
            resourceId: id,
            pendingNames: new Map(),
            id: () => id,
            now: () => 1,
            batch: await resourcePackageAgentBatch({
              reader,
              context: packageContext,
              agents: [{ mutation, resourceId: id }],
            }),
          })
        })
      let operation = 0
      return {
        create: (input) =>
          commit({ kind: 'agent-create', opId: id, slug: id, payload: wirePayload(input) }),
        async update(next) {
          const row = await current(id)
          return commit({
            kind: 'agent-update',
            opId: `${id}-${operation++}`,
            target: `external:${id}`,
            expect: { expectedUpdatedAt: row.updatedAt, expectedAclRevision: row.aclRevision },
            payload: wirePayload(next),
          })
        },
      }
    }
    if (writer === 'template') {
      const repository = createDigitalEmployeeAgentTemplateRepository(harness.db)
      return {
        create: (definition) => repository.createBuiltin({ id, definition }),
        async update(next) {
          const { name: _name, ...patch } = next
          const row = (await repository.get(id))!
          return repository.updateBuiltin({
            id,
            patch,
            expectedUpdatedAt: row.updatedAt,
            expectedAclRevision: row.aclRevision ?? 0,
          })
        },
      }
    }
    return {
      create: (input) =>
        createDemoResourceCatalogSeedPersistence(harness.db).seed({
          marker: { kind: 'initial-demo-offer', ownerUserId: OWNER, offeredAt: 1 },
          agent: { id, value: input },
          workflows: [],
        }),
    }
  }

  for (const writer of ['ordinary', 'intent', 'package', 'template', 'demo'] as const) {
    test(`${writer}: deduplicated reference bytes and the shared dependency-graph errors`, async () => {
      const input = CreateAgentSchema.parse({ name: writer, ...references })
      const id = `a5-${writer}`
      const save = writerFor(writer, id)
      await save.create(input)
      expect(await current(id)).toMatchObject(deduplicated)
      if (save.update === undefined) return

      await save.update({ ...input, description: 'updated' })
      expect(await current(id)).toMatchObject({ ...deduplicated, description: 'updated' })

      await expect(save.update({ ...input, dependsOn: [id] })).rejects.toMatchObject({
        code: 'agent-dependency-self',
        message: 'agent cannot depend on itself',
        status: 422,
      })
      await expect(save.update({ ...input, dependsOn: ['gone'] })).rejects.toMatchObject({
        code: 'agent-dependency-not-found',
        message: 'agent references unknown agent dependency(s): gone',
        status: 422,
        details: { notFound: ['gone'] },
      })
      await patchAgentFixture(harness.db, { id: 'b' }, { dependsOn: '["gone"]' })
      await expect(save.update({ ...input, dependsOn: ['b'] })).rejects.toMatchObject({
        code: 'agent-dependency-not-found',
        message: "agent dependency 'gone' not found",
        status: 422,
      })
      await patchAgentFixture(harness.db, { id: 'b' }, { dependsOn: JSON.stringify([id]) })
      await expect(save.update({ ...input, dependsOn: ['b'] })).rejects.toMatchObject({
        code: 'agent-dependency-cycle',
        message: 'agent dependency graph contains a cycle',
        status: 422,
      })
    })
  }
})
