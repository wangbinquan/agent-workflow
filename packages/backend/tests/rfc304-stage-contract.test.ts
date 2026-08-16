// RFC-304 T4 — the stage contract's self-check.
//
// These assertions run at development time, which is the whole point: the
// sequence is fixed platform code, so nothing can mis-wire it at runtime. What
// this catches is a person adding or reordering a stage whose inputs nothing
// upstream produces — the failure that otherwise shows up as an empty artifact
// three stages later, on a real MR.
//
// The `invoke` arm gets the most attention here because it is the one that was
// missing entirely from the first draft (it lived in a comment while the union
// stayed three-armed), and because its failure modes are non-local: an inverted
// range or a recursive chain typechecks perfectly and only misbehaves when run.

import { describe, expect, test } from 'bun:test'
import {
  CODE_CAPABILITIES,
  validateStageContract,
  type CodeCapabilityId,
  type StageContract,
  type StageDef,
} from '../src/modules/code-capability/domain/stageContract'

const program = (name: string, requires: string[] = [], produces: string[] = []): StageDef => ({
  kind: 'program',
  name,
  requires,
  produces,
})

const contract = (capability: CodeCapabilityId, stages: StageDef[]): StageContract => ({
  capability,
  version: 1,
  stages,
})

const registryOf = (...contracts: StageContract[]) => {
  const byCapability = new Map(contracts.map((c) => [c.capability, c]))
  return (capability: CodeCapabilityId) => byCapability.get(capability)
}

describe('RFC-304 §4.1 — requires/produces closure', () => {
  test('a well-ordered sequence has no issues', () => {
    const c = contract('mr-review', [
      program('collect', [], ['diff']),
      program('shard', ['diff'], ['shards']),
      program('publish', ['shards'], []),
    ])
    expect(validateStageContract(c)).toEqual([])
  })

  test('a stage requiring something no upstream produces is reported', () => {
    const c = contract('mr-review', [
      program('collect', [], ['diff']),
      program('publish', ['findings'], []),
    ])
    const issues = validateStageContract(c)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe('stage-requires-unsatisfied')
    // The message must name both the stage and the missing artifact — "something
    // is unsatisfied" sends the reader back to re-derive what they already knew.
    expect(issues[0]?.message).toContain('publish')
    expect(issues[0]?.message).toContain('findings')
  })

  test('order matters: producing it LATER does not satisfy an earlier requirement', () => {
    // The subtle one. Both stages exist and the artifact name matches, so a
    // set-based check would pass — and the round would run `publish` against an
    // artifact that does not exist yet.
    const c = contract('mr-review', [
      program('publish', ['findings'], []),
      program('review', [], ['findings']),
    ])
    const issues = validateStageContract(c)
    expect(issues.map((i) => i.code)).toEqual(['stage-requires-unsatisfied'])
  })

  test('every unsatisfied requirement is reported, not just the first', () => {
    // Reordering a sequence usually breaks several at once; one-per-run turns a
    // five-minute fix into five edit/run cycles.
    const c = contract('ci-fix', [program('a', ['x'], []), program('b', ['y'], [])])
    expect(validateStageContract(c)).toHaveLength(2)
  })

  test('duplicate stage names are rejected because hooks mount by name', () => {
    const c = contract('ci-fix', [program('collect'), program('collect')])
    const issues = validateStageContract(c)
    expect(issues.map((i) => i.code)).toContain('stage-name-duplicate')
  })
})

describe('RFC-304 §4.1 — invoke ranges', () => {
  const reviewContract = contract('mr-review', [
    program('collect', [], ['diff']),
    program('review', ['diff'], ['findings']),
    program('resolve-positions', ['findings'], ['anchored']),
    program('publish', ['anchored'], []),
  ])

  test('a valid sub-range resolves', () => {
    const ciFix = contract('ci-fix', [
      program('fix', [], ['patch']),
      {
        kind: 'invoke',
        name: 'self-review',
        requires: ['patch'],
        produces: ['findings'],
        invokes: {
          capability: 'mr-review',
          from: 'collect',
          to: 'resolve-positions',
          worktreeFrom: 'worktree',
          diffLeftFrom: 'worktree',
        },
        collect: {},
      },
    ])
    expect(validateStageContract(ciFix, registryOf(reviewContract, ciFix))).toEqual([])
  })

  test('an unknown target capability is reported', () => {
    const c = contract('ci-fix', [
      {
        kind: 'invoke',
        name: 'self-review',
        requires: [],
        produces: [],
        invokes: {
          capability: 'mr-review',
          from: 'collect',
          to: 'publish',
          worktreeFrom: 'worktree',
          diffLeftFrom: 'worktree',
        },
        collect: {},
      },
    ])
    // Empty registry — the target was never registered.
    const issues = validateStageContract(c)
    expect(issues.map((i) => i.code)).toEqual(['invoke-target-unknown'])
  })

  test('a range naming a stage the target does not have is reported per endpoint', () => {
    const c = contract('ci-fix', [
      {
        kind: 'invoke',
        name: 'self-review',
        requires: [],
        produces: [],
        invokes: {
          capability: 'mr-review',
          from: 'nope',
          to: 'also-nope',
          worktreeFrom: 'worktree',
          diffLeftFrom: 'worktree',
        },
        collect: {},
      },
    ])
    const issues = validateStageContract(c, registryOf(reviewContract, c))
    expect(issues.filter((i) => i.code === 'invoke-range-unknown')).toHaveLength(2)
  })

  test('an inverted range is reported — it typechecks but can never run', () => {
    const c = contract('ci-fix', [
      {
        kind: 'invoke',
        name: 'self-review',
        requires: [],
        produces: [],
        invokes: {
          capability: 'mr-review',
          from: 'publish',
          to: 'collect',
          worktreeFrom: 'worktree',
          diffLeftFrom: 'worktree',
        },
        collect: {},
      },
    ])
    const issues = validateStageContract(c, registryOf(reviewContract, c))
    expect(issues.map((i) => i.code)).toContain('invoke-range-inverted')
  })

  test('direct self-invocation is a cycle', () => {
    const c: StageContract = {
      capability: 'ci-fix',
      version: 1,
      stages: [
        program('fix', [], ['patch']),
        {
          kind: 'invoke',
          name: 'self',
          requires: ['patch'],
          produces: [],
          invokes: {
            capability: 'ci-fix',
            from: 'fix',
            to: 'fix',
            worktreeFrom: 'worktree',
            diffLeftFrom: 'worktree',
          },
          collect: {},
        },
      ],
    }
    expect(validateStageContract(c, registryOf(c)).map((i) => i.code)).toContain('invoke-cycle')
  })

  test('an INDIRECT cycle (a → b → a) is caught too', () => {
    // Checking only the direct target would miss this, and two capabilities
    // that each "just self-review through the other" is a natural way to write
    // it. The round would recurse until something else ran out.
    const a: StageContract = {
      capability: 'ci-fix',
      version: 1,
      stages: [
        {
          kind: 'invoke',
          name: 'via-b',
          requires: [],
          produces: [],
          invokes: {
            capability: 'requirement',
            from: 'via-a',
            to: 'via-a',
            worktreeFrom: 'worktree',
            diffLeftFrom: 'worktree',
          },
          collect: {},
        },
      ],
    }
    const b: StageContract = {
      capability: 'requirement',
      version: 1,
      stages: [
        {
          kind: 'invoke',
          name: 'via-a',
          requires: [],
          produces: [],
          invokes: {
            capability: 'ci-fix',
            from: 'via-b',
            to: 'via-b',
            worktreeFrom: 'worktree',
            diffLeftFrom: 'worktree',
          },
          collect: {},
        },
      ],
    }
    expect(validateStageContract(a, registryOf(a, b)).map((i) => i.code)).toContain('invoke-cycle')
  })

  test('a non-recursive cross-capability invoke is NOT flagged', () => {
    // Reverse assertion: without it, a cycle check that returns true for
    // everything would pass every test above.
    const ciFix = contract('ci-fix', [
      {
        kind: 'invoke',
        name: 'self-review',
        requires: [],
        produces: [],
        invokes: {
          capability: 'mr-review',
          from: 'collect',
          to: 'review',
          worktreeFrom: 'worktree',
          diffLeftFrom: 'worktree',
        },
        collect: {},
      },
    ])
    const issues = validateStageContract(ciFix, registryOf(reviewContract, ciFix))
    expect(issues.map((i) => i.code)).not.toContain('invoke-cycle')
  })
})

describe('RFC-304 §4.1 — the union itself carries the constitution', () => {
  test('the five capabilities are the closed set', () => {
    expect([...CODE_CAPABILITIES]).toEqual([
      'mr-review',
      'mr-comment-fix',
      'requirement',
      'ci-fix',
      'mr-monitor',
    ])
  })

  test('source lock: an ai stage cannot be declared without a schema', () => {
    // Constitution R3 is enforced by the TYPE, not by a runtime check — a
    // schema-less AI stage is a hole through the determinism guarantee, so it
    // must be unrepresentable rather than merely rejected. Types leave no
    // runtime trace, so this asserts on the source that the field is required
    // (no `?`) inside the ai arm.
    const src = Bun.file(
      new URL('../src/modules/code-capability/domain/stageContract.ts', import.meta.url),
    )
    return src.text().then((text) => {
      const aiArm = text.slice(text.indexOf("kind: 'ai'"), text.indexOf("kind: 'invoke'"))
      expect(aiArm).toContain('aiSchema: AiEnvelopeSchema')
      expect(aiArm).not.toContain('aiSchema?:')
    })
  })
})
