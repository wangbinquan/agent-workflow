// RFC-370 H6: classic catalogs must use the selected immutable-version facts
// and content adapters. The real workflow loader must not probe another root.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CreateAgentSchema, CreateWorkflowSchema, type Skill } from '@agent-workflow/shared'
import { skills, users } from '@/db/schema'
import { createIdentityAccessRuntime } from '@/modules/identity-access/composition'
import type { SkillVersionPresenceQueries } from '@/modules/resource-catalog/application/skills/contentAvailability'
import { composeClassicCatalogs } from '@/modules/resource-catalog/composition/classicCatalogs'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { composeSkillContentAvailability } from '@/modules/resource-catalog/composition/workflowOperations'
import {
  activateBootReverifyForTest,
  markSkillBootVerified,
  resetSkillBootVerifyForTest,
  unmarkSkillBootVerified,
} from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import { createFileSkillContentReader } from '@/modules/resource-catalog/infrastructure/local/fileSkillContentReader'
import { createFileSkillCreationContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillCreationContentStore'
import { createFileSkillDeletionContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillDeletionContentStore'
import { createFileSkillLifecycleContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillLifecycleContentStore'
import { createFileSkillVersionContentReader } from '@/modules/resource-catalog/infrastructure/local/fileSkillVersionContentReader'
import { createFileSkillVersionContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillVersionContentStore'
import { createFileSkillVersionPresenceQueries } from '@/modules/resource-catalog/infrastructure/local/fileSkillVersionPresenceQueries'
import type { SkillOperationContext } from '@/modules/resource-catalog/public/participants'
import { describeEachProvider } from './helpers/eachProvider'
import { admitTestDirectAuthority } from './helpers/identityAccessAuthority'

function barrier() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  return { pending, release }
}

async function reached(gate: ReturnType<typeof barrier>, pending: Promise<unknown>) {
  await Promise.race([
    gate.pending,
    pending.then(() => {
      throw new Error('operation completed before the selected storage query')
    }),
  ])
}

afterEach(resetSkillBootVerifyForTest)

describeEachProvider('RFC-370 classic selected skill content', (harness) => {
  let directory: string
  let selectedHome: string
  let fallbackHome: string
  let authority: SkillOperationContext

  beforeEach(async () => {
    resetSkillBootVerifyForTest()
    directory = mkdtempSync(join(tmpdir(), 'aw-classic-content-'))
    selectedHome = join(directory, 'selected')
    fallbackHome = join(directory, 'unused-fallback')
    await harness.db.insert(users).values({
      id: 'classic-content-admin',
      username: 'classic-content-admin',
      displayName: 'Classic content admin',
      role: 'admin',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    })
    const identity = await admitTestDirectAuthority(
      createIdentityAccessRuntime({ db: harness.db }).directAuthority,
      { source: 'session', userId: 'classic-content-admin' },
    )
    if (identity === null) throw new Error('classic content fixture authority unavailable')
    authority = identity.actor
  })

  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  function compose(versionPresence?: SkillVersionPresenceQueries) {
    return composeClassicCatalogs({
      db: harness.db,
      appHome: fallbackHome,
      resourceCatalog: composeResourceCatalogFor({ db: harness.db }),
      runtimeProfiles: { get: async () => ({ enabled: true }) },
      restoreMembership: { unfuseForRestore: async () => [] },
      content: createFileSkillContentReader(selectedHome),
      versionReader: createFileSkillVersionContentReader(selectedHome),
      lifecycleContent: createFileSkillLifecycleContentStore(selectedHome),
      deletionContent: createFileSkillDeletionContentStore(selectedHome),
      versionContent: createFileSkillVersionContentStore(selectedHome),
      creationContent: createFileSkillCreationContentStore(selectedHome),
      versionPresence: versionPresence ?? createFileSkillVersionPresenceQueries(selectedHome),
    })
  }

  async function fixture() {
    const catalog = compose()
    const skill = await catalog.skill.operations.create.invoke(authority, {
      submission: {
        kind: 'json-body',
        body: JSON.stringify({ name: 'selected-skill', bodyMd: 'selected body' }),
      },
    })
    const agent = await catalog.agent.operations.create.invoke(
      authority,
      CreateAgentSchema.parse({
        name: 'selected-agent',
        skills: [{ kind: 'managed', skillId: skill.id }],
      }),
    )
    const definition = CreateWorkflowSchema.parse({
      name: 'selected-workflow',
      definition: {
        $schema_version: 6,
        inputs: [],
        nodes: [{ id: 'run', kind: 'agent-single', agentId: agent.id, position: { x: 0, y: 0 } }],
        edges: [],
      },
    }).definition
    return { catalog, skill, definition }
  }

  test('creates, reads and recomposes using the selected storage root', async () => {
    const { catalog, skill } = await fixture()
    expect(existsSync(fallbackHome)).toBe(false)
    expect(existsSync(selectedHome)).toBe(true)
    expect(await catalog.skillContent.isAvailable(skill)).toBe(true)
    expect(await catalog.skill.queries.content(authority, { id: skill.id })).toMatchObject({
      bodyMd: 'selected body',
    })
    const recomposed = compose()
    expect(
      await recomposed.skill.versionQueries.content(authority, { id: skill.id, version: '1' }),
    ).toMatchObject({ versionIndex: 1, content: { bodyMd: 'selected body' } })
    expect(await recomposed.skillContent.isAvailable(skill)).toBe(true)
    expect(existsSync(fallbackHome)).toBe(false)
  })

  for (const verdict of ['present', 'missing', 'unavailable'] as const) {
    test(`workflow validation awaits selected ${verdict} facts and retains database rows`, async () => {
      const { skill, definition } = await fixture()
      const entered = barrier()
      const ready = barrier()
      const failure = new Error('selected version storage unavailable')
      const references: Array<{ id: string; contentVersion: number }> = []
      const query: SkillVersionPresenceQueries & { expectedId: string } = {
        expectedId: skill.id,
        async exists(reference) {
          expect(reference.id).toBe(this.expectedId)
          references.push(reference)
          entered.release()
          await ready.pending
          if (verdict === 'unavailable') throw failure
          return verdict === 'present'
        },
      }
      const before = await harness.db.select().from(skills)
      let settled = false
      const pending = compose(query).workflow.validationQueries.validateCandidate(authority, {
        definition,
        currentWorkflow: { id: 'candidate', name: 'selected-workflow' },
      })
      const observed = pending
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
        .finally(() => {
          settled = true
        })
      try {
        await reached(entered, pending)
        expect(settled).toBe(false)
        expect(references).toEqual([{ id: skill.id, contentVersion: skill.contentVersion }])
        expect(await harness.db.select().from(skills)).toEqual(before)
      } finally {
        ready.release()
        await observed
      }
      const outcome = await observed
      if (verdict === 'unavailable') {
        expect(outcome).toEqual({ error: failure })
      } else {
        if (!('value' in outcome)) throw outcome.error
        expect(outcome.value.issues.some((issue) => issue.code === 'skill-not-found')).toBe(
          verdict === 'missing',
        )
      }
      expect(await harness.db.select().from(skills)).toEqual(before)
      expect(existsSync(fallbackHome)).toBe(false)
    })
  }
})

test('boot availability still rejects before storage and rechecks after an asynchronous fact', async () => {
  resetSkillBootVerifyForTest()
  activateBootReverifyForTest()
  const skill = { id: 'boot-recheck', contentVersion: 3 } as Skill
  const entered = barrier()
  const ready = barrier()
  let queries = 0
  const availability = composeSkillContentAvailability({
    appHome: 'unused',
    versionPresence: {
      async exists() {
        queries += 1
        entered.release()
        await ready.pending
        return true
      },
    },
  })
  expect(await availability.isAvailable(skill)).toBe(false)
  expect(queries).toBe(0)
  markSkillBootVerified(skill.id)
  const pending = availability.isAvailable(skill)
  try {
    await reached(entered, pending)
    unmarkSkillBootVerified(skill.id)
  } finally {
    ready.release()
    await pending
  }
  expect(await pending).toBe(false)
  expect(queries).toBe(1)
})
