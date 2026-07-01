// Locks RFC-017 §A3/A4/A5/A6 — reconcileSource three-state outcome:
//   imported (new + same-source unchanged), deleted (vanished children),
//   skipped (conflict / referenced / parse failures).
// Red here = lazy-sync semantics drifted.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, skillSources, skills } from '../src/db/schema'
import { createSkillSource, reconcileSource } from '../src/services/skill-source'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface H {
  db: DbClient
  parent: string
  cleanup: () => void
}

function build(): H {
  const parent = mkdtempSync(join(tmpdir(), 'aw-source-reconcile-'))
  const db = createInMemoryDb(MIGRATIONS)
  return {
    db,
    parent,
    cleanup: () => rmSync(parent, { recursive: true, force: true }),
  }
}

function addSkill(parent: string, name: string, description = ''): void {
  mkdirSync(join(parent, name), { recursive: true })
  writeFileSync(
    join(parent, name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`,
  )
}

async function getSourceRow(db: DbClient, id: string) {
  const r = await db.select().from(skillSources).where(eq(skillSources.id, id)).limit(1)
  return r[0]!
}

let h: H
beforeEach(() => {
  h = build()
})
afterEach(() => h.cleanup())

describe('reconcileSource', () => {
  test('first scan imports every compliant child', async () => {
    addSkill(h.parent, 'foo', 'foo desc')
    addSkill(h.parent, 'bar', 'bar desc')

    const { source, outcome } = await createSkillSource(h.db, { path: h.parent })
    expect(outcome.imported.map((s) => s.name).sort()).toEqual(['bar', 'foo'])
    expect(outcome.deleted).toEqual([])
    expect(outcome.skipped).toEqual([])
    expect(source.childCount).toBe(2)
    const rows = await h.db.select().from(skills).where(eq(skills.sourceId, source.id))
    expect(rows.every((r) => r.sourceKind === 'external')).toBe(true)
    expect(rows.find((r) => r.name === 'foo')!.description).toBe('foo desc')
  })

  test('second scan after adding an external child imports the new one only', async () => {
    addSkill(h.parent, 'foo')
    const { source } = await createSkillSource(h.db, { path: h.parent })
    addSkill(h.parent, 'bar', 'late comer')

    const sourceRow = await getSourceRow(h.db, source.id)
    const outcome = await reconcileSource(h.db, sourceRow)
    expect(outcome.imported.map((s) => s.name)).toEqual(['bar'])
    expect(outcome.deleted).toEqual([])
    expect(outcome.skipped).toEqual([])
  })

  test('second scan after deleting a child removes it from DB', async () => {
    addSkill(h.parent, 'foo')
    addSkill(h.parent, 'bar')
    const { source } = await createSkillSource(h.db, { path: h.parent })
    rmSync(join(h.parent, 'bar'), { recursive: true })

    const sourceRow = await getSourceRow(h.db, source.id)
    const outcome = await reconcileSource(h.db, sourceRow)
    expect(outcome.deleted).toEqual(['bar'])
    const remaining = await h.db.select().from(skills).where(eq(skills.sourceId, source.id))
    expect(remaining.map((r) => r.name)).toEqual(['foo'])
  })

  test('manual external skill of same name → source candidate is skipped (name-conflict-manual)', async () => {
    // Pre-seed a hand-imported external skill 'shared' BEFORE registering the
    // source directory.
    await h.db.insert(skills).values({
      id: ulid(),
      name: 'shared',
      description: 'manual',
      sourceKind: 'external',
      managedPath: null,
      externalPath: '/tmp/somewhere-else',
      sourceId: null,
    })
    addSkill(h.parent, 'shared', 'from folder')
    addSkill(h.parent, 'fresh', 'unique')

    const { source, outcome } = await createSkillSource(h.db, { path: h.parent })
    expect(outcome.imported.map((s) => s.name)).toEqual(['fresh'])
    const conflict = outcome.skipped.find((s) => s.proposedName === 'shared')
    expect(conflict?.reason).toBe('name-conflict-manual')
    // The manual row keeps its original externalPath.
    const sharedRow = (
      await h.db.select().from(skills).where(eq(skills.name, 'shared')).limit(1)
    )[0]!
    expect(sharedRow.externalPath).toBe('/tmp/somewhere-else')
    expect(sharedRow.sourceId).toBeNull()
    void source
  })

  test('second source registered after the first wins same-name → second source candidate is skipped (name-conflict-source)', async () => {
    const otherParent = mkdtempSync(join(tmpdir(), 'aw-other-'))
    try {
      addSkill(h.parent, 'common', 'first')
      addSkill(otherParent, 'common', 'second')
      await createSkillSource(h.db, { path: h.parent })
      const { outcome: second } = await createSkillSource(h.db, { path: otherParent })
      const conflict = second.skipped.find((s) => s.proposedName === 'common')
      expect(conflict?.reason).toBe('name-conflict-source')
      // The first row still wins.
      const commonRow = (
        await h.db.select().from(skills).where(eq(skills.name, 'common')).limit(1)
      )[0]!
      expect(commonRow.description).toBe('first')
    } finally {
      rmSync(otherParent, { recursive: true, force: true })
    }
  })

  test('child still referenced by an agent: lazy delete is skipped + reported still-referenced', async () => {
    addSkill(h.parent, 'pinned')
    const { source } = await createSkillSource(h.db, { path: h.parent })

    // Now an agent grows a reference to the skill, AFTER which the user
    // deletes the underlying folder externally.
    await h.db.insert(agents).values({
      id: ulid(),
      name: 'agent-x',
      description: '',
      outputs: JSON.stringify(['result']),
      syncOutputsOnIterate: true,
      permission: '{}',
      skills: JSON.stringify(['pinned']),
      frontmatterExtra: '{}',
      bodyMd: '',
    })
    rmSync(join(h.parent, 'pinned'), { recursive: true })

    const sourceRow = await getSourceRow(h.db, source.id)
    const outcome = await reconcileSource(h.db, sourceRow)
    expect(outcome.deleted).toEqual([])
    const pinSkip = outcome.skipped.find((s) => s.proposedName === 'pinned')
    expect(pinSkip?.reason).toBe('still-referenced')
    // skill row survives even though dir is gone.
    const stillThere = await h.db.select().from(skills).where(eq(skills.name, 'pinned')).limit(1)
    expect(stillThere).toHaveLength(1)
  })
})
