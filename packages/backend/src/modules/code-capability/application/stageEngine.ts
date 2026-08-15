// RFC-304 T5 — the stage engine: walk a capability's stage sequence in order,
// record each stage, stop on the first failure.
//
// The engine deliberately knows NOTHING about agents, scripts, git or HTTP. It
// takes a `StageRunners` record and calls the one matching each stage's kind.
// That is not generic-for-its-own-sake: it is what makes the constitution
// checkable. A `program` stage physically cannot dispatch an agent from here,
// because the engine has no way to — the AI path exists only behind
// `runners.ai`, which only `kind: 'ai'` stages reach. (AC-10 additionally scans
// the program implementations themselves.)
//
// It also makes the engine testable without a model, a subprocess or a network:
// every test below drives real sequencing, real persistence and real failure
// propagation with runners that just return values.

import { and, asc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { codeRoundStages } from '@/db/schema'
import type { StageContract, StageDef } from '@/modules/code-capability/domain/stageContract'

/** Artifacts flowing between stages, keyed by the names in `produces`. */
export type StageArtifacts = Readonly<Record<string, unknown>>

export type StageResult =
  | { status: 'done'; produced?: StageArtifacts; counts?: Readonly<Record<string, number>> }
  | { status: 'failed'; error: string }

export interface StageRunContext {
  roundId: string
  stage: StageDef
  /** Everything produced so far, in sequence order. */
  artifacts: StageArtifacts
  signal?: AbortSignal
}

export interface StageRunners {
  program(ctx: StageRunContext): Promise<StageResult>
  script(ctx: StageRunContext): Promise<StageResult>
  ai(ctx: StageRunContext): Promise<StageResult>
  invoke(ctx: StageRunContext): Promise<StageResult>
}

/**
 * Fires around each stage. A `pre` hook that returns `{ block: reason }` stops
 * the sequence — that is the blocking semantics hooks are for (a team's own
 * gate saying "not this one"), and it settles the round as `blocked`, distinct
 * from a stage that errored.
 */
export interface StageHooks {
  /**
   * `block` stops the sequence. `inject` is merged into the artifacts THIS
   * stage sees and nothing further — injection feeds the stage about to run,
   * so leaking it downstream would let one team's hook silently redefine an
   * artifact for every stage after it.
   *
   * Injection is an explicit return value rather than a mutation of
   * `ctx.artifacts`: a hook that scribbled on the context would happen to work
   * today (pre and the runner share one object) and break the moment either
   * side takes a defensive copy — the kind of coupling that fails long after
   * the change that caused it. The caller is responsible for having filtered
   * against the stage's allowlist before returning it (see `injectableKeysFor`).
   */
  pre?(ctx: StageRunContext): Promise<{ block?: string; inject?: StageArtifacts } | void>
  post?(ctx: StageRunContext, result: StageResult): Promise<void>
}

export type StageSequenceOutcome =
  | { outcome: 'done'; artifacts: StageArtifacts }
  | { outcome: 'failed'; failedStage: string; error: string }
  | { outcome: 'blocked'; blockedStage: string; reason: string }
  | { outcome: 'canceled'; canceledStage: string }

export interface RunStageSequenceArgs {
  db: DbClient
  roundId: string
  contract: StageContract
  runners: StageRunners
  hooks?: StageHooks
  /**
   * Restart from this stage, inheriting everything before it. A resumed round
   * must NOT re-run from the top: re-posting every finding the human just read
   * is how a "please confirm" turns into spam (design §2.2 恢复语义).
   */
  resumeFromStage?: string | null
  /** Artifacts carried over from the previous round for the inherited stages. */
  inheritedArtifacts?: StageArtifacts
  signal?: AbortSignal
  now?: () => number
}

export async function runStageSequence(args: RunStageSequenceArgs): Promise<StageSequenceOutcome> {
  const { db, roundId, contract, runners } = args
  const now = args.now ?? Date.now
  const artifacts: Record<string, unknown> = { ...(args.inheritedArtifacts ?? {}) }

  const resumeIdx =
    args.resumeFromStage == null
      ? 0
      : contract.stages.findIndex((s) => s.name === args.resumeFromStage)
  if (resumeIdx === -1) {
    // Fail loudly: silently starting from the top would re-post everything, and
    // silently skipping everything would publish an empty round. Neither is a
    // recoverable default, so the caller has to fix the stage name.
    return {
      outcome: 'failed',
      failedStage: String(args.resumeFromStage),
      error: `resumeFromStage '${String(args.resumeFromStage)}' is not a stage of '${contract.capability}'`,
    }
  }

  for (const [seq, stage] of contract.stages.entries()) {
    if (seq < resumeIdx) {
      await recordStage(db, roundId, seq, stage, 'inherited', now())
      continue
    }
    if (args.signal?.aborted === true) {
      await recordStage(db, roundId, seq, stage, 'skipped', now())
      return { outcome: 'canceled', canceledStage: stage.name }
    }

    const ctx: StageRunContext = {
      roundId,
      stage,
      artifacts: { ...artifacts },
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    }

    const gate = await args.hooks?.pre?.(ctx)
    if (gate != null && typeof gate.block === 'string') {
      await recordStage(db, roundId, seq, stage, 'skipped', now(), { error: gate.block })
      return { outcome: 'blocked', blockedStage: stage.name, reason: gate.block }
    }

    const stageRowId = await recordStage(db, roundId, seq, stage, 'running', now())

    // Injection applies to THIS stage only — it is not written into the
    // accumulated artifacts, so the next stage sees the sequence's own state.
    const runCtx: StageRunContext =
      gate != null && gate.inject !== undefined
        ? { ...ctx, artifacts: { ...ctx.artifacts, ...gate.inject } }
        : ctx

    let result: StageResult
    try {
      result = await runners[stage.kind](runCtx)
    } catch (err) {
      // A runner that throws is a failed stage, not a crashed round: the round
      // row must still settle, or the work item waits on a task that is gone.
      result = { status: 'failed', error: err instanceof Error ? err.message : String(err) }
    }

    await args.hooks?.post?.(runCtx, result)

    if (result.status === 'failed') {
      await settleStage(db, stageRowId, 'failed', now(), { error: result.error })
      return { outcome: 'failed', failedStage: stage.name, error: result.error }
    }

    await settleStage(db, stageRowId, 'done', now(), {
      countsJson: result.counts === undefined ? null : JSON.stringify(result.counts),
    })
    Object.assign(artifacts, result.produced ?? {})
  }

  return { outcome: 'done', artifacts }
}

/**
 * Upsert-by-position, not blind insert: a resumed or retried round walks the
 * same `(roundId, stageSeq)` pairs again, and the table's unique index would
 * reject a second insert. Rewriting the row keeps one row per position, which
 * is what the state view reads.
 */
async function recordStage(
  db: DbClient,
  roundId: string,
  stageSeq: number,
  stage: StageDef,
  status: 'pending' | 'running' | 'skipped' | 'inherited',
  at: number,
  extra: { error?: string } = {},
): Promise<string> {
  const existing = await db
    .select({ id: codeRoundStages.id })
    .from(codeRoundStages)
    .where(and(eq(codeRoundStages.roundId, roundId), eq(codeRoundStages.stageSeq, stageSeq)))
    .limit(1)

  const row = existing[0]
  if (row !== undefined) {
    await db
      .update(codeRoundStages)
      .set({
        status,
        stageName: stage.name,
        stageKind: stage.kind,
        ...(status === 'running' ? { startedAt: at, endedAt: null } : { endedAt: at }),
        ...(extra.error !== undefined ? { error: extra.error } : {}),
      })
      .where(eq(codeRoundStages.id, row.id))
    return row.id
  }

  const id = ulid()
  await db.insert(codeRoundStages).values({
    id,
    roundId,
    stageSeq,
    stageName: stage.name,
    stageKind: stage.kind,
    status,
    startedAt: status === 'running' ? at : null,
    endedAt: status === 'running' ? null : at,
    ...(extra.error !== undefined ? { error: extra.error } : {}),
  })
  return id
}

async function settleStage(
  db: DbClient,
  stageRowId: string,
  status: 'done' | 'failed',
  at: number,
  extra: { error?: string; countsJson?: string | null } = {},
): Promise<void> {
  await db
    .update(codeRoundStages)
    .set({
      status,
      endedAt: at,
      ...(extra.error !== undefined ? { error: extra.error } : {}),
      ...(extra.countsJson !== undefined ? { countsJson: extra.countsJson } : {}),
    })
    .where(eq(codeRoundStages.id, stageRowId))
}

/** Read a round's stages in sequence order — the /code state view's middle level. */
export async function readRoundStages(
  db: DbClient,
  roundId: string,
): Promise<
  Array<{
    stageSeq: number
    stageName: string
    stageKind: string
    status: string
    error: string | null
  }>
> {
  return await db
    .select({
      stageSeq: codeRoundStages.stageSeq,
      stageName: codeRoundStages.stageName,
      stageKind: codeRoundStages.stageKind,
      status: codeRoundStages.status,
      error: codeRoundStages.error,
    })
    .from(codeRoundStages)
    .where(eq(codeRoundStages.roundId, roundId))
    .orderBy(asc(codeRoundStages.stageSeq))
}
