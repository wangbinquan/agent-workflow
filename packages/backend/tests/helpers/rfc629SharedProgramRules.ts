// RFC-629: single-source pure rule detectors & ledgers shared between
// `architecture/rfc629-shared-program-guards.test.ts` (live multi-program scans)
// and each original guard file (isolated negative fixtures & behavior proofs).
import { resolve } from 'node:path'
import ts from 'typescript'

// ---------------------------------------------------------------------------
// 1. RFC-359 W5-T18: bare `db.transaction(`
// ---------------------------------------------------------------------------

export const TRANSACTION_PRIMITIVES: Readonly<Record<string, string>> = {
  'db/txSync.ts':
    'RFC-093 的同步事务原语 `dbTxSync` 的定义处：它就是那个包住 bun:sqlite 同步包装器的地方' +
    '（在类型层把返回 promise 的回调塌成 never、运行期对 thenable 抛错回滚，并补 { behavior: "immediate" }）。' +
    '它自己必须调驱动的 db.transaction，否则无从实现。它的**调用点**由 rfc359-sync-transaction-highwater 单独清点。',
  'platform/persistence/databaseTransaction.ts':
    'RFC-359 W2 的中立原语本体：`createPostgresqlDatabaseSession` 的 transaction / snapshotRead / ' +
    'serializable 三处直接调 PG 驱动的 db.transaction，那正是「中立会话在 PG 上的实现」。' +
    'SQLite 那半在同一文件里刻意**不**用驱动的 transaction，改发显式 BEGIN IMMEDIATE / COMMIT / ROLLBACK。',
  'platform/persistence/postgresqlDatabaseClient.ts':
    'RFC-395 I-b 原生 Bun.SQL 连接边界：先 reserve 再在同一连接 begin，嵌套事务使用原生 savepoint；连接包装器负责事务内的写入标记和部署门，并把 reserve 等待纳入已有遥测。',
}

export const BARE_TRANSACTION_DEBT: readonly string[] = []

function isDatabaseHandle(type: ts.Type, checker: ts.TypeChecker): boolean {
  if (type.isUnionOrIntersection()) {
    return type.types.some((member) => isDatabaseHandle(member, checker))
  }
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true
  const has = (name: string): boolean => checker.getPropertyOfType(type, name) !== undefined
  return (
    ['select', 'insert', 'update', 'delete'].every(has) ||
    ['prepare', 'query', 'exec'].every(has) ||
    has('unsafe')
  )
}

export function countBareTransactions(source: ts.SourceFile, checker: ts.TypeChecker): number {
  let count = 0
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const receiver =
        ts.isPropertyAccessExpression(callee) &&
        ['transaction', 'begin', 'savepoint'].includes(callee.name.text)
          ? callee.expression
          : ts.isElementAccessExpression(callee) &&
              ts.isStringLiteralLike(callee.argumentExpression) &&
              ['transaction', 'begin', 'savepoint'].includes(callee.argumentExpression.text)
            ? callee.expression
            : undefined
      if (
        receiver !== undefined &&
        isDatabaseHandle(checker.getTypeAtLocation(receiver), checker)
      ) {
        count += 1
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return count
}

// ---------------------------------------------------------------------------
// 2. RFC-359 W5: unattended `void <promise>`
// ---------------------------------------------------------------------------

export const UNATTENDED_VOID_PROMISE_DEBT: readonly string[] = [
  // RFC-383: the two terminal callbacks move from both roots into one session bundle.
  'bootstrap/daemonModules/developmentAutomation.ts: 2',
  'mcp/server.ts: 1',
  // RFC-370 H8: the existing observer nudge moved out of the HTTP transport unchanged.
  'modules/integration/application/verifiedWebhookIngress.ts: 1',
  'modules/intent/application/dispatcher.ts: 3',
  'modules/intent/inbound/intentSessionRoutes.ts: 10',
  // RFC-451: moved unchanged from services/repoBatchImport.ts.
  'modules/source-control/infrastructure/local/repositoryBatchImport.ts: 2',
  // RFC-476: moved unchanged from services/reviewMutationCoordinator.ts (the in-flight lookup registration).
  'modules/task-execution/infrastructure/reviewMutationQueue.ts: 1',
  // RFC-453: moved unchanged from services/structuralDiff/service.ts.
  'modules/workspace-insight/application/structuralDiff/taskStructuralDiff.ts: 2',
  'platform/background/maintenanceService.ts: 1',
  'platform/background/maintenanceWorkerRuntime.ts: 3',
  'platform/events/committed/workerDefinitions.ts: 1',
  // RFC-456: moved unchanged from services/controlListener.ts.
  'platform/execution/local/controlListener.ts: 1',
  'platform/execution/local/managedProcess.ts: 4',
  // RFC-392 removes the unused SQLite test initialization fallback.
  'server.ts: 1',
]

function isThenable(type: ts.Type): boolean {
  if (type.isUnionOrIntersection()) return type.types.some(isThenable)
  return type.getProperty('then') !== undefined
}

function hasRejectionHandler(expr: ts.Expression): boolean {
  let cur: ts.Expression = expr
  for (;;) {
    if (ts.isParenthesizedExpression(cur)) {
      cur = cur.expression
      continue
    }
    if (ts.isAwaitExpression(cur)) return true
    if (!ts.isCallExpression(cur)) return false
    const callee = cur.expression
    if (!ts.isPropertyAccessExpression(callee)) return false
    if (callee.name.text === 'catch') return true
    if (callee.name.text === 'then' && cur.arguments.length >= 2) return true
    cur = callee.expression
  }
}

export function countUnattendedVoidPromises(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): number {
  let count = 0
  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node) && ts.isVoidExpression(node.expression)) {
      const inner = node.expression.expression
      if (!hasRejectionHandler(inner) && isThenable(checker.getTypeAtLocation(inner))) count += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return count
}

// ---------------------------------------------------------------------------
// 3. RFC-395 I-b: neutral query boundary
// ---------------------------------------------------------------------------

export function isNeutralQueryWiringPath(path: string): boolean {
  return (
    path.startsWith('platform/persistence/') ||
    path.startsWith('db/') ||
    path === 'bootstrap/persistenceSchema.ts' ||
    /\/infrastructure\/persistence\/schema\.ts$/.test(path)
  )
}

export function sqliteQueryFindings(source: ts.SourceFile, checker: ts.TypeChecker): string[] {
  const findings: string[] = []
  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === 'drizzle-orm/sqlite-core'
    )
      findings.push('sqlite-core import')
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      if (['get', 'all', 'run', 'values'].includes(method)) {
        const receiver = checker.getTypeAtLocation(node.expression.expression)
        const has = (name: string) => checker.getPropertyOfType(receiver, name) !== undefined
        if (has('select') && has('insert')) findings.push(`raw database .${method}`)
        else if (method !== 'values' && has('then') && has('getSQL'))
          findings.push(`SQLite query .${method}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return findings
}

// ---------------------------------------------------------------------------
// 4. Scheduler audit S-10 & RFC-317 T37: decorative async / raw SQLite tx
// ---------------------------------------------------------------------------

export interface RawTransactionSite {
  readonly count: number
  readonly why: string
}

export const EXPECTED_ASYNC_TX_SITES: Readonly<Record<string, number>> = {}
export const RAW_TRANSACTION_SITES: Readonly<Record<string, RawTransactionSite>> = {}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')
}

export function countNonCommentMatches(content: string, re: RegExp): number {
  let n = 0
  for (const line of content.split('\n')) {
    if (isCommentLine(line)) continue
    const m = line.match(re)
    if (m) n += m.length
  }
  return n
}

export function withoutNeutralSessionTransactions(content: string): string {
  return content.replace(
    /databaseSessionFor\([^()]*\)\s*\.transaction\s*\(/g,
    'databaseSessionFor(…)(',
  )
}

export function withoutConversionTargetTransactions(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
  backendSrc: string,
  content = source.text,
): string {
  const ranges: Array<{ start: number; end: number }> = []
  const targetTypesPath = resolve(backendSrc, 'platform/persistence/migration/run/types.ts')
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'transaction'
    ) {
      const callee = node.expression
      const type = checker.getTypeAtLocation(callee.expression)
      const declarations = checker.getPropertyOfType(type, 'transaction')?.declarations ?? []
      if (
        !(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) &&
        declarations.length > 0 &&
        declarations.every(
          (declaration) =>
            resolve(declaration.getSourceFile().fileName) === targetTypesPath &&
            ts.isInterfaceDeclaration(declaration.parent) &&
            declaration.parent.name.text === 'ConversionTargetConnection',
        )
      )
        ranges.push({ start: callee.name.getStart(source), end: callee.name.getEnd() })
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  for (const { start, end } of ranges.sort((a, b) => b.start - a.start))
    if (end <= content.length)
      content = content.slice(0, start) + ' '.repeat(end - start) + content.slice(end)
  return content
}

export function sqliteTransactionSource(relativePath: string, content: string): string | null {
  if (/(^|\/)postgresql[^/]*\.ts$/i.test(relativePath)) return null
  const ownsSqlite =
    /(^|\/)sqlite[^/]*\.ts$/i.test(relativePath) ||
    /from\s+['"](?:@\/db\/client|[^'"]*\/db\/client)['"]/.test(content) ||
    /from\s+['"](?:bun:sqlite|drizzle-orm\/bun-sqlite)['"]/.test(content)
  if (!ownsSqlite) return null

  const postgresqlFactory = content.search(
    /(?:export\s+)?(?:async\s+)?function\s+\w*Postgresql\w*\s*\(/,
  )
  return postgresqlFactory < 0 ? content : content.slice(0, postgresqlFactory)
}

// ---------------------------------------------------------------------------
// 5. RFC-374: NodeRun mint order guard (full R1-R4)
// ---------------------------------------------------------------------------

export interface NodeRunOrderViolation {
  readonly file: string
  readonly line: number
  readonly rule: 'R1' | 'R2' | 'R3' | 'R4'
  readonly text: string
  readonly allowance: string | null
}

export interface NodeRunOrderException {
  readonly count: number
  readonly reason: string
}

const RUN_FIELDS = [
  'nodeId',
  'parentNodeRunId',
  'retryIndex',
  'rerunCause',
  'iteration',
  'shardKey',
  'wgRound',
  'containerRunId',
]
const RELATIONS = new Set([
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
])

export function detectNodeRunIdOrder(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): NodeRunOrderViolation[] {
  const hits: NodeRunOrderViolation[] = []
  const frontendNodeRun =
    source.fileName.replaceAll('\\', '/').includes('/frontend/') &&
    /import\s+(?:type\s+)?[\s\S]*?\{[^}]*\bNodeRun\b[^}]*\}\s*from\s*['"]@agent-workflow\/shared['"]/.test(
      source.text,
    )
  const tables = new Set(['nodeRuns'])
  const visitAll = (node: ts.Node, fn: (node: ts.Node) => void): void => {
    fn(node)
    ts.forEachChild(node, (child) => visitAll(child, fn))
  }
  let grew = true
  while (grew) {
    grew = false
    visitAll(source, (node) => {
      if (
        ts.isImportSpecifier(node) &&
        node.propertyName?.text === 'nodeRuns' &&
        !tables.has(node.name.text)
      ) {
        tables.add(node.name.text)
        grew = true
      }
      if (
        !ts.isVariableDeclaration(node) ||
        !ts.isIdentifier(node.name) ||
        !node.initializer ||
        !ts.isCallExpression(node.initializer)
      )
        return
      const init = node.initializer
      if (
        init.expression.getText(source) === 'alias' &&
        init.arguments[0] &&
        tables.has(init.arguments[0].getText(source)) &&
        !tables.has(node.name.text)
      ) {
        tables.add(node.name.text)
        grew = true
      }
    })
  }
  const tableRefs = (node: ts.Node, property: string): Set<string> => {
    const refs = new Set<string>()
    visitAll(node, (child) => {
      if (
        ts.isPropertyAccessExpression(child) &&
        child.name.text === property &&
        tables.has(child.expression.getText(source))
      )
        refs.add(child.expression.getText(source))
    })
    return refs
  }
  const runShape = (node: ts.Expression): boolean => {
    const type = checker.getNonNullableType(checker.getTypeAtLocation(node))
    const id = type.getProperty('id')
    if (!id) return false
    const idType = checker.getTypeOfSymbolAtLocation(id, node)
    if (!(idType.flags & ts.TypeFlags.StringLike)) return false
    return RUN_FIELDS.filter((field) => type.getProperty(field)).length >= 2
  }
  const inComparator = (node: ts.Node): boolean => {
    for (let current: ts.Node | undefined = node; current; current = current.parent) {
      if (
        ts.isFunctionDeclaration(current) &&
        current.name &&
        /^(?:isFresherNodeRun|compareNodeRunMintOrder|compareLegacyNodeRunMintOrder|isNewerNodeRun)$/.test(
          current.name.text,
        )
      )
        return true
    }
    return false
  }
  const operand = (node: ts.Expression): boolean => {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAsExpression(node)
    )
      return operand(node.expression)
    if (ts.isIdentifier(node)) return /(?:^r|R)unId$/.test(node.text)
    if (ts.isPropertyAccessExpression(node)) {
      if (node.name.text === 'runId' || node.name.text === 'nodeRunId') return true
      return (
        node.name.text === 'id' &&
        (frontendNodeRun || runShape(node.expression) || inComparator(node))
      )
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
    )
      return operand(node.left) || operand(node.right)
    return false
  }
  const report = (node: ts.Node, rule: NodeRunOrderViolation['rule']): void => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line
    const allowance =
      source.text
        .split('\n')
        .slice(Math.max(0, line - 5), line + 1)
        .map((text) => /\/\/\s*s1-allow-id-order:\s*(\S.*)/.exec(text)?.[1])
        .find(Boolean) ?? null
    hits.push({
      file: source.fileName.replaceAll('\\', '/'),
      line: line + 1,
      rule,
      text: node.getText(source),
      allowance,
    })
  }
  visitAll(source, (node) => {
    if (ts.isCallExpression(node)) {
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'orderBy'
      ) {
        const seen = new Set<string>()
        for (const arg of node.arguments) {
          if ([...tableRefs(arg, 'id')].some((table) => !seen.has(table))) report(arg, 'R1')
          for (const table of tableRefs(arg, 'seq')) seen.add(table)
        }
      }
      if (
        ts.isIdentifier(node.expression) &&
        /^(?:gt|gte|lt|lte)$/.test(node.expression.text) &&
        node.arguments.some((arg) => tableRefs(arg, 'id').size > 0)
      )
        report(node, 'R2')
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'localeCompare' &&
        (operand(node.expression.expression) || node.arguments.some(operand))
      )
        report(node, 'R4')
    }
    if (
      ts.isBinaryExpression(node) &&
      RELATIONS.has(node.operatorToken.kind) &&
      (operand(node.left) || operand(node.right))
    )
      report(node, 'R3')
  })
  return hits
}

export function checkNodeRunOrderExceptions(
  hits: readonly NodeRunOrderViolation[],
  exceptions: Readonly<Record<string, NodeRunOrderException>>,
): string[] {
  const counts = new Map<string, number>()
  for (const hit of hits) {
    if (hit.allowance !== null) continue
    counts.set(hit.file, (counts.get(hit.file) ?? 0) + 1)
  }
  const errors: string[] = []
  for (const [file, count] of counts) {
    const allowed = exceptions[file]
    if (!allowed || count > allowed.count) errors.push(`unregistered: ${file}: ${count}`)
  }
  for (const [file, exception] of Object.entries(exceptions)) {
    if ((counts.get(file) ?? 0) < exception.count || !exception.reason.trim())
      errors.push(`stale: ${file}: ${counts.get(file) ?? 0}/${exception.count}`)
  }
  return errors
}

export function nodeRunOrderVirtualProgram(files: Readonly<Record<string, string>>): ts.Program {
  const options: ts.CompilerOptions = { noLib: true, strict: true, target: ts.ScriptTarget.ESNext }
  const host = ts.createCompilerHost(options)
  host.fileExists = (file) => file in files
  host.readFile = (file) => files[file]
  host.getSourceFile = (file, languageVersion) =>
    files[file] === undefined
      ? undefined
      : ts.createSourceFile(file, files[file], languageVersion, true)
  host.writeFile = () => undefined
  return ts.createProgram(Object.keys(files), options, host)
}

export const NODE_RUN_ORDER_EXCEPTIONS: Readonly<Record<string, NodeRunOrderException>> = {
  'packages/backend/src/modules/task-execution/domain/humanGateContinuation.ts': {
    count: 1,
    reason: 'Persisted continuation digest input order must remain byte-compatible.',
  },
  'packages/backend/src/modules/collaboration/infrastructure/clarify/autoDispatch.ts': {
    count: 1,
    reason: 'Canonical dispatch receipt order is independent of run freshness.',
  },
  'packages/backend/src/modules/resource-catalog/application/workgroups/workgroupRoomProjection.ts':
    { count: 1, reason: 'Legacy leader rounds compare message IDs with run IDs across entities.' },
  'packages/frontend/src/lib/workgroup-room.ts': {
    count: 1,
    reason: 'Message/run interleaving is a cross-entity legacy display boundary.',
  },
  'packages/backend/src/modules/task-execution/infrastructure/migration/oracle/legacyOrder.ts': {
    count: 2,
    reason:
      'RFC-395 D4: epoch-1 NULL/NULL order and theoretical seq ties, kept for the conversion oracle only.',
  },
}

// ---------------------------------------------------------------------------
// 6. RFC-395 D4: mint order boundary
// ---------------------------------------------------------------------------

export const MINT_ORDER_MIGRATION_PREFIX =
  'packages/backend/src/modules/task-execution/infrastructure/migration/'

const LEGACY_MINT_ORDER_NAMES = new Set([
  'compareLegacyNodeRunMintOrder',
  'isNewerLegacyNodeRun',
  'legacyNodeRunOrderAnchor',
  'nodeRunOrderAnchor',
])

export const MINT_ORDER_EXCEPTIONS: ReadonlyMap<string, string> = new Map([
  [
    'packages/backend/src/modules/task-execution/domain/runSelection/legacyFacts.ts|readonly seq?: number | null',
    'frozen epoch-1 row facts the converter reads before it numbers the rows; missing ≠ NULL',
  ],
])

type MintOrderRule = 'legacy-order-name' | 'nullable-seq' | 'seq-null-check'

export function mintOrderHits(unit: {
  readonly path: string
  readonly source: ts.SourceFile
}): string[] {
  const hits: string[] = []
  const add = (rule: MintOrderRule, node: ts.Node) =>
    hits.push(`${rule}:${unit.path}|${node.getText(unit.source).replace(/\s+/g, ' ')}`)
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && LEGACY_MINT_ORDER_NAMES.has(node.text))
      add('legacy-order-name', node)
    if (
      (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'seq' &&
      node.type !== undefined &&
      ts.isUnionTypeNode(node.type) &&
      node.type.types.some(
        (member) =>
          ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword,
      )
    )
      add('nullable-seq', node)
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(node.operatorToken.kind)
    ) {
      const [left, right] = [node.left, node.right]
      const isSeq = (side: ts.Expression) =>
        (ts.isPropertyAccessExpression(side) && side.name.text === 'seq') ||
        (ts.isIdentifier(side) && side.text === 'seq')
      const isNull = (side: ts.Expression) => side.kind === ts.SyntaxKind.NullKeyword
      if ((isSeq(left) && isNull(right)) || (isNull(left) && isSeq(right)))
        add('seq-null-check', node)
    }
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  return hits
}
