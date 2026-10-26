import { describe, expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { frozenValues, historyLookups, readFrozenRows } from './helpers/rfc395V2/contentFixtures'
import { historyRule } from '@/platform/persistence/migration/archives/codeHistory'
import { unfinishedWorkPredicates } from '@/platform/persistence/migration/archives/unfinishedWork'
import { encodeHistoryPackage } from '@/platform/persistence/migration/archives/package'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { planConversion } from '@/platform/persistence/migration/conversion/plan'
import {
  OperatorDecisionSchema,
  operatorDecisionRowDigest,
  type OperatorDecision,
  type SourceRow,
} from '@/platform/persistence/migration/conversion/types'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import type { DecodedSourceRow } from '@/platform/persistence/migration/sourceTypes'

function acknowledgement(row: SourceRow): OperatorDecision {
  return {
    kind: 'acknowledge-unfinished-legacy-work',
    sourceTable: row.table,
    sourceKey: row.encodedKey,
    sourcePhase: row.phase,
    rowDigest: operatorDecisionRowDigest(row),
    blockCode: 'v2-code-history-unfinished',
    acknowledgedBy: 'migration-operator',
    acknowledgedAt: 123,
    reason: 'Retired writer cannot finish this work; retain its full history.',
  }
}
const unfinished: Readonly<Record<string, DecodedSourceRow>> = {
  code_ai_attempts: { status: 'running', ended_at: null },
  code_round_stages: { status: 'running', ended_at: null },
  code_work_items: { status: 'queued' },
  code_work_rounds: { outcome: null, ended_at: null },
  legacy_code_work_item_links: { cutover_receipt_json: '{}' },
}
describe('RFC-395 U1 operator decision shape', () => {
  const row: SourceRow = {
    table: 'code_work_items',
    phase: 'current',
    key: [canonicalValue('work')],
    encodedKey: encodeMigrationKey('code_work_items', [canonicalValue('work')]),
    canonical: { key: [canonicalValue('work')], values: [canonicalValue('queued')] },
    values: { status: 'queued' },
  }
  test('only the approved kind/code is accepted; unknown fields and blank acknowledgement facts are refused', () => {
    const decision = acknowledgement(row)
    expect(OperatorDecisionSchema.parse(decision)).toEqual(decision)
    for (const patch of [
      { kind: 'ignore-block' },
      { blockCode: 'v2-writer-not-os-active' },
      { extra: true },
      { sourcePhase: 'live' },
      { reason: ' ' },
      { acknowledgedBy: '' },
      { acknowledgedAt: -1 },
      { rowDigest: 'stale' },
    ])
      expect(OperatorDecisionSchema.safeParse({ ...decision, ...patch }).success).toBe(false)
  })
  test('row digest binds table, phase, encoded key, canonical bytes and raw evidence', () => {
    const digest = operatorDecisionRowDigest(row)
    const variants: SourceRow[] = [
      { ...row, table: 'code_work_rounds' },
      { ...row, phase: 'pre-upgrade' },
      { ...row, encodedKey: encodeMigrationKey(row.table, [canonicalValue('other')]) },
      { ...row, canonical: { ...row.canonical, values: [canonicalValue('running')] } },
      {
        ...row,
        raw: {
          key: row.key,
          cells: { status: { storageClass: 'text', value: canonicalValue('queued') } },
        },
      },
    ]
    for (const variant of variants) expect(operatorDecisionRowDigest(variant)).not.toBe(digest)
    expect(operatorDecisionRowDigest(structuredClone(row))).toBe(digest)
  })
})

describeV2Providers('RFC-395 U1 acknowledged legacy history', (h) => {
  for (const [table, patch] of Object.entries(unfinished))
    test(`${table}: unacknowledged blocks; acknowledged full row archives with predicate and replays`, async () => {
      await h.install()
      if (table === 'legacy_code_work_item_links')
        await h.write('development_missions', [
          frozenValues('development_missions', { id: 'fixture-mission_id' }),
        ])
      await h.write(table, [frozenValues(table, { id: 'pending', ...patch })])
      const rows = await readFrozenRows(h, table)
      const decision = acknowledgement(rows[0]!)
      const input = await h.input([
        { rules: [historyRule(table)], lookups: [], validators: [] },
        historyLookups(),
      ])
      try {
        const beforeSink = new V2MemorySink()
        const before = await runConversion(input, beforeSink)
        expect(
          before.blocks.filter((block) => block.code === 'v2-code-history-unfinished'),
        ).toEqual([
          expect.objectContaining({
            sourceKey: rows[0]!.encodedKey,
            acknowledgeable: true,
            detail: expect.objectContaining({ rowDigest: decision.rowDigest }),
          }),
        ])
        expect(beforeSink.rows('code_history_archives')).toEqual([])
        const sink = new V2MemorySink()
        const approved = { ...input, operatorDecisions: [decision] }
        const result = await runConversion(approved, sink)
        expect(result.status).toBe('converted')
        expect(result.blocks).toEqual([])
        expect(result.plan.operatorDecisions).toEqual([decision])
        expect(result.plan.digest).not.toBe(before.plan.digest)
        const dispositions = [...sink.units.values()].flatMap((unit) => unit.dispositions)
        expect(dispositions).toHaveLength(1)
        expect(dispositions[0]).toMatchObject({
          class: 'archived',
          kind: 'archived',
          sourcePhase: 'current',
          rule: { id: `history/${table}`, version: 3 },
          decision: {
            code: 'v2-code-history-acknowledged-unfinished',
            detail: {
              acknowledgement: decision,
              ...unfinishedWorkPredicates[table as keyof typeof unfinishedWorkPredicates],
            },
          },
        })
        const archives = [...sink.units.values()].flatMap((unit) => unit.archives)
        expect(archives).toHaveLength(1)
        const expected = encodeHistoryPackage({
          sourceGeneration: input.preflight.sourceGenerationId,
          sourceContract: input.preflight.contract!.digest,
          table,
          rows,
        })
        expect(archives[0]!.bytes).toEqual(expected)
        expect(sink.rows('code_history_archives')[0]!.root_digest).toBe(bytesDigest(expected))
        expect(sink.rows('code_history_id_index')[0]!.original_id).toBe('pending')
        const units = [...sink.units.values()].map((unit) => [
          unit.receipt.unitId,
          unit.receipt.digest,
        ])
        expect(await runConversion(approved, sink)).toEqual(result)
        expect(
          [...sink.units.values()].map((unit) => [unit.receipt.unitId, unit.receipt.digest]),
        ).toEqual(units)
      } finally {
        await input.source.close()
      }
    })

  test('unused decisions for finished/missing rows and wrong source phases block; stale digest keeps unfinished blocked', async () => {
    await h.install()
    await h.write('code_work_items', [
      frozenValues('code_work_items', {
        id: 'pending',
        status: 'queued',
        anchor_id: 'pending-anchor',
      }),
      frozenValues('code_work_items', {
        id: 'finished',
        status: 'settled',
        anchor_id: 'finished-anchor',
      }),
    ])
    const rows = await readFrozenRows(h, 'code_work_items')
    const pending = rows.find((row) => row.values.id === 'pending')!
    const finished = rows.find((row) => row.values.id === 'finished')!
    const good = acknowledgement(pending)
    const input = await h.input([
      { rules: [historyRule('code_work_items')], lookups: [], validators: [] },
      historyLookups(),
    ])
    try {
      for (const decision of [
        acknowledgement(finished),
        { ...good, sourceKey: encodeMigrationKey('code_work_items', [canonicalValue('missing')]) },
        { ...good, sourcePhase: 'pre-upgrade' as const },
      ]) {
        const result = await runConversion(
          { ...input, operatorDecisions: [decision] },
          new V2MemorySink(),
        )
        expect(result.status).toBe('blocked')
        expect(result.blocks.map((block) => block.code)).toContain('v2-operator-decision-unused')
        expect(result.blocks.map((block) => block.code)).toContain('v2-code-history-unfinished')
      }
      const sink = new V2MemorySink()
      const stale = await runConversion(
        { ...input, operatorDecisions: [{ ...good, rowDigest: `sha256:${'0'.repeat(64)}` }] },
        sink,
      )
      expect(stale.blocks.map((block) => block.code)).toContain('v2-operator-decision-stale')
      expect(stale.blocks.map((block) => block.code)).toContain('v2-code-history-unfinished')
      expect(stale.blocks.map((block) => block.code)).not.toContain('v2-operator-decision-unused')
      expect(sink.rows('code_history_archives')).toEqual([])
    } finally {
      await input.source.close()
    }
  })
  test('a partially acknowledged package consumes nothing and does not write partial history', async () => {
    await h.install()
    await h.write(
      'code_work_items',
      ['one', 'two'].map((id) =>
        frozenValues('code_work_items', { id, status: 'queued', anchor_id: id }),
      ),
    )
    const rows = await readFrozenRows(h, 'code_work_items')
    const input = await h.input(
      [{ rules: [historyRule('code_work_items')], lookups: [], validators: [] }, historyLookups()],
      { operatorDecisions: [acknowledgement(rows[0]!)] },
    )
    try {
      const sink = new V2MemorySink()
      const result = await runConversion(input, sink)
      expect(result.blocks.map((block) => block.code).sort()).toEqual([
        'v2-code-history-package-blocked',
        'v2-code-history-unfinished',
        'v2-operator-decision-unused',
      ])
      expect(sink.rows('code_history_archives')).toEqual([])
      expect(sink.rows('code_history_id_index')).toEqual([])
      expect(result.tableReceipts[0]!.counts.blocked).toBe(2)
    } finally {
      await input.source.close()
    }
  })
  test('decisions are order-independent in the plan; each fact changes the digest and duplicate bindings are refused', async () => {
    await h.install()
    await h.write(
      'code_work_items',
      ['one', 'two'].map((id) =>
        frozenValues('code_work_items', { id, status: 'queued', anchor_id: id }),
      ),
    )
    const rows = await readFrozenRows(h, 'code_work_items')
    const decisions = rows.map(acknowledgement)
    const input = await h.input(
      [{ rules: [historyRule('code_work_items')], lookups: [], validators: [] }, historyLookups()],
      { operatorDecisions: decisions },
    )
    try {
      const original = planConversion(input)
      expect(planConversion({ ...input, operatorDecisions: [...decisions].reverse() }).digest).toBe(
        original.digest,
      )
      for (const patch of [
        { reason: 'another reason' },
        { acknowledgedBy: 'another operator' },
        { acknowledgedAt: 124 },
        { rowDigest: `sha256:${'f'.repeat(64)}` },
      ])
        expect(
          planConversion({
            ...input,
            operatorDecisions: [{ ...decisions[0]!, ...patch }, decisions[1]!],
          }).digest,
        ).not.toBe(original.digest)
      expect(() =>
        planConversion({ ...input, operatorDecisions: [decisions[0]!, decisions[0]!] }),
      ).toThrow('v2-operator-decision-duplicate')
      expect(() =>
        planConversion({
          ...input,
          operatorDecisions: [
            { ...decisions[0]!, blockCode: 'another-block' } as unknown as OperatorDecision,
          ],
        }),
      ).toThrow()
    } finally {
      await input.source.close()
    }
  })
  test('changed original row makes the prior acknowledgement stale in a new source snapshot', async () => {
    await h.install()
    await h.write('code_work_items', [
      frozenValues('code_work_items', { id: 'pending', status: 'queued' }),
    ])
    const prior = acknowledgement((await readFrozenRows(h, 'code_work_items'))[0]!)
    await h.sourceHarness.native.execute(
      `UPDATE ${h.sourceHarness.table('code_work_items')} SET status = 'running' WHERE id = 'pending'`,
    )
    const input = await h.input(
      [{ rules: [historyRule('code_work_items')], lookups: [], validators: [] }, historyLookups()],
      { operatorDecisions: [prior] },
    )
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).blocks.map((block) => block.code)).toContain(
        'v2-operator-decision-stale',
      )
      expect(sink.rows('code_history_archives')).toEqual([])
    } finally {
      await input.source.close()
    }
  })
  test('pre-upgrade decisions consume only the matching evidence phase', async () => {
    await h.install()
    await h.write('code_ai_attempts', [
      frozenValues('code_ai_attempts', { id: 'pending', status: 'running', ended_at: null }),
    ])
    const row = (await readFrozenRows(h, 'code_ai_attempts'))[0]!
    const rule = { ...historyRule('code_ai_attempts'), sourcePhase: 'pre-upgrade' as const }
    const input = await h.input([{ rules: [rule], lookups: [], validators: [] }], {
      sourceScope: [],
    })
    try {
      const sink = new V2MemorySink()
      const result = await runConversion(
        {
          ...input,
          preUpgradeSource: input.source,
          preUpgradePreflight: input.preflight,
          operatorDecisions: [acknowledgement({ ...row, phase: 'pre-upgrade' })],
        },
        sink,
      )
      expect(result.blocks).toEqual([])
      expect(result.tableReceipts[0]!.sourcePhase).toBe('pre-upgrade')
      expect([...sink.units.values()][0]!.dispositions[0]).toMatchObject({
        sourcePhase: 'pre-upgrade',
        decision: { code: 'v2-code-history-acknowledged-unfinished' },
      })
    } finally {
      await input.source.close()
    }
  })
})
