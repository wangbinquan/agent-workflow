// RFC-395 wave 2: A can select the complete local profile, including package
// bytes, through resource-catalog's composition exit.
import { expect, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  createFileSkillContentBinding,
  selectSkillContentDependencies,
} from '@/modules/resource-catalog/composition/skillContentBinding'
import { tablesOf } from '@/platform/persistence/sessionTables'
import {
  skillTreeColumns,
  writeTree,
} from '@/modules/resource-catalog/infrastructure/databaseSkillTrees'
import { describeEachProvider } from './helpers/eachProvider'

describeEachProvider('RFC-395 composition local skill binding', (h) => {
  for (const profile of ['local-file', 'database-bytes'] as const) {
    test(`${profile}: exported binding exposes the package reader and reads the selected snapshot bytes`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'rfc395-fu-skill-'))
      const id = randomUUID()
      const files = [
        { path: 'SKILL.md', bytes: Buffer.from('\ufeff# 技能\n') },
        { path: 'binary.dat', bytes: new Uint8Array([255, 0, 128]) },
        { path: 'empty', bytes: new Uint8Array() },
      ]
      try {
        if (profile === 'local-file') {
          await mkdir(join(root, 'converted/snapshot'), { recursive: true })
          for (const file of files)
            await writeFile(join(root, 'converted/snapshot', file.path), file.bytes)
        }
        await h.session.transaction(async (tx) => {
          const { skills, skillVersions } = tablesOf(tx)
          await tx.insert(skills).values({
            id,
            name: id,
            description: '',
            contentVersion: 1,
            ...skillTreeColumns(id, 'live', profile, 'converted/live'),
            createdAt: 1,
            updatedAt: 1,
          })
          await tx.insert(skillVersions).values({
            id: randomUUID(),
            skillId: id,
            versionIndex: 1,
            source: 'initial',
            ...skillTreeColumns(id, 'version:1', profile, 'converted/snapshot'),
            createdAt: 1,
          })
          if (profile === 'database-bytes') {
            await writeTree(
              tx,
              id,
              'live',
              [{ path: 'SKILL.md', bytes: Buffer.from('different live bytes') }],
              1,
            )
            await writeTree(tx, id, 'version:1', files, 1)
          }
        })
        const binding = createFileSkillContentBinding(h.db, root)
        const selected = selectSkillContentDependencies(binding, '/unused-default-home')
        const reference = { id, name: id, contentVersion: 1 }
        expect(selected.appHome).toBe(root)
        expect(selected.content).toBe(binding.content)
        expect(await binding.content.readMain(reference)).toEqual(files[0]!.bytes)
        expect(await binding.packageContent.readTree(reference)).toEqual(files)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
})
