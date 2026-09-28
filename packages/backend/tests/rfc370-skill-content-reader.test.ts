// RFC-370 H6: replace physical skill reads without moving metadata, version
// selection or token projection out of AW. Both database providers use the
// production catalog composition; existing skill suites retain file behavior.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Skill } from '@agent-workflow/shared'
import { buildActor } from '@/auth/actor'
import { skills } from '@/db/schema'
import type {
  SkillContentReader,
  SkillContentReference,
} from '@/modules/resource-catalog/application/skills/contentReader'
import { decodeSkillToken } from '@/modules/resource-catalog/application/skills/skillToken'
import { composeSkillCatalog } from '@/modules/resource-catalog/composition/skillOperations'
import {
  createManagedSkill,
  listSkillFiles,
  readSkillContent,
  readSkillFile,
} from '@/modules/resource-catalog/infrastructure/legacy/skill'
import { createFileSkillContentReader } from '@/modules/resource-catalog/infrastructure/local/fileSkillContentReader'
import { describeEachProvider } from './helpers/eachProvider'

function barrier() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  return { pending, release }
}

const authority = buildActor({
  user: {
    id: 'skill-content-admin',
    username: 'skill-content-admin',
    displayName: 'Skill content admin',
    role: 'admin',
    status: 'active',
  },
  source: 'session',
})

describeEachProvider('RFC-370 skill content reader', (harness) => {
  let appHome: string
  let skill: Skill
  beforeEach(async () => {
    appHome = mkdtempSync(join(tmpdir(), 'aw-content-reader-'))
    skill = await createManagedSkill(
      harness.db,
      { appHome },
      {
        name: 'reader-skill',
        description: 'initial description',
        bodyMd: 'original local body',
        frontmatterExtra: {},
      },
    )
  })
  afterEach(() => rmSync(appHome, { recursive: true, force: true }))

  test('catalog awaits the selected version and projects metadata after asynchronous content', async () => {
    const entered = barrier()
    const ready = barrier()
    const references: SkillContentReference[] = []
    const content: SkillContentReader = {
      async readMain(reference) {
        references.push(reference)
        entered.release()
        await ready.pending
        return '---\nname: ignored-content-name\ncustom: kept\n---\nremote body'
      },
      async listFiles(reference) {
        references.push(reference)
        return [{ path: 'support.txt', type: 'file', size: 6, modifiedAt: 123 }]
      },
      async readFile(reference, path) {
        references.push(reference)
        expect(path).toBe('support.txt')
        return 'remote'
      },
    }
    const catalog = composeSkillCatalog({
      db: harness.db,
      // Deliberately contains no local content. Reads must use the selected adapter.
      appHome: join(appHome, 'unused-home'),
      content,
      restoreMembership: { unfuseForRestore: async () => [] },
    })
    const pending = catalog.queries.content(authority, { id: skill.id })
    try {
      await Promise.race([
        entered.pending,
        pending.then(() => {
          throw new Error('content completed before adapter read')
        }),
      ])
      await harness.db
        .update(skills)
        .set({
          description: 'updated metadata',
          metaRevision: 1,
          contentVersion: 2,
        })
        .where(eq(skills.id, skill.id))
        .run()
    } finally {
      ready.release()
    }
    const result = await pending
    expect(result).toMatchObject({
      name: skill.name,
      bodyMd: 'remote body',
      description: 'updated metadata',
      frontmatterExtra: { custom: 'kept' },
      contentVersion: 1,
      metaRevision: 1,
    })
    expect(decodeSkillToken(result.token!)).toEqual({
      skillId: skill.id,
      contentVersion: 1,
      metaRevision: 1,
    })
    expect(await catalog.fileQueries.list(authority, { id: skill.id })).toEqual([
      { path: 'support.txt', type: 'file', size: 6, modifiedAt: 123 },
    ])
    expect(
      await catalog.fileQueries.read(authority, { id: skill.id, path: 'support.txt' }),
    ).toEqual({ path: 'support.txt', content: 'remote' })
    expect(references.map(({ id, contentVersion }) => ({ id, contentVersion }))).toEqual([
      { id: skill.id, contentVersion: 1 },
      { id: skill.id, contentVersion: 2 },
      { id: skill.id, contentVersion: 2 },
    ])
  })

  test('reader-only calls need no home, retain content errors and reject missing skills first', async () => {
    let reads = 0
    const failure = new Error('content service unavailable')
    const fail = async () => {
      reads += 1
      throw failure
    }
    const opts = { content: { readMain: fail, listFiles: fail, readFile: fail } }
    await expect(readSkillContent(harness.db, opts, 'missing')).rejects.toMatchObject({
      code: 'skill-not-found',
    })
    expect(reads).toBe(0)
    await expect(readSkillContent(harness.db, opts, skill.id)).rejects.toBe(failure)
    await expect(listSkillFiles(harness.db, opts, skill.id)).rejects.toBe(failure)
    await expect(readSkillFile(harness.db, opts, skill.id, 'support.txt')).rejects.toBe(failure)
    expect(reads).toBe(3)
    const deleted = readSkillContent(
      harness.db,
      {
        content: {
          ...opts.content,
          async readMain() {
            await harness.db.delete(skills).where(eq(skills.id, skill.id)).run()
            return 'body after delete'
          },
        },
      },
      skill.id,
    )
    await expect(deleted).rejects.toMatchObject({ code: 'skill-changed' })
  })

  test('file adapter retains snapshot reads, legacy fallback, tree metadata and missing-file outcomes', async () => {
    const reader = createFileSkillContentReader(appHome)
    const live = join(appHome, 'skills', skill.id, 'files')
    const snapshot = join(appHome, 'skills', skill.id, 'versions', 'v1', 'files')
    writeFileSync(join(live, 'SKILL.md'), 'live body')
    mkdirSync(join(snapshot, 'support'))
    writeFileSync(join(snapshot, 'support', 'note.txt'), 'snapshot note')
    expect(await reader.readMain(skill)).toContain('original local body')
    expect(await reader.readFile(skill, 'support/note.txt')).toBe('snapshot note')
    const tree = await reader.listFiles(skill)
    expect(tree).toContainEqual({ path: 'support', type: 'dir' })
    expect(tree.find((node) => node.path === 'support/note.txt')).toMatchObject({
      type: 'file',
      size: 13,
      modifiedAt: expect.any(Number),
    })
    await expect(readSkillFile(harness.db, { appHome }, skill.id, 'support')).rejects.toMatchObject(
      { code: 'skill-file-is-dir' },
    )
    await expect(readSkillFile(harness.db, { appHome }, skill.id, 'missing')).rejects.toMatchObject(
      { code: 'skill-file-not-found' },
    )
    rmSync(snapshot, { recursive: true })
    expect(await reader.readMain(skill)).toBe('live body')
    rmSync(live, { recursive: true })
    expect(await reader.listFiles(skill)).toEqual([])
    await expect(readSkillContent(harness.db, { appHome }, skill.id)).rejects.toMatchObject({
      code: 'skill-md-missing',
    })
  })
})
