import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
// RFC-395 F: the index is rebuilt with canonical bytes and never pins a name selector to a cached ID.
import { beforeEach, expect, test } from 'bun:test'
import { asc, eq, sql } from 'drizzle-orm'
import { workflowDependencyIndexEntries } from '@agent-workflow/shared'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { createWorkflowDefinitionWriteParticipant } from '@/modules/resource-catalog/infrastructure/workflowDefinitionWrite'
import {
  createWorkflowAgentReferenceLookup,
  createWorkflowCallReferenceLookup,
} from '@/modules/resource-catalog/infrastructure/referenceLookup'
import { buildWorkflowDependencyIndex } from '@/modules/resource-catalog/infrastructure/migration/workflowDocument'
import { readOnlyProbes } from '@/modules/resource-catalog/infrastructure/migration/probes'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import { describeEachProvider } from './helpers/eachProvider'

const OWNER = 'rfc395-f-workflow-owner'
const definition =
  '{ "nodes": [{"id":"a","kind":"agent-single","agentId":"dangling-agent"},{"id":"w","kind":"call-workflow","workflowName":"same","workflowId":"cached-old-id"},{"id":"g","kind":"call-workgroup","workgroupName":"group","workgroupId":"cached-group"}], "inputs": [], "edges": [] }\n'
const empty = '{"inputs":[],"nodes":[],"edges":[]}'

test('runtime and V2 build identical index rows without rewriting authored bytes or caches', () => {
  const source: SourceRow = {
    table: 'workflows',
    phase: 'current',
    key: [canonicalValue('w')],
    encodedKey: encodeMigrationKey('workflows', [canonicalValue('w')]),
    canonical: { key: [canonicalValue('w')], values: [] },
    values: { id: 'w', version: 8, definition },
  }
  expect(buildWorkflowDependencyIndex(source)).toEqual(
    workflowDependencyIndexEntries(definition).map((r) => ({
      workflow_id: 'w',
      revision: 8,
      reference_path: r.referencePath,
      resource_kind: r.resourceKind,
      selector_kind: r.selectorKind,
      selector_value: r.selectorValue,
      namespace_json: r.namespaceJson,
    })),
  )
  expect(
    workflowDependencyIndexEntries(definition).map((r) => [r.selectorKind, r.selectorValue]),
  ).toEqual([
    ['id', 'dangling-agent'],
    ['name', 'same'],
    ['name', 'group'],
  ])
  expect(source.values.definition).toBe(definition)
  expect(() =>
    workflowDependencyIndexEntries(
      '{"nodes":[{"kind":"call-workflow","workflowId":"cache-only"}]}',
    ),
  ).toThrow('v2-workflow-selector-unproven')
})

describeEachProvider('RFC-395 F target workflow index', (h) => {
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
  const insert = (id: string, document = definition, name = id) =>
    h.session.transaction((tx) =>
      createWorkflowDefinitionWriteParticipant(tx).insert({
        id,
        name,
        description: '',
        definition: document,
        version: 8,
        ownerUserId: OWNER,
        visibility: 'private',
        aclRevision: 0,
        builtin: false,
        createdAt: 1,
        updatedAt: 1,
      }),
    )
  const index = async (id: string) => {
    const { workflowDependencyIndex: table } = tablesOf(h.db)
    return h.db
      .select()
      .from(table)
      .where(eq(table.workflowId, id))
      .orderBy(asc(table.referencePath))
  }
  test('create, CAS update and empty definition keep index revision parity and exact canonical bytes', async () => {
    await insert('caller')
    expect((await index('caller')).map((row) => [row.revision, row.referencePath])).toEqual([
      [8, 'nodes[0].agentId'],
      [8, 'nodes[1].workflowName'],
      [8, 'nodes[2].workgroupName'],
    ])
    const { workflows } = tablesOf(h.db)
    expect(
      (await h.db.select().from(workflows).where(eq(workflows.id, 'caller')))[0]!.definition,
    ).toBe(definition)
    const replaced =
      '{"nodes":[{"kind":"agent-single","agentId":"next"},{"kind":"agent-single","agentId":"next"}]}'
    await h.session.transaction((tx) =>
      createWorkflowDefinitionWriteParticipant(tx).update({
        id: 'caller',
        expectedVersion: 8,
        set: { definition: replaced, version: 9 },
      }),
    )
    expect((await index('caller')).map((row) => [row.revision, row.selectorValue])).toEqual([
      [9, 'next'],
      [9, 'next'],
    ])
    expect(
      (await createWorkflowAgentReferenceLookup(h.db).find('next')).map((row) => row.id),
    ).toEqual(['caller'])
    expect(await createWorkflowAgentReferenceLookup(h.db).find('dangling-agent')).toEqual([])
    await h.session.transaction((tx) =>
      createWorkflowDefinitionWriteParticipant(tx).update({
        id: 'caller',
        expectedVersion: 9,
        set: { definition: empty, version: 10 },
      }),
    )
    expect(await index('caller')).toEqual([])
  })
  test('stale CAS and aborted insert/update never leak index changes', async () => {
    await insert('fenced')
    const before = await index('fenced')
    expect(
      await h.session.transaction((tx) =>
        createWorkflowDefinitionWriteParticipant(tx).update({
          id: 'fenced',
          expectedVersion: 7,
          set: { definition: empty, version: 9 },
        }),
      ),
    ).toEqual([])
    expect(await index('fenced')).toEqual(before)
    const failure = new Error('rollback workflow and index')
    await expect(
      h.session.transaction(async (tx) => {
        await createWorkflowDefinitionWriteParticipant(tx).update({
          id: 'fenced',
          expectedVersion: 8,
          set: { definition: empty, version: 9 },
        })
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(await index('fenced')).toEqual(before)
    await expect(
      h.session.transaction(async (tx) => {
        await createWorkflowDefinitionWriteParticipant(tx).insert({
          id: 'rolled-back',
          name: 'rolled-back',
          description: '',
          definition,
          version: 1,
          ownerUserId: OWNER,
          visibility: 'private',
          aclRevision: 0,
          builtin: false,
          createdAt: 1,
          updatedAt: 1,
        })
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(await index('rolled-back')).toEqual([])
    const { workflows } = tablesOf(h.db)
    expect(
      (await h.db.select().from(workflows).where(eq(workflows.id, 'fenced')))[0]!.definition,
    ).toBe(definition)
  })
  test('name lookup follows rename/delete/recreate while ID selectors stay authored IDs', async () => {
    await insert('caller')
    await insert('cached-old-id', empty, 'same')
    const lookup = createWorkflowCallReferenceLookup(h.db)
    expect(await lookup.find({ id: 'cached-old-id', name: 'same' })).toEqual([{ id: 'caller' }])
    const { workflows } = tablesOf(h.db)
    await h.session.transaction((tx) =>
      createWorkflowDefinitionWriteParticipant(tx).update({
        id: 'cached-old-id',
        expectedVersion: 8,
        set: { definition: empty, version: 9, name: 'renamed' },
      }),
    )
    expect(await lookup.find({ id: 'cached-old-id', name: 'renamed' })).toEqual([])
    await h.db.delete(workflows).where(eq(workflows.id, 'cached-old-id'))
    await insert('replacement', empty, 'same')
    expect(await lookup.find({ id: 'replacement', name: 'same' })).toEqual([{ id: 'caller' }])
    expect((await index('caller')).map((row) => row.selectorValue)).toEqual([
      'dangling-agent',
      'same',
      'group',
    ])
    expect(
      (await createWorkflowAgentReferenceLookup(h.db).find('dangling-agent')).map((row) => row.id),
    ).toEqual(['caller'])
    expect(await createWorkflowAgentReferenceLookup(h.db).find('cached-old-id')).toEqual([])
    await h.db.delete(workflows).where(eq(workflows.id, 'caller'))
    expect(await index('caller')).toEqual([])
  })
  test('the broader conversion index preserves fields without broadening the runtime collector', async () => {
    await insert(
      'collector-compatibility',
      JSON.stringify({
        nodes: [
          { kind: 'future-node', agentId: 'retained-field' },
          { kind: 'agent-single', agentId: '' },
          { kind: 'agent-single', agentId: 'ordinary-id' },
          { kind: 'call-workflow', workflowName: '' },
        ],
      }),
    )
    expect((await index('collector-compatibility')).map((row) => row.selectorValue)).toEqual([
      'retained-field',
      '',
      'ordinary-id',
      '',
    ])
    const agents = createWorkflowAgentReferenceLookup(h.db)
    expect(await agents.find('retained-field')).toEqual([])
    expect(await agents.find('')).toEqual([])
    expect((await agents.find('ordinary-id')).map((row) => row.id)).toEqual([
      'collector-compatibility',
    ])
    expect(await createWorkflowCallReferenceLookup(h.db).find({ id: 'absent', name: '' })).toEqual(
      [],
    )
  })

  test('parity probe detects stale revisions and exact selector/namespace drift', async () => {
    await insert('probe')
    const connection = {
      provider: h.applicationBinding.provider,
      query: async (statement: string) => await rawRows(h.db, sql.raw(statement)),
    }
    const probe = readOnlyProbes.find(
      (entry) => entry.id === 'resource-catalog:workflow-index-parity',
    )!
    expect((await probe.run(connection)).passed).toBe(true)
    const { workflowDependencyIndex: table } = tablesOf(h.db)
    await h.db.update(table).set({ revision: 7 }).where(eq(table.workflowId, 'probe'))
    expect((await probe.run(connection)).passed).toBe(false)
    expect(await createWorkflowAgentReferenceLookup(h.db).find('dangling-agent')).toEqual([])
    await h.db
      .update(table)
      .set({ revision: 8, namespaceJson: '{}' })
      .where(eq(table.workflowId, 'probe'))
    expect((await probe.run(connection)).passed).toBe(false)
  })
})
