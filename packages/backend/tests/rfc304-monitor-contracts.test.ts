// RFC-304 T35/T37 — the script contracts and the default priority.
//
// Pure functions and schemas, tested without a database or a subprocess,
// because the rules are the interesting part and they should be readable
// without either. `rfc304-monitor-scripts.test.ts` covers the same schemas
// through a real script; this file covers what they ACCEPT and REJECT, which is
// where an adapter author meets them.

import { describe, expect, test } from 'bun:test'
import {
  CollectResultSchema,
  ClassifiedIssuesSchema,
  WorkPackageSchema,
  WorkPackagesSchema,
  AgentPlanSchema,
  DEFAULT_CI_PRIORITY,
  DEFAULT_MONITOR_PRIORITY,
  ciPriorityRank,
  defaultArbitrate,
  isSingleCapabilityBatch,
  type ClassifiedIssue,
  type CollectResult,
} from '../src/modules/code-capability/domain/monitorContracts'

const collect = (over: Partial<CollectResult> = {}): CollectResult => ({
  conflict: false,
  unresolvedComments: [],
  gate: { status: 'pass' },
  headSha: 'sha-1',
  ...over,
})

const issue = (type: string): ClassifiedIssue => ({ type, message: `${type} failed` })

describe('RFC-304 T35 — contract shapes', () => {
  test('a gate that could not be read is `unknown`, not `fail`', () => {
    // The distinction is load-bearing: an outage in the pipeline system that
    // reported as `fail` would turn into a storm of CI-fix rounds against merge
    // requests whose pipelines are fine.
    expect(CollectResultSchema.safeParse(collect({ gate: { status: 'unknown' } })).success).toBe(
      true,
    )
    expect(
      CollectResultSchema.safeParse(collect({ gate: { status: 'green' } as never })).success,
    ).toBe(false)
  })

  test('an unmodelled field is rejected rather than ignored', () => {
    // `.strict()`: an adapter reporting something the platform does not model
    // should hear about it, not have it silently dropped and then wonder why
    // the monitor ignored it.
    const parsed = CollectResultSchema.safeParse({ ...collect(), approvals: 2 })
    expect(parsed.success).toBe(false)
  })

  test('a comment anchor is optional but a thread id is not', () => {
    // An unanchored comment is ordinary (an MR-level remark). A comment with no
    // thread id cannot be replied to or resolved, so it is not usable input.
    expect(
      CollectResultSchema.safeParse(
        collect({
          unresolvedComments: [{ threadId: 't1', author: 'ann', body: 'why?' }],
        }),
      ).success,
    ).toBe(true)
    expect(
      CollectResultSchema.safeParse(
        collect({
          unresolvedComments: [{ threadId: '', author: 'ann', body: 'why?' }],
        }),
      ).success,
    ).toBe(false)
  })

  test('a classified issue may omit its location but never its message', () => {
    expect(ClassifiedIssuesSchema.safeParse([{ type: 'compile', message: 'boom' }]).success).toBe(
      true,
    )
    expect(ClassifiedIssuesSchema.safeParse([{ type: 'compile', message: '' }]).success).toBe(false)
  })

  test('a `noop` package must say why', () => {
    // The reason IS the observation's content — it is what an operator reads to
    // find out what the monitor concluded. An empty one makes the record
    // useless while still looking like it worked.
    expect(
      WorkPackageSchema.safeParse({ capability: 'noop', reason: '', observedRevision: 'x' })
        .success,
    ).toBe(false)
    expect(
      WorkPackageSchema.safeParse({ capability: 'noop', reason: 'quiet', observedRevision: 'x' })
        .success,
    ).toBe(true)
  })

  test('a capability the platform cannot run yet is refused at the schema', () => {
    // v1 executes `noop` and `mr-review`. Admitting `ci-fix` here would let an
    // arbitration script select work that fails at round start with "no such
    // sequence", which reads as the platform being broken rather than as a
    // capability that has not shipped.
    expect(
      WorkPackageSchema.safeParse({ capability: 'ci-fix', items: [{ issueRef: 'r' }] }).success,
    ).toBe(false)
  })

  test('an agent plan maps slots to agents', () => {
    expect(AgentPlanSchema.safeParse({ bySlot: { reviewer: { agent: 'auditor' } } }).success).toBe(
      true,
    )
    expect(AgentPlanSchema.safeParse({ bySlot: { reviewer: { agent: '' } } }).success).toBe(false)
  })
})

describe('RFC-304 T37 — the default priority', () => {
  test('the documented order is the implemented order', () => {
    // Asserted against the constants rather than restated, so a change to the
    // policy has to be a deliberate edit in one place.
    expect([...DEFAULT_MONITOR_PRIORITY]).toEqual(['conflict', 'comment', 'ci'])
    expect([...DEFAULT_CI_PRIORITY]).toEqual(['compile', 'codecheck', 'unit-test'])
  })

  test('compile outranks codecheck outranks unit-test', () => {
    // A compile failure makes the other two unmeasurable, so fixing them first
    // produces work that has to be redone.
    expect(ciPriorityRank('compile')).toBeLessThan(ciPriorityRank('codecheck'))
    expect(ciPriorityRank('codecheck')).toBeLessThan(ciPriorityRank('unit-test'))
  })

  test('an issue type the platform has no opinion about sorts LAST', () => {
    // The alternative — unknown sorts first — lets a framework jump its own
    // classifications ahead of a compile break just by naming them something
    // new.
    expect(ciPriorityRank('flaky-integration')).toBeGreaterThan(ciPriorityRank('unit-test'))
  })

  test('a conflict outranks everything, and is never a work package', () => {
    const packages = defaultArbitrate(
      collect({
        conflict: true,
        unresolvedComments: [{ threadId: 't', author: 'a', body: 'b' }],
        gate: { status: 'fail' },
      }),
      [issue('compile')],
    )
    expect(packages).toHaveLength(1)
    expect(packages[0]?.capability).toBe('noop')
    // Reported, never fixed (N1/E10) — so the reason names the conflict even
    // though comments and a red gate were also present.
    expect(packages[0]?.capability === 'noop' && packages[0].reason).toContain('conflict')
  })

  test('comments outrank a failing gate', () => {
    // A person is waiting at the other end of a comment; a red pipeline is
    // waiting on nobody.
    const packages = defaultArbitrate(
      collect({
        unresolvedComments: [{ threadId: 't', author: 'a', body: 'b' }],
        gate: { status: 'fail' },
      }),
      [issue('compile')],
    )
    expect(packages[0]?.capability === 'noop' && packages[0].reason).toContain('comment')
  })

  test('a failing gate names the highest-priority failure it was given', () => {
    const packages = defaultArbitrate(collect({ gate: { status: 'fail' } }), [
      issue('unit-test'),
      issue('compile'),
      issue('codecheck'),
    ])
    expect(packages[0]?.capability === 'noop' && packages[0].reason).toContain('compile')
  })

  test('a failing gate nobody classified says so, rather than inventing work', () => {
    const packages = defaultArbitrate(collect({ gate: { status: 'fail' } }), [])
    expect(packages[0]?.capability === 'noop' && packages[0].reason).toContain('nothing classified')
  })

  test('an unreadable gate is not treated as a failing one', () => {
    // `unknown` must not produce the same output as `fail`, or a pipeline
    // outage becomes a wave of repair attempts.
    const unknown = defaultArbitrate(collect({ gate: { status: 'unknown' } }), [])
    const failing = defaultArbitrate(collect({ gate: { status: 'fail' } }), [])
    expect(unknown[0]?.capability === 'noop' && unknown[0].reason).toBe(
      'nothing outstanding on this merge request',
    )
    expect(failing[0]?.capability === 'noop' && failing[0].reason).not.toBe(
      'nothing outstanding on this merge request',
    )
  })

  test('a healthy merge request arbitrates to `noop`, never to a review', () => {
    // The 150-a-day case. Returning `mr-review` here would post "no new
    // findings this round" on 150 merge requests nobody touched.
    const packages = defaultArbitrate(collect(), [])
    expect(packages[0]?.capability).toBe('noop')
    expect(packages[0]?.capability === 'noop' && packages[0].observedRevision).toBe('sha-1')
  })
})

describe('RFC-304 T38 — one round, one capability', () => {
  test('a mixed batch is detected even though each element type-checks', () => {
    const mixed = WorkPackagesSchema.parse([
      { capability: 'noop', reason: 'nothing', observedRevision: 'x' },
      { capability: 'mr-review', items: [] },
    ])
    expect(isSingleCapabilityBatch(mixed)).toBe(false)
  })

  test('an empty or single-element batch is trivially single-capability', () => {
    expect(isSingleCapabilityBatch([])).toBe(true)
    expect(isSingleCapabilityBatch([{ capability: 'mr-review', items: [] }])).toBe(true)
  })

  test('several packages of the same capability are one batch', () => {
    expect(
      isSingleCapabilityBatch([
        { capability: 'mr-review', items: [], note: 'a' },
        { capability: 'mr-review', items: [], note: 'b' },
      ]),
    ).toBe(true)
  })
})
