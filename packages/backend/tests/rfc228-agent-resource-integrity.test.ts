// RFC-228 — an Agent's persisted resource ids are canonical identity, but a
// dangling id is never a runnable capability. Save and launch boundaries must
// reject the complete dependsOn closure, while actor-safe status distinguishes
// a visible name, a hidden existing row, and a genuinely missing row.

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  CreateWorkgroupSchema,
  type CreateAgent,
  type CreateWorkflow,
} from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, mcps } from '../src/db/schema'
import { createAgent } from '../src/services/agent'
import { getAgentResourceStatus } from '../src/services/agentResourceIntegrity'
import { createMcp } from '../src/services/mcp'
import { createRuntime } from '../src/services/runtimeRegistry'
import { assertWorkflowLaunchable } from '../src/services/taskLaunchGate'
import { createWorkflow, getWorkflow } from '../src/services/workflow'
import { startWorkgroupTask, WORKGROUP_HOST_WORKFLOW_ID } from '../src/services/workgroup/launch'
import { createWorkgroup } from '../src/services/workgroups'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const VALID_RUNTIME = 'rfc228-opencode'

function actor(id = 'viewer'): Actor {
  return buildActor({
    user: {
      id,
      username: id,
      displayName: id,
      role: 'user',
      status: 'active',
    },
    source: 'daemon',
  })
}

function agentInput(name: string, patch: Partial<CreateAgent> = {}): CreateAgent {
  return {
    name,
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
    ...patch,
  }
}

describe('RFC-228 Agent resource integrity', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('create rejects a missing managed Skill but keeps project Skills repo-local', async () => {
    await expect(
      createAgent(
        db,
        agentInput('broken', {
          skills: [{ kind: 'managed', skillId: 'missing-skill' }],
        }),
      ),
    ).rejects.toMatchObject({
      code: 'agent-resources-invalid',
      details: { issues: [{ code: 'skill-not-found', refKind: 'skill', direct: true }] },
    })

    const projectAgent = await createAgent(
      db,
      agentInput('project-skill', {
        skills: [{ kind: 'project', name: 'repo-local-skill' }],
      }),
    )
    expect(projectAgent.skills).toEqual([{ kind: 'project', name: 'repo-local-skill' }])
  })

  test('a broken dependent Agent prevents saving a new root Agent', async () => {
    const child = await createAgent(db, agentInput('child'))
    await db
      .update(agents)
      .set({
        skills: JSON.stringify([{ kind: 'managed', skillId: 'missing-in-child' }]),
      })
      .where(eq(agents.id, child.id))

    await expect(
      createAgent(db, agentInput('parent', { dependsOn: [child.id] })),
    ).rejects.toMatchObject({
      code: 'agent-resources-invalid',
      details: { issues: [{ code: 'skill-not-found', refKind: 'skill', direct: false }] },
    })
  })

  test('status shows names, masks hidden rows, and marks deleted rows without using the id as a name', async () => {
    const mcp = await createMcp(
      db,
      {
        name: 'docs-server',
        description: '',
        type: 'local',
        config: { command: ['docs-server'] },
        enabled: true,
      },
      { ownerUserId: 'other-owner' },
    )
    const root = await createAgent(db, agentInput('root', { mcp: [mcp.id] }))

    const visible = await getAgentResourceStatus(db, actor(), root)
    expect(visible).toMatchObject({
      ok: true,
      references: [{ kind: 'mcp', refId: mcp.id, name: 'docs-server', state: 'available' }],
    })

    await db.update(mcps).set({ visibility: 'private' }).where(eq(mcps.id, mcp.id))
    const hidden = await getAgentResourceStatus(db, actor(), root)
    expect(hidden).toMatchObject({
      ok: true,
      references: [{ kind: 'mcp', refId: mcp.id, name: null, state: 'hidden' }],
    })

    await db.delete(mcps).where(eq(mcps.id, mcp.id))
    const missing = await getAgentResourceStatus(db, actor(), root)
    expect(missing).toMatchObject({
      ok: false,
      references: [{ kind: 'mcp', refId: mcp.id, name: null, state: 'missing' }],
      issues: [{ code: 'mcp-not-found', state: 'missing', refName: null }],
    })
  })

  test('workflow and workgroup launch reject a stale member closure before host/task creation', async () => {
    await createRuntime(db, {
      name: VALID_RUNTIME,
      protocol: 'opencode',
      model: 'openai/gpt-5.6',
    })
    const mcp = await createMcp(db, {
      name: 'required-mcp',
      description: '',
      type: 'local',
      config: { command: ['required-mcp'] },
      enabled: true,
    })
    const member = await createAgent(
      db,
      agentInput('member', { runtime: VALID_RUNTIME, mcp: [mcp.id] }),
    )
    const definition: CreateWorkflow['definition'] = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        {
          id: 'member-node',
          kind: 'agent-single',
          agentId: member.id,
          agentName: member.name,
          promptTemplate: 'work',
        },
      ],
      edges: [],
    }
    const workflow = await createWorkflow(db, {
      name: 'resource-gated-workflow',
      description: '',
      definition,
    })
    const group = await createWorkgroup(
      db,
      CreateWorkgroupSchema.parse({
        name: 'resource-gated-group',
        description: '',
        instructions: '',
        mode: 'free_collab',
        members: [
          {
            memberType: 'agent',
            agentId: member.id,
            displayName: 'member',
            roleDesc: '',
          },
        ],
      }),
    )

    await db.delete(mcps).where(eq(mcps.id, mcp.id))

    await expect(assertWorkflowLaunchable(db, actor(), workflow.id)).rejects.toMatchObject({
      code: 'workflow-invalid',
      details: {
        issues: expect.arrayContaining([expect.objectContaining({ code: 'mcp-not-found' })]),
      },
    })
    await expect(
      startWorkgroupTask(
        db,
        actor(),
        group.id,
        { name: 'blocked run', goal: 'work', scratch: true },
        { db, appHome: '/unused-before-resource-gate', defaultRuntime: VALID_RUNTIME },
      ),
    ).rejects.toMatchObject({
      code: 'agent-resources-invalid',
      details: { issues: [{ code: 'mcp-not-found', refKind: 'mcp' }] },
    })
    expect(await getWorkflow(db, WORKGROUP_HOST_WORKFLOW_ID)).toBeNull()
  })
})
