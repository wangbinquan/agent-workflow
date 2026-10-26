import { convertedAgentFixture } from './helpers/model/frozenAgent'
import { agentFixtureReferences } from './helpers/model/agent'
// RFC-395 II-a A5: both providers preserve reference bytes, exact reverse results,
// caller transactions and existing validation diagnostics before any schema switch.
import { beforeEach, expect, test } from 'bun:test'
import { CreateAgentSchema, WORKFLOW_SCHEMA_VERSION } from '@agent-workflow/shared'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import { createAgentReferenceWriteParticipant } from '@/modules/resource-catalog/infrastructure/agentReferenceWrite'
import { createWorkflowDefinitionWriteParticipant } from '@/modules/resource-catalog/infrastructure/workflowDefinitionWrite'
import {
  createAgentMcpReferenceLookup,
  createAgentPluginReferenceLookup,
  createAgentSkillReferenceLookup,
  createAgentDependencyReferenceLookup,
  createWorkflowAgentReferenceLookup,
  createWorkflowCallReferenceLookup,
} from '@/modules/resource-catalog/infrastructure/referenceLookup'
import { validateAgentDependencies } from '@/modules/resource-catalog/public/queries'
import { agentFromPersistenceRow } from '@/modules/resource-catalog/infrastructure/agentPersistence'
import { createAgentDependencyReadPort } from '@/modules/resource-catalog/infrastructure/agentDependencyRead'
import { assertAgentDependencyGraph } from '@/modules/resource-catalog/domain/agentDependencies'
import { createFusionResourceSeedParticipant } from '@/modules/resource-catalog/infrastructure/fusionResourceSeed'
import { createFusionPersistence } from '@/modules/knowledge-evolution/infrastructure/fusionRepository'
import { describeEachProvider } from './helpers/eachProvider'
import referenceSemantics from './fixtures/rfc395-a5-reference-semantics.json'
import {
  patchAgentFixture,
  readAgentFixtures,
  workflowFixture,
  readWorkflowFixtures,
} from './helpers/model'

function unusedPort<T extends object>(): T {
  return new Proxy({} as T, {
    get() {
      throw new Error('unrelated fusion port called')
    },
  })
}

const OWNER = 'rfc395-a5-owner'
const refs = {
  skills: [
    { kind: 'managed' as const, skillId: 's' },
    { kind: 'project' as const, name: 'local' },
    { kind: 'managed' as const, skillId: 's' },
  ],
  dependsOn: ['b', 'a', 'b'],
  mcp: ['m2', 'm1', 'm2'],
  plugins: ['p2', 'p1', 'p2'],
}
const bytes = Object.fromEntries(
  Object.entries(refs).map(([key, value]) => [key, JSON.stringify(value)]),
)
const definition = (nodes: unknown[]) =>
  JSON.stringify({ $schema_version: WORKFLOW_SCHEMA_VERSION, inputs: [], nodes, edges: [] })

describeEachProvider('RFC-395 II-a A5 reference ports', (harness) => {
  beforeEach(async () => {
    const { users } = tablesOf(harness.db)
    await insertOne(harness.db, users, {
      id: OWNER,
      username: OWNER,
      displayName: OWNER,
      createdAt: 1,
      updatedAt: 1,
    })
  })
  test('agent participant writes all four ordered lists byte-for-byte on insert and replacement', async () => {
    await harness.session.transaction(async (tx) => {
      const writer = createAgentReferenceWriteParticipant(tx)
      const created = (
        await writer.insert({
          id: 'candidate',
          agent: CreateAgentSchema.parse({ name: 'candidate', ...refs }),
          ownerUserId: OWNER,
          now: 1,
        })
      )[0]!
      expect((await readAgentFixtures(tx, { id: created.id }))[0]).toMatchObject(bytes)
      await writer.update({
        current: created,
        patch: { ...refs, description: 'updated' },
        updatedAt: 2,
        expectedUpdatedAt: 1,
        expectedAclRevision: 0,
      })
      expect((await readAgentFixtures(tx, { id: created.id }))[0]).toMatchObject({
        ...bytes,
        updatedAt: 2,
      })
    })
  })
  test('definition writer retains exact whitespace and revision and joins caller rollback', async () => {
    const raw =
      ' { "nodes" : [], "edges" : [], "inputs" : [], "$schema_version" : ' +
      WORKFLOW_SCHEMA_VERSION +
      ' } '
    const aborted = new Error('caller rollback')
    await expect(
      harness.session.transaction(async (tx) => {
        const writer = createWorkflowDefinitionWriteParticipant(tx)
        await writer.insert({
          id: 'w',
          name: 'w',
          description: '',
          definition: raw,
          version: 7,
          ownerUserId: OWNER,
          visibility: 'private',
          aclRevision: 0,
          builtin: false,
          createdAt: 1,
          updatedAt: 1,
        })
        expect((await readWorkflowFixtures(tx, { id: 'w' }))[0]).toMatchObject({
          definition: raw,
          version: 7,
        })
        await writer.update({
          id: 'w',
          expectedVersion: 7,
          set: { definition: raw + '\n', version: 8 },
        })
        expect((await readWorkflowFixtures(tx, { id: 'w' }))[0]).toMatchObject({
          definition: raw + '\n',
          version: 8,
        })
        throw aborted
      }),
    ).rejects.toBe(aborted)
    expect(await readWorkflowFixtures(harness.db, { id: 'w' })).toEqual([])
  })
  test('converted references reject malformed source records and index decoded Unicode identities', async () => {
    await convertedAgentFixture(harness.db, [
      {
        id: 'hit',
        name: 'hit',
        mcp: '["M","M"]',
        plugins: '["P"]',
        skills: '[{"kind":"managed","skillId":"S"}]',
        dependsOn: '["A"]',
      },
      {
        id: 'trap',
        name: 'trap',
        mcp: '{"value":"M"}',
        plugins: '["P-extra"]',
        skills:
          '[{"kind":"project","skillId":"S"},{"kind":"managed","skillId":"other","note":"S"}]',
        dependsOn: '["A-extra"]',
      },
      {
        id: 'broken',
        name: 'broken',
        mcp: '["M"',
        plugins: '{"P"',
        skills: '["S"',
        dependsOn: '["A"',
      },
      {
        id: 'escaped',
        name: 'escaped',
        mcp: '["\\u004d"]',
        plugins: '["\\u0050"]',
        skills: '[{"kind":"managed","skillId":"\\u0053"}]',
        dependsOn: '["\\u0041"]',
      },
    ])
    expect(
      (await createAgentMcpReferenceLookup(harness.db).find('M')).map((row) => row.id).sort(),
    ).toEqual(['escaped', 'hit'])
    expect(
      (await createAgentPluginReferenceLookup(harness.db).find('P')).map((row) => row.id).sort(),
    ).toEqual(['escaped', 'hit'])
    expect(
      (await createAgentSkillReferenceLookup(harness.db).find('S')).map((row) => row.id).sort(),
    ).toEqual(['escaped', 'hit'])
    expect(
      (await createAgentDependencyReferenceLookup(harness.db).find('A'))
        .map((row) => row.id)
        .sort(),
    ).toEqual(['escaped', 'hit'])
    await harness.session.transaction(async (tx) => {
      await patchAgentFixture(tx, { id: 'trap' }, { mcp: '["M"]' })
      expect(
        (await createAgentMcpReferenceLookup(tx).find('M')).map((row) => row.id).sort(),
      ).toEqual(['escaped', 'hit', 'trap'])
    })
  })
  test('workflow reverse relations preserve agent-single filtering and cross-owner name matching', async () => {
    await workflowFixture(harness.db, [
      {
        id: 'one',
        name: 'one',
        definition: definition([
          { id: 'a', kind: 'agent-single', agentId: 'A' },
          { id: 'c', kind: 'call-workflow', workflowName: 'same', workflowId: 'other-cache' },
        ]),
        ownerUserId: OWNER,
      },
      {
        id: 'two',
        name: 'two',
        definition: definition([
          { id: 'x', kind: 'io-input', agentId: 'A' },
          { id: 'c', kind: 'call-workflow', workflowName: 'same', workflowId: 'unrelated' },
        ]),
      },
      { id: 'bad', name: 'bad', definition: 'invalid' },
    ])
    expect(
      (await createWorkflowAgentReferenceLookup(harness.db).find('A')).map((row) => row.id).sort(),
    ).toEqual(['one'])
    // The only caller checks for any referencing workflow; neither epoch orders the rows.
    expect(
      (await createWorkflowCallReferenceLookup(harness.db).find({ id: 'self', name: 'same' }))
        .map((row) => row.id)
        .sort(),
    ).toEqual(['one', 'two'])
    expect(
      await createWorkflowCallReferenceLookup(harness.db).find({ id: 'one', name: 'same' }),
    ).toEqual([{ id: 'two' }])
  })
  test('all validation policies retain exact self, missing and cycle messages', async () => {
    await convertedAgentFixture(harness.db, [{ id: 'a', name: 'a', dependsOn: '["root"]' }])
    const load = createAgentDependencyReadPort(harness.db).load
    for (const semantics of ['catalog', 'intent', 'application'] as const) {
      await expect(
        assertAgentDependencyGraph({
          candidateId: 'root',
          dependencies: ['root'],
          semantics,
          load,
        }),
      ).rejects.toMatchObject(
        semantics === 'intent'
          ? {
              code: 'agent-dependency-cycle',
              message: 'agent dependency graph contains a cycle',
              status: 422,
            }
          : {
              code: 'agent-dependency-self',
              message: 'agent cannot depend on itself',
              status: semantics === 'application' ? 400 : 422,
            },
      )
      await expect(
        assertAgentDependencyGraph({ candidateId: 'root', dependencies: ['a'], semantics, load }),
      ).rejects.toMatchObject({
        code: 'agent-dependency-cycle',
        message:
          semantics === 'application'
            ? 'agent dependsOn forms a cycle: root → a → root'
            : 'agent dependency graph contains a cycle',
      })
    }
    await expect(
      assertAgentDependencyGraph({
        candidateId: 'root',
        dependencies: ['gone'],
        semantics: 'catalog',
        load,
      }),
    ).rejects.toMatchObject({
      code: 'agent-dependency-not-found',
      message: "agent dependency 'gone' not found",
      details: { notFound: ['gone'] },
    })
    await expect(
      assertAgentDependencyGraph({
        candidateId: 'root',
        dependencies: ['gone', 'other'],
        semantics: 'application',
        load,
      }),
    ).rejects.toMatchObject({
      code: 'agent-dependency-not-found',
      message: 'agent dependsOn references unknown agent(s): gone, other',
      details: { notFound: ['gone', 'other'] },
    })
    await assertAgentDependencyGraph({
      candidateId: 'root',
      dependencies: ['gone'],
      semantics: 'intent',
      load,
    })
  })
  test('the frozen semantics ledger drives every declared validation policy', async () => {
    await convertedAgentFixture(harness.db, [{ id: 'a', name: 'a', dependsOn: '["root"]' }])
    const load = createAgentDependencyReadPort(harness.db).load
    const policies = ['package', 'intent', 'application', 'ordinary', 'template'] as const
    expect(Object.keys(referenceSemantics.validation).sort()).toEqual([...policies].sort())
    for (const policy of policies) {
      const semantics = policy === 'intent' || policy === 'application' ? policy : 'catalog'
      for (const [scenario, dependencies] of [
        ['self', ['root']],
        ['cycle', ['a']],
      ] as const) {
        const [code, message, status] = referenceSemantics.validation[policy][scenario]
        await expect(
          assertAgentDependencyGraph({
            candidateId: 'root',
            dependencies,
            semantics,
            load,
          }),
        ).rejects.toMatchObject({
          code,
          message: String(message).replace('${cyclePath joined with arrow}', 'root → a → root'),
          status,
        })
      }
    }
  })

  test('public dependency-validation entry retains self, direct/nested missing and cycle diagnostics', async () => {
    await convertedAgentFixture(harness.db, [
      { id: 'a', name: 'a', dependsOn: '["root"]' },
      { id: 'nested', name: 'nested', dependsOn: '["gone"]' },
    ])
    const reader = {
      async get(id: string) {
        const row = (await readAgentFixtures(harness.db, { id }))[0]
        return row === undefined ? null : agentFromPersistenceRow(row, agentFixtureReferences(row))
      },
    }
    for (const [dependencies, expected] of [
      [
        ['root'],
        {
          code: 'agent-dependency-self',
          message: 'agent cannot depend on itself',
          details: { id: 'root' },
        },
      ],
      [
        ['gone', 'other', 'gone'],
        {
          code: 'agent-dependency-not-found',
          message: 'agent dependsOn references unknown agent(s): gone, other',
          details: { notFound: ['gone', 'other'] },
        },
      ],
      [
        ['nested'],
        {
          code: 'agent-dependency-not-found',
          message: "agent 'gone' not found",
          details: { notFound: ['gone'] },
        },
      ],
      [
        ['a'],
        {
          code: 'agent-dependency-cycle',
          message: 'agent dependsOn forms a cycle: root → a → root',
          details: { cyclePath: ['root', 'a', 'root'] },
        },
      ],
    ] as const) {
      await expect(validateAgentDependencies(reader, 'root', dependencies)).rejects.toMatchObject({
        ...expected,
        status: 400,
      })
    }
  })
  test('fusion seed reaches the catalog participant and preserves empty reference bytes', async () => {
    const participant = createFusionResourceSeedParticipant(harness.db)
    let seedCalls = 0
    const persistence = createFusionPersistence({
      db: harness.db,
      memoryMembership: unusedPort(),
      fusedSkillReassignment: unusedPort(),
      skillVersionCommit: unusedPort(),
      resourceSeed: {
        async seed(seed, repairDefinition) {
          seedCalls += 1
          await participant.seed(seed, repairDefinition)
        },
      },
    })
    await persistence.seedResources({
      ownerUserId: OWNER,
      agent: {
        id: 'merger',
        name: 'merger',
        description: '',
        outputs: [],
        syncOutputsOnIterate: true,
        bodyMd: '',
      },
      workflow: {
        id: 'fusion',
        name: 'fusion',
        description: '',
        mergerAgentId: 'merger',
        definition: JSON.parse(
          definition([
            {
              id: 'merger',
              kind: 'agent-single',
              agentId: 'merger',
              prompt: '',
              dependencies: [],
            },
          ]),
        ),
      },
    })
    expect(seedCalls).toBe(1)
    expect((await readAgentFixtures(harness.db, { id: 'merger' }))[0]).toMatchObject({
      skills: '[]',
      dependsOn: '[]',
      mcp: '[]',
      plugins: '[]',
      builtin: true,
      visibility: 'public',
    })
    expect(await readWorkflowFixtures(harness.db, { id: 'fusion' })).toHaveLength(1)
  })
})
