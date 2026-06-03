// RFC-079 PR-A — migration 0042 (doc_versions multi-document columns) lock.
//
// WHY THIS FILE EXISTS (regression intent):
//   The whole multi-document review feature hinges on three nullable columns
//   on doc_versions (item_index / selection / item_path) plus a
//   (review_node_run_id, item_index) index. If a future migration edit drops
//   or renames any of them — or the journal entry for 0042 is lost — this goes
//   RED before dispatch/submit code starts writing NULLs into a missing column.
//   Pure ADD COLUMN: this also documents that no table rebuild happened.

import { afterAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb } from '../src/db/client'

const migrationsFolder = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('migration 0042 — RFC-079 doc_versions multi-doc columns', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-mig0042-'))
  const dbPath = join(tmp, 'test.sqlite')
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  test('adds item_index / selection / item_path columns + review-item index', () => {
    openDb({ path: dbPath, migrationsFolder }) // applies through 0042
    const raw = new Database(dbPath)
    try {
      const cols = (raw.query('PRAGMA table_info(doc_versions)').all() as { name: string }[]).map(
        (c) => c.name,
      )
      expect(cols).toContain('item_index')
      expect(cols).toContain('selection')
      expect(cols).toContain('item_path')
      // pre-existing columns survive (no rebuild dropped anything)
      expect(cols).toContain('source_file_path')
      expect(cols).toContain('decision')

      const idxs = (raw.query('PRAGMA index_list(doc_versions)').all() as { name: string }[]).map(
        (i) => i.name,
      )
      expect(idxs).toContain('idx_doc_versions_review_item')
      // the original review-run index is still there
      expect(idxs).toContain('idx_doc_versions_review_run')
    } finally {
      raw.close()
    }
  })
})
