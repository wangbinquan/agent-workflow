// RFC-304 §6.1 (T23) — `split-diff`, and the property the constitution needs
// from it: the same diff must produce the same shards, always.
//
// This is not a style preference. Each shard becomes its own model call and its
// own disposable worktree, and the round is expected to be reproducible — so if
// sharding depended on the order the host happened to return files in, a re-run
// of an unchanged MR would produce different findings and nobody could tell
// whether the code or the sharding moved. GitLab and GitHub both return files
// in orders that vary, which is why the insertion-order test below exists.
//
// The other rules under test come from design §6.1:
//   - group by directory, because the bug between two files in one package is
//     the one a split would hide;
//   - never cut a file mid-hunk — a finding anchored in the missing half cannot
//     be positioned at all;
//   - bound the shard COUNT, because each shard costs a process and a worktree.

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_SPLIT,
  filePathOf,
  patchLineCount,
  splitDiff,
} from '../src/modules/code-capability/domain/splitDiff'
import type { FileDiff } from '../src/modules/code-capability/domain/mrDiffNormalize'

const lines = (n: number) =>
  ['@@ -1,1 +1,1 @@', ...Array.from({ length: n - 1 }, (_, i) => `+line ${i}`)].join('\n')

const file = (path: string, n = 4): FileDiff => ({
  oldPath: path,
  newPath: path,
  patch: lines(n),
  omission: 'none',
})

const keysOf = (shards: ReturnType<typeof splitDiff>) => shards.map((s) => s.key)
const pathsIn = (shard: ReturnType<typeof splitDiff>[number]) => shard.files.map(filePathOf)

describe('RFC-304 — split-diff is deterministic', () => {
  test('the same diff produces identical shards on a re-run', async () => {
    const files = [file('src/a.ts'), file('src/b.ts'), file('lib/c.ts')]
    expect(splitDiff(files)).toEqual(splitDiff(files))
  })

  test('input ORDER does not change the result', async () => {
    // The one that matters: both hosts return files in orders that vary between
    // calls, so an order-sensitive split would silently reshard an unchanged MR.
    const files = [file('src/a.ts'), file('src/b.ts'), file('lib/c.ts'), file('lib/d.ts')]
    const forward = splitDiff(files)
    const reversed = splitDiff([...files].reverse())
    expect(reversed).toEqual(forward)
  })

  test('files are ordered by path inside a shard', async () => {
    const shards = splitDiff([file('src/z.ts'), file('src/a.ts'), file('src/m.ts')])
    expect(pathsIn(shards[0]!)).toEqual(['src/a.ts', 'src/m.ts', 'src/z.ts'])
  })

  test('shards are ordered by directory', async () => {
    const shards = splitDiff([file('src/a.ts'), file('lib/b.ts'), file('app/c.ts')])
    expect(shards.map((s) => s.directory)).toEqual(['app', 'lib', 'src'])
  })
})

describe('RFC-304 — split-diff groups by directory', () => {
  test('files in one directory stay in one shard', async () => {
    // The review-quality rule: the bug that lives BETWEEN two files in a package
    // is exactly what a split across shards hides.
    const shards = splitDiff([file('src/auth/session.ts'), file('src/auth/token.ts')])
    expect(shards).toHaveLength(1)
    expect(pathsIn(shards[0]!)).toEqual(['src/auth/session.ts', 'src/auth/token.ts'])
  })

  test('different directories get different shards', async () => {
    const shards = splitDiff([file('src/a.ts'), file('docs/b.md')])
    expect(shards).toHaveLength(2)
  })

  test('repository-root files land in their own shard, keyed readably', async () => {
    const shards = splitDiff([file('README.md'), file('src/a.ts')])
    expect(shards[0]?.directory).toBe('')
    expect(shards[0]?.key).toBe('0:.')
  })

  test('a subdirectory is its own group, not merged into its parent', async () => {
    // `src/` and `src/auth/` are different review contexts; merging them would
    // make the cap unpredictable as a tree deepens.
    const shards = splitDiff([file('src/a.ts'), file('src/auth/b.ts')])
    expect(shards.map((s) => s.directory)).toEqual(['src', 'src/auth'])
  })
})

describe('RFC-304 — split-diff respects the line cap', () => {
  test('a directory over the cap splits into several shards', async () => {
    const shards = splitDiff([file('src/a.ts', 60), file('src/b.ts', 60)], {
      maxLinesPerShard: 100,
      maxShards: 12,
    })
    expect(shards).toHaveLength(2)
  })

  test('a file bigger than the cap gets its own shard, uncut', async () => {
    // Cutting mid-hunk yields a diff nothing can anchor against, so the finding
    // would arrive unpositionable rather than merely late.
    const shards = splitDiff([file('src/huge.ts', 500)], { maxLinesPerShard: 100, maxShards: 12 })
    expect(shards).toHaveLength(1)
    expect(shards[0]?.files).toHaveLength(1)
    expect(shards[0]?.lineCount).toBe(500)
  })

  test('an oversize shard says so rather than looking like it fit', async () => {
    const shards = splitDiff([file('src/huge.ts', 500)], { maxLinesPerShard: 100, maxShards: 12 })
    expect(shards[0]?.oversize).toBe(true)
  })

  test('an ordinary shard is not marked oversize', async () => {
    expect(splitDiff([file('src/a.ts', 4)])[0]?.oversize).toBe(false)
  })

  test('two shards from one directory get distinct keys', async () => {
    // A bare directory key would collide, and the second shard's attempt rows
    // would overwrite the first's.
    const shards = splitDiff([file('src/a.ts', 60), file('src/b.ts', 60)], {
      maxLinesPerShard: 100,
      maxShards: 12,
    })
    expect(new Set(keysOf(shards)).size).toBe(2)
  })
})

describe('RFC-304 — split-diff bounds the shard count', () => {
  test('never exceeds maxShards', async () => {
    // Each shard is a process AND a worktree; unbounded splitting fills a disk.
    const files = Array.from({ length: 30 }, (_, i) => file(`dir${i}/a.ts`))
    expect(splitDiff(files, { maxLinesPerShard: 100, maxShards: 5 })).toHaveLength(5)
  })

  test('the overflow is folded in, never dropped', async () => {
    // A dropped file is an unreviewed file that nothing reports — the exact
    // silent-omission failure sharding exists to prevent.
    const files = Array.from({ length: 30 }, (_, i) => file(`dir${i}/a.ts`))
    const shards = splitDiff(files, { maxLinesPerShard: 100, maxShards: 5 })
    const seen = shards.flatMap(pathsIn)
    expect(seen).toHaveLength(30)
    expect(new Set(seen).size).toBe(30)
  })

  test('the shard that absorbed the overflow is marked oversize', async () => {
    const files = Array.from({ length: 30 }, (_, i) => file(`dir${i}/a.ts`))
    const shards = splitDiff(files, { maxLinesPerShard: 100, maxShards: 5 })
    expect(shards.at(-1)?.oversize).toBe(true)
  })
})

describe('RFC-304 — split-diff and files with nothing to review', () => {
  test('an empty diff produces no shards at all', async () => {
    // Not one empty shard: that would spend a model call to review nothing.
    expect(splitDiff([])).toEqual([])
  })

  test('binary and too-large files are not given shards', async () => {
    const omitted: FileDiff[] = [
      { oldPath: 'img.png', newPath: 'img.png', patch: '', omission: 'binary' },
      { oldPath: 'big.bin', newPath: 'big.bin', patch: '', omission: 'too-large' },
    ]
    expect(splitDiff(omitted)).toEqual([])
  })

  test('a diff of only omitted files does not become one empty shard', async () => {
    const files = [
      { oldPath: 'img.png', newPath: 'img.png', patch: '', omission: 'binary' as const },
      file('src/a.ts'),
    ]
    const shards = splitDiff(files)
    expect(shards).toHaveLength(1)
    expect(pathsIn(shards[0]!)).toEqual(['src/a.ts'])
  })

  test('a deleted file is filed under its old path', async () => {
    // It has no new side; filing it under '' would drop every deletion into the
    // repository-root shard, away from the package it belongs to.
    const deleted: FileDiff = {
      oldPath: 'src/gone.ts',
      newPath: null,
      patch: lines(4),
      omission: 'none',
    }
    expect(splitDiff([deleted])[0]?.directory).toBe('src')
  })
})

describe('RFC-304 — patchLineCount', () => {
  test('an empty patch costs nothing', async () => {
    expect(patchLineCount('')).toBe(0)
  })

  test('a trailing newline does not count as another line', async () => {
    expect(patchLineCount('a\nb\n')).toBe(2)
    expect(patchLineCount('a\nb')).toBe(2)
  })

  test('the default cap is a real bound, not Infinity', async () => {
    expect(DEFAULT_SPLIT.maxLinesPerShard).toBeGreaterThan(0)
    expect(Number.isFinite(DEFAULT_SPLIT.maxShards)).toBe(true)
  })
})
