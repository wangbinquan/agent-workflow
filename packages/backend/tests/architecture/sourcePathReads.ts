import { dirname, isAbsolute, resolve } from 'node:path'
import ts from 'typescript'

/** Resolve literal source reads without leaking callback-local names into siblings. */
export function sourcePathReads(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const paths: string[] = []
  type Bindings = Map<string, string | null>
  const literalPath = (node: ts.Node, bindings: Bindings): string | null => {
    if (ts.isStringLiteralLike(node)) return node.text
    if (ts.isIdentifier(node)) return bindings.get(node.text) ?? null
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'dir' &&
      ts.isMetaProperty(node.expression)
    )
      return dirname(file)
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ['resolve', 'join'].includes(node.expression.text)
    ) {
      const parts = node.arguments.map((argument) => literalPath(argument, bindings))
      if (!parts.length || parts.some((part) => part === null) || !isAbsolute(parts[0]!))
        return null
      return resolve(...(parts as string[]))
    }
    return null
  }
  const visit = (node: ts.Node, inherited: Bindings, insideExpect = false): void => {
    const bindings = ts.isBlock(node) || ts.isFunctionLike(node) ? new Map(inherited) : inherited
    // Unknown parameters and initializers still shadow a known outer name.
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters)
        if (ts.isIdentifier(parameter.name)) bindings.set(parameter.name.text, null)
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      bindings.set(
        node.name.text,
        node.initializer ? literalPath(node.initializer, bindings) : null,
      )
    }
    const expectScope =
      insideExpect ||
      (ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'expect')
    if (
      !insideExpect &&
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'readFileSync' &&
      node.arguments[0]
    ) {
      const target = literalPath(node.arguments[0], bindings)
      if (target !== null) paths.push(target)
    }
    ts.forEachChild(node, (child) => visit(child, bindings, expectScope))
  }
  visit(source, new Map())
  return paths
}
