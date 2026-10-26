import { expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import {
  coreBFixture,
  writeFrozenFixture,
  writeTaskFixture,
} from './rfc395-v2-generic-fixtures.test'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'

describeV2Providers('RFC-395 V2 alignment checks and claims', (h) => {
  test('intent event NULL external ids remain distinct and a duplicate across chunks blocks every participant', async () => {
    await h.install()
    await writeFrozenFixture(h, 'intent_sessions', { id: 'session' })
    await writeFrozenFixture(h, 'intent_turns', { id: 'turn', session_id: 'session' })
    for (const id of [1, 2, 3, 4])
      await writeFrozenFixture(h, 'intent_turn_events', {
        id,
        turn_id: 'turn',
        event_seq: id,
        external_event_id: id < 3 ? null : `external-${id}`,
        payload: ' { event raw } ',
      })
    const input = await h.input([coreBFixture(['intent_turn_events'])], { chunkLimit: 1 })
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).status).toBe('converted')
      expect(sink.rows('intent_turn_events')).toHaveLength(4)
      expect([...sink.units.values()].flatMap((unit) => unit.dispositions)).toEqual([])
      const reader = input.source
      for (const column of ['external_event_id', 'event_seq']) {
        const source = {
          ...reader,
          async readChunk(
            table: string,
            after: Parameters<typeof reader.readChunk>[1],
            limit: number,
          ) {
            const chunk = await reader.readChunk(table, after, limit)
            return table === 'intent_turn_events'
              ? {
                  ...chunk,
                  decodedRows: chunk.decodedRows.map((row) =>
                    row.id === 4
                      ? { ...row, [column]: column === 'external_event_id' ? 'external-3' : 3 }
                      : row,
                  ),
                }
              : chunk
          },
        }
        const blocked = new V2MemorySink()
        const summary = await runConversion({ ...input, source }, blocked)
        expect(summary.status).toBe('blocked')
        expect(
          summary.blocks.filter((block) => block.code === 'v2-intent-event-unique'),
        ).toHaveLength(2)
        expect(
          blocked
            .rows('intent_turn_events')
            .map((row) => row.id)
            .sort(),
        ).toEqual([1, 2])
        expect(summary.tableReceipts[0]).toMatchObject({
          counts: { preserved: 2, converted: 0, archived: 0, blocked: 2 },
        })
      }
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('reset-pending without a lease run blocks while valid leases preserve their complete values', async () => {
    await h.install()
    await writeTaskFixture(h)
    await writeFrozenFixture(h, 'runtime_session_leases', {
      protocol: 'opencode',
      session_id: 'lease',
      task_id: 'fixture-task',
      created_node_run_id: 'old-run',
      lease_node_run_id: 'old-run',
      lease_nonce_digest: 'old-nonce',
      leased_at: 77,
      reset_pending: true,
    })
    const input = await h.input([coreBFixture(['runtime_session_leases'])])
    try {
      const expected = (await input.source.readChunk('runtime_session_leases', null, 10))
        .decodedRows
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).status).toBe('converted')
      expect(sink.rows('runtime_session_leases')).toEqual(expected)
      const reader = input.source
      const source = {
        ...reader,
        async readChunk(
          table: string,
          after: Parameters<typeof reader.readChunk>[1],
          limit: number,
        ) {
          const chunk = await reader.readChunk(table, after, limit)
          return table === 'runtime_session_leases'
            ? {
                ...chunk,
                decodedRows: chunk.decodedRows.map((row) => ({
                  ...row,
                  lease_node_run_id: null,
                  lease_nonce_digest: null,
                  leased_at: null,
                })),
              }
            : chunk
        },
      }
      const blocked = new V2MemorySink()
      const summary = await runConversion({ ...input, source }, blocked)
      expect(summary.blocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'v2-lease-reset-without-run',
            missingFields: ['lease_node_run_id'],
          }),
        ]),
      )
      expect(blocked.rows('runtime_session_leases')).toEqual([])
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('append-only user access audit retains every attribution field and JSON byte', async () => {
    await h.install()
    await writeFrozenFixture(h, 'user_access_audit', {
      id: 'audit',
      target_user_id: 'user',
      actor_user_id: null,
      actor_kind: 'system',
      operation_id: 'original-op',
      correlation_id: '',
      before_role: 'guest',
      after_role: 'user',
      added_permissions_json: ' [ { "z": 2, "a":1 } ]\n',
      removed_permissions_json: ' [] ',
      access_revision: 9,
      created_at: 33,
    })
    const input = await h.input([coreBFixture(['user_access_audit'])])
    try {
      const original = (await input.source.readChunk('user_access_audit', null, 10)).decodedRows
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).status).toBe('converted')
      expect(sink.rows('user_access_audit')).toEqual(original)
      expect([...sink.units.values()].flatMap((unit) => unit.dispositions)).toEqual([])
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('active claims are recorded without rewriting values or introducing a drain block', async () => {
    await h.install()
    await writeTaskFixture(h)
    await writeFrozenFixture(h, 'task_execution_owners', {
      task_id: 'fixture-task',
      owner_id: 'old-owner',
      daemon_generation: 'old-generation',
      state: 'claimed',
      epoch: 19,
      lease_until: 900,
      revision: 7,
      last_heartbeat_at: 12,
      updated_at: 12,
    })
    await writeFrozenFixture(h, 'runtime_session_leases', {
      protocol: 'opencode',
      session_id: 'old-session',
      task_id: 'fixture-task',
      created_node_run_id: 'old-run',
      lease_node_run_id: 'old-run',
      lease_nonce_digest: 'old-nonce',
      leased_at: 12,
      reset_pending: false,
    })
    await writeFrozenFixture(h, 'development_missions', { id: 'mission' })
    await writeFrozenFixture(h, 'development_mr_claims', {
      id: 'mr-claim',
      mission_id: 'mission',
      state: 'active',
      epoch: 29,
    })
    await writeFrozenFixture(h, 'development_mr_claims', {
      id: 'released-claim',
      mission_id: 'mission',
      state: 'released',
      released_at: 13,
    })
    await writeFrozenFixture(h, 'runtime_session_leases', {
      protocol: 'opencode',
      session_id: 'idle-session',
      task_id: 'fixture-task',
      created_node_run_id: 'old-run',
      lease_node_run_id: null,
      lease_nonce_digest: null,
      leased_at: null,
      reset_pending: false,
    })
    const tables = ['task_execution_owners', 'runtime_session_leases', 'development_mr_claims']
    const input = await h.input([coreBFixture(tables)])
    try {
      const originals = new Map(
        await Promise.all(
          tables.map(
            async (table) =>
              [table, (await input.source.readChunk(table, null, 10)).decodedRows] as const,
          ),
        ),
      )
      const sink = new V2MemorySink()
      const summary = await runConversion(input, sink)
      expect(summary.status).toBe('converted')
      expect(summary.blocks).toEqual([])
      for (const [table, rows] of originals) {
        expect(sink.rows(table)).toHaveLength(rows.length)
        expect(sink.rows(table)).toEqual(expect.arrayContaining(rows))
      }
      const claims = summary.records.filter((record) => record.kind === 'source-metadata')
      expect(claims).toHaveLength(3)
      for (const table of tables)
        expect(claims).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              table,
              payload: expect.objectContaining({
                kind: 'active-claim',
                sourcePhase: 'current',
                values: expect.any(Object),
              }),
            }),
          ]),
        )
      expect([...sink.units.values()].flatMap((unit) => unit.dispositions)).toEqual([])
      // D19 acceptance: core must fold these records into table receipts (contract request in B report).
      for (const table of tables)
        expect(
          summary.tableReceipts.find((receipt) => receipt.sourceTable === table),
        ).toMatchObject({
          activeClaims: [
            expect.objectContaining({ sourceKey: expect.any(String), values: expect.any(Object) }),
          ],
        })
    } finally {
      await input.source.close()
    }
  }, 180_000)
})
