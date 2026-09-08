// The 2026-09-08 hosted maintenance run recorded a 266.57ms transaction and
// a 261.39ms statement in one webhookDeliveryGc slice. Histograms alone did
// not identify the SQL or distinguish process CPU from elapsed wall time.
// These diagnostics add evidence; they do not change the workload or its gate.
import { describe, expect, test } from 'bun:test'

import { createMaintenanceSliceDiagnostics } from '@/platform/background/maintenanceSliceDiagnostics'

function fixture(
  input: {
    runId?: string
    slice?: number
    attempt?: number
    now?: () => number
  } = {},
) {
  const lines: Array<{ message: string; fields?: Record<string, unknown> }> = []
  const diagnostic = createMaintenanceSliceDiagnostics({
    job: 'webhookDeliveryGc',
    runId: input.runId ?? 'run-1',
    slice: input.slice ?? 3,
    attempt: input.attempt ?? 4,
    startedAt: 100,
    now: input.now ?? (() => 400),
    log: {
      warn(message, fields) {
        lines.push({ message, fields })
      },
    },
  })
  return { diagnostic, lines }
}

describe('RFC-338 maintenance slice diagnostics', () => {
  test('slow slices identify one bounded slowest SQL template and the slice transaction maxima', () => {
    const { diagnostic, lines } = fixture()
    const template = `  DELETE FROM webhook_deliveries WHERE id = ? /* ${'x'.repeat(500)} */`
    diagnostic.observeStatement(0.4, 'BEGIN IMMEDIATE', 0)
    diagnostic.observeStatement(261.39, template, 18)
    diagnostic.observeStatement(0.7, 'COMMIT', 0)
    diagnostic.finish({ count: 1, totalMs: 266.57, maxMs: 266.57 }, 278.4)

    expect(lines).toEqual([
      {
        message: 'maintenance slice slow',
        fields: {
          job: 'webhookDeliveryGc',
          runId: 'run-1',
          slice: 3,
          attempt: 4,
          workerSliceMs: 278.4,
          dbTransactionCount: 1,
          dbTransactionMsTotal: 266.57,
          dbTransactionMsMax: 266.57,
          slowestStatementKind: 'DELETE',
          slowestStatementSql: `${template.slice(0, 300)}…`,
          slowestStatementWallMs: 261.39,
          slowestStatementProcessCpuMs: 18,
        },
      },
    ])
    expect(lines[0]!.fields!.slowestStatementSql).toHaveLength(301)
  })

  test('the 250ms log boundary observes slice, statement, and transaction wall independently', () => {
    const fast = fixture()
    fast.diagnostic.observeStatement(249.9, 'SELECT 1', 1)
    fast.diagnostic.finish({ count: 1, totalMs: 249.9, maxMs: 249.9 }, 249.9)
    expect(fast.lines).toEqual([])

    const slowSlice = fixture()
    slowSlice.diagnostic.observeStatement(5, 'SELECT 1', 1)
    slowSlice.diagnostic.finish({ count: 2, totalMs: 200, maxMs: 110 }, 250)
    expect(slowSlice.lines[0]?.fields).toMatchObject({
      workerSliceMs: 250,
      dbTransactionCount: 2,
      dbTransactionMsTotal: 200,
      dbTransactionMsMax: 110,
      slowestStatementWallMs: 5,
    })

    const slowStatement = fixture()
    slowStatement.diagnostic.observeStatement(250, 'SELECT 1', 1)
    slowStatement.diagnostic.finish(null, 10)
    expect(slowStatement.lines).toHaveLength(1)

    const slowTransaction = fixture()
    slowTransaction.diagnostic.finish({ count: 1, totalMs: 250, maxMs: 250 }, 10)
    expect(slowTransaction.lines).toHaveLength(1)
  })

  test('each slice retains only its own maximum and late observers cannot alter a finished slice', () => {
    const first = fixture()
    first.diagnostic.observeStatement(270, 'SELECT old', 20)
    first.diagnostic.observeStatement(280, 'UPDATE current SET value = ?', 21)
    first.diagnostic.observeStatement(275, 'DELETE FROM later', 22)
    first.diagnostic.finish({ count: 2, totalMs: 570, maxMs: 290 }, 590)
    first.diagnostic.observeStatement(900, 'SELECT after_settlement', 500)
    first.diagnostic.finish({ count: 3, totalMs: 1_470, maxMs: 900 }, 1_500)
    expect(first.lines).toHaveLength(1)
    expect(first.lines[0]?.fields).toMatchObject({
      slowestStatementKind: 'UPDATE',
      slowestStatementSql: 'UPDATE current SET value = ?',
      slowestStatementWallMs: 280,
      slowestStatementProcessCpuMs: 21,
      dbTransactionCount: 2,
      dbTransactionMsMax: 290,
    })

    const next = fixture({ runId: 'run-2', slice: 1, attempt: 1 })
    next.diagnostic.observeStatement(2, 'SELECT next_slice', 0)
    next.diagnostic.finish({ count: 0, totalMs: 0, maxMs: 0 }, 300)
    expect(next.lines[0]?.fields).toMatchObject({
      runId: 'run-2',
      slice: 1,
      attempt: 1,
      slowestStatementSql: 'SELECT next_slice',
      slowestStatementWallMs: 2,
      dbTransactionMsMax: 0,
    })
  })

  test('failure finalization measures elapsed slice wall and preserves unavailable CPU', () => {
    const { diagnostic, lines } = fixture({ now: () => 550 })
    diagnostic.observeStatement(320, 'INSERT INTO unique_values VALUES (?)', -1)
    diagnostic.finish({ count: 1, totalMs: 330, maxMs: 330 })
    expect(lines[0]?.fields).toMatchObject({
      workerSliceMs: 450,
      slowestStatementKind: 'INSERT',
      slowestStatementWallMs: 320,
      slowestStatementProcessCpuMs: null,
    })
  })

  test('slow work without statements has no invented SQL or CPU attribution', () => {
    const { diagnostic, lines } = fixture()
    diagnostic.finish(null, 300)
    expect(lines[0]?.fields).toMatchObject({
      workerSliceMs: 300,
      dbTransactionCount: 0,
      dbTransactionMsMax: 0,
      slowestStatementKind: null,
      slowestStatementSql: null,
      slowestStatementWallMs: 0,
      slowestStatementProcessCpuMs: null,
    })
  })

  test('diagnostic clock and sink failures never throw or repeat a report', () => {
    const clockFailure = fixture({
      now: () => {
        throw new Error('diagnostic clock failed')
      },
    })
    expect(() => clockFailure.diagnostic.finish(null)).not.toThrow()
    expect(clockFailure.lines).toEqual([])

    let writes = 0
    const diagnostic = createMaintenanceSliceDiagnostics({
      job: 'webhookDeliveryGc',
      runId: 'run',
      slice: 1,
      attempt: 1,
      startedAt: 0,
      log: {
        warn() {
          writes += 1
          throw new Error('diagnostic sink failed')
        },
      },
    })
    expect(() => diagnostic.finish(null, 300)).not.toThrow()
    expect(() => diagnostic.finish(null, 300)).not.toThrow()
    expect(writes).toBe(1)
  })
})
