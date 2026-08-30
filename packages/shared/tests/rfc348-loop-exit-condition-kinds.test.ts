// RFC-348 D1b — `LOOP_EXIT_CONDITION_KINDS` is the single source for wrapper-loop
// exit-condition kinds. Before it existed the roster was hand-copied in four
// places and the canvas inspector / i18n / intent builder all stopped at four
// kinds while the runtime already accepted `port-inactive` (RFC-306). This test
// locks the roster's membership and the zod enum derived from it; the runtime
// parser ↔ roster equality is a compile-time lock in
// `modules/task-execution/domain/loopExitCondition.ts`, and the consumer-side
// locks (inspector dropdown, help text, INTENT.md) live in their own suites.
import { describe, expect, test } from 'bun:test'
import { LOOP_EXIT_CONDITION_KINDS, LoopExitConditionKindSchema } from '../src'

describe('RFC-348 LOOP_EXIT_CONDITION_KINDS roster', () => {
  test('contains the five kinds the runtime parser understands, port-inactive included', () => {
    expect([...LOOP_EXIT_CONDITION_KINDS]).toEqual([
      'port-empty',
      'port-not-empty',
      'port-equals',
      'port-count-lt',
      'port-inactive',
    ])
  })

  test('the derived enum accepts every roster kind and rejects anything else', () => {
    for (const kind of LOOP_EXIT_CONDITION_KINDS) {
      expect(LoopExitConditionKindSchema.safeParse(kind).success).toBe(true)
    }
    expect(LoopExitConditionKindSchema.safeParse('port-nonexistent').success).toBe(false)
    expect(LoopExitConditionKindSchema.safeParse('').success).toBe(false)
  })
})
