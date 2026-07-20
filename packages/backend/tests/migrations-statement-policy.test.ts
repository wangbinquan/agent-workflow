// Repository-wide migration policy guard.
//
// WHY THIS EXISTS
// ---------------
// `bun:sqlite`'s `prepare(sql).run()` executes ONLY THE FIRST statement of a
// multi-statement string and reports no error for the rest. Drizzle's migrator
// splits a `.sql` file on `--> statement-breakpoint` markers and feeds each
// chunk through that path, so a hand-written migration that packs two
// statements into one chunk silently applies half of itself: the backfill
// UPDATE, the second ALTER, the index creation just never happen. `migrate`
// stays green, `drizzle-kit check` stays green, CI stays green — and the
// migration is already recorded in `__drizzle_migrations`, so it can never be
// replayed. That is exactly the RFC-108 0052/0053 incident.
//
// The defence that existed before this file was per-migration: a handful of
// individual `migration-00NN-*.test.ts` files each re-split their own SQL with
// a hard-coded expectation. The next hand-written migration inherits none of
// it. This guard is mechanical and repository-wide, so every future migration
// is covered on the day it lands without its author knowing the rule exists.
//
// Deliberately relational, never a hard-coded count: adding a migration must
// not require editing this file (see `upgrade-rolling.test.ts` for the one
// place where a count is intentionally frozen).
//
// See design/test-guard-audit-2026-07-21 gap B6-data-2 / 逃逸机制⑧.

import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const MIGRATIONS_DIR = resolve(import.meta.dir, '..', 'db', 'migrations')
const BREAKPOINT = '--> statement-breakpoint'

interface JournalEntry {
  idx: number
  tag: string
  breakpoints?: boolean
}

const journal = JSON.parse(
  readFileSync(resolve(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
) as { entries: JournalEntry[] }

const sqlFiles = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
  .map((entry) => entry.name)
  .sort()

/**
 * Blank out string literals and comments so a `;` inside quoted text or a
 * trailing note is never mistaken for a statement terminator. Positions are
 * preserved (replaced with spaces) to keep offsets meaningful.
 */
function blankLiteralsAndComments(sql: string): string {
  const out: string[] = []
  let i = 0
  while (i < sql.length) {
    const ch = sql[i] as string
    if (ch === "'") {
      let j = i + 1
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2
            continue
          }
          break
        }
        j += 1
      }
      out.push(' '.repeat(Math.min(j, sql.length) - i + 1))
      i = j + 1
      continue
    }
    if (ch === '"' || ch === '`') {
      const close = sql.indexOf(ch, i + 1)
      const end = close < 0 ? sql.length : close
      out.push(' '.repeat(end - i + 1))
      i = end + 1
      continue
    }
    if (sql.startsWith('--', i)) {
      const nl = sql.indexOf('\n', i)
      const end = nl < 0 ? sql.length : nl
      out.push(' '.repeat(end - i))
      i = end
      continue
    }
    if (sql.startsWith('/*', i)) {
      const close = sql.indexOf('*/', i + 2)
      const end = close < 0 ? sql.length : close + 2
      out.push(' '.repeat(end - i))
      i = end
      continue
    }
    out.push(ch)
    i += 1
  }
  return out.join('')
}

/** Statements in one breakpoint-delimited chunk, after literals are blanked. */
function statementCount(chunk: string): number {
  const bare = blankLiteralsAndComments(chunk)
  // A trigger body legitimately carries inner `;` inside BEGIN … END. Collapse
  // it to a single terminator so a future trigger migration is judged on its
  // outer statement, not its body.
  const collapsed = /\bCREATE\s+TRIGGER\b/i.test(bare)
    ? bare.replace(/\bBEGIN\b[\s\S]*?\bEND\b/i, 'BEGIN_END')
    : bare
  return collapsed.split(';').filter((segment) => segment.trim().length > 0).length
}

describe('migration statement policy', () => {
  test('there is at least one migration to police', () => {
    // Fails closed: if the directory ever moves, this file must not degrade
    // into a vacuously green loop over zero files.
    expect(sqlFiles.length).toBeGreaterThan(0)
    expect(journal.entries.length).toBeGreaterThan(0)
  })

  test('every breakpoint-delimited chunk holds at most one statement', () => {
    const offenders: string[] = []
    for (const file of sqlFiles) {
      const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8')
      sql.split(BREAKPOINT).forEach((chunk, index) => {
        const count = statementCount(chunk)
        if (count > 1) {
          offenders.push(
            `${file} chunk #${index} holds ${count} statements — only the first would be applied`,
          )
        }
      })
    }
    expect(offenders).toEqual([])
  })

  test('a statement terminator is always followed by a breakpoint or end-of-file', () => {
    // Catches the same defect from the other direction: `...;\nUPDATE ...` with
    // no marker in between. Independent of the chunk-count check above so a
    // subtle bug in one blanking rule cannot disable both.
    const offenders: string[] = []
    for (const file of sqlFiles) {
      const raw = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8')
      const bare = blankLiteralsAndComments(raw)
      if (/\bCREATE\s+TRIGGER\b/i.test(bare)) continue
      let cursor = bare.indexOf(';')
      while (cursor >= 0) {
        const rest = raw.slice(cursor + 1)
        const nextStatement = bare.slice(cursor + 1).trim().length > 0
        if (nextStatement && !rest.trimStart().startsWith(BREAKPOINT)) {
          offenders.push(
            `${file}: statement terminator at offset ${cursor} is not followed by "${BREAKPOINT}"`,
          )
          break
        }
        cursor = bare.indexOf(';', cursor + 1)
      }
    }
    expect(offenders).toEqual([])
  })

  test('journal entries and .sql files are 1:1 with breakpoints enabled', () => {
    // A journal that lists a tag with no file (bad rebase) or a file with no
    // entry (forgot to commit the journal) corrupts every user's DB on the next
    // `start`. `drizzle-kit check` covers part of this in CI; asserting it here
    // keeps the local gate honest too, and adds the `breakpoints` flag — with
    // it false, drizzle stops splitting and hands the whole file to the
    // single-statement path.
    const tags = journal.entries.map((entry) => entry.tag).sort()
    const names = sqlFiles.map((file) => file.replace(/\.sql$/, '')).sort()
    expect(tags).toEqual(names)

    const withoutBreakpoints = journal.entries
      .filter((entry) => entry.breakpoints !== true)
      .map((entry) => entry.tag)
    expect(withoutBreakpoints).toEqual([])

    const indices = journal.entries.map((entry) => entry.idx)
    expect(indices).toEqual([...indices].sort((a, b) => a - b))
    expect(new Set(indices).size).toBe(indices.length)
  })
})
