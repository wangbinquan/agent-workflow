// RFC-075 / RFC-210 / RFC-321 — publish one task workspace's changes: stage
// (respects .gitignore and the RFC-308 exclusion slice), commit with a
// generated message (deterministic fallback), and push inside ONE transport
// session, handling a rejected push (auth → commit-local + warn; non-fast-
// forward → fetch + merge then re-push; everything else → bounded message
// repair). Submodules are committed and published first, deepest first.
//
// RFC-475: the git half of the former `services/commitPushRunner.ts`, moved
// verbatim. Source Control owns every git step; the caller (task-execution)
// owns the commit node run, its effect record and the commit agent sessions,
// and receives the resulting `CommitPushMeta`. git is never asked to
// force-push, and a push that can't be honored never loses the agent's work —
// the local commit always lands first.
import type {
  CommitPushMeta,
  CommitPushOutcome,
  RepositoryPublicationReceipt,
  SubrepoPushResult,
} from '@agent-workflow/shared'
import { AW_INTERNAL_GIT_IDENTITY, bottomUp, usableSubmodules } from '@/util/git'
import {
  classifyPushFailure,
  classifyRepositoryPushFailure,
  redactPushError,
} from '../domain/repositoryPushFailure'
import { buildFallbackMessage, parseNumstat, truncateDiff } from '../domain/stagedChangeSummary'
import type {
  RepositoryCommitCandidateParticipant,
  RepositoryCommitPublicationParticipant,
} from '../public/participants'
import type {
  RepositoryPublicationSubject,
  RepositoryPublicationTransport,
  RepositoryPublishResult,
} from '../public/types'
import type { RepositoryGitWorkspaceScope } from './ports/repositoryGitWorkspace'
import type {
  RepositoryPublicationLogger,
  WorkspaceChangePublicationRequest,
  WorkspaceChangePublicationResult,
  WorkspaceWriteLock,
} from './ports/workspaceChangePublication'
import type { RepositoryGit } from './repositoryCommit'

/** `bindRepositoryCommitParticipant`'s shape: one repository's bound commit + publication surface. */
export type RepositoryCommitBinder = (input: {
  repoPath: string
  configuredPatterns?: readonly string[]
  runGit?: RepositoryGit
  gitWorkspace?: RepositoryGitWorkspaceScope
  runNetworkGit?: RepositoryGit
}) => RepositoryCommitCandidateParticipant & RepositoryCommitPublicationParticipant

/** `bindRepositoryGitSubworkspace`'s shape. */
export type RepositoryGitSubworkspaceBinder = (
  parent: RepositoryGitWorkspaceScope,
  relativePath: string,
) => RepositoryGitWorkspaceScope

export interface WorkspaceChangePublicationDeps {
  readonly workspace: RepositoryGitWorkspaceScope
  readonly transport: RepositoryPublicationTransport
  /**
   * RFC-370: submodule commit policies run on the selected sub-workspace only
   * when the caller selected a workspace factory; otherwise they bind by path.
   */
  readonly bindPoliciesToWorkspace: boolean
  readonly log: RepositoryPublicationLogger
  readonly commits: RepositoryCommitBinder
  readonly subworkspace: RepositoryGitSubworkspaceBinder
}

class CommitAgentUnreapedError extends Error {
  constructor() {
    super('commit agent child could not be reaped; refusing framework git mutation')
    this.name = 'CommitAgentUnreapedError'
  }
}

/**
 * Stage, commit and push one workspace. Never throws for an expected git
 * outcome — every one is reported in the returned `CommitPushMeta`; only truly
 * unexpected errors (e.g. the worktree vanished) propagate.
 */
export async function publishWorkspaceChanges(
  request: WorkspaceChangePublicationRequest,
  deps: WorkspaceChangePublicationDeps,
): Promise<WorkspaceChangePublicationResult> {
  const workspace = deps.workspace
  const runGit: RepositoryGit = (_repoPath, args, options) => workspace.run(args, options)
  const log = deps.log
  const W = workspace.workspaceRef
  const remote = request.remote
  const publicationTransport = deps.transport
  const publicationSubject: RepositoryPublicationSubject = request.subject
  const nodeRunId = request.nodeRunId
  const idEnv = identityEnv(request.authorName, request.authorEmail)
  const g = (args: string[]) => runGit(W, args)
  // Commit-class operations (commit / amend / merge) carry the identity as
  // GIT_AUTHOR_*/GIT_COMMITTER_* env — git gives those precedence over any
  // `-c user.*`, so inherited daemon env (a user shell exporting GIT_AUTHOR_*)
  // can never leak into, or break, framework commits.
  const gc = (args: string[]) => runGit(W, args, { env: idEnv })

  const pushTarget = `${remote}/${request.branch}`
  let processUnreaped = false
  // RFC-210: filled by the submodule stage below and attached by EVERY finalize
  // path — threading it through each call site individually is how the happy
  // path silently lost it the first time.
  let subrepos: SubrepoPushResult[] = []
  const excludedPaths = new Set<string>()
  let exclusionPolicyDigest: string | null = null
  let exclusionHistoryBlocked = false
  let publicationReceipt: RepositoryPublicationReceipt | null = null

  // Assembles the attempt's `CommitPushMeta`; the caller records it (RFC-475:
  // the node-run and effect writes stay with task-execution).
  const finalize = (
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
  ): WorkspaceChangePublicationResult => {
    const meta: CommitPushMeta = {
      repoPath: W,
      repoBranch: request.branch,
      pushTarget,
      baseRef: request.baseRef,
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
    return { meta, ...(processUnreaped ? { processUnreaped: true as const } : {}) }
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
    branch: request.branch,
    remote,
    idEnv,
    excludePatterns: request.excludePatterns,
    recordExclusion: (receipt) => {
      exclusionPolicyDigest = receipt.policyDigest
      for (const path of receipt.excludedPaths) excludedPaths.add(path)
      if (receipt.historyBlocked === true) exclusionHistoryBlocked = true
    },
    writeLock: request.writeLock,
    workspace,
    bindPoliciesToWorkspace: deps.bindPoliciesToWorkspace,
    publicationTransport,
    publicationSubject,
    commits: deps.commits,
    subworkspace: deps.subworkspace,
  })
  const failedSub = subrepos.find((r) => r.error !== null)
  if (failedSub !== undefined) {
    // Atomicity (per-repo, matching RFC-066's per-repo commit-push loop): the
    // parent's gitlink bump is withheld so the remote never sees a gitlink whose
    // target was never published.
    return finalize('commit-local-subrepo-failed', {
      pushError: `submodule '${failedSub.path}': ${failedSub.error ?? 'unknown error'}`,
    })
  }

  // 1+2. Stage everything (respects .gitignore) and capture the change set —
  // under the write lock (RFC-076 C4) so a sibling writer can't mutate the
  // worktree mid-`add` and split its changes across commits. The lock is held
  // ONLY for this capture; `git diff --cached` reads the now-frozen index, and
  // the commit below records that same prepared tree, so we release before the
  // slow LLM message-gen / push (a writer resuming then lands in its own later
  // commit). A sibling node's merge-back in that window resets the live index
  // to HEAD (RFC-130 materialize), which is why the commit restores the tree
  // captured here instead of trusting the index (RFC-370 hosted acceptance,
  // 2026-10-17). No acquirer (single-writer / tests) → unlocked, byte-identical.
  const writeLease = request.writeLock ? await request.writeLock.acquire() : null
  let numstat: string
  let stat: string
  let diffRaw: string
  let preparedTree: string | undefined
  try {
    const prepared = await deps
      .commits({
        repoPath: W,
        gitWorkspace: workspace,
        configuredPatterns: request.excludePatterns,
        runGit,
      })
      .prepare()
    if (!prepared.ok) {
      return finalize('commit-local-failed', {
        pushError: redactPushError(prepared.error),
      })
    }
    exclusionPolicyDigest = prepared.receipt.policyDigest
    for (const path of prepared.receipt.excludedPaths) excludedPaths.add(path)
    preparedTree = prepared.preparedTree
    const numstatResult = await g(['diff', '--cached', '--numstat'])
    if (numstatResult.exitCode !== 0) {
      return finalize('commit-local-failed', {
        pushError: `git diff --numstat failed: ${redactPushError(numstatResult.stderr)}`,
      })
    }
    numstat = numstatResult.stdout
    const statResult = await g(['diff', '--cached', '--stat'])
    if (statResult.exitCode !== 0) {
      return finalize('commit-local-failed', {
        pushError: `git diff --stat failed: ${redactPushError(statResult.stderr)}`,
      })
    }
    stat = statResult.stdout
    const diffResult = await g(['diff', '--cached'])
    if (diffResult.exitCode !== 0) {
      return finalize('commit-local-failed', {
        pushError: `git diff failed: ${redactPushError(diffResult.stderr)}`,
      })
    }
    diffRaw = diffResult.stdout
  } finally {
    writeLease?.release()
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
  const diffTruncated = truncateDiff(diffRaw, request.diffMaxBytes)

  // 3. Generate the commit message (LLM), falling back to a template.
  let messageSource: CommitPushMeta['messageSource'] = 'fallback'
  let message = buildFallbackMessage({
    agentName: request.agentName,
    filesChanged,
    insertions,
    deletions,
    taskId: request.taskId,
  })
  try {
    const gen = await request.author.compose({
      repoName: basenameOf(W),
      branch: request.branch,
      baseRef: request.baseRef,
      stat,
      diffTruncated,
    })
    if (gen.processUnreaped === true) {
      processUnreaped = true
      throw new CommitAgentUnreapedError()
    }
    if (gen.message != null && gen.message.trim() !== '') {
      message = gen.message.trim()
      messageSource = 'llm'
    }
  } catch (err) {
    if (err instanceof CommitAgentUnreapedError) {
      return finalize('commit-local-failed', {
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

  // 4. Commit locally with the task identity. Reacquire the same short write
  // lock used for index capture: message generation deliberately ran unlocked,
  // but the actual Git mutation must not race a sibling writer's Git lifecycle.
  const commit = await (async () => {
    const commitLease = request.writeLock ? await request.writeLock.acquire() : null
    try {
      return await deps
        .commits({
          repoPath: W,
          gitWorkspace: workspace,
          configuredPatterns: request.excludePatterns,
          runGit,
        })
        .commitPrepared({
          message,
          verification: 'normal',
          authorName: request.authorName,
          authorEmail: request.authorEmail,
          ...(preparedTree === undefined ? {} : { preparedTree }),
        })
    } finally {
      commitLease?.release()
    }
  })()
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
  const sessionRunGit: RepositoryGit = (repoPath, args, options) =>
    session.runNetwork(repoPath, args, options)
  const remoteOverride = ['-c', `remote.${remote}.url=${session.endpointUrl}`]
  let attempts = 0
  const collectFinalization = (...args: Parameters<typeof finalize>): Parameters<typeof finalize> =>
    args
  const completedPublication = await (async (): Promise<Parameters<typeof finalize>> => {
    try {
      while (true) {
        const tipResult = await g(['rev-parse', '--verify', 'HEAD^{commit}'])
        const tipSha = tipResult.stdout.trim()
        const publisher = deps.commits({
          repoPath: W,
          gitWorkspace: workspace,
          configuredPatterns: request.excludePatterns,
          runGit,
        })
        const pushBase = await publisher.resolvePushBase({
          remote,
          branch: request.branch,
          fallbackRef: request.baseRef,
        })
        if (tipResult.exitCode !== 0 || tipSha === '' || pushBase === null) {
          return collectFinalization('commit-local-failed', {
            commitSha,
            filesChanged,
            insertions,
            deletions,
            messageSource,
            repairAttempts: attempts,
            pushError: 'cannot resolve outgoing history range; push refused',
          })
        }
        const publication = await deps
          .commits({
            repoPath: W,
            gitWorkspace: workspace,
            configuredPatterns: request.excludePatterns,
            runNetworkGit: sessionRunGit,
          })
          .publish({
            baseSha: pushBase,
            tipSha,
            mode: {
              kind: 'normal',
              remote,
              branch: request.branch,
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
            request.branch,
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
            return collectFinalization(
              managedFailure === null ? 'commit-local-failed' : 'commit-local-auth',
              {
                commitSha,
                filesChanged,
                insertions,
                deletions,
                messageSource,
                repairAttempts: attempts,
                pushError: managedFailure ?? 'repository-push-remote-changed',
              },
            )
          }
          return collectFinalization('pushed', {
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
          return collectFinalization('commit-local-excluded-history', {
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
            branch: request.branch,
            credentialSource: session.receipt.credentialSource,
          })
          return collectFinalization('commit-local-auth', {
            commitSha,
            filesChanged,
            insertions,
            deletions,
            messageSource,
            repairAttempts: attempts,
            pushError: managedFailure ?? 'repository-push-authentication-failed',
          })
        }
        if (attempts >= request.maxRepairRetries) {
          return collectFinalization('commit-local-failed', {
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
            request.branch,
          ])
          if (fetch.exitCode !== 0) {
            const managedFailure = classifyRepositoryPushFailure(`${fetch.stderr}\n${fetch.stdout}`)
            return collectFinalization(
              managedFailure === null ? 'commit-local-failed' : 'commit-local-auth',
              {
                commitSha,
                filesChanged,
                insertions,
                deletions,
                messageSource,
                repairAttempts: attempts,
                pushError: managedFailure ?? redactPushError(fetch.stderr),
              },
            )
          }
          const merge = await gc(['merge', '--no-edit', 'FETCH_HEAD'])
          if (merge.exitCode !== 0) {
            await g(['merge', '--abort'])
            return collectFinalization('commit-local-failed', {
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
          const rep = await request.author.repair({
            branch: request.branch,
            stat,
            pushStderr: redactPushError(stderr),
            currentMessage: message,
            priorAttempts: attempts - 1,
          })
          if (rep.processUnreaped === true) {
            processUnreaped = true
            throw new CommitAgentUnreapedError()
          }
          if (rep.message != null && rep.message.trim() !== '') {
            message = rep.message.trim()
            messageSource = 'llm-repair'
            await gc(['commit', '--amend', '-m', message])
          }
        } catch (err) {
          if (err instanceof CommitAgentUnreapedError) {
            return collectFinalization('commit-local-failed', {
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
      await session.close()
    }
  })()
  return finalize(...completedPublication)
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
  writeLock?: WorkspaceWriteLock | undefined
  workspace: RepositoryGitWorkspaceScope
  bindPoliciesToWorkspace: boolean
  publicationTransport: RepositoryPublicationTransport
  publicationSubject: RepositoryPublicationSubject
  commits: RepositoryCommitBinder
  subworkspace: RepositoryGitSubworkspaceBinder
  log?: RepositoryPublicationLogger
}): Promise<SubrepoPushResult[]> {
  const { branch, remote, idEnv } = args
  if (!(await args.workspace.hasSubmodules())) return []
  // Effective list: a submodule the task ADDED exists only as an unstaged
  // delta with no index entry, which `git submodule status` cannot see
  // (measured) — plain listing would push the parent with a gitlink whose
  // target repository was never published anywhere.
  const subs = bottomUp(usableSubmodules(await args.workspace.effectiveSubmodules()))
  if (subs.length === 0) return []

  const out: SubrepoPushResult[] = []
  for (const s of subs) {
    const workspace = args.subworkspace(args.workspace, s.path)
    const dir = workspace.workspaceRef
    const sg = (a: string[]) => workspace.run(a)
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
    const parentWorkspace =
      parent === null ? args.workspace : args.subworkspace(args.workspace, parent.path)
    const parentDir = parentWorkspace.workspaceRef
    const relInParent = parent === null ? s.path : s.path.slice(parent.path.length + 1)
    const parentPolicy = args.commits({
      repoPath: parentDir,
      ...(args.bindPoliciesToWorkspace ? { gitWorkspace: parentWorkspace } : {}),
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
    const recorded = await parentWorkspace.run(['rev-parse', `HEAD:${relInParent}`])
    const dirty = await sg(['status', '--porcelain', '--untracked-files=all'])
    const isDirty = dirty.exitCode === 0 && dirty.stdout.trim() !== ''
    const movedAhead = recorded.exitCode !== 0 || recorded.stdout.trim() !== s.headSha
    if (!isDirty && !movedAhead) continue

    // --- local writes, under the lock ---
    const lease = args.writeLock ? await args.writeLock.acquire() : null
    try {
      if (isDirty) {
        // Detached HEAD is the norm here; give the commit a branch to land on.
        const co = await sg(['checkout', '-B', branch])
        if (co.exitCode !== 0) {
          entry.error = redactPushError(co.stderr)
          out.push(entry)
          break
        }
        const prepared = await args
          .commits({
            repoPath: dir,
            ...(args.bindPoliciesToWorkspace ? { gitWorkspace: workspace } : {}),
            configuredPatterns: args.excludePatterns,
          })
          .prepare()
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
        const committed = await args
          .commits({
            repoPath: dir,
            ...(args.bindPoliciesToWorkspace ? { gitWorkspace: workspace } : {}),
            configuredPatterns: args.excludePatterns,
          })
          .commitPrepared({
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
      lease?.release()
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
    const sessionRunGit: RepositoryGit = (repoPath, gitArgs, options) =>
      session.runNetwork(repoPath, gitArgs, options)
    const remoteOverride = ['-c', `remote.${remote}.url=${session.endpointUrl}`]
    let publication: RepositoryPublishResult
    try {
      publication = await args
        .commits({
          repoPath: dir,
          ...(args.bindPoliciesToWorkspace
            ? { gitWorkspace: workspace }
            : { runGit: sessionRunGit }),
          configuredPatterns: args.excludePatterns,
          runNetworkGit: sessionRunGit,
        })
        .publish({
          baseSha: historyBase,
          tipSha: entry.toSha,
          mode: { kind: 'normal', remote, branch, leadingArgs: remoteOverride },
        })
    } finally {
      await session.close()
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
