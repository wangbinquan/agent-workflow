// RFC-395 I-a: consumer censuses share declaration roles, independent of DSL syntax.
import ts from 'typescript'

/** Schema declarations and schema-only re-exports do not consume persisted rows. */
export function isSchemaDeclarationFile(path: string, text = ''): boolean {
  const relative = path.replace(/^packages\/backend\/src\//, '')
  if (/^(?:modules|platform)\/[^/]+\/infrastructure\/persistence\/schema\.ts$/.test(relative))
    return true
  if (/^(?:modules|platform)\/[^/]+\/composition\/schema\.ts$/.test(relative)) return true
  if (
    new Set([
      'bootstrap/persistenceSchema.ts',
      'db/schema.ts',
      'db/observation.ts',
      'db/graphDevelopment.ts',
      'platform/persistence/schemaContract.ts',
      'platform/persistence/schema/contractTypes.ts',
      'platform/persistence/migration/legacy/v2Contract.ts',
    ]).has(relative)
  )
    return true
  if (!/^(?:modules|platform)\/[^/]+\/composition\.ts$/.test(relative)) return false
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  return (
    source.statements.length > 0 &&
    source.statements.every(
      (statement) =>
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier !== undefined &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        /(?:infrastructure\/persistence\/schema|composition\/schema)$/.test(
          statement.moduleSpecifier.text,
        ),
    )
  )
}
