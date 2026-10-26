import {
  convertFrozenSkillContent,
  conversion as contentConversion,
} from '@/platform/content/migration'
import { contentLookups } from './helpers/rfc395V2/contentFixtures'
// RFC-395 B-2: frozen source trees and deterministic initial versions. X's publication seam is injected.
import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createSkillBootConversion,
  type SkillBootContentConverter,
} from '@/modules/resource-catalog/infrastructure/migration/skillBootRules'
import {
  skillBootEnvironment,
  verifyFrozenSkillTree,
  SkillBootFactSchema,
  type FrozenSkillTree,
} from '@/modules/resource-catalog/infrastructure/migration/skillBootFacts'
import { digestSortedTree } from '@/modules/resource-catalog/infrastructure/legacy/skillHash'
import {
  createBootUpgradeFacts,
  bootUpgradeEffectsFromRecords,
} from '@/platform/persistence/migration/conversion/bootUpgradeFacts'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import { encodeContentRefColumns } from '@/platform/content/contentRefCodec'
import { legacyLocationToContentRef } from '@/platform/persistence/migration/conversion/content'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { describeV2Providers, emptyV2Content } from './helpers/rfc395V2Harness'
import { frozenValues } from './helpers/rfc395V2/contentFixtures'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import type { BootUpgradeCaptureInput } from '@/platform/persistence/migration/freeze/bootUpgradeEnvironment'

describeV2Providers('RFC-395 skill boot conversion', (h) => {
  test.each([
    'initial',
    'existing',
    'husk',
    'husk-reference',
    'support-only',
    'missing-snapshot',
    'active-operation',
    'root-conflict',
    'null-reference',
  ] as const)(
    '%s is proved before producing skill/version rows',
    async (mode) => {
      await h.install()
      const root = mkdtempSync(join(tmpdir(), 'boot-skill-')),
        main = Buffer.from([0xef, 0xbb, 0xbf, 0x23, 0x20, 0x78])
      const files = new Map([
        ['SKILL.md', main],
        ['empty.bin', Buffer.alloc(0)],
        ['raw.bin', Buffer.from([0xff, 0x00])],
      ])
      const writeTree = (path: string, includeMain = true) => {
        mkdirSync(path, { recursive: true })
        for (const [name, bytes] of files)
          if (includeMain || name !== 'SKILL.md') writeFileSync(join(path, name), bytes)
      }
      const hasVersions = mode === 'existing' || mode === 'missing-snapshot'
      if (mode !== 'husk' && mode !== 'husk-reference')
        writeTree(join(root, 'skills', 'old-name', 'files'), mode !== 'support-only')
      if (mode === 'existing')
        writeTree(join(root, 'skills', 'old-name', 'versions', 'v1', 'files'))
      if (mode === 'root-conflict') writeTree(join(root, 'skills', 'skill', 'files'))
      await h.write('skills', [
        frozenValues('skills', {
          id: 'skill',
          name: 'old-name',
          managed_path: mode === 'null-reference' ? null : 'skills/old-name/files',
          reservation_state: 'ready',
          version_state: hasVersions ? 'snapshot-authoritative' : 'legacy-unbackfilled',
          content_version: hasVersions ? 1 : 0,
        }),
      ])
      if (hasVersions)
        await h.write('skill_versions', [
          frozenValues('skill_versions', {
            id: 'original-v1',
            skill_id: 'skill',
            version_index: 1,
            files_path: 'skills/old-name/versions/v1/files',
            content_hash: digestSortedTree([...files.keys()].sort(), (path) => files.get(path)!),
            source: 'initial',
          }),
        ])
      if (mode === 'husk-reference')
        await h.write('memories', [
          frozenValues('memories', {
            id: 'referenced-memory',
            status: 'fused',
            fused_into_skill: 'old-name',
            fused_into_skill_id: 'skill',
          }),
        ])
      if (mode === 'active-operation')
        await h.write('skill_operations', [
          frozenValues('skill_operations', {
            op_id: 'op',
            skill_id: 'skill',
            kind: 'version-write',
            active: 1,
            phase: 'intent',
          }),
        ])
      const received = new Map<string, FrozenSkillTree>()
      const publish: SkillBootContentConverter = async ({ tree, snapshot, skillId }) => {
        received.set(tree, structuredClone(snapshot))
        const bytes = Buffer.from(JSON.stringify(snapshot.files))
        const columns = encodeContentRefColumns(
          legacyLocationToContentRef({
            kind: 'inline',
            location: { codec: 'skill-tree-fixture', value: { skillId, tree } },
            bytes,
          }),
        )
        return { refJson: columns.json!, inline: columns.inlineBytes }
      }
      const conversion = createSkillBootConversion(publish),
        input = await h.input([conversion])
      const artifacts = new Map<string, Uint8Array>()
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
        readArtifact: async (name) => artifacts.get(name) ?? null,
        writeArtifact: async (name, bytes) => {
          artifacts.set(name, bytes)
        },
      }
      try {
        const rawReads: string[] = []
        const reader = capture.source.reader
        const guarded: BootUpgradeCaptureInput = {
          ...capture,
          source: {
            ...capture.source,
            preflight: {
              ...capture.source.preflight,
              tables: [
                ...capture.source.preflight.tables,
                {
                  table: 'metadata-fixture',
                  physicalTable: 'metadata-fixture',
                  rows: 1,
                  disposition: 'metadata',
                  destination: { kind: 'migration-records', records: [] },
                  reason: 'fixture',
                },
                {
                  table: 'archive-fixture',
                  physicalTable: 'archive-fixture',
                  rows: 1,
                  disposition: 'archived',
                  destination: { kind: 'archive' },
                  reason: 'fixture',
                },
              ],
            },
            reader: {
              ...reader,
              kind: reader.kind,
              preflight: () => reader.preflight(),
              assertUnchanged: (expected) => reader.assertUnchanged(expected),
              close: () => reader.close(),
              readChunk: (...args) => reader.readChunk(...args),
              readRawChunk: async (...args) => {
                rawReads.push(args[0])
                return reader.readRawChunk(...args)
              },
            },
          },
        }
        const facts = createBootUpgradeFacts(await skillBootEnvironment().capture(guarded))
        expect(rawReads).not.toContain('metadata-fixture')
        expect(rawReads).not.toContain('archive-fixture')
        if (!mode.startsWith('husk')) expect(rawReads).toEqual([])
        const fact = SkillBootFactSchema.parse(facts.facts[0]!.evidence)
        const sink = new V2MemorySink()
        if (mode === 'initial') {
          sink.loseAcknowledgementOnce = true
          await expect(runConversion({ ...input, bootUpgradeFacts: facts }, sink)).rejects.toThrow(
            'v2-sink-lost-acknowledgement',
          )
        }
        const summary = await runConversion({ ...input, bootUpgradeFacts: facts }, sink)
        if (mode === 'husk') {
          expect(fact.state).toBe('husk')
          expect(
            summary.tableReceipts.find((receipt) => receipt.sourceTable === 'skills'),
          ).toMatchObject({
            counts: { converted: 0, archived: 1, blocked: 0 },
          })
          expect(sink.rows('skills')).toEqual([])
          expect(bootUpgradeEffectsFromRecords(summary.records)[0]).toMatchObject({
            disposition: 'history-only',
            after: { removedHusk: 'skill' },
          })
        } else if (mode === 'initial' || mode === 'existing') {
          expect(summary.status).toBe('converted')
          expect(sink.rows('skill_versions')).toHaveLength(1)
          if (mode === 'existing') expect(sink.rows('skill_versions')[0]!.id).toBe('original-v1')
          else expect(sink.rows('skill_versions')[0]!.id).toMatch(/^mc1_/)
          expect(sink.rows('skills')[0]).toMatchObject({
            content_version: 1,
            version_state: 'snapshot-authoritative',
          })
          const snapshot = received.get('version:1')!
          for (const file of snapshot.files)
            expect(Buffer.from(file.base64, 'base64')).toEqual(files.get(file.path)!)
          expect(snapshot.files.find((file) => file.path === 'empty.bin')!.size).toBe(0)
          const before = sink.rows('skill_versions')
          await runConversion({ ...input, bootUpgradeFacts: facts }, sink)
          expect(sink.rows('skill_versions')).toEqual(before)
          expect(
            (await input.source.readChunk('skills', null, 100)).decodedRows[0]!.managed_path,
          ).toBe('skills/old-name/files')
        } else {
          expect(summary.status).toBe('blocked')
          expect(received.size).toBe(0)
          expect(sink.rows('skills')).toEqual([])
          expect(sink.rows('skill_versions')).toEqual([])
        }
        if (mode === 'initial') {
          const changedMetadata = await skillBootEnvironment().capture({
            ...guarded,
            source: {
              ...guarded.source,
              reader: {
                ...guarded.source.reader,
                readChunk: async (...args) => {
                  const chunk = await reader.readChunk(...args)
                  return args[0] === 'skills'
                    ? {
                        ...chunk,
                        decodedRows: chunk.decodedRows.map((row) => ({
                          ...row,
                          updated_at: 999999,
                        })),
                      }
                    : chunk
                },
              },
            },
          })
          expect(createBootUpgradeFacts(changedMetadata).environmentDigest).toBe(
            facts.environmentDigest,
          )
          expect(SkillBootFactSchema.parse(changedMetadata[0]!.evidence).sourceDigest).not.toBe(
            fact.sourceDigest,
          )
          writeFileSync(join(root, 'skills', 'old-name', 'files', 'raw.bin'), Buffer.from([1, 2]))
          const drift = createBootUpgradeFacts(
            await skillBootEnvironment().capture({ ...capture, stage: 'freeze' }),
          )
          expect(drift.environmentDigest).not.toBe(facts.environmentDigest)
          const corrupted = structuredClone(fact.live!)
          corrupted.files[0]!.base64 = Buffer.from('changed').toString('base64')
          expect(() => verifyFrozenSkillTree(corrupted)).toThrow('frozen-bytes-mismatch')
        }
      } finally {
        await input.source.close()
        rmSync(root, { recursive: true, force: true })
      }
    },
    180_000,
  )
})

describeV2Providers('RFC-395 B owns database skill tree identities', (h) => {
  test('existing trees have distinct explicit locators; entries are emitted exactly once', async () => {
    await h.install()
    for (const id of ['tree-a', 'tree-b']) {
      await h.write('skills', [
        frozenValues('skills', {
          id,
          name: id,
          managed_path: 'database:skill_content_entries',
          reservation_state: 'ready',
          version_state: 'snapshot-authoritative',
          content_version: 2,
        }),
      ])
      for (const tree of ['live', 'version:1', 'version:2']) {
        const bytes = Buffer.from(`${id}/${tree === 'live' ? 'version:2' : tree}`)
        await h.write('skill_content_entries', [
          frozenValues('skill_content_entries', {
            skill_id: id,
            tree,
            path: 'SKILL.md',
            encoding: 'base64',
            content: bytes.toString('base64'),
            size: bytes.length,
          }),
        ])
        if (tree !== 'live')
          await h.write('skill_versions', [
            frozenValues('skill_versions', {
              id: `${id}-${tree}`,
              skill_id: id,
              version_index: Number(tree.slice(8)),
              files_path: 'database:skill_content_entries',
              content_hash: digestSortedTree(['SKILL.md'], () => bytes),
            }),
          ])
      }
    }
    const input = await h.input([
      createSkillBootConversion(convertFrozenSkillContent),
      contentConversion,
      contentLookups(),
    ])
    try {
      const facts = createBootUpgradeFacts(
        await skillBootEnvironment().capture({
          stage: 'freeze',
          source: {
            reader: input.source,
            preflight: input.preflight,
            preUpgrade: null,
            watermark: input.preflight.watermark,
            evidenceRoot: null,
            close: async () => {},
          },
          root: {
            kind: 'app-home',
            root: '/unused-database-profile',
            runsSupplied: false,
            objects: 'none',
          },
          content: emptyV2Content,
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
        }),
      )
      const sink = new V2MemorySink()
      const summary = await runConversion({ ...input, bootUpgradeFacts: facts }, sink)
      expect(summary.blocks).toEqual([])
      expect(sink.rows('skill_content_entries')).toHaveLength(6)
      for (const row of [...sink.rows('skills'), ...sink.rows('skill_versions')]) {
        const skillId = String(row.skill_id ?? row.id),
          tree = row.version_index ? `version:${row.version_index}` : 'live'
        expect(JSON.parse(String(row.content_ref_json))).toMatchObject({
          kind: 'database-bytes',
          contentId: null,
          location: { codec: 'skill-tree', value: { skillId, tree } },
        })
      }
      const receipts = [...sink.units.values()]
        .flatMap((unit) => unit.artifacts)
        .filter((receipt) => ['skills', 'skill_versions'].includes(receipt.sourceTable))
      expect(receipts).toHaveLength(6)
      expect(
        receipts.every((receipt) => receipt.originalReference === 'database:skill_content_entries'),
      ).toBe(true)
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('orphan versions run through conversion and receive a per-row block without disappearing', async () => {
    await h.install()
    await h.write('skills', [
      frozenValues('skills', { id: 'physical-parent', name: 'physical-parent' }),
    ])
    await h.write('skill_versions', [
      frozenValues('skill_versions', {
        id: 'orphan-version',
        skill_id: 'physical-parent',
        version_index: 1,
        files_path: 'skills/missing/versions/v1/files',
      }),
    ])
    const input = await h.input([createSkillBootConversion(convertFrozenSkillContent)])
    const reader = input.source
    try {
      // A corrupt logical source is injected after the valid physical FK fixture.
      const source = {
        ...reader,
        async readChunk(...args: Parameters<typeof reader.readChunk>) {
          const chunk = await reader.readChunk(...args)
          return args[0] === 'skill_versions'
            ? {
                ...chunk,
                decodedRows: chunk.decodedRows.map((row) => ({ ...row, skill_id: 'missing' })),
              }
            : chunk
        },
      }
      const sink = new V2MemorySink()
      const summary = await runConversion(
        { ...input, source, bootUpgradeFacts: createBootUpgradeFacts([]) },
        sink,
      )
      expect(summary.blocks.some((block) => block.code === 'v2-boot-skill-orphan-version')).toBe(
        true,
      )
      expect(
        summary.tableReceipts.find((receipt) => receipt.sourceTable === 'skill_versions'),
      ).toMatchObject({
        rowsRead: 1,
        counts: { blocked: 1, converted: 0 },
      })
      expect(sink.rows('skill_versions')).toEqual([])
    } finally {
      await reader.close()
    }
  }, 180_000)
})
