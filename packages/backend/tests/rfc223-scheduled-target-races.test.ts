// RFC-223 final implementation gate — scheduled writes must re-check their
// canonical target in the SAME dbTxSync as INSERT/UPDATE. The hooks below
// deterministically open the former async target-gate→write window.
//
// Create covers all three target kinds with the target's real delete service
// winning first. Update covers the three mutable target semantics that matter
// at commit: current ACL visibility and built-in identity. Every rejection
// leaves the scheduled row absent/unchanged, so neither serial order can
// create an orphan.

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, scheduledTasks, workflows, workgroups } from '../src/db/schema'
import { createAgent, deleteAgent } from '../src/services/agent'
import { createScheduledTask, updateScheduledTask } from '../src/services/scheduledTasks'
import { createWorkflow, deleteWorkflow } from '../src/services/workflow'
import { deleteWorkgroup } from '../src/services/workgroups'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SPEC = { kind: 'daily', at: '09:00', timezone: 'UTC' } as const

const AGENT_FIELDS = {
  description: '',
  outputs: [] as string[],
  syncOutputsOnIterate: true,
  permission: {},
  skills: [],
  dependsOn: [] as string[],
  mcp: [] as string[],
  plugins: [] as string[],
  frontmatterExtra: {},
  bodyMd: '',
}

function actorFor(id = 'u-owner'): Actor {
  return buildActor({
    user: {
      id,
      username: id,
      displayName: id,
      role: 'user',
      status: 'active',
    },
    source: 'session',
  })
}

async function seedWorkflow(db: DbClient, ownerId: string) {
  return createWorkflow(
    db,
    {
      name: `wf-${ulid()}`,
      description: '',
      definition: { $schema_version: 1, inputs: [], nodes: [], edges: [] } as never,
    },
    { ownerUserId: ownerId },
  )
}

async function seedAgent(db: DbClient, actor: Actor) {
  return createAgent(
    db,
    { ...AGENT_FIELDS, name: `agent-${ulid().toLowerCase()}` },
    { ownerUserId: actor.user.id, actor },
  )
}

async function seedWorkgroup(db: DbClient, ownerId: string) {
  const id = ulid()
  await db.insert(workgroups).values({
    id,
    name: `wg-${id.toLowerCase()}`,
    mode: 'free_collab',
    ownerUserId: ownerId,
    visibility: 'public',
  })
  return { id, name: `wg-${id.toLowerCase()}`, version: 1 }
}

function workflowPayload(workflowId: string) {
  return {
    workflowId,
    name: 'scheduled workflow',
    inputs: {},
    repoUrl: 'https://example.com/repo.git',
  }
}

function agentPayload(agentId: string) {
  return {
    agentId,
    name: 'scheduled agent',
    description: 'do it',
    scratch: true,
  }
}

function workgroupPayload(workgroupId: string) {
  return {
    workgroupId,
    name: 'scheduled workgroup',
    goal: 'do it',
    scratch: true,
  }
}

describe('RFC-223 scheduled create target/delete transaction order', () => {
  let db: DbClient
  let actor: Actor

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    actor = actorFor()
  })

  test('workflow delete wins after preflight: final INSERT tx returns workflow-not-found and writes no orphan', async () => {
    const workflow = await seedWorkflow(db, actor.user.id)
    await expect(
      createScheduledTask(
        db,
        {
          name: 'workflow race',
          launchKind: 'workflow',
          launchPayload: workflowPayload(workflow.id),
          scheduleSpec: SPEC,
          enabled: true,
        },
        {
          actor,
          beforeWriteTx: async () => {
            await deleteWorkflow(
              db,
              workflow.id,
              { expectedVersion: 1, clientMutationId: ulid(), confirm: workflow.name },
              { kind: 'actor', actor },
            )
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'workflow-not-found' })
    expect(await db.select().from(scheduledTasks)).toEqual([])
    expect(await db.select().from(workflows).where(eq(workflows.id, workflow.id))).toEqual([])
  })

  test('agent delete wins after preflight: final INSERT tx returns agent-not-found and writes no orphan', async () => {
    const agent = await seedAgent(db, actor)
    await expect(
      createScheduledTask(
        db,
        {
          name: 'agent race',
          launchKind: 'agent',
          launchPayload: agentPayload(agent.id),
          scheduleSpec: SPEC,
          enabled: true,
        },
        {
          actor,
          beforeWriteTx: async () => {
            await deleteAgent(db, agent.id, actor)
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'agent-not-found' })
    expect(await db.select().from(scheduledTasks)).toEqual([])
    expect(await db.select().from(agents).where(eq(agents.id, agent.id))).toEqual([])
  })

  test('workgroup delete wins after preflight: final INSERT tx returns workgroup-not-found and writes no orphan', async () => {
    const group = await seedWorkgroup(db, actor.user.id)
    await expect(
      createScheduledTask(
        db,
        {
          name: 'workgroup race',
          launchKind: 'workgroup',
          launchPayload: workgroupPayload(group.id),
          scheduleSpec: SPEC,
          enabled: true,
        },
        {
          actor,
          beforeWriteTx: async () => {
            await deleteWorkgroup(
              db,
              group.id,
              { expectedVersion: 1, clientMutationId: ulid(), confirm: group.name },
              { kind: 'actor', actor },
            )
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'workgroup-not-found' })
    expect(await db.select().from(scheduledTasks)).toEqual([])
    expect(await db.select().from(workgroups).where(eq(workgroups.id, group.id))).toEqual([])
  })
})

describe('RFC-223 scheduled update final target identity/ACL fence', () => {
  let db: DbClient
  let actor: Actor

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    actor = actorFor()
  })

  async function storedName(id: string): Promise<string> {
    return (
      await db
        .select({ name: scheduledTasks.name })
        .from(scheduledTasks)
        .where(eq(scheduledTasks.id, id))
    )[0]!.name
  }

  test('workflow built-in bit flips after preflight: final UPDATE tx returns builtin-readonly and rolls back', async () => {
    const workflow = await seedWorkflow(db, actor.user.id)
    const schedule = await createScheduledTask(
      db,
      {
        name: 'before',
        launchKind: 'workflow',
        launchPayload: workflowPayload(workflow.id),
        scheduleSpec: SPEC,
        enabled: true,
      },
      { actor },
    )

    await expect(
      updateScheduledTask(
        db,
        schedule.id,
        { name: 'must-not-commit' },
        {
          actor,
          beforeWriteTx: async () => {
            await db.update(workflows).set({ builtin: true }).where(eq(workflows.id, workflow.id))
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'builtin-readonly' })
    expect(await storedName(schedule.id)).toBe('before')
  })

  test('agent becomes another owner private after preflight: final UPDATE tx returns non-enumerating 404 and rolls back', async () => {
    const agent = await seedAgent(db, actor)
    const schedule = await createScheduledTask(
      db,
      {
        name: 'before',
        launchKind: 'agent',
        launchPayload: agentPayload(agent.id),
        scheduleSpec: SPEC,
        enabled: true,
      },
      { actor },
    )

    await expect(
      updateScheduledTask(
        db,
        schedule.id,
        { name: 'must-not-commit' },
        {
          actor,
          beforeWriteTx: async () => {
            await db
              .update(agents)
              .set({ ownerUserId: 'u-other', visibility: 'private', aclRevision: 1 })
              .where(eq(agents.id, agent.id))
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'agent-not-found' })
    expect(await storedName(schedule.id)).toBe('before')
  })

  test('workgroup becomes another owner private after preflight: final UPDATE tx returns non-enumerating 404 and rolls back', async () => {
    const group = await seedWorkgroup(db, actor.user.id)
    const schedule = await createScheduledTask(
      db,
      {
        name: 'before',
        launchKind: 'workgroup',
        launchPayload: workgroupPayload(group.id),
        scheduleSpec: SPEC,
        enabled: true,
      },
      { actor },
    )

    await expect(
      updateScheduledTask(
        db,
        schedule.id,
        { name: 'must-not-commit' },
        {
          actor,
          beforeWriteTx: async () => {
            await db
              .update(workgroups)
              .set({ ownerUserId: 'u-other', visibility: 'private', aclRevision: 1 })
              .where(eq(workgroups.id, group.id))
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'workgroup-not-found' })
    expect(await storedName(schedule.id)).toBe('before')
  })
})
