// RFC-251 — the product boundaries no longer reject plugins or `dependsOn` on
// an OpenCode runtime.
//
// Why this test exists: RFC-224 made both a PERMANENT ValidationError at every
// save/launch entry point, so an operator could not even store the selection.
// RFC-251 restored the features (they are assembled into the controlled config
// instead). These are the positive locks for the save/launch surface — the
// runtime-side assembly is covered by rfc251-controlled-config and the
// end-to-end manifest cases in rfc224-verified-plan.
//
// A runtime model is optional: when absent, OpenCode chooses its own configured
// default. Product save and launch surfaces do not add a separate policy gate.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { CreateWorkflow } from '@agent-workflow/shared'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createAgent, updateAgent } from '../src/services/agent'
import { createPlugin } from '../src/services/plugin'
import { resetNpmProbeCacheForTests } from '../src/services/pluginInstaller'
import { createRuntime } from '../src/services/runtimeRegistry'
import { createScheduledTask } from '../src/services/scheduledTasks'
import { assertWorkflowLaunchable } from '../src/services/taskLaunchGate'
import { createWorkflow } from '../src/services/workflow'
import { createUser } from '../src/services/users'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const FAKE_NPM = resolve(import.meta.dir, 'fixtures', 'fake-npm.ts')
const SPEC = { kind: 'daily', at: '09:00', timezone: 'UTC' } as const
const OPENCODE_RUNTIME = 'oc-with-model'

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

let db: DbClient
let pluginsDir = ''

function actor(id: string): Actor {
  return buildActor({
    user: { id, username: `u-${id}`, displayName: 'User', role: 'admin', status: 'active' },
    source: 'daemon',
  })
}

async function workflowForAgent(agent: { id: string; name: string }, name: string) {
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

beforeEach(async () => {
  db = createInMemoryDb(MIGRATIONS)
  pluginsDir = await mkdtemp(join(tmpdir(), 'rfc251-plugins-'))
  resetNpmProbeCacheForTests()
  await createRuntime(db, {
    name: OPENCODE_RUNTIME,
    protocol: 'opencode',
    model: 'openai/gpt-5.6',
  })
})

afterEach(async () => {
  if (pluginsDir !== '') await rm(pluginsDir, { recursive: true, force: true })
  resetNpmProbeCacheForTests()
})

describe('RFC-251 — saving an OpenCode agent with plugins / collaborators', () => {
  test('create accepts a plugin selection', async () => {
    const plugin = await createPlugin(
      db,
      { name: 'formatter', spec: 'formatter@1' },
      { pluginsDir, npmBin: FAKE_NPM },
    )
    const agent = await createAgent(db, {
      ...AGENT_FIELDS,
      name: 'worker',
      runtime: OPENCODE_RUNTIME,
      plugins: [plugin.id],
    })
    expect(agent.plugins).toEqual([plugin.id])
  })

  test('create accepts a dependsOn closure', async () => {
    const auditor = await createAgent(db, { ...AGENT_FIELDS, name: 'auditor' })
    const agent = await createAgent(db, {
      ...AGENT_FIELDS,
      name: 'worker',
      runtime: OPENCODE_RUNTIME,
      dependsOn: [auditor.id],
    })
    expect(agent.dependsOn).toEqual([auditor.id])
  })

  test('update can ADD collaborators to an existing OpenCode agent', async () => {
    // The RFC-224 shape of this failure was especially hostile: an operator
    // could clear the field but never set it.
    const auditor = await createAgent(db, { ...AGENT_FIELDS, name: 'auditor' })
    const agent = await createAgent(db, {
      ...AGENT_FIELDS,
      name: 'worker',
      runtime: OPENCODE_RUNTIME,
    })
    const updated = await updateAgent(
      db,
      agent.id,
      { dependsOn: [auditor.id] },
      actor('owner'),
      undefined,
    )
    expect(updated.dependsOn).toEqual([auditor.id])
  })
})

describe('RFC-251 — launch surfaces accept the same agent', () => {
  async function agentWithBoth() {
    const auditor = await createAgent(db, { ...AGENT_FIELDS, name: 'auditor' })
    const plugin = await createPlugin(
      db,
      { name: 'formatter', spec: 'formatter@1' },
      { pluginsDir, npmBin: FAKE_NPM },
    )
    return createAgent(db, {
      ...AGENT_FIELDS,
      name: 'worker',
      runtime: OPENCODE_RUNTIME,
      dependsOn: [auditor.id],
      plugins: [plugin.id],
    })
  }

  test('the workflow launch gate passes', async () => {
    const agent = await agentWithBoth()
    const workflow = await workflowForAgent(agent, 'wf-restored')
    await expect(assertWorkflowLaunchable(db, actor('owner'), workflow.id)).resolves.toBeDefined()
  })

  test('scheduling that workflow is accepted', async () => {
    const owner = await createUser(db, {
      username: 'owner',
      displayName: 'Owner',
      role: 'admin',
      password: 'longEnoughPassword',
    })
    const agent = await agentWithBoth()
    const workflow = await workflowForAgent(agent, 'wf-scheduled')
    const schedule = await createScheduledTask(
      db,
      {
        name: 'scheduled-workflow',
        launchKind: 'workflow',
        launchPayload: { workflowId: workflow.id, name: 'run', inputs: {}, scratch: true },
        scheduleSpec: SPEC,
        enabled: true,
      },
      { actor: actor(owner.id) },
    )
    expect(schedule.id).toBeTruthy()
  })

  test('a missing model is accepted and delegated to the runtime CLI default', async () => {
    await createRuntime(db, { name: 'oc-no-model', protocol: 'opencode', model: null })
    const auditor = await createAgent(db, { ...AGENT_FIELDS, name: 'auditor' })
    const agent = await createAgent(db, {
      ...AGENT_FIELDS,
      name: 'worker-with-cli-default',
      runtime: 'oc-no-model',
      dependsOn: [auditor.id],
    })
    expect(agent.runtime).toBe('oc-no-model')
  })
})
