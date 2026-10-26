// RFC-376: pure structural gates. Callers choose a working-tree or committed corpus.
import { posix } from 'node:path'
import ts from 'typescript'
import { importEdges, moduleLocation, sourceUnit, type ImportEdge, type SourceUnit } from './census'
import { OFFERED_CONTEXT_PAIRS } from './rfc294Target'
import { nonruntimeSourceRole } from './nonruntimeSourceRoles'

function gateModuleLocation(path: string): { context: string; rest: string } | null {
  const resolved = moduleLocation(path)
  if (resolved !== null) return resolved
  const root = /^packages\/backend\/src\/modules\/([a-z0-9-]+)(?:\.[cm]?[jt]sx?)?$/.exec(path)
  return root === null ? null : { context: root[1]!, rest: '' }
}

export const BACKEND_PREFIX = 'packages/backend/src/'
export const ARCHITECTURE_FILES = [
  'commons-manifest.json',
  'commons-debt.json',
  'guard-manifest.json',
  'counts.json',
  'e2e-capability-ledger.json',
  'e2e-endpoint-coverage.json',
  'e2e-route-coverage.json',
  'repository-publication-call-sites.json',
] as const
export const BINARY_ENTRIES = [
  'main.ts',
  'services/backupVacuumWorker.ts',
  'bootstrap/maintenanceWorker.ts',
  'bootstrap/maintenanceWorkerEntry.ts',
  'platform/persistence/sqliteLogicalSourceWorker.ts',
  'platform/execution/local/managedProcessLauncher.ts',
  'util/gitCredentialHelper.ts',
].map((path) => BACKEND_PREFIX + path)

export interface ResolvedEdge extends ImportEdge {
  readonly target: string
  readonly workerUrl?: boolean
}
export interface GateCorpus {
  readonly units: readonly SourceUnit[]
  readonly backend: readonly SourceUnit[]
  readonly byPath: ReadonlyMap<string, SourceUnit>
  readonly edges: readonly ResolvedEdge[]
  readonly imports: ReadonlyMap<string, readonly ResolvedEdge[]>
}
export function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}
export function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}
export function unwrap(node: ts.Expression): ts.Expression {
  while (
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
  )
    node = node.expression
  return node
}
export function literal(node: ts.Node | undefined): string | null {
  if (node === undefined) return null
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isLiteralTypeNode(node)) return literal(node.literal)
  return null
}
export function memberName(node: ts.Node): string | null {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node)) return literal(node.argumentExpression)
  return null
}
export function calleeName(node: ts.Node): string {
  if (ts.isIdentifier(node)) return node.text
  if (ts.isPropertyAccessExpression(node)) return `${calleeName(node.expression)}.${node.name.text}`
  if (ts.isElementAccessExpression(node))
    return `${calleeName(node.expression)}.${literal(node.argumentExpression) ?? '?'}`
  return '$expression'
}
export function enclosingSymbol(node: ts.Node): string {
  let cursor: ts.Node | undefined = node.parent
  const names: string[] = []
  while (cursor !== undefined && !ts.isSourceFile(cursor)) {
    if (
      (ts.isFunctionDeclaration(cursor) ||
        ts.isMethodDeclaration(cursor) ||
        ts.isClassDeclaration(cursor) ||
        ts.isInterfaceDeclaration(cursor) ||
        ts.isTypeAliasDeclaration(cursor) ||
        ts.isVariableDeclaration(cursor) ||
        ts.isPropertyAssignment(cursor)) &&
      cursor.name !== undefined
    )
      names.unshift(cursor.name.getText())
    cursor = cursor.parent
  }
  return names.join('.') || '$file'
}
export function siteRecorder(file: string): (node: ts.Node, kind: string) => string {
  const ordinals = new Map<string, number>()
  return (node, kind) => {
    const key = `${file}#${enclosingSymbol(node)}#${kind}`
    const ordinal = (ordinals.get(key) ?? 0) + 1
    ordinals.set(key, ordinal)
    return `${key}#${ordinal}`
  }
}

/** Unresolved first-party paths still participate in boundary gates. */
export function resolveImport(
  from: string,
  specifier: string,
  files: ReadonlySet<string>,
  exports: Readonly<Record<string, string>> = {},
): string {
  let candidate: string
  if (specifier.startsWith('@/')) candidate = `${from.split('/src/')[0]}/src/${specifier.slice(2)}`
  else if (specifier.startsWith('.'))
    candidate = posix.normalize(posix.join(posix.dirname(from), specifier))
  else if (specifier === '@agent-workflow/shared') candidate = 'packages/shared/src/index'
  else if (specifier.startsWith('@agent-workflow/shared/'))
    candidate = 'packages/shared/src/' + specifier.slice('@agent-workflow/shared/'.length)
  else if (
    specifier === '@agent-workflow/system-mocks' ||
    specifier.startsWith('@agent-workflow/system-mocks/')
  ) {
    const key =
      specifier === '@agent-workflow/system-mocks'
        ? '.'
        : './' + specifier.slice('@agent-workflow/system-mocks/'.length)
    const target = exports[key]
    if (target === undefined) return specifier
    candidate = posix.normalize('packages/system-mocks/' + target)
  } else return specifier
  const stem = candidate.replace(/\.[cm]?jsx?$/, '')
  const attempts = [
    candidate,
    `${candidate}.ts`,
    `${candidate}.tsx`,
    `${candidate}/index.ts`,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${candidate}.mjs`,
  ]
  return attempts.find((path) => files.has(path)) ?? candidate
}
export function createGateCorpus(
  units: readonly SourceUnit[],
  exports: Readonly<Record<string, string>> = {},
): GateCorpus {
  const byPath = new Map(units.map((unit) => [unit.path, unit]))
  const files = new Set(byPath.keys())
  const edges: ResolvedEdge[] = []
  const imports = new Map<string, ResolvedEdge[]>()
  for (const unit of units) {
    const parsed: Array<ImportEdge & { workerUrl?: boolean }> = importEdges(unit)
    // TypeScript import-equals is another require form; census's original parser predates it.
    walk(unit.source, (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length > 1
      ) {
        const specifier = literal(node.arguments[0])
        if (specifier !== null)
          parsed.push({ from: unit, specifier, kind: 'value', syntax: 'dynamic-import' })
      }
      // Empty binding clauses still load a module. RFC-375 includes these edges,
      // even though census's per-binding inventory has no symbol to record.
      if (
        ts.isImportDeclaration(node) &&
        node.importClause?.name === undefined &&
        node.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(node.importClause.namedBindings) &&
        node.importClause.namedBindings.elements.length === 0
      ) {
        const specifier = literal(node.moduleSpecifier)
        if (specifier !== null)
          parsed.push({
            from: unit,
            specifier,
            kind: node.importClause.isTypeOnly ? 'type' : 'value',
            syntax: 'static-import',
          })
      }
      if (
        ts.isExportDeclaration(node) &&
        node.exportClause !== undefined &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.length === 0
      ) {
        const specifier = literal(node.moduleSpecifier)
        if (specifier !== null)
          parsed.push({
            from: unit,
            specifier,
            kind: node.isTypeOnly ? 'type' : 'value',
            syntax: 'export',
          })
      }
      if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        const specifier = literal(node.moduleReference.expression)
        if (specifier !== null)
          parsed.push({
            from: unit,
            specifier,
            kind: node.isTypeOnly ? 'type' : 'value',
            syntax: 'require',
          })
      }
      if (
        ts.isNewExpression(node) &&
        calleeName(node.expression) === 'URL' &&
        ts.isNewExpression(node.parent) &&
        ['Worker', 'globalThis.Worker'].includes(calleeName(node.parent.expression)) &&
        node.arguments?.[1]?.getText(unit.source) === 'import.meta.url'
      ) {
        const specifier = literal(node.arguments[0])
        if (specifier !== null)
          parsed.push({
            from: unit,
            specifier,
            kind: 'value',
            syntax: 'dynamic-import',
            workerUrl: true,
          })
      }
    })
    const resolved = parsed.map((edge) => ({
      ...edge,
      target: resolveImport(unit.path, edge.specifier, files, exports),
    }))
    imports.set(unit.path, resolved)
    edges.push(...resolved)
  }
  return {
    units,
    backend: units.filter((unit) => unit.path.startsWith(BACKEND_PREFIX)),
    byPath,
    edges,
    imports,
  }
}
export function stronglyConnected(pairs: readonly (readonly [string, string])[]): string[][] {
  const graph = new Map<string, Set<string>>()
  for (const [from, to] of pairs) {
    if (!graph.has(from)) graph.set(from, new Set())
    if (!graph.has(to)) graph.set(to, new Set())
    graph.get(from)!.add(to)
  }
  let next = 0
  const indices = new Map<string, number>(),
    lows = new Map<string, number>()
  const stack: string[] = [],
    active = new Set<string>(),
    result: string[][] = []
  const visit = (node: string): void => {
    indices.set(node, next)
    lows.set(node, next++)
    stack.push(node)
    active.add(node)
    for (const target of graph.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target)
        lows.set(node, Math.min(lows.get(node)!, lows.get(target)!))
      } else if (active.has(target)) lows.set(node, Math.min(lows.get(node)!, indices.get(target)!))
    }
    if (lows.get(node) !== indices.get(node)) return
    const component: string[] = []
    let member: string
    do {
      member = stack.pop()!
      active.delete(member)
      component.push(member)
    } while (member !== node)
    if (component.length > 1 || graph.get(node)?.has(node)) result.push(component.sort())
  }
  for (const node of [...graph.keys()].sort()) if (!indices.has(node)) visit(node)
  return result.sort((a, b) => a.join('|').localeCompare(b.join('|')))
}
export function contextValuePairs(corpus: GateCorpus): string[] {
  return unique(
    corpus.edges.flatMap((edge) => {
      const from = gateModuleLocation(edge.from.path),
        to = gateModuleLocation(edge.target)
      return edge.kind === 'value' &&
        edge.workerUrl !== true &&
        from !== null &&
        to !== null &&
        from.context !== to.context
        ? [`${from.context}->${to.context}`]
        : []
    }),
  )
}
export function contextValueSccs(corpus: GateCorpus): string[] {
  return stronglyConnected(
    contextValuePairs(corpus).map((pair) => pair.split('->') as [string, string]),
  ).map((members) => members.join('|'))
}
export function contextPairsOffDag(corpus: GateCorpus): string[] {
  return contextValuePairs(corpus).filter((pair) => !OFFERED_CONTEXT_PAIRS.has(pair))
}
const EXACT_PUBLIC = /^public\/(?:commands|queries|events|participants|operations|types)$/
const REQUIRED_PORTS = /^composition\/required-ports$/
export function crossContextInternalPairs(corpus: GateCorpus): string[] {
  return unique(
    corpus.edges.flatMap((edge) => {
      const from = gateModuleLocation(edge.from.path),
        to = gateModuleLocation(edge.target)
      if (from === null || to === null || from.context === to.context || EXACT_PUBLIC.test(to.rest))
        return []
      if (
        /^application\/adapters\/.*-adapter$/.test(from.rest) &&
        edge.kind === 'type' &&
        REQUIRED_PORTS.test(to.rest)
      )
        return []
      return [`${edge.from.path} -> ${edge.target}`]
    }),
  )
}
interface ExactRequiredSpiBinding {
  readonly from: string
  readonly specifier: string
  readonly symbol: string
  readonly edgeKind: 'type' | 'value'
  readonly syntax: 'export' | 'static-import'
  readonly role:
    | 'contract-resource-projection-spi'
    | 'workgroup-host-ledger-provider'
    | 'workgroup-task-room-provider'
    | 'workgroup-turns-provider'
}

interface NamedModuleBinding {
  readonly specifier: string
  readonly symbol: string
  readonly edgeKind: 'type' | 'value'
  readonly syntax: 'export' | 'static-import'
}

/**
 * Required-SPI provider implementations point from the provider context to a
 * consumer-owned public contract. They are not offered consumption, even
 * though both classes use an exact public import in source.
 *
 * Keep this list binding-exact. In particular, RC's room projection consumes
 * the two Workgroup node constants as ordinary offered data and is deliberately
 * absent. A file, entrypoint, symbol, kind, or syntax change therefore becomes
 * an ordinary off-DAG edge until its provider role is reviewed explicitly.
 */
const EXACT_REQUIRED_SPI_BINDINGS: readonly ExactRequiredSpiBinding[] = [
  ...(
    [
      ['WORKGROUP_TURN_LEADER_NODE_ID', 'value'],
      ['WORKGROUP_TURN_MEMBER_NODE_ID', 'value'],
      // RFC-369 §4.4：内部错误路径上终结孤儿宿主 run 的账本操作，与 mint / stamp 同属宿主账本合同。
      ['WorkgroupHostLedgerFailRunOperation', 'type'],
      ['WorkgroupHostLedgerMintOperation', 'type'],
      ['WorkgroupHostLedgerMintReceipt', 'type'],
      ['WorkgroupHostLedgerRun', 'type'],
      ['WorkgroupHostLedgerStampOperation', 'type'],
      ['WorkgroupTurnHostOperations', 'type'],
      ['WorkgroupTurnHostResult', 'type'],
      ['WorkgroupTurnLogger', 'type'],
      ['WorkgroupTurnsOperations', 'type'],
    ] as const
  ).map(([symbol, edgeKind]) => ({
    from: 'packages/backend/src/modules/resource-catalog/application/workgroups/workgroupTurnsDriver.ts',
    specifier: '@/modules/task-execution/public/commands',
    symbol,
    edgeKind,
    syntax: 'static-import' as const,
    role: 'workgroup-turns-provider' as const,
  })),
  ...['WORKGROUP_TURN_LEADER_NODE_ID', 'WORKGROUP_TURN_MEMBER_NODE_ID'].map((symbol) => ({
    from: 'packages/backend/src/modules/resource-catalog/application/workgroups/workgroupTurnsDriver.ts',
    specifier: '@/modules/task-execution/public/commands',
    symbol,
    edgeKind: 'value' as const,
    syntax: 'export' as const,
    role: 'workgroup-turns-provider' as const,
  })),
  ...[
    'WorkgroupHostLedgerOperation',
    'WorkgroupHostLedgerParticipantInTx',
    'WorkgroupTurnsOperations',
  ].map((symbol) => ({
    from: 'packages/backend/src/modules/resource-catalog/infrastructure/workgroupTurnsOperations.ts',
    specifier: '@/modules/task-execution/public/commands',
    symbol,
    edgeKind: 'type' as const,
    syntax: 'static-import' as const,
    role:
      symbol === 'WorkgroupTurnsOperations'
        ? ('workgroup-turns-provider' as const)
        : ('workgroup-host-ledger-provider' as const),
  })),
  ...['WorkgroupTaskRoomEventIdentity', 'WorkgroupTaskRoomTaskParticipantInTx'].map((symbol) => ({
    from: 'packages/backend/src/modules/resource-catalog/infrastructure/workgroupTaskRoom.ts',
    specifier: '@/modules/task-execution/public/commands',
    symbol,
    edgeKind: 'type' as const,
    syntax: 'static-import' as const,
    role: 'workgroup-task-room-provider' as const,
  })),
  {
    from: 'packages/backend/src/modules/resource-catalog/composition/workgroupTurns.ts',
    specifier: '@/modules/task-execution/public/commands',
    symbol: 'WorkgroupTurnsOperations',
    edgeKind: 'type',
    syntax: 'static-import',
    role: 'workgroup-turns-provider',
  },
  ...[
    'packages/backend/src/modules/resource-catalog/application/agents/digitalEmployeeAgentTemplateCatalog.ts',
    'packages/backend/src/modules/resource-catalog/infrastructure/aggregateAdapters/postgresqlResourcePackageMutationArms.ts',
    'packages/backend/src/modules/resource-catalog/infrastructure/legacy/agent.ts',
  ].flatMap((from) =>
    [
      'reconcileCreatedAgentExecutionContractPorts',
      'reconcileUpdatedAgentExecutionContractPorts',
    ].map((symbol) => ({
      from,
      specifier: '@/modules/execution-contract/public/commands',
      symbol,
      edgeKind: 'value' as const,
      syntax: 'static-import' as const,
      role: 'contract-resource-projection-spi' as const,
    })),
  ),
]

function requiredSpiBindingKey(binding: {
  readonly from: string
  readonly specifier: string
  readonly symbol: string
  readonly edgeKind: string
  readonly syntax: string
}): string {
  return [binding.from, binding.specifier, binding.symbol, binding.edgeKind, binding.syntax].join(
    '|',
  )
}

const EXACT_REQUIRED_SPI_BINDING_ROLES = new Map(
  EXACT_REQUIRED_SPI_BINDINGS.map((binding) => [requiredSpiBindingKey(binding), binding.role]),
)

/** Named static import/export bindings; default, namespace and star are sentinels and never exempt. */
function namedModuleBindings(unit: SourceUnit): NamedModuleBinding[] {
  const out: NamedModuleBinding[] = []
  for (const node of unit.source.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      const clause = node.importClause
      if (clause === undefined) {
        out.push({ specifier, symbol: '<side-effect>', edgeKind: 'value', syntax: 'static-import' })
        continue
      }
      if (clause.name !== undefined) {
        out.push({
          specifier,
          symbol: '<default>',
          edgeKind: clause.isTypeOnly ? 'type' : 'value',
          syntax: 'static-import',
        })
      }
      const bindings = clause.namedBindings
      if (bindings === undefined) continue
      if (ts.isNamespaceImport(bindings)) {
        out.push({
          specifier,
          symbol: '<namespace>',
          edgeKind: clause.isTypeOnly ? 'type' : 'value',
          syntax: 'static-import',
        })
        continue
      }
      for (const element of bindings.elements) {
        out.push({
          specifier,
          symbol: (element.propertyName ?? element.name).text,
          edgeKind: clause.isTypeOnly || element.isTypeOnly ? 'type' : 'value',
          syntax: 'static-import',
        })
      }
      continue
    }
    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text
      if (node.exportClause === undefined || ts.isNamespaceExport(node.exportClause)) {
        out.push({
          specifier,
          symbol: '<namespace>',
          edgeKind: node.isTypeOnly ? 'type' : 'value',
          syntax: 'export',
        })
        continue
      }
      for (const element of node.exportClause.elements) {
        out.push({
          specifier,
          symbol: (element.propertyName ?? element.name).text,
          edgeKind: node.isTypeOnly || element.isTypeOnly ? 'type' : 'value',
          syntax: 'export',
        })
      }
    }
  }
  return out
}

function exactRequiredSpiProviderImplementation(
  unit: SourceUnit,
  edge: ReturnType<typeof importEdges>[number],
  bindings: readonly NamedModuleBinding[],
): boolean {
  if (edge.syntax !== 'static-import' && edge.syntax !== 'export') return false
  const matching = bindings.filter(
    (binding) =>
      binding.specifier === edge.specifier &&
      binding.edgeKind === edge.kind &&
      binding.syntax === edge.syntax,
  )
  return (
    matching.length > 0 &&
    matching.every((binding) =>
      EXACT_REQUIRED_SPI_BINDING_ROLES.has(
        requiredSpiBindingKey({
          from: unit.path,
          ...binding,
        }),
      ),
    )
  )
}

/** identity-access 的 type-only authority/context 边：所有含 command/query 的 context 都允许。 */
function isAuthorityTypeOnly(toContext: string, entry: string, edgeKind: string): boolean {
  return (
    toContext === 'identity-access' &&
    edgeKind === 'type' &&
    (entry === 'types' || entry === 'participants')
  )
}

export function offDagOfferedPairs(corpus: GateCorpus): string[] {
  const out: string[] = []
  for (const unit of corpus.backend) {
    const from = gateModuleLocation(unit.path)
    if (from === null) continue
    const bindings = namedModuleBindings(unit)
    for (const edge of corpus.imports.get(unit.path) ?? []) {
      const to = gateModuleLocation(edge.target)
      if (to === null || to.context === from.context || !EXACT_PUBLIC.test(to.rest)) continue
      if (isAuthorityTypeOnly(to.context, to.rest.slice('public/'.length), edge.kind)) continue
      if (OFFERED_CONTEXT_PAIRS.has(`${from.context}->${to.context}`)) continue
      if (exactRequiredSpiProviderImplementation(unit, edge, bindings)) continue
      out.push(`${unit.path} -> ${to.context}`)
    }
  }
  return unique(out)
}
export function platformModulePairs(corpus: GateCorpus): string[] {
  return unique(
    corpus.edges
      .filter(
        (edge) =>
          edge.from.path.startsWith(BACKEND_PREFIX + 'platform/') &&
          gateModuleLocation(edge.target) !== null,
      )
      .map((edge) => `${edge.from.path} -> ${edge.target}`),
  )
}
const EFFECT_IMPORT =
  /^(?:(?:node:)?(?:fs(?:\/promises)?|child_process|net|http|https|http2|dgram|tls|dns(?:\/promises)?|worker_threads|cluster)|bun:sqlite)$/
const FS_PROCESS = /^(?:node:)?(?:fs(?:\/promises)?|child_process)$/
const DB_IMPORT = /^(?:drizzle-orm(?:\/|$)|bun:sqlite$)|^packages\/backend\/src\/db(?:\/|\.|$)/
function isApplication(path: string): boolean {
  return /^application\//.test(gateModuleLocation(path)?.rest ?? '')
}

function shadowsGlobal(node: ts.Node, name: string): boolean {
  // Inspect lexical scopes, not similarly named declarations elsewhere in the file.
  let scope: ts.Node | undefined = node.parent
  while (scope !== undefined) {
    if (ts.isFunctionLike(scope) && scope.parameters.some((p) => p.name.getText() === name))
      return true
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const statement of scope.statements) {
        if (
          ts.isVariableStatement(statement) &&
          statement.declarationList.declarations.some((d) => d.name.getText() === name)
        )
          return true
        if (
          (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
          statement.name?.text === name
        )
          return true
        if (ts.isImportDeclaration(statement) && statement.importClause) {
          const clause = statement.importClause
          if (clause.name?.text === name) return true
          const bindings = clause.namedBindings
          if (
            bindings &&
            (ts.isNamespaceImport(bindings)
              ? bindings.name.text === name
              : bindings.elements.some((e) => e.name.text === name))
          )
            return true
        }
      }
    }
    scope = scope.parent
  }
  return false
}
export function applicationEffectFiles(corpus: GateCorpus): string[] {
  return corpus.backend
    .filter((unit) => {
      if (!isApplication(unit.path)) return false
      if (
        (corpus.imports.get(unit.path) ?? []).some(
          (edge) => edge.kind === 'value' && EFFECT_IMPORT.test(edge.specifier),
        )
      )
        return true
      let found = false
      walk(unit.source, (node) => {
        if (
          !ts.isCallExpression(node) &&
          !ts.isNewExpression(node) &&
          !ts.isTaggedTemplateExpression(node)
        )
          return
        const target = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression
        const name = calleeName(target)
        if (
          /^Bun\.(?:spawn|spawnSync|\$|file|write|connect|listen|serve)$/.test(name) &&
          !shadowsGlobal(node, 'Bun')
        )
          found = true
        if (/^process\.(?:kill|exit|chdir)$/.test(name) && !shadowsGlobal(node, 'process'))
          found = true
        if (
          ts.isCallExpression(node) &&
          (name === 'globalThis.fetch' || (name === 'fetch' && !shadowsGlobal(node, 'fetch')))
        )
          found = true
        if (
          ts.isNewExpression(node) &&
          (name === 'globalThis.WebSocket' ||
            (name === 'WebSocket' && !shadowsGlobal(node, 'WebSocket')))
        )
          found = true
      })
      return found
    })
    .map((unit) => unit.path)
    .sort()
}
export type ModuleLayerRule =
  | 'domain-adapter-import'
  | 'schema-table-import'
  | 'infrastructure-import'
  | 'application-composition-import'
  | 'inbound-db-import'
  | 'inbound-context-internal-import'
export interface ModuleLayerViolation {
  readonly rule: ModuleLayerRule
  readonly file: string
  readonly specifier: string
  readonly edgeKind: 'type' | 'value'
}
export function moduleLayerViolations(corpus: GateCorpus): ModuleLayerViolation[] {
  const found = new Map<string, ModuleLayerViolation>()
  for (const edge of corpus.edges) {
    const from = gateModuleLocation(edge.from.path),
      to = gateModuleLocation(edge.target)
    if (from === null) continue
    const layer = from.rest.split('/')[0]
    const push = (rule: ModuleLayerRule): void => {
      const item = { rule, file: edge.from.path, specifier: edge.specifier, edgeKind: edge.kind }
      found.set(`${rule}|${item.file}|${item.specifier}`, item)
    }
    if (
      layer === 'domain' &&
      (FS_PROCESS.test(edge.specifier) ||
        /^(?:hono|drizzle-orm|bun:sqlite)(?:\/|$)/.test(edge.specifier) ||
        /^packages\/backend\/src\/(?:db|ws|routes|server)(?:\/|\.|$)/.test(edge.target))
    )
      push('domain-adapter-import')
    if (
      ['application', 'engine'].includes(layer ?? '') &&
      /^packages\/backend\/src\/db\/schema(?:\/|\.|$)/.test(edge.target)
    )
      push('schema-table-import')
    if (
      ['application', 'engine', 'domain'].includes(layer ?? '') &&
      to?.rest.startsWith('infrastructure/')
    )
      push('infrastructure-import')
    if (
      layer === 'application' &&
      /^composition(?:\/|$)/.test(to?.rest ?? '') &&
      !(edge.kind === 'type' && REQUIRED_PORTS.test(to!.rest))
    )
      push('application-composition-import')
    if (layer === 'inbound' && /^packages\/backend\/src\/db(?:\/|\.|$)/.test(edge.target))
      push('inbound-db-import')
    if (
      layer === 'inbound' &&
      to !== null &&
      to.context !== from.context &&
      !to.rest.startsWith('public/')
    )
      push('inbound-context-internal-import')
  }
  return [...found.values()].sort((a, b) => moduleLayerKey(a).localeCompare(moduleLayerKey(b)))
}
export function moduleLayerKey(item: ModuleLayerViolation): string {
  return `${item.rule}|${item.file}|${item.specifier}`
}
function compositionFile(path: string): boolean {
  const rest = gateModuleLocation(path)?.rest ?? ''
  return /^(?:composition$|composition\/)/.test(rest) && rest !== 'composition/required-ports'
}
export function exportStarBarrels(corpus: GateCorpus): string[] {
  return corpus.backend
    .filter((unit) =>
      unit.source.statements.some((node) => {
        if (
          !ts.isExportDeclaration(node) ||
          node.exportClause !== undefined ||
          node.moduleSpecifier === undefined
        )
          return false
        const specifier = literal(node.moduleSpecifier)
        if (specifier === null) return false
        const target = resolveImport(unit.path, specifier, new Set(corpus.byPath.keys()))
        const location = gateModuleLocation(target)
        return DB_IMPORT.test(target) || (location !== null && !EXACT_PUBLIC.test(location.rest))
      }),
    )
    .map((unit) => unit.path)
    .sort()
}
export function compositionForbiddenFiles(corpus: GateCorpus): string[] {
  const exportsDb = (path: string, seen: Set<string>): boolean => {
    if (DB_IMPORT.test(path)) return true
    if (seen.has(path)) return false
    seen.add(path)
    const unit = corpus.byPath.get(path)
    return (
      unit?.source.statements.some((node) => {
        if (!ts.isExportDeclaration(node) || node.isTypeOnly || node.exportClause !== undefined)
          return false
        const specifier = literal(node.moduleSpecifier)
        return (
          specifier !== null &&
          exportsDb(resolveImport(path, specifier, new Set(corpus.byPath.keys())), seen)
        )
      }) ?? false
    )
  }
  return corpus.backend
    .filter((unit) => {
      if (!compositionFile(unit.path)) return false
      if (
        (corpus.imports.get(unit.path) ?? []).some(
          (edge) =>
            edge.kind === 'value' &&
            (FS_PROCESS.test(edge.specifier) || exportsDb(edge.target, new Set())),
        )
      )
        return true
      let found = false
      walk(unit.source, (node) => {
        const text = ts.isTaggedTemplateExpression(node)
          ? node.template.getText()
          : ts.isCallExpression(node) &&
              /^(?:exec|execute|query|prepare|run|all|get)$/.test(memberName(node.expression) ?? '')
            ? literal(node.arguments[0])
            : null
        if (
          text !== null &&
          /\b(?:SELECT\s+.+\bFROM|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE)\b/is.test(
            text,
          )
        )
          found = true
      })
      return found
    })
    .map((unit) => unit.path)
    .sort()
}
function deploymentScope(path: string): boolean {
  if (!path.startsWith(BACKEND_PREFIX)) return false
  const rel = path.slice(BACKEND_PREFIX.length)
  return (
    /^modules\/[^/]+\/(?:domain|application|engine|inbound|public)\//.test(rel) ||
    (rel.startsWith('platform/') && !rel.startsWith('platform/crewstation/')) ||
    /^(?:routes|mcp|ws)\//.test(rel) ||
    /^(?:main|server|embed)\.ts$|^bootstrap\/(?:daemonStart|developmentReload)\.ts$/.test(rel)
  )
}
function fenceOnly(node: ts.Node): boolean {
  if (ts.isBlock(node)) return node.statements.length === 1 && fenceOnly(node.statements[0]!)
  if (ts.isThrowStatement(node)) return true
  if (ts.isReturnStatement(node)) return node.expression !== undefined && fenceOnly(node.expression)
  if (ts.isExpressionStatement(node)) return fenceOnly(node.expression)
  return (
    ts.isCallExpression(node) &&
    /^(?:unhandledDeploymentMode|assertNever|unreachable)$/.test(memberName(node.expression) ?? '')
  )
}
function exhaustivenessFence(node: ts.Node): boolean {
  let cursor = node,
    parent = cursor.parent
  while (parent !== undefined) {
    if (
      ts.isParenthesizedExpression(parent) ||
      (ts.isBinaryExpression(parent) &&
        [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken].includes(
          parent.operatorToken.kind,
        ))
    ) {
      cursor = parent
      parent = parent.parent
      continue
    }
    if (ts.isIfStatement(parent) && parent.expression === cursor)
      return fenceOnly(parent.thenStatement)
    if (ts.isConditionalExpression(parent) && parent.condition === cursor)
      return fenceOnly(parent.whenTrue)
    return false
  }
  return false
}
export function deploymentBranchSites(corpus: GateCorpus): string[] {
  const sites: string[] = [],
    modes = new Set(['standalone', 'crewstation'])
  const operators = new Set([
    ts.SyntaxKind.EqualsEqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken,
    ts.SyntaxKind.QuestionQuestionToken,
    ts.SyntaxKind.BarBarToken,
  ])
  for (const unit of corpus.backend) {
    if (!deploymentScope(unit.path)) continue
    const record = siteRecorder(unit.path)
    for (const edge of corpus.imports.get(unit.path) ?? []) {
      if (
        unit.path === BACKEND_PREFIX + 'main.ts' ||
        unit.path.startsWith(BACKEND_PREFIX + 'bootstrap/')
      )
        continue
      if (/^packages\/backend\/src\/bootstrap\//.test(edge.target))
        sites.push(`${unit.path}#$file#import:${edge.target}#1`)
    }
    walk(unit.source, (node) => {
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        memberName(node) === 'AW_DEPLOYMENT_MODE'
      )
        sites.push(record(node, 'AW_DEPLOYMENT_MODE'))
      if (
        ts.isBinaryExpression(node) &&
        operators.has(node.operatorToken.kind) &&
        (modes.has(literal(node.left) ?? '') ||
          modes.has(literal(node.right) ?? '') ||
          (ts.isObjectLiteralExpression(node.right) &&
            node.right.properties.some(
              (property) =>
                ts.isPropertyAssignment(property) &&
                property.name.getText() === 'mode' &&
                modes.has(literal(property.initializer) ?? ''),
            )) ||
          /^(?:deploymentMode|executionHost|deployment)$/.test(memberName(node.left) ?? '') ||
          /^(?:deploymentMode|executionHost|deployment)$/.test(memberName(node.right) ?? '')) &&
        !exhaustivenessFence(node)
      )
        sites.push(record(node, 'comparison'))
      if (
        ts.isCaseClause(node) &&
        modes.has(literal(node.expression) ?? '') &&
        !(node.statements.length === 1 && fenceOnly(node.statements[0]!))
      )
        sites.push(record(node, 'case'))
      if (
        ts.isLiteralTypeNode(node) &&
        modes.has(literal(node) ?? '') &&
        /\/application\/ports\//.test(unit.path)
      )
        sites.push(record(node, 'port-literal'))
    })
  }
  return unique(sites)
}
export function directIntervalSites(corpus: GateCorpus): string[] {
  const sites: string[] = []
  for (const unit of corpus.backend) {
    const record = siteRecorder(unit.path)
    walk(unit.source, (node) => {
      if (
        ts.isCallExpression(node) &&
        ['setInterval', 'globalThis.setInterval'].includes(calleeName(node.expression)) &&
        !shadowsGlobal(node, 'setInterval')
      )
        sites.push(record(node, 'setInterval'))
    })
  }
  return sites.sort()
}
export function architectureDirectoryViolations(paths: readonly string[]): string[] {
  return unique(paths.filter((path) => !(ARCHITECTURE_FILES as readonly string[]).includes(path)))
}
export function unreachableProductionFiles(
  corpus: GateCorpus,
  entries: readonly string[] = BINARY_ENTRIES,
): string[] {
  const missing = entries.filter((path) => !corpus.byPath.has(path))
  if (missing.length > 0) throw new Error(`missing production entries: ${missing.join(', ')}`)
  const reachable = new Set<string>(),
    pending = [...entries]
  while (pending.length > 0) {
    const path = pending.pop()!
    if (reachable.has(path)) continue
    reachable.add(path)
    for (const edge of corpus.imports.get(path) ?? [])
      if (corpus.byPath.has(edge.target)) pending.push(edge.target)
  }
  return corpus.backend
    .filter(
      (unit) =>
        !reachable.has(unit.path) &&
        !unit.path.endsWith('.d.ts') &&
        nonruntimeSourceRole(unit) === undefined,
    )
    .map((unit) => unit.path)
    .sort()
}
export function exactAllowlist(
  observed: readonly string[],
  allowed: readonly string[],
): { unregistered: string[]; stale: string[] } {
  const actual = new Set(observed),
    expected = new Set(allowed)
  return {
    unregistered: unique([...actual].filter((key) => !expected.has(key))),
    stale: unique([...expected].filter((key) => !actual.has(key))),
  }
}
export interface CountLimit {
  readonly max: number
  readonly reason: string
}
export function checkCounts(
  measured: Readonly<Record<string, number>>,
  limits: Readonly<Record<string, CountLimit>>,
): { errors: string[]; decreases: string[] } {
  const errors: string[] = [],
    decreases: string[] = []
  for (const id of Object.keys(limits)) if (!(id in measured)) errors.push(`unknown count: ${id}`)
  for (const [id, value] of Object.entries(measured)) {
    const limit = limits[id]
    if (limit === undefined) {
      errors.push(`missing count: ${id}`)
      continue
    }
    if (!Number.isSafeInteger(value) || value < 0) errors.push(`invalid measured count: ${id}`)
    if (!Number.isSafeInteger(limit.max) || limit.max < 0) errors.push(`invalid max: ${id}`)
    if (!new RegExp(`\\bmax=${limit.max}(?![\\d.])`).test(limit.reason))
      errors.push(`missing max=${limit.max} reason: ${id}`)
    if (value > limit.max) errors.push(`over max: ${id}: ${value} > ${limit.max}`)
    if (value < limit.max) decreases.push(`${id}: ${value} < ${limit.max}`)
  }
  return { errors: errors.sort(), decreases: decreases.sort() }
}
export function gateViolationSets(
  corpus: GateCorpus,
  architectureFiles: readonly string[],
  entries: readonly string[] = BINARY_ENTRIES,
): Record<string, string[]> {
  return {
    'context-value-sccs': contextValueSccs(corpus),
    'context-value-pairs-off-dag': contextPairsOffDag(corpus),
    'cross-context-internal-file-pairs': crossContextInternalPairs(corpus),
    'off-dag-offered-file-context-pairs': offDagOfferedPairs(corpus),
    'platform-to-modules-file-pairs': platformModulePairs(corpus),
    'application-direct-effect-files': applicationEffectFiles(corpus),
    'module-layer-violations': moduleLayerViolations(corpus).map(moduleLayerKey),
    'composition-forbidden-import-files': compositionForbiddenFiles(corpus),
    'deployment-mode-branch-sites': deploymentBranchSites(corpus),
    'export-star-barrels': exportStarBarrels(corpus),
    'direct-setinterval-sites': directIntervalSites(corpus),
    'architecture-directory-files': architectureDirectoryViolations(architectureFiles),
    'unreachable-production-files': unreachableProductionFiles(corpus, entries),
  }
}

// RFC-376 G3: retain the existing public-contract scanners without ledger IO.
// RFC-395 I-b: PersistenceTx is the unbranded query interface.
const SENSITIVE_TYPE =
  /^(?!PersistenceTx$).*(?:Actor|Authority|Capability|Claim|Token|WorkerIdentity|Tx)(?:V\d+)?$/
const FORBIDDEN_TYPE_NAME = new Set([
  'AbortController',
  'AppDeps',
  'BigInt',
  'Buffer',
  'Date',
  'DbClient',
  'Error',
  'Function',
  'Hono',
  'Map',
  'Process',
  'SecretBox',
  'Set',
  'WeakMap',
  'WeakSet',
])
const FORBIDDEN_TYPE_IMPORT =
  /^(?:@\/(?:auth|cli|config|db|embed|mcp|platform|routes|server|services|util|ws)(?:\/|$)|drizzle-orm(?:\/|$)|hono(?:\/|$)|node:(?:child_process|fs|path|process)(?:\/|$)|(?:fs|path|process)$)/

/** zod 从 schema 推导类型的三个入口。 */
const ZOD_INFERENCE_HELPERS = new Set(['infer', 'input', 'output'])

/**
 * 该 `typeof X` 是不是一次**确定性派生**，而不是把某个值的类型原样敞给消费者。
 *
 * 三种确定性形态（全部是本仓「常量/schema 与类型单一事实源」的标准写法）：
 *   - `z.infer<typeof XSchema>` / `z.input` / `z.output`  —— shared 740 个导出类型里 586 个
 *   - `(typeof CONST_ARRAY)[number]`                        —— 全仓 85 处
 *   - `keyof typeof CONST_MAP`                              —— 全仓 6 处
 *
 * 真正开放的是**裸** `typeof value`（`export type RepositoryGit = typeof defaultRunGit`
 * 这种：类型等于某个值恰好是什么，消费者在编译期说不出它的形状）。全仓只有 2 处，
 * 且都不在 public 合同链上——所以这条豁免收得住，不是「为了让规则变绿」。
 */
function isDeterministicTypeQuery(node: ts.TypeQueryNode): boolean {
  let current: ts.Node = node
  // 括号在类型层是透明的：`(typeof A)[number]` 的 TypeQuery 外面裹着 ParenthesizedType
  while (current.parent !== undefined && ts.isParenthesizedTypeNode(current.parent)) {
    current = current.parent
  }
  const parent = current.parent
  if (parent === undefined) return false

  // ① z.infer<typeof X>
  if (ts.isTypeReferenceNode(parent)) {
    if (!(parent.typeArguments ?? []).some((argument) => argument === current)) return false
    const name = parent.typeName
    return ts.isQualifiedName(name) && ZOD_INFERENCE_HELPERS.has(name.right.text)
  }
  // ② (typeof A)[number] —— 只认被索引的那一侧；索引位上的 typeof 不算
  if (ts.isIndexedAccessTypeNode(parent)) return parent.objectType === current
  // ③ keyof typeof A
  if (ts.isTypeOperatorNode(parent)) return parent.operator === ts.SyntaxKind.KeyOfKeyword
  return false
}

interface ImportBinding {
  importedName: string
  specifier: string
}

interface SurfaceRoot {
  publicUnit: SourceUnit
  unit: SourceUnit
  declaration: ts.Declaration
  symbol: string
}

function portable(path: string): string {
  return path.replaceAll('\\', '/')
}
const SHARED_PACKAGE = '@agent-workflow/shared'
export function sourceUnits(files: Record<string, string>): SourceUnit[] {
  return Object.entries(files)
    .map(([path, text]) => sourceUnit(path, text))
    .sort((left, right) => left.path.localeCompare(right.path))
}

function canonicalModulePath(path: string): string {
  const location = moduleLocation(path)
  return location === null ? portable(path) : `modules/${location.context}/${location.rest}.ts`
}

function literalSpecifier(node: ts.Expression | ts.TypeNode): string | null {
  if (ts.isStringLiteralLike(node)) return node.text
  if (ts.isLiteralTypeNode(node) && ts.isStringLiteralLike(node.literal)) return node.literal.text
  return null
}

function resolveUnit(
  units: readonly SourceUnit[],
  fromPath: string,
  specifier: string,
): SourceUnit | undefined {
  let candidate: string | null = null
  if (specifier.startsWith('@/')) {
    candidate = `packages/backend/src/${specifier.slice(2)}`
  } else if (specifier === SHARED_PACKAGE) {
    // RFC-317 T25 —— 认识 shared 的**裸包名**。此前解析不到它，于是每个来自 shared 的
    // 类型解析必须跟进 shared 的真实定义：
    // mega-DTO 塞进 payload 的 public 合同，在 24 片叶子的预算里只算 3 片。预算不是
    // 被调高的，是**根本没看见**——比调高更隐蔽，因为账面上它一直是绿的。
    candidate = 'packages/shared/src/index'
  } else if (specifier.startsWith(`${SHARED_PACKAGE}/`)) {
    candidate = `packages/shared/src/${specifier.slice(SHARED_PACKAGE.length + 1)}`
  } else if (specifier.startsWith('.')) {
    candidate = posix.normalize(posix.join(posix.dirname(fromPath), specifier))
  }
  if (candidate === null) return undefined
  const attempts = [candidate, `${candidate}.ts`, `${candidate}.tsx`, `${candidate}/index.ts`].map(
    portable,
  )
  return units.find(
    (unit) =>
      attempts.includes(unit.path) || attempts.some((attempt) => unit.path.endsWith(`/${attempt}`)),
  )
}

function importBindings(unit: SourceUnit): Map<string, ImportBinding> {
  const bindings = new Map<string, ImportBinding>()
  for (const statement of unit.source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue
    }
    const clause = statement.importClause
    if (clause?.name !== undefined) {
      bindings.set(clause.name.text, {
        importedName: 'default',
        specifier: statement.moduleSpecifier.text,
      })
    }
    if (clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        bindings.set(element.name.text, {
          importedName: element.propertyName?.text ?? element.name.text,
          specifier: statement.moduleSpecifier.text,
        })
      }
    } else if (clause?.namedBindings !== undefined) {
      bindings.set(clause.namedBindings.name.text, {
        importedName: '*',
        specifier: statement.moduleSpecifier.text,
      })
    }
  }
  return bindings
}

function namedDeclarations(unit: SourceUnit): Map<string, ts.Declaration> {
  const declarations = new Map<string, ts.Declaration>()
  for (const statement of unit.source.statements) {
    if (
      (ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      declarations.set(statement.name.text, statement)
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, declaration)
      }
    }
  }
  return declarations
}

function resolveNamedDeclaration(
  units: readonly SourceUnit[],
  unit: SourceUnit,
  name: string,
  seen = new Set<string>(),
): { unit: SourceUnit; declaration: ts.Declaration } | undefined {
  const key = `${unit.path}#${name}`
  if (seen.has(key)) return undefined
  seen.add(key)

  const local = namedDeclarations(unit).get(name)
  if (local !== undefined) return { unit, declaration: local }

  const binding = importBindings(unit).get(name)
  if (binding !== undefined && binding.importedName !== '*') {
    const target = resolveUnit(units, unit.path, binding.specifier)
    if (target !== undefined) {
      const resolved = resolveNamedDeclaration(units, target, binding.importedName, seen)
      if (resolved !== undefined) return resolved
    }
  }

  for (const statement of unit.source.statements) {
    if (!ts.isExportDeclaration(statement)) continue
    if (statement.exportClause === undefined && statement.moduleSpecifier !== undefined) {
      const target = resolveUnit(
        units,
        unit.path,
        literalSpecifier(statement.moduleSpecifier) ?? '',
      )
      if (target !== undefined) {
        const resolved = resolveNamedDeclaration(units, target, name, seen)
        if (resolved !== undefined) return resolved
      }
      continue
    }
    if (statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause)) continue
    for (const element of statement.exportClause.elements) {
      if (element.name.text !== name) continue
      const target =
        statement.moduleSpecifier === undefined
          ? unit
          : resolveUnit(units, unit.path, literalSpecifier(statement.moduleSpecifier) ?? '')
      if (target === undefined) continue
      const resolved = resolveNamedDeclaration(
        units,
        target,
        element.propertyName?.text ?? element.name.text,
        seen,
      )
      if (resolved !== undefined) return resolved
    }
  }
  return undefined
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
      false)
  )
}

function publicSurfaceRoots(units: readonly SourceUnit[]): SurfaceRoot[] {
  const roots: SurfaceRoot[] = []
  for (const unit of units) {
    const location = moduleLocation(unit.path)
    if (location === null || !location.rest.startsWith('public/')) continue
    for (const statement of unit.source.statements) {
      if (hasExportModifier(statement)) {
        if (
          ts.isTypeAliasDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isEnumDeclaration(statement)
        ) {
          if (statement.name !== undefined) {
            roots.push({
              publicUnit: unit,
              unit,
              declaration: statement,
              symbol: statement.name.text,
            })
          }
        } else if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name)) {
              roots.push({ publicUnit: unit, unit, declaration, symbol: declaration.name.text })
            }
          }
        }
      }
      if (
        ts.isExportDeclaration(statement) &&
        statement.exportClause !== undefined &&
        ts.isNamedExports(statement.exportClause)
      ) {
        const target =
          statement.moduleSpecifier === undefined
            ? unit
            : resolveUnit(units, unit.path, literalSpecifier(statement.moduleSpecifier) ?? '')
        if (target === undefined) continue
        for (const element of statement.exportClause.elements) {
          const importedName = element.propertyName?.text ?? element.name.text
          const resolved = resolveNamedDeclaration(units, target, importedName)
          if (resolved !== undefined) {
            roots.push({
              publicUnit: unit,
              unit: resolved.unit,
              declaration: resolved.declaration,
              symbol: element.name.text,
            })
          }
        }
      }
    }
  }
  return roots
}

function declarationTypeNodes(declaration: ts.Declaration): ts.TypeNode[] {
  if (ts.isTypeAliasDeclaration(declaration)) return [declaration.type]
  if (ts.isInterfaceDeclaration(declaration)) {
    return [
      ...(declaration.heritageClauses ?? []).flatMap((clause) => clause.types),
      ...declaration.members.flatMap((member) => {
        if (ts.isCallSignatureDeclaration(member) || ts.isMethodSignature(member)) {
          return [
            ...member.parameters.flatMap((parameter) => (parameter.type ? [parameter.type] : [])),
            ...(member.type ? [member.type] : []),
          ]
        }
        if (ts.isPropertySignature(member) || ts.isIndexSignatureDeclaration(member)) {
          return member.type ? [member.type] : []
        }
        if (ts.isConstructSignatureDeclaration(member)) {
          return [
            ...member.parameters.flatMap((parameter) => (parameter.type ? [parameter.type] : [])),
            ...(member.type ? [member.type] : []),
          ]
        }
        return []
      }),
    ]
  }
  if (ts.isFunctionDeclaration(declaration)) {
    return [
      ...declaration.parameters.flatMap((parameter) => (parameter.type ? [parameter.type] : [])),
      ...(declaration.type ? [declaration.type] : []),
    ]
  }
  if (ts.isVariableDeclaration(declaration)) return declaration.type ? [declaration.type] : []
  if (ts.isClassDeclaration(declaration)) {
    return declaration.members.flatMap((member) => {
      if (ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) {
        return [
          ...('parameters' in member
            ? member.parameters.flatMap((parameter) => (parameter.type ? [parameter.type] : []))
            : []),
          ...(member.type ? [member.type] : []),
        ]
      }
      return []
    })
  }
  return []
}

export function publicSurfaceViolations(units: readonly SourceUnit[]): string[] {
  units = [...units].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const violations = new Set<string>()
  const declarationIndexes = new Map(units.map((unit) => [unit.path, namedDeclarations(unit)]))
  const bindingIndexes = new Map(units.map((unit) => [unit.path, importBindings(unit)]))
  const visitedDeclarations = new Set<string>()

  for (const unit of units) {
    const location = moduleLocation(unit.path)
    if (location === null || !location.rest.startsWith('public/')) continue
    if (!/^public\/(commands|queries|participants|events|operations|types)$/.test(location.rest)) {
      violations.add(`${canonicalModulePath(unit.path)}: non-exact public entrypoint`)
    }
    for (const statement of unit.source.statements) {
      if (
        ts.isExportDeclaration(statement) &&
        (statement.exportClause === undefined || ts.isNamespaceExport(statement.exportClause))
      ) {
        violations.add(`${canonicalModulePath(unit.path)}: export * is forbidden`)
      }
      if (
        ts.isExportAssignment(statement) ||
        (hasExportModifier(statement) &&
          ts.canHaveModifiers(statement) &&
          (ts
            .getModifiers(statement)
            ?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) ??
            false))
      ) {
        violations.add(`${canonicalModulePath(unit.path)}: default export is forbidden`)
      }
    }
  }

  const visitDeclaration = (unit: SourceUnit, declaration: ts.Declaration, chain: string): void => {
    const key = `${unit.path}:${declaration.pos}:${declaration.end}`
    if (visitedDeclarations.has(key)) return
    visitedDeclarations.add(key)

    const bindings = bindingIndexes.get(unit.path) ?? new Map()
    const localDeclarations = declarationIndexes.get(unit.path) ?? new Map()
    const visitType = (node: ts.Node): void => {
      // RFC-317 T25 —— **确定性派生**的 `typeof` 不算「开放类型」。
      //
      // 本规则禁的是**被擦除 / 无界**的类型穿过 public 合同：any / unknown / object /
      // 函数类型 / mapped / index signature——它们让消费者拿到一个编译期说不出形状的东西。
      // `typeof X` 一般确实属于这一类，但 `z.infer<typeof XSchema>` 不是：它的形状由
      // schema 完全确定，且是本仓 schema 与类型的**单一事实源**写法。
      //
      // 这条豁免是被实测逼出来的：T25 把解析语料扩到 shared 之后，taint 走查第一次能
      // 走进 shared，立刻报出 8 条 TypeQuery。查证发现 shared 的 740 个导出类型别名里
      // **586 个**是 z.infer<typeof …>，裸 typeof **零个**——也就是说不加这条豁免，
      // 规则与「shared 可解析」结构性冲突，而把它们当债务入账等于把用了 586 次的
      // 标准写法记成债，污染账本的含义。
      if (ts.isTypeQueryNode(node) && isDeterministicTypeQuery(node)) return
      if (
        node.kind === ts.SyntaxKind.AnyKeyword ||
        node.kind === ts.SyntaxKind.UnknownKeyword ||
        node.kind === ts.SyntaxKind.ObjectKeyword ||
        ts.isFunctionTypeNode(node) ||
        ts.isConstructorTypeNode(node) ||
        ts.isTypeQueryNode(node) ||
        ts.isMappedTypeNode(node) ||
        ts.isIndexSignatureDeclaration(node)
      ) {
        violations.add(`${chain}: unsafe/open type ${ts.SyntaxKind[node.kind]}`)
      }
      if (ts.isImportTypeNode(node)) {
        const specifier = literalSpecifier(node.argument)
        if (specifier !== null && FORBIDDEN_TYPE_IMPORT.test(specifier)) {
          violations.add(`${chain}: forbidden type import ${specifier}`)
        } else if (specifier !== null && node.qualifier !== undefined) {
          const target = resolveUnit(units, unit.path, specifier)
          const importedName = ts.isIdentifier(node.qualifier)
            ? node.qualifier.text
            : node.qualifier.right.text
          const resolved = target ? resolveNamedDeclaration(units, target, importedName) : undefined
          if (resolved !== undefined) {
            visitDeclaration(resolved.unit, resolved.declaration, chain)
          }
        }
      }
      if (ts.isTypeReferenceNode(node)) {
        let rootName = node.typeName
        while (ts.isQualifiedName(rootName)) rootName = rootName.left
        const localName = rootName.text
        const name = ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text
        if (FORBIDDEN_TYPE_NAME.has(name) || name === 'Partial') {
          violations.add(`${chain}: forbidden type ${name}`)
        }
        const binding = bindings.get(localName)
        if (binding !== undefined) {
          if (FORBIDDEN_TYPE_IMPORT.test(binding.specifier)) {
            violations.add(
              `${chain}: forbidden type import ${binding.specifier}#${binding.importedName === '*' ? name : binding.importedName}`,
            )
          } else {
            const target = resolveUnit(units, unit.path, binding.specifier)
            const resolved = target
              ? resolveNamedDeclaration(
                  units,
                  target,
                  binding.importedName === '*' ? name : binding.importedName,
                )
              : undefined
            if (resolved !== undefined) {
              visitDeclaration(resolved.unit, resolved.declaration, chain)
            }
          }
        } else {
          const local = localDeclarations.get(name)
          if (local !== undefined && local !== declaration) visitDeclaration(unit, local, chain)
        }
      }
      ts.forEachChild(node, visitType)
    }
    for (const typeNode of declarationTypeNodes(declaration)) visitType(typeNode)
  }

  // RFC-344 operation entrypoints expose descriptor factories whose invoke
  // functions are deliberately executable. Their DTO closure is enforced by
  // versioned exact codecs + catalog self-check, so treating every function
  // member as the old open-public-type debt would reject the operation model
  // by construction. Filename/export-shape checks above still apply.
  for (const root of publicSurfaceRoots(units).filter(
    (entry) => moduleLocation(entry.publicUnit.path)?.rest !== 'public/operations',
  )) {
    visitDeclaration(
      root.unit,
      root.declaration,
      `${canonicalModulePath(root.unit.path)}#${root.symbol}`,
    )
  }
  return [...violations].sort()
}

function typeNames(node: ts.TypeNode | undefined): string[] {
  if (node === undefined) return []
  const names = new Set<string>()
  const visit = (child: ts.Node): void => {
    if (ts.isTypeReferenceNode(child)) {
      names.add(ts.isIdentifier(child.typeName) ? child.typeName.text : child.typeName.right.text)
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return [...names]
}

function containsSensitiveTypeName(
  units: readonly SourceUnit[],
  unit: SourceUnit,
  node: ts.TypeNode | undefined,
  seen = new Set<string>(),
): string | undefined {
  if (node === undefined) return undefined
  const direct = typeNames(node).find((name) => SENSITIVE_TYPE.test(name))
  if (direct !== undefined) return direct

  let found: string | undefined
  const visit = (child: ts.Node): void => {
    if (found !== undefined) return
    if (ts.isTypeReferenceNode(child)) {
      const target = declarationForTypeReference(units, unit, child)
      if (target !== undefined) {
        const key = `${target.unit.path}:${target.declaration.pos}`
        if (!seen.has(key)) {
          seen.add(key)
          const declarationNameNode = ts.getNameOfDeclaration(target.declaration)
          const declarationName =
            declarationNameNode !== undefined && ts.isIdentifier(declarationNameNode)
              ? declarationNameNode.text
              : undefined
          if (declarationName !== undefined && SENSITIVE_TYPE.test(declarationName)) {
            found = declarationName
            return
          }
          for (const typeNode of declarationTypeNodes(target.declaration)) {
            found = containsSensitiveTypeName(units, target.unit, typeNode, seen)
            if (found !== undefined) return
          }
        }
      }
    }
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

// These three W0 interfaces accept the caller's transaction; they do not mint
// authorization. Require their actual method-only declarations, not just an
// InTx name, so a private brand or data-bearing capability remains sensitive.
const TRANSACTION_PORT_DECLARATIONS: Readonly<Record<string, string>> = {
  'modules/task-execution/application/ports/runSelection.ts': 'RunSelectionParticipantInTx',
  'modules/task-execution/application/ports/taskMountKeys.ts': 'TaskMountKeysReaderInTx',
  'modules/task-execution/application/ports/taskExecutionGenerations.ts':
    'TaskExecutionGenerationsParticipantInTx',
}

function isReviewedTransactionPort(unit: SourceUnit, declaration: ts.Declaration): boolean {
  return (
    ts.isInterfaceDeclaration(declaration) &&
    TRANSACTION_PORT_DECLARATIONS[unit.path.replace(BACKEND_PREFIX, '')] ===
      declaration.name.text &&
    !declaration.heritageClauses?.length &&
    declaration.members.length > 0 &&
    declaration.members.every(
      (member) =>
        ts.isMethodSignature(member) &&
        member.parameters.length > 0 &&
        ts.isIdentifier(member.parameters[0]!.name) &&
        member.parameters[0]!.name.text === 'tx' &&
        member.parameters[0]!.type !== undefined &&
        /^(?:PersistenceTx|Tx)$/.test(member.parameters[0]!.type!.getText(unit.source)),
    )
  )
}

function sensitiveIdentityName(
  units: readonly SourceUnit[],
  unit: SourceUnit,
  node: ts.TypeNode | undefined,
  seen = new Set<string>(),
): string | undefined {
  if (node === undefined) return undefined
  if (ts.isTypeReferenceNode(node)) {
    const name = ts.isIdentifier(node.typeName) ? node.typeName.text : node.typeName.right.text
    const target = declarationForTypeReference(units, unit, node)
    if (target !== undefined) {
      if (isReviewedTransactionPort(target.unit, target.declaration)) return undefined
      const key = `${target.unit.path}:${target.declaration.pos}`
      if (seen.has(key)) return undefined
      seen.add(key)
      const declarationNameNode = ts.getNameOfDeclaration(target.declaration)
      if (
        declarationNameNode !== undefined &&
        ts.isIdentifier(declarationNameNode) &&
        SENSITIVE_TYPE.test(declarationNameNode.text)
      ) {
        if (ts.isTypeAliasDeclaration(target.declaration)) {
          const underlying = sensitiveIdentityName(
            units,
            target.unit,
            target.declaration.type,
            seen,
          )
          if (underlying !== undefined) return underlying
        }
        return declarationNameNode.text
      }
      if (ts.isTypeAliasDeclaration(target.declaration)) {
        return sensitiveIdentityName(units, target.unit, target.declaration.type, seen)
      }
    }
    if (SENSITIVE_TYPE.test(name)) return name
    for (const argument of node.typeArguments ?? []) {
      const sensitive = sensitiveIdentityName(units, unit, argument, seen)
      if (sensitive !== undefined) return sensitive
    }
    return undefined
  }
  if (ts.isParenthesizedTypeNode(node) || ts.isTypeOperatorNode(node)) {
    return sensitiveIdentityName(units, unit, node.type, seen)
  }
  if (ts.isUnionTypeNode(node) || ts.isIntersectionTypeNode(node)) {
    for (const member of node.types) {
      const sensitive = sensitiveIdentityName(units, unit, member, seen)
      if (sensitive !== undefined) return sensitive
    }
  }
  return undefined
}

function isRuntimeFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  )
}

function enclosingFunction(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  let current: ts.Node | undefined = node.parent
  while (current !== undefined) {
    if (isRuntimeFunctionLike(current)) return current
    current = current.parent
  }
  return undefined
}

function functionName(node: ts.FunctionLikeDeclaration): string | undefined {
  if ('name' in node && node.name !== undefined && ts.isIdentifier(node.name)) return node.name.text
  return undefined
}

function functionReturnType(node: ts.FunctionLikeDeclaration): ts.TypeNode | undefined {
  return 'type' in node ? node.type : undefined
}

export function capabilityForgeViolations(units: readonly SourceUnit[]): string[] {
  const violations = new Set<string>()
  const sensitiveOwners = new Map<string, string>()
  const authorizedFactories = new Map<string, Set<ts.FunctionLikeDeclaration>>()

  for (const unit of units) {
    const location = moduleLocation(unit.path)
    if (location === null) continue
    const uniqueSymbols = new Set<string>()
    for (const statement of unit.source.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.type !== undefined &&
            declaration.type.getText(unit.source) === 'unique symbol'
          ) {
            uniqueSymbols.add(declaration.name.text)
          }
        }
      }
    }
    for (const statement of unit.source.statements) {
      const entrypoint = /^public\/([^/]+)$/.exec(location.rest)?.[1]
      if (
        (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) &&
        SENSITIVE_TYPE.test(statement.name.text) &&
        (entrypoint === 'participants' ||
          // RFC-363 implements the RFC-362 ports in their declared owner files.
          // Apply the same brand/factory/registry rules to these private port
          // declarations instead of treating their owner as an external forger.
          (location.context === 'source-control' &&
            location.rest === 'application/ports/repositoryLaunch' &&
            (statement.name.text === 'RepositoryLaunchSnapshotInTx' ||
              statement.name.text === 'RepositoryPreparationEffectCapability')) ||
          (location.context === 'task-execution' &&
            location.rest === 'application/ports/workspaceLaunch' &&
            statement.name.text === 'WorkspaceReadCapability'))
      ) {
        const key = `${location.context}:${statement.name.text}`
        sensitiveOwners.set(key, unit.path)
        const text = statement.getText(unit.source)
        const branded = [...uniqueSymbols].some((brand) => text.includes(`[${brand}]`))
        if (!branded)
          violations.add(
            `${canonicalModulePath(unit.path)}#${statement.name.text}: missing private brand`,
          )
        if (!/\bReadonly\s*</.test(text) && !/\breadonly\b/.test(text)) {
          violations.add(`${canonicalModulePath(unit.path)}#${statement.name.text}: not readonly`)
        }
      }
    }
  }

  for (const unit of units) {
    const location = moduleLocation(unit.path)
    const entrypoint = location === null ? undefined : /^public\/([^/]+)$/.exec(location.rest)?.[1]
    if (entrypoint !== 'events' && entrypoint !== 'types') continue
    const declarations: ts.Declaration[] = []
    for (const statement of unit.source.statements) {
      if (
        hasExportModifier(statement) &&
        (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement))
      ) {
        declarations.push(statement)
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.exportClause !== undefined &&
        ts.isNamedExports(statement.exportClause)
      ) {
        const target =
          statement.moduleSpecifier === undefined
            ? unit
            : resolveUnit(units, unit.path, literalSpecifier(statement.moduleSpecifier) ?? '')
        if (target === undefined) continue
        for (const element of statement.exportClause.elements) {
          const resolved = resolveNamedDeclaration(
            units,
            target,
            element.propertyName?.text ?? element.name.text,
          )
          if (resolved !== undefined) declarations.push(resolved.declaration)
        }
      }
    }
    for (const declaration of declarations) {
      const sensitive = declarationTypeNodes(declaration)
        .map((node) => containsSensitiveTypeName(units, unit, node))
        .find((name) => name !== undefined)
      if (sensitive !== undefined) {
        violations.add(
          `${canonicalModulePath(unit.path)}: ${sensitive} leaks through public/${entrypoint}`,
        )
      }
    }
  }

  for (const unit of units) {
    const location = moduleLocation(unit.path)
    if (location === null) continue
    const visitFactories = (node: ts.Node): void => {
      if (isRuntimeFunctionLike(node)) {
        const sensitive = sensitiveIdentityName(units, unit, functionReturnType(node))
        const name = functionName(node)
        if (sensitive !== undefined && name !== undefined && /^(?:create|mint)/.test(name)) {
          const ownerKey = `${location.context}:${sensitive}`
          if (!sensitiveOwners.has(ownerKey)) {
            violations.add(
              `${canonicalModulePath(unit.path)}#${name}: factory is outside capability owner`,
            )
          } else {
            const factories = authorizedFactories.get(ownerKey) ?? new Set()
            factories.add(node)
            authorizedFactories.set(ownerKey, factories)
            const body = node.body?.getText(unit.source) ?? ''
            if (!body.includes('Object.freeze')) {
              violations.add(
                `${canonicalModulePath(unit.path)}#${name}: factory does not freeze capability`,
              )
            }
            if (!/\bnew\s+Weak(?:Map|Set)\b/.test(unit.text)) {
              violations.add(
                `${canonicalModulePath(unit.path)}#${name}: no private runtime registry`,
              )
            }
          }
        }
      }
      ts.forEachChild(node, visitFactories)
    }
    visitFactories(unit.source)
  }

  for (const [ownerKey, path] of sensitiveOwners) {
    const factories = authorizedFactories.get(ownerKey)
    if (factories === undefined || factories.size === 0) {
      violations.add(
        `${canonicalModulePath(path)}#${ownerKey.split(':')[1]}: missing owner factory`,
      )
    } else if (factories.size > 1) {
      violations.add(
        `${canonicalModulePath(path)}#${ownerKey.split(':')[1]}: multiple owner factories`,
      )
    }
  }

  for (const unit of units) {
    const location = moduleLocation(unit.path)
    if (location === null) continue
    const sensitiveVariables = new Set<string>()
    const isAuthorized = (node: ts.Node, sensitive: string): boolean => {
      const fn = enclosingFunction(node)
      return (
        fn !== undefined &&
        (authorizedFactories.get(`${location.context}:${sensitive}`)?.has(fn) ?? false)
      )
    }
    const rootIdentifier = (expression: ts.Expression): ts.Identifier | undefined => {
      let current = expression
      while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
        current = current.expression
      }
      return ts.isIdentifier(current) ? current : undefined
    }
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
        const initializerType =
          ts.isVariableDeclaration(node) &&
          node.initializer !== undefined &&
          (ts.isAsExpression(node.initializer) ||
            ts.isTypeAssertionExpression(node.initializer) ||
            ts.isSatisfiesExpression(node.initializer))
            ? node.initializer.type
            : undefined
        const sensitive =
          sensitiveIdentityName(units, unit, node.type) ??
          sensitiveIdentityName(units, unit, initializerType)
        if (sensitive !== undefined && ts.isIdentifier(node.name)) {
          sensitiveVariables.add(node.name.text)
          if (
            ts.isVariableDeclaration(node) &&
            node.initializer !== undefined &&
            (ts.isObjectLiteralExpression(node.initializer) ||
              (ts.isCallExpression(node.initializer) &&
                ts.isPropertyAccessExpression(node.initializer.expression) &&
                node.initializer.expression.expression.getText(unit.source) === 'JSON' &&
                node.initializer.expression.name.text === 'parse')) &&
            !isAuthorized(node, sensitive)
          ) {
            violations.add(
              `${canonicalModulePath(unit.path)}: constructs ${sensitive} outside owner factory`,
            )
          }
        }
      }
      if (
        ts.isAsExpression(node) ||
        ts.isTypeAssertionExpression(node) ||
        ts.isSatisfiesExpression(node)
      ) {
        const sensitive = sensitiveIdentityName(units, unit, node.type)
        if (sensitive !== undefined && !isAuthorized(node, sensitive)) {
          violations.add(
            `${canonicalModulePath(unit.path)}: casts/rewraps ${sensitive} outside owner factory`,
          )
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const root = rootIdentifier(node.left)
        if (root !== undefined && sensitiveVariables.has(root.text) && node.left !== root) {
          violations.add(`${canonicalModulePath(unit.path)}: mutates sensitive ${root.text}`)
        }
      }
      if (ts.isDeleteExpression(node)) {
        const root = rootIdentifier(node.expression)
        if (root !== undefined && sensitiveVariables.has(root.text)) {
          violations.add(`${canonicalModulePath(unit.path)}: deletes from sensitive ${root.text}`)
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(unit.source) === 'JSON' &&
        node.expression.name.text === 'stringify' &&
        node.arguments.some(
          (argument) => ts.isIdentifier(argument) && sensitiveVariables.has(argument.text),
        )
      ) {
        violations.add(
          `${canonicalModulePath(unit.path)}: serializes sensitive capability/authority`,
        )
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
  }
  return [...violations].sort()
}

function declarationForTypeReference(
  units: readonly SourceUnit[],
  unit: SourceUnit,
  node: ts.TypeReferenceNode,
): { unit: SourceUnit; declaration: ts.Declaration } | undefined {
  let rootName = node.typeName
  while (ts.isQualifiedName(rootName)) rootName = rootName.left
  const localName = rootName.text
  const referencedName = ts.isIdentifier(node.typeName)
    ? node.typeName.text
    : node.typeName.right.text
  const binding = importBindings(unit).get(localName)
  if (binding !== undefined) {
    const target = resolveUnit(units, unit.path, binding.specifier)
    return target === undefined
      ? undefined
      : resolveNamedDeclaration(
          units,
          target,
          binding.importedName === '*' ? referencedName : binding.importedName,
        )
  }
  return resolveNamedDeclaration(units, unit, referencedName)
}
