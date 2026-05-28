// RFC-072 — NodeRunOutputSchema gains an optional, nullable `kind` field so the
// task-detail Outputs tab can tell file-path ports from text. The field is
// `.nullable().optional()` for backward compatibility: pre-RFC-072 API
// responses omit it entirely, and migrated-but-unset DB rows send null.

import { describe, expect, test } from 'bun:test'
import { NodeRunOutputSchema } from '../src/schemas/task'

describe('RFC-072 — NodeRunOutputSchema.kind', () => {
  const base = { nodeRunId: 'r1', port: 'doc', value: 'out/report.md' }

  test('accepts a kind string', () => {
    const parsed = NodeRunOutputSchema.parse({ ...base, kind: 'markdown_file' })
    expect(parsed.kind).toBe('markdown_file')
  })

  test('accepts kind: null', () => {
    const parsed = NodeRunOutputSchema.parse({ ...base, kind: null })
    expect(parsed.kind).toBeNull()
  })

  test('accepts an omitted kind (legacy response)', () => {
    const parsed = NodeRunOutputSchema.parse(base)
    expect(parsed.kind).toBeUndefined()
  })

  test('rejects a non-string, non-null kind', () => {
    expect(() => NodeRunOutputSchema.parse({ ...base, kind: 42 })).toThrow()
  })
})
