// RFC-223 (PR-1) — Codex implementation-gate regressions.
//
// Locks the four findings fixed after the PR-1 impl gate:
//   P1-1  a MISSING managed skill is never silently demoted to a repo-local
//         `project` ref (that would change execution semantics); it stays an
//         UNRESOLVED managed ref, and only a resolvable name / real id becomes a
//         canonical managed id. `project` refs pass through untouched.
//   P1-2  reference ACL is bound to the FINAL resolved id in a SINGLE pass (no
//         check-then-resolve TOCTOU); the update "new refs" diff compares
//         RESOLVED IDS, so a grandfathered ref re-submitted by name is not
//         mis-flagged as new and rejected.
//   P2-1  the closure endpoint projects stored id refs (managed skill / mcp /
//         plugin) to display NAMES — never raw ULIDs in the UI.
//   P2-2  an ACL refusal echoes the caller's INPUT token, never a private
//         resource's resolved name (no name/existence oracle); the closure
//         endpoint likewise never discloses an invisible dependency's name.

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, mcps, plugins, skills } from '../src/db/schema'
import { createApp } from '../src/server'
import { createMcp } from '../src/services/mcp'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  alice: { id: string; token: string }
  bob: { id: string; token: string }
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-rfc223-pr1-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  async function mkUser(username: string) {
    const u = await createUser(db, {
      username,
      displayName: username,
      role: 'user',
      password: 'longEnoughPassword',
    })
    const { token } = await createSession({ db, userId: u.id })
    return { id: u.id, token }
  }
  return { db, app, alice: await mkUser('alice'), bob: await mkUser('bob') }
}

async function req(
  app: Hono,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

const AGENT_BODY = {
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

/** Insert a minimal managed skill row (id + name) owned by `ownerUserId`. */
async function seedSkill(
  db: DbClient,
  id: string,
  name: string,
  visibility: 'public' | 'private',
  ownerUserId: string,
): Promise<void> {
  await db.insert(skills).values({ id, name, sourceKind: 'managed', visibility, ownerUserId })
}

/** Insert a minimal enabled plugin row (id + name) owned by `ownerUserId`. */
async function seedPlugin(
  db: DbClient,
  id: string,
  name: string,
  ownerUserId: string,
): Promise<void> {
  await db.insert(plugins).values({
    id,
    name,
    spec: `${name}@1`,
    sourceKind: 'npm',
    cachedPath: `/tmp/${name}`,
    installedAt: 1,
    enabled: true,
    visibility: 'public',
    ownerUserId,
  })
}

interface AgentDto {
  id: string
  name: string
  skills: Array<{ kind: 'managed'; skillId: string } | { kind: 'project'; name: string }>
  mcp: string[]
  plugins: string[]
  dependsOn: string[]
}

async function createAgentHttp(
  h: Harness,
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return req(h.app, token, '/api/agents', {
    method: 'POST',
    body: JSON.stringify({ ...AGENT_BODY, ...body }),
  })
}

describe('RFC-223 PR-1 P1-1 — missing managed skill is never demoted to project', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  test('an unresolvable managed skill token stays an UNRESOLVED managed ref (not project)', async () => {
    const res = await createAgentHttp(h, h.alice.token, {
      name: 'a1',
      skills: [{ kind: 'managed', skillId: 'ghost-skill' }],
    })
    expect(res.status).toBe(201)
    const a = (await res.json()) as AgentDto
    // Kept as managed with the raw token — NOT { kind:'project', name:'ghost-skill' }.
    expect(a.skills).toEqual([{ kind: 'managed', skillId: 'ghost-skill' }])
  })

  test('a managed skill referenced by NAME resolves to its canonical id', async () => {
    await seedSkill(h.db, 'SKILL_REAL_ID', 'lint', 'public', h.alice.id)
    const res = await createAgentHttp(h, h.alice.token, {
      name: 'a2',
      skills: [{ kind: 'managed', skillId: 'lint' }],
    })
    expect(res.status).toBe(201)
    const a = (await res.json()) as AgentDto
    expect(a.skills).toEqual([{ kind: 'managed', skillId: 'SKILL_REAL_ID' }])
  })

  test('a project ref passes through untouched (RFC-178 repo-local skill)', async () => {
    const res = await createAgentHttp(h, h.alice.token, {
      name: 'a3',
      skills: [{ kind: 'project', name: 'repo-local' }],
    })
    expect(res.status).toBe(201)
    const a = (await res.json()) as AgentDto
    expect(a.skills).toEqual([{ kind: 'project', name: 'repo-local' }])
  })
})

describe('RFC-223 PR-1 P1-2 — ACL bound to resolved id, grandfathering by id', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  test('referencing a private resource (invisible) → 422 acl-missing-refs, id NEVER persisted', async () => {
    const m = await createMcp(
      h.db,
      {
        name: 'secret-mcp',
        description: '',
        type: 'local',
        config: { command: ['x'] },
        enabled: true,
      },
      { ownerUserId: h.alice.id },
    )
    await h.db.update(mcps).set({ visibility: 'private' }).where(eq(mcps.id, m.id))
    const res = await createAgentHttp(h, h.bob.token, { name: 'wrapper', mcp: [m.name] })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('acl-missing-refs')
    // and nothing was persisted
    const fetched = await req(h.app, h.bob.token, '/api/agents/wrapper')
    expect(fetched.status).toBe(404)
  })

  test('a grandfathered ref re-submitted BY NAME after it turns private is NOT mis-flagged as new (diff by resolved id)', async () => {
    // alice owns a PUBLIC agent `dep`; bob depends on it (stored by id).
    const depRes = await createAgentHttp(h, h.alice.token, { name: 'dep' })
    expect(depRes.status).toBe(201)
    const dep = (await depRes.json()) as AgentDto
    const aRes = await createAgentHttp(h, h.bob.token, { name: 'consumer', dependsOn: ['dep'] })
    expect(aRes.status).toBe(201)
    const consumer = (await aRes.json()) as AgentDto
    expect(consumer.dependsOn).toEqual([dep.id])

    // alice makes `dep` private — bob can no longer view it, but it is grandfathered.
    await h.db.update(agents).set({ visibility: 'private' }).where(eq(agents.id, dep.id))
    expect((await req(h.app, h.bob.token, `/api/agents/${dep.id}`)).status).toBe(404)

    // bob re-saves consumer submitting the dep BY NAME (agent.md style). The diff
    // compares resolved id (dep.id ∈ existing) → grandfathered → save succeeds.
    const put = await req(h.app, h.bob.token, `/api/agents/${consumer.id}`, {
      method: 'PUT',
      body: JSON.stringify({ dependsOn: ['dep'] }),
    })
    expect(put.status).toBe(200)
    expect(((await put.json()) as AgentDto).dependsOn).toEqual([dep.id])
  })

  test('adding a genuinely NEW invisible ref on update is still rejected', async () => {
    const m = await createMcp(
      h.db,
      {
        name: 'other-secret',
        description: '',
        type: 'local',
        config: { command: ['x'] },
        enabled: true,
      },
      { ownerUserId: h.alice.id },
    )
    await h.db.update(mcps).set({ visibility: 'private' }).where(eq(mcps.id, m.id))
    const aRes = await createAgentHttp(h, h.bob.token, { name: 'c2' })
    expect(aRes.status).toBe(201)
    const agent = (await aRes.json()) as AgentDto
    const put = await req(h.app, h.bob.token, `/api/agents/${agent.id}`, {
      method: 'PUT',
      body: JSON.stringify({ mcp: [m.id] }),
    })
    expect(put.status).toBe(422)
    expect(((await put.json()) as { code: string }).code).toBe('acl-missing-refs')
  })
})

describe('RFC-223 PR-1 P2-2 — ACL refusal echoes the INPUT token, never a private name', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  test('referencing a private mcp BY ID echoes the id, never leaks its name', async () => {
    const m = await createMcp(
      h.db,
      {
        name: 'top-secret-name',
        description: '',
        type: 'local',
        config: { command: ['x'] },
        enabled: true,
      },
      { ownerUserId: h.alice.id },
    )
    await h.db.update(mcps).set({ visibility: 'private' }).where(eq(mcps.id, m.id))
    const res = await createAgentHttp(h, h.bob.token, { name: 'leaker', mcp: [m.id] })
    expect(res.status).toBe(422)
    const body = (await res.json()) as {
      code: string
      message: string
      details?: { missing?: Array<{ type: string; name: string }> }
    }
    expect(body.code).toBe('acl-missing-refs')
    // Echoes the id the caller supplied — NOT the private mcp's name.
    expect(body.details?.missing).toEqual([{ type: 'mcp', name: m.id }])
    expect(body.message).not.toContain('top-secret-name')
  })

  test('referencing a private mcp BY NAME echoes the name the caller typed', async () => {
    const m = await createMcp(
      h.db,
      {
        name: 'typed-secret',
        description: '',
        type: 'local',
        config: { command: ['x'] },
        enabled: true,
      },
      { ownerUserId: h.alice.id },
    )
    await h.db.update(mcps).set({ visibility: 'private' }).where(eq(mcps.id, m.id))
    const res = await createAgentHttp(h, h.bob.token, { name: 'leaker2', mcp: ['typed-secret'] })
    expect(res.status).toBe(422)
    const body = (await res.json()) as {
      details?: { missing?: Array<{ type: string; name: string }> }
    }
    expect(body.details?.missing).toEqual([{ type: 'mcp', name: 'typed-secret' }])
  })
})

describe('RFC-223 PR-1 P2-1 — closure endpoint projects id refs to display NAMES', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  test('managed skill / mcp / plugin ids render as NAMES, not ULIDs', async () => {
    await seedSkill(h.db, 'SKID', 'code-review', 'public', h.alice.id)
    const m = await createMcp(
      h.db,
      {
        name: 'git-mcp',
        description: '',
        type: 'local',
        config: { command: ['x'] },
        enabled: true,
      },
      { ownerUserId: h.alice.id },
    )
    await seedPlugin(h.db, 'PLID', 'fmt-plugin', h.alice.id)

    const res = await createAgentHttp(h, h.alice.token, {
      name: 'leaf',
      skills: [{ kind: 'managed', skillId: 'SKID' }],
      mcp: [m.id],
      plugins: ['PLID'],
    })
    expect(res.status).toBe(201)
    const agent = (await res.json()) as AgentDto

    const closure = await req(h.app, h.alice.token, `/api/agents/${agent.id}/closure`)
    expect(closure.status).toBe(200)
    const body = (await closure.json()) as {
      ok: boolean
      agents: Array<{ name: string; skills: string[]; mcp: string[]; plugins: string[] }>
    }
    const leaf = body.agents.find((a) => a.name === 'leaf')!
    expect(leaf.skills).toEqual(['code-review'])
    expect(leaf.mcp).toEqual(['git-mcp'])
    expect(leaf.plugins).toEqual(['fmt-plugin'])
    // Explicitly assert no raw ULIDs leaked into the UI projection.
    expect(leaf.skills).not.toContain('SKID')
    expect(leaf.mcp).not.toContain(m.id)
    expect(leaf.plugins).not.toContain('PLID')
  })
})

describe('RFC-223 PR-1 P2-2 — closure never discloses an invisible dependency name', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  test('a private dependency is masked to its opaque id, its name never appears', async () => {
    // alice owns a PUBLIC agent `hidden-dep`; bob depends on it, then alice hides it.
    const depRes = await createAgentHttp(h, h.alice.token, { name: 'hidden-dep' })
    const dep = (await depRes.json()) as AgentDto
    const parentRes = await createAgentHttp(h, h.bob.token, {
      name: 'parent',
      dependsOn: ['hidden-dep'],
    })
    expect(parentRes.status).toBe(201)
    const parentAgent = (await parentRes.json()) as AgentDto
    await h.db.update(agents).set({ visibility: 'private' }).where(eq(agents.id, dep.id))

    const closure = await req(h.app, h.bob.token, `/api/agents/${parentAgent.id}/closure`)
    expect(closure.status).toBe(200)
    const raw = await closure.text()
    // The private dependency's human name must not appear anywhere in the payload.
    expect(raw).not.toContain('hidden-dep')
    const body = JSON.parse(raw) as {
      agents: Array<{
        id: string
        name: string
        ownerUserId: string | null
        dependsOnIds: string[]
        description: string
        masked: boolean
        missing: boolean
      }>
    }
    // The masked member is identified by its opaque id (no human name, blanked fields).
    const masked = body.agents.find((a) => a.name === dep.id)
    expect(masked).toBeDefined()
    expect(masked?.id).toBe(dep.id)
    expect(masked?.ownerUserId).toBeNull()
    expect(masked?.description).toBe('')
    expect(masked?.masked).toBe(true)
    expect(masked?.missing).toBe(false)
    // The parent's dependsOn projection references the opaque id, not a name.
    const parent = body.agents.find((a) => a.name === 'parent')!
    expect(parent.dependsOnIds).toEqual([dep.id])
  })
})

describe('RFC-223 PR-1 P1-2 — workgroup members share the same single-pass binding (PR-2 parity)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  test('a workgroup member referencing a private agent → 422 acl-missing-refs (id NOT persisted)', async () => {
    const depRes = await createAgentHttp(h, h.alice.token, { name: 'wg-secret' })
    const dep = (await depRes.json()) as AgentDto
    await h.db.update(agents).set({ visibility: 'private' }).where(eq(agents.id, dep.id))
    const res = await req(h.app, h.bob.token, '/api/workgroups', {
      method: 'POST',
      body: JSON.stringify({
        name: 'wg1',
        mode: 'free_collab',
        members: [{ memberType: 'agent', agentId: dep.id, displayName: 'x' }],
      }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('acl-missing-refs')
    expect((await req(h.app, h.bob.token, '/api/workgroups/wg1')).status).toBe(404)
  })

  test('a public agent member is stored by resolved id', async () => {
    const depRes = await createAgentHttp(h, h.alice.token, { name: 'wg-public' })
    const dep = (await depRes.json()) as AgentDto
    const res = await req(h.app, h.bob.token, '/api/workgroups', {
      method: 'POST',
      body: JSON.stringify({
        name: 'wg2',
        mode: 'free_collab',
        members: [{ memberType: 'agent', agentId: dep.id, displayName: 'x' }],
      }),
    })
    expect(res.status).toBe(201)
    const wg = (await res.json()) as { members: Array<{ agentId: string | null }> }
    expect(wg.members[0]?.agentId).toBe(dep.id)
  })
})

describe('RFC-223 PR-1 P1-2 — single-pass resolution (source guard)', () => {
  test('the agents + workgroups routes no longer ACL-check refs SEPARATELY from resolution', () => {
    const read = (rel: string): string =>
      readFileSync(resolve(import.meta.dir, '..', 'src', rel), 'utf8')
    // The old two-step shape (route assertNewRefsUsable → service re-resolves)
    // is the TOCTOU; create/update now resolve+check in ONE pass inside the
    // service, so these routes must not call assertNewRefsUsable at all.
    expect(read('routes/agents.ts')).not.toContain('assertNewRefsUsable')
    expect(read('routes/workgroups.ts')).not.toContain('assertNewRefsUsable')
  })
})
