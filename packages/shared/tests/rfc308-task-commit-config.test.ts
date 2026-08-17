import { describe, expect, test } from 'bun:test'
import {
  ConfigPatchSchema,
  ConfigSchema,
  DEFAULT_CONFIG,
  TaskCommitExcludePatternsSchema,
} from '../src'

describe('RFC-308 task commit exclude config', () => {
  test('old config backfills an empty list and patch null resets the key', () => {
    const { taskCommitExcludePatterns: _removed, ...old } = DEFAULT_CONFIG
    expect(ConfigSchema.parse(old).taskCommitExcludePatterns).toEqual([])
    expect(ConfigPatchSchema.parse({ taskCommitExcludePatterns: null })).toEqual({
      taskCommitExcludePatterns: null,
    })
  })

  test('preserves Gitignore order, comments, spaces, escapes, and negation', () => {
    const patterns = ['# note', '/cache/', 'name with spaces', '\\#literal', '!keep.txt']
    expect(TaskCommitExcludePatternsSchema.parse(patterns)).toEqual(patterns)
  })

  test.each([
    ['NUL', ['bad\0path']],
    ['newline', ['bad\npath']],
    ['drive absolute', ['C:\\temp\\x']],
    ['UNC absolute', ['\\\\server\\share']],
    ['traversal', ['../secret']],
  ])('rejects %s', (_label, patterns) => {
    expect(TaskCommitExcludePatternsSchema.safeParse(patterns).success).toBe(false)
  })

  test('enforces entry and UTF-8 byte bounds', () => {
    expect(
      TaskCommitExcludePatternsSchema.safeParse(Array.from({ length: 257 }, () => 'x')).success,
    ).toBe(false)
    expect(TaskCommitExcludePatternsSchema.safeParse(['界'.repeat(342)]).success).toBe(false)
  })
})
