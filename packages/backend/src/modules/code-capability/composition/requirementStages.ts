// RFC-304 §6.3 — `requirement` as the stage engine runs it.
//
// Somebody labels an issue, or submits a set of design documents, and this
// builds it and opens a merge request. The shape that matters:
//
//   resolve-input → materialize-attachments → prepare-worktree
//     → comprehend(ai) → [needs-clarification → clarify → awaiting]
//     → implement(ai) → run-target-gate → self-review(invoke) → open-mr → ledger
//
// ## The pause in the middle is the point
//
// `comprehend` may answer `needs-clarification`, and that is a first-class
// outcome rather than a failure. An agent that cannot ask will not ask: it
// fills the gap with the most plausible reading and produces a merge request
// implementing a requirement nobody wrote. That result compiles, has tests, and
// solves the wrong problem — which is worse than no result, because it consumes
// a reviewer's trust before it consumes their time.
//
// The question goes back where the requirement came FROM (design D2), and when
// there is no way back the round refuses to start rather than asking somewhere
// the person is not looking.
//
// ## Why the gate is read rather than configured
//
// `run-target-gate` reads the TARGET repository's own contributor docs for the
// command it should run. Hardcoding one would be wrong in most repositories,
// and configuring one per cell would make every team restate what their
// CONTRIBUTING.md already says.

import {
  runGuardedAiStage,
  exhaustionDetail,
} from '@/modules/code-capability/application/determinismGuard'
import type {
  AiCaller,
  AttemptRecorder,
  RetryBudget,
} from '@/modules/code-capability/application/determinismGuard'
import { registerProducedMr } from '@/modules/code-capability/application/producedMrIndex'
import type {
  StageArtifacts,
  StageResult,
  StageRunContext,
} from '@/modules/code-capability/application/stageEngine'
import {
  clarifyMarker,
  renderClarifyComment,
  routeClarify,
  type ClarifyOrigin,
} from '@/modules/code-capability/domain/clarifyRouting'
import {
  ComprehendEnvelopeSchema,
  ImplementEnvelopeSchema,
  type ComprehendEnvelope,
  type ImplementEnvelope,
} from '@/modules/code-capability/domain/requirementEnvelope'
import {
  judgeDocumentBudget,
  renderRequirementForPrompt,
  RequirementInputSchema,
  type DocumentBudget,
  type RequirementInput,
} from '@/modules/code-capability/domain/requirementInput'
import {
  describeGateOutcome,
  findGateCommand,
  GATE_DOC_CANDIDATES,
  type GateOutcome,
} from '@/modules/code-capability/domain/targetGate'
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

/** The port a comprehend / implement envelope arrives on. */
export const COMPREHEND_PORT = 'comprehension'
export const IMPLEMENT_PORT = 'implementation'

export interface RequirementEnvironment {
  db: DbClient
  codeHost: CodeHostPort
  git: GitPort
  /** Which connection; part of the produced-MR index key. */
  codeHostEndpointId: string
  provider: 'gitlab' | 'github'
  /** The API-addressable project, as `apiProjectAddress` would render it. */
  projectRef: string
  repoPath: string
  worktreePath: string
  /** Branch the merge request targets; the repository's default unless set. */
  targetBranch: string
  /** The requirement itself, or the entry script's job to fetch (T48). */
  input: RequirementInput | null
  /** Where a question goes (design D2). */
  origin: ClarifyOrigin
  workItemId: string
  roundId: string
  roundSeq: number
  /** See `MrCommentFixEnvironment.makeCaller` for why the port is a parameter. */
  makeCaller: (prompt: string, slot: 'analyst' | 'implementer', port: string) => AiCaller
  nonce: string
  budget: RetryBudget
  attemptRecorder?: AttemptRecorder
  documentBudget?: DocumentBudget
  /** Reads a file out of the worktree; injected so stages stay testable. */
  readWorktreeFile: (relativePath: string) => Promise<string | null>
  /** Runs the target repository's own gate command in the worktree. */
  runGateCommand: (command: string) => Promise<{ exitCode: number; output: string }>
  commitAuthor?: { name: string; email: string }
}

interface Attachments {
  materialized: number
}

export function requirementProgramStages(
  env: RequirementEnvironment,
): Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>> {
  return {
    'resolve-input': async () => {
      if (env.input === null) {
        // The entry script's job (design D5) — a reference was given rather
        // than the content. Refused rather than guessed: fetching "issue 88"
        // means knowing which system and which credentials, which is exactly
        // what the department layer supplies.
        return fail(
          'this requirement was submitted as a reference, and no entry script is configured to fetch it',
        )
      }

      const parsed = RequirementInputSchema.safeParse(env.input)
      if (!parsed.success) {
        return fail(
          `the requirement input does not match its contract: ${parsed.error.issues[0]?.message ?? ''}`,
        )
      }

      // The budget check belongs HERE, before a model is called: refusing after
      // the model has read a truncated set would have paid for the answer and
      // still have to throw it away.
      const budget = judgeDocumentBudget(parsed.data, env.documentBudget)
      if (!budget.fits) return fail(budget.message)

      return done({ requirement: parsed.data })
    },

    'materialize-attachments': async (ctx) => {
      // A stage of its own even though v1 has no attachment transport, because
      // it is a declared hook mount point: a team whose documents live in a
      // wiki writes a `pre` hook here that fetches them into the worktree.
      // Collapsing it into `resolve-input` would remove that mount point while
      // nothing failed.
      const requirement = required<RequirementInput>(ctx.artifacts, 'requirement')
      return done({ attachments: { materialized: requirement.documents.length } })
    },

    'prepare-worktree': async () => {
      const fetched = await env.git.fetchRef({
        repoPath: env.repoPath,
        refspec: env.targetBranch,
      })
      if (!fetched.ok) {
        return fail(`could not fetch '${env.targetBranch}': ${fetched.error}`)
      }
      const checkout = await env.git.checkoutDetached({
        worktreePath: env.worktreePath,
        sha: fetched.resolvedSha,
      })
      if (!checkout.ok) return fail(checkout.error)

      return done({ worktree: { path: env.worktreePath, baselineSha: fetched.resolvedSha } })
    },

    clarify: async (ctx) => {
      const comprehension = required<ComprehendEnvelope>(ctx.artifacts, 'understanding')
      if (comprehension.outcome !== 'needs-clarification') {
        // Not this round's path — `comprehend` was satisfied.
        return { status: 'done', produced: {} }
      }

      const route = routeClarify(env.origin)
      if (route.route === 'refuse') {
        // Should not be reachable: the readiness check asks the same question
        // before the cell is usable. Kept as a stated refusal because "should
        // not be reachable" and "is not reachable" differ by one configuration
        // change, and the alternative is asking into the void.
        return fail(route.message)
      }

      const body = renderClarifyComment(env.roundId, comprehension.questions)
      if (route.route === 'issue-comment') {
        const handle = env.input?.writebackHandle
        if (handle === undefined) return fail('there is no write-back handle for this issue')
        const posted = await env.codeHost.call({
          action: 'comment.create',
          params: { ...handle.params, body },
        })
        if (!posted.ok) return fail(`could not post the question: ${posted.message}`)
      }

      return {
        status: 'awaiting',
        // Back to `comprehend`, NOT to `implement`. The answer changes the
        // reading, so the model has to read it again — which is the opposite of
        // the frozen-artifact wait, where re-running the model is exactly what
        // must not happen (T4b's two wait kinds, expressed as two resume
        // points rather than as a flag that could disagree with them).
        resumeAt: 'comprehend',
        reason: `waiting for an answer to ${String(comprehension.questions.length)} question(s)`,
        produced: {
          clarification: {
            askedAt: route.route,
            marker: clarifyMarker(env.roundId, comprehension.questions[0]?.id ?? 'q1'),
          },
        },
      }
    },

    'run-target-gate': async () => {
      // Read the repository's own instructions to contributors. A hardcoded
      // command would be wrong in most repositories, and confidently so.
      let found: ReturnType<typeof findGateCommand> = null
      for (const candidate of GATE_DOC_CANDIDATES) {
        const contents = await env.readWorktreeFile(candidate)
        if (contents === null) continue
        found = findGateCommand(candidate, contents)
        if (found !== null) break
      }

      if (found === null) {
        // The round CONTINUES. The platform learned nothing, which is different
        // from learning the change is bad — and stopping here would make the
        // capability unusable in every repository documenting its checks
        // somewhere this parser cannot read.
        const outcome: GateOutcome = { kind: 'not-found', searched: GATE_DOC_CANDIDATES }
        return done({ gateResult: outcome })
      }

      let ran: { exitCode: number; output: string }
      try {
        ran = await env.runGateCommand(found.command)
      } catch (err) {
        const outcome: GateOutcome = {
          kind: 'unrunnable',
          command: found.command,
          reason: err instanceof Error ? err.message : String(err),
        }
        return done({ gateResult: outcome })
      }

      if (ran.exitCode !== 0) {
        // The one gate outcome that stops the round: the repository's own
        // checks say the change is broken, and opening a merge request from it
        // spends a reviewer's attention on something already known to be wrong.
        return fail(
          `the target repository's gate failed: \`${found.command}\` exited ${String(ran.exitCode)}\n\n${ran.output.trim().slice(0, 2000)}`,
        )
      }

      const outcome: GateOutcome = { kind: 'passed', command: found.command, source: found.source }
      return done({ gateResult: outcome })
    },

    'open-mr': async (ctx) => {
      const implementation = required<ImplementEnvelope>(ctx.artifacts, 'implementation')
      const gate = required<GateOutcome>(ctx.artifacts, 'gateResult')

      const frozen = await env.git.commitWorktree({
        repoPath: env.repoPath,
        worktreePath: env.worktreePath,
        message: implementation.title,
        // A branch push makes the commit reachable, so the keep-alive ref is
        // released immediately after. It exists only to cover the window
        // between committing and pushing.
        keepRef: `refs/aw/requirement/${env.roundId}`,
        ...(env.commitAuthor === undefined
          ? {}
          : { authorName: env.commitAuthor.name, authorEmail: env.commitAuthor.email }),
      })
      if (!frozen.ok) {
        return fail(
          frozen.reason === 'no-changes'
            ? 'the implementing agent reported a change but the worktree is unmodified'
            : `could not commit the implementation: ${frozen.error}`,
        )
      }

      const branch = requirementBranchName(env.roundId, env.roundSeq)
      const pushed = await env.git.pushNewBranch({
        repoPath: env.repoPath,
        commitSha: frozen.commitSha,
        branch,
      })
      await env.git.deleteRef({ repoPath: env.repoPath, ref: `refs/aw/requirement/${env.roundId}` })
      if (!pushed.ok) return fail(`could not push '${branch}': ${pushed.error}`)

      const created = await env.codeHost.call({
        action: 'mr.create',
        params: {
          project: env.projectRef,
          source_branch: branch,
          target_branch: env.targetBranch,
          title: implementation.title,
          description: renderMrDescription(implementation, gate),
        },
      })
      if (!created.ok) return fail(`could not open the merge request: ${created.message}`)

      const mrIid = readCreatedMrIid(env.provider, created.body)
      if (mrIid === null) {
        // The merge request exists but the platform cannot name it, so it can
        // never be indexed and the requirement can never close. Loud, because
        // the alternative is a work item that stays open after its code ships.
        return fail('the merge request was created but the code host did not return its number')
      }

      // T50b — the reverse index, in the same stage that created the MR. This
      // is the only moment both facts are in one place: the terminal event
      // arrives days later knowing only the merge request.
      await registerProducedMr({
        db: env.db,
        codeHostEndpointId: env.codeHostEndpointId,
        stableProjectId: env.projectRef,
        mrIid,
        workItemId: env.workItemId,
        roundId: env.roundId,
      })

      return done({ producedMr: { mrIid, branch, commitSha: frozen.commitSha } })
    },

    ledger: async (ctx) => {
      const produced = required<{ mrIid: string }>(ctx.artifacts, 'producedMr')
      return done({ ledgerEntry: { mrIid: produced.mrIid, at: Date.now() } })
    },
  }
}

export function requirementAiStages(
  env: RequirementEnvironment,
): Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>> {
  return {
    comprehend: async (ctx) => {
      const requirement = required<RequirementInput>(ctx.artifacts, 'requirement')

      const prompt = [
        'Read the requirement below and decide whether it says enough to implement.',
        '',
        renderRequirementForPrompt(requirement),
        '',
        'If anything you would need to decide is genuinely unstated — a behaviour, a',
        'boundary, a name that has to match something you cannot see — reply with',
        'outcome "needs-clarification" and ask. Asking is a correct answer and is',
        'strongly preferred over choosing the most plausible reading: a merge request',
        'that implements a requirement nobody wrote costs more than a question does.',
        '',
        'Otherwise reply "ready" and state your understanding in your own words.',
      ].join('\n')

      const outcome = await runGuardedAiStage<ComprehendEnvelope>({
        caller: env.makeCaller(prompt, 'analyst', COMPREHEND_PORT),
        schema: ComprehendEnvelopeSchema,
        nonce: env.nonce,
        portName: COMPREHEND_PORT,
        budget: env.budget,
        ...(env.attemptRecorder !== undefined ? { recorder: env.attemptRecorder } : {}),
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      })

      if (outcome.status === 'canceled') return fail('the round was canceled')
      if (outcome.status === 'exhausted') {
        return fail(
          `the analyst did not produce a valid result after ${String(outcome.totalCalls)} attempts${exhaustionDetail(outcome.rejections)}`,
        )
      }
      return done({ understanding: outcome.value })
    },

    implement: async (ctx) => {
      const requirement = required<RequirementInput>(ctx.artifacts, 'requirement')
      const comprehension = required<ComprehendEnvelope>(ctx.artifacts, 'understanding')

      if (comprehension.outcome === 'needs-clarification') {
        // Unreachable in a first pass — `clarify` settles the round `awaiting`
        // before this. Stated rather than assumed, because implementing against
        // an unanswered question is the exact failure the pause exists for.
        return fail('the requirement is still waiting on an answer, so nothing was implemented')
      }

      const prompt = [
        'Implement the requirement below in the working tree.',
        '',
        renderRequirementForPrompt(requirement),
        '',
        'Your own reading of it, from the previous step:',
        comprehension.understanding,
        '',
        'Edit files directly. Follow the conventions the repository already uses —',
        'read its contributor documentation before deciding how something should look.',
        '',
        'If part of it turns out to be out of scope or unworkable, implement the rest',
        'and list what you left out. A partial change with an honest list beats a',
        'complete-looking one that quietly skipped something.',
      ].join('\n')

      const outcome = await runGuardedAiStage<ImplementEnvelope>({
        caller: env.makeCaller(prompt, 'implementer', IMPLEMENT_PORT),
        schema: ImplementEnvelopeSchema,
        nonce: env.nonce,
        portName: IMPLEMENT_PORT,
        budget: env.budget,
        ...(env.attemptRecorder !== undefined ? { recorder: env.attemptRecorder } : {}),
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      })

      if (outcome.status === 'canceled') return fail('the round was canceled')
      if (outcome.status === 'exhausted') {
        return fail(
          `the implementer did not produce a valid result after ${String(outcome.totalCalls)} attempts${exhaustionDetail(outcome.rejections)}`,
        )
      }
      return done({ implementation: outcome.value })
    },
  }
}

/**
 * The branch a requirement round pushes to.
 *
 * Round-scoped rather than issue-scoped: a second round on the same issue is a
 * second attempt, and reusing the branch would either be refused as a
 * non-fast-forward or silently rewrite the first attempt's merge request.
 */
export function requirementBranchName(roundId: string, roundSeq: number): string {
  return `aw/requirement/${roundId.toLowerCase()}-${String(roundSeq)}`
}

/**
 * What the merge request says about itself.
 *
 * The gate line is not decoration. A reviewer's first question about an
 * automated change is whether it was checked, and "no gate was found" must not
 * read as "checks passed" — which is why `describeGateOutcome` owns that
 * sentence rather than this function paraphrasing it.
 */
export function renderMrDescription(implementation: ImplementEnvelope, gate: GateOutcome): string {
  const parts = [implementation.summary.trim(), '', describeGateOutcome(gate)]

  if (implementation.deferred.length > 0) {
    parts.push(
      '',
      'Deliberately not done:',
      ...implementation.deferred.map((entry) => `- ${entry}`),
    )
  }

  return parts.join('\n')
}

/**
 * The new merge request's number, from the create response.
 *
 * GitLab returns `iid` and GitHub returns `number`, and neither returns the
 * other. Reading `id` instead would look right on both and be wrong on both:
 * it is the global object id, which no REST path here accepts.
 */
export function readCreatedMrIid(provider: 'gitlab' | 'github', body: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const row = parsed as Record<string, unknown>
  const value = provider === 'gitlab' ? row.iid : row.number
  if (typeof value === 'number') return String(value)
  return typeof value === 'string' && value !== '' ? value : null
}

/** A round id is unique already; the suffix exists only for readability. */
export function requirementKeepRef(roundId: string): string {
  return `refs/aw/requirement/${roundId}`
}

export type { Attachments }
