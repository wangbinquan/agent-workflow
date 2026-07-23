// RFC-224 T24 — effective OpenCode execution policy must reject workflow and
// workgroup closures before launch side effects, and scheduled create/fire
// must re-evaluate the current runtime rather than trusting save-time state.

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  CreateWorkgroupSchema,
  type CreateWorkgroup,
  type CreateWorkflow,
} from '@agent-workflow/shared'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createAgent } from '../src/services/agent'
import { createRuntime, updateRuntime } from '../src/services/runtimeRegistry'
import {
  createScheduledTask,
  fireSchedule,
  getScheduledTaskRow,
} from '../src/services/scheduledTasks'
import { assertWorkflowLaunchable } from '../src/services/taskLaunchGate'
import { createWorkflow, getWorkflow } from '../src/services/workflow'
import { startWorkgroupTask, WORKGROUP_HOST_WORKFLOW_ID } from '../src/services/workgroup/launch'
import { createWorkgroup } from '../src/services/workgroups'
import { createUser } from '../src/services/users'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MODEL_FAILURE = 'execution-identity-model-unresolved'
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
  bodyMd: 'do it',
}

function actor(id: string): Actor {
  return buildActor({
    user: {
      id,
      username: `u-${id}`,
      displayName: 'User',
      role: 'admin',
      status: 'active',
    },
    source: 'daemon',
  })
}

async function workflowForAgent(db: DbClient, agent: { id: string; name: string }, name: string) {
  const definition: CreateWorkflow['definition'] = {
    $schema_version: 4,
    inputs: [],
    nodes: [
      {
        id: 'agent',
        kind: 'agent-single',
        agentId: agent.id,
        agentName: agent.name,
        promptTemplate: 'work',
      },
    ],
    edges: [],
  }
  return createWorkflow(db, { name, description: '', definition })
}

function workgroupInput(agentId: string): CreateWorkgroup {
  return CreateWorkgroupSchema.parse({
    name: 'group',
    description: '',
    instructions: '',
    mode: 'free_collab',
    members: [{ memberType: 'agent', agentId, displayName: 'member', roleDesc: '' }],
  })
}

describe('RFC-224 workflow/workgroup/schedule execution-policy boundaries', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('workflow launch gate rejects an inherited OpenCode runtime without a model', async () => {
    const agent = await createAgent(db, { ...AGENT_FIELDS, name: 'worker' })
    const workflow = await workflowForAgent(db, agent, 'workflow-invalid-runtime')

    await expect(assertWorkflowLaunchable(db, actor('owner'), workflow.id)).rejects.toMatchObject({
      code: MODEL_FAILURE,
    })
  })

  test('workgroup scheduled save and direct launch reject before seeding the host workflow', async () => {
    const agent = await createAgent(db, { ...AGENT_FIELDS, name: 'member' })
    const group = await createWorkgroup(db, workgroupInput(agent.id))

    await expect(
      createScheduledTask(
        db,
        {
          name: 'scheduled-group',
          launchKind: 'workgroup',
          launchPayload: {
            workgroupId: group.id,
            name: 'scheduled run',
            goal: 'work',
            scratch: true,
          },
          scheduleSpec: SPEC,
          enabled: true,
        },
        { actor: actor('owner') },
      ),
    ).rejects.toMatchObject({ code: MODEL_FAILURE })

    expect(await getWorkflow(db, WORKGROUP_HOST_WORKFLOW_ID)).toBeNull()
    await expect(
      startWorkgroupTask(
        db,
        actor('owner'),
        group.id,
        { name: 'direct run', goal: 'work', scratch: true },
        { db, appHome: '/unused-before-policy' },
      ),
    ).rejects.toMatchObject({ code: MODEL_FAILURE })
    expect(await getWorkflow(db, WORKGROUP_HOST_WORKFLOW_ID)).toBeNull()
  })

  test('scheduled workflow fire rechecks runtime drift and never invokes launch', async () => {
    await createRuntime(db, {
      name: 'oc-valid',
      protocol: 'opencode',
      model: 'openai/gpt-5.6',
    })
    const owner = await createUser(db, {
      username: 'owner',
      displayName: 'Owner',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    const agent = await createAgent(db, {
      ...AGENT_FIELDS,
      name: 'worker',
      runtime: 'oc-valid',
    })
    const workflow = await workflowForAgent(db, agent, 'workflow-drift')
    const schedule = await createScheduledTask(
      db,
      {
        name: 'scheduled-workflow',
        launchKind: 'workflow',
        launchPayload: {
          workflowId: workflow.id,
          name: 'scheduled run',
          inputs: {},
          scratch: true,
        },
        scheduleSpec: SPEC,
        enabled: true,
      },
      { actor: actor(owner.id) },
    )
    await updateRuntime(db, 'oc-valid', { model: null })
    const row = await getScheduledTaskRow(db, schedule.id)
    expect(row).not.toBeNull()
    let launchCalls = 0

    await expect(
      fireSchedule(
        db,
        row!,
        () => async () => {
          launchCalls += 1
          return { id: 'must-not-launch' }
        },
        Date.now(),
      ),
    ).rejects.toMatchObject({ code: MODEL_FAILURE })
    expect(launchCalls).toBe(0)
  })

  test('scheduled fire uses the current daemon defaultRuntime for an inherited agent', async () => {
    await createRuntime(db, {
      name: 'oc-default-valid',
      protocol: 'opencode',
      model: 'openai/gpt-5.6',
    })
    const owner = await createUser(db, {
      username: 'default-owner',
      displayName: 'Default Owner',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    // Deliberately no agent.runtime pin: this closure follows the daemon
    // default at save and at every later fire.
    const agent = await createAgent(db, { ...AGENT_FIELDS, name: 'inherited-worker' })
    const workflow = await workflowForAgent(db, agent, 'workflow-inherited-default')
    const schedule = await createScheduledTask(
      db,
      {
        name: 'scheduled-inherited-default',
        launchKind: 'workflow',
        launchPayload: {
          workflowId: workflow.id,
          name: 'scheduled run',
          inputs: {},
          scratch: true,
        },
        scheduleSpec: SPEC,
        enabled: true,
      },
      {
        actor: actor(owner.id),
        defaultRuntime: 'oc-default-valid',
      },
    )
    const row = await getScheduledTaskRow(db, schedule.id)
    expect(row).not.toBeNull()
    let launchCalls = 0
    const buildLaunch = () => async () => {
      launchCalls += 1
      return { id: `launched-${launchCalls}` }
    }

    await expect(
      fireSchedule(db, row!, buildLaunch, Date.now(), 'oc-default-valid'),
    ).resolves.toMatchObject({ taskId: 'launched-1' })

    // The daemon default drifted to the model-less built-in OpenCode runtime.
    // Fire must reject under the current value, not reuse save-time acceptance
    // and not incorrectly resolve with an implicit hard-coded default.
    await expect(fireSchedule(db, row!, buildLaunch, Date.now(), 'opencode')).rejects.toMatchObject(
      { code: MODEL_FAILURE },
    )
    expect(launchCalls).toBe(1)
  })
})
