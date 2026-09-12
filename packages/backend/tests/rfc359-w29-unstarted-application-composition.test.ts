import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

// No application or service is started here. Whole-body AST inverses pin the
// original complete graph; the pure controls execute the actual lifetime helper.
// W44 exposed the existing repository store and named the SQLite composition.
// Validate those exact same-instance seams before restoring the W29 source locks.
const sourceRoot = process.env.AW_RFC359_COMPOSITION_SOURCE_ROOT ?? resolve(import.meta.dir, '..')
const pgPath = 'src/cli/postgresqlDaemonApplication.ts'
const serverPath = 'src/server.ts'
const parse = (path: string) =>
  ts.createSourceFile(
    path,
    readFileSync(resolve(sourceRoot, path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  )
const pg = parse(pgPath)
const server = parse(serverPath)
const applicationHelper = ts.createSourceFile(
  'providerHttpApplication.ts',
  readFileSync(
    process.env.AW_RFC359_LIFETIME_SOURCE_PATH ??
      resolve(import.meta.dir, 'helpers/providerHttpApplication.ts'),
    'utf8',
  ),
  ts.ScriptTarget.Latest,
  true,
)
const printer = ts.createPrinter({ removeComments: true })

function declaration(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const node = source.statements.find(
    (item): item is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(item) && item.name?.text === name && item.body !== undefined,
  )
  if (node === undefined) throw new Error(`missing composition function: ${name}`)
  return node
}

function functionBody(source: ts.SourceFile, name: string): ts.Block {
  const body = declaration(source, name).body
  if (body === undefined) throw new Error(`missing composition body: ${name}`)
  return body
}

function compact(node: ts.Node, source: ts.SourceFile): string {
  if (
    source === applicationHelper &&
    ts.isCallExpression(node) &&
    node.expression.getText(source) === 'createComposedApp'
  ) {
    const body = functionBody(source, 'composeSqliteUnstartedApplication')
    if (descendants(body, (candidate) => candidate === node).length === 1) {
      const expected =
        '{returncomposeUnstartedApplication((scope)=>{' +
        'constcomposed=composeSqliteApplicationDeps(deps,scope)' +
        'return{app:createComposedApp(composed),' +
        'repositoryWorkspaceStore:composed.repositoryWorkspaceStore,}})}'
      if (body.getText(source).replace(/\s/g, '') !== expected)
        throw new Error('SQLite helper must return the same composed store after one app mount')
      const composition = namedCalls(body, source, 'composeSqliteApplicationDeps')[0]
      if (composition === undefined) throw new Error('missing SQLite composition binding')
      return `createComposedApp(${composition.getText(source)})`.replace(/\s/g, '')
    }
  }
  return node.getText(source).replace(/\s/g, '')
}

function oldSqliteStoreReturn(source: ts.SourceFile, body: ts.Block): ts.Block {
  const composition = source.statements.find(
    (node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) && node.name.text === 'SqliteAppComposition',
  )
  const storeMembers = composition?.members.filter(
    (node) => node.name?.getText(source) === 'repositoryWorkspaceStore',
  )
  if (
    storeMembers?.length !== 1 ||
    compact(storeMembers[0]!, source) !==
      'readonlyrepositoryWorkspaceStore:RepositoryWorkspaceStore'
  )
    throw new Error('SQLite composition must require the original repository store type')
  const last = body.statements.at(-1)
  if (
    last === undefined ||
    !ts.isReturnStatement(last) ||
    last.expression === undefined ||
    !ts.isCallExpression(last.expression) ||
    last.expression.expression.getText(source) !== 'Object.freeze' ||
    last.expression.arguments.length !== 1
  )
    throw new Error('SQLite composition must keep its final frozen return')
  const value = last.expression.arguments[0]
  if (
    value === undefined ||
    !ts.isObjectLiteralExpression(value) ||
    value.properties.at(-1) === undefined ||
    compact(value.properties.at(-1)!, source) !==
      'repositoryWorkspaceStore:repositoryBootstrap.repositoryWorkspaceStore'
  )
    throw new Error('SQLite composition must return the existing bootstrap store last')
  const restored = ts.factory.updateObjectLiteralExpression(
    value,
    ts.factory.createNodeArray(value.properties.slice(0, -1), value.properties.hasTrailingComma),
  )
  return ts.factory.updateBlock(body, [
    ...body.statements.slice(0, -1),
    ts.factory.updateReturnStatement(
      last,
      ts.factory.updateCallExpression(
        last.expression,
        last.expression.expression,
        last.expression.typeArguments,
        [restored],
      ),
    ),
  ])
}

// W54 removes the duplicate provider names while keeping this original body lock.
function oldRuntimeRegistryFactory(source: ts.SourceFile, body: ts.Block): ts.Block {
  const imports = source.statements.filter(
    (node): node is ts.ImportDeclaration =>
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === '@/platform/runtime-registry/composition',
  )
  const clause = imports[0]?.importClause
  const names = clause?.namedBindings
  if (
    imports.length !== 1 ||
    clause === undefined ||
    clause.name !== undefined ||
    clause.isTypeOnly ||
    names === undefined ||
    !ts.isNamedImports(names) ||
    names.elements.length !== 1 ||
    names.elements[0]?.isTypeOnly ||
    names.elements[0]?.propertyName !== undefined ||
    names.elements[0]?.name.text !== 'composeRuntimeRegistryOperations'
  )
    throw new Error('runtime registry must use the single neutral composition import')

  const calls = namedCalls(body, source, 'composeRuntimeRegistryOperations')
  const call = calls[0]
  const bindings = descendants(
    body,
    (node) => ts.isVariableDeclaration(node) && node.name.getText(source) === 'runtimeRegistry',
  )
  if (
    calls.length !== 1 ||
    call === undefined ||
    call.typeArguments !== undefined ||
    call.questionDotToken !== undefined ||
    call.arguments.length !== 1 ||
    compact(call.arguments[0]!, source) !== 'deps.db' ||
    bindings.length !== 1 ||
    compact(bindings[0]!, source) !==
      'runtimeRegistry=deps.runtimeRegistry??deps.providerCore?.runtimeRegistry??composeRuntimeRegistryOperations(deps.db)'
  )
    throw new Error('runtime registry must preserve its original database and lazy fallbacks')

  const transformed = ts.transform(body, [
    (context) => {
      const visit: ts.Visitor = (node) =>
        node === call
          ? ts.factory.updateCallExpression(
              call,
              ts.factory.createIdentifier('composeSqliteRuntimeRegistryOperations'),
              call.typeArguments,
              call.arguments,
            )
          : ts.visitEachChild(node, visit, context)
      return (node) => ts.visitEachChild(node, visit, context)
    },
  ])
  const restored = transformed.transformed[0]!
  transformed.dispose()
  return restored
}

function isDaemonChoice(node: ts.Node, source: ts.SourceFile): node is ts.ConditionalExpression {
  return (
    ts.isConditionalExpression(node) && compact(node.condition, source) === "phase.kind==='daemon'"
  )
}

function isRuntimeFactoryChoice(node: ts.Node, source: ts.SourceFile): node is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
    compact(node.left, source) === 'unstarted?.createMcpRuntimeTests'
  )
}

/** Only the approved composition seams are removed; every original subtree remains. */
function oldPhaseBody(source: ts.SourceFile, name: string): ts.Block {
  const body = functionBody(source, name)
  const original =
    source === server && name === 'composeSqliteApplicationDeps'
      ? oldRuntimeRegistryFactory(source, oldSqliteStoreReturn(source, body))
      : body
  const transformed = ts.transform(original, [
    (context) => {
      const visit: ts.Visitor = (node) => {
        if (
          ts.isParenthesizedExpression(node) &&
          (isDaemonChoice(node.expression, source) ||
            isRuntimeFactoryChoice(node.expression, source))
        ) {
          return ts.visitNode(node.expression, visit)
        }
        if (isDaemonChoice(node, source)) return ts.visitNode(node.whenTrue, visit)
        if (
          ts.isObjectLiteralExpression(node) &&
          node.properties.some(
            (property) =>
              ts.isPropertyAssignment(property) &&
              property.name.getText(source) === 'opencodeVersion' &&
              isDaemonChoice(property.initializer, source),
          )
        ) {
          // The optional fixture value expanded this formerly inline record.
          return ts.factory.createObjectLiteralExpression(
            node.properties.map((property) => {
              const restored = ts.visitNode(property, visit, ts.isObjectLiteralElementLike)!
              return ts.isPropertyAssignment(restored)
                ? ts.factory.createPropertyAssignment(restored.name, restored.initializer)
                : restored
            }),
            false,
          )
        }
        if (isRuntimeFactoryChoice(node, source)) return ts.visitNode(node.right, visit)
        if (ts.isBlock(node)) {
          const statements: ts.Statement[] = []
          for (const statement of node.statements) {
            if (
              ts.isIfStatement(statement) &&
              compact(statement.expression, source) === "phase.kind==='daemon'"
            ) {
              if (!ts.isBlock(statement.thenStatement))
                throw new Error('daemon phase must be a block')
              for (const child of statement.thenStatement.statements) {
                statements.push(ts.visitNode(child, visit, ts.isStatement)!)
              }
            } else if (
              ts.isExpressionStatement(statement) &&
              ((ts.isCallExpression(statement.expression) &&
                compact(statement.expression.expression, source) === 'unstarted?.trackReady') ||
                (ts.isVoidExpression(statement.expression) &&
                  ts.isCallExpression(statement.expression.expression) &&
                  compact(statement.expression.expression.expression, source) ===
                    'unstarted?.trackReady'))
            ) {
              // New unstarted-only readiness capture, absent from old sync entry.
            } else {
              statements.push(ts.visitNode(statement, visit, ts.isStatement)!)
            }
          }
          return ts.factory.updateBlock(node, statements)
        }
        if (
          ts.isCallExpression(node) &&
          ['composeApplicationEventCenter', 'composeSqliteApiRouteMounts'].includes(
            node.expression.getText(source),
          ) &&
          node.arguments.at(-1)?.getText(source) === 'unstarted'
        ) {
          return ts.factory.updateCallExpression(
            node,
            node.expression,
            node.typeArguments,
            node.arguments
              .slice(0, -1)
              .map((argument) => ts.visitNode(argument, visit, ts.isExpression)!),
          )
        }
        return ts.visitEachChild(node, visit, context)
      }
      return (node) => ts.visitNode(node, visit, ts.isBlock)!
    },
  ])
  const result = transformed.transformed[0]
  if (result === undefined) throw new Error('missing normalized composition body')
  transformed.dispose()
  return result
}

function oldEventCenterBody(): ts.Block {
  const body = functionBody(server, 'composeApplicationEventCenter')
  const initialization = body.statements.find(
    (node): node is ts.VariableStatement =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some(
        (item) => item.name.getText(server) === 'initialization',
      ),
  )
  const initializer = initialization?.declarationList.declarations[0]?.initializer
  if (initialization === undefined || initializer === undefined) return body
  const at = body.statements.indexOf(initialization)
  return ts.factory.updateBlock(body, [
    ...body.statements.slice(0, at),
    ts.factory.createReturnStatement(
      ts.factory.createCallExpression(
        ts.factory.createIdentifier('deferEventCenterModule'),
        undefined,
        [initializer],
      ),
    ),
  ])
}

function digest(body: ts.Block, source: ts.SourceFile): string {
  return createHash('sha256')
    .update(printer.printNode(ts.EmitHint.Unspecified, body, source))
    .digest('hex')
}

function descendants(node: ts.Node, predicate: (node: ts.Node) => boolean): ts.Node[] {
  const found: ts.Node[] = []
  const visit = (current: ts.Node): void => {
    if (predicate(current)) found.push(current)
    ts.forEachChild(current, visit)
  }
  visit(node)
  return found
}

function namedCalls(node: ts.Node, source: ts.SourceFile, name: string): ts.CallExpression[] {
  return descendants(
    node,
    (candidate) => ts.isCallExpression(candidate) && candidate.expression.getText(source) === name,
  ).filter(ts.isCallExpression)
}

describe('RFC-359 W29 complete unstarted application composition', () => {
  test('exports both full unstarted entries while retaining the original daemon and sync entries', () => {
    const names = (source: ts.SourceFile) =>
      source.statements
        .filter(ts.isFunctionDeclaration)
        .filter((node) => node.modifiers?.some((item) => item.kind === ts.SyntaxKind.ExportKeyword))
        .map((node) => node.name?.text)
    expect(names(applicationHelper)).toContain('composePostgresqlUnstartedApplication')
    expect(names(pg)).toContain('composePostgresqlDaemonApplication')
    expect(names(applicationHelper)).toContain('composeSqliteUnstartedApplication')
    expect(names(server)).toContain('composeSqliteAppDeps')
    expect(names(server)).toContain('createApp')
    expect(names(pg)).toContain('composePostgresqlApplication')
    expect(names(server)).toContain('composeSqliteApplicationDeps')
    expect(names(pg)).not.toContain('composePostgresqlUnstartedApplication')
    expect(names(server)).not.toContain('composeSqliteUnstartedApplication')
    expect(compact(functionBody(pg, 'composePostgresqlDaemonApplication'), pg)).toBe(
      "{returncomposePostgresqlApplication(input,{kind:'daemon'})}",
    )
    expect(compact(functionBody(server, 'composeSqliteAppDeps'), server)).toBe(
      '{returncomposeSqliteApplicationDeps(deps)}',
    )
  })

  // RFC-359（2026-09-12）：语句条数仍是 159，**摘要变了**——`workgroupTaskRoom` 的
  // `continuation.assertResumable` 从空操作换成 `composeWorktreeResumePreflight({...})`
  // （工作树继续预检两个 provider 共用一份，见 plan §5ah）。这是一条**有意的**行为改动：
  // 改前工作树被 GC 回收后 confirm/approve 在 PG 上回 200 并把任务永久搁浅，改后与 SQLite
  // 同为 410、决策可重试。摘要跟着改是对的；**摘要变了而你说不出改了哪一条，才是红**。
  //
  // RFC-359 W57：daemon 相位从 162 条降到 159 条——`/api/overview` 两侧收成一份时，这里那段
  // 「`WeakMap<authority, Actor>` + `{ resolve }` 解析器 + `systemOverview` 常量 + 包一层
  // `execute` 填 map」的胶水整段删掉了（目录概览端口现在直接收请求者投影），换成一条
  // `composeSystemOverviewQuery({...})` 赋值。降，不是升。
  test('daemon phase retains the complete original 159-statement graph and ordered effects', () => {
    const body = functionBody(pg, 'composePostgresqlApplication')
    const phaseBlocks = body.statements.filter(
      (node): node is ts.IfStatement =>
        ts.isIfStatement(node) && compact(node.expression, pg) === "phase.kind==='daemon'",
    )
    expect(phaseBlocks).toHaveLength(8)
    const restored = oldPhaseBody(pg, 'composePostgresqlApplication')
    expect(restored.statements).toHaveLength(159)
    expect(digest(restored, pg)).toBe(
      '7f6260db1615351a60f38460bfbf9d6927a48f070a4cfe2f12eb5910479477eb',
    )
    expect(phaseBlocks.filter((node) => node.elseStatement !== undefined)).toHaveLength(1)
    expect(
      compact(phaseBlocks.find((node) => node.elseStatement !== undefined)!.elseStatement!, pg),
    ).toBe('{awaitphase.scope.trackReady(digitalEmployee.maintenance.ready())}')
  })

  test('SQLite phase preserves complete original composition and captures the real initialization', () => {
    // RFC-359 W57：`overviewQuery` 不再在这一层装配——它要的 `scheduledTaskRuntime.overview`
    // 要到 `composeSqliteApiRouteMounts` 才齐备，装配挪到了那里（依赖在哪层齐备就在哪层装）。
    expect(digest(oldPhaseBody(server, 'composeSqliteApplicationDeps'), server)).toBe(
      'db69fbb5cfe4a99cc835e8fc7f20aa920a9bb4a796f34c576983037faafadbf8',
    )
    // RFC-359 W57：`overviewQuery` 的装配挪进了这一层（`scheduledTaskRuntime` 就在上面几行），
    // 同时形参表里少了原来那个 `overviewQuery: OverviewRouteQuery`。
    expect(digest(oldPhaseBody(server, 'composeSqliteApiRouteMounts'), server)).toBe(
      'f904bc047d8101ee0823be686e8d595c8b3f31555170a43a84b0f4fd9d9d5eb4',
    )
    expect(digest(oldEventCenterBody(), server)).toBe(
      '3e6131c32a868090e7236eb8e554605e8b46a5df15a149671acd396c0a072194',
    )
    const eventBody = functionBody(server, 'composeApplicationEventCenter')
    expect(namedCalls(eventBody, server, 'composeEventCenter')).toHaveLength(1)
    expect(
      namedCalls(eventBody, server, 'unstarted?.trackReady').map((node) => compact(node, server)),
    ).toEqual(['unstarted?.trackReady(initialization)'])
    expect(
      namedCalls(
        functionBody(server, 'composeSqliteApiRouteMounts'),
        server,
        'unstarted?.trackReady',
      ).map((node) => compact(node, server)),
    ).toEqual(['unstarted?.trackReady(digitalEmployee.maintenance.ready())'])
  })

  test('uses the unchanged complete mounts once and forwards original workflow runtime and health values', () => {
    const expected = {
      composeProviderAppDeps: 'bda8a20e8e4f382e244eb75252ff390d066b680fcc82a99ff0b7bfb1f77da8cb',
      composePostgresqlAppDeps: '2ebbeeef1bc8fecbda4f4c93cf8603afc3eec78fe6d4739403d407c2fb185c5b',
      // gitleaks:allow —— 这是被测装配的 sha256 内容摘要，不是凭据。
      mountApiRoutes: '266aea41bba47101eab057e8e5b9c981f20c8e40063be12b09bf299e1f5391bd', // gitleaks:allow
      createComposedApp: 'a632acc2c6534ecb769e1bd0e64e4f4d8c423d1be8aee049101837c9847b9e62',
      createApp: '628edbc2da66884bfba5d159423fa972ea9a8d4aca3ecb37ed8e3ed98e18aefa',
    }
    for (const [name, hash] of Object.entries(expected)) {
      expect(digest(functionBody(server, name), server)).toBe(hash)
    }
    const pgBody = functionBody(pg, 'composePostgresqlApplication')
    expect(namedCalls(pgBody, pg, 'createComposedApp').map((node) => compact(node, pg))).toEqual([
      'createComposedApp(composePostgresqlAppDeps(composition))',
    ])
    expect(
      namedCalls(
        functionBody(applicationHelper, 'composeSqliteUnstartedApplication'),
        applicationHelper,
        'createComposedApp',
      ).map((node) => compact(node, applicationHelper)),
    ).toEqual(['createComposedApp(composeSqliteApplicationDeps(deps,scope))'])
    const alternatives = descendants(pgBody, (node) => isDaemonChoice(node, pg))
      .filter(ts.isConditionalExpression)
      .map((node) => compact(node.whenFalse, pg))
    expect(alternatives).toEqual([
      'phase.scope.createMcpRuntimeTests',
      '(input.opencodeVersion??null)',
      '(input.workflowRuntime??Object.freeze({}))',
    ])
  })
})

interface ControlledMcpInput {
  readonly name: string
  readonly dispose: () => Promise<void>
}
class ControlledMcpService {
  constructor(readonly input: ControlledMcpInput) {}
  dispose(): Promise<void> {
    return this.input.dispose()
  }
}
interface ControlledScope {
  trackReady<T>(ready: Promise<T>): Promise<T>
  createMcpRuntimeTests(input: ControlledMcpInput): ControlledMcpService
}
type ComposeControlledScope = <T extends object>(
  compose: (scope: ControlledScope) => T | Promise<T>,
) => Promise<T & { readonly dispose: () => Promise<void> }>

function actualLifetimeHelper(): ComposeControlledScope {
  const actual = declaration(applicationHelper, 'composeUnstartedApplication').getText(
    applicationHelper,
  )
  const code = ts.transpileModule(actual.replace(/^export\s+/, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  // Only this actual pure lifetime function is evaluated. The constructor is a
  // controlled lifecycle collaborator; no application, database, or rows are faked.
  return new Function('McpRuntimeTestService', `${code}\nreturn composeUnstartedApplication`)(
    ControlledMcpService,
  ) as ComposeControlledScope
}

function deferred<T>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void
  let rejectPromise!: (error: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

describe('RFC-359 W29 actual application lifetime helper with controlled lifecycle collaborators', () => {
  test('waits for every real readiness promise and preserves the same owned instance', async () => {
    const compose = actualLifetimeHelper()
    const first = deferred<string>()
    const second = deferred<void>()
    const created = deferred<void>()
    let returned = false
    const log: string[] = []
    const pending = compose((scope) => {
      expect(scope.trackReady(first.promise)).toBe(first.promise)
      scope.trackReady(second.promise)
      const service = scope.createMcpRuntimeTests({
        name: 'first',
        dispose: async () => {
          log.push('dispose')
        },
      })
      created.resolve()
      return { service }
    }).then((application) => {
      returned = true
      return application
    })
    await created.promise
    first.resolve('ready')
    await first.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    try {
      expect(returned).toBe(false)
    } finally {
      second.resolve()
    }
    const application = await pending
    expect(application.service.input.name).toBe('first')
    expect(log).toEqual([])
    expect(Object.isFrozen(application)).toBe(true)
    const a = application.dispose()
    const b = application.dispose()
    expect(a).toBe(b)
    await a
    expect(log).toEqual(['dispose'])
  })

  test('finishes pending initialization before cleanup after construction failure', async () => {
    const compose = actualLifetimeHelper()
    const initialization = deferred<void>()
    const constructing = deferred<void>()
    const failure = new Error('construction failed')
    const log: string[] = []
    const pending = compose((scope) => {
      scope.trackReady(initialization.promise)
      scope.createMcpRuntimeTests({
        name: 'failed',
        dispose: async () => {
          log.push('dispose')
        },
      })
      constructing.resolve()
      throw failure
    })
    const outcome = pending.then(
      () => undefined,
      (error: unknown) => error,
    )
    await constructing.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(log).toEqual([])
    log.push('initialization finished')
    initialization.resolve()
    expect(await outcome).toBe(failure)
    expect(log).toEqual(['initialization finished', 'dispose'])
  })

  test('keeps initialization failure and closes every service even when cleanup also fails', async () => {
    const compose = actualLifetimeHelper()
    const failure = new Error('module initialization failed')
    const cleanup = new Error('owned service disposal failed')
    const log: string[] = []
    const outcome = await compose((scope) => {
      scope.trackReady(Promise.reject(failure))
      scope.createMcpRuntimeTests({
        name: 'first',
        dispose: async () => {
          log.push('first')
          throw cleanup
        },
      })
      scope.createMcpRuntimeTests({
        name: 'second',
        dispose: async () => {
          log.push('second')
        },
      })
      return { marker: 'constructed' }
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(outcome).toBeInstanceOf(AggregateError)
    if (!(outcome instanceof AggregateError)) throw new Error('missing combined lifecycle failure')
    expect(outcome.errors).toEqual([failure, cleanup])
    expect(log).toEqual(['first', 'second'])
  })

  test('gives consecutive app scopes separate instances and preserves each cleanup failure identity', async () => {
    const compose = actualLifetimeHelper()
    const cleanup = new Error('first disposal failed')
    const first = await compose((scope) => ({
      service: scope.createMcpRuntimeTests({
        name: 'first',
        dispose: async () => {
          throw cleanup
        },
      }),
    }))
    const second = await compose((scope) => ({
      service: scope.createMcpRuntimeTests({ name: 'second', dispose: async () => {} }),
    }))
    expect(first.service).not.toBe(second.service)
    await expect(first.dispose()).rejects.toBe(cleanup)
    await second.dispose()
    await expect(first.dispose()).rejects.toBe(cleanup)
  })
})
