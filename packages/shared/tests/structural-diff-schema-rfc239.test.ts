// RFC-239 T1 — locks the schema-compat contract for the new optional fields
// (`FileStructuralDiff.renamedFrom`, `StructuralDiff.contentDigest`/`emptyHint`):
// persisted structural-diff JSON written BEFORE RFC-239 has none of them and
// must keep parsing byte-identically (the on-disk store under
// `structural-diffs/{taskId}/` is read back after worktree GC — a parse
// failure there silently downgrades history to 410).

import { describe, expect, test } from 'bun:test'
import { fileStructuralDiffSchema, structuralDiffSchema } from '../src/schemas/structuralDiff'

const LEGACY_FILE = {
  filePath: 'src/a.ts',
  lang: 'typescript',
  status: 'ok',
  changes: [],
  edges: [],
  impact: [],
}

const LEGACY_DIFF = {
  scope: 'task',
  taskId: '01TASK',
  fromRef: 'abc123',
  toRef: 'WORKTREE',
  engine: 'baseline',
  status: 'ok',
  files: [LEGACY_FILE],
  dependencyChanges: [],
  impact: [],
  classEdges: [],
  summary: {
    files: 1,
    classes: { added: 0, modified: 0, removed: 0, renamed: 0 },
    methods: { added: 0, modified: 0, removed: 0, renamed: 0 },
    fields: { added: 0, modified: 0, removed: 0, renamed: 0 },
    imports: { added: 0, modified: 0, removed: 0, renamed: 0 },
    dependencies: { added: 0, modified: 0, removed: 0, renamed: 0 },
  },
}

describe('RFC-239 structural diff schema compat', () => {
  test('legacy persisted JSON (no renamedFrom/contentDigest/emptyHint) still parses', () => {
    const file = fileStructuralDiffSchema.parse(LEGACY_FILE)
    expect(file.renamedFrom).toBeUndefined()
    const diff = structuralDiffSchema.parse(LEGACY_DIFF)
    expect(diff.contentDigest).toBeUndefined()
    expect(diff.emptyHint).toBeUndefined()
  })

  test('renamedFrom round-trips at the file level', () => {
    const file = fileStructuralDiffSchema.parse({
      ...LEGACY_FILE,
      filePath: 'src/core/a.ts',
      renamedFrom: 'src/a.ts',
    })
    expect(file.renamedFrom).toBe('src/a.ts')
  })

  test('contentDigest + emptyHint round-trip and emptyHint is a closed enum', () => {
    const diff = structuralDiffSchema.parse({
      ...LEGACY_DIFF,
      contentDigest: 'deadbeefdeadbeef',
      emptyHint: 'scratch-space',
      files: [],
      summary: { ...LEGACY_DIFF.summary, files: 0 },
    })
    expect(diff.contentDigest).toBe('deadbeefdeadbeef')
    expect(diff.emptyHint).toBe('scratch-space')
    expect(() => structuralDiffSchema.parse({ ...LEGACY_DIFF, emptyHint: 'weird-value' })).toThrow()
  })
})
