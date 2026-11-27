// RFC-616 §4.1 — locks the classification of every rerun cause for process
// metrics, the placeholder rule of manual retries, and the shared heat bins.
//
// Why this file exists: a rerun cause that is added to RERUN_CAUSES but not
// classified here must fail the build, and a classification that drifts (for
// instance counting the `retry-node` placeholder as an execution again) would
// silently invent failures in every workflow's metrics.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MANUAL_RETRY_RERUN_CAUSE,
  PROCESS_CAUSES,
  PROCESS_CAUSE_GROUPS,
  PROCESS_CAUSE_GROUP_OF,
  PROCESS_CAUSE_OF,
  PROCESS_HINT_IDS,
  PROCESS_METRIC_BETTER,
  PROCESS_METRIC_IDS,
  PROCESS_OPERATION_ACTIONS,
  ProcessSummaryQuerySchema,
  ProcessUnitsQuerySchema,
  RERUN_CAUSES,
  processCauseOf,
  processRankBins,
} from '../src'

describe('RFC-616 execution causes', () => {
  test('every rerun cause is classified, and nothing else is', () => {
    expect(Object.keys(PROCESS_CAUSE_OF).sort()).toEqual([...RERUN_CAUSES].sort())
    for (const cause of RERUN_CAUSES) {
      const classified = PROCESS_CAUSE_OF[cause]
      expect(classified === null || PROCESS_CAUSES.includes(classified), cause).toBe(true)
    }
  })

  test('the table is checked for exhaustiveness at compile time', () => {
    const source = readFileSync(join(import.meta.dir, '../src/processCause.ts'), 'utf8')
    expect(source).toContain('as const satisfies Record<RerunCause, ProcessCause | null>')
  })

  test('first executions, rework, reruns after answers, automatic retries', () => {
    for (const cause of [
      'initial',
      'wrapper-init',
      'fanout-shard',
      'fanout-aggregator',
      'wg-leader-round',
      'wg-assignment',
      'wg-message-turn',
      'dw-generate',
    ] as const)
      expect(PROCESS_CAUSE_OF[cause], cause).toBe('first')
    expect(PROCESS_CAUSE_OF['review-iterate']).toBe('review-rework')
    expect(PROCESS_CAUSE_OF['review-reject']).toBe('review-rework')
    expect(PROCESS_CAUSE_OF['clarify-answer']).toBe('clarify-rerun')
    expect(PROCESS_CAUSE_OF['cross-clarify-answer']).toBe('clarify-rerun')
    expect(PROCESS_CAUSE_OF['cross-clarify-questioner-rerun']).toBe('clarify-rerun')
    expect(PROCESS_CAUSE_OF['process-retry']).toBe('auto-retry')
    expect(PROCESS_CAUSE_OF['wg-protocol-retry']).toBe('auto-retry')
    expect(PROCESS_CAUSE_OF['stale-redispatch']).toBe('cascade')
    expect(PROCESS_CAUSE_OF.revival).toBe('recovery')
    expect(PROCESS_CAUSE_OF['commit-push-session']).toBe('system')
    expect(PROCESS_CAUSE_OF['merge-resolve']).toBe('system')
  })

  test('placeholder, container, park and virtual rows are not executions', () => {
    for (const cause of [
      'retry-node',
      'retry-node-cascade',
      'commit-push',
      'review-park',
      'clarify-park',
      'cross-clarify-park',
      'io-virtual',
      'branch-skip',
      'cross-clarify-guard',
      'wg-gate',
      'dw-gate',
    ] as const)
      expect(PROCESS_CAUSE_OF[cause], cause).toBeNull()
    expect(MANUAL_RETRY_RERUN_CAUSE).toBe('retry-node')
  })

  test('a missing or unknown cause counts as a first execution', () => {
    expect(processCauseOf(null)).toBe('first')
    expect(processCauseOf(undefined)).toBe('first')
    expect(processCauseOf('')).toBe('first')
    expect(processCauseOf('a-cause-this-build-does-not-know')).toBe('first')
    expect(processCauseOf('review-park')).toBeNull()
    expect(processCauseOf('revival')).toBe('recovery')
    // An inherited object key must not be mistaken for a rerun cause.
    expect(processCauseOf('toString')).toBe('first')
  })

  test('seven internal classes fold into the six shown to people', () => {
    expect(Object.keys(PROCESS_CAUSE_GROUP_OF).sort()).toEqual([...PROCESS_CAUSES].sort())
    expect(new Set(Object.values(PROCESS_CAUSE_GROUP_OF))).toEqual(new Set(PROCESS_CAUSE_GROUPS))
    expect(PROCESS_CAUSE_GROUP_OF.cascade).toBe('other-rerun')
    expect(PROCESS_CAUSE_GROUP_OF.recovery).toBe('other-rerun')
    expect(PROCESS_CAUSE_GROUPS).toHaveLength(6)
  })
})

describe('RFC-616 heat bins', () => {
  test('bins follow rank, so one extreme value does not flatten the rest', () => {
    expect(processRankBins([1, 2, 3, 4, 1000])).toEqual([1, 2, 3, 4, 5])
    expect(processRankBins([10, 20])).toEqual([1, 5])
    expect(processRankBins([5, 5, 9])).toEqual([1, 1, 5])
  })

  test('a single value sits in the middle; not applicable has no bin', () => {
    expect(processRankBins([7])).toEqual([3])
    expect(processRankBins([7, 7, null])).toEqual([3, 3, 0])
    expect(processRankBins([null, null])).toEqual([0, 0])
    expect(processRankBins([])).toEqual([])
  })

  test('three distinct values use the first, middle and last bin', () => {
    expect(processRankBins([3, 1, 2])).toEqual([5, 1, 3])
  })
})

describe('RFC-616 contract vocabulary', () => {
  test('every metric says which direction is better', () => {
    expect(Object.keys(PROCESS_METRIC_BETTER).sort()).toEqual([...PROCESS_METRIC_IDS].sort())
  })

  test('the closed sets have no duplicates', () => {
    for (const list of [PROCESS_HINT_IDS, PROCESS_OPERATION_ACTIONS, PROCESS_METRIC_IDS])
      expect(new Set(list).size).toBe(list.length)
    expect(PROCESS_OPERATION_ACTIONS).toHaveLength(19)
  })

  test('summary query: defaults, window limit and the revision split', () => {
    const day = 86_400_000
    expect(ProcessSummaryQuerySchema.parse({ from: '0', to: String(day) })).toEqual({
      from: 0,
      to: day,
      tzOffset: 0,
      compare: 'off',
    })
    expect(ProcessSummaryQuerySchema.safeParse({ from: 0, to: 367 * day }).success).toBe(false)
    expect(ProcessSummaryQuerySchema.safeParse({ from: 5, to: 5 }).success).toBe(false)
    expect(
      ProcessSummaryQuerySchema.safeParse({ from: 0, to: day, compare: 'version' }).success,
    ).toBe(false)
    expect(
      ProcessSummaryQuerySchema.parse({ from: 0, to: day, compare: 'version', split: '57' }).split,
    ).toBe(57)
    expect(ProcessSummaryQuerySchema.safeParse({ from: 0, to: day, origin: 'nope' }).success).toBe(
      false,
    )
  })

  test('units query defaults to every unit', () => {
    expect(ProcessUnitsQuerySchema.parse({ from: 0, to: 1 }).status).toBe('all')
    expect(ProcessUnitsQuerySchema.safeParse({ from: 0, to: 1, status: 'done' }).success).toBe(
      false,
    )
  })
})
