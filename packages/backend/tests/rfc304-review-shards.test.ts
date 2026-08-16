// RFC-304 §6.1 (T24) — the parallel review segment.
//
// Two properties carry the design, and both are invisible in a happy-path test:
//
//  1. **A tree per shard.** B6 runs the shards in parallel and B8 lets a
//     reviewing agent edit and run tests. On a shared tree those combine into a
//     review whose result depends on what another shard happened to be doing —
//     the determinism the constitution requires, gone, with nothing failing.
//     So: distinct paths, and never the round's own worktree.
//
//  2. **Every tree is removed.** Including when the shard failed, and including
//     when it threw. A leaked worktree is permanent — nothing downstream knows
//     it was created, so it survives until a human notices the disk.
//
// The third is what a failed shard does. It must NOT take the round down
// (seven good shards' findings are worth publishing) and must NOT be silent
// (publishing seven as if they were eight is the "four of seven findings" bug
// wearing a different hat).

import { describe, expect, test } from 'bun:test'
import {
  describeShardFailures,
  runReviewShards,
  type RunReviewShardsInput,
} from '../src/modules/code-capability/application/reviewShards'
import { splitDiff } from '../src/modules/code-capability/domain/splitDiff'
import type { FileDiff } from '../src/modules/code-capability/domain/mrDiffNormalize'
import type { GitPort } from '../src/modules/code-capability/ports/gitPort'
import { createGitPortFake } from './helpers/gitPortFake'

const NONCE = 'shardnonce'
const BASE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

const file = (path: string): FileDiff => ({
  oldPath: path,
  newPath: path,
  patch: '@@ -1,2 +1,3 @@\n one\n+two\n three\n',
  omission: 'none',
})

const envelope = (findings: unknown[]) =>
  `<workflow-output nonce="${NONCE}"><port name="findings">${JSON.stringify({ findings })}</port></workflow-output>`

const finding = (title: string) => ({
  file: 'src/a.ts',
  line: 2,
  severity: 'major',
  title,
  body: 'Something is wrong here.',
})

/** Records every worktree add/remove, so leaks and sharing are both visible. */
function recordingGit(over: { addFails?: boolean } = {}) {
  const added: string[] = []
  const removed: string[] = []
  const live = new Set<string>()
  let maxConcurrent = 0
  const port: GitPort = createGitPortFake(
    { resolvedSha: BASE },
    {
      async addDisposableWorktree({ worktreePath }) {
        if (over.addFails === true) return { ok: false, error: 'no space left on device' }
        added.push(worktreePath)
        live.add(worktreePath)
        maxConcurrent = Math.max(maxConcurrent, live.size)
        return { ok: true }
      },
      async removeDisposableWorktree({ worktreePath }) {
        removed.push(worktreePath)
        live.delete(worktreePath)
        return { ok: true }
      },
    },
  )
  return {
    port,
    added,
    removed,
    live,
    get maxConcurrent() {
      return maxConcurrent
    },
  }
}

function inputFor(
  shards: ReturnType<typeof splitDiff>,
  git: ReturnType<typeof recordingGit>,
  caller: RunReviewShardsInput['makeCaller'],
  over: Partial<RunReviewShardsInput> = {},
): RunReviewShardsInput {
  return {
    shards,
    baselineSha: BASE,
    repoPath: '/repo',
    shardRoot: '/scratch',
    git: git.port,
    makeCaller: caller,
    protocolBlock: '',
    nonce: NONCE,
    budget: { sameSession: 0, freshSession: 0 },
    mrTitle: 'Add retry logic',
    ...over,
  }
}

const twoShards = () => splitDiff([file('src/a.ts'), file('lib/b.ts')])
// A `makeCaller`, NOT a caller: `runReviewShards` calls this WITH the prompt
// and expects a caller back. Passing the caller itself still "works" — the
// shard exhausts instead of succeeding — so a test that only counts worktrees
// would pass while proving nothing about a successful shard. Typing it is what
// catches that; the first draft of this file had exactly that bug.
const alwaysGood: RunReviewShardsInput['makeCaller'] = () => async () => ({
  stdout: envelope([finding('unchecked index')]),
  sessionId: 's',
})

describe('RFC-304 — each shard gets its own tree', () => {
  test('two shards create two DISTINCT worktrees', async () => {
    // Sharing one would let B8's scratch edits leak between shards, and the
    // same input would review differently on a re-run.
    const git = recordingGit()
    await runReviewShards(inputFor(twoShards(), git, alwaysGood))
    expect(git.added).toHaveLength(2)
    expect(new Set(git.added).size).toBe(2)
  })

  test('no shard tree is the round’s own worktree', async () => {
    // The round's tree holds the baseline `fetch-diff` measured against; an
    // agent editing it would move the anchoring baseline mid-round.
    const git = recordingGit()
    await runReviewShards(inputFor(twoShards(), git, alwaysGood, { shardRoot: '/scratch' }))
    expect(git.added.every((p) => p !== '/repo')).toBe(true)
  })

  test('every tree is at the baseline sha', async () => {
    const seen: string[] = []
    const git = recordingGit()
    const spy: GitPort = {
      ...git.port,
      async addDisposableWorktree(input) {
        seen.push(input.sha)
        return git.port.addDisposableWorktree(input)
      },
    }
    await runReviewShards({ ...inputFor(twoShards(), git, alwaysGood), git: spy })
    expect(seen).toEqual([BASE, BASE])
  })
})

describe('RFC-304 — every shard tree is removed', () => {
  test('after a successful shard', async () => {
    const git = recordingGit()
    const result = await runReviewShards(inputFor(twoShards(), git, alwaysGood))
    // Load-bearing: without it this test passes just as well when both shards
    // exhausted, since a failed shard removes its tree too.
    expect(result.degraded).toBe(false)
    expect(result.findings).toHaveLength(2)
    expect(git.live.size).toBe(0)
    expect(git.removed).toHaveLength(2)
  })

  test('after a shard whose reviewer never conformed', async () => {
    // The leak that would otherwise accumulate fastest — a model that will not
    // conform fails on every round of every MR.
    const git = recordingGit()
    await runReviewShards(
      inputFor(twoShards(), git, () => async () => ({ stdout: 'not an envelope', sessionId: 's' })),
    )
    expect(git.live.size).toBe(0)
  })

  test('after a shard that THREW', async () => {
    const git = recordingGit()
    await runReviewShards(
      inputFor(twoShards(), git, () => async () => {
        throw new Error('the runtime died')
      }),
    )
    expect(git.live.size).toBe(0)
  })

  test('a tree that could not be created is not then removed', async () => {
    // Removing a path that was never added would report a spurious git failure
    // on every shard of a round that ran out of disk.
    const git = recordingGit({ addFails: true })
    await runReviewShards(inputFor(twoShards(), git, alwaysGood))
    expect(git.removed).toHaveLength(0)
  })
})

describe('RFC-304 — a shard that could not be reviewed', () => {
  const oneBadOneGood = () => {
    let call = 0
    return () => async () => {
      call += 1
      return call === 1
        ? { stdout: 'not an envelope', sessionId: 's' }
        : { stdout: envelope([finding('leaked fd')]), sessionId: 's' }
    }
  }

  test('does not discard the OTHER shards’ findings', async () => {
    const git = recordingGit()
    const result = await runReviewShards(
      inputFor(twoShards(), git, oneBadOneGood(), { concurrency: 1 }),
    )
    expect(result.findings).toHaveLength(1)
  })

  test('is reported as degraded rather than passing silently', async () => {
    // Publishing one shard's findings as if they were the whole review is the
    // same failure as posting four of seven findings and saying nothing.
    const git = recordingGit()
    const result = await runReviewShards(
      inputFor(twoShards(), git, oneBadOneGood(), { concurrency: 1 }),
    )
    expect(result.degraded).toBe(true)
  })

  test('names itself, so the overview can say which part went unreviewed', async () => {
    const git = recordingGit()
    const result = await runReviewShards(
      inputFor(twoShards(), git, oneBadOneGood(), { concurrency: 1 }),
    )
    const failed = result.outcomes.find((o) => o.status !== 'done')
    expect(failed?.status).toBe('exhausted')
    expect(String(failed?.reason)).toContain('never returned a valid result')
  })

  test('a worktree failure is distinguished from a model failure', async () => {
    // A full disk and a model that will not conform need different responses;
    // collapsing both to "review failed" sends the operator to the wrong place.
    const git = recordingGit({ addFails: true })
    const result = await runReviewShards(inputFor(twoShards(), git, alwaysGood))
    expect(result.outcomes.map((o) => o.status)).toEqual(['worktree-failed', 'worktree-failed'])
    expect(String(result.outcomes[0]?.reason)).toContain('no space left')
  })

  test('contributes NO findings — nothing unvalidated escapes (R5)', async () => {
    const git = recordingGit()
    const result = await runReviewShards(
      inputFor(twoShards(), git, () => async () => ({ stdout: 'garbage', sessionId: 's' })),
    )
    expect(result.findings).toEqual([])
  })
})

describe('RFC-304 — shard results are assembled deterministically', () => {
  test('findings come back in SHARD order, not completion order', async () => {
    // The gate sorts and then truncates at a cap; input assembled in completion
    // order would truncate a different set each run for identical input.
    const git = recordingGit()
    const bySlowFirstShard: RunReviewShardsInput['makeCaller'] = () => {
      return async () => ({ stdout: envelope([finding('x')]), sessionId: 's' })
    }
    const shards = splitDiff([file('src/a.ts'), file('lib/b.ts'), file('app/c.ts')])
    const first = await runReviewShards(inputFor(shards, git, bySlowFirstShard))
    const second = await runReviewShards(inputFor(shards, recordingGit(), bySlowFirstShard))
    expect(first.outcomes.map((o) => o.shardKey)).toEqual(second.outcomes.map((o) => o.shardKey))
  })

  test('an outcome is recorded for every shard, none dropped', async () => {
    const git = recordingGit()
    const shards = splitDiff([file('src/a.ts'), file('lib/b.ts'), file('app/c.ts')])
    const result = await runReviewShards(inputFor(shards, git, alwaysGood))
    expect(result.outcomes).toHaveLength(3)
    expect(result.outcomes.every((o) => o !== undefined)).toBe(true)
  })
})

describe('RFC-304 — concurrency is bounded', () => {
  test('never more trees open at once than the limit', async () => {
    // Each live shard holds a worktree AND a model call; unbounded fan-out on a
    // large MR opens every tree at once.
    const git = recordingGit()
    const shards = splitDiff(Array.from({ length: 6 }, (_, i) => file(`dir${i}/a.ts`)))
    await runReviewShards(
      inputFor(shards, git, () => async () => {
        await new Promise((r) => setTimeout(r, 5))
        return { stdout: envelope([]), sessionId: 's' }
      }),
    )
    expect(git.maxConcurrent).toBeLessThanOrEqual(3)
  })

  test('all shards still run under the limit', async () => {
    const git = recordingGit()
    const shards = splitDiff(Array.from({ length: 6 }, (_, i) => file(`dir${i}/a.ts`)))
    const result = await runReviewShards(inputFor(shards, git, alwaysGood, { concurrency: 2 }))
    expect(result.outcomes).toHaveLength(6)
    expect(git.added).toHaveLength(6)
  })
})

describe('RFC-304 — describeShardFailures', () => {
  test('says nothing when every shard succeeded', async () => {
    expect(describeShardFailures([])).toBeNull()
  })

  test('names the directories that went unreviewed', async () => {
    const text = describeShardFailures([
      {
        shardKey: '0:src',
        directory: 'src',
        status: 'done',
        findings: [],
        reason: null,
        diffClipped: false,
      },
      {
        shardKey: '1:lib',
        directory: 'lib',
        status: 'exhausted',
        findings: [],
        reason: 'nope',
        diffClipped: false,
      },
    ])
    expect(text).toContain('lib')
    expect(text).toContain('incomplete')
  })
})
