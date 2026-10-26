// RFC-395 II-b W0: system-operations/A implement and inject; N/C consume. Locks V3 semantics.
import { describe, expect, expectTypeOf, test } from 'bun:test'
import type { PersistedHistoryRestriction } from '@/platform/persistence/migration/run/types'
import {
  historyRestrictionDecision,
  type HistoryRestrictionPort,
  type HistoryRestrictionRecord,
  type HistoryRestrictionRequest,
} from '@/platform/contracts/historyRestriction'
import { createHistoryRestrictionBindings } from '@/bootstrap/historyRestrictions'
import { readFileSync } from 'node:fs'

const record = (history: HistoryRestrictionRecord['history']): HistoryRestrictionRecord => ({
  runId: 'migration-run',
  unitId: 'migration-unit',
  ordinal: 0,
  sourceTable: 'node_runs',
  sourcePhase: 'current',
  sourceKey: 'mk1:node-run',
  decisionCode: 'history-only',
  history,
})

describe('RFC-395 W0 history restrictions', () => {
  test('the live daemon passes the common binding to node and gate consumers', () => {
    const application = readFileSync(
      new URL('../src/bootstrap/daemonApplication.ts', import.meta.url),
      'utf8',
    )
    expect(application).toContain('createHistoryRestrictionBindings(historyRestrictions)')
    expect(application).toMatch(
      /composeDaemonTaskExecutionModules\(\{\s*db: input\.db,\s*content,\s*historyRestrictions: nodeRunHistoryRestrictions,/,
    )
    expect(application).toMatch(
      /composeDaemonDigitalEmployeeModules\(\{\s*historyRestrictions: nodeRunHistoryRestrictions,/,
    )
    expect(application).toMatch(
      /composeProviderAppComposition\(\{\s*historyRestrictions: gateHistoryRestrictions,/,
    )
  })

  test('records remain exactly V3-shaped, with separate migration and node run identities', () => {
    expectTypeOf<HistoryRestrictionRecord>().toEqualTypeOf<PersistedHistoryRestriction>()
    const restriction = record({
      taskId: 'task',
      runId: 'node-run',
      execution: 'retryable-history',
      missingFields: ['slot_key'],
    })
    expect(restriction.runId).toBe('migration-run')
    expect(restriction.history.runId).toBe('node-run')
    expect(historyRestrictionDecision([restriction])).toEqual({
      allowed: false,
      code: 'history-only',
      restrictions: [restriction],
    })
  })

  test('terminal and executable-but-unused evidence both refuse execution', () => {
    for (const history of [
      { taskId: 'task', runId: null, execution: 'terminal-history', missingFields: ['workspace'] },
      {
        taskId: 'task',
        runId: 'unselected',
        execution: 'executable',
        executionUse: 'none',
        reason: 'null-envelope-nonce-unselected',
        missingFields: ['envelope_nonce'],
      },
    ] as const) {
      const restriction = record(history)
      const result = historyRestrictionDecision([restriction])
      expect(result.allowed).toBe(false)
      if (!result.allowed) expect(result.restrictions[0]).toBe(restriction)
    }
  })

  test('empty matched evidence allows execution and nonempty evidence is retained without mutating input', () => {
    expect(historyRestrictionDecision([])).toEqual({ allowed: true })
    const a = record({
      taskId: 'a',
      runId: 'run-a',
      execution: 'retryable-history',
      missingFields: [],
    })
    const b = record({ taskId: 'b', runId: null, execution: 'terminal-history', missingFields: [] })
    const input = Object.freeze([a, b])
    const decision = historyRestrictionDecision(input)
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.restrictions).toEqual([a, b])
      expect(decision.restrictions).not.toBe(input)
    }
  })

  test('bootstrap exposes the required provider to both consumers without invoking it', () => {
    let calls = 0
    const provider: HistoryRestrictionPort = {
      check: () => {
        calls += 1
        return Promise.resolve({ allowed: true })
      },
    }
    const bindings = createHistoryRestrictionBindings(provider)
    expect(bindings.nodeRunHistoryRestrictions).toBe(provider)
    expect(bindings.gateHistoryRestrictions).toBe(provider)
    expect(Object.isFrozen(bindings)).toBe(true)
    expect(calls).toBe(0)
    expectTypeOf<HistoryRestrictionRequest['action']>().toEqualTypeOf<
      'resume' | 'retry' | 'replay'
    >()
    expectTypeOf<
      Extract<HistoryRestrictionRequest, { action: 'replay' }>['gates'][0]['sourceTable']
    >().toEqualTypeOf<'clarify_rounds' | 'collaboration_gate_operations'>()
  })
})
