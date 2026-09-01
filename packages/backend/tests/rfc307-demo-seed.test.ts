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
  capabilityTemplates,
  codeRoundStages,
  codeWorkItems,
  codeWorkRounds,
  webhookEndpoints,
  workflows,
} from '../src/db/schema'
import {
  DEMO_AGENT_ID,
  DEMO_ENDPOINT_ID,
  DEMO_TEMPLATE_ID,
  DEMO_ROUND_ID,
  DEMO_WORKFLOW_REVIEW_ID,
  seedDemoContent,
} from '../src/services/demoSeed'
import { lookupStageContract } from '../src/modules/code-capability/domain/capabilityRegistry'
import { composeSqliteCodeCapabilityDemoSeedParticipant } from '../src/modules/code-capability/composition/demoSeed'
import { composeSqliteDemoResourceCatalogSeedParticipant } from '../src/modules/resource-catalog/composition/demoResourceCatalogSeed'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-307 — demo content', () => {
  let db: DbClient
  let home: string
  let priorHome: string | undefined

  const seed = () =>
    seedDemoContent({
      resourceCatalog: composeSqliteDemoResourceCatalogSeedParticipant(db),
      codeCapability: composeSqliteCodeCapabilityDemoSeedParticipant(db),
    })

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
    const result = await seed()
    expect(result.seeded).toBe(true)

    expect(await db.select().from(capabilityTemplates)).toHaveLength(1)
    expect(await db.select().from(capabilityTemplates)).toHaveLength(1)
    expect((await db.select().from(agents)).map((a) => a.id)).toContain(DEMO_AGENT_ID)
    expect(await db.select().from(codeWorkRounds)).toHaveLength(1)
    expect((await db.select().from(workflows)).length).toBeGreaterThanOrEqual(2)
  })

  test('seeding twice produces ONE of each, not two', async () => {
    await seed()
    const second = await seed()
    expect(second).toEqual({ seeded: false, reason: 'already-offered' })
    expect(await db.select().from(capabilityTemplates)).toHaveLength(1)
    expect(await db.select().from(workflows)).toHaveLength(2)
  })

  test('DELETED STAYS DELETED — a removed sample is not re-created on restart', async () => {
    // The rule that makes this feature tolerable. The gate is a marker for "we
    // have offered these once", NOT a check for whether the rows are there; a
    // user who deletes them means it.
    await seed()
    await db.delete(capabilityTemplates)
    await db.delete(capabilityTemplates)

    const restart = await seed()
    expect(restart.seeded).toBe(false)
    expect(await db.select().from(capabilityTemplates)).toEqual([])
    expect(await db.select().from(capabilityTemplates)).toEqual([])
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

    const result = await seed()
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
    expect((await seed()).seeded).toBe(false)
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

    expect((await seed()).seeded).toBe(true)
    const rows = await db.select().from(workflows)
    // Theirs untouched, and the other sample still arrived.
    expect(rows.find((r) => r.id === DEMO_WORKFLOW_REVIEW_ID)?.name).toBe('not ours')
    expect(rows.some((r) => r.name.includes('[demo]'))).toBe(true)
    expect(await db.select().from(capabilityTemplates)).toHaveLength(1)
  })

  test('every seeded row says it is a sample and is safe to delete', async () => {
    await seed()
    const framework = (await db.select().from(capabilityTemplates))[0]
    const binding = (await db.select().from(capabilityTemplates))[0]
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
    await seed()
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
    await seed()
    const [binding] = await db.select().from(capabilityTemplates)
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
    await seed()
    const [framework] = await db.select().from(capabilityTemplates)
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
      expect((await seed()).seeded).toBe(true)
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
    expect(await seed()).toEqual({ seeded: false, reason: 'already-offered' })
    expect(await db.select().from(workflows)).toEqual([])
    expect(await db.select().from(capabilityTemplates)).toEqual([])
  })

  test('the seeded round is settled and published — a finished example, not a stuck one', async () => {
    // A sample that shows a round mid-flight would look like the platform hung.
    await seed()
    const [item] = await db.select().from(codeWorkItems)
    const [round] = await db.select().from(codeWorkRounds)
    expect(item?.status).toBe('settled')
    expect(round?.outcome).toBe('published')
    expect(round?.endedAt).not.toBeNull()
    expect(round?.id).toBe(DEMO_ROUND_ID)
    expect(item?.currentRoundId).toBe(DEMO_ROUND_ID)
  })

  test('NOTHING seeded is marked builtin — the samples must be editable and deletable', async () => {
    // The bug this locks, found by running the daemon rather than by reading
    // the code. The first version copied `builtin: true` from the fusion
    // seeder, and in this repo that flag means "platform infrastructure":
    // `excludeBuiltinWorkflows` hides the row from every list, and
    // `assertNotBuiltin` refuses every edit and delete. All three promises
    // broke at once — the demo agent never reached the agent picker, the demo
    // binding answered `capability-template-builtin` to the exact prompt edit
    // this RFC exists to enable, and "safe to delete" was simply false.
    await seed()
    for (const row of await db.select().from(workflows)) expect(row.builtin).toBe(false)
    for (const row of await db.select().from(capabilityTemplates)) expect(row.builtin).toBe(false)
    for (const row of await db.select().from(capabilityTemplates)) expect(row.builtin).toBe(false)
    const agent = (await db.select().from(agents)).find((a) => a.id === DEMO_AGENT_ID)
    expect(agent?.builtin).toBe(false)
  })

  test('the samples are public, so they are visible without being infrastructure', async () => {
    // The other half of the same decision: not builtin, but not private either
    // — a sample nobody can see is not a sample.
    await seed()
    for (const row of await db.select().from(capabilityTemplates)) {
      expect(row.visibility).toBe('public')
    }
    for (const row of await db.select().from(capabilityTemplates)) {
      expect(row.visibility).toBe('public')
    }
    expect((await db.select().from(agents)).find((a) => a.id === DEMO_AGENT_ID)?.visibility).toBe(
      'public',
    )
    // Workflows too: `createWorkflow` also defaults to `private` (RFC-099), so
    // the sample needs the same follow-up. Caught by this case going red.
    for (const row of await db.select().from(workflows)) expect(row.visibility).toBe('public')
  })

  test('every demo hook returns ONLY keys its stage declares injectable', async () => {
    // Also found by running it: the sample hook returned `promptSuffix` while
    // `review-shard` declares `extraContext`, so the runner would have refused
    // it. A first example that does not work teaches the wrong thing twice —
    // once about hooks, once about whether the samples can be trusted.
    await seed()
    const [framework] = await db.select().from(capabilityTemplates)
    const hooks = JSON.parse(framework?.hooksJson ?? '[]') as Array<{
      stage: string
      script: string
    }>
    const stages = new Map(
      (lookupStageContract('mr-review')?.stages ?? []).map((s) => [s.name, s.injectable ?? []]),
    )
    for (const hook of hooks) {
      const allowed = stages.get(hook.stage) ?? []
      // Read the keys the sample script actually emits out of its own body.
      const emitted = [...hook.script.matchAll(/"([A-Za-z][A-Za-z0-9]*)":/g)].flatMap((m) =>
        m[1] === undefined ? [] : [m[1]],
      )
      expect(emitted.length).toBeGreaterThan(0)
      for (const key of emitted) expect(allowed).toContain(key)
    }
  })

  test('NO webhook endpoint is created — a fake one would be pre-selected on real forms', async () => {
    // Found by CI, not by reading the code. The first version seeded a
    // `webhook_endpoints` row so the demo work item had something to point at.
    // Every endpoint picker in the product then listed `[demo] sample code
    // host`, and pickers default to their first option — so it became the
    // DEFAULT selection on the trigger form, which is where somebody wires up a
    // real code host. Three e2e shards caught it as
    // `expected "rfc295-picker-endpoint", received "[demo] sample code host"`.
    //
    // It is also unnecessary: the column carries no foreign key and no read
    // path joins the endpoint table, because the id is opaque there.
    await seed()
    expect(await db.select().from(webhookEndpoints)).toEqual([])
    // The work item still names its (opaque) host identity, so the row is not
    // half-populated.
    const [item] = await db.select().from(codeWorkItems)
    expect(item?.codeHostEndpointId).toBe(DEMO_ENDPOINT_ID)
  })

  test('ids are stable and readable, so a user can find every trace of the demo', async () => {
    await seed()
    for (const id of [DEMO_AGENT_ID, DEMO_TEMPLATE_ID, DEMO_TEMPLATE_ID, DEMO_ROUND_ID]) {
      expect(id.startsWith('aw-demo-')).toBe(true)
    }
  })
})
