import { intentApplyArtifactCodecs } from '@/modules/intent/infrastructure/intentApplyArtifactCodec'
import { resourcePackageArtifactCodecs } from '@/modules/resource-catalog/infrastructure/resourcePackageArtifactCodec'
import { decodeStagedValue } from '@/platform/persistence/migration/conversion/staging'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import { expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { convertFixtures, readFixtureRows } from './helpers/rfc395V2/collabFixtures'
import { applyJournalRule } from '@/modules/intent/infrastructure/migration/applyJournalRule'
import { bundleAppliesRule } from '@/modules/resource-catalog/infrastructure/migration/bundleAppliesRule'

describeV2Providers('RFC-395 V2-C apply journal profiles', (h) => {
  test('D17 re-encodes readable rows, archives every source byte and preserves all four states and idempotency domains', async () => {
    await h.install()
    await h.write('intent_sessions', [
      { id: 'session', owner_user_id: 'u', created_at: 1, updated_at: 1 },
    ])
    const shapes = [
      ' [ ]\n',
      '{ "scene":"intent", "version":2, "artifacts":[] }\n',
      '{"version":1,"artifacts":[]}',
      'null',
    ]
    const states = ['prepared', 'applying', 'committed', 'failed']
    for (const [i, state] of states.entries()) {
      const common = {
        id: `j-${i}`,
        state,
        prepared_artifacts_json: shapes[i]!,
        receipt_json: state === 'committed' ? `{ "journalId":"j-${i}", "applied":[] }\n` : null,
        created_at: 10,
        updated_at: 20,
      }
      await h.write('intent_apply_journal', [
        {
          ...common,
          session_id: 'session',
          client_mutation_id: `key-${i}`,
          draft_id: 'draft',
          draft_hash: 'hash',
        },
      ])
      await h.write('resource_bundle_applies', [
        {
          ...common,
          prepared_artifacts_json:
            i === 1
              ? '{ "scene":"resource-package", "version":1, "artifacts":[] }\n'
              : i === 2
                ? ' []\n'
                : shapes[i]!,
          scope: 'scope',
          key: `key-${i}`,
          actor_user_id: 'u',
        },
      ])
    }
    const source = [
      ...(await readFixtureRows(h, 'intent_apply_journal')),
      ...(await readFixtureRows(h, 'resource_bundle_applies')),
    ]
    const { summary, sink, units, dispositions } = await convertFixtures(h, [
      { rules: [applyJournalRule, bundleAppliesRule], validators: [], lookups: [] },
    ])
    expect(summary.status).toBe('converted')
    const archived = units
      .flatMap((u) => u.archives)
      .map((a) => decodeStagedValue<SourceRow>(new TextDecoder().decode(a.bytes)))
    expect(archived).toHaveLength(8)
    expect(dispositions).toHaveLength(8)
    for (const row of source) {
      const codecs =
        row.table === 'intent_apply_journal'
          ? intentApplyArtifactCodecs
          : resourcePackageArtifactCodecs
      expect(sink.rows(row.table).find((r) => r.id === row.values.id)).toEqual({
        ...row.values,
        prepared_artifacts_json: codecs.encode([]),
      })
      expect(
        archived.find((r) => r.table === row.table && r.encodedKey === row.encodedKey)?.values,
      ).toEqual(row.values)
      const disposition = dispositions.find(
        (d) => d.sourceTable === row.table && d.sourceKey === row.encodedKey,
      )!
      expect(disposition.class).toBe(row.values.state === 'failed' ? 'archived' : 'converted')
      expect(disposition.targets).toHaveLength(1)
    }
    expect(units.flatMap((u) => u.blocks)).toEqual([])
  }, 180_000)

  test.each(['prepared', 'applying', 'committed'])(
    'D17 blocks unknown %s payloads while preserving source evidence',
    async (state) => {
      await h.install()
      await h.write('intent_sessions', [
        { id: 'session', owner_user_id: 'u', created_at: 1, updated_at: 1 },
      ])
      const invalid = '{"schemaVersion":1,"artifacts":[]}'
      const common = {
        id: 'invalid',
        state,
        prepared_artifacts_json: invalid,
        receipt_json: null,
        created_at: 10,
        updated_at: 20,
      }
      await h.write('intent_apply_journal', [
        {
          ...common,
          session_id: 'session',
          client_mutation_id: 'key',
          draft_id: 'draft',
          draft_hash: 'hash',
        },
      ])
      await h.write('resource_bundle_applies', [
        { ...common, scope: 'scope', key: 'key', actor_user_id: 'u' },
      ])
      const { summary, sink, units } = await convertFixtures(h, [
        { rules: [applyJournalRule, bundleAppliesRule], validators: [], lookups: [] },
      ])
      expect(summary.status).toBe('blocked')
      expect(sink.rows('intent_apply_journal')).toEqual([])
      expect(sink.rows('resource_bundle_applies')).toEqual([])
      expect(
        units
          .flatMap((u) => u.blocks)
          .map((b) => b.code)
          .sort(),
      ).toEqual(['v2-bundle-artifact-undecodable', 'v2-intent-artifact-undecodable'])
      const archived = units
        .flatMap((u) => u.archives)
        .map((a) => decodeStagedValue<SourceRow>(new TextDecoder().decode(a.bytes)))
      expect(archived).toHaveLength(2)
      expect(archived.every((r) => r.values.prepared_artifacts_json === invalid)).toBe(true)
    },
    180_000,
  )
})
