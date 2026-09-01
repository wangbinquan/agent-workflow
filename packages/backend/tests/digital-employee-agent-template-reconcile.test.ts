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
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'

import { createInMemoryDb } from '@/db/client'
import { agents as agentRows } from '@/db/schema'
import { composeDigitalEmployeeAgentTemplateCatalogParticipant } from '@/modules/digital-employee/composition/agentTemplateCatalog'
import { composeSqliteDigitalEmployeeAgentTemplateCatalogParticipant } from '@/modules/resource-catalog/composition/digitalEmployeeAgentTemplateCatalog'
import { getAgentById, listAgents } from '@/services/agent'
import {
  DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS,
  ensureDigitalEmployeeAgentTemplates,
  listDigitalEmployeeAgentTemplates,
} from '@/services/digitalEmployeeAgentTemplates'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function templateCatalog(db: ReturnType<typeof createInMemoryDb>) {
  return composeSqliteDigitalEmployeeAgentTemplateCatalogParticipant(
    db,
    composeDigitalEmployeeAgentTemplateCatalogParticipant,
  )
}

/** Everything the template owns; timestamps move on every repair by design. */
async function definitionOf(db: ReturnType<typeof createInMemoryDb>, id: string) {
  const agent = await getAgentById(db, id)
  expect(agent).not.toBeNull()
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...definition } = agent!
  return definition
}

describe('digital employee Agent template reconciliation', () => {
  test('every seeded built-in converges after its stored definition drifts', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const catalog = templateCatalog(db)
    await ensureDigitalEmployeeAgentTemplates(catalog)
    const seeded = await Promise.all(
      DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS.map((id) => definitionOf(db, id)),
    )

    for (const id of DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS) {
      db.update(agentRows)
        .set({
          description: 'drifted description',
          bodyMd: 'drifted body',
          frontmatterExtra: '{}',
        })
        .where(eq(agentRows.id, id))
        .run()
    }

    await ensureDigitalEmployeeAgentTemplates(catalog)

    const repaired = await Promise.all(
      DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS.map((id) => definitionOf(db, id)),
    )
    expect(repaired).toEqual(seeded)
    expect(await listDigitalEmployeeAgentTemplates(catalog)).toHaveLength(8)
  })

  test('a drifted name is repaired in place, never as a second Agent', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const catalog = templateCatalog(db)
    await ensureDigitalEmployeeAgentTemplates(catalog)
    const [id] = DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS
    const seeded = await definitionOf(db, id)
    const seededCount = (await listAgents(db)).length

    db.update(agentRows).set({ name: 'drifted-name' }).where(eq(agentRows.id, id)).run()
    await ensureDigitalEmployeeAgentTemplates(catalog)

    expect(await definitionOf(db, id)).toEqual(seeded)
    expect(await listAgents(db)).toHaveLength(seededCount)
  })

  test('repeated seeding after a repair stays idempotent', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const catalog = templateCatalog(db)
    await ensureDigitalEmployeeAgentTemplates(catalog)
    const [id] = DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS

    db.update(agentRows).set({ description: 'drifted' }).where(eq(agentRows.id, id)).run()
    await ensureDigitalEmployeeAgentTemplates(catalog)
    const repaired = await getAgentById(db, id)

    await ensureDigitalEmployeeAgentTemplates(catalog)
    expect(await getAgentById(db, id)).toEqual(repaired)
  })

  test('a built-in an administrator made private does not cost the daemon its boot', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const catalog = templateCatalog(db)
    await ensureDigitalEmployeeAgentTemplates(catalog)
    const privatedId = DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS[8]

    db.update(agentRows).set({ visibility: 'private' }).where(eq(agentRows.id, privatedId)).run()

    await ensureDigitalEmployeeAgentTemplates(catalog)

    // Visibility is an ACL decision with its own endpoint: seeding leaves it
    // alone and the row simply drops out of the public template catalog.
    expect((await getAgentById(db, privatedId))?.visibility).toBe('private')
    expect(await listDigitalEmployeeAgentTemplates(catalog)).toHaveLength(7)
  })

  test('a stable id squatted by a row that is not the platform is still refused', async () => {
    for (const squat of [{ builtin: false }, { ownerUserId: '01JUSERUSERUSERUSERUSERUS' }]) {
      const db = createInMemoryDb(MIGRATIONS)
      const catalog = templateCatalog(db)
      await ensureDigitalEmployeeAgentTemplates(catalog)
      const [id] = DIGITAL_EMPLOYEE_AGENT_TEMPLATE_IDS

      db.update(agentRows).set(squat).where(eq(agentRows.id, id)).run()

      await expect(ensureDigitalEmployeeAgentTemplates(catalog)).rejects.toMatchObject({
        code: 'builtin-agent-id-collision',
      })
    }
  })
})
