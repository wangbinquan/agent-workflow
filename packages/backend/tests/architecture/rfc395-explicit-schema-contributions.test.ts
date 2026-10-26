// RFC-395 I-a: declarations live in explicit contributions and bootstrap alone assembles the registry.
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { isSchemaDeclarationFile } from './schemaRoles'
import { packageSrcUnits, sourceUnit, importEdges, type SourceUnit } from './census'

const ROOT = resolve(import.meta.dir, '../../../..')
const BOOTSTRAP = 'packages/backend/src/bootstrap/persistenceSchema.ts'
const FROZEN_CONVERTER = 'packages/backend/src/platform/persistence/migration/epoch1/definitions.ts'
const ASSEMBLY_ROOTS = new Set([BOOTSTRAP, FROZEN_CONVERTER])
const MECHANISM = 'packages/backend/src/platform/persistence/schema/'
function violations(unit: SourceUnit): string[] {
  const out: string[] = []
  const factories = new Set(['sqliteTable', 'providerAwareSqliteTable'])
  const registries = new Set(['createSchemaRegistry'])
  for (const statement of unit.source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamedImports(bindings))
      for (const binding of bindings.elements) {
        const original = (binding.propertyName ?? binding.name).text
        if (factories.has(original)) factories.add(binding.name.text)
        if (original === 'createSchemaRegistry') registries.add(binding.name.text)
      }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : ''
      if (factories.has(name) && unit.path !== MECHANISM + 'drizzle.ts')
        out.push('table declaration outside materializer')
      if (registries.has(name) && !ASSEMBLY_ROOTS.has(unit.path))
        out.push('registry assembled outside bootstrap')
    }
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  for (const edge of importEdges(unit)) {
    if (
      unit.path.includes('/src/modules/') &&
      /\/bootstrap\/persistenceSchema$/.test(edge.specifier)
    )
      out.push('business module imports registry')
    if (
      (unit.path.startsWith(MECHANISM) || unit.path.includes('/persistence/migration/legacy/')) &&
      (edge.specifier.startsWith('@/modules/') ||
        /\/bootstrap\/persistenceSchema$/.test(edge.specifier))
    )
      out.push('platform imports application composition')
  }
  return out
}
describe('RFC-395 I-a explicit schema structural lock', () => {
  const units = packageSrcUnits(ROOT, 'backend')
  test('one live assembly and one frozen source own all direct declarations', () => {
    expect(units.length).toBeGreaterThan(1000)
    expect(units.filter((unit) => unit.path === BOOTSTRAP)).toHaveLength(1)
    expect(units.filter((unit) => unit.path === FROZEN_CONVERTER)).toHaveLength(1)
    expect(
      units.flatMap((unit) => violations(unit).map((reason) => `${unit.path}: ${reason}`)),
    ).toEqual([])
    expect(units.find((unit) => unit.path === 'packages/backend/src/db/schema.ts')).toBeUndefined()
  })
  test('every table has one explicit owner, ordered codecs, and an exported owner contribution', async () => {
    for (const contribution of persistenceSchema.contributions) {
      expect(contribution.owner.length).toBeGreaterThan(0)
      for (const table of contribution.tables) {
        expect(table.owner).toBe(contribution.owner)
        expect(
          Object.values(table.columns).every(
            (column) => typeof column.codec === 'string' && column.codec.length > 0,
          ),
        ).toBe(true)
      }
    }
    const contributions = units.filter((unit) =>
      unit.path.endsWith('/infrastructure/persistence/schema.ts'),
    )
    const expectedPaths = [
      ...new Set(
        persistenceSchema.contributions.map((entry) => {
          const area = entry.owner.startsWith('platform/')
            ? entry.owner
            : `modules/${entry.owner.split('/')[0]}`
          return `packages/backend/src/${area}/infrastructure/persistence/schema.ts`
        }),
      ),
    ].sort()
    expect(contributions.map((unit) => unit.path).sort()).toEqual(expectedPaths)
    for (const contribution of persistenceSchema.contributions) {
      const area = contribution.owner.startsWith('platform/')
        ? contribution.owner
        : `modules/${contribution.owner.split('/')[0]}`
      const file = `packages/backend/src/${area}/infrastructure/persistence/schema.ts`
      const declarations = (await import(resolve(ROOT, file))) as Record<string, unknown>
      const entry = (await import(
        resolve(
          ROOT,
          file.replace('/infrastructure/persistence/schema.ts', '/composition/schema.ts'),
        )
      )) as Record<string, unknown>
      expect(
        Object.values(declarations).filter(
          (value) =>
            value !== null &&
            typeof value === 'object' &&
            'tables' in value &&
            value.tables === contribution.tables,
        ),
        contribution.owner,
      ).toHaveLength(1)
      expect(
        Object.values(entry).filter(
          (value) =>
            value !== null &&
            typeof value === 'object' &&
            'tables' in value &&
            value.tables === contribution.tables,
        ),
        contribution.owner,
      ).toHaveLength(1)
    }
    for (const unit of contributions) {
      const composition = units.find(
        (item) =>
          item.path ===
          unit.path.replace('/infrastructure/persistence/schema.ts', '/composition.ts'),
      )
      expect(composition?.text, unit.path).toContain('schemaContribution')
    }
  })
  test('negative fixture: aliases cannot reintroduce physical declarations or extra registries', () => {
    expect(
      violations(
        sourceUnit(
          'packages/backend/src/db/schema.ts',
          `import { sqliteTable as table } from 'drizzle-orm/sqlite-core'; const t = table('x',{})`,
        ),
      ),
    ).toEqual(['table declaration outside materializer'])
    expect(
      violations(
        sourceUnit(
          'packages/backend/src/platform/rogue.ts',
          `import { createSchemaRegistry as collect } from './registry'; collect([])`,
        ),
      ),
    ).toEqual(['registry assembled outside bootstrap'])
    expect(
      violations(
        sourceUnit(
          'packages/backend/src/modules/example/store.ts',
          `import { persistenceSchema } from '@/bootstrap/persistenceSchema'`,
        ),
      ),
    ).toEqual(['business module imports registry'])
  })
  test('negative fixture: another bootstrap file is still not an assembly root', () => {
    expect(
      violations(
        sourceUnit(
          'packages/backend/src/bootstrap/rogue.ts',
          "import { createSchemaRegistry as collect } from '@/platform/persistence/schema/registry'; collect([])",
        ),
      ),
    ).toEqual(['registry assembled outside bootstrap'])
    expect(
      violations(
        sourceUnit(
          'packages/backend/src/modules/example/store.ts',
          "import { persistenceSchema } from '@/bootstrap/persistenceSchema'",
        ),
      ),
    ).toEqual(['business module imports registry'])
  })
  test('only the frozen converter registry is an additional assembly root', () => {
    const code =
      "import { createSchemaRegistry } from '@/platform/persistence/schema/registry'; createSchemaRegistry([])"
    expect(violations(sourceUnit(FROZEN_CONVERTER, code))).toEqual([])
    expect(
      violations(sourceUnit(FROZEN_CONVERTER.replace('definitions.ts', 'reader.ts'), code)),
    ).toEqual(['registry assembled outside bootstrap'])
  })
  test('declaration roles exclude schema wiring while retaining runtime consumers', () => {
    for (const path of [
      'modules/example/infrastructure/persistence/schema.ts',
      'modules/example/composition/schema.ts',
      'bootstrap/persistenceSchema.ts',
      'db/schema.ts',
      'db/observation.ts',
      'db/graphDevelopment.ts',
    ])
      expect(isSchemaDeclarationFile(path), path).toBe(true)
    const root = 'modules/example/composition.ts'
    const reexport = "export { schemaContribution } from './composition/schema'"
    expect(isSchemaDeclarationFile(root, reexport)).toBe(true)
    expect(isSchemaDeclarationFile(root, `${reexport}; readTable('legacy_rows')`)).toBe(false)
    expect(isSchemaDeclarationFile('modules/example/infrastructure/store.ts', reexport)).toBe(false)
    expect(
      isSchemaDeclarationFile(
        'platform/persistence/migration/reader.ts',
        "readTable('legacy_rows')",
      ),
    ).toBe(false)
  })
})
