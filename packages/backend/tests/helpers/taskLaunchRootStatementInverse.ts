import { createHash } from 'node:crypto'
import ts from 'typescript'
import reviewed from './taskLaunchRootStatementInverse.json'
import lifecycleCallers from '../fixtures/rfc370-task-runtime-lifecycle-original-callers.json'

/** Remove only the six RFC-370 lifecycle selections before the older root inverse. */
export function inverseTaskRuntimeLifecycleRootSelections(source: ts.SourceFile): ts.SourceFile {
  const path = lifecycleCallers.wholeCallers.find(
    (row) =>
      (row.path.includes('/cli/') || row.path.endsWith('/server.ts')) &&
      source.fileName.endsWith(row.path.slice('packages/backend/src/'.length)),
  )?.path
  if (path === undefined) throw new Error('task-lifecycle inverse root is not declared')
  const expected = lifecycleCallers.calls.filter((row) => row.path === path)
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'trySet' &&
      ts.isCallExpression(node.expression.expression) &&
      node.expression.expression.expression.getText(source) === 'selectTaskRuntimeLifecycleWrites'
    )
      calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  if (calls.length !== expected.length)
    throw new Error('task-lifecycle inverse selected call population changed')
  const printer = ts.createPrinter({ removeComments: true })
  const print = (node: ts.Node, file: ts.SourceFile) =>
    printer.printNode(ts.EmitHint.Unspecified, node, file)
  const edits: { start: number; end: number; text: string }[] = []
  for (const [i, call] of calls.entries()) {
    const old = expected[i]!
    const prior = ts.createSourceFile('original-call.ts', old.call, ts.ScriptTarget.Latest, true)
    const statement = prior.statements[0]
    if (
      statement === undefined ||
      !ts.isExpressionStatement(statement) ||
      !ts.isCallExpression(statement.expression)
    )
      throw new Error('task-lifecycle inverse original call is invalid')
    const callee = call.expression as ts.PropertyAccessExpression
    const selection = callee.expression as ts.CallExpression
    if (
      selection.arguments.length !== 2 ||
      selection.arguments[0]!.getText(source) + '.runtimeLifecycle.trySet' !== old.callee ||
      !ts.isStringLiteral(selection.arguments[1]!) ||
      (selection.arguments[1] as ts.StringLiteral).text !== old.purpose ||
      JSON.stringify(call.arguments.map((node) => print(node, source))) !==
        JSON.stringify(statement.expression.arguments.map((node) => print(node, prior)))
    )
      throw new Error(`task-lifecycle inverse unreviewed call: ${old.id}`)
    edits.push({ start: callee.getStart(source), end: callee.end, text: old.callee })
  }
  let text = source.text
  for (const edit of edits.reverse())
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end)
  return ts.createSourceFile(source.fileName, text, ts.ScriptTarget.Latest, true)
}

/** Restore only exact reviewed root additions before the existing complete-body oracles. */
export function inverseTaskLaunchRootStatements(
  source: ts.SourceFile,
  rootName?: string,
): ts.SourceFile {
  source = inverseTaskRuntimeLifecycleRootSelections(source)
  const entry = reviewed.roots.find(
    (row) =>
      source.fileName.endsWith(row.path.slice('packages/backend/src/'.length)) &&
      (rootName === undefined || row.rootName === rootName),
  )
  if (entry === undefined) throw new Error('task-launch inverse root is not declared')
  const roots = source.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) &&
      node.name?.text === entry.rootName &&
      node.body !== undefined,
  )
  if (roots.length !== 1) throw new Error('task-launch inverse requires one actual root')
  const body = roots[0]!.body!
  if (body.statements.length !== entry.expectedCurrentStatementCount)
    throw new Error('task-launch inverse current statement population changed')
  const printer = ts.createPrinter({ removeComments: true })
  const pending = new Map(entry.changes.map((change) => [change.name, change]))
  const replacements: { start: number; end: number; text: string }[] = []
  for (const statement of body.statements) {
    if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1)
      continue
    const declaration = statement.declarationList.declarations[0]!
    if (!ts.isIdentifier(declaration.name)) continue
    const change = pending.get(declaration.name.text)
    if (change === undefined) continue
    const text = printer.printNode(ts.EmitHint.Unspecified, statement, source)
    if (createHash('sha256').update(text).digest('hex') !== change.introducedSha256)
      throw new Error(`task-launch inverse unreviewed statement: ${change.name}`)
    replacements.push({
      start: statement.getStart(source),
      end: statement.end,
      text: change.previousStatement ?? '',
    })
    pending.delete(change.name)
  }
  if (pending.size !== 0) throw new Error('task-launch inverse is missing reviewed statements')
  let text = source.text
  for (const replacement of replacements.reverse())
    text = text.slice(0, replacement.start) + replacement.text + text.slice(replacement.end)
  const restored = ts.createSourceFile(source.fileName, text, ts.ScriptTarget.Latest, true)
  const root = restored.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === entry.rootName,
  )
  if (root?.body?.statements.length !== entry.expectedPreviousStatementCount)
    throw new Error('task-launch inverse previous statement population changed')
  return restored
}
