import { createSkillCatalogBootAdapter } from '@/modules/resource-catalog/infrastructure/skillCatalogBootAdapter'
// RFC-395 U-4: epoch-1 identity/backfill proofs run at B's frozen converter boundary.
import { expect, test, describe, beforeEach, afterEach } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  cpSync,
  lstatSync,
  readdirSync,
  renameSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  createSkillBootConversion,
  type SkillBootContentConverter,
} from '@/modules/resource-catalog/infrastructure/migration/skillBootRules'
import {
  skillBootEnvironment,
  SkillBootFactSchema,
} from '@/modules/resource-catalog/infrastructure/migration/skillBootFacts'
import { convertFrozenSkillContent } from '@/platform/content/migration/skillContent'
import { conversion as contentConversion } from '@/platform/content/migration'
import { createBootUpgradeFacts } from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { describeV2Providers, emptyV2Content } from './helpers/rfc395V2Harness'
import { frozenValues } from './helpers/rfc395V2/contentFixtures'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import type { BootUpgradeCaptureInput } from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'
import {
  digestSortedTree,
  hashDir,
} from '@/modules/resource-catalog/infrastructure/legacy/skillHash'

const modes: readonly string[] = [
  'initial',
  'existing',
  'same-name-id',
  'root-conflict',
  'missing-root',
  'support-only',
  'husk',
  'husk-reference',
  'reserving',
  'symlink-root',
  'symlink-skills-root',
  'converter-waits',
  'converter-failure',
  'missing-snapshot',
  'hash-conflict',
  'authority-conflict',
  'orphan-version',
  'restart',
  'drift',
]
// Assigning the real implementation to B's type locks the published structural contract.
const convert: SkillBootContentConverter = convertFrozenSkillContent

describeV2Providers('RFC-395 former identity barrier: frozen identity and restart', (h) => {
  test.each(modes)(
    '%s keeps source evidence and produces only proved target identities',
    async (mode) => {
      await h.install()
      const root = mkdtempSync(join(tmpdir(), 'aw-x2-skill-'))
      const id = mode === 'same-name-id' ? 'legacy' : 'skill'
      const reference =
        mode === 'absolute-restore' ? '/old-home/skills/legacy/files' : 'skills/legacy/files'
      const files = [
        {
          path: 'SKILL.md',
          bytes: Buffer.from('\ufeff---\nname: legacy\ndescription: d\n---\nlegacy body\r\n'),
        },
        { path: 'empty.bin', bytes: Buffer.alloc(0) },
        { path: 'raw.bin', bytes: Buffer.from([255, 0, 192, 128]) },
      ]
      const missing = ['husk', 'husk-reference', 'missing-root', 'reserving'].includes(mode)
      const database = mode.startsWith('database')
      const existing =
        mode === 'existing' ||
        mode === 'missing-snapshot' ||
        mode === 'hash-conflict' ||
        mode === 'authority-conflict' ||
        mode === 'database-existing'
      const treeHash = digestSortedTree(
        files.map((file) => file.path).sort(),
        (path) => files.find((file) => file.path === path)!.bytes,
      )
      const writeTree = (tree: string, supportOnly = false) => {
        const dir = join(root, 'skills', 'legacy', tree)
        mkdirSync(dir, { recursive: true })
        for (const file of files)
          if (!supportOnly || file.path !== 'SKILL.md')
            writeFileSync(join(dir, file.path), file.bytes)
      }
      try {
        if (!database && !missing) writeTree('files', mode === 'support-only')
        if (mode === 'root-conflict') {
          mkdirSync(join(root, 'skills', id, 'files'), { recursive: true })
          writeFileSync(join(root, 'skills', id, 'files', 'SKILL.md'), 'different')
        }
        if (mode === 'symlink-root') {
          rmSync(join(root, 'skills', 'legacy'), { recursive: true })
          mkdirSync(join(root, 'evidence'), { recursive: true })
          symlinkSync(join(root, 'evidence'), join(root, 'skills', 'legacy'), 'dir')
        }
        if (mode === 'symlink-skills-root') {
          renameSync(join(root, 'skills'), join(root, 'evidence'))
          symlinkSync(join(root, 'evidence'), join(root, 'skills'), 'dir')
        }
        if (existing && mode !== 'missing-snapshot' && !database) writeTree('versions/v1/files')
        await h.write('skills', [
          frozenValues('skills', {
            id,
            name: 'legacy',
            managed_path: database ? 'database:skill_content_entries' : reference,
            reservation_state: mode === 'reserving' ? 'reserving' : 'ready',
            version_state:
              existing || mode === 'missing-root'
                ? 'snapshot-authoritative'
                : 'legacy-unbackfilled',
            content_version: mode === 'authority-conflict' ? 2 : existing ? 1 : 0,
          }),
        ])
        if (existing)
          await h.write('skill_versions', [
            frozenValues('skill_versions', {
              id: 'v1',
              skill_id: id,
              version_index: 1,
              source: 'initial',
              content_hash: mode === 'hash-conflict' ? '0'.repeat(64) : treeHash,
              files_path: database
                ? 'database:skill_content_entries'
                : 'skills/legacy/versions/v1/files',
            }),
          ])
        if (database)
          for (const tree of existing ? ['live', 'version:1'] : ['live'])
            await h.write(
              'skill_content_entries',
              files.map((file) =>
                frozenValues('skill_content_entries', {
                  skill_id: id,
                  tree,
                  path: file.path,
                  encoding: 'base64',
                  content: file.bytes.toString('base64'),
                  size: file.bytes.length,
                }),
              ),
            )
        if (mode === 'husk-reference')
          await h.write('memories', [
            frozenValues('memories', {
              id: 'memory',
              status: 'fused',
              fused_into_skill: 'legacy',
              fused_into_skill_id: id,
            }),
          ])
        if (mode.startsWith('active-')) {
          const phase = mode.slice(7)
          await h.write('skill_operations', [
            frozenValues('skill_operations', {
              op_id: 'unsettled',
              skill_id: id,
              kind: 'migrate',
              phase,
              active: 1,
              precondition_json: JSON.stringify({ originalReference: reference }),
            }),
          ])
        }
        if (mode === 'orphan-version')
          await h.write('skill_versions', [
            frozenValues('skill_versions', {
              id: 'orphan',
              skill_id: id,
              version_index: 1,
              files_path: 'skills/missing/versions/v1/files',
            }),
          ])
        let entered!: () => void,
          release!: () => void,
          conversionCalls = 0
        const enteredContent = new Promise<void>((resolve) => {
          entered = resolve
        })
        const contentReady = new Promise<void>((resolve) => {
          release = resolve
        })
        const baseInput = await h.input([
          createSkillBootConversion(async (value, ctx) => {
            conversionCalls++
            if (mode === 'converter-waits') {
              entered()
              await contentReady
            }
            if (mode === 'converter-failure' && value.tree === 'version:1')
              throw new Error('v2-test-initial-capture-unavailable')
            return await convert(value, ctx)
          }),
        ])
        // Keep the physical source FK intact; inject the orphan at the frozen reader boundary.
        const input =
          mode !== 'orphan-version'
            ? baseInput
            : {
                ...baseInput,
                source: {
                  ...baseInput.source,
                  async readChunk(...args: Parameters<typeof baseInput.source.readChunk>) {
                    const chunk = await baseInput.source.readChunk(...args)
                    return args[0] === 'skill_versions'
                      ? {
                          ...chunk,
                          decodedRows: chunk.decodedRows.map((row) => ({
                            ...row,
                            skill_id: 'missing',
                          })),
                        }
                      : chunk
                  },
                },
              }
        try {
          const capture: BootUpgradeCaptureInput = {
            stage: 'plan',
            source: {
              reader: input.source,
              preflight: input.preflight,
              preUpgrade: null,
              watermark: input.preflight.watermark,
              evidenceRoot: null,
              close: async () => {},
            },
            content: emptyV2Content,
            root: { kind: 'app-home', root, runsSupplied: false, objects: 'none' },
            manifest: {
              version: 1,
              roots: [],
              files: [],
              objects: [],
              databaseTrees: [],
              digest: valueDigest([]),
            },
            readArtifact: async () => null,
            writeArtifact: async () => {},
          }
          const facts = createBootUpgradeFacts(await skillBootEnvironment().capture(capture))
          const fact = SkillBootFactSchema.parse(facts.facts[0]!.evidence)
          const before = await input.source.readChunk('skills', null, 100)
          const sink = new V2MemorySink()
          if (mode === 'restart') {
            sink.loseAcknowledgementOnce = true
            await expect(
              runConversion({ ...input, bootUpgradeFacts: facts }, sink),
            ).rejects.toThrow('v2-sink-lost-acknowledgement')
          }
          const pending = runConversion({ ...input, bootUpgradeFacts: facts }, sink)
          if (mode === 'converter-waits') {
            try {
              await Promise.race([
                enteredContent,
                pending.then(() => {
                  throw new Error('conversion completed before content')
                }),
              ])
              expect(sink.rows('skills')).toEqual([])
              expect(sink.rows('skill_versions')).toEqual([])
              expect((await input.source.readChunk('skills', null, 100)).decodedRows).toEqual(
                before.decodedRows,
              )
            } finally {
              release()
            }
          }
          const summary = await pending
          if (mode === 'converter-failure') {
            expect(summary.status).toBe('blocked')
            expect(sink.rows('skills')).toEqual([])
            expect(sink.rows('skill_versions')).toEqual([])
            expect((await input.source.readChunk('skills', null, 100)).decodedRows).toEqual(
              before.decodedRows,
            )
            expect(readFileSync(join(root, 'skills/legacy/files/SKILL.md'))).toEqual(
              files[0]!.bytes,
            )
            return
          }
          const blocked =
            [
              'root-conflict',
              'support-only',
              'missing-root',
              'missing-snapshot',
              'hash-conflict',
              'authority-conflict',
              'husk-reference',
              'reserving',
              'symlink-root',
              'orphan-version',
            ].includes(mode) || mode.startsWith('active-')
          if (blocked) {
            expect(summary.status).toBe('blocked')
            expect(summary.blocks.length).toBeGreaterThan(0)
            if (mode !== 'orphan-version') {
              expect(fact.state).toBe('blocked')
              expect(sink.rows('skills')).toEqual([])
              expect(sink.rows('skill_versions')).toEqual([])
              expect(sink.rows('content_bytes')).toEqual([])
            }
          } else if (mode === 'husk') {
            expect(fact.state).toBe('husk')
            expect(sink.rows('skills')).toEqual([])
            expect(sink.rows('skill_versions')).toEqual([])
            expect([...sink.units.values()].flatMap((unit) => unit.dispositions)).toEqual(
              expect.arrayContaining([expect.objectContaining({ class: 'archived' })]),
            )
          } else {
            expect(summary.blocks).toEqual([])
            expect(sink.rows('skills')).toHaveLength(1)
            expect(sink.rows('skill_versions')).toHaveLength(1)
            const live = JSON.parse(String(sink.rows('skills')[0]!.content_ref_json))
            const snapshot = JSON.parse(String(sink.rows('skill_versions')[0]!.content_ref_json))
            expect(live.kind).toBe(database ? 'database-bytes' : 'local-file')
            expect(live.location).toEqual(
              database
                ? { codec: 'skill-tree', value: { skillId: id, tree: 'live' } }
                : { codec: 'skill-path', value: join(root, 'skills/legacy/files') },
            )
            expect(snapshot.kind).toBe(existing && !database ? 'local-file' : 'database-bytes')
            expect(snapshot.contentId).toBeNull()
            expect(live.contentId).toBeNull()
            expect(sink.rows('content_bytes')).toHaveLength(existing ? 0 : files.length)
            for (const row of sink.rows('skill_content_entries')) {
              const ref = JSON.parse(String(row.content_ref_json))
              const bytes = sink
                .rows('content_bytes')
                .find((entry) => entry.content_id === ref.contentId)!.bytes
              expect(Buffer.from(bytes as Uint8Array)).toEqual(
                Buffer.from(files.find((file) => file.path === row.path)!.bytes),
              )
            }
            const committed = structuredClone(sink.rows('skill_versions'))
            const completedCalls = conversionCalls
            await runConversion({ ...input, bootUpgradeFacts: facts }, sink)
            // Each replay recomputes the live and version references, then verifies the persisted receipt.
            expect(conversionCalls - completedCalls).toBe(2)
            expect(sink.rows('skill_versions')).toEqual(committed)
            if (!database)
              expect(readFileSync(join(root, 'skills', 'legacy', 'files', 'SKILL.md'))).toEqual(
                files[0]!.bytes,
              )
            if (id !== 'legacy' && !database)
              expect(existsSync(join(root, 'skills', id))).toBe(false)
            if (mode === 'drift') {
              writeFileSync(
                join(root, 'skills', 'legacy', 'files', 'raw.bin'),
                'changed after plan',
              )
              const recaptured = createBootUpgradeFacts(
                await skillBootEnvironment().capture({ ...capture, stage: 'freeze' }),
              )
              expect(recaptured.environmentDigest).not.toBe(facts.environmentDigest)
              // A frozen conversion never reopens or silently replaces its accepted bytes.
              const replay = new V2MemorySink()
              await runConversion({ ...input, bootUpgradeFacts: facts }, replay)
              expect(replay.rows('content_bytes')).toEqual(sink.rows('content_bytes'))
            }
          }
          expect((await input.source.readChunk('skills', null, 100)).decodedRows).toEqual(
            before.decodedRows,
          )
        } finally {
          await input.source.close()
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    180_000,
  )
})

test('B owns skills/versions exclusively; X retains the entry conversion claim', () => {
  const claims = contentConversion.rules.flatMap((rule) => rule.claims)
  expect(claims).not.toContain('skills')
  expect(claims).not.toContain('skill_versions')
  expect(claims).toContain('skill_content_entries')
  expect(createSkillBootConversion(convert).rules.flatMap((rule) => rule.claims)).toEqual([
    'skills',
    'skill_versions',
  ])
})

import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { contentRowColumns } from '@/platform/content/infrastructure/contentStore'
import { legacyContentRef } from '@/platform/content/contentRef'
import {
  skillFilesAbs,
  skillFilesRel,
  skillRootAbs,
  skillVersionAbs,
  skillVersionRelPath,
} from '@/modules/resource-catalog/infrastructure/legacy/skillIdentityPaths'

import {
  advancePhase,
  beginOperation,
  getActiveOp,
} from '@/modules/resource-catalog/infrastructure/legacy/skillOperations'
import {
  opBackupDir,
  opStagedDir,
} from '@/modules/resource-catalog/infrastructure/legacy/skillFsPublish'

import { describeEachProvider } from './helpers/eachProvider'
async function recoverNormalOperations(db: PersistenceDb, options: { appHome: string }) {
  const report = await createSkillCatalogBootAdapter({ db, ...options }).recoverOperations()
  return { recoveredOperations: report.total }
}

describeEachProvider(
  'RFC-395 retained normal version operation recovery',
  (harness) => {
    describe('RFC-223 PR-5 committed version-write recovery', () => {
      let db: PersistenceDb
      let appHome: string

      beforeEach(() => {
        appHome = mkdtempSync(join(tmpdir(), 'aw-version-recovery-'))
        db = harness.db
      })

      afterEach(() => rmSync(appHome, { recursive: true, force: true }))

      test.each(['intent', 'fs-staged'] as const)(
        'reserve %s binds the complete v1 publish window',
        async (phase) => {
          const id = 'reserve-fs-staged-v1'
          const files = skillFilesAbs(appHome, id)
          const version = skillVersionAbs(appHome, id, 1)
          writeTree(files, 'reserve-v1')
          cpSync(files, version, { recursive: true })
          const { skills, skillVersions } = tablesOf(db)
          await insertOne(db, skills, {
            id,
            name: 'reserve-v1',
            ...contentRowColumns(legacyContentRef('skill-path', 'local-file', skillFilesRel(id))),
            contentVersion: 1,
            reservationState: 'reserving',
            versionState: 'snapshot-authoritative',
          })
          await insertOne(db, skillVersions, {
            id: ulid(),
            skillId: id,
            versionIndex: 1,
            ...contentRowColumns(
              legacyContentRef('skill-path', 'local-file', skillVersionRelPath(id, 1)),
            ),
            source: 'initial',
            authorUserId: '__system__',
            contentHash: hashDir(version),
          })
          const opId = await databaseSessionFor(db).transaction(
            async (tx) =>
              await beginOperation(tx, {
                skillId: id,
                kind: 'reserve',
                preconditionJson: JSON.stringify({ skillId: id }),
              }),
          )
          if (phase === 'fs-staged')
            await databaseSessionFor(db).transaction(
              async (tx) => await advancePhase(tx, opId, 'fs-staged'),
            )
          else {
            await expect(recoverNormalOperations(db, { appHome })).rejects.toThrow(
              'disagrees with v1 publication authority',
            )
            expect(await db.select().from(skills).where(eq(skills.id, id))).toHaveLength(1)
            expect(await lockCount(db)).toBe(1)
            expect(existsSync(skillRootAbs(appHome, id))).toBe(true)
            return
          }
          expect((await recoverNormalOperations(db, { appHome })).recoveredOperations).toBe(1)
          expect(await db.select().from(skills).where(eq(skills.id, id))).toEqual([])
          expect(existsSync(skillRootAbs(appHome, id))).toBe(false)
          expect(await lockCount(db)).toBe(0)
        },
      )

      for (const crashWindow of ['before-publish', 'between-renames'] as const) {
        test(`${crashWindow} converges live from the committed target and clears exact residue`, async () => {
          const row = await seedCanonicalSkill(db, appHome, `version-${crashWindow}`)
          const planted = await plantCommittedVersionWrite(db, appHome, row.id)
          if (crashWindow === 'between-renames') {
            renameSync(planted.filesDir, opBackupDir(planted.filesDir, planted.publishId))
          }

          const report = await recoverNormalOperations(db, { appHome })
          expect(report.recoveredOperations).toBe(1)
          expect(readFileSync(join(planted.filesDir, 'SKILL.md'), 'utf-8')).toContain('new-v2')
          expect(hashDir(planted.filesDir)).toBe(hashDir(planted.versionDir))
          expect(await getActiveOp(db, row.id)).toBeNull()
          expect(await lockCount(db)).toBe(0)
          expect(
            readdirSync(skillRootAbs(appHome, row.id)).filter((name) =>
              name.startsWith('files.op-'),
            ),
          ).toEqual([])
        })
      }

      test('committed snapshot mismatch refuses and preserves recovery evidence', async () => {
        const row = await seedCanonicalSkill(db, appHome, 'version-mismatch')
        const planted = await plantCommittedVersionWrite(db, appHome, row.id)
        writeFileSync(join(planted.versionDir, 'tampered.txt'), 'tampered')

        await expect(recoverNormalOperations(db, { appHome })).rejects.toThrow(
          /does not match committed content hash/,
        )
        expect((await getActiveOp(db, row.id))?.phase).toBe('db-committed')
        expect(await lockCount(db)).toBe(1)
        expect(existsSync(planted.staging)).toBe(true)
      })

      test('non-current target or mismatched files_path cannot become canonical live', async () => {
        for (const [index, defect] of (['non-current', 'wrong-path'] as const).entries()) {
          const isolatedHome = mkdtempSync(join(tmpdir(), `aw-version-authority-${defect}-`))
          // 每个缺陷场景一台独立真库：场景之间会各留一笔活动 op + 锁，共用一个库就会互相恢复。
          const isolatedDb = harness.database(index).db
          try {
            const row = await seedCanonicalSkill(isolatedDb, isolatedHome, defect)
            await plantCommittedVersionWrite(isolatedDb, isolatedHome, row.id)
            if (defect === 'non-current') {
              const { skills } = tablesOf(isolatedDb)
              await isolatedDb
                .update(skills)
                .set({ contentVersion: 1 })
                .where(eq(skills.id, row.id))
            } else {
              const { skillVersions } = tablesOf(isolatedDb)
              await isolatedDb
                .update(skillVersions)
                .set({
                  ...contentRowColumns(
                    legacyContentRef('skill-path', 'local-file', skillVersionRelPath(row.id, 999)),
                  ),
                })
                .where(and(eq(skillVersions.skillId, row.id), eq(skillVersions.versionIndex, 2)))
            }

            await expect(
              recoverNormalOperations(isolatedDb, { appHome: isolatedHome }),
            ).rejects.toThrow(
              defect === 'non-current'
                ? /disagrees with version authority/
                : /target row files_path does not match its candidate/,
            )
            expect((await getActiveOp(isolatedDb, row.id))?.phase).toBe('db-committed')
            expect(await lockCount(isolatedDb)).toBe(1)
          } finally {
            rmSync(isolatedHome, { recursive: true, force: true })
          }
        }
      })

      test('a fingerprint-matching candidate-root symlink is never published or retired', async () => {
        const row = await seedCanonicalSkill(db, appHome, 'candidate-symlink')
        const planted = await plantCommittedVersionWrite(db, appHome, row.id)
        const externalCandidate = join(appHome, 'external-version-candidate')
        cpSync(planted.versionDir, externalCandidate, { recursive: true })
        rmSync(planted.versionDir, { recursive: true, force: true })
        symlinkSync(externalCandidate, planted.versionDir, 'dir')

        await expect(recoverNormalOperations(db, { appHome })).rejects.toThrow(
          /not a real directory/,
        )
        expect(readFileSync(join(planted.filesDir, 'SKILL.md'), 'utf-8')).toContain('old-v1')
        expect((await getActiveOp(db, row.id))?.phase).toBe('db-committed')
        expect(await lockCount(db)).toBe(1)
        expect(lstatSync(planted.versionDir).isSymbolicLink()).toBe(true)
      })

      test('an intermediate versions symlink fails before hash/copy/remove', async () => {
        const row = await seedCanonicalSkill(db, appHome, 'intermediate-symlink')
        const planted = await plantCommittedVersionWrite(db, appHome, row.id)
        const versions = join(skillRootAbs(appHome, row.id), 'versions')
        const externalVersions = join(appHome, 'external-versions-tree')
        renameSync(versions, externalVersions)
        symlinkSync(externalVersions, versions, 'dir')
        const externalHash = hashDir(externalVersions)

        await expect(recoverNormalOperations(db, { appHome })).rejects.toThrow(
          /version candidate is not a real directory/,
        )
        expect(hashDir(externalVersions)).toBe(externalHash)
        expect(readFileSync(join(planted.filesDir, 'SKILL.md'), 'utf-8')).toContain('old-v1')
        expect((await getActiveOp(db, row.id))?.phase).toBe('db-committed')
        expect(await lockCount(db)).toBe(1)
      })
    })
  },
  { databaseCount: 2 },
)
async function seedCanonicalSkill(
  db: PersistenceDb,
  appHome: string,
  label: string,
  identity: { id?: string; name?: string } = {},
): Promise<{ id: string; name: string }> {
  const id = identity.id ?? `canonical-${label}`
  const name = identity.name ?? `display-${label}`
  const filesDir = skillFilesAbs(appHome, id)
  const versionDir = skillVersionAbs(appHome, id, 1)
  writeTree(filesDir, 'old-v1')
  cpSync(filesDir, versionDir, { recursive: true })
  const { skills, skillVersions } = tablesOf(db)
  await insertOne(db, skills, {
    id,
    name,
    description: '',
    ...contentRowColumns(legacyContentRef('skill-path', 'local-file', skillFilesRel(id))),
    contentVersion: 1,
    reservationState: 'ready',
    versionState: 'snapshot-authoritative',
  })
  await insertOne(db, skillVersions, {
    id: ulid(),
    skillId: id,
    versionIndex: 1,
    ...contentRowColumns(legacyContentRef('skill-path', 'local-file', skillVersionRelPath(id, 1))),
    source: 'initial',
    authorUserId: '__system__',
    contentHash: hashDir(versionDir),
  })
  return { id, name }
}

async function plantCommittedVersionWrite(
  db: PersistenceDb,
  appHome: string,
  skillId: string,
): Promise<{
  publishId: string
  filesDir: string
  staging: string
  versionDir: string
}> {
  const publishId = ulid()
  const filesDir = skillFilesAbs(appHome, skillId)
  const staging = opStagedDir(filesDir, publishId)
  const versionDir = skillVersionAbs(appHome, skillId, 2)
  writeTree(staging, 'new-v2')
  cpSync(staging, versionDir, { recursive: true })
  const hash = hashDir(versionDir)
  const opId = await databaseSessionFor(db).transaction(
    async (tx) =>
      await beginOperation(tx, {
        skillId,
        kind: 'version-write',
        targetVersion: 2,
        stagingPath: relative(appHome, staging),
        candidatePath: relative(appHome, versionDir),
        preconditionJson: JSON.stringify({ skillId }),
      }),
  )
  await databaseSessionFor(db).transaction(async (tx) => await advancePhase(tx, opId, 'fs-staged'))
  await databaseSessionFor(db).transaction(
    async (tx) => await advancePhase(tx, opId, 'fs-versioned'),
  )
  await databaseSessionFor(db).transaction(async (tx) => {
    const { skills, skillVersions } = tablesOf(tx)
    await tx.update(skills).set({ contentVersion: 2 }).where(eq(skills.id, skillId))
    await insertOne(tx, skillVersions, {
      id: ulid(),
      skillId,
      versionIndex: 2,
      ...contentRowColumns(
        legacyContentRef('skill-path', 'local-file', skillVersionRelPath(skillId, 2)),
      ),
      source: 'editor',
      authorUserId: '__system__',
      contentHash: hash,
    })
    await advancePhase(tx, opId, 'db-committed')
  })
  return { publishId, filesDir, staging, versionDir }
}

function writeTree(root: string, marker: string): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'SKILL.md'), `# ${marker}\n`)
  writeFileSync(join(root, 'payload.txt'), marker)
}

async function lockCount(db: PersistenceDb): Promise<number> {
  const { skillOperationLocks } = tablesOf(db)
  return (await db.select().from(skillOperationLocks)).length
}

// Canonical display names are not physical ownership. These cases retain the
// original all-row ownership and residue oracles at the frozen B boundary.
describeV2Providers('RFC-395 identity ownership evidence', (h) => {
  test.each([
    'canonical-alias',
    'husk-alias',
    'legacy-alias',
    'two-node-cycle',
    'multi-version',
    'recursive-husk',
    'protocol-residue',
    'similar-support-name',
    'dangling-legacy-alias',
  ] as const)(
    '%s keeps every source byte and identity',
    async (mode) => {
      await h.install()
      const root = mkdtempSync(join(tmpdir(), 'aw-x2-identity-graph-'))
      const main = Buffer.from('---\nname: preserved\ndescription: d\n---\noriginal')
      const hash = digestSortedTree(['SKILL.md'], () => main)
      const write = (path: string, bytes = main) => {
        mkdirSync(join(root, path), { recursive: true })
        writeFileSync(join(root, path, 'SKILL.md'), bytes)
      }
      const skills: ReturnType<typeof frozenValues>[] = []
      const versions: ReturnType<typeof frozenValues>[] = []
      const canonical = (id: string, name: string, count = 1) => {
        skills.push(
          frozenValues('skills', {
            id,
            name,
            managed_path: `skills/${id}/files`,
            reservation_state: 'ready',
            version_state: 'snapshot-authoritative',
            content_version: count,
          }),
        )
        write(`skills/${id}/files`)
        for (let index = 1; index <= count; index++) {
          write(`skills/${id}/versions/v${index}/files`)
          versions.push(
            frozenValues('skill_versions', {
              id: `${id}-v${index}`,
              skill_id: id,
              version_index: index,
              files_path: `skills/${id}/versions/v${index}/files`,
              content_hash: hash,
              source: index === 1 ? 'initial' : 'editor',
            }),
          )
        }
      }
      try {
        if (mode === 'recursive-husk') {
          mkdirSync(join(root, 'skills/empty/files/nested/empty'), { recursive: true })
          skills.push(
            frozenValues('skills', {
              id: 'empty',
              name: 'empty',
              managed_path: 'skills/empty/files',
              reservation_state: 'ready',
              version_state: 'legacy-unbackfilled',
              content_version: 0,
            }),
          )
        } else if (mode === 'two-node-cycle') {
          for (const [id, name] of [
            ['left', 'right'],
            ['right', 'left'],
          ]) {
            write(`skills/${name}/files`)
            skills.push(
              frozenValues('skills', {
                id: id!,
                name: name!,
                managed_path: `skills/${name}/files`,
                reservation_state: 'ready',
                version_state: 'legacy-unbackfilled',
                content_version: 0,
              }),
            )
          }
        } else {
          canonical('owner', 'display', mode === 'multi-version' ? 3 : 1)
          if (mode === 'canonical-alias') canonical('alias', 'owner')
          if (mode === 'dangling-legacy-alias')
            symlinkSync(join(root, 'missing-display-root'), join(root, 'skills/display'), 'dir')
          if (mode === 'husk-alias' || mode === 'legacy-alias') {
            skills.push(
              frozenValues('skills', {
                id: 'alias',
                name: 'owner',
                managed_path: mode === 'husk-alias' ? 'skills/alias/files' : 'skills/owner/files',
                reservation_state: 'ready',
                version_state: 'legacy-unbackfilled',
                content_version: 0,
              }),
            )
            if (mode === 'husk-alias') mkdirSync(join(root, 'skills/alias'), { recursive: true })
          }
          if (mode === 'protocol-residue')
            mkdirSync(join(root, 'skills/owner/files.op-01J00000000000000000000000.backup'))
          if (mode === 'similar-support-name') {
            const name = 'files.op-01J00000000000000000000000.staged-not-an-op'
            writeFileSync(join(root, 'skills/owner/files', name), 'support')
            writeFileSync(join(root, 'skills/owner/versions/v1/files', name), 'support')
            versions[0] = frozenValues('skill_versions', {
              ...versions[0],
              content_hash: digestSortedTree(['SKILL.md', name].sort(), (path) =>
                path === 'SKILL.md' ? main : Buffer.from('support'),
              ),
            })
          }
        }
        await h.write('skills', skills)
        if (versions.length) await h.write('skill_versions', versions)
        const input = await h.input([createSkillBootConversion(convert)])
        try {
          const capture: BootUpgradeCaptureInput = {
            stage: 'freeze',
            source: {
              reader: input.source,
              preflight: input.preflight,
              preUpgrade: null,
              watermark: input.preflight.watermark,
              evidenceRoot: null,
              close: async () => {},
            },
            content: emptyV2Content,
            root: { kind: 'app-home', root, runsSupplied: false, objects: 'none' },
            manifest: {
              version: 1,
              roots: [],
              files: [],
              objects: [],
              databaseTrees: [],
              digest: valueDigest([]),
            },
            readArtifact: async () => null,
            writeArtifact: async () => {},
          }
          const before = (await input.source.readChunk('skills', null, 100)).decodedRows
          const facts = createBootUpgradeFacts(await skillBootEnvironment().capture(capture))
          const sink = new V2MemorySink(),
            result = await runConversion({ ...input, bootUpgradeFacts: facts }, sink)
          if (['legacy-alias', 'two-node-cycle', 'protocol-residue'].includes(mode))
            expect(result.status).toBe('blocked')
          else {
            expect(result.blocks).toEqual([])
            expect(sink.rows('skills')).toHaveLength(
              mode === 'recursive-husk' ? 0 : mode === 'canonical-alias' ? 2 : 1,
            )
            if (mode === 'multi-version') {
              expect(sink.rows('skill_versions')).toHaveLength(3)
              expect(sink.rows('content_objects')).toHaveLength(0)
            }
          }
          expect((await input.source.readChunk('skills', null, 100)).decodedRows).toEqual(before)
          if (mode === 'recursive-husk')
            expect(existsSync(join(root, 'skills/empty/files/nested/empty'))).toBe(true)
          else if (mode !== 'two-node-cycle')
            expect(readFileSync(join(root, 'skills/owner/files/SKILL.md'))).toEqual(main)
        } finally {
          await input.source.close()
        }
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    180_000,
  )
})
