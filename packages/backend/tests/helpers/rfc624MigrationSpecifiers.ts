// RFC-624 & RFC-629: the exact parser used by the shared scan and every original negative fixture.
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const slash = (path: string) => path.split('\\').join('/')

export interface MigrationSpecifierSite {
  readonly target: string
  /** Original exported names bound by static import/export-from clauses (`*` for namespace/star). */
  readonly namedImports: readonly string[]
}

export function resolveMigrationSpecifierSites(
  SRC: string,
  path: string,
  text: string,
): MigrationSpecifierSite[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: MigrationSpecifierSite[] = []
  const add = (specifier: string, namedImports: readonly string[] = []) => {
    const bare = specifier.replace(/\.(?:[cm]?tsx?|[cm]?js)$/, '')
    const target = bare.startsWith('@/')
      ? join(SRC, bare.slice(2))
      : bare.startsWith('.')
        ? resolve(dirname(path), bare)
        : null
    if (target === null) return
    const below = slash(relative(SRC, target))
    if (!below.startsWith('..')) out.push({ target: below, namedImports })
  }
  const visit = (node: ts.Node) => {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const bindings = node.importClause?.namedBindings
      const namedImports: string[] = []
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          namedImports.push((element.propertyName ?? element.name).text)
        }
      } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        namedImports.push('*')
      }
      add(node.moduleSpecifier.text, namedImports)
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const clause = node.exportClause
      const namedImports: string[] = []
      if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          namedImports.push((element.propertyName ?? element.name).text)
        }
      } else {
        namedImports.push('*')
      }
      add(node.moduleSpecifier.text, namedImports)
    }
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      add(node.argument.literal.text)
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText(source)
      const first = node.arguments[0]
      if (
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          callee === 'require' ||
          callee === 'mock.module' ||
          callee === 'import.meta.resolve') &&
        first !== undefined &&
        ts.isStringLiteralLike(first)
      )
        add(first.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

export function resolveMigrationSpecifiers(SRC: string, path: string, text: string): string[] {
  return resolveMigrationSpecifierSites(SRC, path, text).map((site) => site.target)
}
