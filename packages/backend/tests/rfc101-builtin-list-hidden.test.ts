// Regression lock for the RFC-101 built-in-resource list leak that turned the
// `visual-regression-nightly` red on 2026-06-23 (3 pages: /agents, /workflows,
// homepage). Root cause: `seedFusionResources` persists the built-in fusion
// agent (`aw-skill-merger`) + workflow (`aw-skill-fusion`) as real DB rows (the
// task runner needs them resolvable by id). They then surfaced in
// GET /api/agents + /api/workflows — flipping those lists from the empty state
// to one row each, and flipping the homepage out of the first-run onboarding
// card (`computeIsFirstRun` keys off those two lists being empty).
//
// Every OTHER system agent (RFC-075 commit agent, RFC-050 memory distiller) is
// synthetic and never a DB row, so the lists were always empty on a fresh
// daemon. The fix (systemResources.excludeBuiltin*) restores that invariant for
// the persisted built-ins.
//
// RFC-104 update: the discriminator is now the immutable `builtin` COLUMN (set
// only by seedFusionResources), NOT the old "reserved NAME *and* __system__
// owner" heuristic. The integration tests still use the daemon `__system__`
// ADMIN token (admins bypass `filterVisibleRows`, so the hide must come from
// `excludeBuiltin*`, not visibility). The pure test pins the column semantics:
//   1. A built-in stays hidden even if its OWNER is transferred away — the old
//      heuristic un-hid it the moment owner drifted (the RFC-104 footgun); the
//      column survives drift.
//   2. A daemon-token-created NORMAL agent (also `__system__`-owned but
//      builtin=false) stays visible — see the "stays visible" test.
//   3. A user who reuses the reserved name (builtin=false) stays visible —
//      `workflows.name` is non-unique and the framework owns only its builtin=1
//      row.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { SYSTEM_USER_ID } from '../src/auth/actor'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { seedTestDefaultOpencodeRuntime } from './helpers/executionRuntimeFixture'
import { listAgents } from '../src/services/agent'
import {
  SKILL_FUSION_WORKFLOW_NAME,
  SKILL_MERGER_AGENT_NAME,
  seedFusionResources,
} from '../src/services/fusion'
import { excludeBuiltinAgents, excludeBuiltinWorkflows } from '../src/services/systemResources'
import { listWorkflows } from '../src/services/workflow'
import { createApp } from '../src/server'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { Agent, Workflow } from '@agent-workflow/shared'

const TOKEN = 'a'.repeat(64) // 64-char hex → resolves to the __system__ admin actor
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function buildApp(): Promise<{ db: DbClient; app: Hono }> {
  const db = createInMemoryDb(MIGRATIONS)
  await seedTestDefaultOpencodeRuntime(db)
  const app = createApp({
    token: TOKEN,
    configPath: '/tmp/aw-rfc101-config-never-used.json',
    opencodeVersion: '1.15.0',
    dbVersion: 1,
    db,
  })
  return { db, app }
}

async function api(app: Hono, path: string, init?: RequestInit): Promise<Response> {
  return app.request(path, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(init?.headers ?? {}) },
  })
}

// Mirrors the proven-valid create payload from agents.test.ts (returns 201).
function samplePayload(name: string): Record<string, unknown> {
  return {
    name,
    description: 'sample',
    outputs: ['out1', 'out2'],
    syncOutputsOnIterate: true,
    model: 'anthropic/claude-opus-4-7',
    permission: { edit: 'deny' },
    // RFC-223 (PR-1): typed skill ref (no managed row named s1 → project skill).
    skills: [{ kind: 'project', name: 's1' }],
    dependsOn: [],
    mcp: [],
    plugins: [],
    bodyMd: '# hello',
  }
}

describe('RFC-101 built-in fusion resources are hidden from user-facing lists', () => {
  beforeEach(() => resetBroadcastersForTests())
  afterEach(() => resetBroadcastersForTests())

  test('GET /api/agents (as daemon/admin) excludes the system-owned aw-skill-merger', async () => {
    const { db, app } = await buildApp()
    await seedFusionResources(db)

    // Sanity: the row really is seeded, system-owned, and still resolvable at
    // the service layer (the fusion engine resolves it by name there).
    const merger = (await listAgents(db)).find((a) => a.name === SKILL_MERGER_AGENT_NAME)
    expect(merger).toBeDefined()
    expect(merger?.ownerUserId).toBe(SYSTEM_USER_ID)

    const res = await api(app, '/api/agents')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Agent[]
    expect(body.some((a) => a.name === SKILL_MERGER_AGENT_NAME)).toBe(false)
  })

  test('GET /api/workflows (as daemon/admin) excludes the system-owned aw-skill-fusion', async () => {
    const { db, app } = await buildApp()
    await seedFusionResources(db)

    const fusion = (await listWorkflows(db)).find((w) => w.name === SKILL_FUSION_WORKFLOW_NAME)
    expect(fusion).toBeDefined()
    expect(fusion?.ownerUserId).toBe(SYSTEM_USER_ID)

    const res = await api(app, '/api/workflows')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Workflow[]
    expect(body.some((w) => w.name === SKILL_FUSION_WORKFLOW_NAME)).toBe(false)
  })

  test('a normal agent created THROUGH the daemon token (also __system__-owned) stays visible', async () => {
    // The exact failure of the first owner-only attempt: this agent's owner is
    // __system__ (the daemon token's identity), yet its name is not reserved, so
    // it is NOT a built-in and must remain in the list. The name+owner
    // conjunction keeps it; the owner-only filter wrongly dropped it.
    const { db, app } = await buildApp()
    await seedFusionResources(db)
    const created = await api(app, '/api/agents', {
      method: 'POST',
      body: JSON.stringify(samplePayload('my-coder')),
    })
    expect(created.status).toBe(201)
    expect((await listAgents(db)).find((a) => a.name === 'my-coder')?.ownerUserId).toBe(
      SYSTEM_USER_ID,
    )

    const body = (await (await api(app, '/api/agents')).json()) as Agent[]
    expect(body.some((a) => a.name === 'my-coder')).toBe(true)
    expect(body.some((a) => a.name === SKILL_MERGER_AGENT_NAME)).toBe(false)
  })

  test('excludeBuiltin* drop a row iff its `builtin` column is set — drift-proof (pure)', () => {
    // RFC-104: the column is the discriminator. Owner/name are irrelevant to the
    // hide — a built-in whose owner DRIFTED is still hidden (the footgun), and a
    // user row reusing the reserved name (builtin=false) is always kept.
    const agentRows = [
      { name: SKILL_MERGER_AGENT_NAME, ownerUserId: SYSTEM_USER_ID, builtin: true }, // built-in → drop
      { name: SKILL_MERGER_AGENT_NAME, ownerUserId: 'user_real', builtin: true }, // built-in, owner DRIFTED → still drop
      { name: 'my-coder', ownerUserId: SYSTEM_USER_ID, builtin: false }, // daemon-token normal agent → keep
      { name: SKILL_MERGER_AGENT_NAME, ownerUserId: 'user_real', builtin: false }, // user reused the name → keep
    ]
    expect(
      excludeBuiltinAgents(agentRows).map((r) => `${r.name}:${r.ownerUserId}:${r.builtin}`),
    ).toEqual(['my-coder:__system__:false', `${SKILL_MERGER_AGENT_NAME}:user_real:false`])

    // workflows.name is NON-unique: a user-owned aw-skill-fusion (builtin=false)
    // must survive; only the framework's builtin=true row is dropped.
    const wfRows = [
      { name: SKILL_FUSION_WORKFLOW_NAME, ownerUserId: SYSTEM_USER_ID, builtin: true }, // built-in → drop
      { name: SKILL_FUSION_WORKFLOW_NAME, ownerUserId: 'user_real', builtin: false }, // user import → keep
      { name: 'my-pipeline', ownerUserId: 'user_real', builtin: false }, // keep
    ]
    expect(excludeBuiltinWorkflows(wfRows).map((r) => `${r.name}:${r.builtin}`)).toEqual([
      `${SKILL_FUSION_WORKFLOW_NAME}:false`,
      'my-pipeline:false',
    ])
  })
})
