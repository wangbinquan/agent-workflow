import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'

import { freezeAt } from './migration-freeze'

function migrationStatements(): string[] {
  return readFileSync(
    resolve(
      import.meta.dir,
      '../db/migrations/0222_rfc341_collaboration_committed_event_cutover.sql',
    ),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement !== '')
}

function applyCutover(raw: Database): void {
  raw.exec('BEGIN')
  for (const statement of migrationStatements()) raw.exec(statement)
  raw.exec('COMMIT')
}

describe('migration 0222 — RFC-341 collaboration cutover', () => {
  test('moves review, clarify and questions to one dispatchable epoch', () => {
    const through0221 = freezeAt(220)
    const raw = new Database(':memory:')
    try {
      migrate(drizzle(raw), { migrationsFolder: through0221 })
      applyCutover(raw)
      expect(
        raw
          .query(
            `SELECT family, mode, epoch, change_ref AS changeRef
             FROM committed_event_family_cutovers
             WHERE producer = 'collaboration'
             ORDER BY family`,
          )
          .all(),
      ).toEqual([
        {
          family: 'clarify',
          mode: 'dispatchable',
          epoch: 2,
          changeRef: 'rfc341:collaboration-cutover',
        },
        {
          family: 'questions',
          mode: 'dispatchable',
          epoch: 2,
          changeRef: 'rfc341:collaboration-cutover',
        },
        {
          family: 'review',
          mode: 'dispatchable',
          epoch: 2,
          changeRef: 'rfc341:collaboration-cutover',
        },
      ])
      expect(
        raw
          .query(
            `SELECT mode, epoch FROM committed_event_family_cutovers
             WHERE producer = 'task-execution' AND family = 'task-lifecycle'`,
          )
          .get(),
      ).toEqual({ mode: 'dispatchable', epoch: 2 })
    } finally {
      raw.close()
      rmSync(through0221, { recursive: true, force: true })
    }
  })

  test('fails atomically instead of accepting a partial or stale family cutover', () => {
    const through0221 = freezeAt(220)
    const raw = new Database(':memory:')
    try {
      migrate(drizzle(raw), { migrationsFolder: through0221 })
      raw.exec(`
        UPDATE committed_event_family_cutovers
        SET mode = 'shadow', epoch = 2, change_ref = 'drift'
        WHERE producer = 'collaboration' AND family = 'clarify';
      `)
      expect(() => applyCutover(raw)).toThrow()
      if (raw.inTransaction) raw.exec('ROLLBACK')
      expect(
        raw
          .query(
            `SELECT family, mode, epoch, change_ref AS changeRef
             FROM committed_event_family_cutovers
             WHERE producer = 'collaboration'
             ORDER BY family`,
          )
          .all(),
      ).toEqual([
        { family: 'clarify', mode: 'shadow', epoch: 2, changeRef: 'drift' },
        { family: 'questions', mode: 'legacy', epoch: 1, changeRef: 'rfc341:foundation' },
        { family: 'review', mode: 'legacy', epoch: 1, changeRef: 'rfc341:foundation' },
      ])
    } finally {
      raw.close()
      rmSync(through0221, { recursive: true, force: true })
    }
  })
})
