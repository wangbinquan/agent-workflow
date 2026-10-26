// RFC-395 U-5: missing/corrupt packages are failures, and history reads never repair or write.
import { beforeEach, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { tablesOf, inheritDatabaseHandle } from '@/platform/persistence/sessionTables'
import { contentRefColumns } from '@/platform/content/contentStore'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { sha256Hex } from '@/util/hash'
import { decodeCodeHistoryPackage } from '@/modules/code-capability/domain/codeHistoryPackage'
import { createCodeHistoryPackageReader } from '@/modules/code-capability/infrastructure/history/packageReader'
import { createWorkItemProjectionRead } from '@/modules/code-capability/infrastructure/workItemProjectionRead'
import { createRoundAttemptsRead } from '@/modules/code-capability/infrastructure/roundAttemptsRead'
import { createDeliveryChainRead } from '@/modules/code-capability/infrastructure/deliveryChainRead'
import { createCodeMetricsRead } from '@/modules/code-capability/infrastructure/codeMetricsRead'
import { describeEachProvider } from './helpers/eachProvider'
import {
  seedEmptyCodeHistory,
  seedCodeHistoryRows,
  historyFixtureSource,
  historyFixtureReader,
  historyFixtureContent,
  historyFixtureArchive,
} from './helpers/legacyCapabilitySeed'

const TABLE = 'code_work_items' as const
const item = {
  id: 'old-id',
  codeHostEndpointId: 'ep',
  stableProjectId: 'project',
  capability: 'mr-review',
  anchorKind: 'mr',
  anchorId: '42',
  status: 'settled',
  epoch: 1,
  createdAt: 100,
  updatedAt: 100,
}

describeEachProvider('RFC-395 read-only history packages', (h) => {
  beforeEach(async () => {
    await seedEmptyCodeHistory(h.db)
  })
  const archiveId = () => historyFixtureArchive(TABLE, []).id
  const patch = async (
    changes: Partial<
      Omit<ReturnType<typeof historyFixtureArchive>, 'contentRefJson' | 'contentInlineBytes'>
    > & {
      readonly contentRefJson?: string
      readonly contentInlineBytes?: Uint8Array | null
    },
  ) => {
    const { codeHistoryArchives } = tablesOf(h.db)
    await h.db
      .update(codeHistoryArchives)
      .set({
        ...changes,
        contentInlineBytes:
          changes.contentInlineBytes == null
            ? changes.contentInlineBytes
            : Buffer.from(changes.contentInlineBytes),
      })
      .where(eq(codeHistoryArchives.id, archiveId()))
  }
  test('all projections and id lookups issue SELECT only and never address retired tables', async () => {
    await seedCodeHistoryRows(h.db, TABLE, item)
    const recording = h.recordStatements()
    try {
      const reader = historyFixtureReader(h.db)
      expect((await reader.find(TABLE, 'old-id'))?.row.id).toBe('old-id')
      expect(await reader.find(TABLE, 'missing')).toBeNull()
      await createWorkItemProjectionRead(reader).readPage({})
      await createRoundAttemptsRead(reader).load('missing', 200)
      await createDeliveryChainRead(reader).byCorrelation('missing')
      await createCodeMetricsRead(reader).loadSince(0)
    } finally {
      recording.stop()
    }
    expect(recording.statements.length).toBeGreaterThan(0)
    expect(recording.statements.every((row) => /^\s*select\b/i.test(row.sql))).toBe(true)
    for (const row of recording.statements)
      expect(row.sql).not.toMatch(
        /(?:from|join)\s+"?(?:code_work_items|code_work_rounds|code_round_stages|code_ai_attempts|code_findings|code_trigger_deliveries)"?\b/i,
      )
  })
  test('a genuine zero-row package is empty; a missing artifact fails even for unknown ids', async () => {
    const reader = historyFixtureReader(h.db)
    expect(await reader.rows(TABLE)).toEqual([])
    const { codeHistoryArchives } = tablesOf(h.db)
    await h.db.delete(codeHistoryArchives).where(eq(codeHistoryArchives.id, archiveId()))
    await expect(reader.rows(TABLE)).rejects.toThrow('code-history-package-missing')
    await expect(reader.find(TABLE, 'missing')).rejects.toThrow('code-history-package-missing')
  })
  test.each([
    [{ formatVersion: 2 }, 'code-history-format-unsupported'],
    [{ rowCount: 1 }, 'code-history-row-count-mismatch'],
    [{ rootDigest: `sha256:${'0'.repeat(64)}` }, 'code-history-digest-mismatch'],
    [{ contentRefJson: '{}' }, 'code-history-content-invalid'],
  ] as const)('rejects archive metadata mismatch %j', async (changes, code) => {
    if ('contentRefJson' in changes) {
      await expect(patch(changes)).rejects.toThrow()
      const { codeHistoryArchives } = tablesOf(h.db)
      const [archive] = await h.db
        .select()
        .from(codeHistoryArchives)
        .where(eq(codeHistoryArchives.id, archiveId()))
      const corrupt = inheritDatabaseHandle(
        { select: () => ({ from: () => ({ where: async () => [{ ...archive, ...changes }] }) }) },
        h.db,
      )
      const reader = createCodeHistoryPackageReader({
        db: corrupt as unknown as Pick<typeof h.db, 'select'>,
        content: historyFixtureContent,
        installation: { kind: 'converted', source: historyFixtureSource },
      })
      await expect(reader.rows(TABLE)).rejects.toThrow(code)
    } else {
      await patch(changes)
      await expect(historyFixtureReader(h.db).rows(TABLE)).rejects.toThrow(code)
    }
  })
  test('corrupt bytes and unknown content format do not turn into empty responses', async () => {
    const bytes = new TextEncoder().encode('{broken')
    const ref = contentRefColumns.encode({
      version: 1,
      kind: 'inline',
      location: { codec: 'code-history@1', value: {} },
      contentId: null,
      contentVersion: null,
      sha256: sha256Hex(bytes),
      size: bytes.length,
      mediaType: null,
      bytes,
    })
    await patch({
      contentRefJson: ref.json,
      contentInlineBytes: ref.inlineBytes,
      rootDigest: `sha256:${sha256Hex(bytes)}`,
    })
    await expect(historyFixtureReader(h.db).rows(TABLE)).rejects.toThrow(
      'code-history-package-invalid',
    )
    const future = new TextEncoder().encode(JSON.stringify({ format: 'code-history@99' }))
    const futureRef = contentRefColumns.encode({
      version: 1,
      kind: 'inline',
      location: { codec: 'code-history@1', value: {} },
      contentId: null,
      contentVersion: null,
      sha256: sha256Hex(future),
      size: future.length,
      mediaType: null,
      bytes: future,
    })
    await patch({
      contentRefJson: futureRef.json,
      contentInlineBytes: futureRef.inlineBytes,
      rootDigest: `sha256:${sha256Hex(future)}`,
    })
    await expect(historyFixtureReader(h.db).rows(TABLE)).rejects.toThrow(
      'code-history-format-unsupported',
    )
  })
  test.each(['ordinal', 'key', 'parent', 'missing'] as const)(
    'validates the id index %s against the package',
    async (kind) => {
      await seedCodeHistoryRows(h.db, TABLE, item)
      const { codeHistoryIdIndex } = tablesOf(h.db)
      const where = eq(codeHistoryIdIndex.originalId, 'old-id')
      if (kind === 'missing') await h.db.delete(codeHistoryIdIndex).where(where)
      else
        await h.db
          .update(codeHistoryIdIndex)
          .set(
            kind === 'ordinal'
              ? { recordOrdinal: 99 }
              : kind === 'key'
                ? { originalKeyJson: '[]' }
                : { archiveId: historyFixtureArchive('code_work_rounds', []).id },
          )
          .where(where)
      await expect(historyFixtureReader(h.db).find(TABLE, 'old-id')).rejects.toThrow(
        'code-history-index-invalid',
      )
    },
  )
  test('ambiguous archive matches fail deterministically instead of last-row-wins', async () => {
    const { codeHistoryArchives } = tablesOf(h.db)
    const [archive] = await h.db
      .select()
      .from(codeHistoryArchives)
      .where(eq(codeHistoryArchives.id, archiveId()))
    // Fault fixture is deliberately outside the physical unique constraint.
    const duplicate = inheritDatabaseHandle(
      { select: () => ({ from: () => ({ where: async () => [archive, archive] }) }) },
      h.db,
    )
    const reader = createCodeHistoryPackageReader({
      db: duplicate as unknown as Pick<typeof h.db, 'select'>,
      content: historyFixtureContent,
      installation: { kind: 'converted', source: historyFixtureSource },
    })
    await expect(reader.rows(TABLE)).rejects.toThrow('code-history-package-conflict')
  })
  test('a missing content reference fails explicitly even in a corrupt archive projection', async () => {
    const { codeHistoryArchives } = tablesOf(h.db)
    const [archive] = await h.db
      .select()
      .from(codeHistoryArchives)
      .where(eq(codeHistoryArchives.id, archiveId()))
    // The physical column is NOT NULL; inject corruption at the read boundary without weakening its schema.
    const missing = inheritDatabaseHandle(
      {
        select: () => ({
          from: () => ({
            where: async () => [{ ...archive, contentRefJson: null, contentInlineBytes: null }],
          }),
        }),
      },
      h.db,
    )
    const reader = createCodeHistoryPackageReader({
      db: missing as unknown as Pick<typeof h.db, 'select'>,
      content: historyFixtureContent,
      installation: { kind: 'converted', source: historyFixtureSource },
    })
    await expect(reader.rows(TABLE)).rejects.toThrow('code-history-content-missing')
  })
  test('external package bytes go through the injected ContentStore reader', async () => {
    const archive = historyFixtureArchive(TABLE, [])
    const bytes = archive.contentInlineBytes!
    const ref = contentRefColumns.encode({
      version: 1,
      kind: 'object',
      location: { codec: 'fixture@1', value: { key: 'history' } },
      contentId: 'content-id',
      contentVersion: 1,
      sha256: sha256Hex(bytes),
      size: bytes.length,
      mediaType: null,
    })
    await patch({ contentRefJson: ref.json, contentInlineBytes: null })
    const seen: string[] = []
    const reader = createCodeHistoryPackageReader({
      db: h.db,
      content: {
        async read(value) {
          seen.push(value.kind)
          return bytes
        },
      },
      installation: { kind: 'converted', source: historyFixtureSource },
    })
    expect(await reader.rows(TABLE)).toEqual([])
    expect(seen).toEqual(['object'])
  })
  test('an explicit fresh installation is empty without probing or creating packages', async () => {
    const recording = h.recordStatements()
    try {
      const reader = createCodeHistoryPackageReader({
        db: h.db,
        content: historyFixtureContent,
        installation: { kind: 'fresh-install' },
      })
      expect(await reader.rows(TABLE)).toEqual([])
      expect(await reader.find(TABLE, 'none')).toBeNull()
    } finally {
      recording.stop()
    }
    expect(recording.statements).toEqual([])
  })
})

test('frozen canonical values preserve integer, boolean, bytes, JSON text and raw evidence without trusting raw over canonical', () => {
  const key = [{ type: 'text', value: 'id' }]
  const cells = [
    ...key,
    { type: 'integer', value: '9007199254740993' },
    { type: 'boolean', value: true },
    { type: 'bytes', value: 'AP8=' },
    { type: 'text', value: ' { "a": 1 }\r\n' },
    { type: 'null' },
  ]
  const raw = {
    key,
    cells: { id: { storageClass: 'text', value: { type: 'text', value: 'wrong' } } },
  }
  const source = {
    sourceGeneration: 'generation',
    contract: {
      digest: 'contract',
      tables: [
        {
          id: TABLE,
          columns: ['id', 'big', 'flag', 'bytes', 'json_text', 'optional'].map((name) => ({
            name,
          })),
          migrationKey: ['id'],
        },
      ],
    },
  }
  const payload = {
    format: 'code-history@1',
    sourceGeneration: 'generation',
    sourceContract: 'contract',
    table: TABLE,
    records: [{ key, canonical: { key, values: cells }, raw }],
  }
  const bytes = new TextEncoder().encode(canonicalSchemaJson(payload))
  const archive = {
    formatVersion: 1,
    sourceGeneration: 'generation',
    sourceContract: 'contract',
    sourceTable: TABLE,
    rowCount: 1,
    rootDigest: `sha256:${sha256Hex(bytes)}`,
  }
  const [record] = decodeCodeHistoryPackage(bytes, archive, source)
  expect(record?.row).toEqual({
    id: 'id',
    big: 9007199254740993n,
    flag: true,
    bytes: new Uint8Array([0, 255]),
    json_text: ' { "a": 1 }\r\n',
    optional: null,
  })
  expect(record?.raw).toEqual(raw)
  expect(() =>
    decodeCodeHistoryPackage(bytes, archive, { ...source, sourceGeneration: 'other' }),
  ).toThrow('code-history-source-mismatch')
  expect(() =>
    decodeCodeHistoryPackage(bytes, archive, {
      ...source,
      contract: { ...source.contract, tables: [] },
    }),
  ).toThrow('code-history-contract-unsupported')
})

test('originally absent PG tables require an explicit empty package; key and positional shape corruption is rejected', () => {
  const source = { sourceGeneration: 'pg', contract: { digest: 'pg-contract', tables: [] } }
  const empty = historyFixtureArchive(TABLE, [], source)
  expect(decodeCodeHistoryPackage(empty.contentInlineBytes!, empty, source)).toEqual([])
  const typedSource = {
    ...source,
    contract: {
      ...source.contract,
      tables: [{ id: TABLE, columns: [{ name: 'id' }], migrationKey: ['id'] }],
    },
  }
  for (const canonical of [
    { key: [{ type: 'text', value: 'id' }], values: [] },
    { key: [{ type: 'text', value: 'id' }], values: [{ type: 'text', value: 'other' }] },
  ]) {
    const bytes = new TextEncoder().encode(
      canonicalSchemaJson({
        format: 'code-history@1',
        sourceGeneration: 'pg',
        sourceContract: 'pg-contract',
        table: TABLE,
        records: [{ key: [{ type: 'text', value: 'id' }], canonical, raw: null }],
      }),
    )
    expect(() =>
      decodeCodeHistoryPackage(
        bytes,
        { ...empty, rowCount: 1, rootDigest: `sha256:${sha256Hex(bytes)}` },
        typedSource,
      ),
    ).toThrow(/code-history-(record-invalid|key-mismatch)/)
  }
})

function runtimeImportClosure(
  root: string,
  entries: readonly string[],
  read: (file: string) => string | undefined,
): ReadonlySet<string> {
  const seen = new Set<string>()
  const walk = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    const text = read(file)
    if (text === undefined) throw new Error(`unresolved runtime entry: ${file}`)
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const follow = (literal: ts.Expression): void => {
      if (!ts.isStringLiteralLike(literal)) throw new Error(`nonliteral runtime import in ${file}`)
      const spec = literal.text
      const next = spec.startsWith('@/')
        ? resolve(root, spec.slice(2))
        : spec.startsWith('.')
          ? resolve(dirname(file), spec)
          : null
      if (next === null) return
      const stem = next.replace(/\.(?:[cm]?js|jsx)$/, '')
      const candidates = [
        next,
        ...['.ts', '.tsx', '.mts', '.cts', '.js', '/index.ts', '/index.tsx', '/index.js'].map(
          (suffix) => stem + suffix,
        ),
      ]
      const resolved = candidates.find((candidate) => read(candidate) !== undefined)
      if (resolved === undefined) throw new Error(`unresolved runtime import ${spec} in ${file}`)
      walk(resolved)
    }
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause
        const bindings = clause?.namedBindings
        const onlyTypes =
          clause?.isTypeOnly ||
          (!clause?.name &&
            bindings &&
            ts.isNamedImports(bindings) &&
            bindings.elements.length > 0 &&
            bindings.elements.every((e) => e.isTypeOnly))
        if (!onlyTypes) follow(node.moduleSpecifier)
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const clause = node.exportClause
        const onlyTypes =
          node.isTypeOnly ||
          (clause &&
            ts.isNamedExports(clause) &&
            clause.elements.length > 0 &&
            clause.elements.every((e) => e.isTypeOnly))
        if (!onlyTypes) follow(node.moduleSpecifier)
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        !node.isTypeOnly &&
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression
      ) {
        follow(node.moduleReference.expression)
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        if (!node.arguments[0]) throw new Error(`runtime import without an argument in ${file}`)
        follow(node.arguments[0])
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  entries.forEach(walk)
  return seen
}

test('the import walker follows directory barrels, value re-exports and nested lazy imports but excludes type-only edges', () => {
  const root = '/virtual-history-src'
  const files = new Map(
    Object.entries({
      '/entry.ts': `import { value } from './barrel'; export * from '@/exports'; export { named } from './named'; const lazy = () => import('./lazy'); const cjs = () => require('./cjs'); import alias = require('./alias'); import './side'; import type { A } from './types'; export type { B } from './types'; import { type C } from './types'; export { type D } from './types';`,
      '/barrel/index.ts': `export { value } from '../leaf.js'`,
      '/leaf.ts': 'export const value = 1',
      '/exports/index.ts': `export * from '../entry'`,
      '/named.ts': 'export const named = 1',
      '/lazy/index.ts': `export * from '@/platform/persistence/migration/conversion/engine'`,
      '/platform/persistence/migration/conversion/engine.ts': 'export const convert = 1',
      '/cjs/index.ts': '',
      '/alias/index.ts': '',
      '/side.ts': '',
      '/types.ts': `import './missing'`,
    }).map(([path, text]) => [root + path, text]),
  )
  const seen = runtimeImportClosure(root, [root + '/entry.ts'], (file) => files.get(file))
  expect([...seen].sort()).toEqual(
    [...files.keys()].filter((file) => !file.endsWith('/types.ts')).sort(),
  )
  expect([...seen].filter((file) => file.includes('/persistence/migration/'))).toEqual([
    root + '/platform/persistence/migration/conversion/engine.ts',
  ])
  expect(() =>
    runtimeImportClosure(root, [root + '/broken.ts'], (file) =>
      file === root + '/broken.ts' ? `export * from './missing'` : undefined,
    ),
  ).toThrow('unresolved runtime import')
})

test('the normal history import closure never loads converter, source-reader or runner code', () => {
  const root = resolve(import.meta.dir, '../src')
  const entries = [
    'composition/historyQueries',
    'infrastructure/history/packageReader',
    'infrastructure/workItemProjectionRead',
    'infrastructure/roundAttemptsRead',
    'infrastructure/deliveryChainRead',
    'infrastructure/codeMetricsRead',
  ].map((file) => resolve(root, `modules/code-capability/${file}.ts`))
  const seen = runtimeImportClosure(root, entries, (file) => {
    try {
      return statSync(file).isFile() ? readFileSync(file, 'utf8') : undefined
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
        return undefined
      throw error
    }
  })
  for (const file of seen) expect(file).not.toContain('/persistence/migration/')
  expect(seen.has(entries[0]!)).toBe(true)
  expect(seen.size).toBeGreaterThan(5)
})
