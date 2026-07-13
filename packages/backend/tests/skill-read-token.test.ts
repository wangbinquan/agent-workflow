// RFC-170 §2/T3 — the skill detail read (readSkillContent) emits an opaque
// composite precondition token that decodes to (skillId, contentVersion,
// metaRevision). The client echoes it on the eventual combined-save (T4) for OCC.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createManagedSkill, getSkill, readSkillContent } from '../src/services/skill'
import { decodeSkillToken, encodeSkillToken } from '../src/services/skillToken'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-170 T3 — read-path composite token', () => {
  let db: DbClient
  let appHome: string
  let fsOpts: { appHome: string }

  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-read-token-'))
    fsOpts = { appHome }
    db = createInMemoryDb(MIGRATIONS)
    await createManagedSkill(db, fsOpts, {
      name: 'foo',
      description: 'd',
      bodyMd: 'body',
      frontmatterExtra: {},
    })
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  test('readSkillContent returns a token decoding to the skill identity', async () => {
    const skill = await getSkill(db, 'foo')
    const content = await readSkillContent(db, fsOpts, 'foo')
    expect(content.token).toBeDefined()
    const decoded = decodeSkillToken(content.token!)
    expect(decoded).not.toBeNull()
    expect(decoded!.skillId).toBe(skill!.id)
    expect(decoded!.contentVersion).toBe(1) // fresh skill → v1
    expect(decoded!.metaRevision).toBe(0) // legacy default
  })

  test('the token is opaque + round-trips exactly (no drift)', async () => {
    const content = await readSkillContent(db, fsOpts, 'foo')
    const skill = await getSkill(db, 'foo')
    const decoded = decodeSkillToken(content.token!)!
    // Re-encoding the decoded parts reproduces the same opaque string.
    expect(encodeSkillToken(decoded)).toBe(content.token!)
    expect(decoded.skillId).toBe(skill!.id)
  })
})
