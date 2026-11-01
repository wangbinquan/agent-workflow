// RFC-404: shared implementations that replaced call-node helpers in nodeMechanics.ts.
//   - the human-wait ledger: the call node now writes it through the same domain owner that the
//     resource-usage reader decodes it with; the oracle below is the deleted `parseCallLedger` /
//     `JSON.stringify(ledger)` pair verbatim, so the persisted bytes cannot drift.
//   - the call node's error decisions, moved to application so the engine body stays free of
//     `@/util/errors`.
import { describe, expect, test } from 'bun:test'
import {
  childCallRefusal,
  childLaunchFailureCode,
  isToleratedChildCancelRace,
} from '@/modules/task-execution/application/childCallErrors'
import {
  decodeCallHumanWait,
  encodeCallHumanWait,
} from '@/modules/task-execution/domain/resourceLimitUsage'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@/util/errors'

/** The deleted nodeMechanics.ts parser (commit 2874dd182), kept as the oracle. */
function historicalParseCallLedger(json: string | null): {
  callHumanWaitMs: number
  callHumanWaitSince: number | null
} {
  if (json === null || json === '') return { callHumanWaitMs: 0, callHumanWaitSince: null }
  try {
    const o = JSON.parse(json) as { callHumanWaitMs?: unknown; callHumanWaitSince?: unknown }
    return {
      callHumanWaitMs:
        typeof o.callHumanWaitMs === 'number' && o.callHumanWaitMs >= 0 ? o.callHumanWaitMs : 0,
      callHumanWaitSince:
        typeof o.callHumanWaitSince === 'number' && o.callHumanWaitSince > 0
          ? o.callHumanWaitSince
          : null,
    }
  } catch {
    return { callHumanWaitMs: 0, callHumanWaitSince: null }
  }
}

const LEDGER_INPUTS: (string | null)[] = [
  null,
  '',
  'null',
  '42',
  '"text"',
  '[]',
  '{',
  '{}',
  '{"callHumanWaitMs":70000}',
  '{"callHumanWaitMs":70000,"callHumanWaitSince":1790000000000}',
  '{"callHumanWaitSince":1790000000000,"callHumanWaitMs":5}',
  '{"callHumanWaitMs":-1,"callHumanWaitSince":0}',
  '{"callHumanWaitMs":"7","callHumanWaitSince":"8"}',
  '{"callHumanWaitMs":0,"callHumanWaitSince":-5,"extra":true}',
]

describe('RFC-404 call human-wait ledger has one owner', () => {
  test('decoding matches the deleted call-node parser on every historical shape', () => {
    for (const json of LEDGER_INPUTS) {
      const historical = historicalParseCallLedger(json)
      expect(decodeCallHumanWait(json), String(json)).toEqual({
        accumulatedMs: historical.callHumanWaitMs,
        openSince: historical.callHumanWaitSince,
      })
    }
  })

  test('encoding writes the historical bytes and round-trips', () => {
    for (const json of LEDGER_INPUTS) {
      const historical = historicalParseCallLedger(json)
      const wait = decodeCallHumanWait(json)
      expect(encodeCallHumanWait(wait)).toBe(JSON.stringify(historical))
      expect(decodeCallHumanWait(encodeCallHumanWait(wait))).toEqual(wait)
    }
    // The open-segment transitions the call node performs keep the key order.
    expect(encodeCallHumanWait({ accumulatedMs: 0, openSince: 1790000000000 })).toBe(
      '{"callHumanWaitMs":0,"callHumanWaitSince":1790000000000}',
    )
    expect(encodeCallHumanWait({ accumulatedMs: 1234, openSince: null })).toBe(
      '{"callHumanWaitMs":1234,"callHumanWaitSince":null}',
    )
  })
})

describe('RFC-404 call-node error decisions', () => {
  test('a failed launch settles with a domain error code, anything else is a generic launch failure', () => {
    expect(childLaunchFailureCode(new ValidationError('call-owner-inactive', 'm'))).toBe(
      'call-owner-inactive',
    )
    expect(childLaunchFailureCode(new NotFoundError('workflow-not-found', 'm'))).toBe(
      'workflow-not-found',
    )
    expect(childLaunchFailureCode(new DomainError('child-budget', 'm'))).toBe('child-budget')
    expect(childLaunchFailureCode(new ConflictError('task-active', 'm'))).toBe('task-active')
    for (const other of [new Error('boom'), new TypeError('broken adapter'), 'text', undefined])
      expect(childLaunchFailureCode(other)).toBe('child-launch-failed')
  })

  test('cancel cascade tolerates only an already-terminal or missing child', () => {
    expect(isToleratedChildCancelRace(new ConflictError('task-not-cancelable', 'm'))).toBe(true)
    expect(isToleratedChildCancelRace(new NotFoundError('task-not-found', 'm'))).toBe(true)
    expect(isToleratedChildCancelRace(new ConflictError('task-active', 'm'))).toBe(false)
    expect(isToleratedChildCancelRace(new DomainError('task-not-cancelable', 'm'))).toBe(false)
    expect(isToleratedChildCancelRace(new TypeError('missing driver method'))).toBe(false)
    expect(isToleratedChildCancelRace(new Error('boom'))).toBe(false)
  })

  test('refusals raised while assembling a launch carry their code into the launch failure', () => {
    for (const code of [
      'call-owner-inactive',
      'trigger-context-missing',
      'workflow-invalid',
    ] as const) {
      const refusal = childCallRefusal(code, `refused: ${code}`)
      expect(refusal).toBeInstanceOf(ValidationError)
      expect(refusal.message).toBe(`refused: ${code}`)
      expect(childLaunchFailureCode(refusal)).toBe(code)
    }
  })
})
