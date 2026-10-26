import { expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import {
  contentFixture,
  contentLookups,
  contentDigest,
  contentBytes,
  objectId,
  seedContentParents,
  FakeContentInventory,
} from './helpers/rfc395V2/contentFixtures'
import { conversion } from '@/platform/content/migration'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { sha256Hex } from '@/util/hash'

describeV2Providers('RFC-395 V2-X publications and ordered archive parts', (h) => {
  test('each publication state preserves its recovery fields and shares the original object location', async () => {
    await h.install()
    await seedContentParents(h)
    const states = ['pending', 'ready', 'releasing', 'released'] as const
    await h.write(
      'hosted_object_publications',
      states.map((state, index) =>
        contentFixture('hosted_object_publications', {
          id: state,
          logical_key: state,
          state,
          source_sealed: state === 'pending' ? 'opaque-source' : null,
          released_at: index > 1 ? 444 : null,
          epoch: 7,
          attempt: 'original-attempt',
          attempts: 9,
          next_attempt_at: 888,
        }),
      ),
    )
    await h.write('hosted_object_publications', [
      contentFixture('hosted_object_publications', {
        id: 'unuploaded',
        logical_key: 'unuploaded',
        state: 'pending',
        object_id: null,
        source_sealed: 'sealed',
      }),
      contentFixture('hosted_object_publications', {
        id: 'already-unpinned',
        logical_key: 'already-unpinned',
        state: 'released',
        object_id: null,
        released_at: 555,
      }),
    ])
    await h.write('hosted_task_artifacts', [contentFixture('hosted_task_artifacts')])
    const input = await h.input([conversion, contentLookups()], {
      content: new FakeContentInventory(),
    })
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).blocks).toEqual([])
      expect(sink.rows('content_objects')).toHaveLength(1)
      const object = sink.rows('content_objects')[0]!
      expect(JSON.parse(object.location_json as string)).toEqual({
        codec: 'hosted-object-id',
        value: objectId,
      })
      for (const state of states)
        expect(sink.rows('content_publications').find((row) => row.id === state)).toMatchObject({
          state,
          epoch: 7,
          attempt: 'original-attempt',
          attempts: 9,
          next_attempt_at: 888,
          content_id: object.content_id,
        })
      expect(
        sink.rows('content_publications').find((row) => row.id === 'unuploaded')!.content_id,
      ).toBeNull()
      expect(
        sink.rows('content_publications').find((row) => row.id === 'already-unpinned')!.content_id,
      ).toBeNull()
      expect(
        [...sink.units.values()]
          .flatMap((unit) => unit.artifacts)
          .find((receipt) => receipt.sourceKey.includes('ready'))!.publication,
      ).toBe('existing-ready')
      expect(sink.rows('content_bytes')).toEqual([])
    } finally {
      await input.source.close()
    }
  })
  test('a shared object with conflicting original digest blocks', async () => {
    await h.install()
    await seedContentParents(h)
    await h.write('hosted_object_publications', [contentFixture('hosted_object_publications')])
    await h.write('hosted_task_artifacts', [
      contentFixture('hosted_task_artifacts', { digest: '0'.repeat(64) }),
    ])
    const input = await h.input([conversion, contentLookups()], {
      content: new FakeContentInventory(),
    })
    try {
      const result = await runConversion(input, new V2MemorySink())
      expect(
        result.blocks.filter((block) => block.code === 'v2-content-object-conflict'),
      ).toHaveLength(2)
    } finally {
      await input.source.close()
    }
  })
  test('hosted review receipts keep staged/final paths and the same physical object', async () => {
    await h.install()
    await seedContentParents(h)
    const receipt = {
      kind: 'cs-review-object-v2',
      operationId: 'gate',
      artifactKey: 'artifact',
      stagedPath: 'runs/.staging/doc.md',
      finalPath: 'runs/task/review/doc.md',
      key: `gate/${sha256Hex('artifact')}`,
      object: { id: objectId, sha256: contentDigest, size: contentBytes.length },
    }
    await h.write('collaboration_gate_artifacts', [
      contentFixture('collaboration_gate_artifacts', { receipt_json: JSON.stringify(receipt) }),
    ])
    const input = await h.input([conversion, contentLookups()], {
      content: new FakeContentInventory(),
    })
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).blocks).toEqual([])
      expect(sink.rows('content_objects')).toHaveLength(1)
      const row = sink.rows('collaboration_gate_artifacts')[0]!
      expect(row.receipt_json).toBe(JSON.stringify(receipt))
      expect(JSON.parse(row.staged_content_ref_json as string).location.value).toEqual({
        reference: receipt.stagedPath,
        objectId,
      })
      expect(
        JSON.parse(sink.rows('doc_versions')[0]!.content_ref_json as string).location.value,
      ).toEqual({ reference: receipt.finalPath, objectId })
    } finally {
      await input.source.close()
    }
  })
  test('part order, append ordinal, empty files and directories survive without new publication', async () => {
    await h.install()
    await seedContentParents(h)
    const parts = ['original', 'append', 'append-again'].map((key) => ({
      key,
      id: objectId,
      sha256: contentDigest,
      size: contentBytes.length,
    }))
    await h.write('hosted_task_archive_entries', [
      contentFixture('hosted_task_archive_entries', { parts_json: JSON.stringify(parts) }),
      contentFixture('hosted_task_archive_entries', { path: 'empty', parts_json: '[]' }),
      contentFixture('hosted_task_archive_entries', {
        path: 'directory',
        kind: 'directory',
        parts_json: '[]',
      }),
    ])
    const input = await h.input([conversion, contentLookups()], {
      content: new FakeContentInventory(),
    })
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).blocks).toEqual([])
      expect(sink.rows('hosted_task_archive_entries')).toHaveLength(3)
      expect(
        sink.rows('hosted_task_archive_entry_parts').map((row) => [row.ordinal, row.part_key]),
      ).toEqual([
        [0, 'original'],
        [1, 'append'],
        [2, 'append-again'],
      ])
      expect(sink.rows('content_objects')).toHaveLength(1)
      expect(sink.rows('content_publications')).toEqual([])
    } finally {
      await input.source.close()
    }
  })
  test('directory with parts and malformed part objects block instead of dropping bytes', async () => {
    await h.install()
    await seedContentParents(h)
    await h.write('hosted_task_archive_entries', [
      contentFixture('hosted_task_archive_entries', { kind: 'directory' }),
      contentFixture('hosted_task_archive_entries', { path: 'bad', parts_json: '[{"key":"x"}]' }),
    ])
    const input = await h.input([conversion, contentLookups()], {
      content: new FakeContentInventory(),
    })
    try {
      const sink = new V2MemorySink()
      expect(
        (await runConversion(input, sink)).blocks.filter(
          (block) => block.sourceTable === 'hosted_task_archive_entries',
        ),
      ).toHaveLength(2)
      expect(sink.rows('hosted_task_archive_entries')).toEqual([])
    } finally {
      await input.source.close()
    }
  })
})
