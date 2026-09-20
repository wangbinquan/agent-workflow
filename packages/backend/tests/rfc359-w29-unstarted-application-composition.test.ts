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
      // 追加在尾部的那几项同样是「暴露装配结果」，不是装配本身（见本文件另一处
      // `APPENDED_EXPOSURES` 的说明）。新增一项要在这里一起登记。
      const expected =
        '{returncomposeUnstartedApplication((scope)=>{' +
        'constcomposed=composeSqliteApplicationDeps(deps,scope)' +
        'return{app:createComposedApp(composed),' +
        'repositoryWorkspaceStore:composed.repositoryWorkspaceStore,' +
        'taskExecutionReadModels:composed.taskExecutionReadModels,' +
        'collaborationContext:composed.collaborationContext,' +
        'core:composed.core,}})}'
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
  // 合一后**追加**在返回对象尾部的那几项：它们都不是「装配」，而是把**已经装配好的东西
  // 暴露出来**给测试夹具（RFC-359 §5aq——否则用例只能在外面再建一份一模一样的，再从
  // `AppDeps` 塞回去，那个形状把用例钉死在 SQLite 上）。这里逐字对账后剥掉，再拿剩下的
  // 部分与合一前的摘要比——**新增一项要在这个名单里显式登记**，不能默默混过去。
  const APPENDED_EXPOSURES = [
    'repositoryWorkspaceStore:repositoryBootstrap.repositoryWorkspaceStore',
    'taskExecutionReadModels:effectiveDeps.taskExecutionReadModels',
    'collaborationContext:effectiveDeps.collaborationContext',
    // RFC-359（apply 引擎合一）：同理——把**装配好的** apply 引擎的「本进程在跑哪些 apply」
    // 查询面暴露出来，交给 `cli/start.ts` 晚绑定给维护服务。合一前这个输入来自
    // `services/bundle/apply.ts` 的模块级集合，SQLite 不再走那条路后它永远为空。
    'resourcePackageApplyActivity:resourcePackageBinding?.applyActivity??NO_RESOURCE_PACKAGE_APPLY_ACTIVITY',
    // RFC-359（intent apply 引擎合一）：同一个形状的第二例。合一前 SQLite 的「本进程在跑哪些
    // intent apply」读的是引擎的**模块级**集合（`activeIntentApplyJournalIds()`），装配点在哪
    // 都无所谓；合一取了 PG 那一侧的强判据——在飞集合是进程内围栏，必须把**选中的那台引擎**
    // 交出来，于是同样走「暴露 + 晚绑定」。
    'intentApplyActivity:Object.freeze({activeJournalIds:()=>intentApply.activeJournalIds(),})',
  ]
  if (value === undefined || !ts.isObjectLiteralExpression(value))
    throw new Error('SQLite composition must keep its final frozen return')
  const tail = value.properties.slice(-APPENDED_EXPOSURES.length)
  if (
    tail.length !== APPENDED_EXPOSURES.length ||
    tail.some((property, index) => compact(property, source) !== APPENDED_EXPOSURES[index])
  )
    throw new Error(
      'SQLite composition must end with exactly the registered exposures: ' +
        APPENDED_EXPOSURES.join(', '),
    )
  const restored = ts.factory.updateObjectLiteralExpression(
    value,
    ts.factory.createNodeArray(
      value.properties.slice(0, -APPENDED_EXPOSURES.length),
      value.properties.hasTrailingComma,
    ),
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
      node.moduleSpecifier.text === '@/modules/runtime-management/composition/runtimeRegistry' &&
      !node.importClause?.isTypeOnly,
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
    call.arguments.length !== 2 ||
    compact(call.arguments[1]!, source) !== 'composeRuntimeProfileParticipants()' ||
    compact(call.arguments[0]!, source) !== 'deps.db' ||
    bindings.length !== 1 ||
    compact(bindings[0]!, source) !==
      'runtimeRegistry=deps.runtimeRegistry??deps.providerCore?.runtimeRegistry??composeRuntimeRegistryOperations(deps.db,composeRuntimeProfileParticipants())'
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
              [call.arguments[0]!],
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
  test('RFC-363 URL preparation uses the existing root IA authority context factory', () => {
    for (const [source, expected] of [
      [pg, 1],
      [server, 3],
      [parse('src/cli/start.ts'), 2],
    ] as const) {
      const bindings = descendants(
        source,
        (node) => ts.isPropertyAssignment(node) && node.name.getText(source) === 'sourceContexts',
      )
      expect(bindings).toHaveLength(expected)
      for (const node of bindings) {
        expect([
          'sourceContexts:identityAccess.taskPreparationContext',
          'sourceContexts:deps.identityAccess.taskPreparationContext',
        ]).toContain(compact(node, source))
      }
    }
  })

  test('RFC-363 workspace readers reuse each root Task loader and the SC scope without starting effects', () => {
    // The reviewed a5312d065 delta adds one property to each existing route
    // binding. Keep the whole-body locks and the cold lifecycle tests below.
    for (const [source, owner, loader] of [
      [pg, 'composePostgresqlApplication', 'taskExecutionProvider.routes.tasks.get'],
      [server, 'composeSqliteApiRouteMounts', 'taskRouteOperations.get'],
    ] as const) {
      const calls = namedCalls(functionBody(source, owner), source, 'composeTaskWorkspaceQueries')
      expect(calls).toHaveLength(1)
      const call = calls[0]!
      expect(compact(call, source)).toBe(
        `composeTaskWorkspaceQueries({load:${loader},contentScope:createWorkspaceContentScope,})`,
      )
      expect(ts.isPropertyAssignment(call.parent)).toBe(true)
      expect(compact(call.parent, source)).toBe(`workspaceQueries:${compact(call, source)}`)
    }
  })

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

  // RFC-359（2026-09-12，第七次）：语句条数**仍是 160**，摘要变化——`intent` 路由依赖里
  // 多了一条条件展开 `...(input.intentTestDependencies?.runFn === undefined ? {} : { runTurn })`，
  // 与 `server.ts:2750-2752` 逐字同构（`IntentSessionRouteDependencies` 本来就有 `runTurn`）。
  // 既有语句内部的形态变化，不增减条数；生产不传 ⇒ 空展开 ⇒ 用真的 runner。
  //
  // RFC-359（2026-09-12，第六次）：语句条数**仍是 160**，摘要变化——
  // `getMcpRuntimeTestService(...)` 的入参里多了三条条件展开
  // （`runFn` / `now` / `capacity`，来自 `input.mcpRuntimeTestDependencies`），
  // 与 `server.ts:2014-2023` 对同一个服务的做法逐字同构。`appHome` 不在其中：PG 根本来
  // 就从 `input.appHome` 取。既有语句内部的形态变化，不增减条数。
  // 生产逐字不变（不传 ⇒ 三个展开都是空对象 ⇒ 服务取自己的默认）。
  // 已变异验证承重：抽掉 `runFn` 那条展开，`rfc238-mcp-runtime-test-http` 的
  // [postgresql] 当场转红。
  //
  // RFC-359（2026-09-12，第五次）：语句条数 **159 → 160**，摘要随之变化。加的是**一条**语句：
  //     const webhookDispatcher = input.webhookDispatcher ?? composedWebhookDispatcher
  // 原来那个 `createWebhookDispatcher(...)` 的结果改名成 `composedWebhookDispatcher`，
  // 新的 `webhookDispatcher` 绑定挑「覆盖件还是自建的那个」。同轮还把事件中心两处改成
  // **能力探测**接线（`supportsEventCenterWorkStart` / `supportsEventCenterCodeHostDelivery`），
  // 与 `server.ts` 对同一件事的做法逐字同构——那两处是既有语句内部的形态变化，不增减条数。
  //
  // 为什么要这样而不是像另外两个覆盖口那样纯透传：两个组合根对 dispatcher 的**所有权**
  // 本来就不同（SQLite 当可选依赖收、PG 自己构造），直接 `??` 会让只有部分能力的测试桩
  // 在 `automationWorkStart` 处运行时炸。三个选项与取舍见 plan §5bi。
  //
  // 生产逐字不变：不传覆盖件 ⇒ 取自建的那个 ⇒ 它带全部能力 ⇒ 两个探测门都通过。
  // 已变异验证承重：抽掉 `?? ` 那一侧，`rfc259-github-ingress` 的 [postgresql] 三条当场转红。
  //
  // RFC-359（2026-09-12，第四次）：语句条数仍是 159，摘要再次变化——PG 组合根补了**两个
  // 可选覆盖口**，都只改了既有语句里的属性取值，没有新增/删除语句：
  //   · `integration.scheduledTasks.buildScheduleLaunch` 从直接取
  //     `taskExecutionProvider.trigger.buildScheduleLaunch` 变成
  //     `input.buildScheduleLaunch ?? …`；
  //   · `platform.runtimes` 多一条条件展开
  //     `...(input.runtimeDiagnosticTestDependencies === undefined ? {} : {…})`。
  // 两者都是**把 SQLite 根早就有的可选覆盖补到 PG 根**（`server.ts` 的
  // `buildScheduleLaunch?` / `runtimeDiagnosticTestDependencies?`），默认行为逐字不变
  // ——生产两侧都不传，取的还是原来那个值。理由与账本见 plan §5bg。
  // 摘要跟着改是对的；**摘要变了而你说不出改了哪一条，才是红**。
  //
  // RFC-359（2026-09-12，第二次）：语句条数仍是 159，摘要再次变化——`PostgresqlDaemonApplicationRuntime`
  // 多了一个 `collaborationContext: boundCollaborationContext`。它**不是**新装配：那个上下文
  // 早就在同一作用域里建好了，这里只是把它交出来，好让测试夹具把「应用自己建的那一份」给用例
  // （plan §5aq）。daemon 自己不碰它。
  //
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
  //
  // RFC-359（2026-09-13，第五次）：语句条数仍是 160，摘要再次变化——同一批的第三档，
  // 最后六对孪生的相同函数体提成中立实现后，PG 根改调
  // `composeCapabilityTemplateOperations` / `composeCodeCapabilityDemoSeedParticipant` /
  // `composeDemoResourceCatalogSeedParticipant` / `composeLegacyCodeReadProviders` /
  // `composeRealtimeRuntimeFor` / `composeWebhookEndpointServiceDependencies`（plan §5ds）。
  //
  // RFC-359（2026-09-13，第四次）：语句条数仍是 160，摘要再次变化——同一批的第二档，
  // PG 根改调 `composeCollaborationRouteOperations` / `composeWorkspaceMaintenanceCommand` /
  // `composeResourceCatalogFor`（plan §5ds）。
  //
  // RFC-359（2026-09-13，第三次）：语句条数仍是 160，摘要再次变化——四对**函数体逐字相同**的
  // 装配别名退役，PG 根改调同名的中立实现：`composePostgresqlWebhookDeliveryRuntime` →
  // `composeWebhookDeliveryRuntimeFor`、`…WebhookIngressPersistence` → `…For`、
  // `…WebhookDeliveryPersistence` → `…For`、`…ScheduledTaskRuntime` → `…For`（plan §5ds）。
  //
  // RFC-359（2026-09-13，第二次）：语句条数仍是 160，摘要再次变化——
  // `composePostgresqlWebhookTerminalWorkspacePrunePolicy` 改名为
  // `composeWebhookTerminalWorkspacePrunePolicy`。那两个 compose 函数的**函数体逐字相同**，
  // 唯一差别是形参上 `db` 的声明类型，而它转交给的 `createWebhookTerminalWorkspaceAttributionQueries`
  // 本来就收中立客户端——不是两台机器，是同一台机器抄了两遍名字，收成一份（plan §5dr）。
  //
  // RFC-359（2026-09-13）：语句条数**不变**（160），摘要变了——
  // `composeDigitalEmployeeExecution({...})` 的实参多了一项
  // `humanReview: { inspect: (ref) => inspectDigitalEmployeeHumanReviewState(input.db, ref) }`。
  // 那是在补一处**用户可见的引擎分叉**：PG 侧的 composition 此前根本没有 `inspectHumanReview`，
  // 于是计划人审闸门在 PostgreSQL 上永远报不出 `waiting`（同一个案子 SQLite 显示「等待人审」、
  // PG 显示「规划中」）。装的是与 SQLite 侧同一份中立实现，见 plan §5dm。
  // RFC-359（2026-09-14，intent apply 引擎合一，plan §5ea）：语句条数仍是 160，摘要变了——
  // PG 根这一段此前是 `createIntentApplyArtifactLifecycle` +
  // `createIntentApplyEngine`（自己拼资源绑定与工件生命周期）+
  // `composeIntentApplyOperations` 的窄化，现在是与 SQLite 根**逐字同一份**的
  // `composeIntentApplyArtifactLifecycle` + `composeIntentApplyOperations`；
  // `composePostgresqlIntentMaintenanceSnapshotQueries` 一并改叫
  // `composeIntentMaintenanceSnapshotQueriesFor`。
  test('daemon phase retains the complete graph plus one RFC-360 management instance and ordered effects', () => {
    const body = functionBody(pg, 'composePostgresqlApplication')
    const phaseBlocks = body.statements.filter(
      (node): node is ts.IfStatement =>
        ts.isIfStatement(node) && compact(node.expression, pg) === "phase.kind==='daemon'",
    )
    expect(phaseBlocks).toHaveLength(8)
    const restored = oldPhaseBody(pg, 'composePostgresqlApplication')
    // RFC-360 adds one management application shared by the two runtime route families.
    expect(restored.statements).toHaveLength(161)
    expect(namedCalls(body, pg, 'composeRuntimeManagement')).toHaveLength(1)
    // RFC-359 AC-10：摘要随 `runFrameBackfillOnBoot({ provider: 'postgresql', db })` →
    // `({ db })` 更新。`FrameBackfillDatabase` 的 provider 标签是摆设（联合两个成员结构逐字
    // 相同、函数体从不读它），删掉它同时消掉了 `main.ts` 里那条三元分叉。
    // **语句数仍是 160、顺序未变**——改的只是一个实参，这正是这条判据要区分的两种情况。
    // RFC-359 AC-10（2026-09-15，恢复管理面合一）：摘要随
    // `createPostgresqlTaskExecutionPersistence(input.db)` → `createTaskExecutionPersistence(input.db)`
    // 更新。两份 persistence 聚合合一后只剩一个中立入口，这里改的**只是被调用者的名字**——
    // **语句数仍是 160、顺序未变**（上一行那条断言就是为了把这两种情况分开）。
    // RFC-359 AC-1（2026-09-15，plan §5fp / §5fr / §5ft）：摘要随**三处被调用者改名**更新——
    // `createPostgresqlExecutionContractResourceAdapter` → `createExecutionContractResourceAdapter`
    // （两份实现合一，§5fp）、
    // `createPostgresqlTaskExecutionCatalogSourceFactory` → `createDatabaseTaskExecutionCatalogSourceFactory`
    // （纯别名退役，§5fr）、
    // `composePostgresqlDevelopmentToolConnectionCatalog` → `composeDevelopmentToolConnectionCatalog`
    // （工具连接目录合一，§5ft）。
    // **语句数仍是 160、顺序未变**——上面那条 `toHaveLength(160)` 没红，正是这条判据用来
    // 区分「只是改了个名字」与「装配图真的变了」的那道闸。
    // RFC-359 AC-1（2026-09-15，plan §5fu）：摘要随**纯装配别名批退**再更新——那一批 20 个
    // 别名（`composeSqliteX` / `composePostgresqlX`）本来就指着同一个函数，去掉品牌前缀后
    // 这几段装配体的**文本**变了，**装配图一条没动**（上面的语句数断言没红）。
    // RFC-359 AC-1（2026-09-16，plan §5hi）：摘要随**两处被调用者改名**更新——
    // `composePostgresqlAgentActionExecution` / `composePostgresqlScriptActionExecution`
    // → `composeAgentActionExecution` / `composeScriptActionExecution`（数字员工动作执行的
    // 两份 composer 合成一对，两个引擎共用）。另加一处实参改名：动作执行环境的 `actor`
    // 换成惰性的 `resolveActor`（SQLite 那个组合根是同步函数，取不到 `await admit…`）。
    // **语句数仍是 160、顺序未变**——上面那条 `toHaveLength(160)` 没红。
    // RFC-359 AC-1（2026-09-16，plan §5hl）：摘要随数字员工执行 composer 的**改名 + 一处实参**
    // 更新——`composePostgresqlDigitalEmployeeExecution` → `composeDigitalEmployeeExecution`
    // （两份合一），`actor: systemActor` → `resolveActor: async () => systemActor`
    // （SQLite 那个组合根是同步函数，取不到 await 的 admit，惰性是两侧都成立的那半）。
    // **语句数仍是 160、顺序未变**。
    // RFC-359 AC-1（2026-09-16，plan §5hm）：摘要随生命周期端口合一更新——
    // `createPostgresqlTaskDriverLifecyclePort` → `createTaskDriverLifecyclePort`（两个引擎一份），
    // 并多一行 `claim:` 绑定（认领方式是唯一按引擎不同的那一格，由装配方交闭包）。
    // **语句数仍是 160、顺序未变**——上面那条 `toHaveLength(160)` 没红。
    // RFC-359 AC-1（2026-09-17，plan §5hn 批次二 ①）：摘要随**两处启动资源面改用共用实现**更新——
    // `agentLaunchResources` 不再注入 `agents.get`（那份把 actor 投影成 direct authority
    // 再查资源目录，认不出定时 / webhook 的委派 actor，PG 上定时启动代理任务当场 500），
    // `workgroupLaunchResources` 从一整段手写对象字面量换成
    // `composeWorkgroupLaunchResourceOperations({ db, integrity })`。
    // **语句数仍是 160**：两处都是 `const … = …`，换的是右手边。
    // RFC-359 AC-1（2026-09-17，plan §5hn 批次二 ①）：摘要随**补上 RFC-287 G7** 更新——
    // 驱动协调器的 `repositoryPreparation` 从 `skipRepositoryPreparation` 换成真正的
    // `composeDeferredRepositoryPreparation({...})`。此前 PG 上这一格是空操作，
    // 于是「远端拉不动」时同步抛错、一行任务都不留。**语句数仍是 160**：换的是一个实参。
    // RFC-359 AC-1（2026-09-17，plan §5hn 批次二 ④）：摘要随 `agentLaunchResources` 的
    // `workflowValidation` 注入**退役**更新——注入的那份丢掉了候选上下文，于是 call-node 规则
    // 不在启动那道门上判；缺省实现读同一批清单并把候选透传下去。**语句数仍是 160**。
    // RFC-359 AC-1（2026-09-17，plan §5hn 之后的盘点第 4 刀）：摘要随 `membershipEvents`
    // 端口**退役**更新——访问门 + 成员四件两个引擎合一之后，成员变更的 WS 重校验与列表广播
    // 由共用的 `updateTaskMembersLocked` 自己做，这一格转发面零调用方。语句数减少一格。
    // RFC-359 AC-1（2026-09-17，plan §5hn 之后的盘点第 5 刀）：`deletionEvents` 端口同样退役
    // ——`delete` 两个引擎共用 `services/taskDelete.ts` 之后，提交后的列表广播由共用实现自己做。
    // RFC-359 AC-1（第 14 刀）：摘要随**源终止参与者与装配合一**更新——这一层改调中立的
    // `composeTaskSourceTermination({ db, finalizeWithoutDriver })`，并把无 driver 时的工作区
    // 收尾（source-control 的 `finalizeClaimedWorkspace`，与本文件驱动生命周期端口用的同一个）
    // 显式交进去。**装配图变的是这一格**，且变的方向是补齐：此前这条路上的源终止没有同步收尾。
    // 2026-09-19：摘要随**运行期配置改成热读**更新——长驻的 `boundTaskDriveCoordinator` 不再吃
    // boot 那一刻的 `runConfig` 快照，`runtime` 改成 getter、每次 drive 现读一次
    // （设置页改完默认运行时之后新任务必须按新那一行派发，见
    // `tests/rfc319-cfg45-default-runtime-hot-read.test.ts`）。装配图变的是这一格，
    // 方向同样是补齐：此前这条路上「设为默认」对新任务不生效。
    expect(digest(restored, pg)).toBe(
      // 2026-09-19（第二次重采）：三条被合一丢掉的装配步骤补回来——长驻协调器的运行期配置改成
      // 每次 drive 现读（`refreshLaunchConfig` / `currentRunConfig()` getter）、仓库准备重试把
      // 发起人原样传下去、数字员工执行在 launch 前播种合成宿主工作流行。三条都是**补齐**，
      // 判据分别在 `tests/rfc319-cfg45-default-runtime-hot-read.test.ts` 与
      // `tests/rfc319-task27-de28-manual-retry-and-host-anchor.test.ts`。
      // RFC-360: both runtime route families and config consume the same management instance;
      // the PostgreSQL task runtime reuses core.runtimeRegistry rather than creating another.
      // RFC-363: Task workspace reader plus explicit preparation binding.
      // Deferred Task composition no longer receives an SC repository store;
      // its required binding owns physical legacy recovery too.
      // RFC-364: explicit single-instance diagnostics, IA contexts and narrow route/reconcile projections.
      // Exact diagnostics bindings are guarded in rfc364-diagnostics-bindings.test.ts.
      // RFC-363 adds the SC preparation binding to Task admission and the existing deferred step; no new worker.
      'ae0365e491407852ebf48f3687fc85126c2e6b81842e94f559525e89f1363975',
    )
    expect(phaseBlocks.filter((node) => node.elseStatement !== undefined)).toHaveLength(1)
    expect(
      compact(phaseBlocks.find((node) => node.elseStatement !== undefined)!.elseStatement!, pg),
    ).toBe('{awaitphase.scope.trackReady(digitalEmployee.maintenance.ready())}')
  })

  test('SQLite phase preserves complete original composition and captures the real initialization', () => {
    // RFC-359 W57：`overviewQuery` 不再在这一层装配——它要的 `scheduledTaskRuntime.overview`
    // 要到 `composeSqliteApiRouteMounts` 才齐备，装配挪到了那里（依赖在哪层齐备就在哪层装）。
    //
    // RFC-359（2026-09-13，第二档）：摘要再变——SQLite 根改调
    // `composeCollaborationRouteOperations` / `composeResourceCatalogFor`（plan §5ds）。
    //
    // RFC-359（2026-09-13）：摘要变了——同一批别名退役，SQLite 根这一侧改调
    // `composeWebhookDeliveryRuntimeFor` / `composeWebhookIngressPersistenceFor` /
    // `composeWebhookDeliveryPersistenceFor` / `composeScheduledTaskRuntimeFor`（plan §5ds）。
    //
    // RFC-359（2026-09-13，apply 引擎合一，plan §5dv）：摘要又变了，变的是**资源包目录那一段**——
    // 此前 `composeSqliteResourcePackageProvider` + `createSqliteResourcePackageExecutionAdapter`
    // （SQLite 专属的 legacy `commitResourcePackage` 那条），现在 `composePostgresqlResourcePackageProvider`
    // + `composePostgresqlResourcePackageCatalog` + `createPostgresqlResourcePackageAtomicApplyOperations`
    // （两个 provider 装的同一条），并带出 `ResourcePackageRouteBinding`（目录 + 造 context 的那条路同源）。
    //
    // RFC-359（2026-09-14，intent apply 引擎合一，plan §5ea）：摘要又变了，变的是 **intent
    // apply 那一段**——此前 `composeSqliteIntentApplyOperations` + `composeIntentApplyResourceBinding`
    // （legacy 资源会话）+ `composeSqliteIntentApplyArtifactLifecycle`，现在是与 PG 根同一份的
    // `composeIntentApplyOperations`（资源会话与工件生命周期由它自己按 db + appHome 装配）。
    // RFC-359 AC-10（2026-09-15）：同上，`createSqliteTaskExecutionPersistence(deps.db)` →
    // `createTaskExecutionPersistence(deps.db)`（连同 import 与那处 `ReturnType<typeof …>`）。
    // 装配图一条没动，动的是名字。
    // RFC-359 AC-1（2026-09-15，plan §5fu）：同上，纯装配别名批退波及这一层的
    // `composeSqliteMemoryCatalogOperations` → `composeMemoryCatalogOperations` 等
    // （那一批 20 个别名本来就指着同一个函数）。**装配图一条没动，动的是名字。**
    // RFC-359 AC-1（2026-09-15，plan §5fu）：摘要随**纯装配别名批退**再更新——那一批 20 个
    // 别名（`composeSqliteX` / `composePostgresqlX`）本来就指着同一个函数，去掉品牌前缀后
    // 这几段装配体的**文本**变了，**装配图一条没动**（上面的语句数断言没红）。
    // RFC-359 AC-1（2026-09-16，plan §5gt）：摘要随 `AppDeps.secretBox` 收成**必填**而更新。
    // 变的是文本不是装配图——11 处 `deps.secretBox === undefined ? … : …` 的容忍分支去掉了
    // （5 处条件展开收成普通字段、6 处 `? null : construct(…)` 收成直接构造）。
    // 那些分支在生产上一条都到不了（`cli/start.ts:1480` 在选 provider 之前就无条件建 secretBox），
    // 所以**装配出来的东西不变，只是不再为「测试没传」留退路**；上面的语句数断言没红即为佐证。
    // RFC-359 AC-1（2026-09-17，plan §5hn 批次二 ⑤）：摘要随**子任务启动两个引擎合一**更新——
    // 这一层的 `createSqliteTaskExecutionRuntimeParticipants(...)` 多了一格
    // `childLaunchWorkgroup`（与 PostgreSQL 组合根同名同形，走同一份
    // `composeWorkgroupLaunchResourceOperations`）。**装配图确实变了，是有意的**：
    // SQLite 的子任务铸造从 87 行转发壳 → `startExecution` → `startTaskImpl` 改成与
    // PostgreSQL 共用的那台铸造机，它要一个工作组资源面。
    // 这一格只在**回退路**上构造（生产交齐 `schedulerDriver` + `taskExecutionReadModels`，
    // 这整段 runtime 根本不装配，走的是 `composeSqliteTaskExecutionProviderRuntime`）。
    // RFC-359 AC-1（第 12 刀）：摘要随**运行时参与者两个引擎合一**更新——这一层改调中立的
    // `createTaskExecutionRuntimeParticipants(...)`，并把此前由 SQLite 那份工厂在体内现造的
    // 四格（协作投影 / 并发域 / 日志 + 驱动生命周期端口）与两格进程内注册表端口
    // （`activity` / `stop`）显式交进去。**装配出来的东西逐字不变**：四格是把原工厂体里那几行
    // 原样搬到调用处（`createTaskDagCollaborationOperations(deps.db)` / `deps.db` /
    // `createLogger('task')` / `createDatabaseTaskDriverLifecyclePort` + 同一个
    // `finishClaimedWebhookWorkspacePrune` 收尾），两格是这条回退路本来就在用的那一对
    // （`composeLegacyTaskActivityParticipant` 此前就住在同一个文件里）。
    expect(digest(oldPhaseBody(server, 'composeSqliteApplicationDeps'), server)).toBe(
      // RFC-364: explicit single-instance diagnostics, IA contexts and narrow route/reconcile projections.
      // Exact diagnostics bindings are guarded in rfc364-diagnostics-bindings.test.ts.
      // RFC-363 adds the SC preparation binding to Task admission and the existing deferred step; no new worker.
      '16a07147e2f02d084a1e3de0fdb41a59db7e445778c31065a0ed81d916809b56',
    )
    // RFC-359 W57：`overviewQuery` 的装配挪进了这一层（`scheduledTaskRuntime` 就在上面几行），
    // 同时形参表里少了原来那个 `overviewQuery: OverviewRouteQuery`。
    //
    // RFC-359（2026-09-13，第三档）：摘要再变——这一层也改调
    // `composeCapabilityTemplateOperations` / `composeRealtimeRuntimeFor` 等中立实现（plan §5ds）。
    //
    // RFC-359（2026-09-13，第二档）：摘要再变——这一层也改调 `composeResourceCatalogFor`。
    //
    // RFC-359（2026-09-13）：摘要变了——同一批别名退役波及这一层的
    // `composeSqliteWebhookIngressPersistence` → `composeWebhookIngressPersistenceFor`（plan §5ds）。
    //
    // RFC-359（2026-09-13，apply 引擎合一，plan §5dv）：形参表里的
    // `resourcePackageCatalog: ComposedResourcePackageCatalog | null` 变成
    // `resourcePackageBinding: ResourcePackageRouteBinding | null`，资源包路由挂载改从这个绑定
    // 取目录与 `commandContextFor`——写会话要把 `context.authority` 解回 Actor 并与传入的 Actor
    // 对照，所以目录与「造 context 的那条路」必须同源。
    //
    // RFC-359 AC-1（2026-09-15，plan §5ft）：摘要随一处被调用者改名更新——
    // `composeSqliteDevelopmentToolConnectionCatalog` → `composeDevelopmentToolConnectionCatalog`
    // （工具连接目录合一）。**挂载图未变**，只是被调用者少了个品牌前缀。
    // RFC-359 AC-1（2026-09-15，plan §5fu）：摘要随**纯装配别名批退**再更新——那一批 20 个
    // 别名（`composeSqliteX` / `composePostgresqlX`）本来就指着同一个函数，去掉品牌前缀后
    // 这几段装配体的**文本**变了，**装配图一条没动**（上面的语句数断言没红）。
    // RFC-359 AC-1（2026-09-16，plan §5gt）：同上一处，随 secretBox 收成必填而更新——
    // 这一段里去掉的是 `multipart` 与 employee 工作区那两处条件展开。
    // RFC-359 AC-1（2026-09-16，plan §5hl）：数字员工执行合成一份后，这一段把
    // `db + startDeps` 换成了端口 + 启动内核（`composeHostTaskLaunchKernel`）与
    // 库内缺省端口的展开。**装配图变了是有意的**：少一个 `startTask` 调用点（rfc301 账本同步删行），
    // 这一层不再自己读库。
    // RFC-359 AC-1（2026-09-17，plan §5hn 批次一）：摘要随**单代理启动路由改走共享编排**更新——
    // `createSqliteTaskRouteLaunchOperations` 这一段多了根内核要的几格依赖
    // （`gitCommitIdentity` / `agent` / `routeWorkspace` / `resourceAuthorityFor` / `coordinator`）。
    // **装配图确实变了，而且是有意的**：这条路由此前转 `startExecution` → `startAgentTask`
    // → `startTask`（只服务 SQLite 的那半），现在与 PostgreSQL 共用 `createAgentRouteLaunch`。
    // RFC-359 AC-1（2026-09-17，plan §5hn 批次二 ③）：摘要随**工作组启动也改走共享编排**更新——
    // `createSqliteTaskRouteLaunchOperations` 这一段多了工作组臂的资源面（`workgroup`）。
    // **装配图确实变了，是有意的**：这条路由此前转 `startExecution` → `startWorkgroupTask`
    // （470 行、直接读库），现在与 PostgreSQL 共用 `createWorkgroupRouteLaunch`。
    // 同一批里这一段还**净减**一格：两条臂都不再经遗留执行器之后，`executionFor`
    // （`buildStartTaskDeps(...)` + `agentLaunchResources` 的那块展开）在这里彻底退役。
    // RFC-359 AC-1（2026-09-17，plan §5hn 批次二 ①）：`workgroup` 那格从一整段手写对象
    // 字面量（loadVisible / loadExistingAgentIds / integrity）换成一次
    // `composeWorkgroupLaunchResourceOperations({ db, integrity })` 调用——两个组合根与
    // PG 守护进程根共用同一份实现，手拼的那三份一起消失。
    // RFC-359 AC-1（2026-09-17，plan §5hn 批次二 ①②）：摘要随**定时启动也改走共享编排**更新——
    // `buildScheduleLaunch(db, …)`（`startExecution` 三分支 switch 的第三份写法）换成
    // `createBuildScheduleLaunch(createTaskExecutionTriggerParticipant({ launches, cancellation }))`，
    // 路由启动的依赖束提成具名 const 供两处复用，并给那台协调器补上延后仓库准备的第 0 步。
    // RFC-359 AC-1（2026-09-17，plan §5hn 批次二 ①② 收尾）：摘要随**协调器补回运行期配置**更新
    // （`...resolveLaunchRuntimeConfig(deps.configPath)`）。20d4a6ce5 把 webhook 启动挪到这台
    // 协调器上时漏了它——`runtimeConfigOpts(deps)` 于是读到十七个 undefined，驱动退回编译期缺省，
    // e2e 当场红在「故意崩溃的 runtime 节点被重试 8 次」（判据要 1 次）。
    // RFC-359 AC-1（2026-09-17，plan §5hn 批次二 ④）：摘要随**工作流 JSON 路由也改走共享编排**
    // 更新——`assertWorkflowLaunchable: (workflow) => assertWorkflowSnapshotLaunchable(deps.db, …)`
    // 换成 `launches` **转发面**（真参与者是同一作用域后面那个 const，它依赖的
    // `taskRouteLaunchDependencies` 在本函数更下方才装配得起来，与协调器转发面同一个词法闭环手法）。
    // **装配图确实变了，是有意的**：这条路由此前转 `startExecution` → `startTask`
    //（三千行的老启动器），现在与 PostgreSQL 共用同一台根启动内核；那道
    // `assertWorkflowLaunchable` 是参与者已经做过的同一次静态校验，留着就是做两遍。
    // RFC-359 AC-1（2026-09-17，plan §5hn 批次二 ⑥）：摘要随 **multipart 路由也改走共享编排**
    // 更新——这一层原来给 SQLite 路由拼的那整格 `multipart: { secretBox, configPath,
    // schedulerDriver, identityAccess }`（`MultipartLaunchDeps`）退役了。
    // **装配图确实变了，是有意的**：multipart 启动此前转 `services/multipartTaskStart.ts` →
    // `startExecution` → `startTaskImpl`，现在与 PostgreSQL 共用同一个启动参与者
    //（路由只解析表单 + 跑路由级门，把已解析的分片交给参与者）。
    // RFC-359 AC-1（2026-09-17，plan §5hn 之后的盘点第 3 刀）：摘要随 SQLite 任务路由新增
    // `owners`（列表行的 owner 身份投影，由组合根装配后注入）更新——与 PostgreSQL 那一侧同形，
    // infrastructure 不再自己去 compose 别的 context。
    // RFC-359 AC-1（2026-09-17，第 5 刀）：再新增 `activity`——`delete` 的 `task-active` 门
    // 读注入的参与者而不是模块级全局，这条路不装配完整 runtime，所以直接取那个唯一装配点。
    // RFC-359 AC-1（第 8 刀）：摘要随手动 / 自动修复合一更新——SQLite 任务路由新增
    // `persistence` / `resumeTaskAs` / `repair` 三样（共用那份修复实现的依赖面），
    // 同时 `repairOptions` / `applyRepair` 两个动词从内联转成转发。
    // RFC-359 AC-1（第 9 刀）：摘要随 `retry` 合一更新——SQLite 任务路由再新增
    // `repositoryPreparationRetry` / `cancelChildTaskForCascade` 两样（共用那份 `retry`
    // 实现的依赖面：`__repo_prep__` 的自有重试路径，与级联取消旧世代子任务）。
    // **装配图确实变了，是有意的**：这条路由此前转 `services/task.ts` 的 `retryNode`
    //（485 行，retry 的第二份实现），现在与 PostgreSQL 共用同一份 `retryNodeProjection`。
    // 两样依赖都用本文件既有的同一句写法（准备重试同 `cli/start.ts`，级联取消走 `cancelTask`）。
    // RFC-359 AC-1（第 10 刀）：摘要随 `resume` 合一更新——`resumeTaskAs` 这一格从
    // 「拼一份 `StartTaskDeps` 交给 `resumeTask`」变成「逐样交给共用的 `resumeTaskProjection`」。
    // **装配图确实变了，是有意的**：这条路此前跑的是 `services/task.ts` 的 `resumeTask`
    //（retry 之外的第二处两份实现），现在与 PostgreSQL 共用同一份。依赖面反而更窄了
    //（六样，`executionModule` / `finalizeWorkspace` 都折进 `lifecycle`），
    // 而**两个引擎唯一的真差异（认领策略）就落在这里交进去的那个 `lifecycle` 上**。
    // RFC-359 AC-1（第 11 刀）：摘要随 `cancel` 合一更新——这条路的 `cancelTask` 与
    // `cancelChildTaskForCascade` 两处从 legacy 的 `cancelTask(deps.db, …)` 换成模块自己的
    // 装配（`composeTaskCancellation(deps.db).cancel(…)`，级联那处直接交 `parent-cascade` cause）。
    // **装配图确实变了，是有意的**：这条路此前跑的是 `services/task.ts` 的 `cancelTask`
    //（retry / resume 之外的第三处两份实现，且它自己就是装配点），现在与 PostgreSQL 共用
    // 同一份 `cancelTaskProjection`，薄壳整个删除。
    // RFC-359 AC-1（命名债收尾 §5hj）：摘要随**纯改名**更新——四份 provider 中立的实现去掉
    // `postgresql` 前缀（`childExecutionLaunchOperations` / `childTaskLifecycleParticipant` /
    // `taskRouteLaunchOperations` / `taskRouteWorkspaceParticipant`），本函数体里那些
    // `createPostgresql*` 调用随之改名。**装配图一格没变**，变的只有标识符。
    // RFC-359 AC-1（第 13 刀）：摘要随 `/api/tasks` 两个绑定合一而更新。这一层改调中立的
    // `createTaskRouteOperations`：`recovery` / `startDepsFor` 两格整个消失（路由层不再持有
    // legacy `StartTaskDeps`），换成 `validateHostWorkflow` 转发面；`resumeTaskAs` /
    // `cancelChildTaskForCascade` 两个 lambda 折成一个 `children` 参与者 + `topology` +
    // `resumeRuntimeFor`（与 PostgreSQL 那一支逐字同形）。
    // **装配出来的东西不变**：复活仍是同一条进程级单例认领 + 同一个收尾器，静态校验门仍指向
    // 同一份 `composeAgentLaunchResourceOperations`。
    expect(digest(oldPhaseBody(server, 'composeSqliteApiRouteMounts'), server)).toBe(
      // 2026-09-19（第二次重采）：三条被合一丢掉的装配步骤补回来——长驻协调器的运行期配置改成
      // 每次 drive 现读（`refreshLaunchConfig` / `currentRunConfig()` getter）、仓库准备重试把
      // 发起人原样传下去、数字员工执行在 launch 前播种合成宿主工作流行。三条都是**补齐**，
      // 判据分别在 `tests/rfc319-cfg45-default-runtime-hot-read.test.ts` 与
      // `tests/rfc319-task27-de28-manual-retry-and-host-anchor.test.ts`。
      // RFC-360: config uses the same management application and composition-bound probe fence.
      // RFC-363: add only the same-provider Task workspace reader, verified below.
      // RFC-364: explicit single-instance diagnostics, IA contexts and narrow route/reconcile projections.
      // Exact diagnostics bindings are guarded in rfc364-diagnostics-bindings.test.ts.
      // RFC-363 adds the SC preparation binding to Task admission and the existing deferred step; no new worker.
      '9aace7e9bfc56b8b2067d7216401459a4d9d71a51f565c37c80e883e8027ee92',
    )
    expect(
      namedCalls(
        functionBody(server, 'composeSqliteApiRouteMounts'),
        server,
        'composeRuntimeManagement',
      ),
    ).toHaveLength(1)
    expect(digest(oldEventCenterBody(), server)).toBe(
      '237773ee140c430dceaea8a12a04437482b305f846c45065fe31043fce226148',
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
      // 2026-09-19 重采：`taskArchive` 的挂载点移到 `tasks` 之前——Hono 的 `*` 能匹配零个段，
      // `'/api/tasks/:id/*'` 那道可见性中间件会吞掉兄弟字面路由 `POST /api/tasks/archive`
      // 并把它变成 404（只对非管理员，见 server.ts 该处注释与
      // tests/rfc311-task-archive-route-reachability.test.ts）。摘要随之变。
      mountApiRoutes: 'ad3aabd891e51458a246b8162514c0bb1bc645ede3922272d6e77292b5029a05', // gitleaks:allow
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
  return new Function('composeMcpDiagnostics', `${code}\nreturn composeUnstartedApplication`)(
    (input: ControlledMcpInput) => new ControlledMcpService(input),
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
