// RFC-223 final implementation gate — ordinary reference writers must not
// persist a canonical id whose target was deleted or became invisible after
// async preflight. Every case uses the production `beforeWriteTransaction`
// seam, so the mutation deterministically lands in the former TOCTOU window.
//
// The same suite locks D15's other half: authorization loss on an unchanged
// stored ref is grandfathered, and historically tolerated never-resolved
// workflow / managed-skill refs remain tolerated.

import {
  CreateWorkgroupSchema,
  type CreateAgent,
  type WorkflowDefinition,
  type WorkgroupRuntimeConfig,
} from '@agent-workflow/shared'
import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { stringify } from 'yaml'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  agents,
  mcps,
  plugins,
  resourceGrants,
  skills,
  tasks,
  users,
  workflows,
} from '../src/db/schema'
import { createAgent, getAgentById, updateAgent } from '../src/services/agent'
import { buildConfigActions } from '../src/services/workgroup/configActions'
import { buildWorkgroupTaskActions } from '../src/services/workgroup/taskActions'
import { importWorkflowYaml } from '../src/services/workflow.yaml'
import {
  createWorkflow,
  getWorkflow,
  updateWorkflow,
  workflowDraftSnapshotOf,
} from '../src/services/workflow'
import {
  createWorkgroup,
  getWorkgroupById,
  saveWorkgroup,
  workgroupDraftSnapshotOf,
} from '../src/services/workgroups'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const EMPTY_AGENT: Omit<CreateAgent, 'name'> = {
  description: '',
  outputs: [],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [],
  mcp: [],
  plugins: [],
  frontmatterExtra: {},
  bodyMd: '',
}

function actor(id: string): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role: 'user', status: 'active' },
    source: 'session',
  })
}

async function seedUser(db: DbClient, id: string): Promise<void> {
  await db.insert(users).values({
    id,
    username: id,
    displayName: id,
    role: 'user',
    status: 'active',
    createdAt: 1,
    updatedAt: 1,
  })
}

function workflowDefinition(agentId?: string): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes:
      agentId === undefined
        ? []
        : [
            {
              id: 'worker',
              kind: 'agent-single',
              agentId,
              agentName: 'display-only',
            },
          ],
    edges: [],
  }
}

async function seedMcp(db: DbClient, id: string, ownerUserId = 'target-owner'): Promise<void> {
  await db.insert(mcps).values({
    id,
    name: `mcp-${id}`,
    type: 'local',
    config: JSON.stringify({ command: ['true'] }),
    enabled: true,
    ownerUserId,
    visibility: 'public',
  })
}

async function grant(
  db: DbClient,
  type: 'agent' | 'mcp',
  resourceId: string,
  userId: string,
): Promise<void> {
  await db.insert(resourceGrants).values({
    resourceType: type,
    resourceId,
    userId,
    addedBy: 'target-owner',
    addedAt: 1,
  })
}

describe('RFC-223 ordinary reference final-transaction fences', () => {
  let db: DbClient
  let editor: Actor

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedUser(db, 'editor')
    await seedUser(db, 'target-owner')
    await seedUser(db, 'new-owner')
    editor = actor('editor')
  })

  test('agent create fences mcp/plugin/dependsOn/managed-skill ids after preflight', async () => {
    const scenarios = [
      {
        kind: 'mcp',
        seed: async (id: string) => seedMcp(db, id),
        input: (id: string): Partial<CreateAgent> => ({ mcp: [id] }),
        hide: async (id: string) => {
          await db.update(mcps).set({ visibility: 'private' }).where(eq(mcps.id, id))
        },
      },
      {
        kind: 'plugin',
        seed: async (id: string) => {
          await db.insert(plugins).values({
            id,
            name: `plugin-${id}`,
            spec: 'pkg@1',
            sourceKind: 'npm',
            cachedPath: `/tmp/${id}`,
            installedAt: 1,
            enabled: true,
            ownerUserId: 'target-owner',
            visibility: 'public',
          })
        },
        input: (id: string): Partial<CreateAgent> => ({ plugins: [id] }),
        hide: async (id: string) => {
          await db.update(plugins).set({ visibility: 'private' }).where(eq(plugins.id, id))
        },
      },
      {
        kind: 'dependsOn',
        seed: async (id: string) => {
          await createAgent(db, { name: `dep-${id}`, ...EMPTY_AGENT }, { id })
          await db
            .update(agents)
            .set({ ownerUserId: 'target-owner', visibility: 'public' })
            .where(eq(agents.id, id))
        },
        input: (id: string): Partial<CreateAgent> => ({ dependsOn: [id] }),
        hide: async (id: string) => {
          await db.update(agents).set({ visibility: 'private' }).where(eq(agents.id, id))
        },
      },
      {
        kind: 'managed-skill',
        seed: async (id: string) => {
          await db.insert(skills).values({
            id,
            name: `skill-${id}`,
            sourceKind: 'managed',
            ownerUserId: 'target-owner',
            visibility: 'public',
          })
        },
        input: (id: string): Partial<CreateAgent> => ({
          skills: [{ kind: 'managed', skillId: id }],
        }),
        hide: async (id: string) => {
          await db.update(skills).set({ visibility: 'private' }).where(eq(skills.id, id))
        },
      },
    ] as const

    for (const scenario of scenarios) {
      const targetId = ulid()
      const sourceName = `source-${scenario.kind}`
      await scenario.seed(targetId)
      await expect(
        createAgent(
          db,
          { name: sourceName, ...EMPTY_AGENT, ...scenario.input(targetId) },
          {
            ownerUserId: editor.user.id,
            actor: editor,
            beforeWriteTransaction: () => scenario.hide(targetId),
          },
        ),
      ).rejects.toMatchObject({
        code: 'acl-missing-refs',
        details: { missing: [{ name: targetId }] },
      })
      expect(
        (await db.select({ name: agents.name }).from(agents)).some(
          (row) => row.name === sourceName,
        ),
      ).toBe(false)
    }
  })

  test('agent create system caller still refuses a matched target deleted after validation', async () => {
    const mcpId = ulid()
    await seedMcp(db, mcpId)

    await expect(
      createAgent(
        db,
        { name: 'system-writer', ...EMPTY_AGENT, mcp: [mcpId] },
        {
          beforeWriteTransaction: async () => {
            await db.delete(mcps).where(eq(mcps.id, mcpId))
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'acl-missing-refs' })
    expect((await db.select().from(agents)).some((row) => row.name === 'system-writer')).toBe(false)
  })

  test('agent update rejects grant revocation and leaves the ref unset', async () => {
    const mcpId = ulid()
    await seedMcp(db, mcpId)
    await db.update(mcps).set({ visibility: 'private' }).where(eq(mcps.id, mcpId))
    await grant(db, 'mcp', mcpId, editor.user.id)
    const source = await createAgent(
      db,
      { name: 'update-source', ...EMPTY_AGENT },
      { ownerUserId: editor.user.id, actor: editor },
    )

    await expect(
      updateAgent(
        db,
        source.id,
        { mcp: [mcpId] },
        editor,
        {
          expectedUpdatedAt: source.updatedAt,
          expectedAclRevision: source.aclRevision ?? 0,
        },
        {
          beforeWriteTransaction: async () => {
            await db.delete(resourceGrants).where(eq(resourceGrants.resourceId, mcpId))
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'acl-missing-refs' })
    expect((await getAgentById(db, source.id))?.mcp).toEqual([])
  })

  test('agent D15: an unchanged ref survives later visibility loss', async () => {
    const mcpId = ulid()
    await seedMcp(db, mcpId)
    const source = await createAgent(
      db,
      { name: 'grandfathered-agent', ...EMPTY_AGENT, mcp: [mcpId] },
      { ownerUserId: editor.user.id, actor: editor },
    )
    await db.update(mcps).set({ visibility: 'private' }).where(eq(mcps.id, mcpId))

    const updated = await updateAgent(db, source.id, { description: 'unrelated edit' }, editor, {
      expectedUpdatedAt: source.updatedAt,
      expectedAclRevision: source.aclRevision ?? 0,
    })
    expect(updated.description).toBe('unrelated edit')
    expect(updated.mcp).toEqual([mcpId])
  })

  test('unresolved managed skill remains a managed ref instead of becoming fence-required', async () => {
    const missingSkillId = 'never-resolved-managed-skill'
    const created = await createAgent(
      db,
      {
        name: 'dormant-skill-ref',
        ...EMPTY_AGENT,
        skills: [{ kind: 'managed', skillId: missingSkillId }],
      },
      { ownerUserId: editor.user.id, actor: editor },
    )
    expect(created.skills).toEqual([{ kind: 'managed', skillId: missingSkillId }])
  })

  test('workflow create rejects matched-then-deleted, but preserves dangling-id contract', async () => {
    const target = await createAgent(
      db,
      { name: 'workflow-target', ...EMPTY_AGENT },
      { ownerUserId: 'target-owner' },
    )
    await expect(
      createWorkflow(
        db,
        {
          name: 'raced-workflow',
          description: '',
          definition: workflowDefinition(target.id),
        },
        {
          ownerUserId: editor.user.id,
          actor: editor,
          beforeWriteTransaction: async () => {
            await db.delete(agents).where(eq(agents.id, target.id))
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'acl-missing-refs' })
    expect(await db.select().from(workflows)).toHaveLength(0)

    const dangling = await createWorkflow(
      db,
      {
        name: 'dormant-workflow',
        description: '',
        definition: workflowDefinition('never-resolved-agent-id'),
      },
      { ownerUserId: editor.user.id, actor: editor },
    )
    expect(dangling.definition.nodes[0]).toMatchObject({ agentId: 'never-resolved-agent-id' })
  })

  test('workflow update fences a newly matched id before CAS and D15 grandfathers existing ids', async () => {
    const target = await createAgent(
      db,
      { name: 'workflow-update-target', ...EMPTY_AGENT },
      { ownerUserId: 'target-owner' },
    )
    await db.update(agents).set({ visibility: 'private' }).where(eq(agents.id, target.id))
    await grant(db, 'agent', target.id, editor.user.id)
    const empty = await createWorkflow(
      db,
      { name: 'empty', description: '', definition: workflowDefinition() },
      { ownerUserId: editor.user.id, actor: editor },
    )

    await expect(
      updateWorkflow(
        db,
        empty.id,
        {
          expectedVersion: empty.version,
          clientMutationId: ulid(),
          snapshot: {
            ...workflowDraftSnapshotOf(empty),
            definition: workflowDefinition(target.id),
          },
        },
        { kind: 'actor', actor: editor },
        {
          beforeWriteTransaction: async () => {
            await db.delete(resourceGrants).where(eq(resourceGrants.resourceId, target.id))
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'acl-missing-refs' })
    expect((await getWorkflow(db, empty.id))?.version).toBe(1)

    await db.update(agents).set({ visibility: 'public' }).where(eq(agents.id, target.id))
    const withRef = await createWorkflow(
      db,
      { name: 'grandfathered', description: '', definition: workflowDefinition(target.id) },
      { ownerUserId: editor.user.id, actor: editor },
    )
    await db.update(agents).set({ visibility: 'private' }).where(eq(agents.id, target.id))
    const receipt = await updateWorkflow(
      db,
      withRef.id,
      {
        expectedVersion: withRef.version,
        clientMutationId: ulid(),
        snapshot: { ...workflowDraftSnapshotOf(withRef), description: 'still editable' },
      },
      { kind: 'actor', actor: editor },
    )
    expect(receipt.outcome).toBe('committed')
  })

  test('workflow import guard stays first and preserves its non-enumerating error contract', async () => {
    const target = await createAgent(
      db,
      { name: 'portable-target', ...EMPTY_AGENT },
      { ownerUserId: 'target-owner' },
    )
    await db.update(agents).set({ visibility: 'private' }).where(eq(agents.id, target.id))
    await grant(db, 'agent', target.id, editor.user.id)

    await expect(
      importWorkflowYaml(
        db,
        {
          mode: 'new',
          yamlText: stringify({
            name: 'portable-race',
            description: '',
            definition: {
              $schema_version: 4,
              inputs: [],
              nodes: [{ id: 'worker', kind: 'agent-single', agentName: 'portable-target' }],
              edges: [],
            },
          }),
        },
        { kind: 'actor', actor: editor },
        {
          afterResolve: async () => {
            await db.delete(resourceGrants).where(eq(resourceGrants.resourceId, target.id))
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'import-ref-unresolved' })
    expect(await db.select().from(workflows)).toHaveLength(0)
  })

  test('workgroup create/save fence new members while unchanged members stay grandfathered', async () => {
    const baseAgent = await createAgent(
      db,
      { name: 'base-member', ...EMPTY_AGENT },
      { ownerUserId: 'target-owner' },
    )
    const racedAgent = await createAgent(
      db,
      { name: 'raced-member', ...EMPTY_AGENT },
      { ownerUserId: 'target-owner' },
    )
    const createInput = CreateWorkgroupSchema.parse({
      name: 'create-race',
      description: '',
      instructions: '',
      mode: 'free_collab',
      members: [
        {
          memberType: 'agent',
          agentId: racedAgent.id,
          displayName: 'raced',
          roleDesc: '',
        },
      ],
    })
    await expect(
      createWorkgroup(db, createInput, {
        ownerUserId: editor.user.id,
        actor: editor,
        beforeWriteTransaction: async () => {
          await db
            .update(agents)
            .set({ ownerUserId: 'new-owner', visibility: 'private' })
            .where(eq(agents.id, racedAgent.id))
        },
      }),
    ).rejects.toMatchObject({ code: 'acl-missing-refs' })

    const group = await createWorkgroup(
      db,
      CreateWorkgroupSchema.parse({
        name: 'save-race',
        description: '',
        instructions: '',
        mode: 'free_collab',
        members: [
          {
            memberType: 'agent',
            agentId: baseAgent.id,
            displayName: 'base',
            roleDesc: '',
          },
        ],
      }),
      { ownerUserId: editor.user.id, actor: editor },
    )
    await db.update(agents).set({ visibility: 'private' }).where(eq(agents.id, baseAgent.id))
    const grandfathered = await saveWorkgroup(
      db,
      group.id,
      {
        expectedVersion: group.version,
        clientMutationId: ulid(),
        snapshot: { ...workgroupDraftSnapshotOf(group), description: 'allowed' },
      },
      { kind: 'actor', actor: editor },
    )
    expect(grandfathered.outcome).toBe('committed')

    await db.update(agents).set({ visibility: 'public' }).where(eq(agents.id, racedAgent.id))
    const current = grandfathered.workgroup
    await expect(
      saveWorkgroup(
        db,
        current.id,
        {
          expectedVersion: current.version,
          clientMutationId: ulid(),
          snapshot: {
            ...workgroupDraftSnapshotOf(current),
            members: [
              ...workgroupDraftSnapshotOf(current).members,
              {
                memberType: 'agent',
                agentId: racedAgent.id,
                displayName: 'new',
                roleDesc: '',
              },
            ],
          },
        },
        { kind: 'actor', actor: editor },
        {
          beforeWriteTransaction: async () => {
            await db.delete(agents).where(eq(agents.id, racedAgent.id))
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'acl-missing-refs' })
    expect((await getWorkgroupById(db, current.id))?.members).toHaveLength(1)
  })

  test('mid-run addMembers rejects a target deleted after ACL/name preflight', async () => {
    const baseAgent = await createAgent(db, { name: 'room-base', ...EMPTY_AGENT })
    const lateAgent = await createAgent(
      db,
      { name: 'room-late', ...EMPTY_AGENT },
      { ownerUserId: 'target-owner' },
    )
    const config: WorkgroupRuntimeConfig = {
      workgroupId: 'wg-runtime',
      workgroupName: 'runtime-room',
      mode: 'free_collab',
      leaderMemberId: null,
      switches: { shareOutputs: true, directMessages: false, blackboard: false },
      maxRounds: 10,
      completionGate: false,
      instructions: '',
      goal: 'goal',
      members: [
        {
          id: 'member-base',
          memberType: 'agent',
          agentId: baseAgent.id,
          agentName: baseAgent.name,
          userId: null,
          displayName: 'base',
          roleDesc: '',
        },
      ],
    }
    const workflowId = ulid()
    const taskId = ulid()
    await db.insert(workflows).values({
      id: workflowId,
      name: 'runtime-host',
      definition: JSON.stringify(workflowDefinition()),
    })
    await db.insert(tasks).values({
      id: taskId,
      name: 'runtime-task',
      workflowId,
      workflowSnapshot: JSON.stringify(workflowDefinition()),
      repoPath: '/tmp/rfc223-ref-fence',
      worktreePath: '/tmp/rfc223-ref-fence-wt',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: '{}',
      startedAt: 1,
      ownerUserId: editor.user.id,
      workgroupId: config.workgroupId,
      workgroupConfigJson: JSON.stringify(config),
    })
    const core = buildWorkgroupTaskActions({
      db,
      configPath: '/tmp/rfc223-ref-fence-config.json',
    })
    const actions = buildConfigActions(
      {
        db,
        configPath: '/tmp/rfc223-ref-fence-config.json',
        beforeWriteTransaction: async () => {
          await db.delete(agents).where(eq(agents.id, lateAgent.id))
        },
      },
      core,
    )

    await expect(
      actions.updateTaskConfig(editor, taskId, {
        addMembers: [
          {
            memberType: 'agent',
            agentId: lateAgent.id,
            displayName: 'late',
            roleDesc: '',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'acl-missing-refs' })
    const stored = JSON.parse(
      (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!.workgroupConfigJson!,
    ) as WorkgroupRuntimeConfig
    expect(stored.members.map((member) => member.displayName)).toEqual(['base'])
  })
})
