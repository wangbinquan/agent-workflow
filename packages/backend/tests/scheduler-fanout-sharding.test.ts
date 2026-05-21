// LOCKS: RFC-055 — scheduler dispatch for agent-multi shardingStrategy.
//
// We don't spin up the full scheduler (heavy: DB + worktree + opencode
// mocking is out of scope for this guard). Instead this file pins down two
// claims that together are the end-to-end contract:
//
//   1. scheduler.ts contains the three-way dispatch on
//      `strategy.kind`, calling splitDiffPerFile / splitDiffPerNFiles /
//      splitDiffPerDirectory. If anyone refactors the dispatch away,
//      this lock fails and the new path must be re-verified.
//
//   2. Given a 10-file / 3-directory synthetic diff, each strategy
//      produces the expected shard count when fed through the same
//      split functions the scheduler invokes. The `undefined` fallback
//      is per-file (10 shards).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { splitDiffPerDirectory, splitDiffPerFile, splitDiffPerNFiles } from '../src/util/diffSplit'
import { type ShardingStrategy } from '@agent-workflow/shared'

function fileHunk(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1 +1 @@`,
    `-old`,
    `+new`,
    ``,
  ].join('\n')
}

// 10 files across 3 top-level directories: src/ (4), docs/ (3), tests/ (3).
const TEN_FILE_THREE_DIR_DIFF = [
  fileHunk('src/a.ts'),
  fileHunk('src/b.ts'),
  fileHunk('src/sub/c.ts'),
  fileHunk('src/sub/d.ts'),
  fileHunk('docs/readme.md'),
  fileHunk('docs/howto.md'),
  fileHunk('docs/changelog.md'),
  fileHunk('tests/x.test.ts'),
  fileHunk('tests/y.test.ts'),
  fileHunk('tests/z.test.ts'),
].join('')

// Mirrors packages/backend/src/services/scheduler.ts strategy dispatch.
function dispatchShards(diff: string, strategy: ShardingStrategy | undefined): number {
  if (strategy === undefined || strategy.kind === 'per-file') {
    return splitDiffPerFile(diff).length
  }
  if (strategy.kind === 'per-n-files') {
    return splitDiffPerNFiles(diff, strategy.n).length
  }
  return splitDiffPerDirectory(diff, strategy.depth ?? 1).length
}

describe('RFC-055 scheduler-fanout sharding dispatch', () => {
  test('per-n-files n=3 on a 10-file diff → ceil(10/3) = 4 shards', () => {
    expect(dispatchShards(TEN_FILE_THREE_DIR_DIFF, { kind: 'per-n-files', n: 3 })).toBe(4)
  })

  test('per-directory depth=1 on a 10-file / 3-dir diff → 3 shards', () => {
    expect(dispatchShards(TEN_FILE_THREE_DIR_DIFF, { kind: 'per-directory', depth: 1 })).toBe(3)
  })

  test('undefined strategy falls back to per-file (10 shards)', () => {
    expect(dispatchShards(TEN_FILE_THREE_DIR_DIFF, undefined)).toBe(10)
  })
})

describe('RFC-055 scheduler.ts dispatch is still wired (source lock)', () => {
  test('scheduler.ts reads node.shardingStrategy and calls all three split fns', () => {
    const src = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'services', 'scheduler.ts'),
      'utf8',
    )
    expect(src).toContain('shardingStrategy')
    expect(src).toContain('splitDiffPerFile')
    expect(src).toContain('splitDiffPerNFiles')
    expect(src).toContain('splitDiffPerDirectory')
    // Sanity: per-n-files / per-directory kinds are referenced in the dispatch.
    expect(src).toContain("'per-n-files'")
    expect(src).toContain("'per-directory'")
  })
})
