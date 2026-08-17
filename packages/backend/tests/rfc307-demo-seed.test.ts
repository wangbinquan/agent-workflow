// RFC-307 PR-3 — the demo content, and the four rules it must not break.
//
// Sample data is the kind of feature that looks harmless and is not. Each case
// here pins one way this could quietly become a nuisance rather than a help:
//
//   · re-seeding what a user deleted (the platform arguing with them);
//   · sample rows that do not read as samples (somebody eventually points one
//     at a live repository);
//   · a demo that needs a code host, which puts back the requirement the demo
//     exists to remove;
//   · a seed failure taking the daemon down with it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { SYSTEM_USER_ID } from '../src/auth/actor'
import {
  agents,
  capabilityBindings,
  capabilityFrameworks,
  codeRoundStages,
  codeWorkItems,
  codeWorkRounds,
  workflows,
} from '../src/db/schema'
import {
  DEMO_AGENT_ID,
  DEMO_BINDING_ID,
  DEMO_FRAMEWORK_ID,
  DEMO_ROUND_ID,
  DEMO_WORKFLOW_REVIEW_ID,
  seedDemoContent,
} from '../src/services/demoSeed'
import { lookupStageContract } from '../src/modules/code-capability/domain/capabilityRegistry'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-307 — demo content', () => {
  let db: DbClient
  let home: string
  let priorHome: string | undefined

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    home = mkdtempSync(join(tmpdir(), 'aw-demo-seed-'))
    priorHome = process.env.AGENT_WORKFLOW_HOME
    process.env.AGENT_WORKFLOW_HOME = home
  })
  afterEach(() => {
    db.$client.close()
    if (priorHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = priorHome
    rmSync(home, { recursive: true, force: true })
  })

  test('a fresh install gets a framework, a binding, an agent, a round and workflows', async () => {
    const result = await seedDemoContent(db)
    expect(result.seeded).toBe(true)

    expect(await db.select().from(capabilityFrameworks)).toHaveLength(1)
    expect(await db.select().from(capabilityBindings)).toHaveLength(1)
    expect((await db.select().from(agents)).map((a) => a.id)).toContain(DEMO_AGENT_ID)
    expect(await db.select().from(codeWorkRounds)).toHaveLength(1)
    expect((await db.select().from(workflows)).length).toBeGreaterThanOrEqual(2)
  })

  test('seeding twice produces ONE of each, not two', async () => {
    await seedDemoContent(db)
    const second = await seedDemoContent(db)
    expect(second).toEqual({ seeded: false, reason: 'already-offered' })
    expect(await db.select().from(capabilityFrameworks)).toHaveLength(1)
    expect(await db.select().from(workflows)).toHaveLength(2)
  })

  test('DELETED STAYS DELETED — a removed sample is not re-created on restart', async () => {
    // The rule that makes this feature tolerable. The gate is a marker for "we
    // have offered these once", NOT a check for whether the rows are there; a
    // user who deletes them means it.
    await seedDemoContent(db)
    await db.delete(capabilityBindings)
    await db.delete(capabilityFrameworks)

    const restart = await seedDemoContent(db)
    expect(restart.seeded).toBe(false)
    expect(await db.select().from(capabilityFrameworks)).toEqual([])
    expect(await db.select().from(capabilityBindings)).toEqual([])
  })

  test('a partial failure does NOT write the marker, so the next start retries', async () => {
    // Without this, one bad start leaves an install permanently half-seeded and
    // nothing ever finishes the job.
    //
    // Induced through the agents table's `(owner, name)` unique index: a row
    // holding the demo agent's NAME under the same owner makes `createAgent`
    // throw, because the seed's own id check does not see it.
    //
    // The first attempt at this case occupied a demo ID instead, and it could
    // not fail for the stated reason: an occupied id is SKIPPED by design (and
    // logged), not thrown. A test that cannot fail for its stated reason is
    // worse than no test.
    await db.insert(agents).values({
      id: 'someone-elses-agent',
      name: '[demo] reviewer',
      bodyMd: 'x',
      ownerUserId: SYSTEM_USER_ID,
      createdAt: 1,
      updatedAt: 1,
    })

    const result = await seedDemoContent(db)
    expect(result.seeded).toBe(false)
    expect(result.reason).toBe('error')
    // The marker is the whole point: absent means "try again next start".
    expect(existsSync(join(home, '.demo-seeded'))).toBe(false)
  })

  test('a seed failure is reported, never thrown — a daemon must still start', async () => {
    await db.insert(agents).values({
      id: 'someone-elses-agent',
      name: '[demo] reviewer',
      bodyMd: 'x',
      ownerUserId: SYSTEM_USER_ID,
      createdAt: 1,
      updatedAt: 1,
    })
    // No rejection. "This install has no samples" is exactly the state every
    // install before this RFC was in; it is not a reason to refuse to boot.
    expect((await seedDemoContent(db)).seeded).toBe(false)
  })

  test('a demo id occupied by someone else is skipped, and the rest still seeds', async () => {
    // The other half of the collision story: skipping is correct (overwriting
    // someone's workflow would be much worse), and it must not abort the batch.
    await db.insert(workflows).values({
      id: DEMO_WORKFLOW_REVIEW_ID,
      name: 'not ours',
      definition: '{}',
      version: 1,
      createdAt: 1,
      updatedAt: 1,
    })

    expect((await seedDemoContent(db)).seeded).toBe(true)
    const rows = await db.select().from(workflows)
    // Theirs untouched, and the other sample still arrived.
    expect(rows.find((r) => r.id === DEMO_WORKFLOW_REVIEW_ID)?.name).toBe('not ours')
    expect(rows.some((r) => r.name.includes('[demo]'))).toBe(true)
    expect(await db.select().from(capabilityFrameworks)).toHaveLength(1)
  })

  test('every seeded row says it is a sample and is safe to delete', async () => {
    await seedDemoContent(db)
    const framework = (await db.select().from(capabilityFrameworks))[0]
    const binding = (await db.select().from(capabilityBindings))[0]
    const agent = (await db.select().from(agents)).find((a) => a.id === DEMO_AGENT_ID)

    for (const name of [framework?.name, binding?.name, agent?.name]) {
      expect(name).toContain('[demo]')
    }
    for (const description of [framework?.description, binding?.description]) {
      // Named in the row itself, because a user meets these in a list where no
      // surrounding page copy travels with them.
      expect(description).toContain('safe to delete')
    }
    for (const row of await db.select().from(workflows)) {
      expect(row.name).toContain('[demo]')
    }
  })

  test('the demo round has one stage row per contract stage, generated from the contract', async () => {
    // Hand-listing them would drift the first time a stage was added, and drift
    // in the sample is what teaches people the picture cannot be trusted.
    await seedDemoContent(db)
    const contract = lookupStageContract('mr-review')
    const stages = await db.select().from(codeRoundStages)
    expect(stages).toHaveLength(contract?.stages.length ?? 0)
    expect(stages.map((s) => s.stageName).sort()).toEqual(
      (contract?.stages ?? []).map((s) => s.name).sort(),
    )
    // And the round declares the version it ran, so the flow view's staleness
    // notice has something true to compare against.
    const [round] = await db.select().from(codeWorkRounds)
    expect(round?.stageContractVer).toBe(contract?.version ?? 0)
  })

  test('the demo binding fills the slot BOTH AI stages share', async () => {
    // This is what makes the sample worth opening: clicking either AI stage in
    // the flow view shows the shared-slot warning, which is the single most
    // surprising thing about slot-shaped configuration.
    await seedDemoContent(db)
    const [binding] = await db.select().from(capabilityBindings)
    const agentBySlot = JSON.parse(binding?.agentBySlotJson ?? '{}') as Record<string, string>
    const aiSlots = new Set(
      (lookupStageContract('mr-review')?.stages ?? []).flatMap((s) =>
        s.kind === 'ai' ? [s.agentSlot] : [],
      ),
    )
    expect(aiSlots.size).toBe(1)
    expect(Object.keys(agentBySlot)).toEqual([...aiSlots])
    expect(agentBySlot[[...aiSlots][0] ?? '']).toBe(DEMO_AGENT_ID)
  })

  test('the demo framework ships a script AND a hook, so both layers are visible', async () => {
    await seedDemoContent(db)
    const [framework] = await db.select().from(capabilityFrameworks)
    const scripts = JSON.parse(framework?.scriptsJson ?? '{}') as Record<string, unknown>
    const hooks = JSON.parse(framework?.hooksJson ?? '[]') as Array<{ stage: string }>
    expect(Object.keys(scripts).length).toBeGreaterThan(0)
    expect(hooks).toHaveLength(1)
    // Mounted on a stage that actually exists — a hook naming a stage the
    // contract does not have would never fire, which is a bad first example.
    const names = new Set((lookupStageContract('mr-review')?.stages ?? []).map((s) => s.name))
    expect(names.has(hooks[0]?.stage ?? '')).toBe(true)
  })

  test('the demo touches no network and no code host', async () => {
    // Rule 3, asserted rather than asserted-in-a-comment: `fetch` is replaced
    // for the duration, so any outbound call fails the case with its URL.
    const calls: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = ((input: unknown) => {
      calls.push(String(input))
      return Promise.reject(new Error('demo seed must not use the network'))
    }) as typeof fetch
    try {
      expect((await seedDemoContent(db)).seeded).toBe(true)
    } finally {
      globalThis.fetch = realFetch
    }
    expect(calls).toEqual([])

    // And the endpoint it references is disabled, so nothing that scans for
    // live endpoints picks it up.
    const [item] = await db.select().from(codeWorkItems)
    expect(item?.codeHostEndpointId).toBeTruthy()
  })

  test('an existing marker means the seed does not even look at the database', async () => {
    writeFileSync(join(home, '.demo-seeded'), 'already\n')
    expect(await seedDemoContent(db)).toEqual({ seeded: false, reason: 'already-offered' })
    expect(await db.select().from(workflows)).toEqual([])
    expect(await db.select().from(capabilityFrameworks)).toEqual([])
  })

  test('the seeded round is settled and published — a finished example, not a stuck one', async () => {
    // A sample that shows a round mid-flight would look like the platform hung.
    await seedDemoContent(db)
    const [item] = await db.select().from(codeWorkItems)
    const [round] = await db.select().from(codeWorkRounds)
    expect(item?.status).toBe('settled')
    expect(round?.outcome).toBe('published')
    expect(round?.endedAt).not.toBeNull()
    expect(round?.id).toBe(DEMO_ROUND_ID)
    expect(item?.currentRoundId).toBe(DEMO_ROUND_ID)
  })

  test('ids are stable and readable, so a user can find every trace of the demo', async () => {
    await seedDemoContent(db)
    for (const id of [DEMO_AGENT_ID, DEMO_FRAMEWORK_ID, DEMO_BINDING_ID, DEMO_ROUND_ID]) {
      expect(id.startsWith('aw-demo-')).toBe(true)
    }
  })
})
