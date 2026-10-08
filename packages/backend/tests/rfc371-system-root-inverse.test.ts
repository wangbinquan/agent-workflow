// Full original bootstrap body oracles remain in their existing RFC-370 suites.
// These regressions reject disconnected System capture rather than normalizing it away.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import reviewed from './helpers/taskLaunchRootStatementInverse.json'
import { inverseTaskLaunchRootStatements } from './helpers/taskLaunchRootStatementInverse'

for (const entry of reviewed.roots) {
  const path = resolve(import.meta.dir, '../../..', entry.path)
  const source = () =>
    ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  test(`${entry.rootName}: exact System inverse preserves the original parent/root and complete statement population`, () => {
    const actual = source()
    const restored = inverseTaskLaunchRootStatements(actual, entry.rootName)
    const root = restored.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === entry.rootName,
    )
    expect(root?.body?.statements).toHaveLength(entry.expectedPreviousStatementCount)
    expect(restored.fileName).toBe(actual.fileName)
  })
  for (const lostField of ['nativeUsage', 'observations'] as const) {
    test(`${entry.rootName}: removing the actual System ${lostField} binding is rejected`, () => {
      const actual = source()
      const root = actual.statements.find(
        (node): node is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(node) && node.name?.text === entry.rootName,
      )
      const statement = root!.body!.statements.find(
        (node) =>
          ts.isVariableStatement(node) &&
          node.declarationList.declarations.some(
            (declaration) =>
              ts.isIdentifier(declaration.name) &&
              declaration.name.text === 'systemAgentObservations',
          ),
      )!
      const original = statement.getText(actual)
      expect(original).toContain(lostField)
      const changed = original.replace(lostField, 'disconnectedSystemSource')
      const text =
        actual.text.slice(0, statement.getStart(actual)) +
        changed +
        actual.text.slice(statement.end)
      const disconnected = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
      expect(() => inverseTaskLaunchRootStatements(disconnected, entry.rootName)).toThrow(
        'task-launch inverse unreviewed statement: systemAgentObservations',
      )
    })
  }
}
