// RFC-062 PR-C — incident-shape regression for S5 stall detection.
//
// rfc061-stuck-detector-rebuild.test.ts already exercises the
// happy / boundary cases for the S5 + S6 rules. This file adds the
// missing one: a regression that recreates the EXACT pathology
// from the 2026-05-25 incident (task `01KSE07E4D6TDHMAS1VZWVMKE7`)
// and asserts the stall scanner would have surfaced the deadlock
// within the configured threshold.
//
// The incident task wrote 4 events in 4 ms then sat for 8 hours
// in `status='running'` with no further events. Pre-RFC-062 the
// dashboard, the diagnose endpoint, and the daemon log all said
// "everything fine" — there was no rule that fired for "running
// but no events". S5 (added in RFC-062 PR-C, implemented by the
// user) closes that gap. This test pins the incident shape against
// it so any future refactor that re-introduces silent stalls is
// caught at PR time.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import { createInMemoryDb } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { writeEvents } from '../src/services/writeEvents'
import { runStuckTaskDetector, DEFAULT_STUCK_THRESHOLD_MS } from '../src/services/stuckTaskDetector'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-062 PR-C — S5 fires for incident-shape deadlock', () => {
  test('cross-clarify workflow deadlock (4 events then silence > threshold) → S5 alert', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const wfId = ulid()
    await db.insert(workflows).values({ id: wfId, name: 'incident-wf', definition: '{}' })
    const taskId = '01KSE07E4D6TDHMAS1VZWVMKE7'
    await db.insert(tasks).values({
      id: taskId,
      name: 'incident',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/aw-incident',
      worktreePath: '/tmp/aw-incident/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: JSON.stringify({ requirement: 'generate a snake game design' }),
      startedAt: Date.now(),
    })

    // The 4 events the incident task actually produced (mirroring the
    // event payloads from sqlite3 readout, but with the deterministic
    // ts base used by writeEvents in tests).
    const baseTs = 1_779_660_208_377 // matches the incident sample
    await writeEvents(db, [
      {
        taskId,
        kind: 'task-started',
        actor: 'system',
        payload: {},
        ts: baseTs,
      },
      {
        taskId,
        kind: 'logical-run-created',
        nodeId: 'in_0ck111',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        actor: 'system',
        payload: {},
        ts: baseTs + 1,
      },
      {
        taskId,
        kind: 'attempt-output-captured',
        nodeId: 'in_0ck111',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        actor: 'system',
        payload: { portName: 'requirement', content: 'generate a snake game design' },
        ts: baseTs + 3,
      },
      {
        taskId,
        kind: 'logical-run-completed',
        nodeId: 'in_0ck111',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        actor: 'system',
        payload: {},
        ts: baseTs + 4,
      },
    ])

    // The incident task sat for ~8 hours after the last event.
    // Advance "now" past the stuck threshold to match.
    const now = baseTs + DEFAULT_STUCK_THRESHOLD_MS + 60_000
    const r = await runStuckTaskDetector({ db, now: () => now })

    expect(r.scanned).toBe(1)
    const s5 = r.openAlerts.filter((a) => a.rule === 'S5')
    expect(s5.length).toBe(1)
    expect(s5[0]?.taskId).toBe(taskId)
    // The alert detail must surface enough context for a human reader
    // to act on (lastEventTs + ageMs + thresholdMs). Without these
    // fields the UI banner is just "something is wrong, good luck".
    const detail = s5[0]?.detail as Record<string, number> | undefined
    expect(detail?.lastEventTs).toBe(baseTs + 4)
    expect(detail?.ageMs).toBeGreaterThan(DEFAULT_STUCK_THRESHOLD_MS)
    expect(detail?.thresholdMs).toBe(DEFAULT_STUCK_THRESHOLD_MS)
  })

  test('healthy fresh task (events flowing recently) → no S5', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const wfId = ulid()
    await db.insert(workflows).values({ id: wfId, name: 'healthy-wf', definition: '{}' })
    const taskId = ulid()
    await db.insert(tasks).values({
      id: taskId,
      name: 'healthy',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/aw-healthy',
      worktreePath: '/tmp/aw-healthy/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })

    // Recent event well within the threshold window.
    const now = Date.now()
    await writeEvents(db, [
      {
        taskId,
        kind: 'task-started',
        actor: 'system',
        payload: {},
        ts: now - 1_000,
      },
    ])
    const r = await runStuckTaskDetector({ db, now: () => now })
    expect(r.openAlerts.filter((a) => a.rule === 'S5').length).toBe(0)
  })

  test('thresholdMs override flows through to the finding detail', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const wfId = ulid()
    await db.insert(workflows).values({ id: wfId, name: 'override-wf', definition: '{}' })
    const taskId = ulid()
    await db.insert(tasks).values({
      id: taskId,
      name: 'override',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/aw-override',
      worktreePath: '/tmp/aw-override/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    const baseTs = 1_700_000_000_000
    await writeEvents(db, [
      {
        taskId,
        kind: 'task-started',
        actor: 'system',
        payload: {},
        ts: baseTs,
      },
    ])
    const customThreshold = 60_000 // 1 minute (very tight)
    const now = baseTs + 90_000
    const r = await runStuckTaskDetector({
      db,
      now: () => now,
      stuckThresholdMs: customThreshold,
    })
    const s5 = r.openAlerts.filter((a) => a.rule === 'S5')
    expect(s5.length).toBe(1)
    const detail = s5[0]?.detail as Record<string, number> | undefined
    expect(detail?.thresholdMs).toBe(customThreshold)
  })
})
