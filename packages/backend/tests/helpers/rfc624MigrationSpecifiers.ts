// RFC-624: the exact parser used by the shared scan and every original negative fixture.
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const slash = (path: string) => path.split('\\').join('/')

export function resolveMigrationSpecifiers(SRC: string, path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  const add = (specifier: string) => {
    const bare = specifier.replace(/\.(?:[cm]?tsx?|[cm]?js)$/, '')
    const target = bare.startsWith('@/')
      ? join(SRC, bare.slice(2))
      : bare.startsWith('.')
        ? resolve(dirname(path), bare)
        : null
    if (target === null) return
    const below = slash(relative(SRC, target))
    if (!below.startsWith('..')) out.push(below)
  }
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      add(node.moduleSpecifier.text)
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
