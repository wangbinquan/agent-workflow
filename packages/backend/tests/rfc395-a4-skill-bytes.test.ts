// RFC-395 II-a A4: both skill adapters carry exact bytes; their historical BOM text views intentionally differ.
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import { createDatabaseSkillContent } from '@/modules/resource-catalog/infrastructure/databaseSkillContent'
import { createFileSkillContentReader } from '@/modules/resource-catalog/infrastructure/local/fileSkillContentReader'
import { createFileSkillCreationContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillCreationContentStore'
import { createFileSkillVersionContentReader } from '@/modules/resource-catalog/infrastructure/local/fileSkillVersionContentReader'
import { createFileSkillVersionContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillVersionContentStore'
import { createFileSkillLifecycleContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillLifecycleContentStore'
import { skillTextView } from '@/modules/resource-catalog/application/skills/textView'
import { describeEachProvider } from './helpers/eachProvider'

const cases = [
  ['bom', Buffer.from([0xef, 0xbb, 0xbf, 0x61])],
  ['nul', Buffer.from([97, 0, 98])],
  ['invalid-utf8', Buffer.from([0xff, 0xc0, 0xaf])],
  ['empty', Buffer.alloc(0)],
] as const

describeEachProvider('A4 skill bytes', (harness) => {
  for (const [name, bytes] of cases)
    test(`${name}: creation, reads, version writes and snapshots retain bytes in both adapters`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'rfc395-a4-skills-'))
      try {
        const database = createDatabaseSkillContent({ db: harness.db })
        const file = {
          creationContent: createFileSkillCreationContentStore(home),
          content: createFileSkillContentReader(home),
          lifecycleContent: createFileSkillLifecycleContentStore(home),
          versionContent: createFileSkillVersionContentStore(home),
          versionReader: createFileSkillVersionContentReader(home),
        }
        for (const store of [database, file]) {
          const skillId = ulid()
          await store.creationContent.initialize(store.creationContent.plan(skillId), {
            kind: 'files',
            mainContent: bytes,
            files: [{ path: 'data', content: bytes }],
          })
          await store.lifecycleContent.captureInitial(skillId)
          const ref = { id: skillId, name, contentVersion: 1 }
          expect(Buffer.from(await store.content.readMain(ref))).toEqual(bytes)
          expect(Buffer.from(await store.content.readFile(ref, 'data'))).toEqual(bytes)
          expect(
            Buffer.from((await store.versionReader.readSnapshot({ skillId, version: 1 })).main!),
          ).toEqual(bytes)
          expect(
            Buffer.from((await store.versionReader.readTree({ skillId, version: 1 })).get('data')!),
          ).toEqual(bytes)
          const plan = store.versionContent.plan({ skillId, version: 2, publicationId: ulid() })
          const staged = await store.versionContent.stage(
            plan,
            { kind: 'write-file', path: 'written', content: bytes },
            false,
          )
          await store.versionContent.captureVersion(plan)
          await store.versionContent.publish(plan, staged.contentHash)
          expect(
            Buffer.from(await store.content.readFile({ ...ref, contentVersion: 2 }, 'written')),
          ).toEqual(bytes)
          const mainPlan = store.versionContent.plan({ skillId, version: 3, publicationId: ulid() })
          const mainStage = await store.versionContent.stage(
            mainPlan,
            { kind: 'write-main', content: bytes },
            false,
          )
          await store.versionContent.captureVersion(mainPlan)
          await store.versionContent.publish(mainPlan, mainStage.contentHash)
          const actual = await store.content.readMain({ ...ref, contentVersion: 3 })
          expect(Buffer.from(actual)).toEqual(bytes)
          expect(skillTextView(actual, store.content)).toBe(
            store === database ? new TextDecoder().decode(bytes) : bytes.toString('utf8'),
          )
        }
        expect(skillTextView(cases[0][1], database.content)).toBe('a')
        expect(skillTextView(cases[0][1], file.content)).toBe('\ufeffa')
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    })
})
