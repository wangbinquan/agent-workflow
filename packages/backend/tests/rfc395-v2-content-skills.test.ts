import { setDefaultTimeout, expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import {
  contentFixture,
  contentLookups,
  seedContentParents,
  FakeContentInventory,
} from './helpers/rfc395V2/contentFixtures'
import { conversion } from '@/platform/content/migration'
import { decodeLegacySkillBytes } from '@/platform/content/migration/skillContent'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import { decodeContentSlots, skillTreeKey } from '@/platform/content/migration/specs'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'

// Slowest case took 3.60 s on CI run 40433510287 including hooks; allow 20 s.
setDefaultTimeout(20_000)

test('skill decoder keeps BOM, invalid UTF-8 and empty bytes; UTF-8 and base64 agree', () => {
  for (const text of ['', '\ufeff技能\r\n', 'text\0tail']) {
    const bytes = new TextEncoder().encode(text)
    const utf8 = decodeLegacySkillBytes('utf8', text)
    const base64 = decodeLegacySkillBytes('base64', Buffer.from(bytes).toString('base64'))
    expect(utf8).toEqual(base64)
    expect(utf8.bytes).toEqual(bytes)
    expect(utf8.bom).toBe(text.startsWith('\ufeff'))
    expect(utf8.empty).toBe(text.length === 0)
    expect(utf8.validUtf8).toBe(true)
  }
  const invalid = new Uint8Array([0xc3, 0x28, 0xff, 0])
  expect(decodeLegacySkillBytes('base64', Buffer.from(invalid).toString('base64'))).toEqual({
    bytes: invalid,
    validUtf8: false,
    bom: false,
    empty: false,
  })
  for (const value of ['?', 'AA', 'A===', 'AB=='])
    expect(() => decodeLegacySkillBytes('base64', value)).toThrow('v2-skill-base64-invalid')
  expect(() => decodeLegacySkillBytes('utf8', '\ud800')).toThrow('v2-skill-text-not-lossless')
  expect(() => decodeLegacySkillBytes('unknown', '')).toThrow('v2-skill-encoding-unknown')
})

describeV2Providers('RFC-395 V2-X skill byte conversion', (h) => {
  // Tree ownership and initial versions are exercised by rfc395-boot-skill-conversion.
  test('X-5 released BOM stripping keeps served bytes, corrects size and records original size for every tree', async () => {
    await h.install()
    await seedContentParents(h)
    const cases = [
      { tree: 'live', content: '' },
      { tree: 'staging:operation', content: '技能\r\n' },
      { tree: 'version:1', content: 'immutable' },
    ]
    await h.write(
      'skill_content_entries',
      cases.map(({ tree, content }) =>
        contentFixture('skill_content_entries', {
          tree,
          content,
          size: Buffer.byteLength(content) + 3,
        }),
      ),
    )
    const input = await h.input([conversion, contentLookups()], {
      content: new FakeContentInventory(),
    })
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).blocks).toEqual([])
      for (const { tree, content } of cases) {
        const bytes = new TextEncoder().encode(content)
        const row = sink.rows('skill_content_entries').find((row) => row.tree === tree)!
        const ref = JSON.parse(row.content_ref_json as string)
        expect(row.size).toBe(bytes.length)
        expect(ref.size).toBe(bytes.length)
        expect(ref.sha256).toBe(bytesDigest(bytes).slice(7))
        expect(
          sink.rows('content_objects').find((row) => row.content_id === ref.contentId)?.size,
        ).toBe(bytes.length)
        expect(
          sink.rows('content_bytes').find((row) => row.content_id === ref.contentId)?.bytes,
        ).toEqual(bytes)
        expect([...sink.units.values()].flatMap((unit) => unit.records)).toContainEqual(
          expect.objectContaining({
            kind: 'decision',
            code: 'v2-skill-stripped-bom-size',
            payload: expect.objectContaining({
              actualSize: bytes.length,
              storedSize: bytes.length + 3,
              servedBytes: 'unchanged',
            }),
          }),
        )
      }
      const source = await input.source.readChunk('skill_content_entries', null, 10)
      expect(source.decodedRows.map((row) => row.size).sort()).toEqual(
        cases.map(({ content }) => Buffer.byteLength(content) + 3).sort(),
      )
    } finally {
      await input.source.close()
    }
  })
  test('X-5 does not excuse base64 length errors or double-count a BOM still present in bytes', async () => {
    await h.install()
    await seedContentParents(h)
    await h.write('skill_content_entries', [
      contentFixture('skill_content_entries', {
        path: 'base64',
        encoding: 'base64',
        content: '',
        size: 3,
      }),
      contentFixture('skill_content_entries', { path: 'bom-present', content: '\ufeff', size: 6 }),
      contentFixture('skill_content_entries', { path: 'wrong-delta', content: '', size: 4 }),
    ])
    const input = await h.input([conversion, contentLookups()], {
      content: new FakeContentInventory(),
    })
    try {
      const sink = new V2MemorySink()
      const result = await runConversion(input, sink)
      expect(result.blocks).toHaveLength(3)
      expect(result.blocks.every((block) => block.code === 'v2-content-source-invalid')).toBe(true)
      expect(sink.rows('skill_content_entries')).toEqual([])
    } finally {
      await input.source.close()
    }
  })
  test('BOM, invalid UTF-8, empty and encoded text reach database bytes unchanged', async () => {
    await h.install()
    await seedContentParents(h)
    const cases = [
      new Uint8Array([]),
      new Uint8Array([0xef, 0xbb, 0xbf, 65]),
      new Uint8Array([0xc3, 0x28, 0xff]),
      new TextEncoder().encode('技能\r\n'),
    ]
    await h.write(
      'skill_content_entries',
      cases.map((bytes, index) =>
        contentFixture('skill_content_entries', {
          path: `case-${index}`,
          content: Buffer.from(bytes).toString('base64'),
          encoding: 'base64',
          size: bytes.length,
        }),
      ),
    )
    await h.write('skill_content_entries', [
      contentFixture('skill_content_entries', {
        path: 'utf8',
        encoding: 'utf8',
        content: '技能\r\n',
        size: cases[3]!.length,
      }),
    ])
    const input = await h.input([conversion, contentLookups()], {
      content: new FakeContentInventory(),
    })
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).blocks).toEqual([])
      for (const [index, expected] of cases.entries()) {
        const row = sink.rows('skill_content_entries').find((row) => row.path === `case-${index}`)!
        const ref = JSON.parse(row.content_ref_json as string)
        expect(ref.kind).toBe('database-bytes')
        expect(ref.sha256).toBe(bytesDigest(expected).slice(7))
        expect(ref.location).toEqual({
          codec: 'skill-tree',
          value: { skillId: 'skill', tree: 'live', path: `case-${index}` },
        })
        expect(row.content_inline_bytes).toBeNull()
        expect(
          sink.rows('content_bytes').find((bytes) => bytes.content_id === ref.contentId)!.bytes,
        ).toEqual(expected)
      }
      const records = [...sink.units.values()].flatMap((unit) => unit.records)
      expect(records).toContainEqual(
        expect.objectContaining({
          kind: 'decision',
          code: 'v2-skill-byte-profile',
          payload: expect.objectContaining({ bom: true }),
        }),
      )
      expect(records).toContainEqual(
        expect.objectContaining({
          kind: 'decision',
          code: 'v2-skill-byte-profile',
          payload: expect.objectContaining({ validUtf8: false }),
        }),
      )
      expect(records).toContainEqual(
        expect.objectContaining({
          kind: 'decision',
          code: 'v2-skill-byte-profile',
          payload: expect.objectContaining({ empty: true }),
        }),
      )
    } finally {
      await input.source.close()
    }
  })
  test('bad base64 or a stored byte length mismatch blocks without changing source', async () => {
    await h.install()
    await seedContentParents(h)
    await h.write('skill_content_entries', [
      contentFixture('skill_content_entries', {
        path: 'bad-base64',
        encoding: 'base64',
        content: '!?',
        size: 0,
      }),
      contentFixture('skill_content_entries', { path: 'bad-size', content: '', size: 2 }),
    ])
    const input = await h.input([conversion, contentLookups()], {
      content: new FakeContentInventory(),
    })
    try {
      const sink = new V2MemorySink()
      const result = await runConversion(input, sink)
      expect(
        result.blocks
          .filter((block) => block.sourceTable === 'skill_content_entries')
          .map((block) => block.code),
      ).toEqual(['v2-content-source-invalid', 'v2-content-source-invalid'])
      expect(sink.rows('skill_content_entries')).toEqual([])
    } finally {
      await input.source.close()
    }
  })
})

test('V2-2 physical-looking database tree aliases use explicit identity while local skill paths stay literal', () => {
  const key = [canonicalValue('tree-skill')]
  const path = '/old/app/skills/tree-skill/files'
  const row: SourceRow = {
    table: 'skills',
    phase: 'current',
    key,
    encodedKey: encodeMigrationKey('skills', key),
    canonical: { key, values: [] },
    values: { id: 'tree-skill', managed_path: path },
  }
  const facts = {
    reviewObjects: new Map(),
    portObjects: new Map(),
    databaseSkillTrees: new Set<string>(),
  }
  const local = decodeContentSlots(row, facts)[0]!
  expect(local.ref?.location).toEqual({ codec: 'skill-path', value: path })
  expect(local.originalReference).toBe(path)
  facts.databaseSkillTrees.add(skillTreeKey('tree-skill', 'live'))
  const database = decodeContentSlots(row, facts)[0]!
  expect(database.ref?.location).toEqual({
    codec: 'skill-tree',
    value: { skillId: 'tree-skill', tree: 'live' },
  })
  expect(database.originalReference).toBe(path)
})
