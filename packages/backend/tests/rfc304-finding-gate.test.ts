// RFC-304 §6 T26 — the gate: how many remarks a person actually sees.
//
// The order of the three steps is load-bearing, and each test below is about
// what goes wrong if it changes:
//
//   sort → filter → truncate
//
// Truncating an UNSORTED list makes the surviving findings depend on whatever
// order the model happened to emit them in, so two identical rounds show
// different remarks and the cap keeps an arbitrary sample instead of the most
// severe ones.
//
// And the withheld counts are not decoration: a review that silently shows 20
// of 63 problems tells the author their code has 20 problems. Next round, after
// they fix those, "new" findings appear that were there all along — which reads
// as the bot being erratic rather than as the cap doing its job.

import { describe, expect, test } from 'bun:test'
import {
  applyGate,
  compareFindings,
  describeWithheld,
  meetsThreshold,
  type FindingSeverity,
  type GateableFinding,
} from '../src/modules/code-capability/domain/findingGate'

const f = (severity: FindingSeverity, file = 'src/a.ts', line = 1): GateableFinding => ({
  severity,
  file,
  line,
})

describe('RFC-304 T26 — deterministic ordering', () => {
  test('severity leads, so the cap keeps the most severe', () => {
    const sorted = [f('minor'), f('blocker'), f('info'), f('major')].sort(compareFindings)
    expect(sorted.map((x) => x.severity)).toEqual(['blocker', 'major', 'minor', 'info'])
  })

  test('same severity sorts by file, then line', () => {
    const sorted = [
      f('major', 'src/b.ts', 5),
      f('major', 'src/a.ts', 20),
      f('major', 'src/a.ts', 3),
    ].sort(compareFindings)
    expect(sorted.map((x) => `${x.file}:${String(x.line)}`)).toEqual([
      'src/a.ts:3',
      'src/a.ts:20',
      'src/b.ts:5',
    ])
  })

  test('the comparison is TOTAL — no pair is left unordered', () => {
    // A partial order lets two runs over the same findings produce different
    // sequences, and the ledger's cross-round comparison then reports changes
    // that did not happen.
    const a = f('major', 'src/a.ts', 7)
    const b = f('major', 'src/a.ts', 7)
    expect(compareFindings(a, b)).toBe(0)
    expect(compareFindings(f('major', 'a', 1), f('major', 'b', 1))).toBeLessThan(0)
    expect(compareFindings(f('major', 'b', 1), f('major', 'a', 1))).toBeGreaterThan(0)
  })

  test('the gate does not mutate its input', () => {
    // A round has to be replayable; sorting the caller's array in place would
    // make a re-run see a different starting order.
    const input = [f('minor'), f('blocker')]
    const snapshot = [...input]
    applyGate(input, { threshold: 'info', maxPerRound: 10 })
    expect(input).toEqual(snapshot)
  })
})

describe('RFC-304 T26 — the threshold', () => {
  test('a severity at the threshold passes; below it does not', () => {
    expect(meetsThreshold('major', 'major')).toBe(true)
    expect(meetsThreshold('blocker', 'major')).toBe(true)
    expect(meetsThreshold('minor', 'major')).toBe(false)
  })

  test('filtered findings are counted, not silently dropped', () => {
    const result = applyGate([f('blocker'), f('minor'), f('info')], {
      threshold: 'major',
      maxPerRound: 10,
    })
    expect(result.published).toHaveLength(1)
    expect(result.belowThreshold).toBe(2)
  })

  test('the lowest threshold lets everything through', () => {
    const result = applyGate([f('blocker'), f('info')], { threshold: 'info', maxPerRound: 10 })
    expect(result.published).toHaveLength(2)
    expect(result.belowThreshold).toBe(0)
  })
})

describe('RFC-304 T26 — the cap, and saying what it withheld', () => {
  test('truncation keeps the most severe because sorting ran first', () => {
    // The property that makes the cap defensible. Cutting an unsorted list
    // would keep whichever findings the model happened to emit first.
    const result = applyGate([f('info'), f('minor'), f('blocker'), f('major')], {
      threshold: 'info',
      maxPerRound: 2,
    })
    expect(result.published.map((x) => x.severity)).toEqual(['blocker', 'major'])
    expect(result.truncated).toBe(2)
  })

  test('truncated and belowThreshold are counted separately', () => {
    // They mean different things to the author: one is "not worth your time at
    // your level", the other is "there are MORE at your level than fit".
    const result = applyGate([f('blocker'), f('blocker'), f('minor')], {
      threshold: 'major',
      maxPerRound: 1,
    })
    expect(result.published).toHaveLength(1)
    expect(result.truncated).toBe(1)
    expect(result.belowThreshold).toBe(1)
  })

  test('the overview line distinguishes the two', () => {
    const line = describeWithheld({ published: [], truncated: 3, belowThreshold: 5 }, 'major')
    expect(line).toContain('3 more finding(s) at or above major')
    expect(line).toContain('5 finding(s) below major')
  })

  test('nothing withheld ⇒ no line at all', () => {
    // An empty "0 hidden" note is noise on a clean review.
    expect(describeWithheld({ published: [], truncated: 0, belowThreshold: 0 }, 'major')).toBe('')
  })

  test('a cap larger than the list publishes everything', () => {
    const result = applyGate([f('major')], { threshold: 'info', maxPerRound: 100 })
    expect(result.published).toHaveLength(1)
    expect(result.truncated).toBe(0)
  })

  test('a zero cap publishes nothing and reports all of it as truncated', () => {
    const result = applyGate([f('blocker'), f('major')], { threshold: 'info', maxPerRound: 0 })
    expect(result.published).toEqual([])
    expect(result.truncated).toBe(2)
  })

  test('a negative cap behaves as zero, not as slice-from-the-end', () => {
    // `slice(0, -1)` would drop the LAST finding and publish the rest — a
    // config typo would then quietly publish almost everything.
    const result = applyGate([f('blocker'), f('major')], { threshold: 'info', maxPerRound: -1 })
    expect(result.published).toEqual([])
    expect(result.truncated).toBe(2)
  })

  test('an empty round is a clean pass, not an error', () => {
    const result = applyGate([], { threshold: 'major', maxPerRound: 10 })
    expect(result).toEqual({ published: [], belowThreshold: 0, truncated: 0 })
  })
})
