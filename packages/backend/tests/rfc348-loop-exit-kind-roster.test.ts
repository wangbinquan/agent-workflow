// RFC-348 D1b — the runtime parser consumes the shared roster: every roster kind
// parses with its minimal valid payload, and a kind outside the roster is
// rejected before any per-variant field check runs. (The two-way type equality
// between `ExitCondition['kind']` and `LoopExitConditionKind` is a compile-time
// lock inside loopExitCondition.ts; this is its runtime twin.)
import { describe, expect, test } from 'bun:test'
import { LOOP_EXIT_CONDITION_KINDS } from '@agent-workflow/shared'
import { parseExitCondition } from '../src/modules/task-execution/domain/loopExitCondition'

const minimalPayload = (kind: string): Record<string, unknown> => {
  const base = { kind, nodeId: 'agent', portName: 'findings' }
  if (kind === 'port-equals') return { ...base, value: 'done' }
  if (kind === 'port-count-lt') return { ...base, n: 2 }
  return base
}

describe('RFC-348 parseExitCondition ↔ LOOP_EXIT_CONDITION_KINDS', () => {
  test('every roster kind parses (port-inactive included)', () => {
    for (const kind of LOOP_EXIT_CONDITION_KINDS) {
      const parsed = parseExitCondition(minimalPayload(kind))
      expect(parsed, `kind ${kind} must parse`).not.toBeNull()
      expect(parsed?.kind).toBe(kind)
    }
  })

  test('a kind outside the roster is rejected even with otherwise valid fields', () => {
    expect(parseExitCondition({ kind: 'port-nonexistent', nodeId: 'a', portName: 'p' })).toBeNull()
  })
})
