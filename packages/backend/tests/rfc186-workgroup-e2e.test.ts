// RFC-186 PR-1 — the FIRST real-subprocess end-to-end test of the leader_worker
// loop (design.md §6; audit design/workgroup-e2e-audit.md §6, the meta root
// cause). Every prior workgroup ENGINE test stubs `runHostNode` with canned
// outputs, so the actual framework↔opencode contract — real spawn → real
// envelope parse → RFC-184 host projection → dispatch → real worker turn → real
// iso merge-back → leader aggregate → done — was NEVER exercised in CI, and
// integration bugs surfaced one-per-task in production (F42SE / E0RBDE / DP7BXB,
// 10 tasks 0 done). This drives it for real via `scenario-opencode` (per-agent,
// per-turn scripted opencode) so the first green is regression-locked.

import { describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workgroupAssignments } from '../src/db/schema'
import { buildActor } from '../src/auth/actor'
import { createAgent } from '../src/services/agent'
import { createWorkgroup } from '../src/services/workgroups'
import { startWorkgroupTask } from '../src/services/workgroupLaunch'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SCENARIO_STUB = resolve(import.meta.dir, 'fixtures', 'scenario-opencode.ts')

interface Step {
  output?: Record<string, string>
  skipEnvelope?: true
  crash?: true
}

interface Harness {
  db: DbClient
  appHome: string
  stateDir: string
  planFile: string
  cleanup: () => void
}

function harness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-wg-e2e-'))
  const appHome = join(tmp, 'home')
  const stateDir = join(tmp, 'state')
  const planFile = join(tmp, 'plan.json')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    appHome,
    stateDir,
    planFile,
    cleanup: () => {
      rmSync(tmp, { recursive: true, force: true })
      delete process.env.SCENARIO_PLAN_FILE
      delete process.env.SCENARIO_STATE_DIR
    },
  }
}

function writePlan(h: Harness, plan: Record<string, Step[]>): void {
  writeFileSync(h.planFile, JSON.stringify(plan))
  process.env.SCENARIO_PLAN_FILE = h.planFile
  process.env.SCENARIO_STATE_DIR = h.stateDir
}

const opencodeCmd = (): string[] => ['bun', 'run', SCENARIO_STUB]

async function seedAgent(db: DbClient, name: string): Promise<void> {
  await createAgent(db, {
    name,
    description: name,
    outputs: [],
    syncOutputsOnIterate: true,
    permission: {},
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: `you are ${name}`,
  })
}

async function seedLeaderWorkerGroup(db: DbClient, name: string): Promise<void> {
  await seedAgent(db, 'wg-lead')
  await seedAgent(db, 'wg-writer')
  await createWorkgroup(db, {
    name,
    description: '',
    instructions: '章程：小步快跑',
    mode: 'leader_worker',
    leaderDisplayName: 'lead',
    // autonomous → no clarify invitation (keeps the scenario off the ask-back path).
    autonomous: true,
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 8,
    completionGate: false,
    members: [
      { memberType: 'agent', agentName: 'wg-lead', displayName: 'lead', roleDesc: '协调' },
      { memberType: 'agent', agentName: 'wg-writer', displayName: 'writer', roleDesc: '产出' },
    ],
  } as Parameters<typeof createWorkgroup>[1])
}

const actor = buildActor({
  user: { id: 'u-e2e', username: 'e2e', displayName: 'e2e', role: 'admin', status: 'active' },
  source: 'daemon',
})

// leader round 1: dispatch one assignment to the worker; round 2: declare done.
const DISPATCH: Step = {
  output: {
    wg_assignments: JSON.stringify([
      { member: 'writer', title: 'write alpha', brief: 'create alpha.txt with content "alpha"' },
    ]),
    wg_decision: JSON.stringify({ action: 'continue' }),
  },
}
const DONE: Step = {
  output: { wg_decision: JSON.stringify({ action: 'done', summary: 'all done' }) },
}
const WORKER_RESULT: Step = {
  output: { wg_result: JSON.stringify({ summary: 'wrote alpha.txt' }) },
}

async function launch(h: Harness, group: string) {
  const task = await startWorkgroupTask(
    h.db,
    actor,
    group,
    { name: 'e2e', goal: '产出 alpha', scratch: true },
    { db: h.db, appHome: h.appHome, opencodeCmd: opencodeCmd(), awaitScheduler: true },
  )
  return task
}

describe('RFC-186 — leader_worker real end-to-end (scenario-opencode)', () => {
  // Runs unconditionally in CI, like the peer real-subprocess e2es
  // (rfc167-dw-e2e, clarify-review-combination): scratch git repos + bun spawn,
  // no network. This is the regression lock for the first green.

  // AC1 — the whole loop reaches done for real.
  test('leader dispatches → worker runs → leader aggregates → task done', async () => {
    const h = harness()
    try {
      await seedLeaderWorkerGroup(h.db, 'wg-e2e-ac1')
      writePlan(h, { 'wg-lead': [DISPATCH, DONE], 'wg-writer': [WORKER_RESULT] })
      const task = await launch(h, 'wg-e2e-ac1')

      const final = (await h.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]
      expect(final?.status).toBe('done')

      // a real __wg_member__ (worker) host run reached done — the thing that had
      // NEVER happened in production (0 workers ever ran).
      const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, task.id))
      const memberDone = runs.filter((r) => r.nodeId === '__wg_member__' && r.status === 'done')
      expect(memberDone.length).toBeGreaterThanOrEqual(1)

      const cards = await h.db
        .select()
        .from(workgroupAssignments)
        .where(eq(workgroupAssignments.taskId, task.id))
      expect(cards).toHaveLength(1)
      expect(cards[0]?.status).toBe('done')
    } finally {
      h.cleanup()
    }
  })

  // AC2 — a leader envelope slip (no <workflow-output>) is retried, not fatal.
  test('leader skips the envelope once → retries → task still reaches done', async () => {
    const h = harness()
    try {
      await seedLeaderWorkerGroup(h.db, 'wg-e2e-ac2')
      writePlan(h, {
        'wg-lead': [{ skipEnvelope: true }, DISPATCH, DONE],
        'wg-writer': [WORKER_RESULT],
      })
      const task = await launch(h, 'wg-e2e-ac2')

      const final = (await h.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]
      expect(final?.status).toBe('done')

      // the first leader host run failed on envelope-missing but the turn recovered.
      const runs = await h.db.select().from(nodeRuns).where(eq(nodeRuns.taskId, task.id))
      const leaderFailed = runs.filter((r) => r.nodeId === '__wg_leader__' && r.status === 'failed')
      expect(leaderFailed.length).toBeGreaterThanOrEqual(1)
      expect(leaderFailed.some((r) => (r.errorMessage ?? '').includes('envelope'))).toBe(true)
    } finally {
      h.cleanup()
    }
  })
})

// A always-on smoke that the scenario stub itself is runnable (so a genuine
// skip in CI can't hide a broken fixture path).
describe('RFC-186 — scenario-opencode fixture is present', () => {
  test('scenario stub reports a version', () => {
    const out = execSync(`bun run "${SCENARIO_STUB}" --version`, { encoding: 'utf8' })
    expect(out).toContain('scenario-opencode')
  })
})
