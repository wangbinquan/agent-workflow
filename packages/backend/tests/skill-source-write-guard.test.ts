import { rimrafDir } from './helpers/cleanup'
// Locks RFC-017 §4.4 — source-derived skill writes throw `skill-source-readonly`
// (distinct from hand-imported external's `skill-external-readonly`). The UI
// keys off the more-specific code to render the "edit files in the source
// folder" hint.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { skills } from '../src/db/schema'
import { writeSkillContent, writeSkillFile, type SkillFsOptions } from '../src/services/skill'
import { createSkillSource } from '../src/services/skill-source'
import type { ConflictError } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface H {
  db: DbClient
  fsOpts: SkillFsOptions
  parent: string
  cleanup: () => void
}

function build(): H {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-write-guard-'))
  const parent = mkdtempSync(join(tmpdir(), 'aw-write-guard-parent-'))
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    fsOpts: { appHome },
    parent,
    cleanup: () => {
      rimrafDir(appHome)
      rimrafDir(parent)
    },
  }
}

let h: H
beforeEach(() => {
  h = build()
})
afterEach(() => h.cleanup())

describe('source-derived skill write guard', () => {
  test('writeSkillContent throws skill-source-readonly (not skill-external-readonly)', async () => {
    mkdirSync(join(h.parent, 'auto'), { recursive: true })
    writeFileSync(
      join(h.parent, 'auto', 'SKILL.md'),
      `---\nname: auto\ndescription: pre\n---\nbody\n`,
    )
    await createSkillSource(h.db, { path: h.parent })

    let caught: ConflictError | null = null
    try {
      await writeSkillContent(h.db, h.fsOpts, 'auto', { description: 'patched' })
    } catch (e) {
      caught = e as ConflictError
    }
    expect(caught).not.toBeNull()
    expect(caught!.code).toBe('skill-source-readonly')
  })

  test('hand-imported external skill still throws skill-external-readonly', async () => {
    await h.db.insert(skills).values({
      id: ulid(),
      name: 'manual-ext',
      description: '',
      sourceKind: 'external',
      managedPath: null,
      externalPath: '/tmp/some-where-else',
      sourceId: null,
    })

    let caught: ConflictError | null = null
    try {
      await writeSkillFile(h.db, h.fsOpts, 'manual-ext', 'x.txt', 'hi')
    } catch (e) {
      caught = e as ConflictError
    }
    expect(caught).not.toBeNull()
    expect(caught!.code).toBe('skill-external-readonly')
  })
})
