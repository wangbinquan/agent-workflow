// RFC-304 — running another capability's stages inline (`kind: 'invoke'`).
//
// `requirement`'s `self-review` is the first use, and it exists so a round can
// review its own work with the SAME stages a real review uses rather than a
// second description of them that would drift.
//
// Three properties, each with a specific way of going wrong:
//
//   the RANGE runs, nothing else. Running past `validate-findings` reaches
//   `publish` — which on a requirement round means posting review comments to a
//   merge request that does not exist yet.
//
//   artifacts stay INSIDE except the declared outputs. `mr-review` has a
//   `worktree` and so does `requirement`; merging the sub-set would overwrite
//   the parent's, and the failure surfaces stages later as a round working on
//   the wrong tree.
//
//   hooks mount PREFIXED. A team's hook on `split-diff` fires for a real review
//   and, differently, inside a self-review — the second has no merge request,
//   and the prefixed name is what lets an author tell them apart.

import { describe, expect, test } from 'bun:test'
import { invokeSubSequence } from '../src/modules/code-capability/application/invokeSubSequence'
import type {
  StageResult,
  StageRunContext,
  StageRunners,
} from '../src/modules/code-capability/application/stageEngine'
import type { StageContract } from '../src/modules/code-capability/domain/stageContract'

const TARGET: StageContract = {
  capability: 'mr-review',
  version: 1,
  stages: [
    { kind: 'program', name: 'resolve-target', requires: [], produces: ['target'] },
    { kind: 'program', name: 'split-diff', requires: ['diff'], produces: ['shards'] },
    { kind: 'program', name: 'review-shard', requires: ['shards'], produces: ['shardFindings'] },
    {
      kind: 'program',
      name: 'validate-findings',
      requires: ['shardFindings'],
      produces: ['findings'],
    },
    { kind: 'program', name: 'publish', requires: ['findings'], produces: ['published'] },
  ],
}

/** Records which stages ran, and hands each a trivial artifact. */
function recordingRunners(over: Record<string, StageResult> = {}): {
  runners: StageRunners
  ran: string[]
  seen: Array<Record<string, unknown>>
} {
  const ran: string[] = []
  const seen: Array<Record<string, unknown>> = []
  const program = async (ctx: StageRunContext): Promise<StageResult> => {
    ran.push(ctx.stage.name)
    seen.push({ ...ctx.artifacts })
    const override = over[ctx.stage.name]
    if (override !== undefined) return override
    const produced: Record<string, unknown> = {}
    for (const name of ctx.stage.produces) produced[name] = `${ctx.stage.name}-output`
    return { status: 'done', produced }
  }
  const refuse = async (ctx: StageRunContext): Promise<StageResult> => ({
    status: 'failed',
    error: `unexpected kind for ${ctx.stage.name}`,
  })
  return { runners: { program, ai: refuse, script: refuse, invoke: refuse }, ran, seen }
}

const base = {
  db: null as never,
  roundId: 'R1',
  parentStage: 'self-review',
  invokes: { capability: 'mr-review' as const, from: 'split-diff', to: 'validate-findings' },
  lookupContract: () => TARGET,
}

describe('RFC-304 — the invoked range', () => {
  test('exactly the declared range runs', async () => {
    const rec = recordingRunners()
    const out = await invokeSubSequence({
      ...base,
      seedArtifacts: { diff: 'd' },
      runners: rec.runners,
    })

    expect(out.outcome).toBe('done')
    expect(rec.ran).toEqual(['split-diff', 'review-shard', 'validate-findings'])
    // The two that must NOT run: `resolve-target` is before the range, and
    // `publish` would post review comments to a merge request that does not
    // exist yet.
    expect(rec.ran).not.toContain('resolve-target')
    expect(rec.ran).not.toContain('publish')
  })

  test('the sub-sequence starts from exactly what the parent seeded', async () => {
    const rec = recordingRunners()
    await invokeSubSequence({
      ...base,
      seedArtifacts: { diff: 'the diff', worktree: 'parent-tree' },
      runners: rec.runners,
    })

    expect(rec.seen[0]).toEqual({ diff: 'the diff', worktree: 'parent-tree' })
  })

  test('the sub-sequence accumulates its own artifacts as it goes', async () => {
    const rec = recordingRunners()
    const out = await invokeSubSequence({
      ...base,
      seedArtifacts: { diff: 'd' },
      runners: rec.runners,
    })

    expect(out.outcome === 'done' && out.artifacts.findings).toBe('validate-findings-output')
    expect(out.outcome === 'done' && out.artifacts.shards).toBe('split-diff-output')
  })

  test('a failing sub-stage fails the invoke, naming the PREFIXED stage', async () => {
    // The prefix is what tells a reader the failure happened inside a
    // self-review rather than in a review of somebody's merge request.
    const rec = recordingRunners({
      'review-shard': { status: 'failed', error: 'the model refused' },
    })
    const out = await invokeSubSequence({
      ...base,
      seedArtifacts: { diff: 'd' },
      runners: rec.runners,
    })

    expect(out.outcome).toBe('failed')
    expect(out.outcome === 'failed' && out.failedStage).toBe('self-review/review-shard')
    expect(rec.ran).not.toContain('validate-findings')
  })

  test('a sub-stage asking to WAIT is a failure, not a pause', async () => {
    // Suspending here would mean resuming into the middle of a parent stage,
    // which the resume model — a single stage name — cannot express.
    const rec = recordingRunners({
      'review-shard': { status: 'awaiting', resumeAt: 'x', reason: 'need a human' },
    })
    const out = await invokeSubSequence({
      ...base,
      seedArtifacts: { diff: 'd' },
      runners: rec.runners,
    })

    expect(out.outcome).toBe('failed')
    expect(out.outcome === 'failed' && out.error).toContain('cannot be resumed into')
  })

  test('an unknown target capability fails loudly', async () => {
    const rec = recordingRunners()
    const out = await invokeSubSequence({
      ...base,
      lookupContract: () => undefined,
      seedArtifacts: {},
      runners: rec.runners,
    })

    expect(out.outcome).toBe('failed')
    expect(out.outcome === 'failed' && out.error).toContain('no registered contract')
    expect(rec.ran).toEqual([])
  })

  test('a range that does not exist fails before running anything', async () => {
    const rec = recordingRunners()
    const out = await invokeSubSequence({
      ...base,
      invokes: { capability: 'mr-review', from: 'split-diff', to: 'nonexistent' },
      seedArtifacts: {},
      runners: rec.runners,
    })

    expect(out.outcome).toBe('failed')
    expect(out.outcome === 'failed' && out.error).toContain('invalid range')
    expect(rec.ran).toEqual([])
  })

  test('a backwards range is refused', async () => {
    const rec = recordingRunners()
    const out = await invokeSubSequence({
      ...base,
      invokes: { capability: 'mr-review', from: 'validate-findings', to: 'split-diff' },
      seedArtifacts: {},
      runners: rec.runners,
    })
    expect(out.outcome).toBe('failed')
    expect(rec.ran).toEqual([])
  })
})

describe('RFC-304 — hooks inside an invoked sub-sequence', () => {
  test('a pre hook sees the PREFIXED stage name', async () => {
    const rec = recordingRunners()
    const mounted: string[] = []

    await invokeSubSequence({
      ...base,
      seedArtifacts: { diff: 'd' },
      runners: rec.runners,
      hooks: {
        pre: async (ctx) => {
          mounted.push(ctx.stage.name)
        },
      },
    })

    expect(mounted).toEqual([
      'self-review/split-diff',
      'self-review/review-shard',
      'self-review/validate-findings',
    ])
  })

  test('the RUNNER still sees the bare name', async () => {
    // The prefix is a hook-mounting concern. A runner keyed by the prefixed
    // name would find no implementation for any sub-stage.
    const rec = recordingRunners()
    await invokeSubSequence({
      ...base,
      seedArtifacts: { diff: 'd' },
      runners: rec.runners,
      hooks: { pre: async () => undefined },
    })
    expect(rec.ran).toEqual(['split-diff', 'review-shard', 'validate-findings'])
  })

  test('a blocking hook stops the sub-sequence', async () => {
    const rec = recordingRunners()
    const out = await invokeSubSequence({
      ...base,
      seedArtifacts: { diff: 'd' },
      runners: rec.runners,
      hooks: {
        pre: async (ctx) =>
          ctx.stage.name === 'self-review/review-shard' ? { block: 'not on this repo' } : undefined,
      },
    })

    expect(out.outcome).toBe('blocked')
    expect(out.outcome === 'blocked' && out.blockedStage).toBe('self-review/review-shard')
    expect(rec.ran).toEqual(['split-diff'])
  })

  test('an injected artifact reaches that stage only', async () => {
    const rec = recordingRunners()
    await invokeSubSequence({
      ...base,
      seedArtifacts: { diff: 'd' },
      runners: rec.runners,
      hooks: {
        pre: async (ctx) =>
          ctx.stage.name === 'self-review/split-diff'
            ? { inject: { extraContext: 'focus on the retry path' } }
            : undefined,
      },
    })

    expect(rec.seen[0]?.extraContext).toBe('focus on the retry path')
    // Not carried into the next stage: injection is per-stage, or a hook could
    // rewrite what the whole sub-sequence is built on.
    expect(rec.seen[1]?.extraContext).toBeUndefined()
  })
})
