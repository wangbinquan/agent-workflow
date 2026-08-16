// RFC-304 §6.4 — `ci-fix` as the stage engine runs it.
//
//   collect → classify → arbitrate → select   (scripts, no AI)
//     → prepare-worktree → fix(ai) → validate-fix → self-review(invoke)
//     → anti-cheat-check → push → ledger
//
// ## One round is one attempt
//
// The pipeline fails, a round runs, and the next pipeline event opens the next
// round. That is why the attempt count lives in the database (T52) rather than
// in a loop here: a round that counted its own attempts would restart at 1 every
// time, and "three attempts" would mean "forever". The count is keyed by
// `(work item, failure fingerprint)` so the quota tracks a FAILURE rather than a
// merge request — otherwise a long-lived merge request loses automatic repair
// the third time it meets any CI problem, spent by failures nobody remembers.
//
// ## The two stages that decide anything
//
// `validate-fix` runs the repository's gate and reports what it saw. `fix` has
// no field in which the agent can claim success, because an agent whose job is
// to make something green is exactly the wrong witness to whether it is green.
//
// `anti-cheat-check` then asks a narrower question — did this change buy its
// green by deleting the test? — and answers it on re-runnable facts. Its
// `escalate` arm is the interesting one: it settles the round `awaiting` rather
// than failing it, because "the platform cannot tell" is not "the change is
// bad", and a red round would send someone looking for a bug that isn't there.

import {
  runGuardedAiStage,
  exhaustionDetail,
} from '@/modules/code-capability/application/determinismGuard'
import type {
  AiCaller,
  AttemptRecorder,
  RetryBudget,
} from '@/modules/code-capability/application/determinismGuard'
import type {
  StageArtifacts,
  StageResult,
  StageRunContext,
} from '@/modules/code-capability/application/stageEngine'
import {
  findCheatSignals,
  judgeAntiCheat,
  type BaselineEvidence,
  type CheatSignal,
} from '@/modules/code-capability/domain/antiCheat'
import {
  CiFixEnvelopeSchema,
  type CiFixEnvelope,
} from '@/modules/code-capability/domain/ciFixEnvelope'
import {
  fingerprintFailures,
  judgeFixQuota,
  renderQuotaExhausted,
  type FailureFingerprint,
} from '@/modules/code-capability/domain/failureFingerprint'
import type {
  ClassifiedIssue,
  CollectResult,
} from '@/modules/code-capability/domain/monitorContracts'
import { say } from '@/modules/code-capability/application/mrVoice'
import {
  claimFixAttempt,
  readFixAttempts,
} from '@/modules/code-capability/infrastructure/sqliteFixAttemptStore'
import type { CodeHostPort } from '@/modules/code-capability/ports/codeHostPort'
import type { GitPort } from '@/modules/code-capability/ports/gitPort'
import type { DbClient } from '@/db/client'

const fail = (error: string): StageResult => ({ status: 'failed', error })
const done = (produced: StageArtifacts): StageResult => ({ status: 'done', produced })

function required<T>(artifacts: StageArtifacts, name: string): T {
  const value = artifacts[name]
  if (value === undefined) {
    throw new Error(`stage artifact '${name}' is missing though the contract requires it`)
  }
  return value as T
}

/** The port a `fix` envelope arrives on. */
export const CI_FIX_PORT = 'fix'

/** What `validate-fix` saw when it ran the repository's gate. */
export interface GateRun {
  exitCode: number
  output: string
}

/** What `validate-fix` concluded, and what `push` is allowed to act on. */
export interface FixResult {
  status: 'fixed' | 'still-red'
  attemptSeq: number
  remaining: number
  fingerprint: FailureFingerprint
  /** The gate's own words for whatever stayed red. */
  detail: string
}

/** The frozen pair the anti-cheat evidence is drawn from. */
export interface BaselineSnapshot {
  baselineSha: string
  /** Absent when the gate could not be run on the baseline at all. */
  baselineGate: GateRun | null
}

export interface CiFixEnvironment {
  db: DbClient
  codeHost: CodeHostPort
  git: GitPort
  repoPath: string
  worktreePath: string
  /** The merge request being repaired, addressed the way `codeHost` expects. */
  reportTarget: Readonly<Record<string, string>>
  /** Its source branch; `push` fast-forwards this. */
  sourceBranch: string
  workItemId: string
  roundId: string
  /** See `MrCommentFixEnvironment.makeCaller` for why the port is a parameter. */
  makeCaller: (prompt: string, slot: 'ci-fixer', port: string) => AiCaller
  nonce: string
  budget: RetryBudget
  attemptRecorder?: AttemptRecorder
  /** Runs the repository's gate in the worktree as it currently stands. */
  runGate: () => Promise<GateRun>
  /**
   * Runs the gate against the frozen baseline, for the red-before half of the
   * anti-cheat evidence. Returns null when it cannot be run mechanically —
   * which is a real answer here, not an error: it selects `escalate`.
   */
  runGateOnBaseline?: () => Promise<GateRun | null>
  /** The change as it stands, for structural analysis. */
  readWorktreeDiff: () => Promise<string>
  attemptLimit?: number
  /** How many notifications this merge request has already produced (T60). */
  notificationsSpent?: number
  commitAuthor?: { name: string; email: string }
  now?: () => number
}

export function ciFixProgramStages(
  env: CiFixEnvironment,
): Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>> {
  return {
    'prepare-worktree': async (ctx) => {
      const state = required<CollectResult>(ctx.artifacts, 'gateState')

      // Pinned to the revision `collect` described, not to whatever the branch
      // points at now. Those differ more often than they look: the author may
      // have pushed while the round was queued, and repairing a revision nobody
      // asked about produces a push that silently reverts their work.
      const checkout = await env.git.checkoutDetached({
        worktreePath: env.worktreePath,
        sha: state.headSha,
      })
      if (!checkout.ok) return fail(checkout.error)

      let baselineGate: GateRun | null = null
      if (env.runGateOnBaseline !== undefined) {
        // Run BEFORE the agent touches anything. After the fix the baseline is
        // gone, and "was this test already passing?" becomes unanswerable —
        // which is the one question the anti-cheat adjudication turns on.
        baselineGate = await env.runGateOnBaseline()
      }

      const baseline: BaselineSnapshot = { baselineSha: state.headSha, baselineGate }
      return done({
        worktree: { path: env.worktreePath, baselineSha: state.headSha },
        baseline,
      })
    },

    'validate-fix': async (ctx) => {
      const attempt = required<CiFixEnvelope>(ctx.artifacts, 'attempt')
      const issues = required<ClassifiedIssue[]>(ctx.artifacts, 'issues')
      const fingerprint = fingerprintFailures(issues)

      const prior = await readFixAttempts({
        db: env.db,
        workItemId: env.workItemId,
        fingerprint: fingerprint.digest,
      })
      const quota = judgeFixQuota(prior.length, env.attemptLimit ?? undefined)

      if (!quota.allowed) {
        // T54 — the quota was already spent by earlier rounds against this same
        // failure. Say so with the full history and stop; `handed_off` is what
        // keeps the next pipeline event from starting a fourth.
        await postComment(env, renderQuotaExhausted(fingerprint, prior), 'handed-off')
        return {
          status: 'settled',
          reason: `the retry quota for this failure is spent after ${String(quota.attempts)} attempts`,
          produced: { handedOff: { fingerprint: fingerprint.digest, attempts: quota.attempts } },
        }
      }

      const ran = await env.runGate()
      const fixed = ran.exitCode === 0
      const detail = ran.output.trim().slice(0, 4000)

      const claim = await claimFixAttempt({
        db: env.db,
        workItemId: env.workItemId,
        fingerprint: fingerprint.digest,
        roundId: env.roundId,
        summary: attempt.summary,
        outcome: fixed ? 'fixed' : 'still-red',
        ...(fixed ? {} : { detail }),
        ...(env.now === undefined ? {} : { now: env.now() }),
      })
      if (!claim.ok) {
        // Another round claimed this attempt number first. Continuing would
        // spend a slot that is already spoken for, so this round steps aside
        // rather than double-counting the quota.
        return fail('another round is already working on this failure')
      }

      if (!fixed) {
        // Nothing to push, and nothing went wrong with the platform — the
        // attempt simply did not work. `settled` rather than `failed` so the
        // remaining stages are recorded skipped instead of running against a
        // change that does not build.
        const left = quota.remaining
        await postComment(
          env,
          [
            `Attempt ${String(quota.attempt)} of ${String(quota.attempt + left)} did not fix the pipeline.`,
            '',
            `What it tried: ${attempt.summary}`,
            '',
            'The gate still fails:',
            '',
            '```',
            detail.slice(0, 1500),
            '```',
          ].join('\n'),
        )
        return {
          status: 'settled',
          reason: `attempt ${String(quota.attempt)} left the gate red`,
          produced: {
            fixResult: {
              status: 'still-red',
              attemptSeq: claim.attemptSeq,
              remaining: left,
              fingerprint,
              detail,
            } satisfies FixResult,
          },
        }
      }

      return done({
        fixResult: {
          status: 'fixed',
          attemptSeq: claim.attemptSeq,
          remaining: quota.remaining,
          fingerprint,
          detail,
        } satisfies FixResult,
      })
    },

    'anti-cheat-check': async (ctx) => {
      const baseline = required<BaselineSnapshot>(ctx.artifacts, 'baseline')
      const diff = await env.readWorktreeDiff()
      const signals = findCheatSignals(diff)

      const verdict = judgeAntiCheat(signals, evidenceFrom(baseline))

      if (verdict.decision === 'reject') {
        await postComment(env, verdict.message)
        return fail(verdict.message)
      }

      if (verdict.decision === 'escalate') {
        // Design §6.4 layer 1: the hard block exists for "do not push
        // automatically", never for "this justification is false". `awaiting`
        // rather than `failed` — nothing is wrong, a person is needed.
        await postComment(env, verdict.message)
        return {
          status: 'awaiting',
          // Back to `push`, NOT to `fix`: the change under discussion is the one
          // already in the tree, and re-running the agent would produce a
          // different change carrying the same conversation.
          resumeAt: 'push',
          reason: 'a test was weakened and the platform could not verify that it should be',
          produced: { integrity: { decision: 'escalate', signals } },
        }
      }

      return done({ integrity: { decision: 'allow', signals } })
    },

    push: async (ctx) => {
      const result = required<FixResult>(ctx.artifacts, 'fixResult')
      const envelope = required<CiFixEnvelope>(ctx.artifacts, 'attempt')
      const baseline = required<BaselineSnapshot>(ctx.artifacts, 'baseline')

      const frozen = await env.git.commitWorktree({
        repoPath: env.repoPath,
        worktreePath: env.worktreePath,
        message: envelope.summary,
        keepRef: `refs/aw/ci-fix/${env.roundId}`,
        ...(env.commitAuthor === undefined
          ? {}
          : { authorName: env.commitAuthor.name, authorEmail: env.commitAuthor.email }),
      })
      if (!frozen.ok) {
        return fail(
          frozen.reason === 'no-changes'
            ? 'the gate passed but the worktree is unmodified, so there is nothing to push'
            : `could not commit the fix: ${frozen.error}`,
        )
      }

      // Compare-and-swap against the revision this round was ABOUT. The author
      // may have pushed while the agent worked, and a force-update here would
      // silently revert their commit — the platform would be the thing that
      // broke the branch it was sent to repair.
      const pushed = await env.git.pushCommit({
        repoPath: env.repoPath,
        commitSha: frozen.commitSha,
        branch: env.sourceBranch,
        expectedRemoteSha: baseline.baselineSha,
      })
      await env.git.deleteRef({ repoPath: env.repoPath, ref: `refs/aw/ci-fix/${env.roundId}` })

      if (!pushed.ok) {
        if (pushed.reason === 'stale') {
          // Not a failure of this round: the branch moved, so the fix was built
          // against code that no longer exists. Settled rather than failed —
          // the new head raises its own pipeline event, and if the same failure
          // survives it, the next round picks it up with the quota intact.
          return {
            status: 'settled',
            reason: `'${env.sourceBranch}' moved while the fix was being made; nothing was pushed`,
          }
        }
        return fail(`could not push to '${env.sourceBranch}': ${pushed.error}`)
      }

      return done({
        pushed: {
          commitSha: frozen.commitSha,
          branch: env.sourceBranch,
          attempt: result.attemptSeq,
        },
      })
    },

    ledger: async (ctx) => {
      const pushed = required<{ commitSha: string }>(ctx.artifacts, 'pushed')
      const result = required<FixResult>(ctx.artifacts, 'fixResult')
      return done({
        ledgerEntry: {
          commitSha: pushed.commitSha,
          attempt: result.attemptSeq,
          fingerprint: result.fingerprint.digest,
        },
      })
    },
  }
}

export function ciFixAiStages(
  env: CiFixEnvironment,
): Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>> {
  return {
    fix: async (ctx) => {
      const issues = required<ClassifiedIssue[]>(ctx.artifacts, 'issues')
      const fingerprint = fingerprintFailures(issues)
      const prior = await readFixAttempts({
        db: env.db,
        workItemId: env.workItemId,
        fingerprint: fingerprint.digest,
      })

      const prompt = [
        'The pipeline for this merge request is failing. Repair it in the working tree.',
        '',
        'The failures, as the pipeline reported them:',
        '',
        ...issues.map(
          (issue) =>
            `- [${issue.type}] ${issue.file ?? '(no file)'}${issue.line === undefined ? '' : `:${String(issue.line)}`} — ${issue.message}`,
        ),
        ...(prior.length === 0
          ? []
          : [
              '',
              // The feedback loop the retry budget is for: without it, attempt
              // two re-derives attempt one from the same inputs and produces
              // the same change.
              'This failure has been attempted before. What was tried, and what happened:',
              '',
              ...prior.map((a) => `${String(a.attempt)}. ${a.summary} → ${a.outcome}`),
              '',
              'Do not repeat those. If the remaining cause is something you cannot fix from',
              'here, say so in the summary rather than making a change that looks like one.',
            ]),
        '',
        'Fix the cause. Do not delete, skip or weaken a test to make the pipeline pass —',
        'the change is checked against the baseline for exactly that, and a green pipeline',
        'bought that way is rejected. If a test is genuinely wrong, say why in',
        'testChangeJustification; a reviewer reads it.',
      ].join('\n')

      const outcome = await runGuardedAiStage<CiFixEnvelope>({
        caller: env.makeCaller(prompt, 'ci-fixer', CI_FIX_PORT),
        schema: CiFixEnvelopeSchema,
        nonce: env.nonce,
        portName: CI_FIX_PORT,
        budget: env.budget,
        ...(env.attemptRecorder !== undefined ? { recorder: env.attemptRecorder } : {}),
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      })

      if (outcome.status === 'canceled') return fail('the round was canceled')
      if (outcome.status === 'exhausted') {
        return fail(
          `the fixer did not produce a valid result after ${String(outcome.totalCalls)} attempts${exhaustionDetail(outcome.rejections)}`,
        )
      }
      return done({ attempt: outcome.value })
    },
  }
}

/**
 * The red-before / green-after evidence, from the frozen baseline run.
 *
 * The mapping is small and the wrong version of it is dangerous, so it is named:
 * a baseline that could not be run is `inconclusive` — NOT "assume it was red",
 * which would clear every weakened test in a repository whose gate needs a live
 * database, and not "assume it was green", which would reject every honest
 * deletion in the same repository.
 */
export function evidenceFrom(baseline: BaselineSnapshot): BaselineEvidence {
  if (baseline.baselineGate === null) {
    return { kind: 'inconclusive', reason: 'the gate could not be run on the baseline revision' }
  }
  return baseline.baselineGate.exitCode === 0
    ? { kind: 'was-already-green' }
    : { kind: 'red-before-green-after' }
}

async function postComment(env: CiFixEnvironment, body: string, kind = 'ci-fix'): Promise<void> {
  // Routed through `say` rather than calling `comment.create` directly, which
  // is what makes T60's notification budget real: a rule enforced beside a call
  // site that does not consult it is documentation. `handed-off` bypasses the
  // budget — it is one of the two messages the quieting exists to preserve.
  //
  // Best-effort either way: a comment that cannot be posted must not turn a
  // decided round into a failed one. The decision is already in the attempt
  // ledger, which is what the next round reads.
  await say(
    {
      codeHost: env.codeHost,
      target: env.reportTarget,
      notificationsSpent: env.notificationsSpent ?? 0,
    },
    kind,
    body,
  )
}

export type { CheatSignal }

// `ciFixResumeArtifacts` / `CI_FIX_RESUME_STAGE` live in
// `domain/ciFixResume.ts` and are re-exported here so existing importers keep
// their path. They moved because the MONITOR is what hands a round its
// inherited answers, and the monitor is application-layer: importing them from
// a composition file would have pointed application at composition, which is
// the one direction RFC-294's layering does not allow.
export {
  ciFixResumeArtifacts,
  CI_FIX_RESUME_STAGE,
} from '@/modules/code-capability/domain/ciFixResume'
