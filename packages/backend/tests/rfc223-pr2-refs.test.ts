// RFC-223 (PR-2) — workflow / workgroup / scheduled agent+workgroup references
// carried from NAMES to canonical IDS. Runtime-side locks (the migration itself
// is locked by migration-0112-rfc223-pr2.test.ts):
//
//   - extractWorkflowAgentRefs returns a node's canonical id (name fallback);
//   - PR-7 scheduled writes REQUIRE $.agentId / $.workgroupId, refresh display
//     names from that row, and delete guards find references BY ID;
//   - PR-7 workgroup writes REQUIRE each member's agent_id; the id survives a
//     rename (rename-safe), and launch readiness refuses a roster whose member
//     agent was deleted (validated by id);
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
import { createRuntime } from '../src/services/runtimeRegistry'
import { createScheduledTask } from '../src/services/scheduledTasks'
import { createWorkgroup, getWorkgroupById } from '../src/services/workgroups'
import { startWorkgroupTask } from '../src/services/workgroup/launch'
import { extractWorkflowAgentRefs, stripWorkflowNodeAgentIds } from '../src/services/resourceRefs'
import { createUser } from '../src/services/users'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SPEC = { kind: 'daily', at: '09:00', timezone: 'UTC' } as const
const VALID_OPENCODE_RUNTIME = 'rfc224-test-opencode'

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
  runtime: VALID_OPENCODE_RUNTIME,
}

async function seedValidOpencodeRuntime(db: DbClient): Promise<void> {
  await createRuntime(db, {
    name: VALID_OPENCODE_RUNTIME,
    protocol: 'opencode',
    model: 'openai/gpt-5.6',
  })
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
function groupInput(agentId: string, overrides: Partial<CreateWorkgroup> = {}): CreateWorkgroup {
  return CreateWorkgroupSchema.parse({
    name: 'squad',
    description: '',
    instructions: '',
    mode: 'free_collab',
    members: [{ memberType: 'agent', agentId, displayName: 'a1', roleDesc: '' }],
    ...overrides,
  })
}

// --------------------------------------------------------------------------
describe('RFC-223 PR-8 — extractWorkflowAgentRefs is canonical-id only', () => {
  test('id is retained; name-only and legacy keys fail closed; non-agent skipped', () => {
    const refs = extractWorkflowAgentRefs({
      nodes: [
        { kind: 'agent-single', agentId: 'ID_A', agentName: 'a' },
        { kind: 'agent-single', agentName: 'b' },
        { kind: 'agent-single', agent: 'c' },
        { kind: 'input', inputKey: 'req' }, // skipped
      ],
    })
    expect([...refs]).toEqual(['ID_A'])
  })
})

// --------------------------------------------------------------------------
describe('RFC-223 PR-7 — scheduled payload writes + guards by id', () => {
  let db: DbClient
  let ownerId: string
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedValidOpencodeRuntime(db)
    ownerId = await seedOwner(db)
  })

  const storedPayload = async (id: string) =>
    JSON.parse(
      (await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)))[0]!.launchPayload,
    )

  test('agent schedule requires $.agentId and refreshes the display name from that row', async () => {
    const agent = await createAgent(db, { ...AGENT_FIELDS, name: 'solo' })
    const created = await createScheduledTask(
      db,
      {
        name: 'nightly',
        launchKind: 'agent',
        launchPayload: {
          agentId: agent.id,
          agentName: 'untrusted-stale-name',
          name: 't',
          description: 'd',
          scratch: true,
        },
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
    const a1 = await createAgent(db, { ...AGENT_FIELDS, name: 'a1' })
    const group = await createWorkgroup(db, groupInput(a1.id))
    const created = await createScheduledTask(
      db,
      {
        name: 'nightly',
        launchKind: 'workgroup',
        launchPayload: {
          workgroupId: group.id,
          workgroupName: 'untrusted-stale-name',
          name: 't',
          goal: 'g',
          scratch: true,
        },
        scheduleSpec: SPEC,
        enabled: true,
      },
      { actor: actor(ownerId) },
    )
    const p = await storedPayload(created.id)
    expect(p.workgroupId).toBe(group.id)
    expect(p.workgroupName).toBe('squad')
  })

  test('rename is id-stable while delete refuses a scheduled reference found BY ID', async () => {
    const agent = await createAgent(db, { ...AGENT_FIELDS, name: 'solo' })
    await createScheduledTask(
      db,
      {
        name: 'nightly',
        launchKind: 'agent',
        launchPayload: { agentId: agent.id, name: 't', description: 'd', scratch: true },
        scheduleSpec: SPEC,
        enabled: true,
      },
      { actor: actor(ownerId) },
    )
    // The stored payload carries agentId — the guard matches it even though the
    // guard is handed the agent's id, not its name.
    expect(agent.id).toBeTruthy()
    await expect(deleteAgent(db, agent.id, actor(ownerId))).rejects.toMatchObject({
      code: 'agent-scheduled-referenced',
    })
    expect(await renameAgent(db, agent.id, { newName: 'solo2' })).toMatchObject({
      id: agent.id,
      name: 'solo2',
    })
  })
})

// --------------------------------------------------------------------------
describe('RFC-223 PR-7 — workgroup member writes and launch target use canonical ids', () => {
  let db: DbClient
  let appHome: string
  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await seedValidOpencodeRuntime(db)
    appHome = mkdtempSync(join(tmpdir(), 'aw-rfc223pr2-'))
    process.env.AGENT_WORKFLOW_HOME = appHome
    writeFileSync(join(appHome, 'config.json'), JSON.stringify({ $schema_version: 1 }))
    await seedOwner(db)
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  const memberOf = async (groupId: string, displayName: string) => {
    const g = (await getWorkgroupById(db, groupId))!
    return g.members.find((m) => m.displayName === displayName)!
  }

  test('createWorkgroup requires and stores each agent member’s canonical agent_id', async () => {
    const a1 = await createAgent(db, { ...AGENT_FIELDS, name: 'a1' })
    expect(
      CreateWorkgroupSchema.safeParse({
        ...groupInput(a1.id),
        members: [{ memberType: 'agent', agentName: 'a1', displayName: 'a1', roleDesc: '' }],
      }).success,
    ).toBe(false)
    const group = await createWorkgroup(db, groupInput(a1.id))
    expect((await memberOf(group.id, 'a1')).agentId).toBe(a1.id)
  })

  test('a member’s frozen agent_id survives a rename of its agent (rename-safe)', async () => {
    const a1 = await createAgent(db, { ...AGENT_FIELDS, name: 'a1' })
    const group = await createWorkgroup(db, groupInput(a1.id))
    // Renaming an agent that is only a workgroup member is allowed (no guard).
    await renameAgent(db, a1.id, { newName: 'a1-renamed' })
    const m = await memberOf(group.id, 'a1')
    // The member still points at the SAME id, and that id still exists — so
    // launch readiness (which validates the roster by id) still passes.
    expect(m.agentId).toBe(a1.id)
    expect(await getAgentById(db, a1.id)).not.toBeNull()
  })

  test('workgroup launch accepts only the canonical id, never an existing name', async () => {
    const a1 = await createAgent(db, { ...AGENT_FIELDS, name: 'a1' })
    const group = await createWorkgroup(db, groupInput(a1.id))
    await expect(
      startWorkgroupTask(
        db,
        actor('u1'),
        group.name,
        { name: 'e2e', goal: 'g', scratch: true },
        { db, appHome, opencodeCmd: ['bun', '-e', 'process.exit(0)'], awaitScheduler: true },
      ),
    ).rejects.toMatchObject({ code: 'workgroup-not-found' })
  })

  test('launch refuses (workgroup-not-ready / agent-missing) when a member agent was deleted', async () => {
    const a1 = await createAgent(db, { ...AGENT_FIELDS, name: 'a1' })
    const group = await createWorkgroup(db, groupInput(a1.id))
    // Deleting an agent that is only a workgroup member is allowed (soft ref).
    await deleteAgent(db, a1.id, actor('u1'))
    // Its frozen id no longer resolves → readiness fails BEFORE any spawn.
    await expect(
      startWorkgroupTask(
        db,
        actor('u1'),
        group.id,
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

  test('ordinary persisted ref extraction rejects a portable name-only node', () => {
    expect([...extractWorkflowAgentRefs(def())]).toEqual([])
  })
})

// --------------------------------------------------------------------------
describe('RFC-223 PR-2 — scheduler dispatches the node agent by id (source lock)', () => {
  // The runtime giant (runOneNode) is exercised end-to-end by the workgroup /
  // workflow e2e suites; this pins the id-first resolution so a refactor can’t
  // silently drop back to name-only dispatch (PR-1 left node→agent by name).
  test('agent-single + wrapper-fanout hydrate only via canonical agentId', () => {
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    expect(src).toContain('const nodeAgent = await getAgentById(db, agentIdRef)')
    expect(src).toContain('const a = aid !== null ? await getAgentById(db, aid) : null')
    expect(src).not.toContain('await getAgent(db, agentName)')
    // RFC-223 (PR-3a impl-gate H2): dedup + key the inner-agent map by the
    // CANONICAL identity (agentId when stamped), NOT the mutable name — so two
    // same-name different-id inner nodes never collapse onto one agent.
    expect(src).toContain('const dedupKey = fanoutInnerAgentKey(rec)')
  })
})
