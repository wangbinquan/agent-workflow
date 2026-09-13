/**
 * Locks the create-or-CONVERGE contract of `ensureDigitalEmployeeAgentTemplates`.
 *
 * Why this file exists: boot seeding used to REFUSE any drift between a
 * platform-owned Agent row and its template ("stable digital employee Agent id
 * '…' is occupied or changed"). One reworded `description` in this repository
 * therefore killed the daemon on every machine that had already seeded the
 * previous text — `bun dev` exited before listening, and an upgraded install
 * would have failed identically, for an edit that cannot break anything.
 * Built-in definitions are code-owned, so boot REPAIRS them; the only refusal
 * left is a row that is not the platform's squatting a stable id, because
 * converging that would overwrite somebody's own Agent.
 *
 * A drifted row is compared against the snapshot taken right after the first
 * seed, so these cases stay honest without restating the template text.
 */
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { agents as agentRows } from '@/db/schema'
import { composeDigitalEmployeeAgentTemplateCatalogParticipant } from '@/modules/digital-employee/composition/agentTemplateCatalog'
import { composeDigitalEmployeeAgentTemplateCatalogFor } from '@/modules/resource-catalog/composition/digitalEmployeeAgentTemplateCatalog'
import { getAgentById, listAgents } from '@/services/agent'
import {
  DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS,
  ensureDigitalEmployeeAgentTemplates,
  listDigitalEmployeeAgentTemplates,
} from '@/services/digitalEmployeeAgentTemplates'
import { describeEachProvider } from './helpers/eachProvider'

function templateCatalog(db: ProviderNeutralDatabase) {
  return composeDigitalEmployeeAgentTemplateCatalogFor(
    db,
    composeDigitalEmployeeAgentTemplateCatalogParticipant,
  )
}

/** Everything the template owns; timestamps move on every repair by design. */
async function definitionOf(db: ProviderNeutralDatabase, id: string) {
  const agent = await getAgentById(db, id)
  expect(agent).not.toBeNull()
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...definition } = agent!
  return definition
}

describeEachProvider('digital employee Agent template reconciliation', (harness) => {
  test('every seeded built-in converges after its stored definition drifts', async () => {
    const db = harness.db
    const catalog = templateCatalog(db)
    await ensureDigitalEmployeeAgentTemplates(catalog)
    const seeded = await Promise.all(
      DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS.map((id) => definitionOf(db, id)),
    )

    for (const id of DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS) {
      await db
        .update(agentRows)
        .set({
          description: 'drifted description',
          bodyMd: 'drifted body',
          frontmatterExtra: '{}',
        })
        .where(eq(agentRows.id, id))
    }

    await ensureDigitalEmployeeAgentTemplates(catalog)

    const repaired = await Promise.all(
      DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS.map((id) => definitionOf(db, id)),
    )
    expect(repaired).toEqual(seeded)
    expect(await listDigitalEmployeeAgentTemplates(catalog)).toHaveLength(8)
  })

  test('a drifted name is repaired in place, never as a second Agent', async () => {
    const db = harness.db
    const catalog = templateCatalog(db)
    await ensureDigitalEmployeeAgentTemplates(catalog)
    const [id] = DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS
    const seeded = await definitionOf(db, id)
    const seededCount = (await listAgents(db)).length

    await db.update(agentRows).set({ name: 'drifted-name' }).where(eq(agentRows.id, id))
    await ensureDigitalEmployeeAgentTemplates(catalog)

    expect(await definitionOf(db, id)).toEqual(seeded)
    expect(await listAgents(db)).toHaveLength(seededCount)
  })

  test('repeated seeding after a repair stays idempotent', async () => {
    const db = harness.db
    const catalog = templateCatalog(db)
    await ensureDigitalEmployeeAgentTemplates(catalog)
    const [id] = DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS

    await db.update(agentRows).set({ description: 'drifted' }).where(eq(agentRows.id, id))
    await ensureDigitalEmployeeAgentTemplates(catalog)
    const repaired = await getAgentById(db, id)

    await ensureDigitalEmployeeAgentTemplates(catalog)
    expect(await getAgentById(db, id)).toEqual(repaired)
  })
})

describeEachProvider('digital employee Agent template reconciliation', (harness) => {
  test('a built-in an administrator made private does not cost the daemon its boot', async () => {
    const db = harness.db
    const catalog = templateCatalog(db)
    await ensureDigitalEmployeeAgentTemplates(catalog)
    const privatedId = DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS[8]

    await db.update(agentRows).set({ visibility: 'private' }).where(eq(agentRows.id, privatedId))

    await ensureDigitalEmployeeAgentTemplates(catalog)

    // Visibility is an ACL decision with its own endpoint: seeding leaves it
    // alone and the row simply drops out of the public template catalog.
    expect((await getAgentById(db, privatedId))?.visibility).toBe('private')
    expect(await listDigitalEmployeeAgentTemplates(catalog)).toHaveLength(7)
  })

  // RFC-359 AC-6：原来这条用 for 循环跑两种占位，每轮**各自新建一个库**。双引擎 harness 是
  // 「每个 test 一个干净库」，循环里共用同一个库会让第一轮的占位活到第二轮——第二轮的
  // `ensureDigitalEmployeeAgentTemplates` 在**建立前提**那一步就先抛了，判据变成空洞。
  // 所以拆成两条 test，一条一种占位，各自拿自己的干净库。
  for (const [label, squat] of [
    ['not builtin', { builtin: false }],
    ['owned by a user', { ownerUserId: '01JUSERUSERUSERUSERUSERUS' }],
  ] as const) {
    test(`a stable id squatted by a row that is not the platform is still refused (${label})`, async () => {
      const db = harness.db
      const catalog = templateCatalog(db)
      await ensureDigitalEmployeeAgentTemplates(catalog)
      const [id] = DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS

      await db.update(agentRows).set(squat).where(eq(agentRows.id, id))

      await expect(ensureDigitalEmployeeAgentTemplates(catalog)).rejects.toMatchObject({
        code: 'builtin-agent-id-collision',
      })
    })
  }
})
