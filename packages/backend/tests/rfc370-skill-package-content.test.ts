import { afterEach, beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { skills } from '@/db/schema'
import type { SkillContentReference } from '@/modules/resource-catalog/application/skills/contentReader'
import type { SkillPackageContentReader } from '@/modules/resource-catalog/application/skills/packageContentReader'
import { composeResourcePackageProvider } from '@/modules/resource-catalog/composition/resourcePackageProvider'
import { createManagedSkill } from '@/modules/resource-catalog/infrastructure/legacy/skill'
import {
  skillFilesAbs,
  skillVersionAbs,
} from '@/modules/resource-catalog/infrastructure/legacy/skillIdentityPaths'
import { createFileSkillPackageContentReader } from '@/modules/resource-catalog/infrastructure/local/fileSkillPackageContentReader'
import { describeEachProvider } from './helpers/eachProvider'

function barrier() {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  return { pending, release }
}
const main = new TextEncoder().encode('---\nname: archived\nlicense: MIT\n---\n\nbyte tree\n')

describeEachProvider('RFC-370 skill package content', (harness) => {
  let directory: string, absentHome: string, skillId: string
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'aw-package-content-'))
    absentHome = join(directory, 'absent-home')
    skillId = (
      await createManagedSkill(
        harness.db,
        { appHome: directory },
        {
          name: 'package-content',
          description: '',
          bodyMd: 'initial',
          frontmatterExtra: {},
        },
      )
    ).id
  })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  test('selected byte tree waits, preserves binary files and uses the metadata version selected before reading', async () => {
    const reading = barrier(),
      releaseRead = barrier(),
      references: SkillContentReference[] = []
    const binary = new Uint8Array([0, 255, 128, 10])
    const content: SkillPackageContentReader = {
      readTree: async (reference) => {
        references.push(reference)
        reading.release()
        await releaseRead.pending
        return [
          { path: 'z.txt', bytes: new Uint8Array([90]) },
          { path: 'SKILL.md', bytes: main },
          { path: 'a.bin', bytes: binary },
        ]
      },
    }
    const provider = composeResourcePackageProvider({
      db: harness.db,
      appHome: absentHome,
      skillPackageContent: content,
    })
    const pending = provider.readSkillTree(skillId)
    try {
      await Promise.race([
        reading.pending,
        pending.then(() => {
          throw new Error('content read not reached')
        }),
      ])
      expect(references).toEqual([{ id: skillId, name: 'package-content', contentVersion: 1 }])
      await harness.db
        .update(skills)
        .set({ name: 'renamed-package', contentVersion: 2 })
        .where(eq(skills.id, skillId))
      releaseRead.release()
      const tree = await pending
      expect(tree.frontmatterExtra).toEqual({ license: 'MIT' })
      expect(tree.bodyMd).toBe('byte tree')
      expect(tree.files.map((file) => file.path)).toEqual(['a.bin', 'z.txt'])
      expect(tree.files[0]!.bytes).toEqual(binary)
      expect(tree.files[0]!.bytes).not.toBe(binary)
      await provider.readSkillTree(skillId)
      expect(references[1]).toEqual({ id: skillId, name: 'renamed-package', contentVersion: 2 })
      expect(existsSync(absentHome)).toBe(false)
    } finally {
      releaseRead.release()
      await pending.catch(() => {})
    }
  })

  test('missing or reserving skill is rejected before invoking the byte reader', async () => {
    let calls = 0
    const provider = composeResourcePackageProvider({
      db: harness.db,
      appHome: absentHome,
      skillPackageContent: {
        readTree: async () => {
          calls++
          return []
        },
      },
    })
    await expect(provider.readSkillTree('missing-skill')).rejects.toMatchObject({
      code: 'package-invalid',
    })
    await harness.db
      .update(skills)
      .set({ reservationState: 'reserving' })
      .where(eq(skills.id, skillId))
    await expect(provider.readSkillTree(skillId)).rejects.toMatchObject({ code: 'package-invalid' })
    expect(calls).toBe(0)
  })

  test('storage rejection propagates without falling back to local contents', async () => {
    const error = new Error('object unavailable')
    const provider = composeResourcePackageProvider({
      db: harness.db,
      appHome: directory,
      skillPackageContent: {
        readTree: async () => {
          throw error
        },
      },
    })
    await expect(provider.readSkillTree(skillId)).rejects.toBe(error)
  })

  test('the file adapter retains snapshot preference and byte-for-byte binary content', async () => {
    const binary = new Uint8Array([0, 255, 128, 10])
    writeFileSync(join(skillVersionAbs(directory, skillId, 1), 'SKILL.md'), main)
    writeFileSync(join(skillVersionAbs(directory, skillId, 1), 'archive.bin'), binary)
    writeFileSync(join(skillFilesAbs(directory, skillId), 'SKILL.md'), 'live differs')
    const content = createFileSkillPackageContentReader(directory)
    const provider = composeResourcePackageProvider({
      db: harness.db,
      appHome: absentHome,
      skillPackageContent: {
        readTree: async (reference) => await content.readTree(reference),
      },
    })
    const tree = await provider.readSkillTree(skillId)
    expect(tree.bodyMd).toBe('byte tree')
    expect(tree.frontmatterExtra).toEqual({ license: 'MIT' })
    expect(tree.files).toEqual([{ path: 'archive.bin', bytes: binary }])
    expect(existsSync(absentHome)).toBe(false)
  })
})
