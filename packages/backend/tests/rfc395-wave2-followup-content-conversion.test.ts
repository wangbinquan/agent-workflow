// RFC-395 C-F2: conversion must preserve the committed reader's staged fallback
// without admitting missing or mismatched bytes, or rejecting a completed rename.
// FX-2 checks document outcomes independently of the artifact's own staged slot.
import { setDefaultTimeout, expect, test } from 'bun:test'
import { conversion } from '@/platform/content/migration'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { parameters } from '@/platform/persistence/schema/history/connection'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import {
  contentFixture,
  contentLookups,
  contentTask,
  seedContentParents,
  FakeContentInventory,
  contentBytes,
  contentDigest,
} from './helpers/rfc395V2/contentFixtures'

// Slowest case took 3.16 s on CI run 40433510287 including hooks; allow 20 s.
setDefaultTimeout(20_000)

const final = { codec: 'review-body', value: 'runs/task/review/doc.md' }
const staged = { codec: 'review-body', value: 'runs/.staging/doc.md' }
const missing = {
  state: 'absent' as const,
  cause: 'originally-absent' as const,
  evidence: 'absent in the frozen legacy input',
}

describeV2Providers('RFC-395 committed review conversion fallback', (h) => {
  async function seed(state: 'consumed' | 'finalized', operationState: string) {
    await h.install()
    await seedContentParents(h)
    await h.write('collaboration_gate_artifacts', [
      contentFixture('collaboration_gate_artifacts', { state }),
    ])
    await h.sourceHarness.native.execute(
      `UPDATE ${h.sourceHarness.table('collaboration_gate_operations')} SET state = ${parameters(h.sourceHarness.native, 1)} WHERE id = 'gate'`,
      [operationState],
    )
  }

  for (const [state, operationState] of [
    ['consumed', 'committed'],
    ['finalized', 'completed'],
  ] as const) {
    test(`${state}: verified staged bytes admit active content and preserve final references`, async () => {
      await seed(state, operationState)
      const input = await h.input(
        [conversion, contentLookups([contentTask('executable', 'awaiting_review')])],
        { content: new FakeContentInventory().set(final, missing).set(staged, contentBytes) },
      )
      try {
        const sink = new V2MemorySink()
        expect((await runConversion(input, sink)).blocks).toEqual([])
        expect(sink.rows('collaboration_gate_artifacts')).toHaveLength(1)
        expect(sink.rows('doc_versions')).toHaveLength(1)
        const artifact = sink.rows('collaboration_gate_artifacts')[0]!
        const doc = sink.rows('doc_versions')[0]!
        expect(artifact.final_content_key).toBe(final.value)
        expect(JSON.parse(artifact.content_ref_json as string).location).toEqual(final)
        expect(JSON.parse(artifact.staged_content_ref_json as string)).toMatchObject({
          location: staged,
          sha256: contentDigest,
          size: contentBytes.byteLength,
        })
        expect(JSON.parse(doc.content_ref_json as string).location).toEqual(final)
        const units = [...sink.units.values()]
        expect(
          units.flatMap((unit) => unit.dispositions).some((d) => d.kind === 'history-only'),
        ).toBe(false)
        for (const [sourceTable, sourceColumn] of [
          ['doc_versions', 'body_path'],
          ['collaboration_gate_artifacts', 'final_path'],
        ])
          expect(units.flatMap((unit) => unit.artifacts)).toContainEqual(
            expect.objectContaining({
              sourceTable,
              sourceColumn,
              originalReference: final.value,
              missing: { state: 'originally-absent', evidence: missing.evidence },
            }),
          )
        const decisions = units
          .flatMap((unit) => unit.records)
          .filter(
            (record) => record.kind === 'decision' && record.code === 'v2-content-staged-fallback',
          )
        expect(decisions).toHaveLength(2)
        for (const column of ['body_path', 'final_path'])
          expect(decisions).toContainEqual(
            expect.objectContaining({
              kind: 'decision',
              payload: expect.objectContaining({
                column,
                originalReference: final.value,
                sha256: contentDigest,
                size: contentBytes.byteLength,
              }),
            }),
          )
      } finally {
        await input.source.close()
      }
    })

    test(`${state}: final-only bytes still convert after the legacy rename`, async () => {
      await seed(state, operationState)
      const input = await h.input(
        [conversion, contentLookups([contentTask('executable', 'awaiting_review')])],
        { content: new FakeContentInventory().set(staged, missing) },
      )
      try {
        const sink = new V2MemorySink()
        expect((await runConversion(input, sink)).blocks).toEqual([])
        expect(sink.rows('collaboration_gate_artifacts')).toHaveLength(1)
        expect(sink.rows('doc_versions')).toHaveLength(1)
        const units = [...sink.units.values()]
        expect(
          units
            .flatMap((unit) => unit.records)
            .some(
              (record) =>
                record.kind === 'decision' && record.code === 'v2-content-staged-fallback',
            ),
        ).toBe(false)
        expect(
          units.flatMap((unit) => unit.dispositions).some((d) => d.kind === 'history-only'),
        ).toBe(false)
        expect(units.flatMap((unit) => unit.artifacts)).toContainEqual(
          expect.objectContaining({
            sourceTable: 'collaboration_gate_artifacts',
            sourceColumn: 'staged_path',
            missing: { state: 'originally-absent', evidence: missing.evidence },
          }),
        )
      } finally {
        await input.source.close()
      }
    })
  }

  for (const [failure, code] of [
    ['both-missing', 'v2-content-required-missing'],
    ['bad-staged', 'v2-content-bytes-unprovable'],
    ['bad-final', 'v2-content-bytes-unprovable'],
    ['final-lost-at-freeze', 'v2-content-lost-at-freeze'],
    ['staged-lost-at-freeze', 'v2-content-lost-at-freeze'],
    ['uncommitted', 'v2-content-required-missing'],
  ] as const) {
    test(`${failure}: fallback preserves the existing content failure`, async () => {
      await seed('consumed', failure === 'uncommitted' ? 'prepared' : 'committed')
      const inventory = new FakeContentInventory().set(final, missing)
      const badBytes = new Uint8Array([1, 2, 3])
      if (failure === 'both-missing') inventory.set(staged, missing)
      if (failure === 'bad-staged') inventory.set(staged, badBytes)
      if (failure === 'bad-final') inventory.set(final, badBytes)
      if (failure === 'final-lost-at-freeze')
        inventory.set(final, { ...missing, cause: 'missing-at-freeze' })
      if (failure === 'staged-lost-at-freeze')
        inventory.set(staged, { ...missing, cause: 'missing-at-freeze' })
      const input = await h.input(
        [conversion, contentLookups([contentTask('executable', 'awaiting_review')])],
        { content: inventory },
      )
      try {
        const sink = new V2MemorySink()
        const { blocks } = await runConversion(input, sink)
        expect(blocks).toContainEqual(
          expect.objectContaining({ code, sourceTable: 'collaboration_gate_artifacts' }),
        )
        expect(sink.rows('collaboration_gate_artifacts')).toEqual([])
        const documentBlocks = blocks.filter((block) => block.sourceTable === 'doc_versions')
        if (failure === 'bad-final') {
          // Local document paths have no declared digest; only the artifact has one.
          expect(documentBlocks).toEqual([])
          expect(sink.rows('doc_versions')).toHaveLength(1)
          expect(
            JSON.parse(sink.rows('doc_versions')[0]!.content_ref_json as string),
          ).toMatchObject({
            location: final,
            sha256: bytesDigest(badBytes).slice(7),
            size: badBytes.byteLength,
          })
        } else {
          expect(documentBlocks).toContainEqual(expect.objectContaining({ code }))
          expect(sink.rows('doc_versions')).toEqual([])
        }
        expect(
          [...sink.units.values()]
            .flatMap((unit) => unit.records)
            .some(
              (record) =>
                record.kind === 'decision' && record.code === 'v2-content-staged-fallback',
            ),
        ).toBe(false)
      } finally {
        await input.source.close()
      }
    })
  }
})
