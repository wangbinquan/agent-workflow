// Regression guard: reading merge request facts for a digital employee's work item collects again
// when the source reports that a branch moved between its two reads.
//
// 2026-11-27, a real case on GitLab (recorded in design/RFC-616-process-metrics/plan.md §4.7): the
// employee pushed its repair commit and went straight on to "reply with repair result". That work
// item refreshes the review threads first; the refresh ran while the merge request's head was
// changing from the old commit to the one the employee had just pushed. The source drops such a
// snapshot (`mr-facts-head-race`) and its contract is that the caller collects again
// (modules/integration/application/mrFacts.ts, file header). The read returned the failure as it
// was, the work item treated it as blocked, and the case stopped until a person resumed it; the
// reply was never posted. The read now collects again, a bounded number of times.
import { describe, expect, test } from 'bun:test'
import { createDevelopmentMrFacts } from '@/modules/development-automation/application/developmentMrFacts'
import type { DevelopmentMrFactsSourcePort } from '@/modules/development-automation/application/ports/developmentDelivery'

type Answer = Awaited<ReturnType<DevelopmentMrFactsSourcePort['collect']>>

const SNAPSHOT = {
  mrRef: '7',
  headSha: 'b'.repeat(40),
  targetSha: 'c'.repeat(40),
  targetBranch: 'main',
  state: 'opened' as const,
  draft: false,
  mergeableState: 'mergeable' as const,
  approvalHold: null,
  mergedCommitSha: null,
  mergedAt: null,
  threads: [],
}
const ok: Answer = { ok: true, snapshot: SNAPSHOT }
const headRace: Answer = {
  ok: false,
  code: 'mr-facts-head-race',
  detail: `head moved during collection (${'a'.repeat(40)} -> ${'b'.repeat(40)})`,
}
const targetRace: Answer = {
  ok: false,
  code: 'mr-facts-target-race',
  detail: 'target moved during collection',
}

/** A source that gives the listed answers in order, then keeps giving the last one. */
function source(answers: readonly Answer[]): DevelopmentMrFactsSourcePort & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    collect: async (repositoryId, mrRef, options) => {
      calls.push(`${repositoryId} ${mrRef} ${options.selfMarker}`)
      return answers[Math.min(calls.length, answers.length) - 1]!
    },
  }
}
const read = (facts: DevelopmentMrFactsSourcePort) =>
  createDevelopmentMrFacts({ mrFacts: facts }).collect('repo-1', '7', 'case-1')

describe('development MR facts: a branch that moved during the read is collected again', () => {
  test('the head moved once (the employee has just pushed): the second read is the answer', async () => {
    const facts = source([headRace, ok])
    const out = await read(facts)
    expect(out.ok).toBe(true)
    expect(out.ok && out.snapshot.headSha).toBe(SNAPSHOT.headSha)
    // Same repository, merge request and self marker on the second read.
    expect(facts.calls).toEqual(['repo-1 7 case-1', 'repo-1 7 case-1'])
  })

  test('the target branch moved: collected again the same way', async () => {
    const facts = source([targetRace, ok])
    expect((await read(facts)).ok).toBe(true)
    expect(facts.calls).toHaveLength(2)
  })

  test('a head race followed by a target race still ends in a snapshot on the third read', async () => {
    const facts = source([headRace, targetRace, ok])
    expect((await read(facts)).ok).toBe(true)
    expect(facts.calls).toHaveLength(3)
  })

  test('a branch that keeps moving is reported after three reads, with the last failure unchanged', async () => {
    const facts = source([headRace, headRace, targetRace])
    expect(await read(facts)).toBe(targetRace)
    expect(facts.calls).toHaveLength(3)
  })

  test('any other failure is returned at once: reading again cannot change it', async () => {
    for (const code of [
      'mr-facts-lookup-failed',
      'code-host-connection-missing',
      'mr-facts-head-race-like',
    ]) {
      const failure: Answer = { ok: false, code, detail: 'nope' }
      const facts = source([failure, ok])
      expect(await read(facts)).toBe(failure)
      expect(facts.calls).toHaveLength(1)
    }
  })

  test('a first read that succeeds is not repeated', async () => {
    const facts = source([ok, headRace])
    expect((await read(facts)).ok).toBe(true)
    expect(facts.calls).toHaveLength(1)
  })
})
