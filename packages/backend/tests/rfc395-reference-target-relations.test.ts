import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
// RFC-395 F: relation storage must replay every authored occurrence on both providers.
import { beforeEach, expect, test } from 'bun:test'
import { asc, eq, sql } from 'drizzle-orm'
import { CreateAgentSchema, WorkflowDefinitionSchema, type Agent } from '@agent-workflow/shared'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import { insertOne } from '@/platform/persistence/singleInsert'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { createAgentReferenceWriteParticipant } from '@/modules/resource-catalog/infrastructure/agentReferenceWrite'
import {
  loadAgentPersistenceRow,
  loadAgentPersistenceRows,
} from '@/modules/resource-catalog/infrastructure/agentPersistence'
import { createAgentRepository } from '@/modules/resource-catalog/infrastructure/agentRepository'
import { getAgentById, listAgents } from '@/modules/resource-catalog/infrastructure/legacy/agent'
import { createDigitalEmployeeAgentTemplateRepository } from '@/modules/resource-catalog/infrastructure/digitalEmployeeAgentTemplateCatalog'
import { createDatabaseAgentResourceInventoryReadPort } from '@/modules/resource-catalog/infrastructure/agentResourceInventory'
import { createWorkflowValidationPort } from '@/modules/resource-catalog/infrastructure/workflowValidation'
import { createAgentDependencyReadPort } from '@/modules/resource-catalog/infrastructure/agentDependencyRead'
import { createAgentExecutionQueries } from '@/modules/resource-catalog/infrastructure/executionResourceQueries'
import { resolveAgentDependencyClosure } from '@/modules/resource-catalog/application/agents/agentDependencyValidation'
import {
  createAgentMcpReferenceLookup,
  createAgentPluginReferenceLookup,
  createAgentSkillReferenceLookup,
  createAgentDependencyReferenceLookup,
} from '@/modules/resource-catalog/infrastructure/referenceLookup'
import { readOnlyProbes } from '@/modules/resource-catalog/infrastructure/migration/probes'
import { agentReferenceRows } from '@/modules/resource-catalog/domain/agentReferenceKey'
import { explodeAgentReferences } from '@/modules/resource-catalog/infrastructure/migration/agentsRule'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import { describeEachProvider } from './helpers/eachProvider'
import { createTestDb } from './helpers/testDatabase'

const OWNER = 'rfc395-f-owner'
const references = {
  skills: [
    { kind: 'managed' as const, skillId: 'missing-skill' },
    { kind: 'project' as const, name: '本地/:技能' },
    { kind: 'managed' as const, skillId: 'missing-skill' },
  ],
  dependsOn: ['missing-agent', 'second-agent', 'missing-agent'],
  mcp: ['m_%"\\汉', 'other-mcp', 'm_%"\\汉'],
  plugins: ['missing-plugin', 'missing-plugin'],
}

test('the new fixture factory installs epoch 2 without the epoch-1 chain', async () => {
  const fixture = await createTestDb()
  try {
    expect(fixture.baseline.schemaEpoch).toBe(2)
    expect(fixture.baseline.seeds).toBe('install-only')
    expect('skills' in tablesOf(fixture.db).agents).toBe(false)
    expect(await fixture.db.select().from(tablesOf(fixture.db).agentSkillRefs)).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('runtime relation identities match V2, including separators, Unicode and duplicates', () => {
  const source: SourceRow = {
    table: 'agents',
    phase: 'current',
    key: [canonicalValue('a')],
    encodedKey: encodeMigrationKey('agents', [canonicalValue('a')]),
    canonical: { key: [canonicalValue('a')], values: [] },
    values: {
      id: 'a',
      skills: JSON.stringify(references.skills),
      depends_on: JSON.stringify(references.dependsOn),
      mcp: JSON.stringify(references.mcp),
      plugins: JSON.stringify(references.plugins),
    },
  }
  const converted = explodeAgentReferences(source)
  const live = agentReferenceRows('a', references)
  expect(converted.blocks).toEqual([])
  expect<readonly unknown[]>(
    live.skills.map((r) => [
      r.agentId,
      r.referenceKey,
      r.occurrence,
      r.ordinal,
      r.kind,
      r.skillId,
      r.projectName,
    ]),
  ).toEqual(
    converted.skillRefs.map((r) => [
      r.agent_id,
      r.reference_key,
      r.occurrence,
      r.ordinal,
      r.kind,
      r.skill_id,
      r.project_name,
    ]),
  )
  for (const [actual, expected, field] of [
    [live.mcp.map((r) => [r.mcpId, r.ordinal, r.occurrence]), converted.mcpRefs, 'mcp_id'],
    [
      live.plugins.map((r) => [r.pluginId, r.ordinal, r.occurrence]),
      converted.pluginRefs,
      'plugin_id',
    ],
    [
      live.dependencies.map((r) => [r.dependencyAgentId, r.ordinal, r.occurrence]),
      converted.dependencies,
      'dependency_agent_id',
    ],
  ] as const)
    expect<readonly unknown[]>(actual).toEqual(
      expected.map((r) => [r[field], r.ordinal, r.occurrence]),
    )
})

test('malformed epoch-1 reference JSON blocks conversion instead of becoming empty target lists', () => {
  for (const dependsOn of ['{', '[null,1,false,"leaf"]']) {
    const source: SourceRow = {
      table: 'agents',
      phase: 'current',
      key: [canonicalValue('invalid')],
      encodedKey: encodeMigrationKey('agents', [canonicalValue('invalid')]),
      canonical: { key: [canonicalValue('invalid')], values: [] },
      values: { id: 'invalid', skills: '[]', mcp: '[]', plugins: '[]', depends_on: dependsOn },
    }
    const converted = explodeAgentReferences(source)
    expect(converted.blocks.length).toBeGreaterThan(0)
    expect(converted.blocks.every((block) => block.code === 'v2-agent-reference-shape')).toBe(true)
  }
})

describeEachProvider('RFC-395 F target Agent relations', (h) => {
  beforeEach(async () => {
    await insertOne(h.db, tablesOf(h.db).users, {
      id: OWNER,
      username: OWNER,
      displayName: OWNER,
      role: 'user',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    })
  })
  const insert = (id: string, refs: Partial<typeof references> = {}) =>
    h.session.transaction(
      async (tx) =>
        (
          await createAgentReferenceWriteParticipant(tx).insert({
            id,
            agent: CreateAgentSchema.parse({ name: id, ...refs }),
            ownerUserId: OWNER,
            now: 10,
          })
        )[0]!,
    )
  const read = async (id: string): Promise<Agent> => {
    const agent = await createAgentExecutionQueries(h.db).read(id)
    if (agent === null) throw new Error(`missing test agent ${id}`)
    return agent
  }
  const readRepository = () => {
    const unexpected = async (): Promise<never> => {
      throw new Error('read called write semantics')
    }
    return createAgentRepository({
      db: h.db,
      semantics: {
        canonicalizeCreate: unexpected,
        canonicalizeUpdate: unexpected,
        assertCreateInTransaction: unexpected,
        assertUpdateInTransaction: unexpected,
        assertDeleteInTransaction: unexpected,
        referenceLabels: unexpected,
      },
    })
  }

  // F-F2: the parent query must be inside the same boundary as all four relation queries.
  test('every client Agent loader reads the parent and relations in one snapshot', async () => {
    const created = await insert('snapshot-loaders', references)
    const repository = readRepository()
    const loaders: [string, () => Promise<unknown>][] = [
      ['repository.get', async () => expect(await repository.get(created.id)).toEqual(created)],
      ['repository.list', async () => expect(await repository.list()).toContainEqual(created)],
      ['legacy.get', async () => expect(await getAgentById(h.db, created.id)).toEqual(created)],
      ['legacy.list', async () => expect(await listAgents(h.db)).toContainEqual(created)],
      ['execution', async () => expect(await read(created.id)).toEqual(created)],
      [
        'employee template',
        async () =>
          expect(await createDigitalEmployeeAgentTemplateRepository(h.db).get(created.id)).toEqual(
            created,
          ),
      ],
      [
        'inventory',
        async () => {
          const inventory = await createDatabaseAgentResourceInventoryReadPort({
            db: h.db,
            skillAvailability: { isAvailable: () => true },
          }).load()
          expect(inventory.agents.get(created.id)).toEqual(created)
        },
      ],
      [
        'workflow validation',
        async () =>
          createWorkflowValidationPort({
            db: h.db,
            skillContent: { isAvailable: async () => true },
          }).validate({
            definition: WorkflowDefinitionSchema.parse({ $schema_version: 7 }),
            currentWorkflow: { id: 'candidate', name: 'candidate' },
          }),
      ],
    ]
    for (const [name, load] of loaders) {
      const recording = h.recordStatements()
      try {
        await load()
        const statements = recording.statements.map((row) => row.sql)
        const begin = statements.findIndex((statement) => /^begin\b/i.test(statement))
        const commit = statements.findIndex((statement) => /^commit\b/i.test(statement))
        expect(
          statements.filter((statement) => /^begin\b/i.test(statement)),
          name,
        ).toHaveLength(1)
        expect(
          statements.filter((statement) => /^commit\b/i.test(statement)),
          name,
        ).toHaveLength(1)
        for (const table of [
          'agents',
          'agent_skill_refs',
          'agent_mcp_refs',
          'agent_plugin_refs',
          'agent_dependencies',
        ]) {
          const indices = statements.flatMap((statement, index) =>
            new RegExp(`\\bfrom (?:"agent_workflow"\\.)?"${table}"`).test(statement) ? [index] : [],
          )
          expect(indices, `${name}: ${table}`).toHaveLength(1)
          expect(indices[0]!, `${name}: ${table} before snapshot`).toBeGreaterThan(begin)
          expect(indices[0]!, `${name}: ${table} after snapshot`).toBeLessThan(commit)
        }
        if (h.capabilities.provider === 'postgresql') {
          expect(statements.join('\n')).toMatch(
            /set transaction[^\n]*repeatable read[^\n]*read only/i,
          )
        }
      } finally {
        recording.stop()
      }
    }
  })

  test('single and batch snapshots keep old parent and all old references during a concurrent patch', async () => {
    for (const batch of [false, true]) {
      const current = await insert(`snapshot-race-${batch}`, references)
      let parentRead!: () => void
      const parentReady = new Promise<void>((resolve) => {
        parentRead = resolve
      })
      // Register outside the reader's async transaction context: this is an independent writer.
      const writing = parentReady.then(() =>
        h.session.transaction((tx) =>
          createAgentReferenceWriteParticipant(tx).update({
            current,
            patch: {
              bodyMd: 'new body',
              skills: [{ kind: 'project', name: 'new skill' }],
              dependsOn: ['new dependency'],
              mcp: ['new mcp'],
              plugins: ['new plugin'],
            },
            updatedAt: 11,
            expectedUpdatedAt: 10,
            expectedAclRevision: 0,
          }),
        ),
      )
      try {
        const select = async (tx: PersistenceTx) => {
          const { agents } = tablesOf(tx)
          const rows = await tx.select().from(agents).where(eq(agents.id, current.id))
          parentRead()
          // PG can commit on another connection while the snapshot is open; SQLite holds its writer lease.
          if (h.capabilities.provider === 'postgresql') await writing
          return rows
        }
        const observed = batch
          ? (await loadAgentPersistenceRows(h.db, select))[0]
          : await loadAgentPersistenceRow(h.db, async (tx) => (await select(tx))[0])
        expect(observed).toEqual(current)
      } finally {
        parentRead()
        await writing
      }
      const changed = (await writing)[0]!
      expect(changed.updatedAt).toBe(11)
      expect(await read(current.id)).toEqual(changed)
    }
  })

  test('transaction loaders see uncommitted changes and reuse the caller boundary', async () => {
    const current = await insert('snapshot-caller', references)
    const rollback = new Error('rollback caller')
    const recording = h.recordStatements()
    try {
      await expect(
        h.session.transaction(async (tx) => {
          const changed = (
            await createAgentReferenceWriteParticipant(tx).update({
              current,
              patch: { bodyMd: 'uncommitted', skills: [], mcp: [], plugins: [], dependsOn: [] },
              updatedAt: 11,
              expectedUpdatedAt: 10,
              expectedAclRevision: 0,
            })
          )[0]!
          const { agents } = tablesOf(tx)
          const row = (await tx.select().from(agents).where(eq(agents.id, current.id)))[0]!
          expect(await loadAgentPersistenceRow(tx, row)).toEqual(changed)
          expect(await loadAgentPersistenceRows(tx, [row])).toEqual([changed])
          expect(await readRepository().get(current.id)).toEqual(changed)
          throw rollback
        }),
      ).rejects.toBe(rollback)
      const statements = recording.statements.map((row) => row.sql)
      expect(statements.filter((statement) => /^begin\b/i.test(statement))).toHaveLength(1)
      expect(statements.filter((statement) => /savepoint/i.test(statement))).toEqual([])
    } finally {
      recording.stop()
    }
    expect(await read(current.id)).toEqual(current)
  })

  test('missing single rows and empty batch queries retain their null and empty results', async () => {
    const { agents } = tablesOf(h.db)
    expect(
      await loadAgentPersistenceRow(
        h.db,
        async (tx) => (await tx.select().from(agents).where(eq(agents.id, 'absent')))[0],
      ),
    ).toBeNull()
    expect(
      await loadAgentPersistenceRows(h.db, async (tx) =>
        tx.select().from(agents).where(eq(agents.id, 'absent')),
      ),
    ).toEqual([])
  })

  test('the catalog loader reads its parent and relations in one provider snapshot', async () => {
    const created = await insert('snapshot-sync', references)
    const recording = h.recordStatements()
    try {
      const agent = await getAgentById(h.db, created.id)
      expect(agent).toEqual(created)
      const statements = recording.statements.map((row) => row.sql)
      expect(statements[0]).toMatch(/^begin\b/i)
      expect(statements.at(-1)).toMatch(/^commit\b/i)
      expect(recording.selects()).toHaveLength(5)
    } finally {
      recording.stop()
    }
    expect(await getAgentById(h.db, 'absent')).toBeNull()
  })
  test('all four lists preserve ordinal, occurrence, project names and dangling targets', async () => {
    const created = await insert('all-refs', references)
    expect(await read(created.id)).toEqual(created)
    for (const field of ['skills', 'dependsOn', 'mcp', 'plugins'] as const)
      expect(created[field]).toEqual(references[field])
    const { agentSkillRefs, agentMcpRefs, agentPluginRefs, agentDependencies } = tablesOf(h.db)
    for (const table of [agentSkillRefs, agentMcpRefs, agentPluginRefs, agentDependencies]) {
      const rows = await h.db
        .select({ ordinal: table.ordinal, occurrence: table.occurrence })
        .from(table)
        .orderBy(asc(table.ordinal))
      expect(rows.map((row) => row.ordinal)).toEqual(rows.map((_, index) => index))
      expect(rows.map((row) => row.occurrence)).toEqual(
        table === agentPluginRefs ? [0, 1] : [0, 0, 1],
      )
    }
    expect(await createAgentDependencyReadPort(h.db).load(created.id)).toEqual(references.dependsOn)
    expect(await createAgentDependencyReadPort(h.db).load('missing-agent')).toBeUndefined()
  })
  test('failed CAS and aborted writes leave both parent and all relation lists intact', async () => {
    const current = await insert('fenced', references)
    expect(
      await h.session.transaction((tx) =>
        createAgentReferenceWriteParticipant(tx).update({
          current,
          patch: { mcp: [], skills: [] },
          updatedAt: 11,
          expectedUpdatedAt: 9,
          expectedAclRevision: 0,
        }),
      ),
    ).toEqual([])
    expect(await read(current.id)).toEqual(current)
    const failure = new Error('abort after relations')
    await expect(
      h.session.transaction(async (tx) => {
        await createAgentReferenceWriteParticipant(tx).update({
          current,
          patch: { description: 'changed', skills: [], dependsOn: [], mcp: [], plugins: [] },
          updatedAt: 11,
          expectedUpdatedAt: 10,
          expectedAclRevision: 0,
        })
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(await read(current.id)).toEqual(current)
    await expect(
      h.session.transaction(async (tx) => {
        await createAgentReferenceWriteParticipant(tx).insert({
          id: 'aborted',
          agent: CreateAgentSchema.parse({ name: 'aborted', ...references }),
          ownerUserId: OWNER,
          now: 10,
        })
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(await createAgentExecutionQueries(h.db).read('aborted')).toBeNull()
  })
  test('sparse patches preserve references and full replacement resets occurrence within each list', async () => {
    const current = await insert('replace', references)
    const sparse = (
      await h.session.transaction((tx) =>
        createAgentReferenceWriteParticipant(tx).update({
          current,
          patch: {
            description: 'next',
            skills: undefined,
            dependsOn: undefined,
            mcp: undefined,
            plugins: undefined,
          },
          updatedAt: 11,
          expectedUpdatedAt: 10,
          expectedAclRevision: 0,
        }),
      )
    )[0]!
    const unchanged = await read(current.id)
    for (const field of ['skills', 'dependsOn', 'mcp', 'plugins'] as const)
      expect(unchanged[field]).toEqual(references[field])
    const updated = (
      await h.session.transaction((tx) =>
        createAgentReferenceWriteParticipant(tx).update({
          current: sparse,
          patch: {
            skills: [{ kind: 'project', name: 'only' }],
            mcp: ['new', 'new'],
            dependsOn: [],
            plugins: [],
          },
          updatedAt: 12,
          expectedUpdatedAt: 11,
          expectedAclRevision: 0,
        }),
      )
    )[0]!
    expect(await read(current.id)).toEqual(updated)
    expect(updated.dependsOn).toEqual([])
    const { agentMcpRefs } = tablesOf(h.db)
    expect(
      (await h.db.select().from(agentMcpRefs).orderBy(asc(agentMcpRefs.ordinal))).map((r) => [
        r.mcpId,
        r.ordinal,
        r.occurrence,
      ]),
    ).toEqual([
      ['new', 0, 0],
      ['new', 1, 1],
    ])
  })
  test('exact reverse lookup returns one parent per match and never treats a project name as a managed id', async () => {
    await insert('matching', references)
    await insert('project-only', { skills: [{ kind: 'project', name: 'missing-skill' }] })
    const recording = h.recordStatements()
    try {
      expect(
        (await createAgentMcpReferenceLookup(h.db).find(references.mcp[0]!)).map((r) => r.id),
      ).toEqual(['matching'])
      expect(await createAgentMcpReferenceLookup(h.db).find('%')).toEqual([])
      expect(
        (await createAgentPluginReferenceLookup(h.db).find('missing-plugin')).map((r) => r.id),
      ).toEqual(['matching'])
      expect(
        (await createAgentSkillReferenceLookup(h.db).find('missing-skill')).map((r) => r.id),
      ).toEqual(['matching'])
      expect(
        (await createAgentDependencyReferenceLookup(h.db).find('missing-agent')).map((r) => r.id),
      ).toEqual(['matching'])
      expect(recording.statements.every((row) => !/\blike\b/i.test(row.sql))).toBe(true)
    } finally {
      recording.stop()
    }
  })
  test('deleting a target retains dangling references; deleting their parent cascades only its children', async () => {
    await insert('target')
    const referrer = await insert('referrer', { ...references, dependsOn: ['target', 'target'] })
    const { agents, agentSkillRefs, agentMcpRefs, agentPluginRefs, agentDependencies } = tablesOf(
      h.db,
    )
    await h.db.delete(agents).where(eq(agents.id, 'target'))
    expect((await read(referrer.id)).dependsOn).toEqual(['target', 'target'])
    await h.db.delete(agents).where(eq(agents.id, referrer.id))
    for (const table of [agentSkillRefs, agentMcpRefs, agentPluginRefs, agentDependencies])
      expect(await h.db.select().from(table)).toEqual([])
  })
  test('dependency closure keeps breadth-first encounter order and reports the same cycle and missing cases', async () => {
    await insert('leaf')
    await insert('left', { dependsOn: ['leaf'] })
    await insert('right', { dependsOn: ['leaf'] })
    const root = await insert('root', { dependsOn: ['right', 'left', 'right'] })
    const queries = createAgentExecutionQueries(h.db)
    const observed: string[] = []
    const reader = {
      get: async (id: string) => {
        observed.push(id)
        return queries.read(id)
      },
    }
    const closure = await resolveAgentDependencyClosure(reader, { root, onMissing: 'fail' })
    expect(closure.ok).toBe(true)
    if (closure.ok)
      expect(closure.agents.map((agent) => agent.id)).toEqual(['root', 'right', 'left', 'leaf'])
    expect(observed).toEqual(['right', 'left', 'leaf'])
    await expect(
      resolveAgentDependencyClosure(reader, {
        root: { ...root, dependsOn: ['absent'] },
        onMissing: 'fail',
      }),
    ).rejects.toMatchObject({ code: 'agent-dependency-not-found' })
    const cycle = await insert('cycle', { dependsOn: ['cycle'] })
    expect(await resolveAgentDependencyClosure(reader, { root: cycle, onMissing: 'fail' })).toEqual(
      { ok: false, cyclePath: ['cycle', 'cycle'] },
    )
  })
  test('the read-only probe detects ordinal and occurrence drift without resolving dangling targets', async () => {
    await insert('probe', references)
    const connection = {
      provider: h.applicationBinding.provider,
      query: async (statement: string) => await rawRows(h.db, sql.raw(statement)),
    }
    const probe = readOnlyProbes.find(
      (entry) => entry.id === 'resource-catalog:agent-reference-order',
    )!
    expect((await probe.run(connection)).passed).toBe(true)
    const { agentMcpRefs } = tablesOf(h.db)
    await h.db.update(agentMcpRefs).set({ occurrence: 7 }).where(eq(agentMcpRefs.ordinal, 2))
    expect((await probe.run(connection)).passed).toBe(false)
  })
})
