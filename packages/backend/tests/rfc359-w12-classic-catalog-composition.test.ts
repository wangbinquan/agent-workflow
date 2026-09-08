// RFC-359 W12: execute the complete classic catalog bundle before consolidating
// its daemon wiring. A renamed factory alone cannot prove that its ports work.
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CreateAgentSchema } from '@agent-workflow/shared'
import { users } from '@/db/schema'
import { composeSkillMemoryFusionParticipantFactory } from '@/modules/memory/composition'
import { createAsyncSkillRestoreMembership } from '@/modules/knowledge-evolution/public/participants'
import { composeClassicCatalogs } from '@/modules/resource-catalog/composition/classicCatalogs'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { resetSkillBootVerifyForTest } from '@/modules/resource-catalog/infrastructure/legacy/skillBootVerify'
import type { AgentOperationContext } from '@/modules/resource-catalog/public/participants'
import { describeEachProvider } from './helpers/eachProvider'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  resetSkillBootVerifyForTest()
})

describeEachProvider('RFC-359 W12 complete classic catalog composition', (harness) => {
  test('create, read and recompose agent, managed skill and workflow using the same database', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rfc359-classic-'))
    homes.push(home)
    const owner = 'classic-catalog-owner'
    await harness.db.insert(users).values({
      id: owner,
      username: owner,
      displayName: owner,
      role: 'admin',
      createdAt: 1,
      updatedAt: 1,
    })
    const authority = {
      user: { id: owner, username: owner, displayName: owner, role: 'admin', status: 'active' },
      userId: owner,
      source: 'session',
      permissions: new Set(['resource-acl:private']),
    } as unknown as AgentOperationContext
    const resourceCatalog = composeResourceCatalogFor({ db: harness.db })
    const compose = (appHome: string) =>
      composeClassicCatalogs({
        db: harness.db,
        appHome,
        runtimeProfiles: { get: async () => ({ enabled: true }) },
        restoreMembership: createAsyncSkillRestoreMembership(
          composeSkillMemoryFusionParticipantFactory(),
        ),
        resourceCatalog,
      })
    const recording = harness.recordStatements()
    const catalog = compose(home)
    recording.stop()
    expect(recording.statements).toEqual([])
    expect(readdirSync(home)).toEqual([])
    const skill = await catalog.skill.operations.create.invoke(authority, {
      submission: {
        kind: 'json-body',
        body: JSON.stringify({ name: 'classic-skill', bodyMd: 'original body' }),
      },
    })
    expect(await catalog.skillContent.isAvailable(skill)).toBe(true)
    expect(await catalog.skill.queries.content(authority, { id: skill.id })).toMatchObject({
      bodyMd: 'original body',
    })
    const agent = await catalog.agent.operations.create.invoke(
      authority,
      CreateAgentSchema.parse({
        name: 'classic-agent',
        runtime: 'opencode',
        skills: [{ kind: 'managed', skillId: skill.id }],
      }),
    )
    expect(await catalog.agent.queries.get(authority, { id: agent.id })).toMatchObject({
      id: agent.id,
      runtime: 'opencode',
      skills: [{ kind: 'managed', skillId: skill.id }],
    })
    expect(
      await catalog.agentResourceIntegrity.queries.closureStatus(authority, {
        rootAgentIds: [agent.id],
      }),
    ).toEqual({ ok: true, issues: [] })
    const workflow = await catalog.workflow.operations.create.invoke(authority, {
      submission: {
        kind: 'json-body',
        body: JSON.stringify({
          name: 'classic-workflow',
          definition: { $schema_version: 2, nodes: [], edges: [] },
        }),
      },
    })
    const recomposed = compose(home)
    expect(await recomposed.agent.queries.get(authority, { id: agent.id })).toEqual(agent)
    expect(await recomposed.skill.queries.get(authority, { id: skill.id })).toMatchObject(skill)
    expect(await recomposed.workflow.queries.get(authority, { id: workflow.id })).toMatchObject({
      ...workflow,
      definition: { $schema_version: 6, inputs: [], nodes: [], edges: [] },
    })
    const otherHome = join(home, 'other-root')
    expect(await compose(otherHome).skillContent.isAvailable(skill)).toBe(false)
    expect(existsSync(otherHome)).toBe(false)
  })
})
