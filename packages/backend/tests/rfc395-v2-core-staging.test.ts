// RFC-395 V2: staging stores source bytes and lookup facts without touching a target provider.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createStagingStore,
  encodeStagedValue,
  decodeStagedValue,
} from '@/platform/persistence/migration/conversion/staging'
import { encodeMigrationKey } from '@/platform/persistence/migration/conversion/migrationKey'
import { targetRegistryView } from '@/platform/persistence/migration/conversion/targetRows'
import {
  legacyEvidenceRow,
  type LegacyEvidence,
} from '@/platform/persistence/migration/conversion/evidence'
import { createUnitCollector } from '@/platform/persistence/migration/conversion/receipts'
import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import {
  artifactReceipt,
  legacyLocationToContentRef,
} from '@/platform/persistence/migration/conversion/content'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { decodeContentRefColumns } from '@/platform/content/contentRefCodec'
import { evaluateExpression } from '@/platform/persistence/migration/conversion/expressionEvaluator'
import { deterministicChildId } from '@/platform/persistence/migration/conversion/ids'
import type {
  SourceRow,
  TargetRow,
  HistoryRestriction,
} from '@/platform/persistence/migration/conversion/types'

function source(id: string, group: string): SourceRow {
  const key = [{ type: 'text' as const, value: id }]
  return {
    table: 'fixture',
    phase: 'current',
    key,
    encodedKey: encodeMigrationKey('fixture', key),
    canonical: { key, values: [...key, { type: 'text', value: group }] },
    values: { id, group },
  }
}
describe('RFC-395 V2 staging and evidence', () => {
  test('V3 K-4 missing and empty task/run ids are null, never empty or stringified null/undefined', () => {
    for (const table of ['fixture', 'tasks', 'node_runs']) {
      for (const value of [undefined, null, '']) {
        const row: SourceRow = {
          ...source('key', 'group'),
          table,
          values: value === undefined ? {} : { id: value, task_id: value },
        }
        expect(rowBlock('invalid-source', row, null)).toMatchObject({ taskId: null, runId: null })
      }
    }
    expect(
      rowBlock(
        'invalid-source',
        { ...source('run', 'g'), table: 'node_runs', values: { id: 'run', task_id: 'task' } },
        null,
      ),
    ).toMatchObject({ taskId: 'task', runId: 'run' })
    expect(
      rowBlock('invalid-source', { ...source('task', 'g'), table: 'tasks' }, null),
    ).toMatchObject({ taskId: 'task', runId: null })
    expect(
      rowBlock('invalid-source', { ...source('key', 'g'), values: { task_id: '' } }, null),
    ).toMatchObject({ taskId: null, runId: null })
  })
  test('V2-1 receipt key bounds and group keys match UTF-8 staging/trace order across Unicode planes', () => {
    const root = mkdtempSync(join(tmpdir(), 'v2-byte-order-'))
    const staged = createStagingStore(root)
    const expected = ['a', '\ue000', '\u{10000}']
    const rows = [...expected].reverse().map((value) => source(value, value))
    try {
      rows.forEach((row) => staged.put(row))
      expect([...staged.rows('fixture')].map((row) => row.values.id)).toEqual(expected)
      expect(staged.groupKeys('fixture', 'group')).toEqual(expected)
      const collector = createUnitCollector({
        rule: {
          ref: { id: 'unicode', version: 1 },
          owner: 'fixture',
          claims: ['fixture'],
          produces: [],
          lookups: [],
          unit: { kind: 'source-chunk', table: 'fixture' },
          convert() {},
        },
        sourceRows: rows,
        sourceVersion: 'v1',
        sourceContract: 'contract',
        target: targetRegistryView(persistenceSchema),
        topology: [],
      })
      for (const row of rows)
        collector.out.record({ kind: 'decision', code: 'unicode-source', payload: null }, row)
      const result = collector.finish({
        unit: {
          kind: 'source-chunk',
          table: 'fixture',
          phase: 'current',
          afterKey: null,
          limit: 3,
        },
        unitId: 'unicode-range',
        lookups: [],
      })
      const receipt = result.receipt.sources[0]!
      expect(receipt.firstKey).toBe(source('a', 'a').encodedKey)
      expect(receipt.lastKey).toBe(source('\u{10000}', '\u{10000}').encodedKey)
      for (const row of rows) {
        expect(
          Buffer.compare(Buffer.from(row.encodedKey), Buffer.from(receipt.firstKey!)),
        ).toBeGreaterThanOrEqual(0)
        expect(
          Buffer.compare(Buffer.from(row.encodedKey), Buffer.from(receipt.lastKey!)),
        ).toBeLessThanOrEqual(0)
      }
    } finally {
      staged.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
  test('caller scratch root, deterministic iteration, grouping, key lookup, and lossless nested values', () => {
    const root = mkdtempSync(join(tmpdir(), 'v2-staging-test-'))
    const first = createStagingStore(root),
      second = createStagingStore(root)
    try {
      expect(first.path.startsWith(root)).toBe(true)
      expect(existsSync(first.path)).toBe(true)
      const rows = [source('z', 'g'), source('a', 'g'), source('q', 'other')].map((row) => ({
        ...row,
        values: { ...row.values, payload: 'large-json'.repeat(10000) },
      }))
      rows.forEach((row) => first.put(row))
      ;[...rows].reverse().forEach((row) => second.put(row))
      expect([...first.rows('fixture')].map((row) => row.values.id)).toEqual(['a', 'q', 'z'])
      expect(first.indexedColumns()).toEqual([])
      expect(first.group('fixture', 'group', 'g').map((row) => row.values.id)).toEqual(['a', 'z'])
      expect(first.indexedColumns()).toEqual([
        { table: 'fixture', column: 'group', phase: 'current' },
      ])
      expect(first.groupKeys('fixture', 'group')).toEqual(['g', 'other'])
      expect(first.get('fixture', rows[0]!.encodedKey)).toEqual(rows[0])
      expect(first.digest()).toBe(second.digest())
      expect(second.indexedColumns()).toEqual([])
      const value = {
        small: 1n,
        large: 9007199254740993n,
        bytes: new Uint8Array([0, 255]),
        nested: [null, -0, ''],
        object: { type: 'integer', value: '5' },
      }
      expect(decodeStagedValue(encodeStagedValue(value))).toEqual(value)
      first.putLookup('facts', '', value)
      expect(first.lookup('facts', '')).toEqual(value)
      expect([...first.lookupEntries('facts')]).toEqual([['', value]])
      first.clear('fixture')
      expect(first.count('fixture')).toBe(0)
      first.put(source('replacement', 'new'))
      expect(first.groupKeys('fixture', 'group')).toEqual(['new'])
      expect(first.group('fixture', 'group', 'g')).toEqual([])
      first.put({ ...source('before', 'g'), phase: 'pre-upgrade' })
      expect(first.group('fixture', 'group', 'g', 'pre-upgrade')).toHaveLength(1)
      expect(first.indexedColumns()).toHaveLength(2)
    } finally {
      first.close()
      second.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
  test('the complete unit digest ignores target emission order while conserving source rows', () => {
    const origins = [source('a', 'g'), source('b', 'g')]
    const build = (reverse: boolean) => {
      const collector = createUnitCollector({
        rule: {
          ref: { id: 'ordered', version: 1 },
          owner: 'fixture',
          claims: ['fixture'],
          produces: [{ table: 'maintenance_state' }],
          lookups: [],
          unit: { kind: 'source-chunk', table: 'fixture' },
          convert() {},
        },
        sourceRows: reverse ? [...origins].reverse() : origins,
        sourceVersion: 'v1',
        sourceContract: 'contract',
        target: targetRegistryView(persistenceSchema),
        topology: ['maintenance_state'],
      })
      for (const origin of reverse ? [...origins].reverse() : origins)
        collector.out.row(
          'maintenance_state',
          { key: origin.values.id!, value: 'same', updated_at: 1 },
          origin,
        )
      return collector.finish({
        unit: {
          kind: 'source-chunk',
          table: 'fixture',
          phase: 'current',
          afterKey: null,
          limit: 2,
        },
        unitId: 'unit-order',
        lookups: [],
      })
    }
    expect(build(false).receipt.digest).toBe(build(true).receipt.digest)
    expect(build(false).receipt.counts.converted).toBe(2)
  })
  test('a newly minted target key requires a D7 disposition and history-only requires explicit restrictions', () => {
    const origin = source('a', 'g')
    const create = () =>
      createUnitCollector({
        rule: {
          ref: { id: 'minted', version: 1 },
          owner: 'fixture',
          claims: ['fixture'],
          produces: [{ table: 'maintenance_state' }],
          lookups: [],
          unit: { kind: 'source-chunk', table: 'fixture' },
          convert() {},
        },
        sourceRows: [origin],
        sourceVersion: 'v1',
        sourceContract: 'contract',
        target: targetRegistryView(persistenceSchema),
        topology: ['maintenance_state'],
      })
    const collector = create()
    collector.out.row(
      'maintenance_state',
      { key: deterministicChildId('child', origin.encodedKey), value: 'same', updated_at: 1 },
      origin,
    )
    const output = collector.finish({
      unit: { kind: 'source-chunk', table: 'fixture', phase: 'current', afterKey: null, limit: 1 },
      unitId: 'missing-disposition',
      lookups: [],
    })
    expect(output.blocks[0]!.code).toBe('v2-missing-row-disposition')
    const disposition = {
      sourceTable: origin.table,
      sourceKey: origin.encodedKey,
      class: 'converted' as const,
      kind: 'history-only' as const,
      targets: [],
      archive: null,
      decision: { code: 'unknown-frame', detail: null },
    }
    expect(() => create().out.exception(disposition)).toThrow('v2-history-restriction')
    expect(() =>
      create().out.exception({
        ...disposition,
        history: {
          taskId: 'task',
          runId: 'run',
          execution: 'retryable-history',
          missingFields: ['frame'],
        },
      }),
    ).not.toThrow()
    const unused: HistoryRestriction = {
      taskId: 'task',
      runId: 'run',
      execution: 'executable',
      executionUse: 'none',
      reason: 'null-envelope-nonce-unselected',
      missingFields: ['envelope_nonce'],
    }
    const accepted = create()
    accepted.out.exception({ ...disposition, history: unused })
    const acceptedOutput = accepted.finish({
      unit: { kind: 'source-chunk', table: 'fixture', phase: 'current', afterKey: null, limit: 1 },
      unitId: 'unused-history',
      lookups: [],
    })
    expect(acceptedOutput.blocks).toEqual([])
    expect(acceptedOutput.receipt.counts.historyOnly).toBe(1)
    expect(acceptedOutput.dispositions[0]!.history).toEqual(unused)
    for (const history of [
      { ...unused, executionUse: undefined },
      { ...unused, executionUse: 'selected' },
      { ...unused, reason: undefined },
      { ...unused, reason: 'unregistered-reason' },
      { ...unused, execution: 'unknown' },
    ])
      expect(() =>
        create().out.exception({ ...disposition, history: history as HistoryRestriction }),
      ).toThrow('v2-history-restriction')
    expect(() => create().out.exception({ ...disposition, kind: 'blocked' })).toThrow(
      'v2-disposition-class',
    )
    const blocked = create()
    blocked.out.exception({ ...disposition, kind: 'blocked', class: 'blocked' })
    const blockedOutput = blocked.finish({
      unit: { kind: 'source-chunk', table: 'fixture', phase: 'current', afterKey: null, limit: 1 },
      unitId: 'explicit-blocked-disposition',
      lookups: [],
    })
    expect(blockedOutput.blocks).toHaveLength(1)
    expect(blockedOutput.dispositions).toHaveLength(1)
    expect(blockedOutput.receipt.counts.blocked).toBe(1)
  })
  test('D21 evidence is restricted to task/task-repo/node-run and records original canonical cells', () => {
    const origin = source('task-1', 'g')
    const evidence: LegacyEvidence = {
      origin,
      taskId: null,
      recordKind: 'task',
      recordId: 'task-1',
      quality: 'legacy-derived',
      missingFields: ['snapshot'],
      detail: { reason: 'fixture' },
    }
    const row = legacyEvidenceRow(evidence, 'contract')
    const ref = decodeContentRefColumns(
      row.content_ref_json as string,
      row.content_inline_bytes as Uint8Array,
    )
    expect(ref?.kind).toBe('inline')
    if (ref?.kind === 'inline')
      expect(JSON.parse(Buffer.from(ref.bytes).toString())).toEqual({
        source: origin.canonical,
        raw: null,
        detail: { reason: 'fixture' },
      })
    const collector = createUnitCollector({
      rule: {
        ref: { id: 'evidence', version: 1 },
        owner: 'task-execution',
        claims: ['fixture'],
        produces: [{ table: 'execution_legacy_evidence', partition: 'task|task-repo' }],
        lookups: [],
        unit: { kind: 'source-chunk', table: 'fixture' },
        convert() {},
      },
      sourceRows: [origin],
      sourceVersion: 'v1',
      sourceContract: 'contract',
      target: targetRegistryView(persistenceSchema),
      topology: ['execution_legacy_evidence'],
    })
    collector.out.evidence(evidence)
    expect(
      collector.finish({
        unit: {
          kind: 'source-chunk',
          table: 'fixture',
          phase: 'current',
          afterKey: null,
          limit: 1,
        },
        unitId: 'unit',
        lookups: [],
      }).rows[0]!.rows,
    ).toEqual([row])
    expect(() =>
      legacyEvidenceRow(
        { ...evidence, recordKind: 'other' as LegacyEvidence['recordKind'] },
        'contract',
      ),
    ).toThrow('record-kind')
  })
  test('artifact receipts distinguish original absence, freeze loss and verified empty inline content', () => {
    const origin = source('content', 'g')
    const target = { table: 'target', key: origin.encodedKey }
    const file = legacyLocationToContentRef({
      kind: 'local-file',
      location: { codec: 'fixture', value: 'unchanged-path' },
    })
    for (const cause of ['originally-absent', 'missing-at-freeze'] as const) {
      const receipt = artifactReceipt({
        source: origin,
        column: 'path',
        originalReference: 'unchanged-path',
        target,
        ref: file,
        stat: { state: 'absent', cause, evidence: 'frozen inventory' },
      })
      expect(receipt.missing?.state).toBe(cause)
      expect(receipt.bytes).toBeNull()
      expect(receipt.originalReference).toBe('unchanged-path')
    }
    const inline = legacyLocationToContentRef({
      kind: 'inline',
      location: { codec: 'fixture', value: '' },
      bytes: new Uint8Array(),
    })
    const receipt = artifactReceipt({
      source: origin,
      column: 'body',
      originalReference: null,
      target,
      ref: inline,
    })
    expect(receipt.bytes?.size).toBe(0)
    expect(receipt.missing).toBeNull()
    expect(receipt.publication).toBe('not-required')
    expect(() =>
      artifactReceipt({
        source: origin,
        column: 'path',
        originalReference: 'path',
        target,
        ref: file,
      }),
    ).toThrow('inventory-required')
  })
  test('derived-id exceptions reject equal keys in another target table and record deterministic children', () => {
    const origin = source('a', 'g')
    const create = () =>
      createUnitCollector({
        rule: {
          ref: { id: 'fixture', version: 1 },
          owner: 'fixture',
          claims: ['fixture'],
          produces: [{ table: 'tasks' }],
          lookups: [],
          unit: { kind: 'source-chunk', table: 'fixture' },
          convert() {},
        },
        sourceRows: [origin],
        sourceVersion: 'v1',
        sourceContract: 'contract',
        target: targetRegistryView(persistenceSchema),
        topology: [],
      })
    const collector = create()
    const child = encodeMigrationKey('tasks', [
      { type: 'text', value: deterministicChildId('fixture', origin.encodedKey) },
    ])
    collector.out.exception({
      sourceTable: 'fixture',
      sourceKey: origin.encodedKey,
      class: 'converted',
      kind: 'derived-id',
      targets: [{ table: 'tasks', key: child }],
      archive: null,
      decision: { code: 'derived', detail: null },
    })
    expect(
      collector.finish({
        unit: {
          kind: 'source-chunk',
          table: 'fixture',
          phase: 'current',
          afterKey: null,
          limit: 1,
        },
        unitId: 'derived-unit',
        lookups: [],
      }).dispositions[0]!.targets[0]!.key,
    ).toBe(child)
    const equal = encodeMigrationKey('tasks', origin.key)
    expect(() =>
      create().out.exception({
        sourceTable: 'fixture',
        sourceKey: origin.encodedKey,
        class: 'converted',
        kind: 'derived-id',
        targets: [{ table: 'tasks', key: equal }],
        archive: null,
        decision: { code: 'derived', detail: null },
      }),
    ).toThrow('same-key-disposition')
  })
  test('typed target validation honors D8 detached base shape without accepting arbitrary refs', () => {
    const target = targetRegistryView(persistenceSchema)
    const definition = target.table('task_repository_mounts')
    const base = Object.fromEntries(
      Object.values(definition.columns).map((column) => [column.name, null]),
    ) as Record<string, TargetRow[string]>
    Object.assign(base, {
      task_id: 'task',
      repo_key: 'repo',
      ordinal: 0,
      mount_path: '',
      attachment_kind: 'internal',
      repo_path: '/repo',
      branch_state: 'detached',
      branch: null,
      base_branch: 'sha',
      base_commit: 'sha',
    })
    // The native R1 behavior fixture checks the full row; inspect the exact typed predicate here.
    const check = definition.checks.find(
      (check) => check.name === 'task_repository_mounts_base_shape',
    )!
    expect(evaluateExpression(check.expression, base)).toBe(true)
    expect(evaluateExpression(check.expression, { ...base, base_branch: null })).toBe(true)
    expect(evaluateExpression(check.expression, { ...base, base_branch: 'other' })).toBe(false)
  })
})
