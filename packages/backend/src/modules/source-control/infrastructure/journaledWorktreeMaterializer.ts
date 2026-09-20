import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import {
  applySparseSubdir,
  repoSlug,
  runGit,
  withWorktreeRegistryLock,
  type WorktreeCleanupProvenance,
  type WorktreeLifecycleHookEvent,
} from '@/util/git'
import { syncSubmodules } from '@/services/gitSubmodule'
import { resolveSubmoduleParams } from '@/services/gitRepoCache'
import { ConflictError } from '@/util/errors'
import { materializeWorktree } from './workspaceMaterializer'

const provenanceSchema = z
  .object({
    repoPath: z.string(),
    worktreePath: z.string(),
    branch: z.string(),
    branchRef: z.string(),
    branchBefore: z.string().nullable(),
    branchAfter: z.string(),
  })
  .strict()
const resultSchema = z
  .object({
    worktreePath: z.string(),
    branch: z.string(),
    baseCommit: z.string().nullable(),
    earlyError: z.string().nullable(),
    cleanup: provenanceSchema.nullable(),
    submoduleInitOk: z.boolean(),
    submoduleInitError: z.string().nullable(),
    hasSubmodules: z.boolean(),
  })
  .strict()
export const WorktreePreparationEvidenceSchema = z
  .object({
    version: z.literal(1),
    worktrees: z.array(
      z.object({ intent: provenanceSchema, result: resultSchema.optional() }).strict(),
    ),
  })
  .strict()

/** SC-private physical journal, bound to the current Task attempt by composition. */
export function createJournaledWorktreeMaterializer(input: {
  readonly evidenceJson: string | null
  readonly checkpoint: (evidenceJson: string) => Promise<void>
  readonly assertCurrent: () => Promise<void>
}): typeof materializeWorktree {
  const evidence =
    input.evidenceJson === null
      ? {
          version: 1 as const,
          worktrees: [] as z.infer<typeof WorktreePreparationEvidenceSchema>['worktrees'],
        }
      : WorktreePreparationEvidenceSchema.parse(JSON.parse(input.evidenceJson))
  async function save() {
    await input.assertCurrent()
    await input.checkpoint(JSON.stringify(evidence))
    await input.assertCurrent()
  }
  return async (options) => {
    await input.assertCurrent()
    const path =
      options.overrideWorktreePath ??
      join(options.appHome, 'worktrees', repoSlug(options.repoPath), options.taskId)
    const branch = options.branchName ?? options.workingBranch ?? `agent-workflow/${options.taskId}`
    let entry = evidence.worktrees.find((value) => value.intent.worktreePath === path)
    if (
      entry !== undefined &&
      (entry.intent.repoPath !== options.repoPath || entry.intent.branch !== branch)
    )
      throw new ConflictError('repository-preparation-replay-mismatch', 'worktree binding changed')
    let checkpointError: unknown
    const lifecycleHook = async (event: WorktreeLifecycleHookEvent) => {
      if (
        event.preparedCommit !== undefined &&
        (event.stage === 'working-branch-prepared-before-cas' ||
          event.stage === 'before-worktree-add' ||
          event.stage === 'post-add-before-submodules')
      ) {
        const intent: WorktreeCleanupProvenance = {
          repoPath: event.repoPath,
          worktreePath: event.worktreePath,
          branch: event.branch,
          branchRef: event.branchRef,
          branchBefore: event.branchBefore,
          branchAfter: event.preparedCommit,
        }
        if (entry === undefined) {
          entry = { intent }
          evidence.worktrees.push(entry)
        } else if (entry.intent.branchAfter !== intent.branchAfter) {
          throw new ConflictError(
            'repository-preparation-replay-mismatch',
            'prepared branch changed',
          )
        }
        // Never replace the first expected-old operand with the retry's ref.
        try {
          await save()
        } catch (error) {
          checkpointError = error
          throw error
        }
      }
      await options.lifecycleHook?.(event)
    }

    if (entry !== undefined && existsSync(path)) {
      await verifyExistingWorktree(entry.intent)
      await input.assertCurrent()
      if (entry.result !== undefined) return entry.result
      // Worktree add already happened. Finish its remaining checkout/submodules,
      // then return the original provenance; no branch preparation is repeated.
      if (options.sparseSubdir !== undefined && options.sparseSubdir !== '')
        await applySparseSubdir(path, options.sparseSubdir, options.signal)
      const effective = resolveSubmoduleParams(undefined, undefined)
      const sub = await syncSubmodules(path, {
        mode: effective.mode,
        jobs: effective.jobs,
        ...(effective.remote ? { remote: true } : {}),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      const result = {
        worktreePath: path,
        branch,
        baseCommit: options.baseBranch ?? null,
        earlyError: null,
        cleanup: entry.intent,
        submoduleInitOk: sub.ok,
        submoduleInitError: sub.error,
        hasSubmodules: sub.hasGitmodules,
      }
      entry.result = result
      await save()
      return result
    }

    // An interruption after branch publication but before worktree add leaves
    // the intended ref at branchAfter. Attach that exact branch without changing
    // the first cleanup operand. Other ref changes are not ours to incorporate.
    let reusePublishedBranch = false
    if (entry !== undefined) {
      const current = await runGit(options.repoPath, [
        'rev-parse',
        '--verify',
        '--quiet',
        entry.intent.branchRef,
      ])
      const head = current.exitCode === 0 ? current.stdout.trim() : null
      if (head !== entry.intent.branchAfter && head !== entry.intent.branchBefore)
        throw new ConflictError(
          'repository-preparation-replay-mismatch',
          'worktree branch changed after interruption',
        )
      const intent = entry.intent
      await input.assertCurrent()
      await withWorktreeRegistryLock(options.repoPath, async () => {
        if (head !== intent.branchAfter) {
          const publish = await runGit(
            options.repoPath,
            [
              'update-ref',
              intent.branchRef,
              intent.branchAfter,
              intent.branchBefore ?? '0'.repeat(intent.branchAfter.length),
            ],
            { signal: options.signal },
          )
          if (publish.exitCode !== 0)
            throw new ConflictError(
              'repository-preparation-replay-mismatch',
              'prepared branch CAS failed',
            )
        }
        // No directory exists. Clear only this operation's interrupted Git
        // registration, if present; the normal add path verifies any failure.
        await runGit(options.repoPath, ['worktree', 'remove', '--force', path], {
          signal: options.signal,
        })
      })
      reusePublishedBranch = true
    }
    const result = await materializeWorktree({
      ...options,
      lifecycleHook,
      ...(reusePublishedBranch ? { workingBranch: branch, overrideWorktreePath: path } : {}),
    })
    if (checkpointError !== undefined) throw checkpointError
    if (result.earlyError === null && entry !== undefined) {
      const prepared = { ...result, cleanup: entry.intent }
      entry.result = prepared
      await save()
      return prepared
    }
    return result
  }
}

async function verifyExistingWorktree(provenance: WorktreeCleanupProvenance): Promise<void> {
  const [head, branch, top, common, sourceCommon] = await Promise.all([
    runGit(provenance.worktreePath, ['rev-parse', '--verify', 'HEAD']),
    runGit(provenance.worktreePath, ['symbolic-ref', 'HEAD']),
    runGit(provenance.worktreePath, ['rev-parse', '--show-toplevel']),
    runGit(provenance.worktreePath, ['rev-parse', '--git-common-dir']),
    runGit(provenance.repoPath, ['rev-parse', '--git-common-dir']),
  ])
  if (
    [head, branch, top, common, sourceCommon].some((result) => result.exitCode !== 0) ||
    head.stdout.trim() !== provenance.branchAfter ||
    branch.stdout.trim() !== provenance.branchRef
  )
    throw new ConflictError(
      'repository-preparation-replay-mismatch',
      'existing worktree no longer matches the operation',
    )
  if (
    (await realpath(top.stdout.trim())) !== (await realpath(provenance.worktreePath)) ||
    (await realpath(resolve(provenance.worktreePath, common.stdout.trim()))) !==
      (await realpath(resolve(provenance.repoPath, sourceCommon.stdout.trim())))
  )
    throw new ConflictError(
      'repository-preparation-replay-mismatch',
      'existing worktree belongs to another repository',
    )
}
