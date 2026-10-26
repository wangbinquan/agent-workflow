// RFC-395 II-b: follow the explicit target aggregate split and lineage builder, never an opaque spread.
import ts from 'typescript'

export function enclosingFunction(node: ts.Node): ts.Node {
  let scope = node.parent
  while (scope.parent) {
    // transactionStep defers a generator step; its callback reads the generator's lexical locals.
    const step =
      ts.isArrowFunction(scope) &&
      ts.isCallExpression(scope.parent) &&
      ts.isIdentifier(scope.parent.expression) &&
      scope.parent.expression.text === 'transactionStep'
    if (ts.isFunctionLike(scope) && !step) break
    scope = scope.parent
  }
  return scope
}

export function tableMember(node: ts.Node | undefined, name: string): boolean {
  return (
    node !== undefined &&
    ((ts.isIdentifier(node) && node.text === name) ||
      (ts.isPropertyAccessExpression(node) && node.name.text === name) ||
      (ts.isElementAccessExpression(node) &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === name))
  )
}

export function returnedKeys(text: string, functionName: string, member?: string): Set<string> {
  const source = ts.createSourceFile('builder.ts', text, ts.ScriptTarget.Latest, true)
  const fn = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === functionName,
  )
  const result = fn?.body?.statements.find(ts.isReturnStatement)?.expression
  if (!result || !ts.isObjectLiteralExpression(result)) return new Set()
  const nested = member
    ? result.properties.find(
        (node): node is ts.PropertyAssignment =>
          ts.isPropertyAssignment(node) && node.name.getText(source) === member,
      )?.initializer
    : result
  if (!nested || !ts.isObjectLiteralExpression(nested)) return new Set()
  return new Set(
    nested.properties.flatMap((node) =>
      ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)
        ? [node.name.getText(source)]
        : [],
    ),
  )
}

export function importedCallResult(
  source: ts.SourceFile,
  local: string,
  factory: string,
  module: string,
  scope: ts.Node = source,
): boolean {
  const imported = source.statements.some(
    (node) =>
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === module &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings) &&
      node.importClause.namedBindings.elements.some(
        (binding) => binding.name.text === factory && !binding.propertyName,
      ),
  )
  if (!imported) return false
  let found = false
  const visit = (node: ts.Node): void => {
    if (node !== scope && ts.isFunctionLike(node)) return
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === local &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === factory
    )
      found = true
    ts.forEachChild(node, visit)
  }
  visit(scope)
  return found
}
