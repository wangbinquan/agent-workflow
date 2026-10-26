// RFC-395 I-b: native table objects stay in schema/bootstrap/provider wiring; business queries use session tables.
import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'

const root = resolve(import.meta.dir, '../../src')
const tableSymbols: ReadonlySet<string> = new Set(
  persistenceSchema.tables.map((table) => table.schemaSymbol),
)
function wiring(path: string): boolean {
  return (
    path.startsWith('platform/persistence/') ||
    /^(?:modules\/[^/]+|platform\/[^/]+)\/(?:infrastructure\/persistence|composition)\/schema\.ts$/.test(
      path,
    ) ||
    [
      'bootstrap/persistenceSchema.ts',
      'bootstrap/persistenceSchema.ts',
      'db/client.ts',
      'db/observation.ts',
      'db/graphDevelopment.ts',
    ].includes(path)
  )
}
function target(path: string, specifier: string): string {
  if (specifier.startsWith('@/')) return specifier.slice(2)
  return specifier.startsWith('.')
    ? relative(root, resolve(root, path, '..', specifier)).replaceAll('\\', '/')
    : specifier
}
export function directNativeTableImports(path: string, text: string): readonly string[] {
  if (wiring(path)) return []
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const violations: string[] = []
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const clause = statement.importClause
    if (!clause || clause.isTypeOnly || !clause.namedBindings) continue
    const destination = target(path, statement.moduleSpecifier.text).replace(/\.ts$/, '')
    const schemaModule =
      /^(?:db\/(?:schema|observation|graphDevelopment)|bootstrap\/persistenceSchema)$/.test(
        destination,
      ) ||
      /\/(?:composition|infrastructure\/persistence)\/schema$/.test(destination) ||
      destination.endsWith('/legacySqliteTransportMechanisms')
    const names = clause.namedBindings
    if (ts.isNamespaceImport(names) && schemaModule) violations.push(names.name.text)
    if (ts.isNamedImports(names))
      for (const item of names.elements) {
        if (item.isTypeOnly) continue
        const imported = (item.propertyName ?? item.name).text
        if (schemaModule && (tableSymbols.has(imported) || imported === 'nativeTableSets'))
          violations.push(imported)
        if (
          ['drizzle-orm/sqlite-core', 'drizzle-orm/pg-core'].includes(destination) &&
          ['sqliteTable', 'pgTable', 'pgSchema'].includes(imported)
        )
          violations.push(imported)
      }
  }
  return violations
}
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : []
  })
}

describe('RFC-395 I-b native table import boundary', () => {
  test('every business consumer obtains tables from its native handle', () => {
    const files = sources(root)
    expect(files.length).toBeGreaterThan(1000)
    const consumers = files.filter((file) =>
      readFileSync(file, 'utf8').includes('persistence/sessionTables'),
    )
    expect(consumers.length).toBeGreaterThan(200)
    expect(
      files.flatMap((file) => {
        const path = relative(root, file).replaceAll('\\', '/')
        return directNativeTableImports(path, readFileSync(file, 'utf8')).map(
          (name) => `${path}: ${name}`,
        )
      }),
    ).toEqual([])
  })
  test('negative controls cover aliases, namespaces, contribution entry points and direct constructors', () => {
    const path = 'modules/example/infrastructure/store.ts'
    expect(directNativeTableImports(path, "import { tasks as t } from '@/db/schema'")).toEqual([
      'tasks',
    ])
    expect(directNativeTableImports(path, "import * as t from '../../../db/schema'")).toEqual(['t'])
    expect(
      directNativeTableImports(
        path,
        "import { tasks } from '@/modules/task-execution/composition/schema'",
      ),
    ).toEqual(['tasks'])
    expect(
      directNativeTableImports(
        path,
        "import { nativeTableSets } from '@/bootstrap/persistenceSchema'",
      ),
    ).toEqual(['nativeTableSets'])
    expect(
      directNativeTableImports(path, "import { pgSchema as schema } from 'drizzle-orm/pg-core'"),
    ).toEqual(['pgSchema'])
    expect(
      directNativeTableImports(path, "import { sqliteTable } from 'drizzle-orm/sqlite-core'"),
    ).toEqual(['sqliteTable'])
  })
  test('neutral access, type-only imports and actual schema wiring remain allowed', () => {
    expect(
      directNativeTableImports(
        'modules/x/infrastructure/store.ts',
        "import { tablesOf } from '@/platform/persistence/sessionTables'",
      ),
    ).toEqual([])
    expect(
      directNativeTableImports(
        'modules/x/infrastructure/store.ts',
        "import type { tasks } from '@/db/schema'",
      ),
    ).toEqual([])
    expect(
      directNativeTableImports(
        'platform/persistence/schema/drizzle.ts',
        "import { sqliteTable } from 'drizzle-orm/sqlite-core'",
      ),
    ).toEqual([])
  })
})
