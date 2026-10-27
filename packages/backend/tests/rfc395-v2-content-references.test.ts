import { setDefaultTimeout, expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import {
  contentFixture,
  contentLookups,
  contentBytes,
  contentText,
  contentDigest,
  seedContentParents,
  FakeContentInventory,
  readFrozenRows,
} from './helpers/rfc395V2/contentFixtures'
import { conversion } from '@/platform/content/migration'
import { contentTableSpecs } from '@/platform/content/migration/specs'
import { convertContentReference } from '@/platform/content/migration/convert'
import { legacyLocationToContentRef } from '@/platform/persistence/migration/conversion/content'
import { decodeContentRefColumns } from '@/platform/content/contentRefCodec'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import type { ConversionRule } from '@/platform/persistence/migration/conversion/rule'

// Slowest case took 3.19 s on CI run 40433510287 including hooks; allow 20 s.
setDefaultTimeout(20_000)

describeV2Providers('RFC-395 V2-X content references', (h) => {
  test('X-owned real source shapes preserve bytes, NULLs, location and untouched columns', async () => {
    await h.install()
    await seedContentParents(h)
    for (const spec of contentTableSpecs)
      if (spec.table !== 'doc_versions') await h.write(spec.table, [contentFixture(spec.table)])
    const input = await h.input([conversion, contentLookups()], {
      content: new FakeContentInventory(),
    })
    const sink = new V2MemorySink()
    try {
      const summary = await runConversion(input, sink)
      expect(summary.blocks).toEqual([])
      for (const spec of contentTableSpecs.filter(
        (spec) => !['skills', 'skill_versions'].includes(spec.table),
      ))
        expect(sink.rows(spec.table).length).toBeGreaterThan(0)
      for (const [table, column] of [
        ['node_run_outputs', 'content'],
        ['review_comments', 'comment_text'],
        ['employee_reaction_artifacts', 'body'],
      ] as const) {
        const row = sink.rows(table)[0]!
        const ref = decodeContentRefColumns(
          row.content_ref_json as string,
          row.content_inline_bytes as Uint8Array,
        )!
        expect(ref.kind).toBe('inline')
        expect(ref.sha256).toBe(contentDigest)
        expect(ref.mediaType).toBeNull()
        expect(row.content_inline_bytes).toEqual(contentBytes)
        expect(row[column]).toBeUndefined()
      }
      expect(sink.rows('node_run_outputs')[0]!.archive_json).toBe(' { "v": 1, "items": [] } ')
      // B exclusively owns skills and skill_versions; its suite covers absent paths.
      expect(sink.rows('skills')).toEqual([])
      expect(sink.rows('skill_versions')).toEqual([])
      const gate = sink.rows('collaboration_gate_artifacts')[0]!
      expect(gate.final_content_key).toBe('runs/task/review/doc.md')
      expect(JSON.parse(gate.staged_content_ref_json as string).location.value).toBe(
        'runs/.staging/doc.md',
      )
      expect(JSON.parse(gate.content_ref_json as string).location.value).toBe(
        'runs/task/review/doc.md',
      )
      expect(JSON.parse(sink.rows('doc_versions')[0]!.content_ref_json as string).mediaType).toBe(
        'text/markdown',
      )
      expect(sink.rows('content_bytes')[0]!.bytes).toEqual(contentBytes)
      const artifacts = [...sink.units.values()].flatMap((unit) => unit.artifacts)
      expect(
        artifacts
          .filter((receipt) => receipt.bytes)
          .every((receipt) => receipt.bytes!.sha256 === contentDigest),
      ).toBe(true)
      const before = [...sink.units.values()].map((unit) => unit.receipt.digest)
      await runConversion(input, sink)
      expect([...sink.units.values()].map((unit) => unit.receipt.digest)).toEqual(before)
      const source = await readFrozenRows(h, 'node_run_outputs')
      expect(source[0]!.values.content).toBe(contentText)
    } finally {
      await input.source.close()
    }
  })

  test('twelve table origins times four ContentRef backends preserve exact locations and original-byte receipts', async () => {
    await h.install()
    await seedContentParents(h)
    for (const spec of contentTableSpecs)
      if (spec.table !== 'doc_versions') await h.write(spec.table, [contentFixture(spec.table)])
    let checked = 0
    // This matrix exercises the common conversion boundary. Epoch-1 inline
    // text is never reinterpreted as a path by the production source decoders.
    const rules: ConversionRule[] = contentTableSpecs.map((spec) => ({
      ref: { id: `fixture/backends/${spec.table}`, version: 1 },
      owner: 'fixture',
      claims: [spec.table],
      produces: [],
      lookups: [],
      unit: { kind: 'source-chunk', table: spec.table },
      async convert(unit, ctx) {
        for (const row of unit.rows.get(spec.table)!) {
          for (const kind of ['inline', 'local-file', 'database-bytes', 'object'] as const) {
            const location = {
              codec: 'fixture-original-location',
              value: `untouched/${spec.table}/${kind}`,
            }
            const ref = legacyLocationToContentRef({
              kind,
              location,
              ...(kind === 'inline' ? { bytes: contentBytes } : {}),
            })
            const converted = await convertContentReference(
              {
                column: spec.sourceColumns[0]!,
                originalReference: location.value,
                target: { table: spec.table, key: row.encodedKey },
                refColumn: 'content_ref_json',
                bytesColumn: 'content_inline_bytes',
                required: false,
                ref,
              },
              row,
              ctx,
            )
            expect(converted.blocked).toBe(false)
            const decoded = decodeContentRefColumns(converted.refJson, converted.inline)!
            expect(decoded.kind).toBe(kind)
            expect(decoded.location).toEqual(location)
            expect(decoded.sha256).toBe(contentDigest)
            expect(decoded.size).toBe(contentBytes.length)
            expect(decoded.mediaType).toBeNull()
            if (kind === 'inline') expect(converted.inline).toEqual(contentBytes)
            else expect(converted.inline).toBeNull()
            checked++
          }
          ctx.out.record(
            { kind: 'decision', code: 'fixture-backend-matrix', payload: row.encodedKey },
            row,
          )
        }
      },
    }))
    const input = await h.input([{ rules, lookups: [], validators: [] }], {
      content: new FakeContentInventory(),
    })
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).blocks).toEqual([])
      expect(checked).toBe(13 * 4) // The parents include the additional nullable skill row.
      expect(
        [...sink.units.values()]
          .flatMap((unit) => unit.artifacts)
          .every((receipt) => receipt.bytes?.sha256 === contentDigest),
      ).toBe(true)
    } finally {
      await input.source.close()
    }
  })

  test('a prepared event archive keeps its NULL reference', async () => {
    await h.install()
    await seedContentParents(h)
    await h.write('hosted_node_event_archives', [
      contentFixture('hosted_node_event_archives', { state: 'prepared', object_id: null }),
    ])
    const input = await h.input([conversion, contentLookups()], {
      content: new FakeContentInventory(),
    })
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).blocks).toEqual([])
      expect(sink.rows('hosted_node_event_archives')[0]).toMatchObject({
        state: 'prepared',
        content_ref_json: null,
        content_inline_bytes: null,
      })
    } finally {
      await input.source.close()
    }
  })
})
