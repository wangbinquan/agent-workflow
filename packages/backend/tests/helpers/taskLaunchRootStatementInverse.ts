import { createHash } from 'node:crypto'
import ts from 'typescript'
import reviewed from './taskLaunchRootStatementInverse.json'

/** Restore only exact reviewed root additions before the existing complete-body oracles. */
export function inverseTaskLaunchRootStatements(
  source: ts.SourceFile,
  rootName?: string,
): ts.SourceFile {
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
