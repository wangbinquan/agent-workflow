// Six-kind selectors share a public query contract even though each aggregate has
// its own richer command and query suites. Exercise the real provider composition.
import { expect, test } from 'bun:test'
import { buildActor } from '@/auth/actor'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import type {
  CatalogSelectorKind,
  ResourceCatalogCursor,
  ResourceSummary,
} from '@/modules/resource-catalog/public/types'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { describeEachProvider } from './helpers/eachProvider'
import { agentFixture, workflowFixture } from './helpers/model'

const kinds = ['agent', 'skill', 'mcp', 'plugin', 'workflow', 'workgroup'] as const

async function seedKind(
  db: PersistenceDb,
  kind: CatalogSelectorKind,
  suffix: string,
  description = '',
) {
  const common = {
    id: `${kind}-${suffix}`,
    name: suffix,
    description,
    ownerUserId: 'catalog-contract-owner',
    visibility: 'public' as const,
    createdAt: 10,
    updatedAt: 20,
  }
  const tables = tablesOf(db)
  switch (kind) {
    case 'agent':
      return agentFixture(db, common)
    case 'skill':
      return insertOne(db, tables.skills, common)
    case 'mcp':
      return insertOne(db, tables.mcps, {
        ...common,
        type: 'local',
        config: JSON.stringify({ command: ['fixture-not-executed'] }),
      })
    case 'plugin':
      return insertOne(db, tables.plugins, {
        ...common,
        spec: 'contract-fixture@1.0.0',
        sourceKind: 'npm',
        cachedPath: '/fixture-not-read',
        installedAt: 10,
      })
    case 'workflow':
      return workflowFixture(db, {
        ...common,
        definition: { $schema_version: 1, nodes: [], edges: [] },
      })
    case 'workgroup':
      return insertOne(db, tables.workgroups, common)
  }
}

describeEachProvider('module contract — resource-catalog classic-six summaries', (harness) => {
  function catalog() {
    const actor = buildActor({
      user: {
        id: 'catalog-contract-owner',
        username: 'catalog-contract-owner',
        displayName: 'Catalog Contract',
        role: 'admin',
        status: 'active',
      },
      source: 'session',
    })
    const identity = composeIdentityAccess(harness.db)
    const context = identity.contexts.queryFromAuthenticatedPrincipal(
      { userId: actor.user.id, source: actor.source },
      'http',
    )
    return {
      query: composeResourceCatalogFor({ db: harness.db }).createQuery({
        resolveActor: () => actor,
      }),
      context,
    }
  }

  test('cursor pages cross all six kind boundaries without gaps or duplicates and keep each revision discriminator', async () => {
    for (const kind of kinds) {
      await seedKind(harness.db, kind, 'beta')
      await seedKind(harness.db, kind, 'alpha')
    }
    const { query, context } = catalog()
    const items: ResourceSummary[] = []
    let cursor: ResourceCatalogCursor | undefined
    let pages = 0
    do {
      const page = await query.listVisible(context, {
        limit: 3,
        ...(cursor === undefined ? {} : { cursor }),
      })
      expect(page.items.length).toBeLessThanOrEqual(3)
      items.push(...page.items)
      cursor = page.nextCursor ?? undefined
      pages += 1
      expect(pages).toBeLessThanOrEqual(4)
    } while (cursor !== undefined)
    expect(pages).toBe(4)
    expect(items.map((item) => item.ref.id)).toEqual(
      kinds.flatMap((kind) => [`${kind}-alpha`, `${kind}-beta`]),
    )
    for (const item of items) {
      expect(item.ref.kind).toBe(item.kind)
      expect(item.revision.kind).toBe(item.kind)
      expect(await query.getVisibleSummary(context, item.ref)).toEqual(item)
    }
    expect(
      await query.getVisibleSummary(context, { kind: 'workgroup', id: 'missing-workgroup' }),
    ).toBeNull()
  })

  test('each requested kind uses one bounded read, duplicate kinds do not duplicate work, and search is a literal substring', async () => {
    for (const kind of kinds) {
      for (const suffix of ['alpha', 'beta', 'gamma'])
        await seedKind(
          harness.db,
          kind,
          suffix,
          suffix === 'beta' ? 'Mixed CASE %_ marker' : 'ordinary description',
        )
    }
    const { query, context } = catalog()
    const recording = harness.recordStatements()
    try {
      const first = await query.listVisible(context, { limit: 1 })
      expect(first.items.map((item) => item.ref.id)).toEqual(['agent-alpha'])
      expect(first.nextCursor).not.toBeNull()
    } finally {
      recording.stop()
    }
    expect(recording.selects()).toHaveLength(6)
    expect(recording.selects().every((read) => read.rows <= 2 && /\blimit\b/i.test(read.sql))).toBe(
      true,
    )
    const selectedRecording = harness.recordStatements()
    try {
      const selected = await query.listVisible(context, {
        kinds: ['plugin', 'agent', 'agent'],
        search: '  case %_  ',
        limit: 500,
      })
      expect(selected.items.map((item) => item.ref.id)).toEqual(['agent-beta', 'plugin-beta'])
      expect(selected.nextCursor).toBeNull()
    } finally {
      selectedRecording.stop()
    }
    expect(selectedRecording.selects()).toHaveLength(2)
    expect((await query.listVisible(context, { kinds: [], limit: 1 })).items).toEqual([])
  })

  test('invalid limits and malformed cursors fail before reading any aggregate', async () => {
    const { query, context } = catalog()
    const recording = harness.recordStatements()
    try {
      for (const limit of [0, -1, 501, 1.5, Number.NaN]) {
        await expect(query.listVisible(context, { limit })).rejects.toMatchObject({
          code: 'resource-catalog-limit-invalid',
        })
      }
      await expect(
        query.listVisible(context, {
          limit: 1,
          cursor: 'not-a-catalog-cursor' as ResourceCatalogCursor,
        }),
      ).rejects.toMatchObject({ code: 'resource-catalog-cursor-invalid' })
    } finally {
      recording.stop()
    }
    expect(recording.selects()).toEqual([])
  })
})
