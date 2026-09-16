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
  test('daemon phase retains the complete original 160-statement graph and ordered effects', () => {
    const body = functionBody(pg, 'composePostgresqlApplication')
    const phaseBlocks = body.statements.filter(
      (node): node is ts.IfStatement =>
        ts.isIfStatement(node) && compact(node.expression, pg) === "phase.kind==='daemon'",
    )
    expect(phaseBlocks).toHaveLength(8)
    const restored = oldPhaseBody(pg, 'composePostgresqlApplication')
    expect(restored.statements).toHaveLength(160)
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
    expect(digest(restored, pg)).toBe(
      '4ea94193a3fc6417aa5094168a5555bd0735f2cc2158b186d477c498fe3ce91f',
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
    expect(digest(oldPhaseBody(server, 'composeSqliteApplicationDeps'), server)).toBe(
      '9f05d1bead6df62355b4d6a5b67ef261baed442bdc9521ce725925e2789b0002',
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
    expect(digest(oldPhaseBody(server, 'composeSqliteApiRouteMounts'), server)).toBe(
      'cd71778040adfd6ec425cd21006d92642e2852e15cf91adb94b7ff81cc78fdd5',
    )
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
