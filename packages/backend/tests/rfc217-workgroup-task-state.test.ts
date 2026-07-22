// RFC-217 T2 — workgroup_task_state: gate state machine + migration 0106.
//
// WHY THIS FILE EXISTS (regression intent):
//   1. The gate machine (idle/declared/awaiting_confirmation/approved/rejected
//      + CAS) replaces three unguarded JSON write styles that could clobber
//      each other (design §2.1). The transition table and its field-patch
//      semantics (declare stores summary + clears the surfaced comment;
//      rejected→idle is the consumption edge) are load-bearing for the
//      engine, the confirm route and the room wire shape — lock them all.
//   2. Migration 0106's backfill CASE is the ONLY bridge for stock tasks. The
//      design-gate P1 findings live here: a declared-but-holder-not-open crash
//      snapshot must map to 'declared' (NOT idle — that would drop the
//      leader's completion declaration on resume), and the dw checkpoint must
//      survive FIELD-COMPLETE (generatedDef / rejectRounds / rejectionComment
//      — phase-only would strand awaiting_confirm tasks unconfirmable).
//   Seeding of the frozen (0105) DB uses raw SQL with EXPLICIT columns —
//   drizzle INSERTs emit all HEAD columns and break on frozen schemas
//   ([reference_new_column_breaks_frozen_migration_tests]).

import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import {
  WORKGROUP_GATE_TRANSITIONS,
  WorkgroupGateTransitionError,
  casGateStatus,
  ensureWorkgroupTaskStateRow,
  gateViewOf,
  loadWorkgroupTaskState,
  type WorkgroupGateStatus,
} from '../src/services/workgroup/state'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

// ---------------------------------------------------------------------------
// 1. gate state machine (HEAD schema)
// ---------------------------------------------------------------------------

async function seedTask(db: ReturnType<typeof createInMemoryDb>): Promise<string> {
  const wfId = ulid()
  await db.insert(workflows).values({ id: wfId, name: `wf-${wfId}`, definition: '{}' })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 'gate-machine',
    workflowId: wfId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read-wt',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  await ensureWorkgroupTaskStateRow(db, taskId)
  return taskId
}

describe('rfc217 T2 — gate state machine', () => {
  test('legal walk: idle→declared→awaiting→rejected→declared→awaiting→approved', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const id = await seedTask(db)
    expect(
      await casGateStatus(db, id, { from: ['idle', 'rejected'], to: 'declared', summary: 's1' }),
    ).toBe(true)
    expect((await loadWorkgroupTaskState(db, id)).gateSummary).toBe('s1')
    expect(await casGateStatus(db, id, { from: ['declared'], to: 'awaiting_confirmation' })).toBe(
      true,
    )
    expect(
      await casGateStatus(db, id, {
        from: ['awaiting_confirmation'],
        to: 'rejected',
        rejectedComment: 'nope',
      }),
    ).toBe(true)
    const rejected = await loadWorkgroupTaskState(db, id)
    expect(rejected.gateRejectedComment).toBe('nope')
    expect(rejected.gateSummary).toBe('s1') // summary kept for the re-declare prompt
    // re-declare clears the surfaced comment and stores the new summary
    expect(
      await casGateStatus(db, id, { from: ['idle', 'rejected'], to: 'declared', summary: 's2' }),
    ).toBe(true)
    const redeclared = await loadWorkgroupTaskState(db, id)
    expect(redeclared.gateSummary).toBe('s2')
    expect(redeclared.gateRejectedComment).toBeNull()
    expect(await casGateStatus(db, id, { from: ['declared'], to: 'awaiting_confirmation' })).toBe(
      true,
    )
    expect(await casGateStatus(db, id, { from: ['awaiting_confirmation'], to: 'approved' })).toBe(
      true,
    )
    expect(gateViewOf(await loadWorkgroupTaskState(db, id)).approved).toBe(true)
  })

  test('rejected→idle consumption edge clears summary AND comment', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const id = await seedTask(db)
    await casGateStatus(db, id, { from: ['idle'], to: 'declared', summary: 's' })
    await casGateStatus(db, id, { from: ['declared'], to: 'awaiting_confirmation' })
    await casGateStatus(db, id, {
      from: ['awaiting_confirmation'],
      to: 'rejected',
      rejectedComment: 'c',
    })
    expect(await casGateStatus(db, id, { from: ['rejected'], to: 'idle' })).toBe(true)
    const st = await loadWorkgroupTaskState(db, id)
    expect(st.gateStatus).toBe('idle')
    expect(st.gateSummary).toBeNull()
    expect(st.gateRejectedComment).toBeNull()
  })

  test('CAS: wrong from-state returns false and writes nothing', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const id = await seedTask(db)
    expect(await casGateStatus(db, id, { from: ['declared'], to: 'awaiting_confirmation' })).toBe(
      false,
    )
    expect((await loadWorkgroupTaskState(db, id)).gateStatus).toBe('idle')
  })

  test('illegal transition throws (table is the single legality source)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const id = await seedTask(db)
    await expect(casGateStatus(db, id, { from: ['idle'], to: 'approved' })).rejects.toBeInstanceOf(
      WorkgroupGateTransitionError,
    )
    // approved is terminal — every outgoing edge is illegal
    expect(WORKGROUP_GATE_TRANSITIONS.approved).toHaveLength(0)
  })

  test('gateViewOf derivation matrix (wire-frozen booleans)', () => {
    const base = { gateSummary: null, gateRejectedComment: null, pauseReason: null, dwState: null }
    const view = (gateStatus: WorkgroupGateStatus) => gateViewOf({ ...base, gateStatus })
    expect(view('idle')).toMatchObject({
      declaredDone: false,
      awaitingConfirmation: false,
      approved: false,
      rejected: false,
    })
    expect(view('declared')).toMatchObject({ declaredDone: true, awaitingConfirmation: false })
    expect(view('awaiting_confirmation')).toMatchObject({
      declaredDone: true,
      awaitingConfirmation: true,
    })
    expect(view('approved')).toMatchObject({ declaredDone: true, approved: true })
    expect(view('rejected')).toMatchObject({ declaredDone: false, rejected: true })
  })
})

// ---------------------------------------------------------------------------
// 2. migration 0106 — frozen-DB backfill
// ---------------------------------------------------------------------------

interface JournalEntry {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}
interface Journal {
  version: string
  dialect: string
  entries: JournalEntry[]
}

function freezeAt(idx: number): string {
  const full = JSON.parse(
    readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf-8'),
  ) as Journal
  const dir = mkdtempSync(join(tmpdir(), 'aw-mig0106-partial-'))
  mkdirSync(join(dir, 'meta'), { recursive: true })
  const partial: Journal = { ...full, entries: full.entries.slice(0, idx + 1) }
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(partial, null, 2), 'utf-8')
  for (const e of partial.entries) {
    copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`))
    const snap = `${String(e.idx).padStart(4, '0')}_snapshot.json`
    if (existsSync(join(MIGRATIONS, 'meta', snap))) {
      copyFileSync(join(MIGRATIONS, 'meta', snap), join(dir, 'meta', snap))
    }
  }
  return dir
}

const NUDGE_BODY =
  'Autonomous mode: you ended a round without dispatching work or declaring done. If the goal is complete, emit wg_decision done; otherwise dispatch the next assignment(s) or say what is blocking.'

describe('rfc217 T2 — migration 0106 backfill', () => {
  test('gate CASE (incl. declared-only crash window), dw field-complete, slot strip, nudge stamp', () => {
    const sqlite = new Database(':memory:')
    const db = drizzle(sqlite)
    migrate(db, { migrationsFolder: freezeAt(104) }) // through 0105 — pre-state-table

    const insertTask = (id: string, configJson: string | null, wg: boolean): void => {
      sqlite.run(
        `INSERT INTO tasks (id, name, workflow_id, workflow_snapshot, repo_path, worktree_path,
           base_branch, branch, status, inputs, started_at, workgroup_id, workgroup_config_json)
         VALUES (?, ?, 'wf-x', '{}', '/tmp/x', '/tmp/x-wt', 'main', ?, 'running', '{}', 1, ?, ?)`,
        [id, id, `agent-workflow/${id}`, wg ? 'wg-1' : null, configJson],
      )
    }
    sqlite.run(`INSERT INTO workflows (id, name, definition) VALUES ('wf-x', 'wf-x', '{}')`)

    const dwCheckpoint = {
      phase: 'awaiting_confirm',
      generateAttempts: 2,
      rejectRounds: 1,
      rejectionComment: 'tighten the plan',
      generatedDef: { nodes: [{ id: 'n1' }], edges: [] },
    }
    insertTask(
      't-approved',
      JSON.stringify({
        mode: 'leader_worker',
        keep: 'me',
        gate: { approved: true, awaitingConfirmation: false, declaredDone: true, summary: 'done!' },
      }),
      true,
    )
    insertTask(
      't-await',
      JSON.stringify({
        mode: 'leader_worker',
        gate: { awaitingConfirmation: true, declaredDone: true },
      }),
      true,
    )
    insertTask(
      't-rejected',
      JSON.stringify({ mode: 'leader_worker', gate: { rejected: true, rejectedComment: 'redo' } }),
      true,
    )
    insertTask(
      't-declared-window',
      JSON.stringify({ mode: 'leader_worker', gate: { declaredDone: true } }),
      true,
    )
    insertTask(
      't-idle',
      JSON.stringify({
        mode: 'free_collab',
        autonomous: true,
        wgPause: { reason: 'max-rounds-wrapup' },
      }),
      true,
    )
    insertTask('t-dw', JSON.stringify({ mode: 'dynamic_workflow', dw: dwCheckpoint }), true)
    insertTask('t-plain', null, false)

    sqlite.run(
      `INSERT INTO workgroup_messages (id, task_id, round, author_kind, kind, body_md, mentions_json, created_at)
       VALUES ('m-nudge', 't-idle', 0, 'system', 'chat', ?, '[]', 1),
              ('m-chat',  't-idle', 0, 'system', 'chat', 'ordinary system note', '[]', 2),
              ('m-human', 't-idle', 0, 'human',  'chat', ?, '[]', 3)`,
      [NUDGE_BODY, NUDGE_BODY],
    )

    migrate(db, { migrationsFolder: MIGRATIONS }) // applies 0106

    const state = (id: string): Record<string, unknown> | null =>
      sqlite.query('SELECT * FROM workgroup_task_state WHERE task_id = ?').get(id) as Record<
        string,
        unknown
      > | null

    expect(state('t-approved')?.gate_status).toBe('approved')
    expect(state('t-approved')?.gate_summary).toBe('done!')
    expect(state('t-await')?.gate_status).toBe('awaiting_confirmation')
    expect(state('t-rejected')?.gate_status).toBe('rejected')
    expect(state('t-rejected')?.gate_rejected_comment).toBe('redo')
    // design-gate P1 — the two-write crash window maps to 'declared', not idle
    expect(state('t-declared-window')?.gate_status).toBe('declared')
    expect(state('t-idle')?.gate_status).toBe('idle')
    expect(state('t-idle')?.pause_reason).toBe('max-rounds-wrapup')
    // dw checkpoint survives FIELD-COMPLETE
    expect(JSON.parse((state('t-dw')?.dw_state_json as string) ?? 'null')).toEqual(dwCheckpoint)
    // non-workgroup task gets no row
    expect(state('t-plain')).toBeNull()

    // retired slots (incl. the RFC-207 autonomous corpse) are stripped; other keys survive
    const cfg = (id: string): Record<string, unknown> =>
      JSON.parse(
        (
          sqlite.query('SELECT workgroup_config_json AS c FROM tasks WHERE id = ?').get(id) as {
            c: string
          }
        ).c,
      ) as Record<string, unknown>
    for (const id of [
      't-approved',
      't-await',
      't-rejected',
      't-declared-window',
      't-idle',
      't-dw',
    ]) {
      const c = cfg(id)
      expect(c.gate).toBeUndefined()
      expect(c.dw).toBeUndefined()
      expect(c.wgPause).toBeUndefined()
      expect(c.autonomous).toBeUndefined()
    }
    expect(cfg('t-approved').keep).toBe('me')

    // nudge stamp: ONLY system-author chat rows with the exact body flip kind
    const kindOf = (id: string): string =>
      (sqlite.query('SELECT kind FROM workgroup_messages WHERE id = ?').get(id) as { kind: string })
        .kind
    expect(kindOf('m-nudge')).toBe('nudge')
    expect(kindOf('m-chat')).toBe('chat')
    expect(kindOf('m-human')).toBe('chat') // human-authored same-body row untouched

    // machine continuity (AC-12): the declared-window task can proceed through
    // the normal edge after upgrade
    sqlite.run(
      `UPDATE workgroup_task_state SET gate_status = 'awaiting_confirmation', updated_at = 2
       WHERE task_id = 't-declared-window' AND gate_status = 'declared'`,
    )
    expect(state('t-declared-window')?.gate_status).toBe('awaiting_confirmation')
  })
})
