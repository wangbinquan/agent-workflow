// RFC-304 §invoke — what a self-review is handed, and why the snapshot is the
// whole point.
//
// `invokedStages` was a runner input nothing supplied, so both capabilities
// that self-review — `ci-fix` before pushing, `requirement` before opening a
// merge request — failed at that stage with "whose stage implementations were
// not supplied to the runner". Neither could finish a round.
//
// Wiring the stages was only half of it. The design's warning is about the
// other half: `mr-review` builds every shard's tree from the baseline, so a
// sub-sequence seeded with the parent's baseline would have each reviewer
// reading the code as it was BEFORE this round changed anything — 自审了个寂寞,
// a self-review of nothing. Freezing the parent tree into a commit gives the
// diff a right-hand side that is both the real change and immutable.
//
// These cases pin that: the diff spans baseline→snapshot, the sub-sequence is
// pointed at the snapshot rather than the baseline, and each way the seeding
// can be wrong answers by name instead of silently reviewing the wrong tree.

import { describe, expect, test } from 'bun:test'
import { buildInvokeSeed } from '../src/modules/code-capability/application/invokeSeed'
import { parseLocalDiffFiles } from '../src/modules/code-capability/domain/localDiffFiles'
import type { GitPort } from '../src/modules/code-capability/ports/gitPort'

const SNAPSHOT_DIFF = [
  'diff --git a/src/broken.txt b/src/broken.txt',
  'index 111..222 100644',
  '--- a/src/broken.txt',
  '+++ b/src/broken.txt',
  '@@ -1 +1 @@',
  '-red',
  '+fixed',
].join('\n')

/** A git port that records what it was asked to do. */
function fakeGit(
  over: Partial<{
    commit: Awaited<ReturnType<GitPort['commitWorktree']>>
    diff: Awaited<ReturnType<GitPort['readCommitDiff']>>
  }> = {},
): { git: GitPort; calls: string[] } {
  const calls: string[] = []
  const git = {
    async commitWorktree(input: { keepRef: string }) {
      calls.push(`commit:${input.keepRef}`)
      return over.commit ?? { ok: true as const, commitSha: 'snapshot-sha' }
    },
    async readCommitDiff(input: { commitSha: string }) {
      calls.push(`diff:${input.commitSha}`)
      return over.diff ?? { ok: true as const, diff: SNAPSHOT_DIFF }
    },
  } as unknown as GitPort
  return { git, calls }
}

const INVOKES = { worktreeFrom: 'worktree', diffLeftFrom: 'worktree' }
const ARTIFACTS = { worktree: { path: '/tmp/wt', baselineSha: 'base-sha' } }

describe('RFC-304 — seeding a self-review', () => {
  test('the tree is frozen, and the diff is read from that snapshot', async () => {
    // The load-bearing order: freeze first, then read. Reading the working tree
    // instead would give a right-hand side that can move while the shards run.
    const { git, calls } = fakeGit()
    const seed = await buildInvokeSeed({
      invokes: INVOKES,
      artifacts: ARTIFACTS,
      git,
      roundId: 'r1',
    })

    expect(seed.ok).toBe(true)
    expect(calls).toEqual(['commit:refs/aw/self-review/r1', 'diff:snapshot-sha'])
  })

  test('the sub-sequence is pointed at the SNAPSHOT, not the baseline', async () => {
    // The bug the design warns about, in one assertion: `mr-review` builds each
    // shard tree from the baselineSha it is handed, so handing it the round's
    // own baseline means every reviewer reads the pre-fix code.
    const { git } = fakeGit()
    const seed = await buildInvokeSeed({
      invokes: INVOKES,
      artifacts: ARTIFACTS,
      git,
      roundId: 'r1',
    })
    if (!seed.ok) throw new Error(seed.message)

    expect((seed.artifacts.worktree as { baselineSha: string }).baselineSha).toBe('snapshot-sha')
    expect((seed.artifacts.worktree as { baselineSha: string }).baselineSha).not.toBe('base-sha')
  })

  test('the diff arrives in the shape the review stages read', async () => {
    // `split-diff` reads `files`, the prompt reads `unifiedDiff`, placement
    // reads `hunks`. A seed that filled only one of them would fail a stage
    // deep inside the sub-sequence, where the message is about `mr-review`.
    const { git } = fakeGit()
    const seed = await buildInvokeSeed({
      invokes: INVOKES,
      artifacts: ARTIFACTS,
      git,
      roundId: 'r1',
    })
    if (!seed.ok) throw new Error(seed.message)

    const diff = seed.artifacts.diff as {
      unifiedDiff: string
      hunks: unknown[]
      files: Array<{ newPath: string | null }>
    }
    expect(diff.unifiedDiff).toContain('+fixed')
    expect(diff.hunks.length).toBeGreaterThan(0)
    expect(diff.files.map((f) => f.newPath)).toEqual(['src/broken.txt'])
  })

  test('a round that changed nothing self-reviews an EMPTY diff rather than failing', async () => {
    // `no-changes` is an outcome, not an error: a round whose agent declined has
    // nothing to review, and the parent's next stage should see "no findings"
    // rather than a red round with a git message in it.
    const { git } = fakeGit({ commit: { ok: false, reason: 'no-changes' } })
    const seed = await buildInvokeSeed({
      invokes: INVOKES,
      artifacts: ARTIFACTS,
      git,
      roundId: 'r1',
    })
    if (!seed.ok) throw new Error(seed.message)

    expect((seed.artifacts.diff as { unifiedDiff: string }).unifiedDiff).toBe('')
    expect((seed.artifacts.worktree as { baselineSha: string }).baselineSha).toBe('base-sha')
  })

  test('the snapshot ref is handed back so the caller can release it', async () => {
    // Found by the ci-fix round test, which asserts no refs are left behind: a
    // keep-alive ref per round pins one object per repaired pipeline forever.
    // The seed cannot release it itself — the commit has to stay reachable
    // while the shards read it — so it names it and the runner drops it after.
    const { git } = fakeGit()
    const seed = await buildInvokeSeed({
      invokes: INVOKES,
      artifacts: ARTIFACTS,
      git,
      roundId: 'r1',
    })
    expect(seed.ok === true && seed.keepRef).toBe('refs/aw/self-review/r1')
  })

  test('nothing frozen means nothing to release', async () => {
    const { git } = fakeGit({ commit: { ok: false, reason: 'no-changes' } })
    const seed = await buildInvokeSeed({
      invokes: INVOKES,
      artifacts: ARTIFACTS,
      git,
      roundId: 'r1',
    })
    expect(seed.ok === true && seed.keepRef).toBeNull()
  })

  test('a freeze that genuinely failed refuses, and says so', async () => {
    const { git } = fakeGit({ commit: { ok: false, reason: 'failed', error: 'disk full' } })
    const seed = await buildInvokeSeed({
      invokes: INVOKES,
      artifacts: ARTIFACTS,
      git,
      roundId: 'r1',
    })
    expect(seed.ok).toBe(false)
    expect(seed.ok === false && seed.message).toContain('disk full')
  })

  test('a declaration naming an artifact the round never produced refuses by name', async () => {
    // The wiring fault this replaces: without the check the seed would carry
    // `undefined` and the sub-sequence would fail somewhere inside `mr-review`,
    // with a message about the review rather than about the invoke.
    const { git } = fakeGit()
    const seed = await buildInvokeSeed({
      invokes: { worktreeFrom: 'tree-that-does-not-exist', diffLeftFrom: 'worktree' },
      artifacts: ARTIFACTS,
      git,
      roundId: 'r1',
    })
    expect(seed.ok).toBe(false)
    expect(seed.ok === false && seed.message).toContain('tree-that-does-not-exist')
  })
})

describe('RFC-304 — splitting a local diff by file', () => {
  test('one entry per file, with the paths and the body', async () => {
    const files = parseLocalDiffFiles(SNAPSHOT_DIFF)
    expect(files).toHaveLength(1)
    expect(files[0]?.oldPath).toBe('src/broken.txt')
    expect(files[0]?.newPath).toBe('src/broken.txt')
    // The body starts at the first hunk — the `diff --git` / `index` preamble is
    // noise to the stages and would only make the prompt longer.
    expect(files[0]?.patch.startsWith('@@ ')).toBe(true)
    expect(files[0]?.patch).toContain('+fixed')
  })

  test('an added file has no old side, a deleted file has no new side', async () => {
    // `null` is what the placement logic reads to decide whether a comment can
    // sit on the old side; getting it backwards puts remarks on lines that do
    // not exist.
    const added = parseLocalDiffFiles(
      [
        'diff --git a/src/new.ts b/src/new.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/src/new.ts',
        '@@ -0,0 +1 @@',
        '+export const x = 1',
      ].join('\n'),
    )
    expect(added[0]?.oldPath).toBeNull()
    expect(added[0]?.newPath).toBe('src/new.ts')

    const deleted = parseLocalDiffFiles(
      [
        'diff --git a/src/gone.ts b/src/gone.ts',
        'deleted file mode 100644',
        '--- a/src/gone.ts',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-export const x = 1',
      ].join('\n'),
    )
    expect(deleted[0]?.oldPath).toBe('src/gone.ts')
    expect(deleted[0]?.newPath).toBeNull()
  })

  test('several files are split at their boundaries', async () => {
    const files = parseLocalDiffFiles(
      [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1 +1 @@',
        '-one',
        '+ONE',
        'diff --git a/b.ts b/b.ts',
        '--- a/b.ts',
        '+++ b/b.ts',
        '@@ -1 +1 @@',
        '-two',
        '+TWO',
      ].join('\n'),
    )
    expect(files.map((f) => f.newPath)).toEqual(['a.ts', 'b.ts'])
    expect(files[0]?.patch).not.toContain('TWO')
    expect(files[1]?.patch).not.toContain('ONE')
  })

  test('a binary file is reported as one, not as an empty change', async () => {
    // Empty and binary look the same in the patch body. A reviewer told "this
    // file changed and there is nothing to read" is being told the truth; one
    // told nothing at all is not.
    const files = parseLocalDiffFiles(
      [
        'diff --git a/logo.png b/logo.png',
        'index 111..222 100644',
        'Binary files a/logo.png and b/logo.png differ',
      ].join('\n'),
    )
    expect(files[0]?.newPath).toBe('logo.png')
    expect(files[0]?.omission).toBe('binary')
    expect(files[0]?.patch).toBe('')
  })

  test('an empty diff is no files, not one empty file', async () => {
    expect(parseLocalDiffFiles('')).toEqual([])
    expect(parseLocalDiffFiles('\n\n')).toEqual([])
  })
})
