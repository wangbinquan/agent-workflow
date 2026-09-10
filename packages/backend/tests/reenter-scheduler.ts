// RFC-097 shared test helper — re-enter the scheduler on a parked task.
// Not a *.test.ts file so bun:test doesn't try to run it (same convention as
// lifecycle-repair-harness.ts).
//
// Background: RFC-097 made runTask's entry a CAS claim —
// `trySetTaskStatus(running, from={pending})` (services/lifecycle.ts /
// scheduler.ts, audit S-8). Tests that used to simulate "resume" by calling
// runTask a second time while the task sat in awaiting_review /
// awaiting_human / failed now silently no-op ("task not claimable") and the
// downstream assertions go red (or, worse, hollow-green for negative
// oracles like scheduler-boundary-loop-exhausted-resume).
//
// This helper flips the task back to `pending` first — the test equivalent
// of resumeTask's ownership CAS (task.ts flips pending before kicking
// runTask). We intentionally do NOT call resumeTask itself: it also performs
// a git pre_snapshot rollback and registers an AbortController in
// activeTasks, both of which would interfere with scheduler-focused tests
// that drive runTask synchronously. Exemplar for the explicit reset:
// scheduler-clarify-dispatch.test.ts (2dbcf1 :404).

import { eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '../src/db/query'
import { tasks } from '../src/db/schema'

/** Flip the task back to `pending` so the next runTask call can claim it
 *  through the RFC-097 entry CAS — the test stand-in for resumeTask. */
export async function reenterScheduler(db: ProviderNeutralDatabase, taskId: string): Promise<void> {
  await db.update(tasks).set({ status: 'pending' }).where(eq(tasks.id, taskId))
}
