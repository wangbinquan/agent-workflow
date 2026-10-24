import { composeSubjectTaskReferencePort } from '@/modules/task-execution/composition'
import { agentFixture, patchAgentFixture, readAgentFixtures } from './helpers/model'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { WORKFLOW_SCHEMA_VERSION } from '@agent-workflow/shared'
// RFC-359 W12: execute the complete classic catalog bundle before consolidating
// its daemon wiring. A renamed factory alone cannot prove that its ports work.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CreateAgentSchema } from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { AuthorityClaimRegistry } from '@/modules/identity-access/application/operationContext'
import { composeSkillMemoryFusionParticipantFactory } from '@/modules/memory/composition'
import { createAsyncSkillRestoreMembership } from '@/modules/knowledge-evolution/public/participants'
import { composeClassicCatalogs } from '@/modules/resource-catalog/composition/classicCatalogs'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { resetSkillBootVerifyForTest } from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import { createAgentPersistenceValues } from '@/modules/resource-catalog/infrastructure/agentPersistence'
import type { AgentOperationContext } from '@/modules/resource-catalog/public/participants'
import { describeEachProvider } from './helpers/eachProvider'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  resetSkillBootVerifyForTest()
})

describeEachProvider('RFC-359 W12 complete classic catalog composition', (harness) => {
  // RFC-359 W20: exercise the shared dependency traversal through the complete
  // catalog, keeping the original transaction and create/update entry points.
  test('agent dependency create and update traverse the real graph and preserve a rejected row', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rfc359-agent-graph-'))
    homes.push(home)
    const owner = 'classic-agent-graph-owner'
    const actor = buildActor({
      user: { id: owner, username: owner, displayName: owner, role: 'admin', status: 'active' },
      source: 'session',
    })
    const { users } = tablesOf(harness.db)
    await insertOne(harness.db, users, {
      ...actor.user,
      createdAt: 1,
      updatedAt: 1,
    })
    const { actor: authority } = new AuthorityClaimRegistry().mintDirectAuthority(
      { userId: owner, source: actor.source },
      { ...actor, userId: owner },
    )
    const catalog = composeClassicCatalogs({
      taskReferences: composeSubjectTaskReferencePort,
      db: harness.db,
      appHome: home,
      resourceCatalog: composeResourceCatalogFor({ db: harness.db }),
      runtimeProfiles: {
        async get() {
          throw new Error('the dependency fixture has no runtime profile')
        },
      },
      restoreMembership: createAsyncSkillRestoreMembership(
        composeSkillMemoryFusionParticipantFactory(),
      ),
    })
    for (const [id, dependsOn] of [
      ['graph-leaf', []],
      ['graph-a', ['graph-leaf']],
      ['graph-b', ['graph-leaf']],
    ] as const) {
      await agentFixture(
        harness.db,
        createAgentPersistenceValues({
          id,
          agent: CreateAgentSchema.parse({ name: id, dependsOn }),
          ownerUserId: owner,
          now: 1,
        }),
      )
    }
    const created = await catalog.agent.operations.create.invoke(
      authority,
      CreateAgentSchema.parse({ name: 'graph-root', dependsOn: ['graph-b', 'graph-a'] }),
    )
    expect(created.dependsOn).toEqual(['graph-b', 'graph-a'])
    expect(await catalog.agent.queries.get(authority, { id: created.id })).toEqual(created)
    const updated = await catalog.agent.operations.update.invoke(authority, {
      id: created.id,
      submission: {
        kind: 'json-body',
        body: JSON.stringify({
          description: 'same graph, new root order',
          dependsOn: ['graph-a', 'graph-b'],
          expectedUpdatedAt: created.updatedAt,
          expectedAclRevision: created.aclRevision,
        }),
      },
    })
    expect(updated).toEqual({
      ...created,
      description: 'same graph, new root order',
      dependsOn: ['graph-a', 'graph-b'],
      updatedAt: updated.updatedAt,
    })
    expect(updated.updatedAt).toBeGreaterThan(created.updatedAt)
    const before = (await readAgentFixtures(harness.db, { id: created.id }))[0]
    expect(before?.dependsOn).toBe('["graph-a","graph-b"]')

    // Both direct dependencies still exist. Only the nested graph now reaches
    // the root, so this failure comes from the save-time traversal.
    await patchAgentFixture(
      harness.db,
      { id: 'graph-b' },
      { dependsOn: JSON.stringify([created.id]) },
    )
    await expect(
      catalog.agent.operations.update.invoke(authority, {
        id: created.id,
        submission: {
          kind: 'json-body',
          body: JSON.stringify({
            description: 'must not be written',
            expectedUpdatedAt: updated.updatedAt,
            expectedAclRevision: updated.aclRevision,
          }),
        },
      }),
    ).rejects.toMatchObject({
      code: 'agent-dependency-cycle',
      message: 'agent dependency graph contains a cycle',
    })
    expect((await readAgentFixtures(harness.db, { id: created.id }))[0]).toEqual(before)
  })

  test('create, read and recompose agent, managed skill and workflow using the same database', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rfc359-classic-'))
    homes.push(home)
    const owner = 'classic-catalog-owner'
    const { users } = tablesOf(harness.db)
    await insertOne(harness.db, users, {
      id: owner,
      username: owner,
      displayName: owner,
      role: 'admin',
      createdAt: 1,
      updatedAt: 1,
    })
    const authority = {
      user: { id: owner, username: owner, displayName: owner, role: 'admin', status: 'active' },
      userId: owner,
      source: 'session',
      permissions: new Set(['resource-acl:private']),
    } as unknown as AgentOperationContext
    const resourceCatalog = composeResourceCatalogFor({ db: harness.db })
    const compose = (appHome: string) =>
      composeClassicCatalogs({
        taskReferences: composeSubjectTaskReferencePort,
        db: harness.db,
        appHome,
        runtimeProfiles: { get: async () => ({ enabled: true }) },
        restoreMembership: createAsyncSkillRestoreMembership(
          composeSkillMemoryFusionParticipantFactory(),
        ),
        resourceCatalog,
      })
    const recording = harness.recordStatements()
    const catalog = compose(home)
    recording.stop()
    expect(recording.statements).toEqual([])
    expect(readdirSync(home)).toEqual([])
    const skill = await catalog.skill.operations.create.invoke(authority, {
      submission: {
        kind: 'json-body',
        body: JSON.stringify({ name: 'classic-skill', bodyMd: 'original body' }),
      },
    })
    expect(await catalog.skillContent.isAvailable(skill)).toBe(true)
    expect(await catalog.skill.queries.content(authority, { id: skill.id })).toMatchObject({
      bodyMd: 'original body',
    })
    const agent = await catalog.agent.operations.create.invoke(
      authority,
      CreateAgentSchema.parse({
        name: 'classic-agent',
        runtime: 'opencode',
        skills: [{ kind: 'managed', skillId: skill.id }],
      }),
    )
    expect(await catalog.agent.queries.get(authority, { id: agent.id })).toMatchObject({
      id: agent.id,
      runtime: 'opencode',
      skills: [{ kind: 'managed', skillId: skill.id }],
    })
    expect(
      await catalog.agentResourceIntegrity.queries.closureStatus(authority, {
        rootAgentIds: [agent.id],
      }),
    ).toEqual({ ok: true, issues: [] })
    const workflow = await catalog.workflow.operations.create.invoke(authority, {
      submission: {
        kind: 'json-body',
        body: JSON.stringify({
          name: 'classic-workflow',
          definition: { $schema_version: 2, nodes: [], edges: [] },
        }),
      },
    })
    const recomposed = compose(home)
    expect(await recomposed.agent.queries.get(authority, { id: agent.id })).toEqual(agent)
    expect(await recomposed.skill.queries.get(authority, { id: skill.id })).toMatchObject(skill)
    expect(await recomposed.workflow.queries.get(authority, { id: workflow.id })).toMatchObject({
      ...workflow,
      definition: { $schema_version: WORKFLOW_SCHEMA_VERSION, inputs: [], nodes: [], edges: [] },
    })
    const otherHome = join(home, 'other-root')
    expect(await compose(otherHome).skillContent.isAvailable(skill)).toBe(false)
    expect(existsSync(otherHome)).toBe(false)
  })
})
