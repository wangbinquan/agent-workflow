// Locks the boot/periodic lifecycle-scan log tiering introduced when a real
// daemon boot logged `ERROR [lifecycle.invariants] lifecycle invariants
// violated open=59 errorCount=59` — 50 of those 59 were permanent, benign
// findings on long-finished (terminal) tasks, so a red ERROR every restart was
// pure noise. The fix: classify open alerts by the owning task's terminality
// and only ERROR when an error-severity finding sits on a still-live/parked
// task (actionable); error findings that are all on terminal tasks drop to WARN.
//
// If a refactor turns any of these red, it means the terminal-vs-live tiering
// (or the reused canonical `TERMINAL_TASK_STATUSES` predicate) regressed.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  runLifecycleInvariants,
  summarizeOpenAlerts,
  type LifecycleAlertRow,
} from '../src/services/lifecycleInvariants'
import { configureLogger, resetLoggerForTest, setLoggerStdoutWriterForTest } from '../src/util/log'

const GRACE_MS = 24 * 3_600_000

// ---------------------------------------------------------------------------
// Part A — pure summary oracle
// ---------------------------------------------------------------------------

function row(partial: Partial<LifecycleAlertRow> & { taskId: string }): LifecycleAlertRow {
  return {
    id: ulid(),
    rule: 'R2',
    severity: 'error',
    detail: {},
    detectedAt: 0,
    resolvedAt: null,
    ...partial,
  }
}

describe('summarizeOpenAlerts — terminal-vs-live classification', () => {
  test('all error findings on terminal tasks → liveErrorCount 0', () => {
    const status = new Map<string, string>([
      ['done1', 'done'],
      ['fail1', 'failed'],
      ['canc1', 'canceled'],
      ['intr1', 'interrupted'],
    ])
    const s = summarizeOpenAlerts(
      [
        row({ taskId: 'done1', rule: 'T3' }),
        row({ taskId: 'done1', rule: 'R2' }),
        row({ taskId: 'fail1', rule: 'U1' }),
        row({ taskId: 'canc1', rule: 'R2' }),
        row({ taskId: 'intr1', rule: 'S4' }),
      ],
      status,
    )
    expect(s.open).toBe(5)
    expect(s.errorCount).toBe(5)
    expect(s.liveErrorCount).toBe(0)
    expect(s.byRule).toEqual({ T3: 1, R2: 2, U1: 1, S4: 1 })
  })

  test('error findings on live/parked tasks are counted as liveErrorCount', () => {
    const status = new Map<string, string>([
      ['done1', 'done'],
      ['park1', 'awaiting_human'],
      ['park2', 'awaiting_review'],
      ['run1', 'running'],
      ['pend1', 'pending'],
    ])
    const s = summarizeOpenAlerts(
      [
        row({ taskId: 'done1', rule: 'T3' }), // terminal → excluded
        row({ taskId: 'park1', rule: 'T2' }), // live
        row({ taskId: 'park2', rule: 'S1' }), // live
        row({ taskId: 'run1', rule: 'R2' }), // live
        row({ taskId: 'pend1', rule: 'C1' }), // live
      ],
      status,
    )
    expect(s.errorCount).toBe(5)
    expect(s.liveErrorCount).toBe(4)
  })

  test('warning-severity alerts count toward byRule but never toward errorCount', () => {
    const status = new Map<string, string>([['park1', 'awaiting_human']])
    const s = summarizeOpenAlerts(
      [
        row({ taskId: 'park1', rule: 'T2', severity: 'warning' }),
        row({ taskId: 'park1', rule: 'R2', severity: 'warning' }),
      ],
      status,
    )
    expect(s.open).toBe(2)
    expect(s.errorCount).toBe(0)
    expect(s.liveErrorCount).toBe(0)
    expect(s.byRule).toEqual({ T2: 1, R2: 1 })
  })

  test('unknown task status is treated as live (never silently downgraded)', () => {
    const s = summarizeOpenAlerts([row({ taskId: 'ghost', rule: 'R2' })], new Map())
    expect(s.errorCount).toBe(1)
    expect(s.liveErrorCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Part B — end-to-end log tiering through a real promote scan
// ---------------------------------------------------------------------------

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Captured {
  level: string
  service: string
  message: string
  fields: Record<string, unknown>
}

function parse(captured: string): Captured[] {
  return captured
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .map((o) => {
      const { ts: _ts, level, service, message, ...fields } = o
      return {
        level: level as string,
        service: service as string,
        message: message as string,
        fields,
      }
    })
}

async function seedOffendingTask(db: DbClient, status: 'done' | 'awaiting_human'): Promise<string> {
  // done + an output node with no done run → T3 (terminal).
  // awaiting_human + a run that is NOT awaiting_human → T2 (live/parked).
  const node: WorkflowNode =
    status === 'done'
      ? ({ id: 'out', kind: 'output' } as WorkflowNode)
      : ({ id: 'clr', kind: 'clarify' } as WorkflowNode)
  const def: WorkflowDefinition = { $schema_version: 2, inputs: [], nodes: [node], edges: [] }
  const workflowId = ulid()
  await db.insert(workflows).values({ id: workflowId, name: 'w', definition: JSON.stringify(def) })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/x',
    worktreePath: '/tmp/x',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status,
    inputs: '{}',
    startedAt: 0,
  })
  await db.insert(nodeRuns).values({
    id: ulid(),
    taskId,
    nodeId: node.id,
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
    shardKey: null,
    status: status === 'done' ? 'pending' : 'running',
    startedAt: 0,
    finishedAt: null,
  })
  return taskId
}

describe('lifecycle invariants boot log — tiering by task terminality', () => {
  let captured: string

  beforeEach(() => {
    resetLoggerForTest()
    captured = ''
    configureLogger({ level: 'debug', jsonMode: true })
    setLoggerStdoutWriterForTest((line) => {
      captured += line
    })
  })
  afterEach(() => resetLoggerForTest())

  // Detect at t0 (severity=warning), rescan past the 24h grace so the finding
  // promotes to error — the state that made the real daemon log ERROR.
  async function detectThenPromote(db: DbClient, taskId: string): Promise<void> {
    await runLifecycleInvariants({ db, scope: { taskId }, now: () => 0 })
    captured = '' // ignore the first (warning) scan; assert on the promoting scan only
    await runLifecycleInvariants({ db, scope: { taskId }, now: () => GRACE_MS + 1 })
  }

  test('error finding on a terminal (done) task → WARN, not ERROR', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedOffendingTask(db, 'done')
    await detectThenPromote(db, taskId)

    const lines = parse(captured).filter((l) => l.service === 'lifecycle.invariants')
    expect(lines.some((l) => l.level === 'error')).toBe(false)
    const warn = lines.find((l) => l.level === 'warn')
    expect(warn).toBeDefined()
    expect(warn!.message).toContain('historic findings on terminal tasks')
    expect(warn!.fields.errorCount).toBe(1)
  })

  test('error finding on a live (awaiting_human) task → ERROR with liveErrorCount', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedOffendingTask(db, 'awaiting_human')
    await detectThenPromote(db, taskId)

    const lines = parse(captured).filter((l) => l.service === 'lifecycle.invariants')
    const err = lines.find((l) => l.level === 'error')
    expect(err).toBeDefined()
    expect(err!.message).toBe('lifecycle invariants violated')
    expect(err!.fields.liveErrorCount).toBe(1)
    expect(err!.fields.errorCount).toBe(1)
  })
})
