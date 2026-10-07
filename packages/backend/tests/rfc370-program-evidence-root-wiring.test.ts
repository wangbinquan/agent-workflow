// RFC-370 A2: actual session, daemon and standalone roots share selected
// program artifacts and all evidence read faces; no daemon starts here.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

function source(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(resolve(import.meta.dir, '..', 'src', path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
}
function descendants(node: ts.Node, match: (item: ts.Node) => boolean): ts.Node[] {
  const result: ts.Node[] = []
  function visit(item: ts.Node): void {
    if (match(item)) result.push(item)
    ts.forEachChild(item, visit)
  }
  visit(node)
  return result
}
function declaration(file: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const result = file.statements.filter(
    (item): item is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(item) && item.name?.text === name && item.body !== undefined,
  )
  expect(result).toHaveLength(1)
  return result[0]!
}
function calls(node: ts.Node, file: ts.SourceFile, name: string): ts.CallExpression[] {
  return descendants(
    node,
    (item) => ts.isCallExpression(item) && item.expression.getText(file) === name,
  ).filter(ts.isCallExpression)
}
const compact = (node: ts.Node, file: ts.SourceFile): string =>
  node.getText(file).replace(/\s/g, '')

const start = source('cli/start.ts')
const pg = source('cli/postgresqlDaemonApplication.ts')
const server = source('server.ts')

function selected(node: ts.Node, file: ts.SourceFile, name: string, property: string): void {
  const found = calls(node, file, name)
  expect(found).toHaveLength(1)
  expect(compact(found[0]!.arguments[0]!, file)).toContain(property)
}

test('provider session and recompose retain both bootstrap selections', () => {
  const root = declaration(start, 'startCommand')
  const inputs = descendants(
    root,
    (item) => ts.isVariableDeclaration(item) && item.name.getText(start) === 'sessionInput',
  ).filter(ts.isVariableDeclaration)
  expect(inputs).toHaveLength(1)
  for (const key of ['employeePrograms', 'evidenceRead', 'evidenceDocumentCommands']) {
    expect(compact(inputs[0]!, start)).toContain(`${key}:opts.${key},`)
    selected(
      declaration(start, 'composePostgresqlProviderSession'),
      start,
      'composePostgresqlDaemonApplication',
      `${key}:input.${key},`,
    )
    selected(
      declaration(start, 'composeSqliteProviderSession'),
      start,
      'composeSqliteAppDeps',
      `${key}:input.${key},`,
    )
  }
})

test('both daemon owners consume the same program and evidence read selection', () => {
  for (const [file, rootName, receiver] of [
    [start, 'composeSqliteProviderSession', 'input'],
    [pg, 'composePostgresqlApplication', 'input'],
  ] as const) {
    const root = declaration(file, rootName)
    selected(root, file, 'composeDigitalEmployee', `programArtifacts:${receiver}.employeePrograms,`)
    selected(root, file, 'composeDevelopmentAutomation', `evidenceRead:${receiver}.evidenceRead,`)
    selected(
      root,
      file,
      'composeDevelopmentAutomation',
      'evidenceDocumentCommands:developmentPurposeRoot.requirement.documentCommands,',
    )
    selected(
      root,
      file,
      'composeDevelopmentPurposeRoot',
      `evidenceDocumentCommands:${receiver}.evidenceDocumentCommands,`,
    )
    selected(
      root,
      file,
      'composeDevelopmentPurposeRoot',
      `selection:${receiver}.developmentPurposes,`,
    )
  }
})

test('standalone HTTP consumers preserve the selected receiver through fallback composition', () => {
  selected(
    declaration(server, 'composeSqliteApiRouteMounts'),
    server,
    'composeDigitalEmployee',
    'programArtifacts:deps.employeePrograms,',
  )
  selected(
    declaration(server, 'composeFallbackDevelopmentAutomation'),
    server,
    'composeDevelopmentAutomation',
    'evidenceRead:deps.evidenceRead,',
  )
  selected(
    declaration(server, 'composeFallbackDevelopmentAutomation'),
    server,
    'composeDevelopmentAutomation',
    'evidenceDocumentCommands:deps.developmentPurposeRoot.requirement.documentCommands,',
  )
  selected(
    declaration(server, 'composeSqliteApplicationDeps'),
    server,
    'composeDevelopmentPurposeRoot',
    'evidenceDocumentCommands:deps.evidenceDocumentCommands,',
  )
  selected(
    declaration(server, 'composeSqliteApplicationDeps'),
    server,
    'composeDevelopmentPurposeRoot',
    'selection:deps.developmentPurposes,',
  )
})
