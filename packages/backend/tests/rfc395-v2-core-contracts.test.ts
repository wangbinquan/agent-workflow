// RFC-395 V2-core A: contracts are dormant; execution is reserved for T18.
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import {
  encodeMigrationKey,
  decodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import { deterministicChildId } from '@/platform/persistence/migration/conversion/ids'
import { targetRowsDigest } from '@/platform/persistence/migration/conversion/digest'
import {
  evaluateExpression,
  sqlTruth,
} from '@/platform/persistence/migration/conversion/expressionEvaluator'
import {
  targetRegistryView,
  createTargetRow,
  createUnitUniqueChecker,
} from '@/platform/persistence/migration/conversion/targetRows'
import {
  column as c,
  defineContribution,
  retention,
  index,
  foreignKey,
} from '@/platform/persistence/schema/dsl'
import { createSchemaRegistry } from '@/platform/persistence/schema/registry'
import { expr } from '@/platform/persistence/schema/targetDefinition'
import { targetTopology } from '@/platform/persistence/migration/conversion/topology'
import { executionClass } from '@/platform/persistence/migration/conversion/lookups/keys'
import { TASK_STATUS } from '@agent-workflow/shared'
import { scanJsonObjectEntries } from '@/platform/persistence/migration/conversion/orderedJson'
import { orderLookupBuilders, lookupKey } from '@/platform/persistence/migration/conversion/lookups'
import {
  encodeContentRefColumns,
  decodeContentRefColumns,
} from '@/platform/content/contentRefCodec'
import { legacyLocationToContentRef } from '@/platform/persistence/migration/conversion/content'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import type { TargetRow } from '@/platform/persistence/migration/conversion/types'

const owner = defineContribution('v2-fixture')
const definition = owner.table({
  id: 'sample',
  schemaSymbol: 'sample',
  retention: retention.business,
  columns: {
    id: c.id('id', { primary: true }),
    state: c.enum('state', ['open', 'closed']),
    flag: c.bool('flag'),
    count: c.int('count'),
    ref: c.jsonText('ref', {
      nullable: true,
      document: { kind: 'content-ref', version: 1, inlineBytesColumn: 'bytes' },
    }),
    bytes: c.bytes('bytes', { nullable: true }),
    optional: c.text('optional', { nullable: true }),
  },
  unique: [{ name: 'optional_distinct', columns: ['optional'], nulls: 'distinct' }],
  indexes: [
    index('closed_unique', ['state'], {
      unique: true,
      nulls: 'distinct',
      where: expr.binary('=', expr.column('state'), expr.value('closed')),
    }),
  ],
  checks: [
    {
      name: 'count_nonnegative',
      expression: expr.binary('>=', expr.column('count'), expr.value(0)),
    },
  ],
})
const registry = createSchemaRegistry([owner.contribution([definition])], { schemaEpoch: 2 })
const target = targetRegistryView(registry)
const valid: TargetRow = {
  id: 'id',
  state: 'open',
  flag: true,
  count: 0,
  ref: null,
  bytes: null,
  optional: null,
}

describe('RFC-395 V2 contracts', () => {
  test('mk1 is injective for composite keys, separators, escaped Unicode and typed scalars', () => {
    const values = ['a:b', 'a', 'b:c', 'a/b', 'a\u0000b', '["a"]', 'é', 'é', '', 'mk1:']
    const keys = values.flatMap((left) =>
      values.map((right) =>
        encodeMigrationKey('t', [
          { type: 'text', value: left },
          { type: 'text', value: right },
        ]),
      ),
    )
    expect(new Set(keys).size).toBe(keys.length)
    for (const encoded of keys) {
      const decoded = decodeMigrationKey(encoded)
      expect(encodeMigrationKey(decoded.table, decoded.key)).toBe(encoded)
    }
    expect(encodeMigrationKey('t', [{ type: 'text', value: '1' }])).not.toBe(
      encodeMigrationKey('t', [{ type: 'integer', value: '1' }]),
    )
    expect(() => decodeMigrationKey('mk2:[]')).toThrow()
    expect(() => decodeMigrationKey('mk1:["t",[]]')).toThrow()
  })
  test('child ids are stable in fresh Bun processes and separate namespaces/discriminators', async () => {
    const parent = encodeMigrationKey('t', [{ type: 'text', value: 'parent' }])
    const expected = deterministicChildId('mount', parent, 1)
    const script = `import {deterministicChildId} from './src/platform/persistence/migration/conversion/ids.ts'; process.stdout.write(deterministicChildId('mount', ${JSON.stringify(parent)}, 1))`
    for (let index = 0; index < 2; index++) {
      const process = Bun.spawn([globalThis.process.execPath, '-e', script], {
        cwd: resolve(import.meta.dir, '..'),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const result = await new Response(process.stdout).text()
      expect(await process.exited).toBe(0)
      expect(result).toBe(expected)
    }
    expect(deterministicChildId('mount', parent, '1')).not.toBe(expected)
    expect(deterministicChildId('other', parent, 1)).not.toBe(expected)
  })
  test('row digests ignore order, retain duplicate multiplicity and exact text, bytes, NULL and -0', () => {
    const a = { id: 'a', bytes: new Uint8Array([0, 255]), json: '{ "b":2,"a":1 }', value: -0 }
    const b = { id: 'b', bytes: null, json: '', value: 0 }
    expect(targetRowsDigest([a, b])).toBe(targetRowsDigest([b, a]))
    expect(targetRowsDigest([a, b, a])).not.toBe(targetRowsDigest([a, b]))
    expect(targetRowsDigest([a])).not.toBe(targetRowsDigest([{ ...a, value: 0 }]))
    expect(targetRowsDigest([b])).not.toBe(targetRowsDigest([{ ...b, bytes: new Uint8Array() }]))
  })
  test('target rows require every explicit column and reject codec/NULL/enum/bool/document/CHECK failures', () => {
    expect(createTargetRow(target, 'sample', valid)).toEqual(valid)
    const { count: _count, ...missing } = valid
    for (const row of [
      missing,
      { ...valid, extra: 1 },
      { ...valid, state: 'other' },
      { ...valid, flag: 2 },
      { ...valid, count: 9007199254740992 },
      { ...valid, id: null },
      { ...valid, count: -1 },
      { ...valid, ref: '{"version":1,"kind":"inline"}' },
      { ...valid, bytes: new Uint8Array() },
    ])
      expect(() => createTargetRow(target, 'sample', row)).toThrow()
  })
  test('jsonDoc transport is explicit JSON text and versioned documents reject malformed input', () => {
    const definitionWithDocument = {
      ...definition,
      columns: { ...definition.columns, doc: c.jsonDoc('doc') },
    }
    const view = targetRegistryView(
      createSchemaRegistry([owner.contribution([definitionWithDocument])], { schemaEpoch: 2 }),
    )
    expect(createTargetRow(view, 'sample', { ...valid, doc: '{ "a": 1 }' }).doc).toBe('{ "a": 1 }')
    expect(() => createTargetRow(view, 'sample', { ...valid, doc: '{broken' })).toThrow(
      'v2-target-codec',
    )
  })
  test('PK, unique NULL semantics and partial indexes are checked across all outputs in one unit', () => {
    const check = createUnitUniqueChecker(target)
    check('sample', valid)
    check('sample', { ...valid, id: 'two' })
    expect(() => check('sample', valid)).toThrow('v2-target-unique')
    check('sample', { ...valid, id: 'three', state: 'closed' })
    expect(() => check('sample', { ...valid, id: 'four', state: 'closed' })).toThrow(
      'closed_unique',
    )
    check('sample', { ...valid, id: 'five', optional: '' })
    expect(() => check('sample', { ...valid, id: 'six', optional: '' })).toThrow(
      'optional_distinct',
    )
    const equalDefinition = {
      ...definition,
      unique: [{ name: 'equal', columns: ['optional'], nulls: 'not-distinct' as const }],
      indexes: [],
    }
    const equalCheck = createUnitUniqueChecker(
      targetRegistryView(
        createSchemaRegistry([owner.contribution([equalDefinition])], { schemaEpoch: 2 }),
      ),
    )
    equalCheck('sample', valid)
    expect(() => equalCheck('sample', { ...valid, id: 'two' })).toThrow('equal')
  })
  test('typed predicates use SQL three-valued logic; NULL CHECK is accepted and FALSE is rejected', () => {
    for (const a of [true, false, null])
      for (const b of [true, false, null]) {
        expect(evaluateExpression(expr.binary('AND', expr.value(a), expr.value(b)), {})).toBe(
          a === false || b === false ? false : a === null || b === null ? null : true,
        )
        expect(evaluateExpression(expr.binary('OR', expr.value(a), expr.value(b)), {})).toBe(
          a === true || b === true ? true : a === null || b === null ? null : false,
        )
      }
    expect(
      evaluateExpression(
        { kind: 'in', value: expr.value('x'), values: [expr.value(null), expr.value('z')] },
        {},
      ),
    ).toBeNull()
    expect(evaluateExpression({ kind: 'unary', op: 'NOT', value: expr.value(null) }, {})).toBeNull()
    expect(
      sqlTruth(evaluateExpression(expr.binary('=', expr.value(null), expr.value('x')), {})),
    ).toBeNull()
    const nullable = {
      ...definition,
      checks: [
        {
          name: 'nullable_check',
          expression: expr.binary('=', expr.column('optional'), expr.value('yes')),
        },
      ],
    }
    const view = targetRegistryView(
      createSchemaRegistry([owner.contribution([nullable])], { schemaEpoch: 2 }),
    )
    expect(() => createTargetRow(view, 'sample', valid)).not.toThrow()
    expect(() => createTargetRow(view, 'sample', { ...valid, optional: 'no' })).toThrow(
      'nullable_check',
    )
  })
  test('topology emits parents first, reports unorderable self references and cross-table cycles', () => {
    const self = {
      ...definition,
      foreignKeys: [foreignKey('self', ['optional'], 'sample', ['id'])],
    }
    const child = owner.table({
      id: 'child',
      schemaSymbol: 'child',
      retention: retention.business,
      columns: { id: c.id('id', { primary: true }), parent: c.id('parent') },
      foreignKeys: [foreignKey('parent', ['parent'], 'sample', ['id'])],
    })
    const order = targetTopology(
      createSchemaRegistry([owner.contribution([child, self])], { schemaEpoch: 2 }),
    )
    expect(order.order).toEqual(['sample', 'child'])
    expect(order.selfReferences).toEqual([{ table: 'sample', foreignKey: 'self' }])
    const cycle = { ...definition, foreignKeys: [foreignKey('back', ['id'], 'child', ['id'])] }
    expect(
      targetTopology(createSchemaRegistry([owner.contribution([child, cycle])], { schemaEpoch: 2 }))
        .deferredForeignKeys,
    ).toHaveLength(1)
  })
  test('lookup dependency cycles and duplicate versions are rejected', () => {
    const a = lookupKey('a', 1)
    const b = lookupKey('b', 1)
    const first = { key: a, sources: [], dependsOn: [b], build() {} }
    const second = { key: b, sources: [], dependsOn: [a], build() {} }
    expect(() => orderLookupBuilders([first, second])).toThrow('v2-lookup-cycle')
    expect(() => orderLookupBuilders([first, first])).toThrow('v2-duplicate-lookup')
    expect(() => orderLookupBuilders([first])).toThrow('v2-missing-lookup')
  })
  test('D4 covers every stored task status with exactly three execution classes', () => {
    const expected: Record<(typeof TASK_STATUS)[number], ReturnType<typeof executionClass>> = {
      pending: 'executable',
      running: 'executable',
      awaiting_review: 'executable',
      awaiting_human: 'executable',
      interrupted: 'executable',
      failed: 'retryable-history',
      canceled: 'retryable-history',
      done: 'terminal-history',
    }
    const statuses: readonly string[] = TASK_STATUS
    expect([...statuses].sort()).toEqual(Object.keys(expected).sort())
    for (const [status, classification] of Object.entries(expected))
      expect(executionClass(status)).toBe(classification)
    expect(() => executionClass('new-unknown')).toThrow('v2-unknown-task-status')
  })
  test('D16 scans raw JSON key order and duplicate occurrences without JS integer-key reordering', () => {
    const entries = scanJsonObjectEntries(
      '{"z":{},"10":{"nested":["}",2]},"2":3,"z":' + JSON.stringify('a"b') + '}',
    )
    expect(entries.map((entry) => entry.key)).toEqual(['z', '10', '2', 'z'])
    expect(entries.map((entry) => entry.ordinal)).toEqual([0, 1, 2, 3])
    expect(entries[1]!.rawValue).toBe('{"nested":["}",2]}')
    expect(() => scanJsonObjectEntries('{"a":')).toThrow()
    expect(() => scanJsonObjectEntries('[]')).toThrow()
  })
  test('ContentRef round trips inline zero bytes/BOM and every location kind without inventing metadata', () => {
    for (const bytes of [new Uint8Array(), new Uint8Array([239, 187, 191, 255])]) {
      const ref = legacyLocationToContentRef({
        kind: 'inline',
        location: { codec: 'fixture', value: 'original' },
        bytes,
      })
      const columns = encodeContentRefColumns(ref)
      expect(decodeContentRefColumns(columns.json, columns.inlineBytes)).toEqual(ref)
      expect(columns.json).not.toContain('"bytes"')
    }
    for (const kind of ['local-file', 'database-bytes', 'object'] as const) {
      const ref = legacyLocationToContentRef({
        kind,
        location: { codec: 'fixture', value: 'a/../raw' },
      })
      const columns = encodeContentRefColumns(ref)
      expect(columns.inlineBytes).toBeNull()
      expect(decodeContentRefColumns(columns.json, null)).toEqual(ref)
      expect(ref.sha256).toBeNull()
      expect(ref.mediaType).toBeNull()
      expect(() => decodeContentRefColumns(columns.json, new Uint8Array())).toThrow()
    }
    expect(decodeContentRefColumns(null, null)).toBeNull()
    expect(() => decodeContentRefColumns(null, new Uint8Array())).toThrow()
    const columns = encodeContentRefColumns(
      legacyLocationToContentRef({
        kind: 'inline',
        location: { codec: 'fixture', value: 'x' },
        bytes: new Uint8Array([1]),
      }),
    )
    expect(() => decodeContentRefColumns(columns.json, null)).toThrow()
    expect(() => decodeContentRefColumns(columns.json, new Uint8Array([2]))).toThrow(
      'digest-mismatch',
    )
  })
  test('D6 preserves occurrence in both clarify keys and unique ordinals', () => {
    for (const name of ['clarify_answers', 'clarify_answer_drafts']) {
      const definition = persistenceSchema.tables.find((table) => table.id === name)!
      expect(definition.primaryKey).toEqual(['round_id', 'question_id', 'occurrence'])
      expect(definition.unique.some((key) => key.columns.join(',') === 'round_id,ordinal')).toBe(
        true,
      )
    }
  })
})
