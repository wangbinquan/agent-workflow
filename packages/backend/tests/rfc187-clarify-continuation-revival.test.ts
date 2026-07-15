// RFC-187 T13 (Codex design-gate P1-7① + impl-gate P1) — the answer-handoff crash wedge.
//
// A human answers a leader clarify: the answer + a PENDING clarify-answer continuation row
// commit, then the route calls `resumeTask` fire-and-forget. If the daemon dies in that
// window, boot's reaper flips the pending row to `interrupted` — but leaves the TASK
// `awaiting_human`, because it only reaps pending/running TASKS. Before this fix nothing
// could ever drive that continuation again:
//   • auto-resume only scanned `interrupted` TASKS  → skipped it;
//   • engine adoption only takes `pending` ROWS      → skipped it;
//   • `interrupted` is terminal (no transition out)  → nothing could flip it back.
// The human's answer was silently lost and the task sat awaiting_human forever.
//
// Fix = revive-by-re-mint at engine entry (like the DAG revives a terminal row) + an
// auto-resume sweep that recognises this second wedge shape.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { autoResumeInterruptedTasks } from '../src/services/autoResume'
import { isKilledClarifyContinuation } from '../src/services/workgroupRunner'
import { CLARIFY_RERUN_CAUSES, isClarifyRerunCause } from '../src/services/nodeRunMint'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-187 T13 — isKilledClarifyContinuation', () => {
  test('an interrupted clarify-answer row = a continuation the restart killed', () => {
    expect(
      isKilledClarifyContinuation({ status: 'interrupted', rerunCause: 'clarify-answer' }),
    ).toBe(true)
    expect(
      isKilledClarifyContinuation({
        status: 'interrupted',
        rerunCause: 'cross-clarify-questioner-rerun',
      }),
    ).toBe(true)
  })

  test('a NON-clarify interrupted row is ordinary restart history (not revived)', () => {
    // reviving these would re-run ordinary work the engine re-derives from its own wake.
    for (const cause of ['wg-leader-round', 'wg-assignment', 'wg-message-turn', 'revival', null]) {
      expect(isKilledClarifyContinuation({ status: 'interrupted', rerunCause: cause })).toBe(false)
    }
  })

  test('a clarify continuation that is NOT interrupted is untouched', () => {
    for (const status of ['pending', 'running', 'done', 'failed', 'canceled']) {
      expect(isKilledClarifyContinuation({ status, rerunCause: 'clarify-answer' })).toBe(false)
    }
  })

  test('the SQL cause list and the predicate share one source (cannot drift)', () => {
    for (const c of CLARIFY_RERUN_CAUSES) expect(isClarifyRerunCause(c)).toBe(true)
  })
})

type TaskInsert = typeof tasks.$inferInsert
type NodeRunInsert = typeof nodeRuns.$inferInsert

async function seedWedged(
  db: DbClient,
  opts: {
    taskStatus: TaskInsert['status']
    runStatus: NodeRunInsert['status']
    cause: NodeRunInsert['rerunCause']
  },
): Promise<string> {
  const taskId = ulid()
  const wfId = ulid()
  await db.insert(workflows).values({ id: wfId, name: `wf-${taskId}`, definition: '{}' })
  await db.insert(tasks).values({
    id: taskId,
    name: 'wedged',
    workflowId: wfId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/x',
    worktreePath: '/tmp/x',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: opts.taskStatus,
    inputs: '{}',
    startedAt: Date.now(),
    workgroupId: 'wg1',
  })
  await db.insert(nodeRuns).values({
    id: ulid(),
    taskId,
    nodeId: '__wg_leader__',
    status: opts.runStatus,
    iteration: 0,
    retryIndex: 0,
    rerunCause: opts.cause,
    startedAt: Date.now(),
  })
  return taskId
}

describe('RFC-187 T13 — auto-resume sweeps the answer-handoff wedge', () => {
  const sweep = async (db: DbClient) => {
    const resumed: string[] = []
    const res = await autoResumeInterruptedTasks({
      db,
      breaker: { maxPerWindow: 3, windowMs: 3_600_000 },
      resume: (id) => {
        resumed.push(id)
        return Promise.resolve()
      },
    })
    return { res, resumed }
  }

  test('awaiting_human + an interrupted clarify-answer row IS resumed (the wedge)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedWedged(db, {
      taskStatus: 'awaiting_human',
      runStatus: 'interrupted',
      cause: 'clarify-answer',
    })
    const { resumed } = await sweep(db)
    // before the fix this was [] — the answered continuation was wedged forever.
    expect(resumed).toEqual([taskId])
  })

  test('a task legitimately PARKED on an unanswered clarify is NOT resumed', async () => {
    // no killed continuation row ⇒ it is genuinely waiting for a human; resuming it would
    // yank a task out from under the person answering it.
    const db = createInMemoryDb(MIGRATIONS)
    await seedWedged(db, {
      taskStatus: 'awaiting_human',
      runStatus: 'awaiting_human',
      cause: 'clarify-park',
    })
    const { resumed } = await sweep(db)
    expect(resumed).toEqual([])
  })

  test('awaiting_human + an interrupted NON-clarify row is NOT resumed', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seedWedged(db, {
      taskStatus: 'awaiting_human',
      runStatus: 'interrupted',
      cause: 'wg-leader-round',
    })
    const { resumed } = await sweep(db)
    expect(resumed).toEqual([])
  })
})

describe('RFC-187 T13 — source locks (engine-entry revive)', () => {
  const RUNNER = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'workgroupRunner.ts'),
    'utf8',
  )

  test('the engine revives killed continuations at (re)entry, next to the assignment reconcile', () => {
    expect(RUNNER).toContain('await reviveKilledClarifyContinuations(db, taskId, rec, log)')
    // re-mint (interrupted is terminal — there is no transition back to pending).
    expect(RUNNER).toMatch(/reviveKilledClarifyContinuations[\s\S]{0,1400}mintNodeRun\(db, \{/)
    // the clarify lineage cause is preserved — it is what re-injects the answered Q&A.
    expect(RUNNER).toContain('cause: latest.rerunCause as RerunCause')
  })

  // Codex P1-7② — RFC-181 A2's dismissal runs OUTSIDE the config-PATCH transaction, so a
  // crash between "autonomous=true committed" and "dismiss" leaves an autonomous group
  // sitting on an open clarify — which (with F3) parks the task awaiting_human for an
  // answer autonomous mode promises never to ask for. Re-assert at engine entry.
  test('an autonomous group re-entering with an open clarify dismisses it (invariant re-asserted)', () => {
    expect(RUNNER).toContain('dismissOpenClarifyParksForAutonomous(db, taskId, rec.config.mode)')
    expect(RUNNER).toMatch(/rec\.config\.autonomous \?\? false[\s\S]{0,200}awaiting_human/)
    // dynamic_workflow has no clarify channel — excluded, like the PATCH path.
    expect(RUNNER).toMatch(/rec\.config\.mode !== 'dynamic_workflow'/)
  })
})
