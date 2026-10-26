import { expect, test } from 'bun:test'
import { describeV2Providers, fixtureLookup } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { coreBFixture, writeFrozenFixture } from './rfc395-v2-generic-fixtures.test'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import {
  genericIdentities,
  identityHighWaterRecord,
  identityMaxima,
} from '@/platform/persistence/migration/conversion/generic/identityHighWater'
import { referenceLookups } from '@/platform/persistence/migration/conversion/generic/references'
import {
  columnLookup,
  idSetLookup,
  orderLookupBuilders,
} from '@/platform/persistence/migration/conversion/lookups'
import type { RuleContext } from '@/platform/persistence/migration/conversion/rule'

test('generic builder ownership includes exactly the agreed cross-package keys and rejects duplicates', () => {
  for (const builder of [
    idSetLookup('users', 'id'),
    columnLookup('workflows', ['id'], ['builtin']),
    columnLookup('node_runs', ['id'], ['continuation_slot_key']),
    idSetLookup('memories', 'id'),
    idSetLookup('repo_groups', 'id'),
    idSetLookup('development_missions', 'id'),
    idSetLookup('skills', 'id'),
    idSetLookup('agents', 'id'),
    idSetLookup('mcps', 'id'),
    idSetLookup('plugins', 'id'),
    columnLookup('node_runs', ['id'], ['task_id']),
    columnLookup('doc_versions', ['id'], ['task_id']),
    columnLookup('collaboration_gate_operations', ['id'], ['task_id']),
    columnLookup(
      'code_work_items',
      ['id'],
      ['status', 'pending_generation', 'publishing_epoch', 'pending_revision'],
    ),
    columnLookup('code_work_rounds', ['id'], ['outcome', 'ended_at']),
  ])
    expect(referenceLookups.filter((entry) => entry.key.id === builder.key.id)).toHaveLength(1)
  expect(referenceLookups).toHaveLength(15)
  expect(() => orderLookupBuilders([...referenceLookups, idSetLookup('users', 'id')])).toThrow(
    'v2-duplicate-lookup',
  )
})

describeV2Providers('RFC-395 V2 seed presence and identity high water', (h) => {
  test('both required seeds are checked in empty units and never synthesized', async () => {
    await h.install()
    await h.sourceHarness.native.execute(
      `DELETE FROM ${h.sourceHarness.table('auth_login_policy')}`,
    )
    await h.sourceHarness.native.execute(`DELETE FROM ${h.sourceHarness.table('users')}`)
    const input = await h.input([coreBFixture(['users', 'auth_login_policy'])])
    try {
      const sink = new V2MemorySink()
      const summary = await runConversion(input, sink)
      expect(summary.status).toBe('blocked')
      expect(
        summary.blocks
          .filter((block) => block.code === 'v2-required-seed-missing')
          .map((block) => block.sourceTable)
          .sort(),
      ).toEqual(['auth_login_policy', 'users'])
      expect(sink.rows('users')).toEqual([])
      expect(sink.rows('auth_login_policy')).toEqual([])
      expect(summary.tableReceipts.every((receipt) => receipt.rowsRead === 0)).toBe(true)
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('existing seeds retain non-default configuration, attribution and timestamps', async () => {
    await h.install()
    await h.sourceHarness.native.execute(
      `DELETE FROM ${h.sourceHarness.table('auth_login_policy')}`,
    )
    await h.sourceHarness.native.execute(`DELETE FROM ${h.sourceHarness.table('users')}`)
    await writeFrozenFixture(h, 'users', {
      id: '__system__',
      username: '__system__',
      display_name: 'Original System',
      role: 'manager',
      status: 'disabled',
      git_name: 'custom',
      created_at: 7,
      updated_at: 99,
    })
    await h.write('auth_login_policy', [
      {
        id: 'global',
        password_login_enabled: false,
        oidc_default_role: 'user',
        bootstrap_completed_at: 44,
        updated_at: 101,
      },
    ])
    const input = await h.input([coreBFixture(['users', 'auth_login_policy'])])
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).status).toBe('converted')
      expect(sink.rows('users')[0]).toMatchObject({
        display_name: 'Original System',
        role: 'manager',
        status: 'disabled',
        git_name: 'custom',
        created_at: 7,
        updated_at: 99,
      })
      expect(sink.rows('auth_login_policy')[0]).toMatchObject({
        password_login_enabled: false,
        oidc_default_role: 'user',
        bootstrap_completed_at: 44,
        updated_at: 101,
      })
      expect([...sink.units.values()].flatMap((unit) => unit.dispositions)).toEqual([])
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('five identities take max(original sequence, rows), retain empty high water and warn for unrecorded artifacts', async () => {
    await h.install()
    const contribution = coreBFixture(
      genericIdentities.map((identity) => identity.table),
      [
        fixtureLookup(
          identityMaxima.key,
          genericIdentities.map(({ table }, index) => [
            table,
            { maximum: index === 4 ? null : String(10 + index) },
          ]),
        ),
      ],
    )
    const input = await h.input([contribution])
    try {
      for (const identity of genericIdentities) {
        const sequence = {
          name: identity.table,
          table: identity.table,
          column: null,
          value: '9007199254740993',
          isCalled: true,
          increment: '1',
        }
        const ctx = {
          preflight: { ...input.preflight, identityHighWater: [{ ...sequence, value: '2' }] },
          preUpgradePreflight: { ...input.preflight, identityHighWater: [sequence] },
        } satisfies Pick<RuleContext, 'preflight' | 'preUpgradePreflight'>
        expect(identityHighWaterRecord(identity.table, identity.column, '17', ctx)).toMatchObject({
          value: '9007199254740993',
          basis: 'both',
        })
        expect(identityHighWaterRecord(identity.table, identity.column, null, ctx)).toMatchObject({
          value: '9007199254740993',
          basis: 'sequence',
        })
        expect(
          identityHighWaterRecord(identity.table, identity.column, '9007199254740994', ctx).value,
        ).toBe('9007199254740994')
        const artifact = {
          preflight: {
            ...input.preflight,
            identityEvidence: 'not-recorded-by-epoch1-artifact',
            identityHighWater: [],
          },
        } satisfies Pick<RuleContext, 'preflight'>
        expect(
          identityHighWaterRecord(identity.table, identity.column, '17', artifact),
        ).toMatchObject({
          value: '17',
          basis: 'max-row',
          warning: 'source-sequence-not-recorded; maximum-observed-only',
        })
        expect(identityHighWaterRecord(identity.table, identity.column, null, artifact).value).toBe(
          '0',
        )
      }
      const sink = new V2MemorySink()
      const summary = await runConversion(input, sink)
      for (const [index, identity] of genericIdentities.entries())
        expect(summary.records).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: 'identity-high-water',
              table: identity.table,
              column: 'id',
              value:
                index === 4
                  ? (input.preflight.identityHighWater.find(
                      (entry) => entry.table === identity.table,
                    )?.value ?? '0')
                  : String(10 + index),
            }),
          ]),
        )
      expect(
        summary.records.some(
          (record) =>
            record.kind === 'identity-high-water' && record.table === 'node_run_seq_allocations',
        ),
      ).toBe(false)
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('maximum lookup scans all source chunks, including unsafe integers blocked by target codecs', async () => {
    await h.install()
    await writeFrozenFixture(h, 'memory_distill_jobs', { id: 'distill-job' })
    for (const id of [1, 2, 9007199254740993n])
      await writeFrozenFixture(h, 'memory_distill_events', {
        id,
        distill_job_id: 'distill-job',
        payload: ' { raw text } ',
      })
    const input = await h.input([coreBFixture(['memory_distill_events'])], { chunkLimit: 1 })
    try {
      const sink = new V2MemorySink()
      const summary = await runConversion(input, sink)
      expect(summary.blocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'v2-target-codec',
            sourceTable: 'memory_distill_events',
            missingFields: ['id'],
          }),
        ]),
      )
      expect(
        sink
          .rows('memory_distill_events')
          .map((row) => row.id)
          .sort(),
      ).toEqual([1, 2])
      expect(
        summary.records
          .filter((record) => record.kind === 'identity-high-water')
          .every(
            (record) =>
              record.kind === 'identity-high-water' && record.value === '9007199254740993',
          ),
      ).toBe(true)
      expect(summary.tableReceipts[0]).toMatchObject({
        rowsRead: 3,
        counts: { preserved: 2, converted: 0, archived: 0, blocked: 1 },
      })
    } finally {
      await input.source.close()
    }
  }, 180_000)
})
