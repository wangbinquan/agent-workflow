// RFC-304 T31b — readiness that is observed rather than claimed.
//
// `deriveReadiness` shipped with PR-2 as a pure function over facts, and until
// now nothing produced those facts: every caller was a test handing in whatever
// answer it wanted, usually `ready`. So a cell's readiness was an assertion by
// the caller, and a repository could sit at `ready` with no binding, no trigger
// and no agent — precisely the state readiness exists to make visible.
//
// These tests remove one prerequisite at a time and check that the fact
// reporting it flips. The point is not that the boolean is correct in the
// abstract; it is that each fact is established by asking the SAME question the
// round will ask. A check that verifies "a binding is selected" while the round
// resolves "an agent visible to this repository for this slot" reports ready
// and then fails on the MR, in front of the author — which is worse than
// reporting misconfigured, because it wastes somebody's review cycle to say so.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, capabilityTemplates, webhookEndpoints } from '../src/db/schema'
import {
  gatherReadinessFacts as gatherReadinessFactsFromPort,
  type GatherFactsInput,
} from '../src/modules/code-capability/application/readinessFacts'
import { deriveReadiness } from '../src/modules/code-capability/domain/templateLayers'
import { createSqliteReadinessFactsRead } from '../src/modules/code-capability/infrastructure/sqliteReadinessFactsRead'
import { seedCapabilityCell } from './helpers/legacyCapabilitySeed'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const NOW = 1_700_000_000_000
const REPO = 'group/project'
const ENDPOINT = 'ep-1'

type SqliteGatherFactsInput = Omit<GatherFactsInput, 'reader'> & { readonly db: DbClient }

const gatherReadinessFacts = ({ db, ...input }: SqliteGatherFactsInput) =>
  gatherReadinessFactsFromPort({
    ...input,
    reader: createSqliteReadinessFactsRead(db),
  })

describe('RFC-304 — gathering readiness facts from the database', () => {
  let db: DbClient
  let agentId: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    agentId = ulid()
    await db.insert(agents).values({
      id: agentId,
      name: 'reviewer-agent',
      bodyMd: 'You review code.',
      createdAt: NOW,
      updatedAt: NOW,
    })
    await db.insert(webhookEndpoints).values({
      id: ENDPOINT,
      name: 'gl',
      provider: 'gitlab',
      urlToken: 'aw_whk_facts',
      secretEnc: 'sealed',
      enabled: true,
    })
    await db.insert(capabilityTemplates).values({
      id: 'binding-1',
      name: 'team binding',
      agentBySlotJson: JSON.stringify({ reviewer: agentId }),
      createdAt: NOW,
      updatedAt: NOW,
      capability: 'mr-review',
    })
  })
  afterEach(() => db.$client.close())

  const ask = (over: { templateId?: string | null } = {}) =>
    gatherReadinessFacts({
      db,
      repoId: REPO,
      capability: 'mr-review',
      endpointId: ENDPOINT,
      templateId: over.templateId === undefined ? 'binding-1' : over.templateId,
      enabled: true,
    })

  /** The cell must exist for slot resolution to find its binding. */
  const seedCell = async (templateId: string | null = 'binding-1') => {
    await seedCapabilityCell(db, {
      repoId: REPO,
      capability: 'mr-review',
      templateId,
      enabled: true,
      dependencyRevision: 1,
      now: NOW,
    })
  }

  test('a fully configured repository reports every fact satisfied', async () => {
    await seedCell()
    const facts = await ask()
    expect(facts.hasBinding).toBe(true)
    expect(facts.frameworkExists).toBe(true)
    expect(facts.codeHostConfigured).toBe(true)
    expect(facts.invisibleAgentSlots).toEqual([])
  })

  test('no binding is reported, not assumed', async () => {
    await seedCell(null)
    const facts = await ask({ templateId: null })
    expect(facts.hasBinding).toBe(false)
  })

  test('a binding whose framework was deleted reports the FRAMEWORK missing', async () => {
    // Distinct from "no binding": the team selected one, and the thing it was
    // built on is gone. Sending them to pick a binding again would be the wrong
    // instruction — the binding is fine.
    await seedCell()
    await db.delete(capabilityTemplates)
    const facts = await ask()
    expect(facts.hasBinding).toBe(true)
    expect(facts.frameworkExists).toBe(false)
  })

  test('a deleted agent makes its SLOT invisible, by name', async () => {
    // The round resolves a slot to an agent. Checking only that a binding
    // exists would report ready and then fail at the review stage — after the
    // worktree, the diff and possibly a model call have been paid for.
    await seedCell()
    await db.delete(agents)
    const facts = await ask()
    expect(facts.invisibleAgentSlots).toEqual(['reviewer'])
  })

  test('an unmapped slot is invisible too', async () => {
    await db
      .update(capabilityTemplates)
      .set({ agentBySlotJson: '{}' })
      .where(eq(capabilityTemplates.id, 'binding-1'))
    await seedCell()
    const facts = await ask()
    expect(facts.invisibleAgentSlots).toEqual(['reviewer'])
  })

  test('no enabled endpoint reports the code host unconfigured', async () => {
    await seedCell()
    await db.delete(webhookEndpoints)
    const facts = await ask()
    expect(facts.codeHostConfigured).toBe(false)
  })

  test('mr-review does not require a wake source; MR events are one', async () => {
    await seedCell()
    expect((await ask()).requiresWakeSource).toBe(false)
  })

  test('a capability with nothing to start it DOES require one', async () => {
    // AC-14d. Without this, `ci-fix` would show ready while nothing could ever
    // start it — the worst readiness answer, because it is confidently wrong.
    const facts = await gatherReadinessFacts({
      db,
      repoId: REPO,
      capability: 'ci-fix',
      endpointId: ENDPOINT,
      templateId: 'binding-1',
      enabled: true,
    })
    expect(facts.requiresWakeSource).toBe(true)
    expect(facts.hasWakeSource).toBe(false)
  })
})

describe('RFC-304 — facts feed the verdict', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => db.$client.close())

  test('an unconfigured repository derives MISCONFIGURED, naming what is missing', async () => {
    // The end-to-end of this task: nothing seeded, so the facts are all false,
    // and the verdict says so with specifics rather than a bare red state.
    const facts = await gatherReadinessFacts({
      db,
      repoId: 'never-configured',
      capability: 'mr-review',
      endpointId: 'ep-none',
      templateId: null,
      enabled: true,
    })
    const { state, issues } = deriveReadiness(facts)

    expect(state).toBe('misconfigured')
    const codes = issues.map((i) => i.code)
    expect(codes).toContain('no-binding')
    expect(codes).toContain('code-host-unconfigured')
  })

  test('a disabled cell is DISABLED, not misconfigured', async () => {
    // Off is a choice; misconfigured is a fault. Showing a switched-off
    // capability in red would train people to ignore red.
    const facts = await gatherReadinessFacts({
      db,
      repoId: 'never-configured',
      capability: 'mr-review',
      endpointId: 'ep-none',
      templateId: null,
      enabled: false,
    })
    expect(deriveReadiness(facts).state).toBe('disabled')
  })
})
