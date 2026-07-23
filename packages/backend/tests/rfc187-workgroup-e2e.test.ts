// RFC-187 PR-1 — real-subprocess e2e locking the THREE live-probe findings (audit
// design/workgroup-e2e-audit.md §3-7/§4/§5, probes A/B/C, 2026-07-14) into CI. Every
// prior workgroup engine test stubs runHostNode; these drive the real spawn → envelope
// parse → dispatch → merge-back → done path via `scenario-opencode`, so the fixes can't
// silently regress:
//   F3  (probe B) — a NON-autonomous leader clarify must park awaiting_human (leader-
//                   clarify) and NOT re-drive the leader; before the fix it spun to
//                   max_rounds (10 leader rounds, N orphaned clarify sessions).
//   §3-7 (probe C) — maxRounds hit WITH completed work must NOT hard-fail; the leader
//                   gets ONE grace wrap-up round to declare done.
//   §4  (probe A) — a `done` with zero canonical delta despite completed work posts a
//                   non-blocking warn (the scenario stub writes no files, so every
//                   scenario done is zero-delta — exactly the detection surface).

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, nodeRuns, tasks, workgroupMessages, users } from '../src/db/schema'
import { buildActor } from '../src/auth/actor'
import { createAgent } from '../src/services/agent'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import { resumeTask } from '../src/services/task'
import { createWorkgroup } from '../src/services/workgroups'
import { startWorkgroupTask } from '../src/services/workgroup/launch'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SCENARIO_STUB = resolve(import.meta.dir, 'fixtures', 'scenario-opencode.ts')

interface Harness {
  db: DbClient
  appHome: string
  stateDir: string
  planFile: string
  cleanup: () => void
}

function harness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-wg187-e2e-'))
  const appHome = join(tmp, 'home')
  const stateDir = join(tmp, 'state')
  const planFile = join(tmp, 'plan.json')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  return {
    db: createInMemoryDb(MIGRATIONS),
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

function writePlan(h: Harness, plan: Record<string, unknown[]>): void {
  writeFileSync(h.planFile, JSON.stringify(plan))
  process.env.SCENARIO_PLAN_FILE = h.planFile
  process.env.SCENARIO_STATE_DIR = h.stateDir
}

const opencodeCmd = (): string[] => ['bun', 'run', SCENARIO_STUB]

async function seedAgent(db: DbClient, name: string): Promise<string> {
  const created = await createAgent(db, {
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
  return created.id
}

async function seedGroup(
  db: DbClient,
  name: string,
  // RFC-207 — ask-back is on iff the roster holds a human; `withHuman` replaces
  // the old `autonomous` flag (which meant the same thing, inverted).
  opts: { withHuman: boolean; maxRounds?: number },
): Promise<string> {
  const leadAgentId = await seedAgent(db, 'wg-lead')
  const writerAgentId = await seedAgent(db, 'wg-writer')
  if (opts.withHuman) {
    // The human member must resolve to an ACTIVE user — createWorkgroup rejects a
    // roster pointing at a missing/inactive one (workgroups.ts assertHumanMembersActive).
    await db
      .insert(users)
      .values({
        id: 'u-e2e',
        username: 'e2e',
        displayName: 'e2e',
        role: 'admin',
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .onConflictDoNothing()
  }
  const group = await createWorkgroup(db, {
    name,
    description: '',
    instructions: '章程：小步快跑',
    mode: 'leader_worker',
    leaderDisplayName: 'lead',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: opts.maxRounds ?? 8,
    completionGate: false,
    members: [
      { memberType: 'agent', agentId: leadAgentId, displayName: 'lead', roleDesc: '协调' },
      { memberType: 'agent', agentId: writerAgentId, displayName: 'writer', roleDesc: '产出' },
      ...(opts.withHuman
        ? [{ memberType: 'human', userId: 'u-e2e', displayName: 'owner', roleDesc: '拍板' }]
        : []),
    ],
  } as Parameters<typeof createWorkgroup>[1])
  return group.id
}

const actor = buildActor({
  user: { id: 'u-e2e', username: 'e2e', displayName: 'e2e', role: 'admin', status: 'active' },
  source: 'daemon',
})

const DISPATCH = {
  output: {
    wg_assignments: JSON.stringify([{ member: 'writer', title: 'write alpha', brief: 'do it' }]),
    wg_decision: JSON.stringify({ action: 'continue' }),
  },
}
const DONE = { output: { wg_decision: JSON.stringify({ action: 'done', summary: 'done' }) } }
const WORKER_RESULT = { output: { wg_result: JSON.stringify({ summary: 'did the work' }) } }

const CLARIFY = {
  clarify: {
    questions: [
      {
        id: 'q1',
        title: 'Which config format?',
        kind: 'single',
        options: [{ label: 'JSON', recommended: true }, { label: 'YAML' }],
      },
    ],
  },
}

async function launch(h: Harness, workgroupId: string) {
  return startWorkgroupTask(
    h.db,
    actor,
    workgroupId,
    { name: 'e2e', goal: '产出 alpha', scratch: true },
    { db: h.db, appHome: h.appHome, opencodeCmd: opencodeCmd(), awaitScheduler: true },
  )
}

const leaderRunCount = async (db: DbClient, taskId: string): Promise<number> =>
  (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
    (r) => r.nodeId === '__wg_leader__',
  ).length

describe('RFC-187 F3 — non-autonomous leader clarify parks (does not spin to max_rounds)', () => {
  test('leader clarify → awaiting_human (leader-clarify) with exactly ONE leader run → answer → done', async () => {
    const h = harness()
    try {
      const groupId = await seedGroup(h.db, 'wg187-f3', { withHuman: true })
      // leader: ask a clarify FIRST, then (after the answer) dispatch, then declare done.
      writePlan(h, {
        'wg-lead': [CLARIFY, DISPATCH, DONE],
        'wg-writer': [WORKER_RESULT],
      })
      const task = await launch(h, groupId)

      // PROBE B LOCK: the task parks awaiting_human — NOT running/failed — and the
      // leader ran exactly ONCE (before the fix it re-drove every round to max_rounds).
      const parked = (await h.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]
      expect(parked?.status).toBe('awaiting_human')
      expect(await leaderRunCount(h.db, task.id)).toBe(1)
      // the park is a LEADER clarify (a __wg_clarify__ session awaiting a human).
      const clar = (
        await h.db
          .select()
          .from(clarifyRounds)
          .where(and(eq(clarifyRounds.taskId, task.id), eq(clarifyRounds.status, 'awaiting_human')))
      )[0]
      expect(clar).toBeDefined()
      expect(clar?.askingNodeId).toBe('__wg_leader__')

      // answer the clarify → resume → leader continues → dispatch → worker → done.
      await autoDispatchClarifyRound({
        db: h.db,
        originNodeRunId: clar!.intermediaryNodeRunId,
        answers: [
          {
            questionId: 'q1',
            selectedOptionIndices: [0],
            selectedOptionLabels: ['JSON'],
            customText: '',
          },
        ],
        directive: 'continue',
        actor: { userId: 'u-e2e', role: 'owner' },
      })
      await resumeTask(h.db, task.id, {
        db: h.db,
        appHome: h.appHome,
        opencodeCmd: opencodeCmd(),
        awaitScheduler: true,
      })

      const final = (await h.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]
      expect(final?.status).toBe('done')
      // the leader re-woke (continued) — strictly more than the single parked run.
      expect(await leaderRunCount(h.db, task.id)).toBeGreaterThan(1)
    } finally {
      h.cleanup()
    }
  })
})

describe('RFC-187 §3-7 — maxRounds with completed work wraps up (does not hard-fail)', () => {
  test('maxRounds:1 + dispatch + worker done → grace wrap-up round → task done (not failed)', async () => {
    const h = harness()
    try {
      const groupId = await seedGroup(h.db, 'wg187-mr', { withHuman: false, maxRounds: 1 })
      // round 1 (the only budgeted round) dispatches; the grace wrap-up round declares done.
      writePlan(h, { 'wg-lead': [DISPATCH, DONE], 'wg-writer': [WORKER_RESULT] })
      const task = await launch(h, groupId)

      const final = (await h.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]
      expect(final).toBeDefined()
      // PROBE C LOCK: NOT failed — the deliverable-in-hand task wrapped up.
      expect(final?.status).not.toBe('failed')
      expect(['done', 'awaiting_human']).toContain(final!.status)
      // exactly ONE grace round past the cap: 2 leader runs (dispatch + wrap-up).
      expect(await leaderRunCount(h.db, task.id)).toBe(2)
    } finally {
      h.cleanup()
    }
  })
})

describe('RFC-187 §4 — zero canonical delta on done posts a warn', () => {
  test('done with completed work but no canonical changes → advisory warn message', async () => {
    const h = harness()
    try {
      const groupId = await seedGroup(h.db, 'wg187-zd', { withHuman: false })
      // scenario-opencode never writes files, so this done has zero canonical delta.
      writePlan(h, { 'wg-lead': [DISPATCH, DONE], 'wg-writer': [WORKER_RESULT] })
      const task = await launch(h, groupId)

      const final = (await h.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]
      expect(final?.status).toBe('done')
      // PROBE A LOCK: the framework flags the silent empty deliverable.
      const msgs = await h.db
        .select()
        .from(workgroupMessages)
        .where(eq(workgroupMessages.taskId, task.id))
      expect(msgs.some((m) => m.bodyMd.includes('canonical worktree has no changes'))).toBe(true)
    } finally {
      h.cleanup()
    }
  })
})
