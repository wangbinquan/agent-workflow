import { expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { frozenValues, historyLookups } from './helpers/rfc395V2/contentFixtures'
import { historyRule } from '@/platform/persistence/migration/archives/codeHistory'
import { unfinishedWorkPredicates } from '@/platform/persistence/migration/archives/unfinishedWork'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { historyAdoptionsLookup } from '@/platform/persistence/migration/archives/adoptions'
import { columnLookup, idSetLookup } from '@/platform/persistence/migration/conversion/lookups'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'

// X-1/X-2: delivery progress and open findings are history, not work predicates.
const completed: Readonly<Record<string, DecodedSourceRow>> = {
  code_ai_attempts: { id: 'attempt', status: 'validated', ended_at: 456 },
  code_findings: { id: 'finding', lifecycle: 'active', closed_at: null, resolved_at: null },
  code_round_stages: { id: 'stage', status: 'done', ended_at: 456 },
  code_trigger_deliveries: { id: 'delivery', outcome: 'ok', step: 'round', round_id: 'round' },
  code_work_items: { id: 'work', status: 'settled' },
  code_work_rounds: { id: 'round', outcome: 'published', ended_at: 456 },
  legacy_code_work_item_links: {
    id: 'link',
    mission_id: 'mission',
    legacy_work_item_id: 'work',
    legacy_round_id: 'round',
    cutover_receipt_json:
      ' { "observedState": "opened", "headSha": "head", "targetBranch": "main", "adoptedAt": 123 } ',
  },
}
const unfinished: Readonly<Record<string, readonly DecodedSourceRow[]>> = {
  code_ai_attempts: [{ status: 'claimed' }, { status: 'running' }, { ended_at: null }],
  code_round_stages: [{ status: 'pending' }, { status: 'running' }, { ended_at: null }],
  code_work_items: [
    ...['queued', 'running', 'awaiting', 'superseding', 'handed_off', 'closing'].map((status) => ({
      status,
    })),
    { pending_generation: 1 },
    { publishing_epoch: 1 },
    { pending_revision: 'head' },
  ],
  code_work_rounds: [{ outcome: null }, { outcome: 'awaiting' }, { ended_at: null }],
  legacy_code_work_item_links: [
    { cutover_receipt_json: '{}' },
    {
      cutover_receipt_json:
        '{"observedState":["opened"],"headSha":null,"targetBranch":null,"adoptedAt":123}',
    },
    {
      cutover_receipt_json:
        '{"observedState":"opened","headSha":42,"targetBranch":null,"adoptedAt":123}',
    },
    { cutover_receipt_json: '{"observedState":"opened","headSha":null,"adoptedAt":123}' },
    {
      cutover_receipt_json:
        '{"observedState":"opened","headSha":null,"targetBranch":null,"adoptedAt":1.5}',
    },
    { legacy_work_item_id: 'missing' },
    { legacy_round_id: 'missing' },
  ],
}
describeV2Providers('RFC-395 V2-X unfinished code work', (h) => {
  for (const table of Object.keys(unfinished)) {
    test(`${table}: completed facts archive with writer provenance; every unfinished arm blocks`, async () => {
      await h.install()
      if (table === 'legacy_code_work_item_links')
        await h.write('development_missions', [
          frozenValues('development_missions', {
            id: 'mission',
            status: 'watching',
            source_kind: 'direct',
            delivery_kind: 'adopt-merge-request',
          }),
        ])
      await h.write(table, [frozenValues(table, completed[table]!)])
      const rules = { rules: [historyRule(table)], lookups: [], validators: [] }
      const goodInput = await h.input([rules, historyLookups()])
      try {
        const sink = new V2MemorySink()
        expect((await runConversion(goodInput, sink)).blocks).toEqual([])
        expect(sink.rows('code_history_id_index')).toHaveLength(1)
      } finally {
        await goodInput.source.close()
      }
      // Every fixture is a new original ID, written by the frozen raw writer.
      for (const [index, patch] of unfinished[table]!.entries())
        await h.write(table, [
          frozenValues(table, {
            ...completed[table],
            ...patch,
            id: `unfinished-${index}`,
            ...(table === 'code_ai_attempts' ? { round_id: `round-${index}` } : {}),
            ...(table === 'code_findings' ? { fingerprint: `finding-${index}` } : {}),
            ...(table === 'code_round_stages' ? { stage_seq: index + 1000 } : {}),
            ...(table === 'code_work_items' ? { anchor_id: `anchor-${index}` } : {}),
            ...(table === 'code_work_rounds' ? { round_seq: index + 1000 } : {}),
          }),
        ])
      const input = await h.input([rules, historyLookups()])
      try {
        const sink = new V2MemorySink()
        const result = await runConversion(input, sink)
        const blocks = result.blocks.filter((block) => block.code === 'v2-code-history-unfinished')
        expect(blocks).toHaveLength(unfinished[table]!.length)
        for (const block of blocks)
          expect(block.detail).toMatchObject({
            predicate:
              unfinishedWorkPredicates[table as keyof typeof unfinishedWorkPredicates].predicate,
            source: expect.any(String),
            original: expect.any(Object),
          })
        expect(sink.rows('code_history_archives')).toEqual([])
        expect(sink.rows('code_history_id_index')).toEqual([])
      } finally {
        await input.source.close()
      }
    })
  }
  test('X-1/X-2 all writer delivery endpoints and open findings archive without a liveness predicate', async () => {
    await h.install()
    const deliveries: readonly DecodedSourceRow[] = [
      { step: 'received', outcome: 'ok' },
      { step: 'matched', outcome: 'ok' },
      { step: 'routed', outcome: 'ok' },
      { step: 'matched', outcome: 'dropped' },
      { step: 'routed', outcome: 'failed' },
      { step: 'routed', outcome: 'dropped' },
      { step: 'round', outcome: 'ok', round_id: 'finished-round' },
      { step: 'round', outcome: 'ok', round_id: null },
    ]
    await h.write(
      'code_trigger_deliveries',
      deliveries.map((value, index) =>
        frozenValues('code_trigger_deliveries', { id: `delivery-${index}`, ...value }),
      ),
    )
    await h.write(
      'code_findings',
      ['active', 'reappeared', 'disappeared'].map((lifecycle, index) =>
        frozenValues('code_findings', {
          id: `finding-${index}`,
          fingerprint: `finding-${index}`,
          lifecycle,
          closed_at: null,
          resolved_at: null,
        }),
      ),
    )
    const input = await h.input([
      {
        rules: [historyRule('code_trigger_deliveries'), historyRule('code_findings')],
        lookups: [],
        validators: [],
      },
    ])
    try {
      const sink = new V2MemorySink()
      const result = await runConversion(input, sink)
      expect(result.blocks).toEqual([])
      expect(sink.rows('code_history_id_index')).toHaveLength(11)
      const decisions = [...sink.units.values()].flatMap((unit) => unit.dispositions)
      expect(
        decisions.filter(
          (d) =>
            d.decision?.code === 'v2-code-delivery-history' &&
            (d.decision.detail as { dispatch?: string }).dispatch === 'interrupted',
        ),
      ).toHaveLength(3)
      expect(result.tableReceipts.every((receipt) => receipt.counts.blocked === 0)).toBe(true)
    } finally {
      await input.source.close()
    }
  })
  for (const observedState of ['opened', 'merged', 'closed']) {
    test(`X-3 ${observedState}: nullable observation fields hand over the linked awaiting item and round`, async () => {
      await h.install()
      await h.write('development_missions', [
        frozenValues('development_missions', { id: 'mission' }),
      ])
      await h.write('code_work_items', [
        frozenValues('code_work_items', { id: 'work', status: 'awaiting', pending_generation: 7 }),
      ])
      await h.write('code_work_rounds', [
        frozenValues('code_work_rounds', {
          id: 'round',
          work_item_id: 'work',
          outcome: 'awaiting',
          ended_at: 123,
        }),
      ])
      const receipt = JSON.stringify({
        observedState,
        headSha: null,
        targetBranch: null,
        adoptedAt: 123,
      })
      await h.write('legacy_code_work_item_links', [
        frozenValues('legacy_code_work_item_links', {
          ...completed.legacy_code_work_item_links,
          cutover_receipt_json: receipt,
        }),
      ])
      const input = await h.input([
        {
          rules: ['code_work_items', 'code_work_rounds', 'legacy_code_work_item_links'].map(
            (table) => historyRule(table),
          ),
          lookups: [
            historyAdoptionsLookup,
            idSetLookup('development_missions', 'id'),
            columnLookup(
              'code_work_items',
              ['id'],
              ['status', 'pending_generation', 'publishing_epoch', 'pending_revision'],
            ),
            columnLookup('code_work_rounds', ['id'], ['outcome', 'ended_at']),
          ],
          validators: [],
        },
      ])
      try {
        const sink = new V2MemorySink()
        expect((await runConversion(input, sink)).blocks).toEqual([])
        expect(sink.rows('code_history_id_index')).toHaveLength(3)
        const decisions = [...sink.units.values()].flatMap((unit) => unit.dispositions)
        expect(decisions).toHaveLength(3)
        for (const decision of decisions)
          expect(decision).toMatchObject({
            class: 'archived',
            decision: {
              code: 'v2-code-history-adopted',
              detail: { adoptions: [{ missionId: 'mission', receipt }] },
            },
          })
        const original = await input.source.readChunk('code_work_items', null, 1)
        expect(original.decodedRows[0]).toMatchObject({ status: 'awaiting', pending_generation: 7 })
      } finally {
        await input.source.close()
      }
    })
  }
  test('X-3 adoption never covers an unlinked item/round or unfinished stage/attempt', async () => {
    await h.install()
    await h.write('development_missions', [frozenValues('development_missions', { id: 'mission' })])
    await h.write('legacy_code_work_item_links', [
      frozenValues('legacy_code_work_item_links', completed.legacy_code_work_item_links!),
    ])
    await h.write('code_work_items', [
      frozenValues('code_work_items', { id: 'other-work', status: 'running' }),
    ])
    await h.write('code_work_rounds', [
      frozenValues('code_work_rounds', { id: 'other-round', outcome: 'awaiting' }),
    ])
    await h.write('code_ai_attempts', [
      frozenValues('code_ai_attempts', { id: 'attempt', round_id: 'round', status: 'running' }),
    ])
    await h.write('code_round_stages', [
      frozenValues('code_round_stages', { id: 'stage', round_id: 'round', status: 'running' }),
    ])
    const input = await h.input([
      {
        rules: ['code_work_items', 'code_work_rounds', 'code_ai_attempts', 'code_round_stages'].map(
          (table) => historyRule(table),
        ),
        lookups: [],
        validators: [],
      },
      historyLookups(),
    ])
    try {
      const result = await runConversion(input, new V2MemorySink())
      expect(
        result.blocks.filter((block) => block.code === 'v2-code-history-unfinished'),
      ).toHaveLength(4)
    } finally {
      await input.source.close()
    }
  })
  test('X-3 missing mission blocks, but an unfinished linked item/round no longer invalidates the receipt', async () => {
    await h.install()
    await h.write('development_missions', [frozenValues('development_missions', { id: 'mission' })])
    await h.write('legacy_code_work_item_links', [
      frozenValues('legacy_code_work_item_links', completed.legacy_code_work_item_links!),
    ])
    for (const [fixture, blocked] of [
      [historyLookups({ mission: false }), true],
      [
        historyLookups({
          item: {
            status: 'running',
            pending_generation: null,
            publishing_epoch: null,
            pending_revision: null,
          },
        }),
        false,
      ],
      [historyLookups({ round: { outcome: 'awaiting', ended_at: 123 } }), false],
    ] as const) {
      const input = await h.input([
        { rules: [historyRule('legacy_code_work_item_links')], lookups: [], validators: [] },
        fixture,
      ])
      try {
        const result = await runConversion(input, new V2MemorySink())
        if (blocked)
          expect(result.blocks).toContainEqual(
            expect.objectContaining({ code: 'v2-code-history-unfinished' }),
          )
        else expect(result.blocks).toEqual([])
      } finally {
        await input.source.close()
      }
    }
  })
})
