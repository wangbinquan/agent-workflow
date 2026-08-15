// RFC-304 T5 — the stage engine drives a real sequence against a real DB.
//
// Runners are stubs that return values, and that is the design working as
// intended rather than a testing shortcut: the engine has no path to an agent,
// a subprocess or the network, so everything it owns — ordering, persistence,
// artifact threading, failure propagation, resume, cancel, hook blocking — is
// exercised here at full fidelity.
//
// The behaviours worth stating outright, because each has a plausible-looking
// wrong version:
//   - a failed stage stops the sequence (a "collect errors and continue" engine
//     would publish a round built on a missing artifact);
//   - a resumed round marks the skipped prefix `inherited` rather than deleting
//     or re-running it (re-running re-posts everything the human just read);
//   - an unknown `resumeFromStage` fails loudly instead of defaulting, because
//     both defaults — start from the top, skip everything — are wrong in a way
//     that only shows up on someone's MR.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  readRoundStages,
  runStageSequence,
  type StageResult,
  type StageRunContext,
  type StageRunners,
} from '../src/modules/code-capability/application/stageEngine'
import type { StageContract, StageDef } from '../src/modules/code-capability/domain/stageContract'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const program = (name: string, requires: string[] = [], produces: string[] = []): StageDef => ({
  kind: 'program',
  name,
  requires,
  produces,
})

/** Records the order stages ran in, and lets a named stage fail or block. */
function stubRunners(opts: {
  log: string[]
  failAt?: string
  produce?: Record<string, StageArtifactsValue>
}): StageRunners {
  const run = async (ctx: StageRunContext): Promise<StageResult> => {
    opts.log.push(ctx.stage.name)
    if (opts.failAt === ctx.stage.name)
      return { status: 'failed', error: `boom at ${ctx.stage.name}` }
    const produced = opts.produce?.[ctx.stage.name]
    return { status: 'done', ...(produced !== undefined ? { produced } : {}) }
  }
  return { program: run, script: run, ai: run, invoke: run }
}
type StageArtifactsValue = Record<string, unknown>

const CONTRACT: StageContract = {
  capability: 'mr-review',
  version: 1,
  stages: [
    program('collect', [], ['diff']),
    program('review', ['diff'], ['findings']),
    program('publish', ['findings'], []),
  ],
}

describe('RFC-304 T5 — stage engine', () => {
  let db: DbClient
  let roundId: string

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    roundId = ulid()
  })
  afterEach(() => db.$client.close())

  test('runs every stage in order and records one row per position', async () => {
    const log: string[] = []
    const out = await runStageSequence({
      db,
      roundId,
      contract: CONTRACT,
      runners: stubRunners({ log }),
    })

    expect(out.outcome).toBe('done')
    expect(log).toEqual(['collect', 'review', 'publish'])

    const rows = await readRoundStages(db, roundId)
    expect(rows.map((r) => r.stageName)).toEqual(['collect', 'review', 'publish'])
    expect(rows.every((r) => r.status === 'done')).toBe(true)
    // stage_kind is persisted so the state view can render a program stage
    // differently from an AI one without re-deriving it from the contract.
    expect(rows.every((r) => r.stageKind === 'program')).toBe(true)
  })

  test('artifacts thread forward, and a stage sees only what ran before it', async () => {
    const seen: Array<Record<string, unknown>> = []
    const runners: StageRunners = {
      program: async (ctx) => {
        seen.push(ctx.artifacts)
        return { status: 'done', produced: { [`${ctx.stage.name}_out`]: 1 } }
      },
      script: async () => ({ status: 'done' }),
      ai: async () => ({ status: 'done' }),
      invoke: async () => ({ status: 'done' }),
    }
    const out = await runStageSequence({ db, roundId, contract: CONTRACT, runners })

    expect(seen[0]).toEqual({})
    expect(seen[1]).toEqual({ collect_out: 1 })
    expect(seen[2]).toEqual({ collect_out: 1, review_out: 1 })
    expect(out.outcome === 'done' && out.artifacts).toEqual({
      collect_out: 1,
      review_out: 1,
      publish_out: 1,
    })
  })

  test('a mutation to the artifacts a runner received cannot leak sideways', async () => {
    // Each runner gets its own snapshot; a runner that scribbles on it must not
    // change what the next stage sees, or the sequence stops being replayable.
    const runners: StageRunners = {
      program: async (ctx) => {
        ;(ctx.artifacts as Record<string, unknown>).sneaky = true
        return { status: 'done' }
      },
      script: async () => ({ status: 'done' }),
      ai: async () => ({ status: 'done' }),
      invoke: async () => ({ status: 'done' }),
    }
    const out = await runStageSequence({ db, roundId, contract: CONTRACT, runners })
    expect(out.outcome === 'done' && out.artifacts).toEqual({})
  })

  test('a failed stage stops the sequence and names itself', async () => {
    const log: string[] = []
    const out = await runStageSequence({
      db,
      roundId,
      contract: CONTRACT,
      runners: stubRunners({ log, failAt: 'review' }),
    })

    expect(out.outcome).toBe('failed')
    expect(out.outcome === 'failed' && out.failedStage).toBe('review')
    expect(out.outcome === 'failed' && out.error).toContain('boom')
    // `publish` must not have run — a round built on a missing artifact is
    // worse than no round.
    expect(log).toEqual(['collect', 'review'])

    const rows = await readRoundStages(db, roundId)
    expect(rows.find((r) => r.stageName === 'review')?.status).toBe('failed')
    expect(rows.find((r) => r.stageName === 'review')?.error).toContain('boom')
    expect(rows.find((r) => r.stageName === 'publish')).toBeUndefined()
  })

  test('a runner that THROWS is a failed stage, not a crashed round', async () => {
    // If this propagated, the round row would never settle and the work item
    // would wait forever on a task that is already gone.
    const runners: StageRunners = {
      program: async () => {
        throw new Error('unexpected explosion')
      },
      script: async () => ({ status: 'done' }),
      ai: async () => ({ status: 'done' }),
      invoke: async () => ({ status: 'done' }),
    }
    const out = await runStageSequence({ db, roundId, contract: CONTRACT, runners })
    expect(out.outcome).toBe('failed')
    expect(out.outcome === 'failed' && out.error).toContain('unexpected explosion')
    expect((await readRoundStages(db, roundId))[0]?.status).toBe('failed')
  })

  test('resume marks the skipped prefix inherited and runs only the rest', async () => {
    const log: string[] = []
    const out = await runStageSequence({
      db,
      roundId,
      contract: CONTRACT,
      runners: stubRunners({ log }),
      resumeFromStage: 'publish',
      inheritedArtifacts: { diff: 'd', findings: 'f' },
    })

    expect(out.outcome).toBe('done')
    expect(log).toEqual(['publish'])
    const rows = await readRoundStages(db, roundId)
    // Inherited, not absent: the state view still shows what the round is built
    // on, and the reader can see it came from the previous round.
    expect(rows.map((r) => [r.stageName, r.status])).toEqual([
      ['collect', 'inherited'],
      ['review', 'inherited'],
      ['publish', 'done'],
    ])
  })

  test('the resumed stage still sees the inherited artifacts', async () => {
    const seen: Array<Record<string, unknown>> = []
    const runners: StageRunners = {
      program: async (ctx) => {
        seen.push(ctx.artifacts)
        return { status: 'done' }
      },
      script: async () => ({ status: 'done' }),
      ai: async () => ({ status: 'done' }),
      invoke: async () => ({ status: 'done' }),
    }
    await runStageSequence({
      db,
      roundId,
      contract: CONTRACT,
      runners,
      resumeFromStage: 'publish',
      inheritedArtifacts: { findings: ['a'] },
    })
    expect(seen).toEqual([{ findings: ['a'] }])
  })

  test('an unknown resumeFromStage fails loudly rather than defaulting', async () => {
    const log: string[] = []
    const out = await runStageSequence({
      db,
      roundId,
      contract: CONTRACT,
      runners: stubRunners({ log }),
      resumeFromStage: 'no-such-stage',
    })
    expect(out.outcome).toBe('failed')
    expect(out.outcome === 'failed' && out.error).toContain('no-such-stage')
    // Both plausible defaults are wrong: starting from the top re-posts
    // everything, skipping everything publishes an empty round.
    expect(log).toEqual([])
  })

  test('resumeFromStage null/undefined runs the whole sequence', async () => {
    const log: string[] = []
    await runStageSequence({
      db,
      roundId,
      contract: CONTRACT,
      runners: stubRunners({ log }),
      resumeFromStage: null,
    })
    expect(log).toEqual(['collect', 'review', 'publish'])
  })

  test('an aborted signal stops before the next stage', async () => {
    const log: string[] = []
    const controller = new AbortController()
    const runners: StageRunners = {
      program: async (ctx) => {
        log.push(ctx.stage.name)
        if (ctx.stage.name === 'collect') controller.abort()
        return { status: 'done' }
      },
      script: async () => ({ status: 'done' }),
      ai: async () => ({ status: 'done' }),
      invoke: async () => ({ status: 'done' }),
    }
    const out = await runStageSequence({
      db,
      roundId,
      contract: CONTRACT,
      runners,
      signal: controller.signal,
    })
    expect(out.outcome).toBe('canceled')
    expect(out.outcome === 'canceled' && out.canceledStage).toBe('review')
    expect(log).toEqual(['collect'])
  })

  test('a pre hook can block, and blocking is distinct from failing', async () => {
    // A team gate saying "not this one" is not an error — conflating them would
    // put a policy decision in the failure alerts.
    const log: string[] = []
    const out = await runStageSequence({
      db,
      roundId,
      contract: CONTRACT,
      runners: stubRunners({ log }),
      hooks: {
        pre: async (ctx) =>
          ctx.stage.name === 'review' ? { block: 'team gate says no' } : undefined,
      },
    })
    expect(out.outcome).toBe('blocked')
    expect(out.outcome === 'blocked' && out.blockedStage).toBe('review')
    expect(out.outcome === 'blocked' && out.reason).toBe('team gate says no')
    expect(log).toEqual(['collect'])
  })

  test('an injected value reaches its stage but NOT the ones after it', async () => {
    // Injection feeds the stage about to run. If it leaked into the sequence's
    // accumulated artifacts, one team's hook on one stage would silently
    // redefine that artifact for every stage downstream.
    const seen: Array<Record<string, unknown>> = []
    const runners: StageRunners = {
      program: async (ctx) => {
        seen.push({ ...ctx.artifacts })
        return { status: 'done' }
      },
      script: async () => ({ status: 'done' }),
      ai: async () => ({ status: 'done' }),
      invoke: async () => ({ status: 'done' }),
    }
    const out = await runStageSequence({
      db,
      roundId,
      contract: CONTRACT,
      runners,
      hooks: {
        pre: async (ctx) =>
          ctx.stage.name === 'review' ? { inject: { extraContext: 'team-rules' } } : undefined,
      },
    })

    expect(seen[0]).toEqual({})
    expect(seen[1]).toEqual({ extraContext: 'team-rules' })
    expect(seen[2]).toEqual({})
    expect(out.outcome === 'done' && out.artifacts).toEqual({})
  })

  test('a post hook sees the same injected view its stage ran with', async () => {
    // Otherwise a cleanup hook would reason about different inputs than the
    // stage it is cleaning up after.
    const postArtifacts: Array<Record<string, unknown>> = []
    await runStageSequence({
      db,
      roundId,
      contract: CONTRACT,
      runners: stubRunners({ log: [] }),
      hooks: {
        pre: async (ctx) => (ctx.stage.name === 'review' ? { inject: { k: 'v' } } : undefined),
        post: async (ctx) => {
          if (ctx.stage.name === 'review') postArtifacts.push({ ...ctx.artifacts })
        },
      },
    })
    expect(postArtifacts).toEqual([{ k: 'v' }])
  })

  test('block wins over inject when a hook returns both', async () => {
    // A gate that also offers data is still a gate; running the stage with the
    // data would be acting on a hook that said "no".
    const log: string[] = []
    const out = await runStageSequence({
      db,
      roundId,
      contract: CONTRACT,
      runners: stubRunners({ log }),
      hooks: {
        pre: async (ctx) =>
          ctx.stage.name === 'review' ? { block: 'denied', inject: { k: 'v' } } : undefined,
      },
    })
    expect(out.outcome).toBe('blocked')
    expect(log).toEqual(['collect'])
  })

  test('hooks fire around every stage, in order, and see the result', async () => {
    const trace: string[] = []
    await runStageSequence({
      db,
      roundId,
      contract: CONTRACT,
      runners: stubRunners({ log: [] }),
      hooks: {
        pre: async (ctx) => {
          trace.push(`pre:${ctx.stage.name}`)
        },
        post: async (ctx, result) => {
          trace.push(`post:${ctx.stage.name}:${result.status}`)
        },
      },
    })
    expect(trace).toEqual([
      'pre:collect',
      'post:collect:done',
      'pre:review',
      'post:review:done',
      'pre:publish',
      'post:publish:done',
    ])
  })

  test('a post hook still fires for the stage that failed', async () => {
    // Cleanup hooks that only run on success are how a worktree leaks.
    const trace: string[] = []
    await runStageSequence({
      db,
      roundId,
      contract: CONTRACT,
      runners: stubRunners({ log: [], failAt: 'collect' }),
      hooks: {
        post: async (ctx, result) => {
          trace.push(`post:${ctx.stage.name}:${result.status}`)
        },
      },
    })
    expect(trace).toEqual(['post:collect:failed'])
  })

  test('re-running the same round rewrites rows rather than duplicating them', async () => {
    // A retried round walks the same (roundId, stageSeq) pairs; a blind insert
    // would hit the unique index and turn a retry into a crash.
    await runStageSequence({ db, roundId, contract: CONTRACT, runners: stubRunners({ log: [] }) })
    await runStageSequence({ db, roundId, contract: CONTRACT, runners: stubRunners({ log: [] }) })
    const rows = await readRoundStages(db, roundId)
    expect(rows).toHaveLength(3)
  })

  test('each stage kind reaches its own runner and nothing else', async () => {
    // The structural half of AC-10: a program stage has no path to the AI
    // runner from inside the engine.
    const calls: string[] = []
    const mark =
      (kind: string) =>
      async (ctx: StageRunContext): Promise<StageResult> => {
        calls.push(`${kind}:${ctx.stage.name}`)
        return { status: 'done' }
      }
    const mixed: StageContract = {
      capability: 'ci-fix',
      version: 1,
      stages: [
        program('p'),
        { kind: 'script', name: 's', scriptSlot: 'slot', requires: [], produces: [] },
        { kind: 'ai', name: 'a', aiSchema: {}, agentSlot: 'reviewer', requires: [], produces: [] },
        {
          kind: 'invoke',
          name: 'i',
          requires: [],
          produces: [],
          invokes: { capability: 'mr-review', from: 'collect', to: 'review' },
        },
      ],
    }
    await runStageSequence({
      db,
      roundId,
      contract: mixed,
      runners: {
        program: mark('program'),
        script: mark('script'),
        ai: mark('ai'),
        invoke: mark('invoke'),
      },
    })
    expect(calls).toEqual(['program:p', 'script:s', 'ai:a', 'invoke:i'])
    const rows = await readRoundStages(db, roundId)
    expect(rows.map((r) => r.stageKind)).toEqual(['program', 'script', 'ai', 'invoke'])
  })
})
