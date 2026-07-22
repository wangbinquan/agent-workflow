// RFC-217 T8 — freeze the drizzle migrator at a journal idx. Era-locked
// migration tests (asserting a table/column shape that a LATER migration
// destroyed, e.g. the clarify legacy tables dropped by 0107) migrate through
// `freezeAt(idx)` instead of MIGRATIONS so history stays asserted without
// keeping dead surface alive at HEAD.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface JournalEntry {
  idx: number
  version: string
  when: number
  tag: string
  breakpoints: boolean
}
interface Journal {
  version: string
  dialect: string
  entries: JournalEntry[]
}

/** Copy migrations 0..idx (inclusive) into a temp folder with a truncated journal. */
export function freezeAt(idx: number): string {
  const full = JSON.parse(
    readFileSync(join(MIGRATIONS, 'meta', '_journal.json'), 'utf-8'),
  ) as Journal
  const dir = mkdtempSync(join(tmpdir(), `aw-mig-freeze-${idx}-`))
  mkdirSync(join(dir, 'meta'), { recursive: true })
  const partial: Journal = { ...full, entries: full.entries.slice(0, idx + 1) }
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify(partial, null, 2), 'utf-8')
  for (const e of partial.entries) {
    copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`))
    const snap = `${String(e.idx).padStart(4, '0')}_snapshot.json`
    if (existsSync(join(MIGRATIONS, 'meta', snap))) {
      copyFileSync(join(MIGRATIONS, 'meta', snap), join(dir, 'meta', snap))
    }
  }
  return dir
}

/** Last journal idx where the clarify legacy tables still exist (0106; 0107 drops them). */
export const LAST_LEGACY_CLARIFY_IDX = 105
