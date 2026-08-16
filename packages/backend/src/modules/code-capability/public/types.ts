// RFC-304 — the code-capability module's outward contract.
//
// This is the module's FIRST public surface, added when its first consumer
// appeared (the scheduler's `code-round` branch) rather than pre-built as empty
// scaffolding. What it exposes is deliberately one verb: "run this round". The
// scheduler does not learn what a stage is, what a hook is, or that an AI
// attempt table exists — all of that stays inside, which is what keeps the
// eventual RFC-294 consolidation from having to untangle a second wide seam.
//
// Shape follows `integration/public/mrTerminalControl.ts` — interface here,
// concrete instance assembled in `composition/`, transitional caller
// (services/scheduler.ts) receiving it through its existing options bag — with
// one deliberate difference: it lives in `public/types.ts`, one of RFC-294's
// five EXACT entrypoints, rather than at a name of its own. The architecture
// preflight tracks non-exact entrypoints as reviewed pilot DEBT, and that list
// is only allowed to shrink; a new module has no business adding to it.

/** What the scheduler hands in — everything about the round it already knows. */
export interface CodeRoundExecutionInput {
  readonly roundId: string
  readonly capability: string
  readonly roundSeq: number
  /** The task's worktree; stages and hooks operate here. */
  readonly worktreePath: string
  readonly repos: ReadonlyArray<{ readonly name: string; readonly path: string }>
  /** Envelope scoping for this round's AI stages and hooks. */
  readonly envelopeNonce: string
  /**
   * Restart from this stage, inheriting the prefix (design §2.2 恢复语义).
   *
   * What the skipped stages would have PRODUCED is not passed here. A resumed
   * round starts cold — the posting round's task ended, possibly days ago — so
   * that state has to be reconstituted from durable sources, and the artifact
   * vocabulary doing it is a capability's private business. It is supplied
   * through the runner's assembly (`CodeCapabilityRunnerDeps.inheritedArtifacts`)
   * rather than through this contract, which would otherwise have to carry an
   * open `unknown`-valued map across a public surface (RFC-294 W0-R).
   */
  readonly resumeFromStage: string | null
}

export type CodeRoundExecutionResult =
  | { readonly outcome: 'done'; readonly summary: string }
  | { readonly outcome: 'failed'; readonly failedStage: string; readonly error: string }
  /** A team's own pre-hook refused this stage — a policy decision, not an error. */
  | { readonly outcome: 'blocked'; readonly blockedStage: string; readonly reason: string }
  | { readonly outcome: 'canceled'; readonly canceledStage: string }
  /**
   * RFC-304 §6.2 — the round did its work and now waits for a person.
   *
   * Neither `done` nor `failed`, and conflating it with either loses something
   * real: reported as done, the work item settles and the confirmation has
   * nothing to wake; reported as failed, an operator goes looking for a bug
   * that does not exist. The caller moves the WORK ITEM to `awaiting` and
   * records `resumeAt` for the round the confirmation will open.
   */
  | {
      readonly outcome: 'awaiting'
      readonly awaitingStage: string
      readonly resumeAt: string
      readonly reason: string
    }
  /** No contract is registered for this capability — a configuration fault. */
  | { readonly outcome: 'unknown-capability'; readonly capability: string }

export interface CodeCapabilityRunner {
  /**
   * Run one round's stage sequence to completion.
   *
   * Never throws for a stage-level problem: a round that fails must still
   * settle its rows, or the work item waits forever on a task that is gone.
   */
  runRound(input: CodeRoundExecutionInput): Promise<CodeRoundExecutionResult>
}
