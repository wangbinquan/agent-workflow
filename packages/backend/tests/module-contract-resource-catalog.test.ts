// Six-kind selectors share a public query contract even though each aggregate has
// its own richer command and query suites. Exercise the real provider composition.
import { expect, test } from 'bun:test'
import { TASK_DEFINITION_HOSTS } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { buildActor } from '@/auth/actor'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { decodeSkillToken } from '@/modules/resource-catalog/application/skills/skillToken'
import type {
  CatalogSelectorKind,
  ResourceCatalogCursor,
  ResourceSummary,
} from '@/modules/resource-catalog/public/types'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { describeEachProvider } from './helpers/eachProvider'
import { agentFixture, readWorkflowFixtures, workflowFixture } from './helpers/model'

const kinds = ['agent', 'skill', 'mcp', 'plugin', 'workflow', 'workgroup'] as const

async function seedKind(
  db: PersistenceDb,
  kind: CatalogSelectorKind,
  suffix: string,
  description = '',
  options: { readonly id?: string; readonly revision?: number } = {},
) {
  const revision = options.revision ?? 0
  const common = {
    id: options.id ?? `${kind}-${suffix}`,
    name: suffix,
    description,
    ownerUserId: 'catalog-contract-owner',
    visibility: 'public' as const,
    createdAt: 10,
    updatedAt: 20 + revision,
    aclRevision: revision,
  }
  const tables = tablesOf(db)
  switch (kind) {
    case 'agent':
      return agentFixture(db, common)
    case 'skill':
      return insertOne(db, tables.skills, {
        ...common,
        contentVersion: 1 + revision,
        metaRevision: revision,
      })
    case 'mcp':
      return insertOne(db, tables.mcps, {
        ...common,
        type: 'local',
        config: JSON.stringify({ command: ['fixture-not-executed'], timeoutMs: 1_000 + revision }),
      })
    case 'plugin':
      return insertOne(db, tables.plugins, {
        ...common,
        spec: 'contract-fixture@1.0.0',
        sourceKind: 'npm',
        cachedPath: '/fixture-not-read',
        installedAt: 10,
        optionsJson: JSON.stringify({ revision }),
      })
    case 'workflow':
      return workflowFixture(db, {
        ...common,
        version: 1 + revision,
        definition: { $schema_version: 1, nodes: [], edges: [] },
      })
    case 'workgroup':
      return insertOne(db, tables.workgroups, { ...common, version: 1 + revision })
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

  test('RFC-602 exact reads preserve all six non-default revisions and distinguish equal ids in different kinds', async () => {
    for (const kind of kinds) {
      await seedKind(harness.db, kind, 'shared-resource', `Description for ${kind} · 中文`, {
        id: 'shared-exact-id',
        revision: 7,
      })
    }
    await seedKind(harness.db, 'agent', 'agent-only')
    const { query, context } = catalog()
    const listed = await query.listVisible(context, { limit: 50 })
    for (const kind of kinds) {
      const summary = await query.getVisibleSummary(context, { kind, id: 'shared-exact-id' })
      const expectedSummary = listed.items.find(
        (item) => item.kind === kind && item.ref.id === 'shared-exact-id',
      )
      if (expectedSummary === undefined) throw new Error(`fixture list summary missing for ${kind}`)
      expect(summary).toEqual(expectedSummary)
      expect(summary).toMatchObject({
        ref: { kind, id: 'shared-exact-id' },
        kind,
        name: 'shared-resource',
        description: `Description for ${kind} · 中文`,
        visibilityHint: 'public',
      })
      if (summary === null) throw new Error('fixture summary missing')
      expect(kind).toBe(summary.revision.kind)
      switch (summary.revision.kind) {
        case 'agent':
          expect(summary.revision).toEqual({ kind: 'agent', updatedAt: 27, aclRevision: 7 })
          break
        case 'skill':
          expect(decodeSkillToken(summary.revision.token)).toEqual({
            skillId: 'shared-exact-id',
            contentVersion: 8,
            metaRevision: 7,
          })
          break
        case 'mcp':
        case 'plugin':
          expect(summary.revision.configHash).toMatch(/^[0-9a-f]{64}$/)
          break
        case 'workflow':
        case 'workgroup':
          expect(summary.revision).toEqual({ kind: summary.revision.kind, version: 8 })
          break
      }
    }
    expect(
      await query.getVisibleSummary(context, { kind: 'skill', id: 'agent-agent-only' }),
    ).toBeNull()
  })

  test('RFC-602 hit and miss each read at most one row in one statement, even beyond the former 500-row window', async () => {
    for (const kind of kinds) {
      await seedKind(harness.db, kind, 'aa-earlier')
      await seedKind(harness.db, kind, 'zz-target')
    }
    // More than one old lookup page precedes the target. Bulk insertion keeps
    // fixture setup proportional without changing the public query under test.
    const { skills } = tablesOf(harness.db)
    await harness.db.insert(skills).values(
      Array.from({ length: 503 }, (_, index) => ({
        id: `catalog-background-${index}`,
        name: `background-${String(index).padStart(4, '0')}`,
        description: '',
        ownerUserId: 'catalog-contract-owner',
        visibility: 'public' as const,
        createdAt: 10,
        updatedAt: 20,
      })),
    )
    const { query, context } = catalog()
    for (const kind of kinds) {
      for (const hit of [true, false]) {
        const id = hit ? `${kind}-zz-target` : `${kind}-missing`
        const recording = harness.recordStatements()
        try {
          const summary = await query.getVisibleSummary(context, { kind, id })
          if (hit) expect(summary?.ref).toEqual({ kind, id })
          else expect(summary).toBeNull()
        } finally {
          recording.stop()
        }
        const reads = recording.selects()
        expect(reads).toHaveLength(1)
        expect(reads[0]!.rows).toBe(hit ? 1 : 0)
        expect(reads[0]!.params).toBeLessThanOrEqual(8)
        expect(reads[0]!.values).toContain(id)
        expect(reads[0]!.sql).toMatch(/\blimit\b/i)
      }
    }
  })

  test('RFC-602 a renamed resource is still found by id and its new revision is read immediately', async () => {
    await seedKind(harness.db, 'skill', 'before-rename', 'Before')
    const { query, context } = catalog()
    const ref = { kind: 'skill' as const, id: 'skill-before-rename' }
    const before = await query.getVisibleSummary(context, ref)
    const { skills } = tablesOf(harness.db)
    await harness.db
      .update(skills)
      .set({ name: 'after-rename', description: 'After', contentVersion: 12, metaRevision: 4 })
      .where(eq(skills.id, ref.id))
    const after = await query.getVisibleSummary(context, ref)
    expect(after).toMatchObject({ ref, name: 'after-rename', description: 'After' })
    if (after?.revision.kind !== 'skill') throw new Error('fixture skill summary missing')
    expect(decodeSkillToken(after.revision.token)).toEqual({
      skillId: ref.id,
      contentVersion: 12,
      metaRevision: 4,
    })
    expect(after.revision).not.toEqual(before?.revision)
    expect(await query.getVisibleSummary(context, { kind: 'skill', id: 'after-rename' })).toBeNull()
    const page = await query.listVisible(context, { kinds: ['skill'], limit: 10 })
    expect(page.items).toEqual([after])
  })

  test('RFC-602 corrupt MCP and plugin neighbors cannot break a point read, while corrupt target errors remain unchanged', async () => {
    for (const kind of ['mcp', 'plugin'] as const) {
      await seedKind(harness.db, kind, 'aa-corrupt')
      await seedKind(harness.db, kind, 'zz-healthy')
    }
    const { mcps, plugins } = tablesOf(harness.db)
    await harness.db
      .update(mcps)
      .set({ config: JSON.stringify({ command: [] }) })
      .where(eq(mcps.id, 'mcp-aa-corrupt'))
    await harness.db
      .update(plugins)
      .set({ optionsJson: '[]' })
      .where(eq(plugins.id, 'plugin-aa-corrupt'))
    const { query, context } = catalog()
    for (const kind of ['mcp', 'plugin'] as const) {
      expect(
        await query.getVisibleSummary(context, { kind, id: `${kind}-zz-healthy` }),
      ).toMatchObject({ ref: { kind, id: `${kind}-zz-healthy` } })
      expect(await query.getVisibleSummary(context, { kind, id: `${kind}-missing` })).toBeNull()
      await expect(
        query.getVisibleSummary(context, { kind, id: `${kind}-aa-corrupt` }),
      ).rejects.toMatchObject({ code: `${kind}-row-corrupt` })
    }
  })

  test('RFC-602 definition-host workflow rows remain outside both exact and paged catalog reads', async () => {
    for (const host of Object.values(TASK_DEFINITION_HOSTS)) {
      await workflowFixture(
        harness.db,
        { ...host, definition: { $schema_version: 1, nodes: [], edges: [] } },
        { onConflict: 'ignore' },
      )
      expect(await readWorkflowFixtures(harness.db, { id: host.id })).toHaveLength(1)
    }
    await seedKind(harness.db, 'workflow', 'ordinary-workflow')
    const { query, context } = catalog()
    for (const host of Object.values(TASK_DEFINITION_HOSTS)) {
      expect(await query.getVisibleSummary(context, { kind: 'workflow', id: host.id })).toBeNull()
    }
    const listed = await query.listVisible(context, { kinds: ['workflow'], limit: 10 })
    expect(listed.items.map((item) => item.ref.id)).toEqual(['workflow-ordinary-workflow'])
  })
})
