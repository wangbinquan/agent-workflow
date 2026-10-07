// Locks actual RFC-371 bootstrap/fallback wiring; model and data acceptance use separate fixtures.
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
function calls(source: ts.SourceFile, name: string) {
  const found: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && text(node.expression, source) === name) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}
function property(node: ts.Expression, source: ts.SourceFile, name: string): ts.Expression {
  if (!ts.isObjectLiteralExpression(node)) throw Error('actual composition object required')
  const found = node.properties.filter(
    (p): p is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
      text(p.name, source) === name,
  )
  expect(found).toHaveLength(1)
  const value = found[0]!
  return ts.isPropertyAssignment(value) ? value.initializer : value.name
}

test('actual SQLite and PG bootstrap freeze exact provider admissions into the existing Task provider', () => {
  for (const [path, provider, db, generation] of [
    [
      'cli/start.ts',
      'composeSqliteTaskExecutionProviderRuntime',
      'db',
      'databaseProvider.generation.payload.generationId',
    ],
    [
      'cli/postgresqlDaemonApplication.ts',
      'composePostgresqlTaskExecutionProviderRuntime',
      'input.db',
      'input.provider.runtime',
    ],
  ]) {
    const source = load(path!),
      selected = calls(source, 'selectedNativeUsageInvocationPersistence')
    expect(selected).toHaveLength(1)
    expect(text(selected[0]!.arguments[0]!, source)).toBe(db!)
    const options = selected[0]!.arguments[1]!,
      binding = property(options, source, 'binding')
    expect(text(property(options, source, 'admissions'), source)).toBe(
      'nativeUsageAdmissions(process.env.AW_NATIVE_OBSERVATION_ADMISSIONS)',
    )
    expect(
      text(property(binding, source, path === 'cli/start.ts' ? 'generationId' : 'runtime'), source),
    ).toBe(generation!)
    const composed = calls(source, provider!)
    expect(composed).toHaveLength(1)
    expect(text(property(composed[0]!.arguments[1]!, source, 'nativeUsage'), source)).toBe(
      'nativeUsage',
    )
    if (path !== 'cli/start.ts') {
      expect(text(property(options, source, 'postgresqlPoolMax'), source)).toBe(
        'input.config.database.poolMax',
      )
      const main = calls(source, 'createTaskExecutionPersistence')
      expect(main).toHaveLength(1)
      expect(text(property(main[0]!.arguments[1]!, source, 'nativeUsage'), source)).toBe(
        'nativeUsage',
      )
    } else {
      const http = calls(source, 'composeSqliteAppDeps')
      expect(http).toHaveLength(1)
      expect(text(property(http[0]!.arguments[0]!, source, 'nativeUsage'), source)).toBe(
        'nativeUsage',
      )
    }
  }
})

test('standalone/default and host Task roots retain the actual participant instead of silently omitting it', () => {
  const source = load('server.ts'),
    persistence = calls(source, 'createTaskExecutionPersistence')
  expect(persistence).toHaveLength(2)
  for (const call of persistence)
    expect(text(property(call.arguments[1]!, source, 'nativeUsage'), source)).toBe(
      'deps.nativeUsage',
    )
})

test('actual standalone route composition receives the existing selected launch configuration before reading it', () => {
  const source = load('server.ts'),
    mounted = calls(source, 'composeSqliteApiRouteMounts')
  expect(mounted).toHaveLength(1)
  const declarations = source.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'composeSqliteApiRouteMounts',
  )
  expect(declarations).toHaveLength(1)
  const declaration = declarations[0]!,
    position = declaration.parameters.findIndex(
      (p) => text(p.name, source) === 'taskLaunchConfiguration',
    )
  expect(position).toBeGreaterThanOrEqual(0)
  expect(text(mounted[0]!.arguments[position]!, source)).toBe('taskLaunchConfiguration')
  expect(text(declaration.parameters[position]!.type!, source)).toBe(
    'ReturnType<typeofcomposeTaskLaunchConfiguration>',
  )
})

test('both direct provider fallbacks bind native usage while caller supplied PG persistence stays whole', () => {
  const source = load('modules/task-execution/composition/providerRuntime.ts')
  const persistence = calls(source, 'createTaskExecutionPersistence')
  expect(persistence).toHaveLength(2)
  for (const call of persistence)
    expect(text(property(call.arguments[1]!, source, 'nativeUsage'), source)).toBe(
      'dependencies.nativeUsage',
    )
  const pg = persistence[1]!.parent
  expect(ts.isBinaryExpression(pg)).toBe(true)
  if (!ts.isBinaryExpression(pg)) throw Error('actual PG caller persistence selection required')
  expect(pg.operatorToken.kind).toBe(ts.SyntaxKind.QuestionQuestionToken)
  expect(text(pg.left, source)).toBe('dependencies.runtime.persistence')
})

test('actual runNode passes the same frozen registration/revision and actual protocol at invocation creation', () => {
  const source = load('modules/task-execution/application/taskAgentRun.ts')
  const invocation = calls(source, 'opts.persistence.nativeUsage?.forInvocation')
  expect(invocation).toHaveLength(1)
  const argument = invocation[0]!.arguments[0]!
  expect(text(property(argument, source, 'taskId'), source)).toBe('opts.taskId')
  expect(text(property(argument, source, 'nodeRunId'), source)).toBe('opts.nodeRunId')
  expect(text(argument, source)).toContain(
    "runtime:{...opts.runtimeObservationIdentity,protocol:opts.runtime??'opencode'}",
  )
})
