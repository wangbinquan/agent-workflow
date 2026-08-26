// RFC-075 — auto commit&push executor (T9/T10).
//
// The framework OWNS git here: stage (`add -A`), commit (with the task
// identity), push. opencode is only consulted for the commit MESSAGE and to
// REPAIR a rejected push — both injected as callbacks (`generateMessage` /
// `generateRepair`) so this orchestration is unit-testable against real git
// without spawning opencode. Production wires those callbacks to the runner
// (which captures the opencode session under THIS commit node_run id, so the
// detail-page "view session" button works).
//
// One node_run row per commit attempt; the internal repair loop records its
// count in `commit_push_json.repairAttempts` (surfaced as "retried N times" on
// the commit row). git is never asked to force-push. A push that can't be
// honored never loses the agent's work — the local commit always lands first.

import { eq } from 'drizzle-orm'
import type {
  CommitPushMeta,
  CommitPushOutcome,
  RepositoryPublicationReceipt,
  SubrepoPushResult,
} from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { nodeRuns } from '@/db/schema'
import { createLocalEffectAttemptObserver } from '@/modules/task-execution/application/localEffectObserver'
import { mintNodeRun } from '@/services/nodeRunMint'
import { createLogger, type Logger } from '@/util/log'
import { AW_INTERNAL_GIT_IDENTITY, runGit as realRunGit } from '@/util/git'
import { join } from 'node:path'
// RFC-210: recursive submodule commit&push.
import {
  bottomUp,
  detectSubmodules,
  listEffectiveSubmodules,
  usableSubmodules,
} from '@/services/gitSubmodule'
import {
  buildFallbackMessage,
  classifyPushFailure,
  commitPushNodeId,
  parseNumstat,
  redactPushError,
  truncateDiff,
} from '@/services/commitPush'
import {
  bindRepositoryCommitParticipant,
  classifyRepositoryPushFailure,
  createRepositoryPublicationTransport,
} from '@/modules/source-control/composition'
import type {
  RepositoryPublicationSubject,
  RepositoryPublicationTransport,
} from '@/modules/source-control/public/types'
import { Paths } from '@/util/paths'
import { sha256Hex } from '@/util/hash'

type RunGit = typeof realRunGit

export interface GenerateMessageCtx {
  nodeRunId: string
  repoName: string
  branch: string
  baseRef: string
  stat: string
  diffTruncated: string
}
export interface GenerateRepairCtx {
  nodeRunId: string
  branch: string
  stat: string
  pushStderr: string
  currentMessage: string
  priorAttempts: number
}
export interface GeneratedMessage {
  /** null → caller falls back to the deterministic template message. */
  message: string | null
  /** opencode session id to stamp on the node_run, when the generator spawned one. */
  sessionId?: string | null
  /** The generator child may still be alive; no git mutation or replacement is safe. */
  processUnreaped?: true
}

class CommitAgentUnreapedError extends Error {
  constructor() {
    super('commit agent child could not be reaped; refusing framework git mutation')
    this.name = 'CommitAgentUnreapedError'
  }
}

export interface CommitPushParams {
  taskId: string
  /** The workflow node whose completion triggered this commit. */
  agentNodeId: string
  /** Human-readable agent name for the fallback commit message. */
  agentName: string
  /** node_run id of the triggering agent (becomes parentNodeRunId). */
  parentNodeRunId: string | null
  worktreePath: string
  /** Stable source-repository identity for cross-worktree publication fencing. */
  repositoryIdentity?: string
  /** Local branch to commit on + push (working branch or isolation branch). */
  repoBranch: string
  /** Base ref the worktree was branched from (for prompt context). */
  baseRef: string
  /** Multi-repo disambiguator for the synthetic node id; omit for single-repo. */
  repoSlug?: string
  /** Push remote. Default 'origin'. */
  pushRemote?: string
  /** Persisted work owner; null/system tasks deliberately skip the personal layer. */
  ownerUserId?: string | null
  gitUserName: string | null
  gitUserEmail: string | null
  maxRepairRetries: number
  diffMaxBytes: number
  /** RFC-308: one immutable config slice for this whole publication attempt. */
  excludePatterns?: readonly string[]
  generateMessage: (ctx: GenerateMessageCtx) => Promise<GeneratedMessage>
  generateRepair: (ctx: GenerateRepairCtx) => Promise<GeneratedMessage>
  /**
   * RFC-076 C4 — optional write-lock acquirer (the scheduler passes its
   * per-task `writeSem.acquire`). Held ONLY around `git add -A` + the
   * `git diff --cached` capture so the staged index snapshot is consistent: a
   * sibling writer node still in flight under the completion-driven race loop
   * could otherwise mutate the worktree mid-`add`, splitting its changes across
   * two commits. Writer nodes hold the same Semaphore(1) for their whole run, so
   * acquiring it here means "capture only when no writer is mid-write" — the
   * quiescence the old batch barrier gave for free. Released BEFORE the LLM
   * message-gen / commit / push (those operate on the frozen index, so a writer
   * resuming after the snapshot lands in its OWN later commit). Omit → no lock
   * (single-writer / test callers take a byte-identical unlocked path).
   */
  acquireWrite?: () => Promise<() => void>
}

export interface CommitPushDeps {
  db: DbClient
  /** Injectable for tests; defaults to the real git CLI. */
  runGit?: RunGit
  log?: Logger
  /** RFC-321 exact publication transport; production supplies the sealed-key composition. */
  publicationTransport?: RepositoryPublicationTransport
}

/**
 * Stage all changes, commit with an LLM-generated message, and push — handling
 * a rejected push per RFC-075 (auth → commit-local + warn; everything else →
 * bounded repair / non-FF merge then re-push). Always returns the resulting
 * `CommitPushMeta` AND persists it (+ the node_run row) so the caller doesn't
 * have to. Never throws for an expected git outcome; only truly unexpected
 * errors (e.g. the worktree vanished) propagate.
 */
export async function runCommitPush(
  params: CommitPushParams,
  deps: CommitPushDeps,
): Promise<{ nodeRunId: string; meta: CommitPushMeta; processUnreaped?: true }> {
  const db = deps.db
  const runGit = deps.runGit ?? realRunGit
  const log = deps.log ?? createLogger('commit-push')
  const W = params.worktreePath
  const remote = params.pushRemote ?? 'origin'
  const publicationTransport =
    deps.publicationTransport ??
    createRepositoryPublicationTransport({ db, appHome: Paths.root, runGit })
  const publicationSubject: RepositoryPublicationSubject =
    params.ownerUserId === undefined ||
    params.ownerUserId === null ||
    params.ownerUserId === '__system__'
      ? { kind: 'system' }
      : { kind: 'user', userId: params.ownerUserId }
  const idEnv = identityEnv(params.gitUserName, params.gitUserEmail)
  const g = (args: string[]) => runGit(W, args)
  // Commit-class operations (commit / amend / merge) carry the identity as
  // GIT_AUTHOR_*/GIT_COMMITTER_* env — git gives those precedence over any
  // `-c user.*`, so inherited daemon env (a user shell exporting GIT_AUTHOR_*)
  // can never leak into, or break, framework commits.
  const gc = (args: string[]) => runGit(W, args, { env: idEnv })

  const nodeId = commitPushNodeId(params.agentNodeId, params.repoSlug)
  const startedAt = Date.now()
  // Born 'running' (NOT through the RFC-053 state machine — it governs
  // updates, not inserts): this container row is always a CHILD of the
  // triggering agent run, so it never enters deriveFrontier's in-flight set.
  // mintNodeRun enforces exactly that invariant (RFC-098 revision #10).
  const nodeRunId = await mintNodeRun(db, {
    taskId: params.taskId,
    nodeId,
    status: 'running',
    cause: 'commit-push',
    overrides: { parentNodeRunId: params.parentNodeRunId, startedAt },
  })
  const repositoryEffect = createLocalEffectAttemptObserver({
    db,
    taskId: params.taskId,
    nodeRunId,
    kind: 'repository',
    stableActionOrdinal: `repository-publication:${params.agentNodeId}:${params.repoSlug ?? ''}`,
    candidateId: 'commit-and-push',
    request: {
      v: 1,
      branch: params.repoBranch,
      baseRef: params.baseRef,
      remote,
      repoSlug: params.repoSlug ?? '',
    },
    resourceKeys: [
      `workspace:${sha256Hex(W)}`,
      `repository:${sha256Hex(`${params.repositoryIdentity ?? W}\u0000${remote}\u0000${params.repoBranch}`)}`,
    ],
  })
  repositoryEffect?.beforeAct()

  const pushTarget = `${remote}/${params.repoBranch}`
  let sessionId: string | null = null
  let processUnreaped = false
  // RFC-210: filled by the submodule stage below and attached by EVERY finalize
  // path — threading it through each call site individually is how the happy
  // path silently lost it the first time.
  let subrepos: SubrepoPushResult[] = []
  const excludedPaths = new Set<string>()
  let exclusionPolicyDigest: string | null = null
  let exclusionHistoryBlocked = false
  let publicationReceipt: RepositoryPublicationReceipt | null = null

  const finalize = async (
    outcome: CommitPushOutcome,
    extra: {
      commitSha?: string | null
      filesChanged?: number
      insertions?: number
      deletions?: number
      messageSource?: CommitPushMeta['messageSource']
      repairAttempts?: number
      pushError?: string | null
    },
  ): Promise<{ nodeRunId: string; meta: CommitPushMeta; processUnreaped?: true }> => {
    const meta: CommitPushMeta = {
      repoPath: W,
      repoBranch: params.repoBranch,
      pushTarget,
      baseRef: params.baseRef,
      commitSha: extra.commitSha ?? null,
      filesChanged: extra.filesChanged ?? 0,
      insertions: extra.insertions ?? 0,
      deletions: extra.deletions ?? 0,
      messageSource: extra.messageSource ?? 'fallback',
      repairAttempts: extra.repairAttempts ?? 0,
      pushOutcome: outcome,
      pushError: extra.pushError ?? null,
      ...(exclusionPolicyDigest !== null
        ? {
            exclusions: {
              count: excludedPaths.size,
              paths: [...excludedPaths].sort().slice(0, 100),
              truncated: excludedPaths.size > 100,
              policyDigest: exclusionPolicyDigest,
              historyBlocked: exclusionHistoryBlocked,
            },
          }
        : {}),
      ...(subrepos.length > 0 ? { subrepos } : {}),
      ...(publicationReceipt === null ? {} : { publicationReceipt }),
    }
    // `commit-local-failed` is the only failed status; everything else
    // (pushed / commit-local-auth degraded / skipped-empty) is a done row so a
    // push problem the framework can't fix never aborts the task.
    // RFC-210: a withheld parent (because a submodule could not be pushed) is a
    // FAILED row too — the node produced work that never reached the remote, and
    // showing it as done would hide that.
    const status =
      outcome === 'commit-local-failed' ||
      outcome === 'commit-local-subrepo-failed' ||
      outcome === 'commit-local-excluded-history'
        ? 'failed'
        : 'done'
    const persistMeta = (tx: DbTxSync): void => {
      tx.update(nodeRuns)
        .set({
          status,
          finishedAt: Date.now(),
          ...(sessionId !== null ? { opencodeSessionId: sessionId } : {}),
          commitPushJson: JSON.stringify(meta),
        })
        .where(eq(nodeRuns.id, nodeRunId))
        .run()
    }
    if (repositoryEffect === undefined) {
      await db
        .update(nodeRuns)
        .set({
          status,
          finishedAt: Date.now(),
          ...(sessionId !== null ? { opencodeSessionId: sessionId } : {}),
          commitPushJson: JSON.stringify(meta),
        })
        .where(eq(nodeRuns.id, nodeRunId))
    } else {
      repositoryEffect.succeed(
        {
          outcome,
          commitSha: meta.commitSha,
          repairAttempts: meta.repairAttempts,
          publicationReceipt: meta.publicationReceipt ?? null,
        },
        persistMeta,
      )
    }
    return { nodeRunId, meta, ...(processUnreaped ? { processUnreaped: true as const } : {}) }
  }

  // 0. RFC-210 — recurse into submodules FIRST.
  //
  // Two things go wrong without this. A submodule with uncommitted content makes
  // the parent's `status --porcelain` non-empty (` M sub`) yet contributes
  // NOTHING to `diff --cached` — so the run ends as `skipped-empty` and the work
  // is silently dropped. And if the agent committed inside the submodule itself,
  // the parent happily pushes a gitlink pointing at a commit that exists only in
  // this worktree, leaving the remote with an unresolvable submodule.
  subrepos = await commitPushSubmodules({
    worktreePath: W,
    branch: params.repoBranch,
    remote,
    idEnv,
    excludePatterns: params.excludePatterns ?? [],
    recordExclusion: (receipt) => {
      exclusionPolicyDigest = receipt.policyDigest
      for (const path of receipt.excludedPaths) excludedPaths.add(path)
      if (receipt.historyBlocked === true) exclusionHistoryBlocked = true
    },
    acquireWrite: params.acquireWrite,
    runGit,
    publicationTransport,
    publicationSubject,
  })
  const failedSub = subrepos.find((r) => r.error !== null)
  if (failedSub !== undefined) {
    // Atomicity (per-repo, matching RFC-066's per-repo commit-push loop): the
    // parent's gitlink bump is withheld so the remote never sees a gitlink whose
    // target was never published.
    return await finalize('commit-local-subrepo-failed', {
      pushError: `submodule '${failedSub.path}': ${failedSub.error ?? 'unknown error'}`,
    })
  }

  // 1+2. Stage everything (respects .gitignore) and capture the change set —
  // under the write lock (RFC-076 C4) so a sibling writer can't mutate the
  // worktree mid-`add` and split its changes across commits. The lock is held
  // ONLY for this capture; `git diff --cached` reads the now-frozen index, and
  // the commit below operates on that same index, so we release before the slow
  // LLM message-gen / push (a writer resuming then lands in its own later
  // commit). No acquirer (single-writer / tests) → unlocked, byte-identical.
  const releaseWrite = params.acquireWrite ? await params.acquireWrite() : null
  let numstat: string
  let stat: string
  let diffRaw: string
  try {
    const prepared = await bindRepositoryCommitParticipant({
      repoPath: W,
      configuredPatterns: params.excludePatterns ?? [],
      runGit,
    }).prepare()
    if (!prepared.ok) {
      return await finalize('commit-local-failed', {
        pushError: redactPushError(prepared.error),
      })
    }
    exclusionPolicyDigest = prepared.receipt.policyDigest
    for (const path of prepared.receipt.excludedPaths) excludedPaths.add(path)
    const numstatResult = await g(['diff', '--cached', '--numstat'])
    if (numstatResult.exitCode !== 0) {
      return await finalize('commit-local-failed', {
        pushError: `git diff --numstat failed: ${redactPushError(numstatResult.stderr)}`,
      })
    }
    numstat = numstatResult.stdout
    const statResult = await g(['diff', '--cached', '--stat'])
    if (statResult.exitCode !== 0) {
      return await finalize('commit-local-failed', {
        pushError: `git diff --stat failed: ${redactPushError(statResult.stderr)}`,
      })
    }
    stat = statResult.stdout
    const diffResult = await g(['diff', '--cached'])
    if (diffResult.exitCode !== 0) {
      return await finalize('commit-local-failed', {
        pushError: `git diff failed: ${redactPushError(diffResult.stderr)}`,
      })
    }
    diffRaw = diffResult.stdout
  } finally {
    releaseWrite?.()
  }
  // Nothing staged → skip (no commit).
  const { filesChanged, insertions, deletions } = parseNumstat(numstat)
  if (filesChanged === 0) {
    // RFC-210: reaching here with committed submodules would mean their gitlink
    // bump produced no parent-level change, which cannot happen — but report the
    // results either way so the UI never loses them.
    return finalize(excludedPaths.size > 0 ? 'skipped-excluded' : 'skipped-empty', {
      filesChanged: 0,
    })
  }
  const diffTruncated = truncateDiff(diffRaw, params.diffMaxBytes)

  // 3. Generate the commit message (LLM), falling back to a template.
  let messageSource: CommitPushMeta['messageSource'] = 'fallback'
  let message = buildFallbackMessage({
    agentName: params.agentName,
    filesChanged,
    insertions,
    deletions,
    taskId: params.taskId,
  })
  try {
    const gen = await params.generateMessage({
      nodeRunId,
      repoName: basenameOf(W),
      branch: params.repoBranch,
      baseRef: params.baseRef,
      stat,
      diffTruncated,
    })
    if (gen.processUnreaped === true) {
      processUnreaped = true
      throw new CommitAgentUnreapedError()
    }
    if (gen.sessionId != null) sessionId = gen.sessionId
    if (gen.message != null && gen.message.trim() !== '') {
      message = gen.message.trim()
      messageSource = 'llm'
    }
  } catch (err) {
    if (err instanceof CommitAgentUnreapedError) {
      return await finalize('commit-local-failed', {
        filesChanged,
        insertions,
        deletions,
        messageSource,
        pushError: err.message,
      })
    }
    log.warn('commit message generation failed; using fallback', {
      nodeRunId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // 4. Commit locally with the task identity.
  const commit = await bindRepositoryCommitParticipant({
    repoPath: W,
    configuredPatterns: params.excludePatterns ?? [],
    runGit,
  }).commitPrepared({
    message,
    verification: 'normal',
    authorName: params.gitUserName,
    authorEmail: params.gitUserEmail,
  })
  if (!commit.ok) {
    // A failed commit is unusual (e.g. unknown identity, hook). Surface it as a
    // failed node but keep the staged changes for the user.
    const error = commit.reason === 'no-changes' ? 'prepared index became empty' : commit.error
    log.warn('git commit failed', { nodeRunId, error })
    return finalize('commit-local-failed', {
      filesChanged,
      insertions,
      deletions,
      messageSource,
      pushError: redactPushError(error),
    })
  }
  const commitSha = commit.commitSha

  // 5. Open one RFC-321 transport session for the WHOLE network transaction.
  // Push, non-FF fetch, retry and post-verify all reuse its fixed endpoint and
  // credential revision; an authentication failure never opens a fallback.
  const remoteResult = await g(['remote', 'get-url', remote])
  if (remoteResult.exitCode !== 0 || remoteResult.stdout.trim() === '') {
    return finalize('commit-local-failed', {
      commitSha,
      filesChanged,
      insertions,
      deletions,
      messageSource,
      pushError: 'cannot resolve push remote URL',
    })
  }
  const opened = await publicationTransport.open({
    subject: publicationSubject,
    remoteUrl: remoteResult.stdout.trim(),
  })
  if (!opened.ok) {
    const authFailure = opened.code.startsWith('code-host-push-credential-')
    return finalize(authFailure ? 'commit-local-auth' : 'commit-local-failed', {
      commitSha,
      filesChanged,
      insertions,
      deletions,
      messageSource,
      pushError: opened.code,
    })
  }
  const session = opened.session
  publicationReceipt = session.receipt
  const sessionRunGit: RunGit = (repoPath, args, options) =>
    session.runNetwork(repoPath, args, options)
  const remoteOverride = ['-c', `remote.${remote}.url=${session.endpointUrl}`]
  let attempts = 0
  try {
    while (true) {
      const tipResult = await g(['rev-parse', '--verify', 'HEAD^{commit}'])
      const tipSha = tipResult.stdout.trim()
      const publisher = bindRepositoryCommitParticipant({
        repoPath: W,
        configuredPatterns: params.excludePatterns ?? [],
        runGit,
      })
      const pushBase = await publisher.resolvePushBase({
        remote,
        branch: params.repoBranch,
        fallbackRef: params.baseRef,
      })
      if (tipResult.exitCode !== 0 || tipSha === '' || pushBase === null) {
        return finalize('commit-local-failed', {
          commitSha,
          filesChanged,
          insertions,
          deletions,
          messageSource,
          repairAttempts: attempts,
          pushError: 'cannot resolve outgoing history range; push refused',
        })
      }
      const publication = await bindRepositoryCommitParticipant({
        repoPath: W,
        configuredPatterns: params.excludePatterns ?? [],
        runGit: sessionRunGit,
      }).publish({
        baseSha: pushBase,
        tipSha,
        mode: {
          kind: 'normal',
          remote,
          branch: params.repoBranch,
          leadingArgs: remoteOverride,
        },
      })
      if (publication.ok) {
        exclusionPolicyDigest = publication.policyDigest
        const verified = await session.runNetwork(W, [
          ...remoteOverride,
          'ls-remote',
          '--heads',
          remote,
          params.repoBranch,
        ])
        const remoteSha = verified.stdout
          .split('\n')
          .find((line) => line.trim() !== '')
          ?.split(/\s+/)[0]
        const remoteContainsTip =
          verified.exitCode === 0 && remoteSha !== undefined && remoteSha !== tipSha
            ? await g(['merge-base', '--is-ancestor', tipSha, remoteSha])
            : null
        if (
          verified.exitCode !== 0 ||
          remoteSha === undefined ||
          (remoteSha !== tipSha && remoteContainsTip?.exitCode !== 0)
        ) {
          const managedFailure =
            verified.exitCode === 0
              ? null
              : classifyRepositoryPushFailure(`${verified.stderr}\n${verified.stdout}`)
          return finalize(managedFailure === null ? 'commit-local-failed' : 'commit-local-auth', {
            commitSha,
            filesChanged,
            insertions,
            deletions,
            messageSource,
            repairAttempts: attempts,
            pushError: managedFailure ?? 'repository-push-remote-changed',
          })
        }
        return finalize('pushed', {
          commitSha,
          filesChanged,
          insertions,
          deletions,
          messageSource,
          repairAttempts: attempts,
        })
      }
      if (publication.reason === 'excluded-history') {
        exclusionPolicyDigest = publication.policyDigest
        exclusionHistoryBlocked = true
        for (const path of publication.excludedPaths) excludedPaths.add(path)
        return finalize('commit-local-excluded-history', {
          commitSha,
          filesChanged,
          insertions,
          deletions,
          messageSource,
          repairAttempts: attempts,
          pushError: `push blocked: outgoing history contains ${publication.excludedPaths.length} excluded path(s)`,
        })
      }
      const stderr = publication.error
      const cls = classifyPushFailure(stderr)
      const managedFailure = classifyRepositoryPushFailure(stderr)
      if (managedFailure !== null || cls === 'auth') {
        log.warn('push rejected (auth); committed locally only', {
          nodeRunId,
          branch: params.repoBranch,
          credentialSource: session.receipt.credentialSource,
        })
        return finalize('commit-local-auth', {
          commitSha,
          filesChanged,
          insertions,
          deletions,
          messageSource,
          repairAttempts: attempts,
          pushError: managedFailure ?? 'repository-push-authentication-failed',
        })
      }
      if (attempts >= params.maxRepairRetries) {
        return finalize('commit-local-failed', {
          commitSha,
          filesChanged,
          insertions,
          deletions,
          messageSource,
          repairAttempts: attempts,
          pushError: redactPushError(stderr),
        })
      }
      attempts += 1

      if (cls === 'non-fast-forward') {
        const fetch = await session.runNetwork(W, [
          ...remoteOverride,
          'fetch',
          remote,
          params.repoBranch,
        ])
        if (fetch.exitCode !== 0) {
          const managedFailure = classifyRepositoryPushFailure(`${fetch.stderr}\n${fetch.stdout}`)
          return finalize(managedFailure === null ? 'commit-local-failed' : 'commit-local-auth', {
            commitSha,
            filesChanged,
            insertions,
            deletions,
            messageSource,
            repairAttempts: attempts,
            pushError: managedFailure ?? redactPushError(fetch.stderr),
          })
        }
        const merge = await gc(['merge', '--no-edit', 'FETCH_HEAD'])
        if (merge.exitCode !== 0) {
          await g(['merge', '--abort'])
          return finalize('commit-local-failed', {
            commitSha,
            filesChanged,
            insertions,
            deletions,
            messageSource,
            repairAttempts: attempts,
            pushError: redactPushError(merge.stderr),
          })
        }
        continue
      }

      try {
        const rep = await params.generateRepair({
          nodeRunId,
          branch: params.repoBranch,
          stat,
          pushStderr: redactPushError(stderr),
          currentMessage: message,
          priorAttempts: attempts - 1,
        })
        if (rep.processUnreaped === true) {
          processUnreaped = true
          throw new CommitAgentUnreapedError()
        }
        if (rep.sessionId != null) sessionId = rep.sessionId
        if (rep.message != null && rep.message.trim() !== '') {
          message = rep.message.trim()
          messageSource = 'llm-repair'
          await gc(['commit', '--amend', '-m', message])
        }
      } catch (err) {
        if (err instanceof CommitAgentUnreapedError) {
          return finalize('commit-local-failed', {
            commitSha,
            filesChanged,
            insertions,
            deletions,
            messageSource,
            repairAttempts: attempts,
            pushError: err.message,
          })
        }
        log.warn('push repair generation failed', {
          nodeRunId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  } finally {
    session.close()
  }
}

function identityEnv(name: string | null, email: string | null): Record<string, string> {
  const n = name?.trim()
  const e = email?.trim()
  // RFC-165: task identity when the launch supplied one, else the fixed
  // platform identity. The framework's auto-commit used to inherit the
  // ambient git config via the path-mode parent repo's local user.* — a
  // URL/scratch worktree's parent is the cache clone, which carries none,
  // so on hosts without a global gitconfig (CI runners, fresh servers)
  // `git commit` refused and every autoCommitPush task degraded to
  // commit-local-failed. Env (not `-c`) because GIT_AUTHOR_*/GIT_COMMITTER_*
  // outrank config-level identity — this also SHIELDS framework commits from
  // whatever identity env the daemon process happened to inherit.
  const an = n && e ? n : AW_INTERNAL_GIT_IDENTITY['GIT_AUTHOR_NAME']!
  const ae = n && e ? e : AW_INTERNAL_GIT_IDENTITY['GIT_AUTHOR_EMAIL']!
  return {
    GIT_AUTHOR_NAME: an,
    GIT_AUTHOR_EMAIL: ae,
    GIT_COMMITTER_NAME: an,
    GIT_COMMITTER_EMAIL: ae,
  }
}

function basenameOf(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] ?? p
}

/**
 * RFC-210 impl-gate A8-fix — the submodule that DIRECTLY contains `path`, or
 * null when the superproject does. The longest listed submodule path that is a
 * proper prefix of `path`: for `vendor/inner` with `vendor` listed that is
 * `vendor`; a first-level submodule at `libs/vendor` (plain directory `libs`)
 * has no containing submodule and stays with the superproject.
 */
function directParentOf(
  path: string,
  subs: { path: string; headSha: string }[],
): { path: string; headSha: string } | null {
  let best: { path: string; headSha: string } | null = null
  for (const s of subs) {
    if (s.path === path) continue
    if (!path.startsWith(s.path + '/')) continue
    if (best === null || s.path.length > best.path.length) best = s
  }
  return best
}

/**
 * RFC-210 — commit & push every submodule of one repo, deepest path first.
 *
 * Ordering matters: committing a nested submodule moves its parent's gitlink, so
 * the child must be settled before the level above stages anything.
 *
 * A submodule checked out by `submodule update` sits on a DETACHED HEAD, so a
 * plain `git push` has no branch to push. Each one is put on the same working
 * branch name the parent uses before committing.
 *
 * Lock discipline mirrors the parent's (RFC-076 C4): local writes happen under
 * the write lock so a sibling writer cannot split changes across commits, while
 * the network push is deliberately OUTSIDE it — holding a per-task lock across N
 * pushes would stall every other writer for the duration.
 *
 * Errors are returned, never thrown: the caller decides (and it withholds the
 * parent, which is the whole point of collecting them).
 */
async function commitPushSubmodules(args: {
  worktreePath: string
  branch: string
  remote: string
  idEnv: Record<string, string>
  excludePatterns: readonly string[]
  recordExclusion?: (receipt: {
    policyDigest: string
    excludedPaths: readonly string[]
    historyBlocked?: true
  }) => void
  acquireWrite?: (() => Promise<() => void>) | undefined
  runGit: RunGit
  publicationTransport: RepositoryPublicationTransport
  publicationSubject: RepositoryPublicationSubject
  log?: Logger
}): Promise<SubrepoPushResult[]> {
  const { worktreePath, branch, remote, idEnv } = args
  if (!detectSubmodules(worktreePath)) return []
  // Effective list: a submodule the task ADDED exists only as an unstaged
  // delta with no index entry, which `git submodule status` cannot see
  // (measured) — plain listing would push the parent with a gitlink whose
  // target repository was never published anywhere.
  const subs = bottomUp(usableSubmodules(await listEffectiveSubmodules(worktreePath)))
  if (subs.length === 0) return []

  const out: SubrepoPushResult[] = []
  for (const s of subs) {
    const dir = join(worktreePath, s.path)
    const sg = (a: string[]) => args.runGit(dir, a)
    const entry: SubrepoPushResult = {
      path: s.path,
      fromSha: s.headSha,
      toSha: s.headSha,
      committed: false,
      pushed: false,
      error: null,
    }

    // Only submodules this task actually changed are ours to touch. Design §5.1②
    // says "对每个有本地新提交或脏内容的子仓"; the predicate was missing, so a
    // clean, untouched submodule still got `checkout -B` + `push`. Two things
    // followed, both bad and both measured:
    //   * a vendored third-party submodule with a read-only remote failed to
    //     push and withheld the ENTIRE parent commit-push — the parent never
    //     even committed locally, inverting RFC-075's "a push that can't be
    //     honored never loses the agent's work".
    //   * every autoCommitPush task wrote a branch ref into every submodule's
    //     remote, including repos we merely vendor.
    // "Changed" = dirty working tree, or HEAD ahead of the gitlink the
    // superproject currently records.
    //
    // Impl-gate A8-fix: the recorded gitlink must be read from the DIRECT
    // parent repository. `rev-parse HEAD:vendor/inner` in the superproject
    // cannot pierce the `vendor` gitlink (measured: exit 128), so a nested
    // submodule the agent pre-committed (clean, but ahead of what its parent
    // records) read as untouched and was skipped — while `vendor` and the
    // superproject went on to publish gitlinks pointing at commits that never
    // reached inner's remote. And a recorded lookup that fails (path absent
    // from the parent's HEAD — a newly added submodule) means the sha is NOT
    // on record anywhere, i.e. it must be pushed, not skipped.
    const parent = directParentOf(s.path, subs)
    const parentDir = parent === null ? worktreePath : join(worktreePath, parent.path)
    const relInParent = parent === null ? s.path : s.path.slice(parent.path.length + 1)
    const parentPolicy = bindRepositoryCommitParticipant({
      repoPath: parentDir,
      configuredPatterns: args.excludePatterns,
    })
    const parentPathPolicy = await parentPolicy.classifyPath({
      path: relInParent,
      directory: true,
    })
    if (parentPathPolicy.excluded) {
      args.recordExclusion?.({
        policyDigest: parentPathPolicy.policyDigest,
        excludedPaths: [s.path],
      })
      continue
    }
    const recorded = await args.runGit(parentDir, ['rev-parse', `HEAD:${relInParent}`])
    const dirty = await sg(['status', '--porcelain', '--untracked-files=all'])
    const isDirty = dirty.exitCode === 0 && dirty.stdout.trim() !== ''
    const movedAhead = recorded.exitCode !== 0 || recorded.stdout.trim() !== s.headSha
    if (!isDirty && !movedAhead) continue

    // --- local writes, under the lock ---
    const release = args.acquireWrite ? await args.acquireWrite() : null
    try {
      if (isDirty) {
        // Detached HEAD is the norm here; give the commit a branch to land on.
        const co = await sg(['checkout', '-B', branch])
        if (co.exitCode !== 0) {
          entry.error = redactPushError(co.stderr)
          out.push(entry)
          break
        }
        const prepared = await bindRepositoryCommitParticipant({
          repoPath: dir,
          configuredPatterns: args.excludePatterns,
        }).prepare()
        if (!prepared.ok) {
          entry.error = redactPushError(prepared.error)
          out.push(entry)
          break
        }
        args.recordExclusion?.({
          policyDigest: prepared.receipt.policyDigest,
          excludedPaths: prepared.receipt.excludedPaths.map((path) => `${s.path}/${path}`),
        })
        const stagedDirty = await sg(['diff', '--cached', '--quiet', '--exit-code'])
        if (stagedDirty.exitCode === 0) continue
        const committed = await bindRepositoryCommitParticipant({
          repoPath: dir,
          configuredPatterns: args.excludePatterns,
        }).commitPrepared({
          message: `aw: submodule changes (${branch})`,
          verification: 'normal',
          authorName: idEnv.GIT_AUTHOR_NAME,
          authorEmail: idEnv.GIT_AUTHOR_EMAIL,
        })
        if (!committed.ok) {
          entry.error =
            committed.reason === 'no-changes'
              ? 'prepared submodule index became empty'
              : redactPushError(committed.error)
          out.push(entry)
          break
        }
        entry.committed = true
      } else {
        // Clean, but `movedAhead` — HEAD is a commit the agent made itself, past
        // the gitlink the superproject records. Nothing to commit, but it still
        // needs a branch and a push. (Reaching here at all now requires that;
        // an untouched submodule was skipped before the lock.)
        const co = await sg(['checkout', '-B', branch])
        if (co.exitCode !== 0) {
          entry.error = redactPushError(co.stderr)
          out.push(entry)
          break
        }
      }
      const head = await sg(['rev-parse', 'HEAD'])
      if (head.exitCode === 0) entry.toSha = head.stdout.trim()
    } finally {
      release?.()
    }

    // --- network push, outside the lock ---
    let historyBase = recorded.exitCode === 0 ? recorded.stdout.trim() : ''
    if (historyBase === '') {
      const parentSha = await sg(['rev-parse', '--verify', `${entry.toSha}^`])
      historyBase = parentSha.exitCode === 0 ? parentSha.stdout.trim() : ''
    }
    if (historyBase === '') {
      entry.error = 'cannot resolve submodule outgoing history range; push refused'
      out.push(entry)
      break
    }
    const remoteResult = await sg(['remote', 'get-url', remote])
    if (remoteResult.exitCode !== 0 || remoteResult.stdout.trim() === '') {
      entry.error = 'cannot resolve submodule push remote URL'
      out.push(entry)
      break
    }
    const opened = await args.publicationTransport.open({
      subject: args.publicationSubject,
      remoteUrl: remoteResult.stdout.trim(),
    })
    if (!opened.ok) {
      entry.error = opened.code
      out.push(entry)
      break
    }
    const session = opened.session
    entry.publicationReceipt = session.receipt
    const sessionRunGit: RunGit = (repoPath, gitArgs, options) =>
      session.runNetwork(repoPath, gitArgs, options)
    const remoteOverride = ['-c', `remote.${remote}.url=${session.endpointUrl}`]
    let publication: Awaited<
      ReturnType<ReturnType<typeof bindRepositoryCommitParticipant>['publish']>
    >
    try {
      publication = await bindRepositoryCommitParticipant({
        repoPath: dir,
        configuredPatterns: args.excludePatterns,
        runGit: sessionRunGit,
      }).publish({
        baseSha: historyBase,
        tipSha: entry.toSha,
        mode: { kind: 'normal', remote, branch, leadingArgs: remoteOverride },
      })
    } finally {
      session.close()
    }
    if (!publication.ok) {
      entry.error =
        publication.reason === 'excluded-history'
          ? `push blocked: outgoing history contains ${publication.excludedPaths.length} excluded path(s)`
          : (classifyRepositoryPushFailure(publication.error) ?? redactPushError(publication.error))
      if (publication.reason === 'excluded-history') {
        args.recordExclusion?.({
          policyDigest: publication.policyDigest,
          excludedPaths: publication.excludedPaths.map((path) => `${s.path}/${path}`),
          historyBlocked: true,
        })
      }
      // NO fetch+merge repair here, deliberately — this used to mirror the
      // parent's non-fast-forward repair, and inside a submodule that is
      // destructive. Measured: superproject pins `vendor` at v1, upstream has
      // moved to v2, the task runs with workingBranch `main`. `checkout -B main`
      // puts the pinned commit on local main, the push is rejected non-FF,
      // `merge FETCH_HEAD` FAST-FORWARDS to the upstream tip, the retry
      // "succeeds", and the parent then commits the moved gitlink under the
      // agent's message. The pin is destroyed and published, with nobody having
      // asked for a submodule bump — exactly the drift `gitSubmoduleRemote` is
      // defaulted off to prevent. A non-FF in a submodule means that branch is
      // not ours; report it and let a human decide.
      args.log?.warn('submodule push failed — withholding parent gitlink', {
        subPath: s.path,
        error: entry.error ?? '',
      })
      out.push(entry)
      break
    }
    entry.pushed = true
    out.push(entry)
  }
  return out
}
