// RFC-304 §invoke — what a self-review is handed to read.
//
// `invokeSubSequence` runs another capability's stages against artifacts the
// parent supplies. Which artifacts, and where the diff's two sides come from,
// is what the invoke declaration now says (`worktreeFrom` / `diffLeftFrom`).
// This turns that declaration into the seed.
//
// ## The snapshot, and why it is not optional
//
// The design states the problem plainly: `ci-fix` makes its change in the
// parent worktree, then self-reviews. `mr-review`'s own rule is that each shard
// builds its tree from the baseline — so if the sub-sequence were seeded with
// the baseline alone, every reviewer would read the code as it was BEFORE the
// fix. The design's phrase for that is 自审了个寂寞: a self-review of nothing.
//
// So the parent tree is frozen into a commit first, and that commit is the
// diff's right-hand side. Three things then hold at once: the review sees this
// round's real change, the shards stay isolated from each other, and running it
// twice gives the same answer.
//
// The freeze is a detached commit — no branch, no push, nothing a person will
// ever see. It exists so the tree cannot move under the reviewers.

import { parseDiffHunks } from '@/modules/code-capability/domain/diffHunks'
import { parseLocalDiffFiles } from '@/modules/code-capability/domain/localDiffFiles'
import type { StageArtifacts } from '@/modules/code-capability/application/stageEngine'
import type { GitPort } from '@/modules/code-capability/ports/gitPort'

/** The shape `prepare-worktree` produces, in both capabilities that invoke. */
interface WorktreeLike {
  path: string
  baselineSha: string
}

export interface InvokeSeedInput {
  invokes: { worktreeFrom: string; diffLeftFrom: string }
  artifacts: StageArtifacts
  git: GitPort
  /** The round, so the snapshot's keep-ref is unique and traceable. */
  roundId: string
}

export type InvokeSeedResult =
  | {
      ok: true
      artifacts: StageArtifacts
      /**
       * The ref keeping the snapshot alive — the caller MUST release it once the
       * sub-sequence is done.
       *
       * Not released here: the commit has to stay reachable while the shards
       * read it. Leaving it behind pins one object per round forever, which is
       * what the round tests assert against ("a keep-alive ref per repaired
       * pipeline" is a leak, not a record).
       *
       * Null when nothing was frozen, i.e. the round changed nothing.
       */
      keepRef: string | null
    }
  | { ok: false; message: string }

function worktreeLike(value: unknown): WorktreeLike | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Partial<WorktreeLike>
  if (typeof candidate.path !== 'string' || candidate.path === '') return null
  if (typeof candidate.baselineSha !== 'string' || candidate.baselineSha === '') return null
  return { path: candidate.path, baselineSha: candidate.baselineSha }
}

/**
 * Freeze the parent tree and build the `diff` / `mrMeta` / `worktree` artifacts
 * the invoked range reads.
 *
 * Returns a refusal rather than throwing: a parent whose worktree artifact is
 * missing has a wiring fault, and the stage reports it by name like every other
 * refusal in this module.
 */
export async function buildInvokeSeed(input: InvokeSeedInput): Promise<InvokeSeedResult> {
  const worktree = worktreeLike(input.artifacts[input.invokes.worktreeFrom])
  if (worktree === null) {
    return {
      ok: false,
      message: `the invoke declares its worktree comes from '${input.invokes.worktreeFrom}', which this round did not produce`,
    }
  }
  const left = worktreeLike(input.artifacts[input.invokes.diffLeftFrom])
  if (left === null) {
    return {
      ok: false,
      message: `the invoke declares its diff's left side comes from '${input.invokes.diffLeftFrom}', which this round did not produce`,
    }
  }

  // The freeze. `commitWorktree` stages everything and commits it under a keep
  // ref, which is exactly "an immutable right-hand side" — the same mechanism
  // the patch path uses to hold a change while a human decides about it.
  const keepRef = `refs/aw/self-review/${input.roundId}`
  const frozen = await input.git.commitWorktree({
    repoPath: worktree.path,
    worktreePath: worktree.path,
    message: `aw: self-review snapshot for round ${input.roundId}`,
    keepRef,
  })

  if (!frozen.ok) {
    // `no-changes` is not a failure: a round that changed nothing has nothing
    // to self-review, and the sub-sequence is handed an empty diff so the
    // parent's next stage sees "no findings" rather than an error.
    if (frozen.reason !== 'no-changes') {
      return { ok: false, message: `the tree could not be frozen for review: ${frozen.error}` }
    }
  }

  // The snapshot commits ON TOP of the tree's current HEAD, which is the
  // baseline this round checked out — so the diff the commit introduces IS
  // baseline→snapshot. No separate range read, and no chance of the two
  // disagreeing about what "this round changed" means.
  const rightSha = frozen.ok ? frozen.commitSha : left.baselineSha
  const diff = frozen.ok
    ? await input.git.readCommitDiff({ repoPath: worktree.path, commitSha: rightSha })
    : ({ ok: true, diff: '' } as const)
  if (!diff.ok) {
    return { ok: false, message: `the change could not be read back for review: ${diff.error}` }
  }

  return {
    ok: true,
    keepRef: frozen.ok ? keepRef : null,
    artifacts: {
      // The names the invoked range requires. They are `mr-review`'s
      // vocabulary, not the parent's — that asymmetry is the whole reason the
      // declaration names the parent's artifacts explicitly.
      worktree: { path: worktree.path, baselineSha: rightSha },
      diff: {
        unifiedDiff: diff.diff,
        hunks: parseDiffHunks(diff.diff),
        omitted: [],
        files: parseLocalDiffFiles(diff.diff),
      },
      // A self-review has no merge request to describe. The title is what the
      // prompt uses for context; `diffRefs` is absent because nothing here is
      // ever placed on a merge request — the sub-sequence stops before publish.
      mrMeta: { title: null },
    },
  }
}
