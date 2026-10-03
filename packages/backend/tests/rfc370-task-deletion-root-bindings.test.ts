import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const load = (path: string) =>
  ts.createSourceFile(
    path,
    readFileSync(new URL('../src/' + path, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
const text = (node: ts.Node, source: ts.SourceFile) => node.getText(source).replace(/\s/g, '')
function nodes<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T): T[] {
  const found: T[] = []
  const visit = (node: ts.Node): void => {
    if (predicate(node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return found
}
function calls(root: ts.Node, source: ts.SourceFile, name: string) {
  return nodes(
    root,
    (node): node is ts.CallExpression =>
      ts.isCallExpression(node) && text(node.expression, source) === name,
  )
}
function object(node: ts.Node): ts.ObjectLiteralExpression {
  if (ts.isParenthesizedExpression(node)) return object(node.expression)
  expect(ts.isObjectLiteralExpression(node)).toBe(true)
  if (!ts.isObjectLiteralExpression(node)) throw new Error('explicit composition object required')
  return node
}
function property(
  value: ts.ObjectLiteralExpression,
  source: ts.SourceFile,
  name: string,
): ts.Expression {
  const matches = value.properties.filter(
    (node): node is ts.PropertyAssignment =>
      ts.isPropertyAssignment(node) && text(node.name, source) === name,
  )
  expect(matches).toHaveLength(1)
  return matches[0]!.initializer
}
function owner(node: ts.Node): ts.FunctionDeclaration {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (ts.isFunctionDeclaration(parent) && parent.name) return parent
  throw new Error('named real owner required')
}
function oneCall(source: ts.SourceFile, name: string): ts.CallExpression {
  const found = calls(source, source, name)
  expect(found).toHaveLength(1)
  return found[0]!
}
function arrowObject(node: ts.Node): ts.ObjectLiteralExpression {
  if (!ts.isArrowFunction(node)) throw new Error('real routes closure required')
  if (!ts.isBlock(node.body)) return object(node.body)
  const returns = node.body.statements.filter(ts.isReturnStatement)
  expect(returns).toHaveLength(1)
  return object(returns[0]!.expression!)
}

test('both actual provider route closures and standalone HTTP bind the same whole record', () => {
  for (const [path, name, fn] of [
    ['cli/start.ts', 'composeSqliteTaskExecutionProviderRuntime', 'composeSqliteProviderSession'],
    [
      'cli/postgresqlDaemonApplication.ts',
      'composePostgresqlTaskExecutionProviderRuntime',
      'composePostgresqlApplication',
    ],
  ]) {
    const source = load(path!),
      call = oneCall(source, name!)
    expect(owner(call).name!.text).toBe(fn!)
    const dependencies = object(call.arguments[1]!)
    expect(
      text(
        property(arrowObject(property(dependencies, source, 'routes')), source, 'effects'),
        source,
      ),
    ).toBe('input.taskDeletionEffects')
  }
  const source = load('server.ts'),
    call = oneCall(source, 'createTaskRouteOperations')
  expect(owner(call).name!.text).toBe('composeSqliteApiRouteMounts')
  expect(text(property(object(call.arguments[0]!), source, 'effects'), source)).toBe(
    'deps.taskDeletionEffects',
  )
})

test('both real boot recovery calls retain db and default store before the whole selected record', () => {
  for (const [path, fn, db] of [
    ['cli/start.ts', 'composeSqliteProviderSession', 'db'],
    ['cli/postgresqlDaemonApplication.ts', 'composePostgresqlApplication', 'input.db'],
  ]) {
    const source = load(path!),
      call = oneCall(source, 'recoverInterruptedTaskDeletes')
    expect(owner(call).name!.text).toBe(fn!)
    expect(call.arguments.map((argument) => text(argument, source))).toEqual([
      db!,
      'undefined',
      'input.taskDeletionEffects',
    ])
  }
})

test('frozen start choice reaches initial and replacement sessions, PG session and SQLite HTTP', () => {
  const source = load('cli/start.ts')
  const declarations = nodes(
    source,
    (node): node is ts.VariableDeclaration =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'sessionInput',
  )
  expect(declarations).toHaveLength(1)
  const initializer = declarations[0]!.initializer!
  if (!ts.isCallExpression(initializer)) throw new Error('frozen session input required')
  expect(text(initializer.expression, source)).toBe('Object.freeze')
  expect(
    text(property(object(initializer.arguments[0]!), source, 'taskDeletionEffects'), source),
  ).toBe('opts.taskDeletionEffects')
  const sessions = calls(source, source, 'composeDaemonProviderSession')
  expect(sessions).toHaveLength(2)
  for (const call of sessions) {
    const spreads = object(call.arguments[0]!).properties.filter(ts.isSpreadAssignment)
    expect(
      spreads.filter((spread) => text(spread.expression, source) === 'sessionInput'),
    ).toHaveLength(1)
  }
  for (const name of ['composePostgresqlDaemonApplication', 'composeSqliteAppDeps']) {
    const call = oneCall(source, name)
    expect(text(property(object(call.arguments[0]!), source, 'taskDeletionEffects'), source)).toBe(
      'input.taskDeletionEffects',
    )
  }
})

test('actual route delete forwards required activity and whole effects to the original shared owner', () => {
  const source = load('modules/task-execution/infrastructure/taskRouteOperations.ts'),
    call = oneCall(source, 'deleteTask')
  expect(owner(call).name!.text).toBe('createTaskRouteOperations')
  expect(call.arguments.slice(0, 2).map((node) => text(node, source))).toEqual([
    'dependencies.db',
    'taskId',
  ])
  const options = object(call.arguments[2]!)
  expect(text(property(options, source, 'activity'), source)).toBe('dependencies.activity')
  expect(text(property(options, source, 'effects'), source)).toBe('dependencies.effects')
})

test('root choice uses exact TE public type and SC offers its own independent native factory', () => {
  for (const [path, names] of [
    ['cli/start.ts', ['StartOptions', 'DaemonProviderSessionComposeInput']],
    ['cli/postgresqlDaemonApplication.ts', ['PostgresqlDaemonApplicationInput']],
    ['server.ts', ['AppDeps']],
  ] as const) {
    const source = load(path)
    const imports = source.statements.filter(
      (node): node is ts.ImportDeclaration =>
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === '@/modules/task-execution/public/types',
    )
    expect(
      imports.some(
        (node) =>
          node.importClause?.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings) &&
          node.importClause.namedBindings.elements.some(
            (element) => element.name.text === 'TaskDeletionEffects',
          ),
      ),
    ).toBe(true)
    for (const name of names) {
      const declarations = source.statements.filter(
        (node): node is ts.InterfaceDeclaration =>
          ts.isInterfaceDeclaration(node) && node.name.text === name,
      )
      expect(declarations).toHaveLength(1)
      const fields = declarations[0]!.members.filter(
        (node): node is ts.PropertySignature =>
          ts.isPropertySignature(node) && text(node.name, source) === 'taskDeletionEffects',
      )
      expect(fields).toHaveLength(1)
      expect(fields[0]!.questionToken).toBeDefined()
      expect(text(fields[0]!.type!, source)).toBe('TaskDeletionEffects')
    }
  }
  const postgres = load('cli/postgresqlDaemonApplication.ts')
  const derived = postgres.statements.filter(
    (node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) && node.name.text === 'PostgresqlApplicationInput',
  )
  expect(derived).toHaveLength(1)
  const clauses = derived[0]!.heritageClauses
  expect(clauses).toHaveLength(1)
  const clause = clauses![0]!
  expect(clause.token).toBe(ts.SyntaxKind.ExtendsKeyword)
  expect(clause.types).toHaveLength(1)
  const inherited = clause.types[0]!
  expect(text(inherited.expression, postgres)).toBe('Omit')
  expect(inherited.typeArguments).toHaveLength(2)
  expect(text(inherited.typeArguments![0]!, postgres)).toBe('PostgresqlDaemonApplicationInput')
  const omissions = inherited.typeArguments![1]!
  expect(ts.isUnionTypeNode(omissions)).toBe(true)
  if (!ts.isUnionTypeNode(omissions)) throw new Error('exact original exclusions required')
  expect(omissions.types.map((node) => text(node, postgres))).toEqual([
    "'provider'",
    "'maintenanceStatus'",
  ])
  expect(
    derived[0]!.members.filter(
      (node) => ts.isPropertySignature(node) && text(node.name, postgres) === 'taskDeletionEffects',
    ),
  ).toHaveLength(0)

  const selection = load('modules/task-execution/composition/taskDeletionEffects.ts')
  const nativeImports = selection.statements.filter(
    (node): node is ts.ImportDeclaration =>
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text.includes('source-control'),
  )
  expect(nativeImports).toHaveLength(1)
  expect((nativeImports[0]!.moduleSpecifier as ts.StringLiteral).text).toBe(
    '@/modules/source-control/composition',
  )
  const composition = load('modules/source-control/composition.ts')
  const exports = composition.statements.filter(
    (node): node is ts.ExportDeclaration =>
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === './infrastructure/local/gitTaskDeletionRepositoryEffects',
  )
  expect(exports).toHaveLength(1)
  expect(text(exports[0]!.exportClause!, composition)).toBe(
    '{createGitTaskDeletionRepositoryEffects}',
  )
})

test('native content construction stays lazy and existence plus removal stays one synchronous method', () => {
  const source = load(
    'modules/task-execution/infrastructure/local/fileTaskDeletionContentEffects.ts',
  )
  const factory = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'createFileTaskDeletionContentEffects',
  )!
  expect(factory.body!.statements).toHaveLength(1)
  const returned = factory.body!.statements[0]!
  if (
    !ts.isReturnStatement(returned) ||
    !returned.expression ||
    !ts.isCallExpression(returned.expression)
  )
    throw new Error('lazy complete native receiver required')
  expect(text(returned.expression.expression, source)).toBe('Object.freeze')
  const methods = object(returned.expression.arguments[0]!).properties.filter(
    ts.isMethodDeclaration,
  )
  expect(methods.map((node) => text(node.name, source)).sort()).toEqual([
    'directories',
    'removeIfPresent',
  ])
  const remove = methods.find((node) => text(node.name, source) === 'removeIfPresent')!
  expect(remove.modifiers?.some((node) => node.kind === ts.SyntaxKind.AsyncKeyword) ?? false).toBe(
    false,
  )
  expect(nodes(remove, ts.isAwaitExpression)).toHaveLength(0)
  expect(
    calls(remove, source, 'existsSync').map((node) =>
      node.arguments.map((argument) => text(argument, source)),
    ),
  ).toEqual([['reference']])
  expect(
    calls(remove, source, 'rmSync').map((node) =>
      node.arguments.map((argument) => text(argument, source)),
    ),
  ).toEqual([['reference', '{recursive:true,force:true}']])
})
