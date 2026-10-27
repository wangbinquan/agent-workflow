// RFC-395 U-4: epoch-1 identity/backfill proofs run at B's frozen converter boundary.
import { setDefaultTimeout, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { digestSortedTree } from '@/modules/resource-catalog/infrastructure/legacy/skillHash'

// Slowest case took 3.52 s on CI run 40433510287 including hooks (0.42 s before RFC-395 II-b); allow 20 s.
setDefaultTimeout(20_000)

const modes: readonly string[] = [
  'database-initial',
  'database-existing',
  'restart',
  'drift',
  'husk',
]
// Assigning the real implementation to B's type locks the published structural contract.
const convert: SkillBootContentConverter = convertFrozenSkillContent

describeV2Providers('RFC-395 former identity content effects: exact frozen bytes', (h) => {
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
            frozenValues('memories', { id: 'memory', fused_into_skill_id: id }),
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
              skill_id: 'missing',
              version_index: 1,
              files_path: 'skills/missing/versions/v1/files',
            }),
          ])
        const input = await h.input([createSkillBootConversion(convert)])
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
          const summary = await runConversion({ ...input, bootUpgradeFacts: facts }, sink)
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
            expect(live.location).toEqual(
              database
                ? {
                    codec: 'skill-tree',
                    value: { skillId: id, tree: 'live' },
                  }
                : { codec: 'skill-path', value: join(root, 'skills', 'legacy', 'files') },
            )
            expect(snapshot.location).toEqual(
              existing && !database
                ? {
                    codec: 'skill-path',
                    value: join(root, 'skills', 'legacy', 'versions', 'v1', 'files'),
                  }
                : { codec: 'skill-tree', value: { skillId: id, tree: 'version:1' } },
            )
            expect(live.contentId).toBeNull()
            expect(snapshot.contentId).toBeNull()
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
            await runConversion({ ...input, bootUpgradeFacts: facts }, sink)
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
