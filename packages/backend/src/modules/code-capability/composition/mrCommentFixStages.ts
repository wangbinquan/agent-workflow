// RFC-304 §6.2 — `mr-comment-fix` as the stage engine runs it.
//
// One registered implementation per contract stage, for the same reason
// `mrReviewStages` is written that way: the engine fires hooks at each stage
// BOUNDARY, so a sequence collapsed into fewer stages silently deletes the
// injection and blocking points teams are promised, and nothing reports it.
//
// ## The shape of this capability
//
// A reviewer says something. An agent edits the worktree. Then a PROGRAM
// decides how the edit reaches them:
//
//   suggestion — small, one file, contiguous. The host renders an apply button.
//                Posting it ends the round: whether they click is theirs to
//                decide and the host's to record, and watching for it would
//                mean polling (N7).
//   patch      — everything else. The change is frozen as a commit, the diff is
//                posted with its digest, and the round STOPS. A later
//                confirmation opens a new round at `verify-baseline`, which
//                re-checks the branch head before pushing the frozen object.
//
// Freezing at post time rather than at confirmation time is the load-bearing
// decision. Days can pass; by then the worktree is gone and re-running the
// model produces a DIFFERENT change with the same justification. The only
// honest push is the one they read.

import {
  freezeArtifact,
  findPendingArtifact,
  releaseArtifact,
  type ArtifactRow,
} from '@/modules/code-capability/application/artifactStore'
import { prepareWorktree } from '@/modules/code-capability/application/prepareWorktree'
import { runGuardedAiStage } from '@/modules/code-capability/application/determinismGuard'
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
  CommentFixEnvelopeSchema,
  type CommentFixEnvelope,
} from '@/modules/code-capability/domain/commentFixEnvelope'
import {
  parseThread,
  renderThreadForPrompt,
  type CollectedThread,
  type ThreadAnchor,
} from '@/modules/code-capability/domain/commentThread'
import {
  patchArtifactMarker,
  shortDigest,
} from '@/modules/code-capability/domain/patchConfirmation'
import {
  apiProjectAddress,
  resolveTarget,
  type RoundTarget,
} from '@/modules/code-capability/domain/resolveTarget'
import {
  decideForm,
  renderSuggestion,
  type DeliveryForm,
  type SuggestionOptions,
} from '@/modules/code-capability/domain/suggestionForm'
import type { CodeHostPort } from '@/modules/code-capability/ports/codeHostPort'
import type { GitPort } from '@/modules/code-capability/ports/gitPort'
import type { DbClient } from '@/db/client'
import type { WebhookTriggerFields } from '@agent-workflow/shared'

const fail = (error: string): StageResult => ({ status: 'failed', error })
const done = (produced: StageArtifacts): StageResult => ({ status: 'done', produced })

function required<T>(artifacts: StageArtifacts, name: string): T {
  const value = artifacts[name]
  if (value === undefined) {
    throw new Error(`stage artifact '${name}' is missing though the contract requires it`)
  }
  return value as T
}

/** The port a fix envelope arrives on. */
export const COMMENT_FIX_PORT = 'fix'

export interface MrCommentFixEnvironment {
  db: DbClient
  codeHost: CodeHostPort
  git: GitPort
  webhook: WebhookTriggerFields
  codeHostEndpointId: string
  repoPath: string
  worktreePath: string
  /** The discussion this round is answering. */
  threadId: string
  /** The work item, so a frozen artifact can be found again by the confirmation. */
  workItemId?: string
  generation?: number
  roundId: string
  /** Injected: this module must not reach the scheduler (AC-10 negative scan). */
  makeCaller: (prompt: string) => AiCaller
  protocolBlock: string
  nonce: string
  budget: RetryBudget
  attemptRecorder?: AttemptRecorder
  suggestion?: SuggestionOptions
  /** Identity for the frozen commit; the author a push shows in `git log`. */
  commitAuthor?: { name: string; email: string }
}

interface ValidatedChange {
  diff: string
  message: string
}

interface PendingArtifactArtifact {
  artifactId: string
  digest: string
  baseSha: string
}

export function mrCommentFixProgramStages(
  env: MrCommentFixEnvironment,
): Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>> {
  return {
    'resolve-target': async () => {
      const resolved = resolveTarget(env.webhook, env.codeHostEndpointId)
      return resolved.ok ? done({ target: resolved.target }) : fail(resolved.message)
    },

    'collect-thread': async (ctx) => {
      const target = required<RoundTarget>(ctx.artifacts, 'target')
      const project = apiProjectAddress(target)
      if (!project.ok) return fail(project.message)

      const listed = await env.codeHost.call({
        action: 'comment.list',
        params: {
          __project__: project.value,
          mr: target.anchorId,
          per_page: '100',
          // GitHub splits line comments and MR-level comments across two
          // endpoints; a review thread is a line comment, so `pulls`.
          ...(target.provider === 'github' ? { comment_scope: 'pulls' } : {}),
        },
        // A long discussion on a busy MR runs past the default cap, and a
        // truncated listing reads as "the thread has three messages" — the
        // agent then answers a conversation it only half received.
        maxResponseBytes: 2 * 1024 * 1024,
      })
      if (!listed.ok) return fail(`could not read the discussion: ${listed.message}`)
      if (listed.truncated) {
        return fail('the discussion listing was truncated, so the thread cannot be read in full')
      }

      const parsed = parseThread(target.provider, listed.body, env.threadId)
      if (!parsed.ok) return fail(parsed.reason)
      // Already settled by a human between the event and this round — common on
      // a busy MR, and answering it anyway posts into a closed conversation.
      if (parsed.thread.resolved) {
        return fail(`discussion ${env.threadId} was resolved before this round started`)
      }

      return done({ thread: parsed.thread, threadAnchor: parsed.anchor })
    },

    'prepare-worktree': async (ctx) => {
      const target = required<RoundTarget>(ctx.artifacts, 'target')
      const result = await prepareWorktree({
        git: env.git,
        repoPath: env.repoPath,
        worktreePath: env.worktreePath,
        target,
      })
      if (result.state === 'ready') {
        return done({ worktree: { path: env.worktreePath, baselineSha: result.sha } })
      }
      if (result.state === 'stale') {
        // Superseded rather than broken: the branch moved before this round
        // could read it, and the fix would be computed against code the
        // reviewer's comment no longer describes.
        return fail(
          `stale-head: the MR moved to ${result.fetchedSha} before this round could read it`,
        )
      }
      return fail(result.message)
    },

    'validate-change': async (ctx) => {
      const change = required<CommentFixEnvelope>(ctx.artifacts, 'change')

      // The agent declined. A settled round with a posted explanation, not a
      // failure: "this whole approach is wrong" and "let's discuss in standup"
      // are comments no edit answers, and forcing one produces a plausible
      // change for a question nobody asked.
      if (change.outcome === 'declined') {
        return done({ validated: { declined: true, message: change.message } })
      }

      const read = await env.git.readWorktreeDiff({ worktreePath: env.worktreePath })
      if (!read.ok) return fail(`could not read what the agent changed: ${read.error}`)

      // The claim is not the evidence. An agent that says `changed` and edited
      // nothing would otherwise reach `post-patch`, which would freeze an empty
      // commit and ask a human to confirm a change that does not exist.
      if (read.diff.trim() === '') {
        return fail('the agent reported a change but the worktree is unmodified')
      }

      return done({
        validated: { diff: read.diff, message: change.message } satisfies ValidatedChange,
      })
    },

    'decide-form': async (ctx) => {
      const validated = ctx.artifacts.validated as ValidatedChange | { declined: true }
      if ('declined' in validated) return done({ form: { kind: 'declined' } })

      const form = decideForm(validated.diff, env.suggestion)
      return done({ form })
    },

    'publish-suggestion': async (ctx) => {
      const form = ctx.artifacts.form as DeliveryForm | { kind: 'declined' }
      const validated = ctx.artifacts.validated as ValidatedChange | { declined: true }
      const target = required<RoundTarget>(ctx.artifacts, 'target')

      if (form.kind === 'declined') {
        const posted = await replyToThread(env, target, (validated as { message: string }).message)
        // Settled, not done: the agent declined, so nothing downstream applies.
        // Letting `post-patch` and `push` run would have them no-op, which is
        // indistinguishable from having worked.
        return posted.ok
          ? {
              status: 'settled',
              produced: { published: { kind: 'declined' } },
              reason: 'the agent declined to change code',
            }
          : fail(posted.error)
      }
      // The patch path's stage does the work; this one steps aside rather than
      // failing, because both are declared stages of one sequence and only one
      // applies per round.
      if (form.kind === 'patch') return done({ published: { kind: 'skipped' } })

      const rendered = renderSuggestion(
        target.provider,
        form.span,
        (validated as ValidatedChange).message,
      )
      const posted = await replyToThread(env, target, rendered.body)
      if (!posted.ok) return fail(posted.error)

      // Terminal. Whether the reviewer clicks apply is theirs to decide and the
      // host's to record; watching for it would mean polling (N7). The patch
      // stages below belong to the other branch and must not run.
      return {
        status: 'settled',
        produced: {
          published: { kind: 'suggestion', anchorLine: rendered.anchorLine, path: form.span.path },
        },
        reason: 'delivered as a one-click suggestion',
      }
    },

    'post-patch': async (ctx) => {
      const form = ctx.artifacts.form as DeliveryForm | { kind: 'declined' }
      const target = required<RoundTarget>(ctx.artifacts, 'target')

      // Unreachable in practice: `publish-suggestion` settles the sequence on
      // both of the other branches. Kept as a stated refusal rather than an
      // assumption, because a future branch added upstream would otherwise
      // reach here and freeze an artifact for a change already delivered.
      if (form.kind !== 'patch') {
        return { status: 'settled', reason: 'this change was not delivered as a patch' }
      }

      const validated = required<ValidatedChange>(ctx.artifacts, 'validated')
      const frozen = await freezeArtifact({
        db: env.db,
        git: env.git,
        repoPath: env.repoPath,
        worktreePath: env.worktreePath,
        baseSha: target.headSha,
        message: firstLine(validated.message),
        roundId: env.roundId,
        ...(env.workItemId === undefined ? {} : { workItemId: env.workItemId }),
        ...(env.generation === undefined ? {} : { generation: env.generation }),
        ...(env.commitAuthor === undefined
          ? {}
          : { authorName: env.commitAuthor.name, authorEmail: env.commitAuthor.email }),
      })
      if (!frozen.ok) {
        return fail(
          frozen.reason === 'no-changes'
            ? 'the agent reported a change but the worktree is unmodified'
            : `could not freeze the change: ${frozen.error}`,
        )
      }

      const posted = await replyToThread(
        env,
        target,
        renderPatchComment(
          validated.message,
          frozen.artifact.diff,
          frozen.artifact.digest,
          form.reason,
        ),
      )
      if (!posted.ok) {
        // The change is frozen but nobody was told about it. Release it rather
        // than leaving a ref pinning a commit no confirmation can ever name.
        await releaseArtifact(env.db, env.git, frozen.artifact.id, 'abandoned')
        return fail(posted.error)
      }

      return {
        status: 'awaiting',
        resumeAt: 'verify-baseline',
        reason: `waiting for confirmation of change ${shortDigest(frozen.artifact.digest)}`,
        produced: {
          pendingArtifact: {
            artifactId: frozen.artifact.id,
            digest: frozen.artifact.digest,
            baseSha: frozen.artifact.baseSha,
          } satisfies PendingArtifactArtifact,
        },
      }
    },

    'verify-baseline': async (ctx) => {
      const target = required<RoundTarget>(ctx.artifacts, 'target')
      const pending = await resolvePendingArtifact(env, ctx)
      if (pending === null) {
        return fail('there is no frozen change waiting for confirmation on this work item')
      }

      // The C7 check, done as late as possible. The branch can move at any
      // point while a person is deciding, and applying a change built on what
      // it used to be would clobber whatever arrived in between.
      if (pending.baseSha !== target.headSha) {
        await releaseArtifact(env.db, env.git, pending.id, 'superseded')
        return fail(
          `the branch moved from ${pending.baseSha.slice(0, 12)} to ${target.headSha.slice(0, 12)} while this change was waiting, so it was not pushed`,
        )
      }

      return done({ verified: { artifactId: pending.id, commitSha: pending.commitSha } })
    },

    push: async (ctx) => {
      const verified = required<{ artifactId: string; commitSha: string }>(
        ctx.artifacts,
        'verified',
      )
      const target = required<RoundTarget>(ctx.artifacts, 'target')
      // `branch` is the source branch for every MR-shaped event (the envelope's
      // own contract). Absent means the delivery could not name where the
      // change lives, and guessing the default branch would push a review fix
      // onto trunk.
      const branch = env.webhook.branch ?? ''
      if (branch === '') {
        return fail('the trigger context carries no source branch, so there is nowhere to push')
      }

      const pushed = await env.git.pushCommit({
        repoPath: env.repoPath,
        commitSha: verified.commitSha,
        branch,
        expectedRemoteSha: target.headSha,
      })
      if (!pushed.ok) {
        // A lease failure means somebody pushed in the window between the
        // baseline check and this call. Not an error worth alarming about —
        // the artifact is released and the author is told.
        await releaseArtifact(
          env.db,
          env.git,
          verified.artifactId,
          pushed.reason === 'stale' ? 'superseded' : 'abandoned',
        )
        return fail(
          pushed.reason === 'stale'
            ? 'the branch moved just before the push, so the change was not applied'
            : `the push failed: ${pushed.error}`,
        )
      }

      await releaseArtifact(env.db, env.git, verified.artifactId, 'consumed')
      await replyToThread(env, target, 'Pushed.')
      return done({ pushed: { commitSha: verified.commitSha, branch } })
    },
  }
}

/**
 * The AI stage, separately so a caller can refuse it when no agent is bound.
 *
 * `mrReviewStages` splits the maps the same way, and for the same reason: a
 * round with an unbound slot must fail with "no agent is bound", not with
 * whatever a missing caller does three stages later.
 */
export function mrCommentFixAiStages(
  env: MrCommentFixEnvironment,
): Readonly<Record<string, (ctx: StageRunContext) => Promise<StageResult>>> {
  return {
    'apply-change': async (ctx) => {
      const thread = required<CollectedThread>(ctx.artifacts, 'thread')
      const anchor = (ctx.artifacts.threadAnchor ?? null) as ThreadAnchor | null

      const prompt = [
        'A reviewer left the discussion below on a merge request. Make the change it asks for.',
        '',
        renderThreadForPrompt(thread, anchor),
        '',
        'Edit the files in the working tree directly. Keep the change as small as the',
        'comment asks for — do not refactor around it, and do not fix unrelated things',
        'you notice on the way.',
        '',
        'If the comment is not asking for a code change (a question, a discussion, a',
        'request to rebase), reply with outcome "declined" and say why. Declining is a',
        'correct answer and is preferred over inventing an edit.',
      ].join('\n')

      const outcome = await runGuardedAiStage<CommentFixEnvelope>({
        caller: env.makeCaller(`${prompt}\n${env.protocolBlock}`),
        schema: CommentFixEnvelopeSchema,
        nonce: env.nonce,
        portName: COMMENT_FIX_PORT,
        budget: env.budget,
        ...(env.attemptRecorder !== undefined ? { recorder: env.attemptRecorder } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      })

      if (outcome.status === 'canceled') return fail('the round was canceled')
      if (outcome.status === 'exhausted') {
        return fail(
          `the fixing agent did not produce a valid result after ${String(outcome.totalCalls)} attempts`,
        )
      }
      return done({ change: outcome.value })
    },
  }
}

/**
 * What a confirming round must be handed to resume at `verify-baseline`.
 *
 * The posting round's task ended — possibly days ago — so nothing it computed
 * survives in this process. Everything the resumed stages read is recomputed
 * from durable state here: the target from the trigger context (which the task
 * row carries), and the artifact from the store.
 *
 * Recomputed rather than persisted as a blob, because the two are not the same
 * claim. A stored `target` would assert what the merge request looked like when
 * it was stored; a recomputed one asserts what it looks like now — and
 * `verify-baseline` exists precisely to compare those.
 */
export function commentFixResumeArtifacts(env: MrCommentFixEnvironment): Record<string, unknown> {
  const resolved = resolveTarget(env.webhook, env.codeHostEndpointId)
  // An unresolvable target is left absent rather than faked: `verify-baseline`
  // then fails with the contract's own "missing required artifact", which is
  // accurate, instead of comparing against a placeholder.
  return resolved.ok ? { target: resolved.target } : {}
}

/** The artifact this round is confirming, from the sequence or from the store. */
async function resolvePendingArtifact(
  env: MrCommentFixEnvironment,
  ctx: StageRunContext,
): Promise<(ArtifactRow & { commitSha: string }) | null> {
  // Inherited from the posting round when the engine carried it across; read
  // from the store when the confirming round starts cold, which is the normal
  // case — the posting round's task ended days ago.
  const inherited = ctx.artifacts.pendingArtifact as PendingArtifactArtifact | undefined
  if (env.workItemId === undefined) return null

  const row = await findPendingArtifact(env.db, env.workItemId)
  if (row === null) return null
  if (inherited !== undefined && inherited.artifactId !== row.id) {
    // The pending artifact is not the one this round posted, which means a
    // newer change replaced it. Confirming the old one would push something
    // the person did not see.
    return null
  }
  return row
}

async function replyToThread(
  env: MrCommentFixEnvironment,
  target: RoundTarget,
  body: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const project = apiProjectAddress(target)
  if (!project.ok) return { ok: false, error: project.message }

  const result = await env.codeHost.call({
    action: 'comment.reply-thread',
    params: {
      __project__: project.value,
      mr: target.anchorId,
      thread: env.threadId,
      body,
    },
  })
  return result.ok ? { ok: true } : { ok: false, error: `could not reply: ${result.message}` }
}

/** A commit subject: one line, however many the agent wrote. */
function firstLine(message: string): string {
  const line = message.split('\n')[0]?.trim() ?? ''
  return line === '' ? 'apply review comment' : line.slice(0, 72)
}

/**
 * The posted patch comment.
 *
 * Three things, in the order a reader needs them: what was done, why it is not
 * a one-click suggestion, and the diff. The digest marker at the end is
 * invisible and is what ties a later `/aw apply` to this exact change.
 */
export function renderPatchComment(
  message: string,
  diff: string,
  digest: string,
  whyNotSuggestion: string,
): string {
  return [
    message.trim(),
    '',
    `This is posted as a diff rather than a suggestion because ${whyNotSuggestion}.`,
    '',
    '```diff',
    diff.trimEnd(),
    '```',
    '',
    `Reply \`/aw apply\` to push this change (\`${shortDigest(digest)}\`). It is pushed exactly as shown — if the branch moves in the meantime it will be discarded rather than applied.`,
    '',
    patchArtifactMarker(digest),
  ].join('\n')
}
