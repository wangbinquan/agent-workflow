// RFC-223 (PR-2) — workflow / workgroup / scheduled agent+workgroup references
// carried from NAMES to canonical IDS. Runtime-side locks (the migration itself
// is locked by migration-0112-rfc223-pr2.test.ts):
//
//   - extractWorkflowAgentRefs returns a node's canonical id (name fallback);
//   - createScheduledTask STAMPS $.agentId / $.workgroupId into the stored
//     payload, and the delete/rename guards find that reference BY ID;
//   - createWorkgroup resolves each agent member's agent_id (dangling → null),
//     the id survives a rename (rename-safe), and launch readiness refuses a
//     roster whose member agent was deleted (validated by id);
//   - the portable YAML selector helpers (strip on export / resolve on import);
//   - a source-level lock on the scheduler dispatching by getAgentById.
//
// If this reds, PR-2's id-canonicalization of the non-agent references broke.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  CreateWorkgroupSchema,
  type CreateWorkgroup,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { scheduledTasks } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { createAgent, deleteAgent, getAgentById, renameAgent } from '../src/services/agent'
import { createScheduledTask } from '../src/services/scheduledTasks'
import { createWorkgroup, getWorkgroup } from '../src/services/workgroups'
import { startWorkgroupTask } from '../src/services/workgroup/launch'
import {
  extractWorkflowAgentRefs,
  resolveWorkflowNodeAgentIds,
  stripWorkflowNodeAgentIds,
} from '../src/services/resourceRefs'
import { createUser } from '../src/services/users'

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
  bodyMd: 'do it',
}

function actor(id: string): Actor {
  return buildActor({
    user: { id, username: `u-${id.slice(-4)}`, displayName: 'U', role: 'admin', status: 'active' },
    source: 'daemon',
  })
}
async function seedOwner(db: DbClient): Promise<string> {
  const u = await createUser(db, {
    username: 'alice',
    displayName: 'alice',
    role: 'admin',
    password: 'longEnoughPassword',
  })
  return u.id
}
function groupInput(overrides: Partial<CreateWorkgroup> = {}): CreateWorkgroup {
  return CreateWorkgroupSchema.parse({
    name: 'squad',
    description: '',
    instructions: '',
    mode: 'free_collab',
    members: [{ memberType: 'agent', agentName: 'a1', displayName: 'a1', roleDesc: '' }],
    ...overrides,
  })
}

// --------------------------------------------------------------------------
describe('RFC-223 PR-2 — extractWorkflowAgentRefs prefers the canonical id', () => {
  test('id preferred; agentName fallback; legacy `agent` key; non-agent skipped', () => {
    const refs = extractWorkflowAgentRefs({
      nodes: [
        { kind: 'agent-single', agentId: 'ID_A', agentName: 'a' },
        { kind: 'agent-single', agentName: 'b' }, // no id → name fallback
        { kind: 'agent-single', agent: 'c' }, // even-older key
        { kind: 'input', inputKey: 'req' }, // skipped
      ],
    })
    expect([...refs].sort()).toEqual(['ID_A', 'b', 'c'])
  })
})

// --------------------------------------------------------------------------
describe('RFC-223 PR-2 — scheduled payload stamps + guards by id', () => {
  let db: DbClient
  let ownerId: string
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    ownerId = await seedOwner(db)
  })

  const storedPayload = async (id: string) =>
    JSON.parse(
      (await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)))[0]!.launchPayload,
    )

  test('agent schedule stamps $.agentId (server-derived; client sends only the name)', async () => {
    const agent = await createAgent(db, { ...AGENT_FIELDS, name: 'solo' })
    const created = await createScheduledTask(
      db,
      {
        name: 'nightly',
        launchKind: 'agent',
        launchPayload: { agentName: 'solo', name: 't', description: 'd', scratch: true },
        scheduleSpec: SPEC,
        enabled: true,
      },
      { actor: actor(ownerId) },
    )
    const p = await storedPayload(created.id)
    expect(p.agentId).toBe(agent.id)
    expect(p.agentName).toBe('solo') // display kept
  })

  test('workgroup schedule stamps $.workgroupId', async () => {
    await createAgent(db, { ...AGENT_FIELDS, name: 'a1' })
    const group = await createWorkgroup(db, groupInput())
    const created = await createScheduledTask(
      db,
      {
        name: 'nightly',
        launchKind: 'workgroup',
        launchPayload: { workgroupName: 'squad', name: 't', goal: 'g', scratch: true },
        scheduleSpec: SPEC,
        enabled: true,
      },
      { actor: actor(ownerId) },
    )
    const p = await storedPayload(created.id)
    expect(p.workgroupId).toBe(group.id)
  })

  test('deleteAgent / renameAgent refuse while a scheduled task references the agent (found BY ID)', async () => {
    const agent = await createAgent(db, { ...AGENT_FIELDS, name: 'solo' })
    await createScheduledTask(
      db,
      {
        name: 'nightly',
        launchKind: 'agent',
        launchPayload: { agentName: 'solo', name: 't', description: 'd', scratch: true },
        scheduleSpec: SPEC,
        enabled: true,
      },
      { actor: actor(ownerId) },
    )
    // The stored payload carries agentId — the guard matches it even though the
    // guard is handed the agent's id, not its name.
    expect(agent.id).toBeTruthy()
    await expect(deleteAgent(db, 'solo', actor(ownerId))).rejects.toMatchObject({
      code: 'agent-scheduled-referenced',
    })
    await expect(
      renameAgent(db, 'solo', { newName: 'solo2' }, actor(ownerId)),
    ).rejects.toMatchObject({ code: 'agent-scheduled-referenced' })
  })
})

// --------------------------------------------------------------------------
describe('RFC-223 PR-2 — workgroup member agent_id', () => {
  let db: DbClient
  let appHome: string
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc223pr2-'))
    process.env.AGENT_WORKFLOW_HOME = appHome
    writeFileSync(join(appHome, 'config.json'), JSON.stringify({ $schema_version: 1 }))
    await seedOwner(db)
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  const memberOf = async (groupName: string, displayName: string) => {
    const g = (await getWorkgroup(db, groupName))!
    return g.members.find((m) => m.displayName === displayName)!
  }

  test('createWorkgroup resolves each agent member’s agent_id; a dangling member stays null', async () => {
    const a1 = await createAgent(db, { ...AGENT_FIELDS, name: 'a1' })
    await createWorkgroup(
      db,
      groupInput({
        members: [
          { memberType: 'agent', agentName: 'a1', displayName: 'a1', roleDesc: '' },
          { memberType: 'agent', agentName: 'ghost', displayName: 'ghost', roleDesc: '' },
        ],
      }),
    )
    expect((await memberOf('squad', 'a1')).agentId).toBe(a1.id)
    expect((await memberOf('squad', 'ghost')).agentId).toBeNull()
  })

  test('a member’s frozen agent_id survives a rename of its agent (rename-safe)', async () => {
    const a1 = await createAgent(db, { ...AGENT_FIELDS, name: 'a1' })
    await createWorkgroup(db, groupInput())
    // Renaming an agent that is only a workgroup member is allowed (no guard).
    await renameAgent(db, 'a1', { newName: 'a1-renamed' }, actor('u1'))
    const m = await memberOf('squad', 'a1')
    // The member still points at the SAME id, and that id still exists — so
    // launch readiness (which validates the roster by id) still passes.
    expect(m.agentId).toBe(a1.id)
    expect(await getAgentById(db, a1.id)).not.toBeNull()
  })

  test('launch refuses (workgroup-not-ready / agent-missing) when a member agent was deleted', async () => {
    await createAgent(db, { ...AGENT_FIELDS, name: 'a1' })
    await createWorkgroup(db, groupInput())
    // Deleting an agent that is only a workgroup member is allowed (soft ref).
    await deleteAgent(db, 'a1', actor('u1'))
    // Its frozen id no longer resolves → readiness fails BEFORE any spawn.
    await expect(
      startWorkgroupTask(
        db,
        actor('u1'),
        'squad',
        { name: 'e2e', goal: 'g', scratch: true },
        { db, appHome, opencodeCmd: ['bun', '-e', 'process.exit(0)'], awaitScheduler: true },
      ),
    ).rejects.toMatchObject({ code: 'workgroup-not-ready' })
  })
})

// --------------------------------------------------------------------------
describe('RFC-223 PR-2 — portable YAML selector helpers', () => {
  const def = (extra: Record<string, unknown> = {}): WorkflowDefinition => ({
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'n1', kind: 'agent-single', agentName: 'a1', ...extra },
      { id: 'in1', kind: 'input', inputKey: 'req' },
    ],
    edges: [],
  })

  test('stripWorkflowNodeAgentIds removes internal agentId from agent-single nodes only', () => {
    const stripped = stripWorkflowNodeAgentIds(def({ agentId: 'FOREIGN_ID' }))
    const n1 = stripped.nodes.find((n) => n.id === 'n1') as Record<string, unknown>
    const in1 = stripped.nodes.find((n) => n.id === 'in1') as Record<string, unknown>
    expect(n1.agentId).toBeUndefined()
    expect(n1.agentName).toBe('a1') // portable name kept
    expect(in1.inputKey).toBe('req') // non-agent node untouched
  })

  test('resolveWorkflowNodeAgentIds stamps the LOCAL id from the name, discarding a foreign id', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const a1 = await createAgent(db, { ...AGENT_FIELDS, name: 'a1' })
    // Incoming node carries a foreign id — it must be replaced by the local one.
    const resolved = await resolveWorkflowNodeAgentIds(db, def({ agentId: 'FOREIGN_ID' }))
    const n1 = resolved.nodes.find((n) => n.id === 'n1') as Record<string, unknown>
    expect(n1.agentId).toBe(a1.id)
  })

  test('resolveWorkflowNodeAgentIds leaves a node id-less when its name resolves to no local agent', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const resolved = await resolveWorkflowNodeAgentIds(db, def())
    const n1 = resolved.nodes.find((n) => n.id === 'n1') as Record<string, unknown>
    expect(n1.agentId).toBeUndefined()
  })
})

// --------------------------------------------------------------------------
describe('RFC-223 PR-2 — scheduler dispatches the node agent by id (source lock)', () => {
  // The runtime giant (runOneNode) is exercised end-to-end by the workgroup /
  // workflow e2e suites; this pins the id-first resolution so a refactor can’t
  // silently drop back to name-only dispatch (PR-1 left node→agent by name).
  test('agent-single + wrapper-fanout hydrate via getAgentById when the node carries an agentId', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    // main dispatch: id-first, name fallback.
    expect(src).toContain(
      'agentIdRef !== null ? await getAgentById(db, agentIdRef) : await getAgent(db, agentName)',
    )
    // fanout inner hydration resolves each inner agent the same way.
    expect(src).toContain('aid !== null ? await getAgentById(db, aid) : await getAgent(db, an)')
  })
})
