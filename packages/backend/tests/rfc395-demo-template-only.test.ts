// RFC-395 U-5: only the editable capability template is offered; historic demo rows remain archived.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { composeCodeCapabilityDemoSeedParticipant } from '@/modules/code-capability/composition/demoSeed'
import { createCodeCapabilityDemoSeedParticipant } from '@/modules/code-capability/application/demoSeed'
import { seedDemoContent, DEMO_TEMPLATE_ID } from '@/services/demoSeed'
import { composeDemoResourceCatalogSeedParticipant } from '@/modules/resource-catalog/composition/demoResourceCatalogSeed'
import { describeEachProvider } from './helpers/eachProvider'
import { seedCodeHistoryRows, historyFixtureReader } from './helpers/legacyCapabilitySeed'

const expected = {
  capabilityTemplateId: DEMO_TEMPLATE_ID,
  workItemId: null,
  roundId: null,
  stageIds: [],
}
describeEachProvider('RFC-395 demo template only', (h) => {
  test('retries write only one template, keep its content/slot and return no history ids', async () => {
    const participant = composeCodeCapabilityDemoSeedParticipant(h.db)
    const recording = h.recordStatements()
    try {
      expect(await participant.ensure({ agentId: 'reviewer' })).toEqual(expected)
      expect(await participant.ensure({ agentId: 'different-reviewer' })).toEqual(expected)
    } finally {
      recording.stop()
    }
    const inserts = recording.statements.filter((row) => /^\s*insert\b/i.test(row.sql))
    expect(inserts).toHaveLength(2)
    expect(inserts.every((row) => row.sql.includes('capability_templates'))).toBe(true)
    const { capabilityTemplates } = tablesOf(h.db)
    const [template] = await h.db.select().from(capabilityTemplates)
    expect(template).toMatchObject({
      id: DEMO_TEMPLATE_ID,
      capability: 'mr-review',
      builtin: false,
      visibility: 'public',
      agentBySlotJson: '{"reviewer":"reviewer"}',
    })
    expect(template?.scriptsJson).toContain('collect')
    expect(template?.hooksJson).toContain('extraContext')
    const { codeHistoryArchives, codeHistoryIdIndex } = tablesOf(h.db)
    expect(await h.db.select().from(codeHistoryArchives)).toEqual([])
    expect(await h.db.select().from(codeHistoryIdIndex)).toEqual([])
  })
  test('an occupied template id is preserved, and the offer marker prevents recreation after deletion', async () => {
    const participant = composeCodeCapabilityDemoSeedParticipant(h.db)
    await participant.ensure({ agentId: 'reviewer' })
    const { capabilityTemplates } = tablesOf(h.db)
    await h.db
      .update(capabilityTemplates)
      .set({ description: 'user content' })
      .where(eq(capabilityTemplates.id, DEMO_TEMPLATE_ID))
    expect(await participant.ensure({ agentId: 'replacement' })).toEqual(expected)
    expect((await h.db.select().from(capabilityTemplates))[0]?.description).toBe('user content')
    let completed = false
    let resources = 0
    const catalog = composeDemoResourceCatalogSeedParticipant(h.db)
    const participants = {
      codeCapability: participant,
      resourceCatalog: {
        ...catalog,
        async seed(input: Parameters<typeof catalog.seed>[0]) {
          resources += 1
          return await catalog.seed(input)
        },
      },
      completion: {
        async hasCompleted() {
          return completed
        },
        async recordCompleted() {
          completed = true
        },
      },
    }
    expect(await seedDemoContent(participants)).toEqual({ seeded: true })
    await h.db.delete(capabilityTemplates).where(eq(capabilityTemplates.id, DEMO_TEMPLATE_ID))
    expect(await seedDemoContent(participants)).toEqual({
      seeded: false,
      reason: 'already-offered',
    })
    expect(resources).toBe(1)
    expect(await h.db.select().from(capabilityTemplates)).toEqual([])
  })
  test('stopping the seed never purges already archived demo work', async () => {
    await seedCodeHistoryRows(h.db, 'code_work_items', {
      id: 'aw-demo-work-item',
      codeHostEndpointId: 'aw-demo-endpoint',
      stableProjectId: 'demo/sample-project',
      capability: 'mr-review',
      anchorKind: 'mr',
      anchorId: '42',
      status: 'settled',
      epoch: 1,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    })
    const reader = historyFixtureReader(h.db)
    const before = await reader.find('code_work_items', 'aw-demo-work-item')
    expect(before).not.toBeNull()
    await composeCodeCapabilityDemoSeedParticipant(h.db).ensure({ agentId: 'reviewer' })
    expect(await reader.find('code_work_items', 'aw-demo-work-item')).toEqual(before)
  })
})
test('the seed aggregate contains only the template; no hidden retired write DTO survives', async () => {
  const aggregates: unknown[] = []
  const participant = createCodeCapabilityDemoSeedParticipant({
    async ensure(aggregate) {
      aggregates.push(aggregate)
    },
  })
  expect(await participant.ensure({ agentId: 'reviewer' })).toEqual(expected)
  expect(Object.keys(aggregates[0] as object)).toEqual(['template'])
})
