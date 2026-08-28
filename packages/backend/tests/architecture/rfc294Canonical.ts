// RFC-294 N1b — canonical architecture inventory generator.
//
// This module is deliberately assertion-free.  The command-line report and the
// CI guard import the same scanners so that a green guard cannot be produced by
// a different denominator than the committed manifests.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'

import ts from 'typescript'

import {
  backendUnits,
  importEdges,
  inboundBoundaryEdges,
  layerOf,
  ledgerEntryCount,
  moduleLocation,
  moduleShapes,
  outboundBoundaryEdges,
  packageSrcUnits,
  portable,
  type EdgeKind,
  type EdgeSyntax,
  type SourceUnit,
} from './census'
import { KNOWN_VIOLATIONS } from '../../../../scripts/depcheck'
import {
  buildCodeHostRecoveryBindingManifest,
  validateCodeHostRecoveryBindingManifest,
} from '../../src/modules/task-execution/domain/codeHostRecovery'

export const CANONICAL_MANIFEST_PATHS = {
  mutationEntrypoints: 'architecture/mutation-entrypoints.json',
  transactionExternalEffects: 'architecture/transaction-external-effects.json',
  backgroundJobs: 'architecture/background-jobs.json',
  crossContextImports: 'architecture/cross-context-imports.json',
  facades: 'architecture/facades.json',
  publicSurfaces: 'architecture/public-surfaces.json',
  moduleSymbolOwners: 'architecture/module-symbol-owners.json',
  report: 'architecture/current-report.json',
} as const

export type CanonicalManifestName = keyof typeof CANONICAL_MANIFEST_PATHS

const EXACT_PUBLIC = new Set(['commands', 'events', 'participants', 'queries', 'types'])
const GOVERNED_EXTERNAL_SPECIFIERS = new Set(['drizzle-orm'])
const MODULE_PREFIX = 'packages/backend/src/modules/'
const BACKEND_PREFIX = 'packages/backend/src/'

export const PUBLIC_SURFACE_OPAQUE_TYPE_ALLOWLIST = [
  'AbortSignal',
  'Extract',
  'Record',
  'extends:Error',
  'z.infer',
] as const

export const TARGET_PUBLIC_CONTEXTS = [
  'collaboration',
  'development-automation',
  'digital-employee',
  'event-center',
  'execution-contract',
  'identity-access',
  'integration',
  'intent',
  'knowledge-evolution',
  'memory',
  'resource-catalog',
  'runtime-management',
  'source-control',
  'system-operations',
  'task-catalog',
  'task-execution',
  'workspace-insight',
] as const

type TargetContext = (typeof TARGET_PUBLIC_CONTEXTS)[number]
type TargetOwner = TargetContext | 'bootstrap' | 'frontend' | 'platform' | 'shared-contracts'

export type ContextEdgeRole =
  | 'authority-type-only'
  | 'offered-consumption'
  | 'required-implementation'

export interface TargetContextEdge {
  readonly id: string
  readonly fromContext: TargetContext
  readonly toContext: TargetContext
  readonly role: ContextEdgeRole
  readonly contract: string
}

const OFFERED_CONTEXT_EDGES: ReadonlyArray<readonly [TargetContext, TargetContext]> = [
  ['task-execution', 'identity-access'],
  ['task-execution', 'resource-catalog'],
  ['task-execution', 'source-control'],
  ['task-execution', 'runtime-management'],
  ['task-catalog', 'identity-access'],
  ['collaboration', 'task-execution'],
  ['memory', 'resource-catalog'],
  ['memory', 'source-control'],
  ['memory', 'collaboration'],
  ['memory', 'task-execution'],
  ['intent', 'resource-catalog'],
  ['integration', 'task-execution'],
  ['integration', 'resource-catalog'],
  ['knowledge-evolution', 'memory'],
  ['knowledge-evolution', 'resource-catalog'],
  ['knowledge-evolution', 'task-execution'],
  ['workspace-insight', 'source-control'],
  ['workspace-insight', 'task-execution'],
  ['workspace-insight', 'runtime-management'],
  ['development-automation', 'identity-access'],
  ['development-automation', 'resource-catalog'],
  ['development-automation', 'source-control'],
  ['development-automation', 'digital-employee'],
  ['development-automation', 'execution-contract'],
  ['digital-employee', 'event-center'],
  ['digital-employee', 'execution-contract'],
  ['task-execution', 'event-center'],
  ['event-center', 'identity-access'],
  ['task-execution', 'execution-contract'],
  ['integration', 'event-center'],
  ['integration', 'development-automation'],
]

const REQUIRED_CONTEXT_EDGES: ReadonlyArray<readonly [TargetContext, TargetContext, string]> = [
  ['integration', 'source-control', 'RepositoryProviderEndpointDiscoveryPort'],
  ['integration', 'source-control', 'GlobalRepositoryTransportProjectionPort'],
  ['collaboration', 'task-execution', 'HumanGatePreparationPort/HumanGateOpenParticipantInTx'],
  ['memory', 'task-execution', 'TaskMemoryInjectionPort'],
  ['integration', 'task-execution', 'CodeHostExecutionPort'],
  ['task-execution', 'development-automation', 'AgentActionExecutionPort'],
  ['task-execution', 'digital-employee', 'ReactionExecutionPortV1'],
  ['task-execution', 'digital-employee', 'ReactionExecutionAdmissionParticipantInTxV1'],
  ['integration', 'development-automation', 'development-effect-spi'],
  ['task-execution', 'task-catalog', 'TaskCatalogSource'],
  ['digital-employee', 'task-catalog', 'TaskCatalogSource'],
  ['task-execution', 'event-center', 'TaskAutomationWorkStartPort'],
  ['digital-employee', 'event-center', 'EmployeeAutomationWorkStartPort'],
  ['identity-access', 'event-center', 'EventAutomationDelegatedContextFactory'],
  ['integration', 'event-center', 'event-source-routing-spi'],
  ['resource-catalog', 'execution-contract', 'contract-resource-projection-spi'],
  ['task-execution', 'execution-contract', 'contract-fixture-spi'],
]

const AUTHORITY_CONTEXTS = TARGET_PUBLIC_CONTEXTS.filter((context) => context !== 'identity-access')

function edgeId(
  role: ContextEdgeRole,
  fromContext: TargetContext,
  toContext: TargetContext,
  contract: string,
): string {
  return `${role}:${fromContext}->${toContext}:${slug(contract)}`
}

export const TARGET_CONTEXT_EDGES: readonly TargetContextEdge[] = [
  ...OFFERED_CONTEXT_EDGES.map(([fromContext, toContext]) => ({
    id: edgeId('offered-consumption', fromContext, toContext, 'public'),
    fromContext,
    toContext,
    role: 'offered-consumption' as const,
    contract: 'exact-public-entrypoint',
  })),
  ...REQUIRED_CONTEXT_EDGES.map(([fromContext, toContext, contract]) => ({
    id: edgeId('required-implementation', fromContext, toContext, contract),
    fromContext,
    toContext,
    role: 'required-implementation' as const,
    contract,
  })),
  ...AUTHORITY_CONTEXTS.map((fromContext) => ({
    id: edgeId('authority-type-only', fromContext, 'identity-access', 'public-types'),
    fromContext,
    toContext: 'identity-access' as const,
    role: 'authority-type-only' as const,
    contract: 'identity-access/public/types:AuthorizationSubjectRef+opaque-authority',
  })),
].sort((left, right) => left.id.localeCompare(right.id))

export interface ManifestProvenance {
  readonly originSha: string
  readonly currentSnapshotSha: string
  readonly contentDigest: string
  readonly digestAlgorithm: 'sha256'
  readonly digestScope: 'canonical-json-without-provenance'
}

export const PROVENANCE_ARTIFACTS = [
  'architecture/commons-manifest.json',
  'architecture/commons-debt.json',
  'architecture/guard-manifest.json',
  'architecture/ledger-baselines.json',
] as const

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)]),
    )
  }
  return value
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(stable(value), null, 2)}\n`
}

function digestText(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

export function artifactPayload(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const record = structuredClone(value as Record<string, unknown>)
  delete record.provenance
  delete record.recordedAtSha
  delete record.recordedAtShaNote
  const baseline = record.baseline
  if (baseline !== null && typeof baseline === 'object' && !Array.isArray(baseline)) {
    delete (baseline as Record<string, unknown>).recordedAtSha
  }
  return record
}

export function artifactContentDigest(value: unknown): string {
  return digestText(stableJson(artifactPayload(value)))
}

export function withArtifactProvenance(
  value: Record<string, unknown>,
  input: { originSha: string; currentSnapshotSha: string },
): Record<string, unknown> {
  const payload = artifactPayload(value) as Record<string, unknown>
  return {
    ...payload,
    provenance: {
      originSha: input.originSha,
      currentSnapshotSha: input.currentSnapshotSha,
      contentDigest: artifactContentDigest(payload),
      digestAlgorithm: 'sha256',
      digestScope: 'canonical-json-without-provenance',
    } satisfies ManifestProvenance,
  }
}

function slug(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  )
}

function declarationName(node: ts.Node): string | null {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)) &&
    node.name !== undefined
  ) {
    return node.name.text
  }
  if (
    (ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node)) &&
    node.name !== undefined
  ) {
    return node.name.getText()
  }
  return null
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ??
        false)
    : false
}

interface NamedNode {
  readonly name: string
  readonly node: ts.Node
  readonly exported: boolean
}

function topLevelNamedNodes(unit: SourceUnit): NamedNode[] {
  const out: NamedNode[] = []
  for (const statement of unit.source.statements) {
    const name = declarationName(statement)
    if (name !== null) {
      out.push({ name, node: statement, exported: hasExportModifier(statement) })
      continue
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const binding of bindingNames(declaration.name)) {
          out.push({ name: binding, node: declaration, exported: hasExportModifier(statement) })
        }
      }
    }
  }
  return out.sort((left, right) => left.name.localeCompare(right.name))
}

function physicalLayer(unit: SourceUnit): string {
  const place = layerOf(unit)
  if (place !== null) return place.layer.replace(/\.ts$/, '')
  if (unit.path.startsWith('packages/frontend/src/')) {
    return unit.path.slice('packages/frontend/src/'.length).split('/')[0] ?? 'frontend'
  }
  if (unit.path.startsWith('packages/shared/src/')) return 'contracts'
  const relative = unit.path.slice(BACKEND_PREFIX.length)
  return relative.split('/')[0] ?? 'legacy'
}

function semanticTokens(path: string, symbol: string): readonly string[] {
  return `${path}#${symbol}`
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
}

export function hasScheduleTargetToken(path: string, symbol = ''): boolean {
  return semanticTokens(path, symbol).some((token) =>
    ['schedule', 'scheduled', 'schedules', 'scheduling'].includes(token),
  )
}

export function targetContextFor(path: string, symbol = ''): TargetOwner {
  const location = moduleLocation(path)
  if (
    location !== null &&
    (TARGET_PUBLIC_CONTEXTS as readonly string[]).includes(location.context)
  ) {
    return location.context as TargetContext
  }
  if (path.startsWith('packages/frontend/src/')) return 'frontend'
  if (path.startsWith('packages/shared/src/')) return 'shared-contracts'
  if (path.startsWith('packages/backend/src/platform/')) return 'platform'
  if (path === 'packages/backend/src/server.ts' || path === 'packages/backend/src/cli/start.ts') {
    return 'bootstrap'
  }
  const value = `${path}#${symbol}`.toLowerCase()
  if (/identity|auth|user|permission|grant|oidc|presence/.test(value)) return 'identity-access'
  if (/memory|distill/.test(value)) return 'memory'
  if (/intent/.test(value)) return 'intent'
  if (/fusion|skillversion|knowledge/.test(value)) return 'knowledge-evolution'
  if (/structural|symbol|insight|narrative/.test(value)) return 'workspace-insight'
  if (/runtime|opencode|claudecode|providerprofile/.test(value)) return 'runtime-management'
  if (/webhook|codehost|gitlab|github|integration/.test(value) || hasScheduleTargetToken(path, symbol)) {
    return 'integration'
  }
  if (/repo|git|worktree|workspace|candidate|commit|publish/.test(value)) return 'source-control'
  if (/review|clarify|question|collaboration|continuation/.test(value)) return 'collaboration'
  if (/employee|reaction|casecontext/.test(value)) return 'digital-employee'
  if (/eventcenter|eventdelivery|eventsource/.test(value)) return 'event-center'
  if (/catalog/.test(value)) return 'task-catalog'
  if (/agent|workflow|workgroup|plugin|skill|mcp/.test(value)) return 'resource-catalog'
  if (/backup|restore|maintenance|doctor|migrate/.test(value)) return 'system-operations'
  return 'task-execution'
}

const SCHEDULER_W2_B_SYMBOLS = new Set([
  'buildScopeUpstreams',
  'deriveFrontier',
  'findScopeCycle',
  'runScope',
  'runTaskInner',
  'runTaskWithTopology',
])
const SCHEDULER_W2_D_SYMBOLS = new Set([
  'dispatchFanoutAggregator',
  'dispatchFanoutShard',
  'replayConflictHumanResolutions',
  'replayPendingMerges',
  'runGitWrapperNode',
  'runLoopWrapperNode',
  'runWrapperFanoutNode',
  'runWrapperGitNode',
  'runWrapperLoopNode',
  'runWrapperNode',
])
const SCHEDULER_W3_SYMBOLS = new Set(['cancelTaskRow', 'emitStatus', 'failTask'])
const SCHEDULER_W5_SYMBOLS = new Set(['inspectReadonlyRepos', 'maybeRunCommitPush'])

const RFC_332_COMPATIBILITY_BRIDGE_FILES = new Set([
  'packages/backend/src/modules/task-execution/composition/dagFrontier.ts',
  'packages/backend/src/modules/task-execution/composition/taskDagGraph.ts',
  'packages/backend/src/modules/task-execution/composition/taskDagScope.ts',
  'packages/backend/src/modules/task-execution/composition/taskEngineApplication.ts',
  'packages/backend/src/modules/task-execution/infrastructure/taskDriverLifecycle.ts',
])

function isRfc332CompatibilityEdge(edge: Pick<ObservedContextEdge, 'fromFile' | 'toFile'>): boolean {
  return (
    RFC_332_COMPATIBILITY_BRIDGE_FILES.has(edge.fromFile) ||
    (edge.fromFile === 'packages/backend/src/services/task.ts' &&
      edge.toFile ===
        'packages/backend/src/modules/task-execution/composition/taskDriveLegacy.ts')
  )
}

export function targetRemoveAfterWaveFor(
  path: string,
  symbol: string,
  targetContext: TargetOwner = targetContextFor(path, symbol),
): string {
  if (path === 'packages/backend/src/services/scheduler.ts') {
    if (SCHEDULER_W2_B_SYMBOLS.has(symbol)) return 'W2-B'
    if (SCHEDULER_W2_D_SYMBOLS.has(symbol)) return 'W2-D'
    if (SCHEDULER_W3_SYMBOLS.has(symbol)) return 'W3'
    if (SCHEDULER_W5_SYMBOLS.has(symbol)) return 'W5'
    return 'W2-D/W3/W5'
  }
  return targetContext === 'source-control' ? 'W5' : 'W4/W9'
}

function targetLayerFor(path: string, symbol: string): string {
  const location = moduleLocation(path)
  if (location !== null) return location.rest.split('/')[0] ?? 'application'
  if (path.startsWith('packages/frontend/src/')) {
    return path.slice('packages/frontend/src/'.length).split('/')[0] ?? 'frontend'
  }
  if (path.startsWith('packages/shared/src/')) return 'contracts'
  if (path.startsWith('packages/backend/src/platform/')) {
    return path.slice('packages/backend/src/platform/'.length).split('/')[0] ?? 'mechanism'
  }
  const value = `${path}#${symbol}`.toLowerCase()
  if (/schema|model|policy|lifecycle|status|predicate/.test(value)) return 'domain'
  if (/adapter|sqlite|store|repository|client|driver|fs|git/.test(value)) return 'infrastructure'
  if (/scheduler\.ts|executor|wrapper|kernel|frontier|nodeexecutor/.test(value)) return 'engine'
  if (/route|server|ws|mcp|cli/.test(value)) return 'inbound'
  return 'application'
}

function ownerEntryId(path: string, symbol: string): string {
  return `owner:${path}#${symbol}`
}

interface OwnerEntry {
  readonly id: string
  readonly file: string
  readonly symbol: string
  readonly exported: boolean
  readonly currentContext: string
  readonly currentLayer: string
  readonly targetContext: TargetOwner
  readonly targetLayer: string
  readonly status:
    | 'cross-package-contract'
    | 'current-module'
    | 'external-contract'
    | 'legacy-target'
  readonly removeAfterWave: string | null
  readonly signatureDigest: string
}

function buildOwnerEntries(units: readonly SourceUnit[]): OwnerEntry[] {
  const entries: OwnerEntry[] = []
  for (const unit of units) {
    const location = moduleLocation(unit.path)
    const currentContext =
      location?.context ??
      (unit.path.startsWith('packages/frontend/src/')
        ? 'frontend'
        : unit.path.startsWith('packages/shared/src/')
          ? 'shared'
          : 'legacy')
    const currentLayer = physicalLayer(unit)
    const named = topLevelNamedNodes(unit)
    const nodes = [{ name: '$file', node: unit.source as ts.Node, exported: false }, ...named]
    for (const item of nodes) {
      entries.push({
        id: ownerEntryId(unit.path, item.name),
        file: unit.path,
        symbol: item.name,
        exported: item.exported,
        currentContext,
        currentLayer,
        targetContext: targetContextFor(unit.path, item.name),
        targetLayer: targetLayerFor(unit.path, item.name),
        status:
          unit.path.startsWith('packages/frontend/src/') ||
          unit.path.startsWith('packages/shared/src/')
            ? 'cross-package-contract'
            : location === null
              ? 'legacy-target'
              : 'current-module',
        removeAfterWave:
          unit.path.startsWith(BACKEND_PREFIX) && location === null
            ? targetRemoveAfterWaveFor(unit.path, item.name)
            : null,
        signatureDigest: digestText(item.node.getText(unit.source).replace(/\s+/g, ' ').trim()),
      })
    }
  }
  // Function overloads and declaration merging can legitimately repeat one
  // top-level symbol.  Ownership is still one row; the source file remains the
  // signature/API authority for all overload declarations.
  const unique = new Map(entries.map((entry) => [entry.id, entry]))
  for (const specifier of GOVERNED_EXTERNAL_SPECIFIERS) {
    const file = `external:${specifier}`
    const symbol = '$package'
    const entry: OwnerEntry = {
      id: ownerEntryId(file, symbol),
      file,
      symbol,
      exported: true,
      currentContext: 'external',
      currentLayer: 'vendor',
      targetContext: 'platform',
      targetLayer: 'persistence-adapter',
      status: 'external-contract',
      removeAfterWave: null,
      signatureDigest: digestText(specifier),
    }
    unique.set(entry.id, entry)
  }
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id))
}

function attemptsFor(candidate: string): string[] {
  const withoutExtension = candidate.replace(/\.[cm]?tsx?$/, '')
  return [
    candidate,
    `${withoutExtension}.ts`,
    `${withoutExtension}.tsx`,
    `${withoutExtension}/index.ts`,
    `${withoutExtension}/index.tsx`,
  ]
}

function resolveSpecifier(
  allUnits: readonly SourceUnit[],
  fromPath: string,
  specifier: string,
): SourceUnit | null {
  let candidate: string | null = null
  const packageMatch = /^packages\/([^/]+)\/src\//.exec(fromPath)
  if (specifier.startsWith('@/') && packageMatch !== null) {
    candidate = `packages/${packageMatch[1]!}/src/${specifier.slice(2)}`
  } else if (specifier === '@agent-workflow/shared') {
    candidate = 'packages/shared/src/index'
  } else if (specifier.startsWith('@agent-workflow/shared/')) {
    candidate = `packages/shared/src/${specifier.slice('@agent-workflow/shared/'.length)}`
  } else if (specifier.startsWith('.')) {
    candidate = posix.normalize(posix.join(posix.dirname(fromPath), specifier))
  }
  if (candidate === null) return null
  const attempts = new Set(attemptsFor(portable(candidate)))
  return allUnits.find((unit) => attempts.has(unit.path)) ?? null
}

interface SymbolImport {
  readonly fromFile: string
  readonly toFile: string
  readonly importedName: string
  readonly localName: string
  readonly edgeKind: EdgeKind
  readonly syntax: EdgeSyntax
  readonly specifier: string
}

function symbolImports(unit: SourceUnit, allUnits: readonly SourceUnit[]): SymbolImport[] {
  const out: SymbolImport[] = []
  const add = (
    specifier: string,
    importedName: string,
    localName: string,
    edgeKind: EdgeKind,
    syntax: EdgeSyntax,
  ): void => {
    const target = resolveSpecifier(allUnits, unit.path, specifier)
    if (target === null) return
    out.push({
      fromFile: unit.path,
      toFile: target.path,
      importedName,
      localName,
      edgeKind,
      syntax,
      specifier,
    })
  }
  for (const statement of unit.source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text
      const clause = statement.importClause
      if (clause?.name !== undefined) {
        add(
          specifier,
          'default',
          clause.name.text,
          clause.isTypeOnly ? 'type' : 'value',
          'static-import',
        )
      }
      if (clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          add(
            specifier,
            element.propertyName?.text ?? element.name.text,
            element.name.text,
            clause.isTypeOnly || element.isTypeOnly ? 'type' : 'value',
            'static-import',
          )
        }
      } else if (clause?.namedBindings !== undefined) {
        add(
          specifier,
          '*',
          clause.namedBindings.name.text,
          clause.isTypeOnly ? 'type' : 'value',
          'static-import',
        )
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      const specifier = statement.moduleSpecifier.text
      if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          add(
            specifier,
            element.propertyName?.text ?? element.name.text,
            element.name.text,
            statement.isTypeOnly || element.isTypeOnly ? 'type' : 'value',
            'export',
          )
        }
      } else {
        add(specifier, '*', '*', statement.isTypeOnly ? 'type' : 'value', 'export')
      }
    }
  }
  // Side-effect imports, import(), require() and import('x').T carry a real
  // dependency even when no named binding exists.  Preserve them as a wildcard
  // symbol edge instead of letting the symbol-level inventory hide them.
  for (const edge of importEdges(unit)) {
    if (
      out.some(
        (item) =>
          item.specifier === edge.specifier &&
          item.edgeKind === edge.kind &&
          item.syntax === edge.syntax,
      )
    ) {
      continue
    }
    add(edge.specifier, '*', '*', edge.kind, edge.syntax)
  }
  return out.sort((left, right) =>
    `${left.fromFile}|${left.toFile}|${left.importedName}|${left.edgeKind}`.localeCompare(
      `${right.fromFile}|${right.toFile}|${right.importedName}|${right.edgeKind}`,
    ),
  )
}

function publicLocation(path: string): { context: string; entrypoint: string } | null {
  const location = moduleLocation(path)
  if (location === null) return null
  const match = /^public\/([^/]+)$/.exec(location.rest)
  if (match === null || !EXACT_PUBLIC.has(match[1]!)) return null
  return { context: location.context, entrypoint: match[1]! }
}

function requiredPortLocation(path: string): { context: string } | null {
  const location = moduleLocation(path)
  return location?.rest === 'composition/required-ports' ? { context: location.context } : null
}

type ObservedEdgeRole =
  | ContextEdgeRole
  | 'external-layer-debt'
  | 'temporary-internal-debt'
  | 'legacy-inbound'
  | 'legacy-outbound'

interface ObservedContextEdge {
  readonly id: string
  readonly fromFile: string
  readonly fromOwnerEntryId: string
  readonly fromContext: string
  readonly toFile: string
  readonly toOwnerEntryId: string
  readonly toContext: string
  readonly targetSymbol: string
  readonly specifier: string
  readonly edgeKind: EdgeKind
  readonly syntax: EdgeSyntax
  readonly role: ObservedEdgeRole
  readonly owner: string
  readonly removeAfterWave: string | null
}

function observedContextEdges(
  backend: readonly SourceUnit[],
  allUnits: readonly SourceUnit[],
  owners: readonly OwnerEntry[],
): ObservedContextEdge[] {
  const ownerIds = new Set(owners.map((entry) => entry.id))
  const edges: ObservedContextEdge[] = []
  for (const unit of backend) {
    const fromLocation = moduleLocation(unit.path)
    for (const item of symbolImports(unit, allUnits)) {
      // shared/frontend/platform packages are outside the bounded-context
      // module graph.  Their package dependency is governed separately; this
      // manifest owns backend module and legacy-boundary edges only.
      if (!item.toFile.startsWith(BACKEND_PREFIX)) continue
      const toLocation = moduleLocation(item.toFile)
      if (fromLocation?.context === toLocation?.context) continue
      if (fromLocation === null && toLocation === null) continue

      let role: ObservedEdgeRole
      let removeAfterWave: string | null = null
      if (fromLocation === null) {
        role = 'legacy-inbound'
        removeAfterWave =
          unit.path === 'packages/backend/src/services/task.ts' &&
          item.toFile ===
            'packages/backend/src/modules/task-execution/composition/taskDriveLegacy.ts'
            ? 'W4'
            : 'W4/W9'
      } else if (toLocation === null) {
        role = 'legacy-outbound'
        removeAfterWave = targetRemoveAfterWaveFor(item.toFile, item.importedName)
      } else {
        const publicEntry = publicLocation(item.toFile)
        const requiredPort = requiredPortLocation(item.toFile)
        if (
          toLocation.context === 'identity-access' &&
          publicEntry?.entrypoint === 'types' &&
          item.edgeKind === 'type'
        ) {
          role = 'authority-type-only'
        } else if (
          requiredPort !== null &&
          item.edgeKind === 'type' &&
          /^application\/adapters\/[^/]+-adapter$/.test(fromLocation.rest)
        ) {
          role = 'required-implementation'
        } else if (publicEntry !== null) {
          role = 'offered-consumption'
        } else {
          role = 'temporary-internal-debt'
          removeAfterWave = 'W4/W5'
        }
      }

      const exactTarget = ownerEntryId(item.toFile, item.importedName)
      const toOwnerEntryId = ownerIds.has(exactTarget)
        ? exactTarget
        : ownerEntryId(item.toFile, '$file')
      const identity = [
        item.fromFile,
        item.toFile,
        item.importedName,
        item.edgeKind,
        item.syntax,
        role,
      ].join('|')
      edges.push({
        id: `import:${digestText(identity).slice('sha256:'.length, 'sha256:'.length + 20)}`,
        fromFile: item.fromFile,
        fromOwnerEntryId: ownerEntryId(item.fromFile, '$file'),
        fromContext: fromLocation?.context ?? 'legacy',
        toFile: item.toFile,
        toOwnerEntryId,
        toContext: toLocation?.context ?? 'legacy',
        targetSymbol: item.importedName,
        specifier: item.specifier,
        edgeKind: item.edgeKind,
        syntax: item.syntax,
        role,
        owner: fromLocation?.context ?? targetContextFor(item.fromFile),
        removeAfterWave,
      })
    }
    if (fromLocation !== null) {
      for (const item of importEdges(unit)) {
        if (!GOVERNED_EXTERNAL_SPECIFIERS.has(item.specifier)) continue
        const toFile = `external:${item.specifier}`
        const identity = [unit.path, toFile, item.kind, item.syntax, 'external-layer-debt'].join(
          '|',
        )
        edges.push({
          id: `import:${digestText(identity).slice('sha256:'.length, 'sha256:'.length + 20)}`,
          fromFile: unit.path,
          fromOwnerEntryId: ownerEntryId(unit.path, '$file'),
          fromContext: fromLocation.context,
          toFile,
          toOwnerEntryId: ownerEntryId(toFile, '$package'),
          toContext: 'external',
          targetSymbol: '*',
          specifier: item.specifier,
          edgeKind: item.kind,
          syntax: item.syntax,
          role: 'external-layer-debt',
          owner: fromLocation.context,
          removeAfterWave: 'W4/W9',
        })
      }
    }
  }
  const unique = new Map(edges.map((edge) => [edge.id, edge]))
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id))
}

function memberNames(node: ts.Node): string[] {
  if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
    return node.members
      .map((member) => declarationName(member))
      .filter((name): name is string => name !== null)
      .sort()
  }
  if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
    return node.type.members
      .map((member) => declarationName(member))
      .filter((name): name is string => name !== null)
      .sort()
  }
  return []
}

interface SurfaceMember {
  readonly name: string
  readonly signatureDigest: string
  readonly consumerEdgeIds: readonly string[]
}

interface SurfaceField {
  readonly fieldPath: string
  readonly type: string
  readonly consumerEdgeIds: readonly string[]
}

function propertyName(node: ts.PropertyName | undefined): string | null {
  if (node === undefined) return null
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) {
    return node.text
  }
  if (ts.isNumericLiteral(node)) return node.text
  return null
}

interface ResolvedShapeReference {
  readonly key: string
  readonly node: ts.Node
  readonly source: ts.SourceFile
}

type ShapeResolver = (source: ts.SourceFile, name: string) => ResolvedShapeReference | null

interface MutableShape {
  readonly fields: Array<{ fieldPath: string; type: string }>
  readonly methods: Array<{ name: string; signatureDigest: string }>
  unionVariants: number
  readonly unresolvedRefs: string[]
}

function shapePath(prefix: string, name: string): string {
  return prefix === '' ? name : `${prefix}.${name}`
}

function collectNodeShape(
  node: ts.Node,
  source: ts.SourceFile,
  shape: MutableShape,
  resolver: ShapeResolver,
  prefix: string,
  visited: ReadonlySet<string>,
  depth: number,
): void {
  if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
    for (const member of node.members) {
      if (ts.isCallSignatureDeclaration(member)) {
        shape.methods.push({
          name: '$call',
          signatureDigest: digestText(member.getText(source).replace(/\s+/g, ' ').trim()),
        })
        continue
      }
      const name = propertyName(member.name)
      if (name === null) continue
      if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member)) {
        shape.methods.push({
          name,
          signatureDigest: digestText(member.getText(source).replace(/\s+/g, ' ').trim()),
        })
      } else if (
        (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) &&
        member.type !== undefined
      ) {
        collectTypeShape(
          member.type,
          source,
          shape,
          resolver,
          shapePath(prefix, name),
          visited,
          depth + 1,
        )
      }
    }
    for (const clause of node.heritageClauses ?? []) {
      for (const heritage of clause.types) {
        const name = heritage.expression.getText(source)
        const resolved = ts.isIdentifier(heritage.expression) ? resolver(source, name) : null
        if (resolved !== null && !visited.has(resolved.key)) {
          collectNodeShape(
            resolved.node,
            resolved.source,
            shape,
            resolver,
            prefix,
            new Set([...visited, resolved.key]),
            depth + 1,
          )
        } else {
          shape.unresolvedRefs.push(resolved === null ? `extends:${name}` : `$cycle:${name}`)
        }
      }
    }
  } else if (ts.isTypeAliasDeclaration(node)) {
    collectTypeShape(node.type, source, shape, resolver, prefix, visited, depth + 1)
  } else if (ts.isFunctionDeclaration(node)) {
    shape.methods.push({
      name: '$call',
      signatureDigest: digestText(node.getText(source).replace(/\s+/g, ' ').trim()),
    })
  }
}

function collectTypeShape(
  type: ts.TypeNode,
  source: ts.SourceFile,
  shape: MutableShape,
  resolver: ShapeResolver,
  prefix = '',
  visited: ReadonlySet<string> = new Set(),
  depth = 0,
): void {
  if (depth > 20) {
    shape.unresolvedRefs.push('$depth-limit')
    return
  }
  if (ts.isTypeLiteralNode(type)) {
    for (const member of type.members) {
      if (ts.isCallSignatureDeclaration(member)) {
        shape.methods.push({
          name: '$call',
          signatureDigest: digestText(member.getText(source).replace(/\s+/g, ' ').trim()),
        })
        continue
      }
      const name = propertyName(member.name)
      if (name === null) continue
      if (ts.isMethodSignature(member)) {
        shape.methods.push({
          name,
          signatureDigest: digestText(member.getText(source).replace(/\s+/g, ' ').trim()),
        })
      } else if (ts.isPropertySignature(member) && member.type !== undefined) {
        collectTypeShape(
          member.type,
          source,
          shape,
          resolver,
          shapePath(prefix, name),
          visited,
          depth + 1,
        )
      }
    }
    return
  }
  if (ts.isUnionTypeNode(type)) {
    shape.unionVariants += type.types.length
    type.types.forEach((variant, index) =>
      collectTypeShape(
        variant,
        source,
        shape,
        resolver,
        shapePath(prefix, `$variant:${index}`),
        visited,
        depth + 1,
      ),
    )
    return
  }
  if (ts.isIntersectionTypeNode(type)) {
    for (const member of type.types) {
      collectTypeShape(member, source, shape, resolver, prefix, visited, depth + 1)
    }
    return
  }
  if (ts.isParenthesizedTypeNode(type)) {
    collectTypeShape(type.type, source, shape, resolver, prefix, visited, depth + 1)
    return
  }
  if (ts.isArrayTypeNode(type)) {
    collectTypeShape(type.elementType, source, shape, resolver, `${prefix}[]`, visited, depth + 1)
    return
  }
  if (ts.isTypeReferenceNode(type)) {
    const name = type.typeName.getText(source)
    const argument = type.typeArguments?.[0]
    if (argument !== undefined && ['Array', 'ReadonlyArray', 'Set', 'ReadonlySet'].includes(name)) {
      collectTypeShape(argument, source, shape, resolver, `${prefix}[]`, visited, depth + 1)
      return
    }
    if (
      argument !== undefined &&
      ['Readonly', 'Required', 'Partial', 'Promise', 'Awaited', 'NonNullable'].includes(name)
    ) {
      collectTypeShape(argument, source, shape, resolver, prefix, visited, depth + 1)
      return
    }
    const resolved = resolver(source, name)
    if (resolved !== null && !visited.has(resolved.key)) {
      collectNodeShape(
        resolved.node,
        resolved.source,
        shape,
        resolver,
        prefix,
        new Set([...visited, resolved.key]),
        depth + 1,
      )
      return
    }
    shape.fields.push({ fieldPath: prefix === '' ? '$value' : prefix, type: type.getText(source) })
    shape.unresolvedRefs.push(resolved === null ? name : `$cycle:${name}`)
    return
  }
  shape.fields.push({ fieldPath: prefix === '' ? '$value' : prefix, type: type.getText(source) })
}

function nodeShape(
  node: ts.Node,
  source: ts.SourceFile,
  resolver: ShapeResolver,
): {
  fields: Array<{ fieldPath: string; type: string }>
  methods: Array<{ name: string; signatureDigest: string }>
  unionVariants: number
  unresolvedRefs: string[]
} {
  const shape: MutableShape = { fields: [], methods: [], unionVariants: 0, unresolvedRefs: [] }
  collectNodeShape(
    node,
    source,
    shape,
    resolver,
    '',
    new Set([`${source.fileName}#${declarationName(node) ?? '$anonymous'}`]),
    0,
  )
  return {
    fields: [...new Map(shape.fields.map((field) => [field.fieldPath, field])).values()].sort(
      (a, b) => a.fieldPath.localeCompare(b.fieldPath),
    ),
    methods: [...new Map(shape.methods.map((method) => [method.name, method])).values()].sort(
      (a, b) => a.name.localeCompare(b.name),
    ),
    unionVariants: shape.unionVariants,
    unresolvedRefs: [...new Set(shape.unresolvedRefs)].sort(),
  }
}

function createShapeResolver(units: readonly SourceUnit[]): ShapeResolver {
  const byPath = new Map(units.map((unit) => [unit.path, unit]))
  const declarations = new Map(
    units.map((unit) => [
      unit.path,
      new Map(topLevelNamedNodes(unit).map((entry) => [entry.name, entry.node])),
    ]),
  )
  const imports = new Map(units.map((unit) => [unit.path, symbolImports(unit, units)]))
  const resolveExported = (
    unit: SourceUnit,
    name: string,
    visited: ReadonlySet<string> = new Set(),
  ): ResolvedShapeReference | null => {
    const key = `${unit.path}#${name}`
    if (visited.has(key)) return null
    const nextVisited = new Set([...visited, key])
    const local = topLevelNamedNodes(unit).find(
      (entry) => entry.name === name && entry.exported,
    )?.node
    if (local !== undefined) return { key, node: local, source: unit.source }

    for (const statement of unit.source.statements) {
      if (!ts.isExportDeclaration(statement)) continue
      const targetUnit =
        statement.moduleSpecifier !== undefined && ts.isStringLiteralLike(statement.moduleSpecifier)
          ? resolveSpecifier(units, unit.path, statement.moduleSpecifier.text)
          : unit
      if (targetUnit === null) continue
      if (statement.exportClause === undefined) {
        const resolved = resolveExported(targetUnit, name, nextVisited)
        if (resolved !== null) return resolved
        continue
      }
      if (!ts.isNamedExports(statement.exportClause)) continue
      const element = statement.exportClause.elements.find(
        (candidate) => candidate.name.text === name,
      )
      if (element === undefined) continue
      const sourceName = element.propertyName?.text ?? element.name.text
      if (targetUnit === unit) {
        const targetNode = declarations.get(unit.path)?.get(sourceName)
        if (targetNode !== undefined) {
          return { key: `${unit.path}#${sourceName}`, node: targetNode, source: unit.source }
        }
        continue
      }
      const resolved = resolveExported(targetUnit, sourceName, nextVisited)
      if (resolved !== null) return resolved
    }
    return null
  }

  return (source, name) => {
    const local = declarations.get(source.fileName)?.get(name)
    if (local !== undefined) {
      return { key: `${source.fileName}#${name}`, node: local, source }
    }
    const binding = imports
      .get(source.fileName)
      ?.find((entry) => entry.localName === name && entry.importedName !== '*')
    if (binding === undefined) {
      const sourceUnit = byPath.get(source.fileName)
      return sourceUnit === undefined ? null : resolveExported(sourceUnit, name)
    }
    const targetUnit = byPath.get(binding.toFile)
    if (targetUnit === undefined) return null
    return resolveExported(targetUnit, binding.importedName)
  }
}

interface PublicSurfaceEntry {
  readonly id: string
  readonly context: string
  readonly entrypoint: string
  readonly symbol: string
  readonly file: string
  readonly ownerEntryId: string
  readonly signatureDigest: string
  readonly members: readonly string[]
  readonly consumerEdgeIds: readonly string[]
  readonly productionConsumers: readonly {
    readonly edgeId: string
    readonly ownerEntryId: string
    readonly context: string
    readonly file: string
  }[]
  readonly methods: readonly SurfaceMember[]
  readonly fields: readonly SurfaceField[]
  readonly unresolvedTypeRefs: readonly string[]
  readonly direction: 'offered'
  readonly authority: 'context-bound' | 'none' | 'request-authority'
  readonly transaction: 'caller-tx' | 'none' | 'own-tx'
  readonly serialization: 'durable' | 'ephemeral' | 'wire'
  readonly dataClass: 'confidential' | 'metadata' | 'secret'
  readonly version: 1
  readonly budget: {
    readonly maxMethods: number
    readonly maxTopLevelFields: number
    readonly maxTransitiveLeafFields: number
    readonly maxUnionVariants: number
  }
  readonly status: 'legacy-context-debt' | 'target-context-current-surface'
  readonly removeAfterWave: string | null
}

function publicSurfaceLifecycle(location: {
  context: string
  entrypoint: string
}): Pick<PublicSurfaceEntry, 'status' | 'removeAfterWave'> {
  const target = (TARGET_PUBLIC_CONTEXTS as readonly string[]).includes(location.context)
  return {
    status: target ? 'target-context-current-surface' : 'legacy-context-debt',
    removeAfterWave: target ? null : 'W9-D',
  }
}

function buildPublicSurfaces(
  backend: readonly SourceUnit[],
  allUnits: readonly SourceUnit[],
  observedEdges: readonly ObservedContextEdge[],
): PublicSurfaceEntry[] {
  const entries: PublicSurfaceEntry[] = []
  const resolver = createShapeResolver(allUnits)
  const unitsByPath = new Map(backend.map((unit) => [unit.path, unit]))
  const consumersFor = (
    unit: SourceUnit,
    symbol: string,
  ): { edges: ObservedContextEdge[]; memberEdges: (name: string) => string[] } => {
    const edges = observedEdges.filter(
      (edge) =>
        edge.toFile === unit.path && (edge.targetSymbol === symbol || edge.targetSymbol === '*'),
    )
    return {
      edges,
      memberEdges: (name) =>
        edges
          .filter((edge) => {
            const consumer = unitsByPath.get(edge.fromFile)
            return (
              consumer !== undefined &&
              new RegExp(`\\b${name.replace(/[$]/g, '\\$&')}\\b`).test(consumer.text)
            )
          })
          .map((edge) => edge.id)
          .sort(),
    }
  }
  const classification = (
    location: { context: string; entrypoint: string },
    symbol: string,
  ): Pick<PublicSurfaceEntry, 'authority' | 'dataClass' | 'serialization' | 'transaction'> => ({
    authority:
      location.entrypoint === 'commands' || location.entrypoint === 'queries'
        ? 'request-authority'
        : location.entrypoint === 'participants'
          ? 'context-bound'
          : 'none',
    transaction:
      location.entrypoint === 'commands'
        ? 'own-tx'
        : location.entrypoint === 'participants'
          ? 'caller-tx'
          : 'none',
    serialization:
      location.entrypoint === 'events'
        ? 'durable'
        : location.entrypoint === 'commands' || location.entrypoint === 'queries'
          ? 'wire'
          : 'ephemeral',
    dataClass: /secret|credential|token|password/i.test(symbol)
      ? 'secret'
      : /authority|actor|subject|user|repository|workspace|artifact/i.test(symbol)
        ? 'confidential'
        : 'metadata',
  })
  for (const unit of backend) {
    const location = publicLocation(unit.path)
    if (location === null) continue
    for (const item of topLevelNamedNodes(unit).filter((node) => node.exported)) {
      const consumers = consumersFor(unit, item.name)
      const shape = nodeShape(item.node, unit.source, resolver)
      const consumerEdgeIds = consumers.edges.map((edge) => edge.id).sort()
      entries.push({
        id: `public:${location.context}:${location.entrypoint}:${item.name}`,
        context: location.context,
        entrypoint: location.entrypoint,
        symbol: item.name,
        file: unit.path,
        ownerEntryId: ownerEntryId(unit.path, item.name),
        signatureDigest: digestText(item.node.getText(unit.source).replace(/\s+/g, ' ').trim()),
        members: memberNames(item.node),
        consumerEdgeIds,
        productionConsumers: consumers.edges.map((edge) => ({
          edgeId: edge.id,
          ownerEntryId: edge.fromOwnerEntryId,
          context: edge.fromContext,
          file: edge.fromFile,
        })),
        methods: shape.methods.map((method) => ({
          ...method,
          consumerEdgeIds: consumers.memberEdges(method.name),
        })),
        fields: shape.fields.map((field) => ({
          ...field,
          consumerEdgeIds: consumers.memberEdges(
            field.fieldPath.split('.').at(-1) ?? field.fieldPath,
          ),
        })),
        unresolvedTypeRefs: shape.unresolvedRefs,
        direction: 'offered',
        ...classification(location, item.name),
        version: 1,
        budget: {
          maxMethods: Math.max(5, shape.methods.length),
          maxTopLevelFields: Math.max(
            12,
            new Set(shape.fields.map((field) => field.fieldPath.split('.')[0])).size,
          ),
          maxTransitiveLeafFields: Math.max(24, shape.fields.length),
          maxUnionVariants: Math.max(12, shape.unionVariants),
        },
        ...publicSurfaceLifecycle(location),
      })
    }
    for (const statement of unit.source.statements) {
      if (!ts.isExportDeclaration(statement) || statement.exportClause === undefined) continue
      if (!ts.isNamedExports(statement.exportClause)) continue
      for (const element of statement.exportClause.elements) {
        const symbol = element.name.text
        const sourceSymbol = element.propertyName?.text ?? element.name.text
        const targetUnit =
          statement.moduleSpecifier !== undefined &&
          ts.isStringLiteralLike(statement.moduleSpecifier)
            ? resolveSpecifier(allUnits, unit.path, statement.moduleSpecifier.text)
            : unit
        const targetNode = targetUnit === null ? null : resolver(targetUnit.source, sourceSymbol)
        const shape =
          targetNode !== null
            ? nodeShape(targetNode.node, targetNode.source, resolver)
            : { fields: [], methods: [], unionVariants: 0, unresolvedRefs: ['$re-export'] }
        const consumers = consumersFor(unit, symbol)
        const consumerEdgeIds = consumers.edges.map((edge) => edge.id).sort()
        entries.push({
          id: `public:${location.context}:${location.entrypoint}:${symbol}`,
          context: location.context,
          entrypoint: location.entrypoint,
          symbol,
          file: unit.path,
          ownerEntryId: ownerEntryId(unit.path, '$file'),
          signatureDigest: digestText(element.getText(unit.source)),
          members: [],
          consumerEdgeIds,
          productionConsumers: consumers.edges.map((edge) => ({
            edgeId: edge.id,
            ownerEntryId: edge.fromOwnerEntryId,
            context: edge.fromContext,
            file: edge.fromFile,
          })),
          methods: shape.methods.map((method) => ({
            ...method,
            consumerEdgeIds: consumers.memberEdges(method.name),
          })),
          fields: shape.fields.map((field) => ({
            ...field,
            consumerEdgeIds: consumers.memberEdges(
              field.fieldPath.split('.').at(-1) ?? field.fieldPath,
            ),
          })),
          unresolvedTypeRefs: shape.unresolvedRefs,
          direction: 'offered',
          ...classification(location, symbol),
          version: 1,
          budget: {
            maxMethods: Math.max(5, shape.methods.length),
            maxTopLevelFields: Math.max(
              12,
              new Set(shape.fields.map((field) => field.fieldPath.split('.')[0])).size,
            ),
            maxTransitiveLeafFields: Math.max(24, shape.fields.length),
            maxUnionVariants: Math.max(12, shape.unionVariants),
          },
          ...publicSurfaceLifecycle(location),
        })
      }
    }
  }
  const unique = new Map(entries.map((entry) => [entry.id, entry]))
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id))
}

interface SourceAnchorSpec {
  readonly file: string
  readonly symbol: string
  readonly sourceToken: string
}

interface SourceAnchor extends SourceAnchorSpec {
  readonly ownerEntryId: string
}

interface GovernedFieldSurface {
  readonly id: string
  readonly fieldPath: string
  readonly purpose: string
  readonly dataClass: 'confidential' | 'metadata'
  readonly owner: SourceAnchor
  readonly writers: readonly SourceAnchor[]
  readonly consumers: readonly SourceAnchor[]
  readonly rollback: string
}

const INTERNAL_CATALOG_VISIBILITY_WRITERS: readonly SourceAnchorSpec[] = [
  {
    file: 'packages/backend/src/modules/task-execution/composition/agentActionExecution.ts',
    symbol: '$file',
    sourceToken: "catalogVisibility: 'internal'",
  },
  {
    file: 'packages/backend/src/modules/task-execution/composition/digitalEmployeeExecution.ts',
    symbol: '$file',
    sourceToken: "catalogVisibility: 'internal'",
  },
  {
    file: 'packages/backend/src/modules/task-execution/composition/scriptActionExecution.ts',
    symbol: '$file',
    sourceToken: "catalogVisibility: 'internal'",
  },
  {
    file: 'packages/backend/src/modules/development-automation/composition/employeeTypePackage.ts',
    symbol: '$file',
    sourceToken: "catalogVisibility: 'internal'",
  },
]

function buildGovernedFieldSurfaces(allUnits: readonly SourceUnit[]): GovernedFieldSurface[] {
  const byPath = new Map(allUnits.map((unit) => [unit.path, unit]))
  const anchor = (spec: SourceAnchorSpec): SourceAnchor => {
    const unit = byPath.get(spec.file)
    if (unit === undefined || !unit.text.includes(spec.sourceToken)) {
      throw new Error(`missing governed field anchor: ${spec.file}#${spec.sourceToken}`)
    }
    return { ...spec, ownerEntryId: ownerEntryId(spec.file, spec.symbol) }
  }
  const internalWriters = INTERNAL_CATALOG_VISIBILITY_WRITERS.map(anchor)
  return [
    {
      id: 'field:shared.TaskCatalogVisibility',
      fieldPath: 'TaskCatalogVisibility',
      purpose: 'Closed public/internal catalog-membership vocabulary; it is not an ACL grant.',
      dataClass: 'metadata',
      owner: anchor({
        file: 'packages/shared/src/taskOperations.ts',
        symbol: 'TaskCatalogVisibility',
        sourceToken: 'export type TaskCatalogVisibility',
      }),
      writers: [],
      consumers: [
        anchor({
          file: 'packages/backend/src/db/schema.ts',
          symbol: 'tasks',
          sourceToken: "catalogVisibility: text('catalog_visibility'",
        }),
        anchor({
          file: 'packages/backend/src/services/task.ts',
          symbol: 'StartTaskDeps',
          sourceToken: 'catalogVisibility?: TaskCatalogVisibility',
        }),
      ],
      rollback: 'Keep the closed vocabulary and persisted values; disable only new readers.',
    },
    {
      id: 'field:tasks.catalog_visibility',
      fieldPath: 'tasks.catalog_visibility',
      purpose:
        'TaskExecution-owned catalog membership; roots default public and children inherit the persisted parent value.',
      dataClass: 'metadata',
      owner: anchor({
        file: 'packages/backend/src/db/schema.ts',
        symbol: 'tasks',
        sourceToken: "catalogVisibility: text('catalog_visibility'",
      }),
      writers: [
        anchor({
          file: 'packages/backend/src/services/task.ts',
          symbol: 'startTaskImpl',
          sourceToken: 'catalogVisibility = parent.catalogVisibility',
        }),
        ...internalWriters,
      ],
      consumers: [
        anchor({
          file: 'packages/backend/src/modules/task-execution/application/adapters/task-catalog-adapter.ts',
          symbol: 'source',
          sourceToken: "catalogVisibility: 'public'",
        }),
        anchor({
          file: 'packages/backend/src/services/taskOperations.ts',
          symbol: '$file',
          sourceToken: "col('catalog_visibility')",
        }),
        anchor({
          file: 'packages/backend/src/routes/tasks.ts',
          symbol: '$file',
          sourceToken: "catalogVisibility: 'public'",
        }),
        anchor({
          file: 'packages/backend/src/services/overview.ts',
          symbol: '$file',
          sourceToken: "eq(tasks.catalogVisibility, 'public')",
        }),
      ],
      rollback: 'Stop new internal callers; retain the column, root default and child inheritance.',
    },
    {
      id: 'field:StartTaskDeps.catalogVisibility',
      fieldPath: 'StartTaskDeps.catalogVisibility',
      purpose: 'Trusted internal launch projection into the TaskExecution-owned membership field.',
      dataClass: 'metadata',
      owner: anchor({
        file: 'packages/backend/src/services/task.ts',
        symbol: 'StartTaskDeps',
        sourceToken: 'catalogVisibility?: TaskCatalogVisibility',
      }),
      writers: internalWriters,
      consumers: [
        anchor({
          file: 'packages/backend/src/services/task.ts',
          symbol: 'startTaskImpl',
          sourceToken: "deps.catalogVisibility ?? 'public'",
        }),
      ],
      rollback:
        'Stop passing the internal projection; preserve persisted membership on existing rows.',
    },
    {
      id: 'field:tasks.digital_employee_case_id',
      fieldPath: 'tasks.digital_employee_case_id',
      purpose:
        'TaskExecution-owned immutable provenance ref used to locate an actor-filtered DigitalEmployee projection.',
      dataClass: 'confidential',
      owner: anchor({
        file: 'packages/backend/src/db/schema.ts',
        symbol: 'tasks',
        sourceToken: "digitalEmployeeCaseId: text('digital_employee_case_id')",
      }),
      writers: [
        anchor({
          file: 'packages/backend/src/services/task.ts',
          symbol: 'startTaskImpl',
          sourceToken: 'digitalEmployeeCaseId: deps.digitalEmployeeLaunch?.caseId ?? null',
        }),
      ],
      consumers: [
        anchor({
          file: 'packages/backend/src/services/task.ts',
          symbol: 'rowToTask',
          sourceToken: 'digitalEmployeeCaseId: row.digitalEmployeeCaseId ?? null',
        }),
        anchor({
          file: 'packages/frontend/src/routes/tasks.detail.tsx',
          symbol: '$file',
          sourceToken: 'tk.digitalEmployeeCaseId',
        }),
        anchor({
          file: 'packages/frontend/src/components/tasks/TaskDigitalEmployeeSourceLink.tsx',
          symbol: 'TaskDigitalEmployeeSourceLink',
          sourceToken: '/api/employee-cases/',
        }),
      ],
      rollback:
        'Disable the link reader; never delete or rewrite already persisted provenance refs.',
    },
    {
      id: 'field:employee_cases.name',
      fieldPath: 'employee_cases.name',
      purpose: 'DigitalEmployee-owned operator task name projected out as taskName.',
      dataClass: 'confidential',
      owner: anchor({
        file: 'packages/backend/src/db/schema.ts',
        symbol: 'employeeCases',
        sourceToken: "name: text('name').notNull().default('')",
      }),
      writers: [
        anchor({
          file: 'packages/backend/src/modules/digital-employee/infrastructure/sqliteRuntimeStore.ts',
          symbol: 'createSqliteRuntimeStore',
          sourceToken: 'name: input.caseRecord.name',
        }),
      ],
      consumers: [
        anchor({
          file: 'packages/backend/src/modules/digital-employee/application/runtimeService.ts',
          symbol: 'DigitalEmployeeRuntimeService',
          sourceToken: 'taskName: caseRecord.name',
        }),
      ],
      rollback:
        'Disable the projection reader; retain the DigitalEmployee-owned value and single writer.',
    },
  ]
}

interface RequiredPortEntry {
  readonly id: string
  readonly context: string
  readonly symbol: string
  readonly ownerEntryId: string
  readonly consumerOwnerEntryIds: readonly string[]
  readonly providerAdapters: readonly {
    readonly edgeId: string
    readonly ownerEntryId: string
    readonly context: string
    readonly file: string
  }[]
  readonly compositionFiles: readonly string[]
  readonly compositionOwnerEntryIds: readonly string[]
  readonly status: 'active' | 'declared-debt'
  readonly removeAfterWave: string | null
}

function buildRequiredPorts(
  backend: readonly SourceUnit[],
  allUnits: readonly SourceUnit[],
  observedEdges: readonly ObservedContextEdge[],
): RequiredPortEntry[] {
  const out: RequiredPortEntry[] = []
  const allImports = backend.flatMap((unit) =>
    symbolImports(unit, allUnits).map((item) => ({ ...item, unit })),
  )
  for (const unit of backend) {
    const location = requiredPortLocation(unit.path)
    if (location === null) continue
    for (const item of topLevelNamedNodes(unit).filter(
      (node) => node.exported && /(?:Port|Participant|Source)(?:V\d+)?$/.test(node.name),
    )) {
      const uses = allImports.filter(
        (entry) => entry.toFile === unit.path && entry.importedName === item.name,
      )
      const consumers = uses
        .filter((entry) => moduleLocation(entry.fromFile)?.context === location.context)
        .map((entry) => ownerEntryId(entry.fromFile, '$file'))
        .sort()
      const providerAdapters = observedEdges
        .filter(
          (edge) =>
            edge.toFile === unit.path &&
            edge.targetSymbol === item.name &&
            edge.role === 'required-implementation',
        )
        .map((edge) => ({
          edgeId: edge.id,
          ownerEntryId: edge.fromOwnerEntryId,
          context: edge.fromContext,
          file: edge.fromFile,
        }))
        .sort((left, right) => left.edgeId.localeCompare(right.edgeId))
      const compositionFiles = uses
        .filter((entry) => moduleLocation(entry.fromFile)?.rest === 'composition')
        .map((entry) => entry.fromFile)
        .sort()
      const active =
        consumers.length > 0 && providerAdapters.length > 0 && compositionFiles.length === 1
      out.push({
        id: `required:${location.context}:${item.name}`,
        context: location.context,
        symbol: item.name,
        ownerEntryId: ownerEntryId(unit.path, item.name),
        consumerOwnerEntryIds: consumers,
        providerAdapters,
        compositionFiles,
        compositionOwnerEntryIds: compositionFiles.map((file) => ownerEntryId(file, '$file')),
        status: active ? 'active' : 'declared-debt',
        removeAfterWave: active
          ? null
          : location.context === 'development-automation'
            ? 'W4-E8/W5'
            : 'W4-E9',
      })
    }
  }

  const reconciler = backend.find((unit) =>
    unit.path.endsWith('modules/development-automation/application/ports/reconcilerPorts.ts'),
  )
  if (reconciler !== undefined) {
    const aggregate = topLevelNamedNodes(reconciler).find((item) => item.name === 'ReconcilerPorts')
    if (aggregate !== undefined) {
      out.push({
        id: 'required:development-automation:ReconcilerPorts-legacy-aggregate',
        context: 'development-automation',
        symbol: 'ReconcilerPorts',
        ownerEntryId: ownerEntryId(reconciler.path, 'ReconcilerPorts'),
        consumerOwnerEntryIds: [],
        providerAdapters: [],
        compositionFiles: ['packages/backend/src/modules/development-automation/composition.ts'],
        compositionOwnerEntryIds: [
          ownerEntryId(
            'packages/backend/src/modules/development-automation/composition.ts',
            '$file',
          ),
        ],
        status: 'declared-debt',
        removeAfterWave: 'W4-E8/W5',
      })
    }
  }
  return out.sort((left, right) => left.id.localeCompare(right.id))
}

const MUTATION_NAME =
  /^(?:add|admit|apply|archive|attach|cancel|claim|commit|confirm|create|delete|deliver|disable|enable|execute|handoff|launch|move|open|patch|promote|publish|reject|remove|rename|resume|retry|restore|revoke|run|save|seal|set|stage|start|stop|submit|sync|terminate|transition|unarchive|update|upsert)/i

interface ControlEvidence {
  readonly authority: 'effect' | 'internal-family' | 'none-observed' | 'request' | 'system'
  readonly authorization: boolean
  readonly transaction: boolean
  readonly fenceOrOcc: boolean
  readonly audit: boolean
  readonly event: boolean
}

function controls(text: string): ControlEvidence {
  const authority =
    /RequestAuthority|DelegatedAuthority|DirectOperationContext|AuthorizationSubjectRef/.test(text)
      ? 'request'
      : /EffectCapability|OwnershipToken|CurrentAuthorityInTx|SystemEffect/.test(text)
        ? 'effect'
        : /SystemActor|background|recovery|bootstrap/i.test(text)
          ? 'system'
          : /Capability|Claim|Epoch/.test(text)
            ? 'internal-family'
            : 'none-observed'
  return {
    authority,
    authorization:
      /authorize|permission|can[A-Z]|require[A-Z]|assert.*(?:owner|edit|permission)|visible|access/i.test(
        text,
      ),
    transaction: /\btransaction\b|\bdbTx(?:Sync)?\b|\btx\b/.test(text),
    fenceOrOcc:
      /\bCAS\b|compare-and-swap|expectedRevision|revision|stale|conflict|epoch|fence|claim/i.test(
        text,
      ),
    audit: /audit|observability|record.*(?:attempt|decision)|ledger/i.test(text),
    event: /event|emit|publish|outbox|invalidate/i.test(text),
  }
}

function missingControlNames(evidence: ControlEvidence): string[] {
  return [
    ...(evidence.authority === 'none-observed' ? ['authority'] : []),
    ...Object.entries(evidence)
      .filter(([name, present]) => name !== 'authority' && present === false)
      .map(([name]) => name),
  ].sort()
}

interface MutationEntry {
  readonly id: string
  readonly file: string
  readonly symbol: string
  readonly ownerEntryId: string
  readonly targetContext: TargetOwner
  readonly targetLayer: string
  readonly controls: ControlEvidence
  readonly missingControls: readonly string[]
  readonly finalCriterion: string
}

function buildMutationEntries(backend: readonly SourceUnit[]): MutationEntry[] {
  const out: MutationEntry[] = []
  for (const unit of backend) {
    for (const item of topLevelNamedNodes(unit)) {
      if (!MUTATION_NAME.test(item.name)) continue
      const text = item.node.getText(unit.source)
      const evidence = controls(text)
      const missingControls = missingControlNames(evidence)
      out.push({
        id: `mutation:${unit.path}#${item.name}`,
        file: unit.path,
        symbol: item.name,
        ownerEntryId: ownerEntryId(unit.path, item.name),
        targetContext: targetContextFor(unit.path, item.name),
        targetLayer: targetLayerFor(unit.path, item.name),
        controls: evidence,
        missingControls,
        finalCriterion: missingControls.length === 0 ? 'controls-complete' : 'W3/W4 owner cutover',
      })
    }

    if (!/\/(?:routes|mcp|ws)\//.test(unit.path)) continue
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['delete', 'patch', 'post', 'put'].includes(node.expression.name.text)
      ) {
        const symbol = `$http:${node.expression.name.text}:${unit.source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
        const text = node.getText(unit.source)
        const evidence = controls(text)
        out.push({
          id: `mutation:${unit.path}#${symbol}`,
          file: unit.path,
          symbol,
          ownerEntryId: ownerEntryId(unit.path, '$file'),
          targetContext: targetContextFor(unit.path, symbol),
          targetLayer: 'inbound',
          controls: evidence,
          missingControls: missingControlNames(evidence),
          finalCriterion: 'W4 transport-to-application cutover',
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
  }
  return out.sort((left, right) => left.id.localeCompare(right.id))
}

type TaskExecutionAuthorityKind =
  | 'worker-epoch'
  | 'control-revision'
  | 'recovery-proof'
  | 'terminal-maintenance'

type TaskExecutionControlSubtype =
  | 'continuation-admission'
  | 'terminal-control'
  | 'gate-control'
  | 'membership-control'
  | 'daemon-shutdown'
  | 'recovery-candidate-revoke'

const TASK_EXECUTION_DURABLE_TABLES = new Set([
  // Business projections are part of the authority denominator too.  The
  // RFC-328 ledgers are not useful if a stale worker can still bypass them by
  // writing the task/node projection directly.
  'tasks',
  'nodeRuns',
  'nodeRunOutputs',
  'nodeRunEvents',
  'taskExecutionOwners',
  'taskExecutionIntents',
  'taskExecutionEffects',
  'taskExecutionEffectAttempts',
  'taskExecutionEffectFences',
  'taskExecutionMaintenanceClaims',
  'taskExecutionMaintenanceMembers',
  'taskExecutionLineageOperationRecords',
])

interface TaskExecutionAuthorityEntry {
  readonly id: string
  readonly file: string
  readonly line: number
  readonly ownerEntryId: string
  readonly symbol: string
  readonly consumer: string
  readonly dataClass: string
  readonly authorityKind: TaskExecutionAuthorityKind
  readonly controlSubtype: TaskExecutionControlSubtype | null
  readonly allowedTables: readonly string[]
  readonly revisionPredicate: string
  readonly requiredBrandedProof: string
}

interface TaskExecutionControlGatewayEntry {
  readonly id: string
  readonly subtype: TaskExecutionControlSubtype
  readonly file: string
  readonly symbol: string
  readonly ownerEntryId: string
  readonly allowedTables: readonly string[]
  readonly allowedTransitions: readonly string[]
  readonly revisionPredicate: string
  readonly requiredBrandedProof: string
}

function nearestCallableName(unit: SourceUnit, node: ts.Node): string {
  let cursor: ts.Node | undefined = node
  while (cursor !== undefined && cursor !== unit.source) {
    if (
      (ts.isMethodDeclaration(cursor) || ts.isFunctionDeclaration(cursor)) &&
      cursor.name !== undefined
    ) {
      return cursor.name.getText(unit.source)
    }
    if (
      (ts.isArrowFunction(cursor) || ts.isFunctionExpression(cursor)) &&
      ts.isVariableDeclaration(cursor.parent) &&
      ts.isIdentifier(cursor.parent.name)
    ) {
      return cursor.parent.name.text
    }
    cursor = cursor.parent
  }
  return enclosingTopLevelSymbol(unit, node)?.name ?? '$file'
}

function durableMutationTable(node: ts.Node): string | null {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    !['insert', 'update', 'delete'].includes(node.expression.name.text)
  ) {
    return null
  }
  const table = node.arguments[0]
  return table !== undefined && ts.isIdentifier(table) ? table.text : null
}

function classifyTaskExecutionAuthority(input: {
  file: string
  callable: string
}): Pick<
  TaskExecutionAuthorityEntry,
  'authorityKind' | 'controlSubtype' | 'revisionPredicate' | 'requiredBrandedProof'
> | null {
  const value = `${input.file}#${input.callable}`
  if (
    /sqliteTerminalMaintenance|taskArchive|taskDelete|services\/eventsArchive\.ts|services\/gc\.ts|services\/lifecycleRepair\//.test(
      value,
    )
  ) {
    return {
      authorityKind: 'terminal-maintenance',
      controlSubtype: null,
      revisionPredicate: 'exact-claim-revision-and-member-set-digest',
      requiredBrandedProof: 'TerminalMaintenanceClaim',
    }
  }
  if (/recoverTaskExecutions|releaseRecovered|closeRecovered/.test(value)) {
    return {
      authorityKind: 'recovery-proof',
      controlSubtype: null,
      revisionPredicate: 'exact-old-owner-revision-and-daemon-generation',
      requiredBrandedProof: 'ExclusiveDaemonLockProof+VerifiedTakeoverOrOutcomeProof',
    }
  }
  if (
    /modules\/task-execution\/application\/applySourceTerminationEffect\.ts|services\/task\.ts#cancelTask|services\/terminalSweep\.ts/.test(
      value,
    )
  ) {
    return {
      authorityKind: 'control-revision',
      controlSubtype: 'terminal-control',
      revisionPredicate: 'task-lifecycle-cas-and-source-or-terminal-control-fence',
      requiredBrandedProof: 'ExactTerminalControlTuple',
    }
  }
  if (
    /services\/clarify\/seal\.ts|services\/review\.ts#submitReviewDecisionUnlocked|services\/taskQuestionDispatch\.ts|services\/workgroup\/(?:configActions|lifecycle)\.ts/.test(
      value,
    )
  ) {
    return {
      authorityKind: 'control-revision',
      controlSubtype: 'gate-control',
      revisionPredicate: 'task-scoped-decision-transaction-and-row-cas',
      requiredBrandedProof: 'GateDecisionTransaction',
    }
  }
  if (
    /services\/lifecycle\.ts|services\/limits\.ts|services\/recoveryBreaker\.ts|services\/repoCredentials\.ts/.test(
      value,
    )
  ) {
    return {
      authorityKind: 'control-revision',
      controlSubtype: 'continuation-admission',
      revisionPredicate: 'task-lifecycle-or-metadata-cas',
      requiredBrandedProof: 'CanonicalControlTransaction',
    }
  }
  if (
    /services\/humanGateContinuationEffects\.ts#projectWorkspaceRollbackTx|modules\/task-execution\/application\/drive\/gateContinuationEffectStep\.ts#run/.test(
      value,
    )
  ) {
    return {
      authorityKind: 'worker-epoch',
      controlSubtype: null,
      revisionPredicate: 'exact-owned-intent-and-succeeded-effect-receipt',
      requiredBrandedProof: 'OwnershipToken+TaskExecutionEffectReceipt',
    }
  }
  if (
    /services\/(?:runner|scheduler|isolatedAgentRun|commitPushRunner|nodeRunMint|runtimeSessionLease)\.ts|modules\/task-execution\/composition\/(?:nodeMechanics|wrapperMechanics|wrapperRunLifecycle)\.ts|services\/runtime\/(?:opencode|claudeCode)\/(?:sessionCapture|subagentLiveCapture)\.ts|services\/review\.ts#dispatchReviewNodeUnlocked|modules\/collaboration\/infrastructure\/sqliteHumanGateOpenParticipant\.ts#project(?:Review|Clarify)GateOpenTx|services\/workgroup\/rounds\.ts|services\/task\.ts#persistPreparedProjection/.test(
      value,
    )
  ) {
    return {
      authorityKind: 'worker-epoch',
      controlSubtype: null,
      revisionPredicate: 'exact-owner-id-daemon-generation-epoch-and-claimed-state',
      requiredBrandedProof: 'OwnershipToken+OwnedTaskTx',
    }
  }
  if (
    /sqliteTaskExecutionIntent|submitTaskContinuation|submitContinuationIntentTx|services\/task\.ts#startTaskImpl/.test(
      value,
    )
  ) {
    return {
      authorityKind: 'control-revision',
      controlSubtype: 'continuation-admission',
      revisionPredicate: 'expected-task-revision-and-active-intent-unique',
      requiredBrandedProof: 'CanonicalContinuationRequest',
    }
  }
  if (/terminalizeExecutionIntent/.test(value)) {
    return {
      authorityKind: 'control-revision',
      controlSubtype: 'terminal-control',
      revisionPredicate: 'bound-intent-and-decision-revision',
      requiredBrandedProof: 'TerminalControlDecision',
    }
  }
  if (/revoke|markRecoveryRequired|releaseAfterStop/.test(input.callable)) {
    return {
      authorityKind: 'control-revision',
      controlSubtype: 'terminal-control',
      revisionPredicate: 'exact-owner-tuple-state-and-revision',
      requiredBrandedProof: 'VerifiedStopProofOrExactControlTuple',
    }
  }
  if (/sqliteTaskOwnership|sqliteTaskExecutionEffect|processEffectObserver/.test(value)) {
    return {
      authorityKind: 'worker-epoch',
      controlSubtype: null,
      revisionPredicate: 'exact-owner-id-daemon-generation-epoch-and-claimed-state',
      requiredBrandedProof: 'OwnershipToken',
    }
  }
  return null
}

function buildTaskExecutionAuthorityEntries(backend: readonly SourceUnit[]): {
  entries: TaskExecutionAuthorityEntry[]
  unknown: Array<{ file: string; line: number; table: string; callable: string }>
} {
  const entries: TaskExecutionAuthorityEntry[] = []
  const unknown: Array<{ file: string; line: number; table: string; callable: string }> = []
  for (const unit of backend) {
    const visit = (node: ts.Node): void => {
      const table = durableMutationTable(node)
      if (table !== null && TASK_EXECUTION_DURABLE_TABLES.has(table)) {
        const line = unit.source.getLineAndCharacterOfPosition(node.getStart()).line + 1
        const owner = enclosingTopLevelSymbol(unit, node)
        const symbol = owner?.name ?? '$file'
        const callable = nearestCallableName(unit, node)
        const classification = classifyTaskExecutionAuthority({ file: unit.path, callable })
        if (classification === null) {
          unknown.push({ file: unit.path, line, table, callable })
        } else {
          entries.push({
            id: `task-authority:${unit.path}#${line}:${table}`,
            file: unit.path,
            line,
            ownerEntryId: ownerEntryId(unit.path, symbol),
            symbol,
            consumer: callable,
            dataClass: table,
            ...classification,
            allowedTables: [table],
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
  }
  return {
    entries: entries.sort((left, right) => left.id.localeCompare(right.id)),
    unknown: unknown.sort((left, right) =>
      `${left.file}:${left.line}`.localeCompare(`${right.file}:${right.line}`),
    ),
  }
}

const TASK_EXECUTION_CONTROL_GATEWAY_SPECS: readonly Omit<
  TaskExecutionControlGatewayEntry,
  'id' | 'ownerEntryId'
>[] = [
  {
    subtype: 'continuation-admission',
    file: 'packages/backend/src/modules/task-execution/application/submitTaskContinuation.ts',
    symbol: 'submitTaskContinuationTx',
    allowedTables: ['tasks', 'taskExecutionIntents', 'taskExecutionLineageOperationRecords'],
    allowedTransitions: ['business-state->pending', 'intent-absent->pending', 'decision->authorized'],
    revisionPredicate: 'task-lifecycle-event-revision+decision-record-revision',
    requiredBrandedProof: 'CanonicalContinuationRequest',
  },
  {
    subtype: 'terminal-control',
    file: 'packages/backend/src/services/task.ts',
    symbol: 'cancelTask',
    allowedTables: ['tasks', 'taskExecutionOwners', 'taskExecutionIntents'],
    allowedTransitions: ['task->canceled', 'owner-claimed->revoked', 'intent->canceled'],
    revisionPredicate: 'task-lifecycle-event-revision+exact-owner-revision',
    requiredBrandedProof: 'ExactTerminalControlTuple',
  },
  {
    subtype: 'gate-control',
    file: 'packages/backend/src/modules/task-execution/composition/humanGate.ts',
    symbol: 'bindTaskDecisionParticipantInTx',
    allowedTables: ['tasks', 'taskExecutionIntents', 'gate-companion-table'],
    allowedTransitions: ['awaiting-gate->pending', 'intent-absent->pending'],
    revisionPredicate: 'task-lifecycle-event-revision',
    requiredBrandedProof: 'GateDecisionTransaction',
  },
  {
    subtype: 'membership-control',
    file: 'packages/backend/src/services/taskCollab.ts',
    symbol: 'updateTaskMembers',
    allowedTables: ['tasks', 'taskCollaborators'],
    allowedTransitions: ['membership-revision-cas'],
    revisionPredicate: 'task-membership-revision',
    requiredBrandedProof: 'AuthorizedTaskMembershipActor',
  },
  {
    subtype: 'daemon-shutdown',
    file: 'packages/backend/src/services/task.ts',
    symbol: 'markTaskExecutionShutdownSurvivor',
    allowedTables: ['taskExecutionOwners', 'taskExecutionIntents'],
    allowedTransitions: ['claimed->revoked', 'revoked->recovery-required'],
    revisionPredicate: 'exact-owner-tuple-and-revision',
    requiredBrandedProof: 'ExplicitShutdownReason+ExactOwnershipToken',
  },
  {
    subtype: 'recovery-candidate-revoke',
    file: 'packages/backend/src/modules/task-execution/application/recoverTaskExecutions.ts',
    symbol: 'prepareTaskExecutionRecovery',
    allowedTables: ['taskExecutionOwners'],
    allowedTransitions: ['old-daemon-claimed->revoked'],
    revisionPredicate: 'exact-old-owner-revision',
    requiredBrandedProof: 'ExclusiveDaemonLockProof',
  },
]

function buildTaskExecutionControlGateways(
  backend: readonly SourceUnit[],
): { entries: TaskExecutionControlGatewayEntry[]; unknown: string[] } {
  const entries: TaskExecutionControlGatewayEntry[] = []
  const unknown: string[] = []
  for (const spec of TASK_EXECUTION_CONTROL_GATEWAY_SPECS) {
    const unit = backend.find((candidate) => candidate.path === spec.file)
    const symbolExists = unit?.source.statements.some(
      (statement) => declarationName(statement) === spec.symbol,
    )
    if (unit === undefined || symbolExists !== true) {
      unknown.push(`${spec.subtype}:${spec.file}#${spec.symbol}`)
      continue
    }
    entries.push({
      ...spec,
      id: `task-control:${spec.subtype}`,
      ownerEntryId: ownerEntryId(spec.file, spec.symbol),
    })
  }
  return { entries, unknown: unknown.sort() }
}

interface NodeRunInsertSite {
  readonly id: string
  readonly file: string
  readonly line: number
  readonly symbol: string
  readonly ownerEntryId: string
  readonly status: 'canonical-writer' | 'reviewed-dispatch-exception' | 'unreviewed'
  readonly removeAfterWave: 'W2/W7' | null
  readonly guard: 'rfc098-node-run-mint-grep-guard'
}

function buildNodeRunInsertSites(backend: readonly SourceUnit[]): NodeRunInsertSite[] {
  const out: NodeRunInsertSite[] = []
  for (const unit of backend) {
    const lines = unit.text.split('\n')
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'insert' &&
        node.arguments[0] !== undefined &&
        ts.isIdentifier(node.arguments[0]) &&
        node.arguments[0].text === 'nodeRuns'
      ) {
        const line = unit.source.getLineAndCharacterOfPosition(node.getStart()).line + 1
        const owner = enclosingTopLevelSymbol(unit, node)
        const symbol = owner?.name ?? '$file'
        const nearby = lines.slice(Math.max(0, line - 6), line).join('\n')
        const status = unit.path.endsWith('/services/nodeRunMint.ts')
          ? 'canonical-writer'
          : /rfc098-allow-direct-node-run-insert/.test(nearby)
            ? 'reviewed-dispatch-exception'
            : 'unreviewed'
        out.push({
          id: `node-runs-insert:${unit.path}#${line}`,
          file: unit.path,
          line,
          symbol,
          ownerEntryId: ownerEntryId(unit.path, symbol),
          status,
          removeAfterWave: status === 'canonical-writer' ? null : 'W2/W7',
          guard: 'rfc098-node-run-mint-grep-guard',
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
  }
  return out.sort((left, right) => left.id.localeCompare(right.id))
}

const EXTERNAL_EFFECT =
  /\b(?:fetch|spawn|runGit|push|publish|send|upload|download|writeFile|rename|unlink|rm|mkdir|copyFile|webhook|provider)\b/i
const TRANSACTION_CALL = /^(?:dbTx|dbTxSync|runInTransaction|transaction|withTransaction)$/

function enclosingTopLevelSymbol(unit: SourceUnit, node: ts.Node): NamedNode | null {
  const containing = topLevelNamedNodes(unit)
    .filter(
      (item) =>
        item.node.getStart(unit.source) <= node.getStart(unit.source) && item.node.end >= node.end,
    )
    .sort(
      (left, right) =>
        left.node.end -
        left.node.getStart(unit.source) -
        (right.node.end - right.node.getStart(unit.source)),
    )
  return containing[0] ?? null
}

interface TransactionExternalEffect {
  readonly id: string
  readonly file: string
  readonly symbol: string
  readonly line: number
  readonly transactionCallee: string
  readonly ownerEntryId: string
  readonly targetContext: TargetOwner
  readonly effectTokens: readonly string[]
  readonly status: 'clear' | 'co-located-risk'
  readonly finalCriterion: 'commit-intent-then-effect' | 'no-external-effect-observed'
}

function buildTransactionEffects(backend: readonly SourceUnit[]): TransactionExternalEffect[] {
  const out: TransactionExternalEffect[] = []
  for (const unit of backend) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : null
        if (callee !== null && TRANSACTION_CALL.test(callee)) {
          const text = node.getText(unit.source)
          const effectTokens = [...text.matchAll(new RegExp(EXTERNAL_EFFECT.source, 'gi'))]
            .map((match) => match[0]!.toLowerCase())
            .filter((value, index, values) => values.indexOf(value) === index)
            .sort()
          const line = unit.source.getLineAndCharacterOfPosition(node.getStart()).line + 1
          const owner = enclosingTopLevelSymbol(unit, node)
          const symbol = owner?.name ?? '$file'
          out.push({
            id: `tx:${unit.path}#${callee}:${line}`,
            file: unit.path,
            symbol,
            line,
            transactionCallee: callee,
            ownerEntryId: ownerEntryId(unit.path, symbol),
            targetContext: targetContextFor(unit.path, symbol),
            effectTokens,
            status: effectTokens.length === 0 ? 'clear' : 'co-located-risk',
            finalCriterion:
              effectTokens.length === 0
                ? 'no-external-effect-observed'
                : 'commit-intent-then-effect',
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
  }
  return [...new Map(out.map((entry) => [entry.id, entry])).values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )
}

const TASK_EFFECT_OBSERVER_CALLEES = new Set([
  'createCodeHostEffectAttemptObserver',
  'createLocalEffectAttemptObserver',
  'createProcessEffectAttemptObserver',
  'runTaskLocalEffect',
])

interface TaskOwnedEffectEntry {
  readonly id: string
  readonly file: string
  readonly symbol: string
  readonly line: number
  readonly effectKind: string
  readonly operationFamily: 'lineage-slot-stable-action'
  readonly generationPolicy: 'intent-or-node-generation' | 'next-retained-generation'
  readonly journaledBy: string
  readonly attemptPolicy: 'per-act' | 'per-spawn' | 'per-http-send'
  readonly resourceKeySetResolver: 'explicit-multi-resource-set'
  readonly recoveryClass: string
  readonly responseClassifier: string
  readonly transportRetryPolicy: string
  readonly recoveryProbeOrActorReplay: string
  readonly auditRetention: 'effect-attempt-watermark-and-decision'
  readonly ownerEntryId: string
}

function objectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.Expression | null {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || propertyName(property.name) !== name) continue
    return property.initializer
  }
  return null
}

function literalText(expression: ts.Expression | null): string | null {
  return expression !== null && ts.isStringLiteralLike(expression) ? expression.text : null
}

function buildTaskOwnedEffectEntries(backend: readonly SourceUnit[]): {
  entries: TaskOwnedEffectEntry[]
  unknown: Array<{ file: string; line: number; reason: string }>
} {
  const entries: TaskOwnedEffectEntry[] = []
  const unknown: Array<{ file: string; line: number; reason: string }> = []
  for (const unit of backend) {
    // Coordinator internals call one another; the denominator is production
    // act-site registration, not the coordinator's own adapter plumbing.
    if (unit.path.startsWith(`${MODULE_PREFIX}task-execution/application/`)) continue
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        TASK_EFFECT_OBSERVER_CALLEES.has(node.expression.text)
      ) {
        const callee = node.expression.text
        const line = unit.source.getLineAndCharacterOfPosition(node.getStart()).line + 1
        const owner = enclosingTopLevelSymbol(unit, node)
        const symbol = owner?.name ?? '$file'
        const argument = node.arguments[0]
        if (argument === undefined || !ts.isObjectLiteralExpression(argument)) {
          unknown.push({ file: unit.path, line, reason: `${callee} lacks an object-literal policy` })
          ts.forEachChild(node, visit)
          return
        }
        const text = argument.getText(unit.source)
        let effectKind: string | null = null
        if (callee === 'createProcessEffectAttemptObserver') effectKind = 'process'
        else if (callee === 'createCodeHostEffectAttemptObserver') effectKind = 'code-host-mutation'
        else effectKind = literalText(objectProperty(argument, 'kind'))
        if (effectKind === null) {
          unknown.push({ file: unit.path, line, reason: `${callee} has an unclassified effect kind` })
          ts.forEachChild(node, visit)
          return
        }
        if (!/\bresourceKeys\s*:/.test(text)) {
          unknown.push({ file: unit.path, line, reason: `${callee} has no resource-key resolver` })
          ts.forEachChild(node, visit)
          return
        }
        const isProcess = effectKind === 'process'
        const isCodeHost = effectKind === 'code-host-mutation'
        entries.push({
          id: `task-effect:${unit.path}#${line}:${effectKind}`,
          file: unit.path,
          symbol,
          line,
          effectKind,
          operationFamily: 'lineage-slot-stable-action',
          generationPolicy: isCodeHost
            ? 'next-retained-generation'
            : 'intent-or-node-generation',
          journaledBy: callee,
          attemptPolicy: isCodeHost ? 'per-http-send' : isProcess ? 'per-spawn' : 'per-act',
          resourceKeySetResolver: 'explicit-multi-resource-set',
          recoveryClass: isCodeHost
            ? 'action-provider-candidate-matrix'
            : isProcess
              ? 'managed-process-preactivation'
              : 'local-probe-or-actor',
          responseClassifier: isCodeHost
            ? 'http-status-plus-prior-ambiguity'
            : isProcess
              ? 'spawn-receipt-exit-reap'
              : 'applied-or-ambiguous-throw',
          transportRetryPolicy: isCodeHost
            ? 'rfc269-current-method-policy'
            : isProcess
              ? 'no-hidden-respawn'
              : 'caller-explicit-only',
          recoveryProbeOrActorReplay: isCodeHost
            ? 'binding-profile-or-actor-next-generation'
            : isProcess
              ? 'pid-nonce-binary-probe'
              : 'local-probe-or-actor-next-generation',
          auditRetention: 'effect-attempt-watermark-and-decision',
          ownerEntryId: ownerEntryId(unit.path, symbol),
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
  }
  return {
    entries: entries.sort((left, right) => left.id.localeCompare(right.id)),
    unknown: unknown.sort((left, right) =>
      `${left.file}:${left.line}`.localeCompare(`${right.file}:${right.line}`),
    ),
  }
}

const BACKGROUND_NAME =
  /(?:worker|sweep|ticker|timer|heartbeat|poll|reconcile|recover|retention|prune|gc)/i

interface BackgroundEntry {
  readonly id: string
  readonly file: string
  readonly symbol: string
  readonly ownerEntryId: string
  readonly targetContext: TargetOwner
  readonly kind: 'disabled' | 'execution-local' | 'long-running' | 'periodic'
  readonly lifetime: 'daemon' | 'disabled' | 'execution-local'
  readonly managed: boolean
  readonly phase: 'after-ready' | 'before-ready' | 'execution' | 'unknown'
  readonly dependencies: readonly string[]
  readonly lifecycle: {
    readonly start: boolean
    readonly run: boolean
    readonly stop: boolean
    readonly health: boolean
    readonly readiness: boolean
    readonly state: boolean
  }
  readonly finalCriterion: string
}

function buildBackgroundEntries(backend: readonly SourceUnit[]): BackgroundEntry[] {
  const out: BackgroundEntry[] = []
  for (const unit of backend) {
    for (const item of topLevelNamedNodes(unit)) {
      if (!BACKGROUND_NAME.test(item.name)) continue
      if (
        unit.path.endsWith('/platform/background/definitions.ts') ||
        ts.isInterfaceDeclaration(item.node) ||
        ts.isTypeAliasDeclaration(item.node)
      ) {
        continue
      }
      const text = item.node.getText(unit.source)
      const kind = /disabled|no-op|noop/i.test(text + item.name)
        ? 'disabled'
        : /setInterval|setTimeout|sweep|ticker|poll|prune|retention|gc/i.test(text + item.name)
          ? 'periodic'
          : /executor|runtime|task/i.test(text + item.name)
            ? 'execution-local'
            : 'long-running'
      const managed =
        /maintenanceTicker|BackgroundJobDefinition|ManagedWorkerDefinition|register.*(?:job|worker)/i.test(
          text,
        )
      const lifecycle = {
        start: /\bstart\b|create.*(?:worker|timer)|setInterval|setTimeout/i.test(text),
        run: /\brun\b|execute|tick|sweep|poll|reconcile|recover/i.test(text),
        stop: /\bstop\b|dispose|clearInterval|clearTimeout|abort|shutdown/i.test(text),
        health: /\bhealth\b|heartbeat|lastSuccess|lastFailure/i.test(text),
        readiness: /\bready\b|readiness|degraded/i.test(text),
        state: /\bstate\b|status|running|stopped|failed/i.test(text),
      }
      out.push({
        id: `background:${unit.path}#${item.name}`,
        file: unit.path,
        symbol: item.name,
        ownerEntryId: ownerEntryId(unit.path, item.name),
        targetContext: targetContextFor(unit.path, item.name),
        kind,
        lifetime:
          kind === 'disabled'
            ? 'disabled'
            : kind === 'execution-local'
              ? 'execution-local'
              : 'daemon',
        managed,
        phase: /before.*ready|boot/i.test(text)
          ? 'before-ready'
          : /after.*ready|maintenance/i.test(text)
            ? 'after-ready'
            : kind === 'execution-local'
              ? 'execution'
              : 'unknown',
        dependencies: [
          ...new Set(
            [
              ...text.matchAll(
                /\b(?:db|clock|timer|logger|config|runtime|executor|registry|client)\b/gi,
              ),
            ].map((match) => match[0]!.toLowerCase()),
          ),
        ].sort(),
        lifecycle,
        finalCriterion:
          kind === 'disabled'
            ? 'remain disabled or delete'
            : managed
              ? 'managed definition contract'
              : kind === 'execution-local'
                ? 'owner lifecycle'
                : 'W9-B registry',
      })
    }
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === 'setInterval' || node.expression.text === 'setTimeout')
      ) {
        const line = unit.source.getLineAndCharacterOfPosition(node.getStart()).line + 1
        const symbol = `$${node.expression.text}:${line}`
        out.push({
          id: `background:${unit.path}#${symbol}`,
          file: unit.path,
          symbol,
          ownerEntryId: ownerEntryId(unit.path, '$file'),
          targetContext: targetContextFor(unit.path, symbol),
          kind: 'periodic',
          lifetime: 'daemon',
          managed: /maintenanceTicker|timerPort/.test(node.parent.getText(unit.source)),
          phase: /boot|start/i.test(node.parent.getText(unit.source)) ? 'before-ready' : 'unknown',
          dependencies: ['timer'],
          lifecycle: {
            start: true,
            run: true,
            stop: /clearInterval|clearTimeout|dispose|stop/.test(unit.text),
            health: /health|heartbeat|lastSuccess|lastFailure/.test(unit.text),
            readiness: /ready|readiness|degraded/.test(unit.text),
            state: /state|status|running|stopped|failed/.test(unit.text),
          },
          finalCriterion: 'W9-B registry',
        })
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
  }
  const unique = new Map(out.map((entry) => [entry.id, entry]))
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id))
}

interface AmbientWiringEntry {
  readonly id: string
  readonly file: string
  readonly symbol: string
  readonly line: number
  readonly callee: string
  readonly ownerEntryId: string
  readonly targetContext: TargetOwner
  readonly kind: 'global-setter' | 'register-call'
  readonly removeAfterWave: 'W6/W9'
}

const AMBIENT_WIRING_CALL = /^(?:configure|install|register|set)(?:[A-Z].*)$/
const AMBIENT_WIRING_SUBJECT =
  /(?:callback|client|factory|handler|hook|listener|provider|registry|resolver|runtime|transport|worker)/i

function buildAmbientWiringEntries(backend: readonly SourceUnit[]): AmbientWiringEntry[] {
  const out: AmbientWiringEntry[] = []
  for (const unit of backend) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : null
        if (
          callee !== null &&
          AMBIENT_WIRING_CALL.test(callee) &&
          (callee.startsWith('register') || AMBIENT_WIRING_SUBJECT.test(callee))
        ) {
          const line = unit.source.getLineAndCharacterOfPosition(node.getStart()).line + 1
          const owner = enclosingTopLevelSymbol(unit, node)
          const symbol = owner?.name ?? '$file'
          out.push({
            id: `ambient:${unit.path}#${callee}:${line}`,
            file: unit.path,
            symbol,
            line,
            callee,
            ownerEntryId: ownerEntryId(unit.path, symbol),
            targetContext: targetContextFor(unit.path, symbol),
            kind: callee.startsWith('set') ? 'global-setter' : 'register-call',
            removeAfterWave: 'W6/W9',
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
  }
  return [...new Map(out.map((entry) => [entry.id, entry])).values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )
}

interface FacadeEntry {
  readonly id: string
  readonly file: string
  readonly ownerEntryId: string
  readonly targetContext: TargetOwner
  readonly targetLayer: string
  readonly status: 'boundary-facade' | 'legacy-owner'
  readonly boundaryEdgeIds: readonly string[]
  readonly exportedSymbols: readonly string[]
  readonly removeAfterWave: string
}

function buildFacades(
  backend: readonly SourceUnit[],
  observedEdges: readonly ObservedContextEdge[],
): FacadeEntry[] {
  return backend
    .filter((unit) => unit.path.startsWith(`${BACKEND_PREFIX}services/`))
    .map((unit) => {
      const boundaryEdgeIds = observedEdges
        .filter((edge) => edge.fromFile === unit.path || edge.toFile === unit.path)
        .map((edge) => edge.id)
        .sort()
      return {
        id: `facade:${unit.path}`,
        file: unit.path,
        ownerEntryId: ownerEntryId(unit.path, '$file'),
        targetContext: targetContextFor(unit.path),
        targetLayer:
          unit.path === `${BACKEND_PREFIX}services/startTaskDeps.ts`
            ? 'composition'
            : targetLayerFor(unit.path, '$file'),
        status:
          boundaryEdgeIds.length > 0 ? ('boundary-facade' as const) : ('legacy-owner' as const),
        boundaryEdgeIds,
        exportedSymbols: topLevelNamedNodes(unit)
          .filter((entry) => entry.exported)
          .map((entry) => entry.name)
          .sort(),
        removeAfterWave:
          targetContextFor(unit.path) === 'source-control' ? 'W5' : 'W4/W9',
      }
    })
    .sort((left, right) => left.id.localeCompare(right.id))
}

interface ArchitectureException {
  readonly id: string
  readonly rule: string
  readonly fromPath: string
  readonly fromSymbol: string
  readonly fromOwnerEntryId: string
  readonly toPath: string
  readonly toSymbol: string
  readonly toOwnerEntryId: string
  readonly edgeKind: EdgeKind
  readonly owner: string
  readonly why: string
  readonly introducedByRFC: string
  readonly removeAfterWave: string
  readonly expiresOn: string
  readonly mutationTest: string
}

function symbolFromOwnerId(id: string): string {
  return id.slice(id.lastIndexOf('#') + 1)
}

function buildArchitectureExceptions(
  observedEdges: readonly ObservedContextEdge[],
  ownerIds: ReadonlySet<string>,
): ArchitectureException[] {
  const out: ArchitectureException[] = observedEdges
    .filter((edge) => edge.removeAfterWave !== null)
    .map((edge) => ({
      id: `exception:${edge.id}`,
      rule: edge.role,
      fromPath: edge.fromFile,
      fromSymbol: symbolFromOwnerId(edge.fromOwnerEntryId),
      fromOwnerEntryId: edge.fromOwnerEntryId,
      toPath: edge.toFile,
      toSymbol: edge.targetSymbol,
      toOwnerEntryId: edge.toOwnerEntryId,
      edgeKind: edge.edgeKind,
      owner: edge.owner,
      why:
        isRfc332CompatibilityEdge(edge)
          ? 'RFC-332 retains this exact compatibility dependency in composition until its declared owner cutover.'
          : edge.role === 'legacy-inbound'
          ? 'Legacy inbound caller reaches a module boundary before its W4 public use-case cutover.'
          : edge.role === 'legacy-outbound'
            ? 'A module still reaches a legacy implementation before its owner adapter cutover.'
            : 'Current module edge reaches a non-public internal entrypoint and must not become precedent.',
      introducedByRFC: isRfc332CompatibilityEdge(edge)
        ? 'RFC-332'
        : 'pre-RFC-294-current-debt',
      removeAfterWave: edge.removeAfterWave!,
      expiresOn: '2027-12-31',
      mutationTest: 'rfc294-canonical-manifests: exact exception stale/unknown mutation',
    }))

  for (const entry of KNOWN_VIOLATIONS) {
    const fromOwnerEntryId = ownerEntryId(entry.from, '$file')
    const toOwnerEntryId = ownerEntryId(entry.to, '$file')
    if (!ownerIds.has(fromOwnerEntryId) || !ownerIds.has(toOwnerEntryId)) continue
    const identity = `${entry.rule}|${entry.from}|${entry.to}|value`
    out.push({
      id: `exception:depcheck:${digestText(identity).slice('sha256:'.length, 'sha256:'.length + 20)}`,
      rule: entry.rule,
      fromPath: entry.from,
      fromSymbol: '$file',
      fromOwnerEntryId,
      toPath: entry.to,
      toSymbol: '$file',
      toOwnerEntryId,
      edgeKind: 'value',
      owner: entry.owner ?? String(targetContextFor(entry.from)),
      why: entry.why,
      introducedByRFC: 'pre-RFC-294-depcheck-debt',
      removeAfterWave:
        entry.removeWave ??
        /\bW\d(?:-[A-Z0-9]+)?\b/.exec(entry.removeWhen)?.[0] ??
        'RFC-owner-cutover',
      expiresOn: '2027-12-31',
      mutationTest:
        'depcheck exact known/stale/unknown equality + rfc294 exception schema mutation',
    })
  }
  return [...new Map(out.map((entry) => [entry.id, entry])).values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )
}

function sourceDigest(units: readonly SourceUnit[], repoRoot: string): string {
  const extraPaths = ['.dependency-cruiser.cjs', 'scripts/depcheck.ts']
  const parts = units.map((unit) => `${unit.path}\0${digestText(unit.text)}`)
  for (const path of extraPaths) {
    const absolute = resolve(repoRoot, path)
    if (existsSync(absolute)) parts.push(`${path}\0${digestText(readFileSync(absolute, 'utf8'))}`)
  }
  return digestText(parts.sort().join('\n'))
}

function resolvedValueGraph(units: readonly SourceUnit[]): {
  graph: Map<string, Set<string>>
  unresolvedFirstParty: string[]
} {
  const graph = new Map(units.map((unit) => [unit.path, new Set<string>()]))
  const unresolved = new Set<string>()
  for (const unit of units) {
    for (const edge of importEdges(unit).filter((item) => item.kind === 'value')) {
      const target = resolveSpecifier(units, unit.path, edge.specifier)
      if (target !== null) graph.get(unit.path)!.add(target.path)
      else if (
        edge.specifier.startsWith('.') ||
        edge.specifier.startsWith('@/') ||
        edge.specifier.startsWith('@agent-workflow/')
      ) {
        if (/\.(?:css|scss|sass|less|svg|png|jpe?g|gif|webp)$/.test(edge.specifier)) continue
        unresolved.add(`${unit.path} -> ${edge.specifier}`)
      }
    }
  }
  return { graph, unresolvedFirstParty: [...unresolved].sort() }
}

function sccs(graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  let index = 0
  const indices = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const components: string[][] = []
  const visit = (node: string): void => {
    indices.set(node, index)
    low.set(node, index)
    index += 1
    stack.push(node)
    onStack.add(node)
    for (const target of graph.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target)
        low.set(node, Math.min(low.get(node)!, low.get(target)!))
      } else if (onStack.has(target)) {
        low.set(node, Math.min(low.get(node)!, indices.get(target)!))
      }
    }
    if (low.get(node) !== indices.get(node)) return
    const component: string[] = []
    while (stack.length > 0) {
      const current = stack.pop()!
      onStack.delete(current)
      component.push(current)
      if (current === node) break
    }
    if (component.length > 1 || (graph.get(node)?.has(node) ?? false)) {
      components.push(component.sort())
    }
  }
  for (const node of [...graph.keys()].sort()) if (!indices.has(node)) visit(node)
  return components.sort((left, right) => left[0]!.localeCompare(right[0]!))
}

function targetImplementationSccs(): string[][] {
  const graph = new Map<string, Set<string>>()
  for (const context of TARGET_PUBLIC_CONTEXTS) graph.set(context, new Set())
  for (const edge of TARGET_CONTEXT_EDGES.filter(
    (item) => item.role === 'required-implementation',
  )) {
    graph.get(edge.fromContext)!.add(edge.toContext)
  }
  return sccs(graph)
}

export interface CanonicalArtifacts {
  readonly mutationEntrypoints: Record<string, unknown>
  readonly transactionExternalEffects: Record<string, unknown>
  readonly backgroundJobs: Record<string, unknown>
  readonly crossContextImports: Record<string, unknown>
  readonly facades: Record<string, unknown>
  readonly publicSurfaces: Record<string, unknown>
  readonly moduleSymbolOwners: Record<string, unknown>
  readonly report: Record<string, unknown>
}

export function buildCanonicalArtifacts(repoRoot: string): CanonicalArtifacts {
  const backend = backendUnits(repoRoot)
  const shared = packageSrcUnits(repoRoot, 'shared')
  const frontend = packageSrcUnits(repoRoot, 'frontend')
  const allUnits = [...backend, ...shared, ...frontend]
  const owners = buildOwnerEntries(allUnits)
  const observedEdges = observedContextEdges(backend, allUnits, owners)
  const publicSurfaces = buildPublicSurfaces(backend, allUnits, observedEdges)
  const governedFieldSurfaces = buildGovernedFieldSurfaces(allUnits)
  const requiredPorts = buildRequiredPorts(backend, allUnits, observedEdges)
  const mutationEntries = buildMutationEntries(backend)
  const taskExecutionAuthority = buildTaskExecutionAuthorityEntries(backend)
  const taskExecutionControlGateways = buildTaskExecutionControlGateways(backend)
  const nodeRunInsertSites = buildNodeRunInsertSites(backend)
  const transactionEffects = buildTransactionEffects(backend)
  const taskOwnedEffects = buildTaskOwnedEffectEntries(backend)
  const codeHostRecoveryBindings = buildCodeHostRecoveryBindingManifest()
  const backgrounds = buildBackgroundEntries(backend)
  const ambientWiring = buildAmbientWiringEntries(backend)
  const facades = buildFacades(backend, observedEdges)
  const architectureExceptions = buildArchitectureExceptions(
    observedEdges,
    new Set(owners.map((entry) => entry.id)),
  )
  const digest = sourceDigest(allUnits, repoRoot)
  const inbound = inboundBoundaryEdges(backend)
  const outbound = outboundBoundaryEdges(backend)
  const backendGraph = resolvedValueGraph(backend)
  const repoGraph = resolvedValueGraph(allUnits)
  const backendSccs = sccs(backendGraph.graph)
  const repoSccs = sccs(repoGraph.graph)
  const depcheckText = readFileSync(resolve(repoRoot, 'scripts/depcheck.ts'), 'utf8')
  const knownViolations = ledgerEntryCount(depcheckText, 'KNOWN_VIOLATIONS')
  const routeDbEdges = backend.flatMap((unit) =>
    unit.path.startsWith(`${BACKEND_PREFIX}routes/`)
      ? importEdges(unit).filter(
          (edge) => edge.kind === 'value' && edge.specifier.startsWith('@/db/'),
        )
      : [],
  )
  const transportDbEdges = backend.flatMap((unit) =>
    /^packages\/backend\/src\/(?:ws|mcp)\//.test(unit.path)
      ? importEdges(unit).filter(
          (edge) => edge.kind === 'value' && edge.specifier.startsWith('@/db/'),
        )
      : [],
  )
  const appDepsConsumers = backend.filter((unit) =>
    /\bimport\s+(?:type\s+)?\{[^}]*\bAppDeps\b/s.test(unit.text),
  )

  const common = { schemaVersion: 1, sourceDigest: digest }
  const mutationEntrypoints = {
    ...common,
    kind: 'mutation-entrypoints',
    denominator: {
      entries: mutationEntries.length,
      nodeRunInsertSites: nodeRunInsertSites.length,
      unreviewedNodeRunInsertSites: nodeRunInsertSites.filter(
        (entry) => entry.status === 'unreviewed',
      ).length,
    },
    finalCriterion:
      'Every discovered command and write transport is owned and its authority/tx/OCC/audit/event evidence cannot change silently.',
    entries: mutationEntries,
    nodeRunInsertSites,
    taskExecutionAuthorityLedger: {
      denominator: {
        durableWriterSites: taskExecutionAuthority.entries.length,
        unknownAuthoritySites: taskExecutionAuthority.unknown.length,
        controlSubtypes: taskExecutionControlGateways.entries.length,
        unknownControlSubtypes: taskExecutionControlGateways.unknown.length,
      },
      finalCriterion:
        'Every durable task-execution writer uses exactly one of worker-epoch/control-revision/recovery-proof/terminal-maintenance, and all six control subtypes retain explicit write and proof bounds.',
      entries: taskExecutionAuthority.entries,
      unknown: taskExecutionAuthority.unknown,
      controlGateways: taskExecutionControlGateways.entries,
      unknownControlGateways: taskExecutionControlGateways.unknown,
    },
  }
  const transactionExternalEffects = {
    ...common,
    kind: 'transaction-external-effects',
    denominator: {
      transactionCallbacks: transactionEffects.length,
      coLocatedCandidates: transactionEffects.filter((entry) => entry.status === 'co-located-risk')
        .length,
    },
    finalCriterion:
      'Every transaction callback is inventoried; external effects are emitted only after a committed intent and the risky subset may only shrink.',
    entries: transactionEffects,
    taskExecutionEffectLedger: {
      denominator: {
        registeredActSites: taskOwnedEffects.entries.length,
        unknownActSites: taskOwnedEffects.unknown.length,
        codeHostBindings: codeHostRecoveryBindings.length,
        unknownCodeHostBindings:
          validateCodeHostRecoveryBindingManifest(codeHostRecoveryBindings).length,
      },
      finalCriterion:
        'Every task-owned FS/Git/process/code-host act is registered before act with an operation family, generation, attempt, full resource set, recovery profile and retained audit.',
      entries: taskOwnedEffects.entries,
      unknown: taskOwnedEffects.unknown,
      codeHostBindings: codeHostRecoveryBindings,
    },
  }
  const backgroundJobs = {
    ...common,
    kind: 'background-jobs',
    denominator: {
      entries: backgrounds.length,
      periodic: backgrounds.filter((entry) => entry.kind === 'periodic').length,
      longRunning: backgrounds.filter((entry) => entry.kind === 'long-running').length,
      executionLocal: backgrounds.filter((entry) => entry.kind === 'execution-local').length,
      disabled: backgrounds.filter((entry) => entry.kind === 'disabled').length,
      managed: backgrounds.filter((entry) => entry.managed).length,
      ambientWiring: ambientWiring.length,
    },
    finalCriterion:
      'Periodic and long-running work is registered with phase/dependency/readiness/state/stop ownership; execution-local work follows its aggregate lifecycle.',
    definitionContract: {
      file: 'packages/backend/src/platform/background/definitions.ts',
      periodic: 'BackgroundJobDefinition',
      longRunning: 'ManagedWorkerDefinition',
      requiredLifecycleFields: [
        'dependencies',
        'health',
        'owner',
        'phase',
        'readiness',
        'run',
        'start',
        'state',
        'stop',
      ],
    },
    entries: backgrounds,
    ambientWiringEntries: ambientWiring,
  }
  const crossContextImports = {
    ...common,
    kind: 'cross-context-imports',
    denominator: {
      observedEdges: observedEdges.length,
      targetEdges: TARGET_CONTEXT_EDGES.length,
      requiredPorts: requiredPorts.length,
      architectureExceptions: architectureExceptions.length,
      implementationSccs: targetImplementationSccs().length,
    },
    finalCriterion:
      'Observed imports, offered/required/authority target edges and required-port liveness remain exact, referentially complete and role-preserving.',
    targetEdges: TARGET_CONTEXT_EDGES,
    observedEdges,
    requiredPorts,
    architectureExceptions,
    implementationSccs: targetImplementationSccs(),
  }
  const facadeManifest = {
    ...common,
    kind: 'facades',
    denominator: {
      serviceFiles: facades.length,
      boundaryFacades: facades.filter((entry) => entry.status === 'boundary-facade').length,
    },
    finalCriterion:
      'Every legacy service file has one target owner/layer and every boundary facade has exact consumers and a removal wave.',
    entries: facades,
  }
  const publicSurfaceManifest = {
    ...common,
    kind: 'public-surfaces',
    denominator: {
      exactEntrypointFiles: backend.filter((unit) => publicLocation(unit.path) !== null).length,
      symbols: publicSurfaces.length,
      consumers: publicSurfaces.reduce((sum, entry) => sum + entry.consumerEdgeIds.length, 0),
      recursiveFields: publicSurfaces.reduce((sum, entry) => sum + entry.fields.length, 0),
      methods: publicSurfaces.reduce((sum, entry) => sum + entry.methods.length, 0),
      opaqueTypeRefs: new Set(publicSurfaces.flatMap((entry) => entry.unresolvedTypeRefs)).size,
      governedFieldSurfaces: governedFieldSurfaces.length,
    },
    finalCriterion:
      'Every exact public symbol has one owner, an API signature digest, a recursive member matrix, an exact consumer allowlist and no unclassified opaque type reference.',
    targetContexts: TARGET_PUBLIC_CONTEXTS,
    opaqueTypeRefAllowlist: PUBLIC_SURFACE_OPAQUE_TYPE_ALLOWLIST,
    governedFieldSurfaces,
    entries: publicSurfaces,
  }
  const moduleSymbolOwners = {
    ...common,
    kind: 'module-symbol-owners',
    denominator: {
      productionFiles: allUnits.length,
      backendFiles: backend.length,
      frontendFiles: frontend.length,
      sharedFiles: shared.length,
      moduleFiles: backend.filter((unit) => unit.path.startsWith(MODULE_PREFIX)).length,
      legacyFiles: backend.filter((unit) => !unit.path.startsWith(MODULE_PREFIX)).length,
      symbolsIncludingFileRoots: owners.length,
    },
    finalCriterion:
      'Every production file and top-level symbol has exactly one current and target context/layer owner; no unassigned bucket exists.',
    entries: owners,
  }
  const report = {
    ...common,
    kind: 'current-architecture-report',
    metrics: {
      backendProductionFiles: backend.length,
      serviceFiles: facades.length,
      moduleFiles: backend.filter((unit) => unit.path.startsWith(MODULE_PREFIX)).length,
      moduleContexts: moduleShapes(repoRoot)
        .filter((shape) => shape.fileCount > 0)
        .map((shape) => ({
          context: shape.context,
          files: shape.fileCount,
        })),
      backendValueSccs: backendSccs,
      repoValueSccs: repoSccs,
      knownViolations,
      routeToDbEdges: routeDbEdges.length,
      transportToDbEdges: transportDbEdges.length,
      appDepsConsumers: appDepsConsumers.map((unit) => unit.path).sort(),
      inboundBoundaryEdges: inbound.length,
      outboundBoundaryEdges: outbound.length,
      backgroundEntries: backgrounds.length,
      ambientWiringEntries: ambientWiring.length,
      nodeRunInsertSites,
      directNativeTimers: backgrounds.filter((entry) => entry.symbol.startsWith('$set')).length,
      directNativeIntervals: backgrounds.filter((entry) => entry.symbol.startsWith('$setInterval'))
        .length,
      directNativeIntervalFiles: [
        ...new Set(
          backgrounds
            .filter((entry) => entry.symbol.startsWith('$setInterval'))
            .map((entry) => entry.file),
        ),
      ].sort(),
      unresolvedFirstParty: repoGraph.unresolvedFirstParty,
    },
    manifestDenominators: {
      mutationEntrypoints: mutationEntries.length,
      nodeRunInsertSites: nodeRunInsertSites.length,
      transactionExternalEffects: transactionEffects.length,
      backgroundJobs: backgrounds.length,
      ambientWiring: ambientWiring.length,
      crossContextImports: observedEdges.length,
      architectureExceptions: architectureExceptions.length,
      facades: facades.length,
      publicSurfaces: publicSurfaces.length,
      governedFieldSurfaces: governedFieldSurfaces.length,
      moduleSymbolOwners: owners.length,
    },
  }

  return {
    mutationEntrypoints,
    transactionExternalEffects,
    backgroundJobs,
    crossContextImports,
    facades: facadeManifest,
    publicSurfaces: publicSurfaceManifest,
    moduleSymbolOwners,
    report,
  }
}

function recordArray(value: Record<string, unknown>, key: string): Array<Record<string, unknown>> {
  const raw = value[key]
  return Array.isArray(raw)
    ? raw.filter(
        (entry): entry is Record<string, unknown> =>
          entry !== null && typeof entry === 'object' && !Array.isArray(entry),
      )
    : []
}

export interface GovernanceArtifacts {
  readonly commonsManifest: Record<string, unknown>
  readonly commonsDebt: Record<string, unknown>
  readonly guardManifest: Record<string, unknown>
  readonly ledgerBaselines: Record<string, unknown>
}

interface N1LedgerSpec {
  readonly id: string
  readonly file: string
  readonly symbol: string
  readonly baseline: number
  readonly why: string
  readonly allowGrowth?: { readonly why: string }
}

function n1LedgerSpecs(artifacts: CanonicalArtifacts): N1LedgerSpec[] {
  const count = (manifest: Record<string, unknown>, symbol: string): number =>
    Array.isArray(manifest[symbol]) ? manifest[symbol].length : 0
  return [
    {
      id: 'rfc294-mutation-entrypoints',
      file: CANONICAL_MANIFEST_PATHS.mutationEntrypoints,
      symbol: 'entries',
      baseline: count(artifacts.mutationEntrypoints, 'entries'),
      why: 'RFC-294 N1：全部命令与写 transport 的 authority/authorization/transaction/fence/audit/event 控制分母；新增或漏枚举必须与 owner 账本同批解释。',
    },
    {
      id: 'rfc294-node-run-insert-sites',
      file: CANONICAL_MANIFEST_PATHS.mutationEntrypoints,
      symbol: 'nodeRunInsertSites',
      baseline: count(artifacts.mutationEntrypoints, 'nodeRunInsertSites'),
      why: 'RFC-294 N1：node_runs INSERT 的 exact single-writer/显式 dispatch 例外分母；任何未登记新写点直接阻断。',
    },
    {
      id: 'rfc294-transaction-callbacks',
      file: CANONICAL_MANIFEST_PATHS.transactionExternalEffects,
      symbol: 'entries',
      baseline: count(artifacts.transactionExternalEffects, 'entries'),
      why: 'RFC-294 N1：全部 transaction callback 及其外部效果候选分母；风险项只能收敛为 commit-intent-then-effect。',
    },
    {
      id: 'rfc294-background-jobs',
      file: CANONICAL_MANIFEST_PATHS.backgroundJobs,
      symbol: 'entries',
      baseline: count(artifacts.backgroundJobs, 'entries'),
      why: 'RFC-294 N1：periodic、long-running、execution-local 与 disabled 后台工作分母；W9 前保持 exact owner 与生命周期判据。',
    },
    {
      id: 'rfc294-ambient-wiring',
      file: CANONICAL_MANIFEST_PATHS.backgroundJobs,
      symbol: 'ambientWiringEntries',
      baseline: count(artifacts.backgroundJobs, 'ambientWiringEntries'),
      why: 'RFC-294 N1：production register/global setter ambient wiring 的 exact 分母；W6/W9 只许随实例化 composition 收敛。',
    },
    {
      id: 'rfc294-cross-context-observed-imports',
      file: CANONICAL_MANIFEST_PATHS.crossContextImports,
      symbol: 'observedEdges',
      baseline: count(artifacts.crossContextImports, 'observedEdges'),
      why: 'RFC-294 N1：backend module↔module 与 module↔legacy 的 symbol-level observed edge 分母；kind/syntax/role 与两端 owner 外键必须闭合。',
    },
    {
      id: 'rfc294-target-context-edges',
      file: CANONICAL_MANIFEST_PATHS.crossContextImports,
      symbol: 'targetEdges',
      baseline: count(artifacts.crossContextImports, 'targetEdges'),
      why: 'RFC-294 N1：design §3.1 offered、required implementation 与 IA authority type-only 三类目标边，角色和合同不可折叠。',
    },
    {
      id: 'rfc294-required-port-liveness',
      file: CANONICAL_MANIFEST_PATHS.crossContextImports,
      symbol: 'requiredPorts',
      baseline: count(artifacts.crossContextImports, 'requiredPorts'),
      why: 'RFC-294 N1：consumer-owned required SPI 的 consumer/provider/composition liveness 与显式迁移债；未分类或 stale symbol 必须红。',
    },
    {
      id: 'rfc294-architecture-exceptions',
      file: CANONICAL_MANIFEST_PATHS.crossContextImports,
      symbol: 'architectureExceptions',
      baseline: count(artifacts.crossContextImports, 'architectureExceptions'),
      why: 'RFC-294 N1：唯一 exact exception schema；每条具名两端 path+symbol、edge kind、owner、到期波次和变异证据，禁止 glob。',
    },
    {
      id: 'rfc294-facades',
      file: CANONICAL_MANIFEST_PATHS.facades,
      symbol: 'entries',
      baseline: count(artifacts.facades, 'entries'),
      why: 'RFC-294 N1：当前 services 文件到 target context/layer 的完整归属与 boundary facade exact edge；不能用 unassigned 桶掩盖 owner。',
    },
    {
      id: 'rfc294-public-surfaces',
      file: CANONICAL_MANIFEST_PATHS.publicSurfaces,
      symbol: 'entries',
      baseline: count(artifacts.publicSurfaces, 'entries'),
      why: 'RFC-294 N1：exact public entrypoint 的 symbol/API digest/method/recursive-field/consumer/authority/tx/data-class matrix。',
    },
    {
      id: 'rfc294-public-surface-opaque-type-allowlist',
      file: 'packages/backend/tests/architecture/rfc294Canonical.ts',
      symbol: 'PUBLIC_SURFACE_OPAQUE_TYPE_ALLOWLIST',
      baseline: PUBLIC_SURFACE_OPAQUE_TYPE_ALLOWLIST.length,
      why: 'RFC-294 N1：递归 public surface 仍无法在仓内解析的精确 opaque type reference；每一项必须有意保留且不得静默扩张。',
    },
    {
      id: 'rfc294-governed-field-surfaces',
      file: CANONICAL_MANIFEST_PATHS.publicSurfaces,
      symbol: 'governedFieldSurfaces',
      baseline: count(artifacts.publicSurfaces, 'governedFieldSurfaces'),
      why: 'RFC-294 N1：TaskCatalog membership 与 DigitalEmployee Case link 两组 edge-neutral field growth 的 owner/writer/consumer/rollback 账本。',
    },
    {
      id: 'rfc294-module-symbol-owners',
      file: CANONICAL_MANIFEST_PATHS.moduleSymbolOwners,
      symbol: 'entries',
      baseline: count(artifacts.moduleSymbolOwners, 'entries'),
      why: 'RFC-294 N1：backend/frontend/shared 每个 production file 与 top-level symbol 的唯一 current/target owner root。',
    },
  ]
}

export function projectGovernanceArtifacts(
  artifacts: CanonicalArtifacts,
  input: GovernanceArtifacts,
): GovernanceArtifacts {
  const sourceDigestValue = String(artifacts.report.sourceDigest)
  const ownerIds = new Set(
    recordArray(artifacts.moduleSymbolOwners, 'entries').map((entry) => String(entry.id)),
  )
  const observedEdges = recordArray(artifacts.crossContextImports, 'observedEdges')
  const facades = recordArray(artifacts.facades, 'entries')

  const commonsManifest = structuredClone(input.commonsManifest)
  commonsManifest.canonicalProjection = {
    sourceDigest: sourceDigestValue,
    ownerManifest: CANONICAL_MANIFEST_PATHS.moduleSymbolOwners,
  }
  commonsManifest.kernels = recordArray(commonsManifest, 'kernels').map((kernel) => ({
    ...kernel,
    canonicalOwnerEntryIds: (Array.isArray(kernel.files) ? kernel.files : [])
      .map((file) => ownerEntryId(String(file), '$file'))
      .filter((id) => ownerIds.has(id))
      .sort(),
  }))

  const commonsDebt = structuredClone(input.commonsDebt)
  commonsDebt.canonicalProjection = {
    sourceDigest: sourceDigestValue,
    importManifest: CANONICAL_MANIFEST_PATHS.crossContextImports,
    facadeManifest: CANONICAL_MANIFEST_PATHS.facades,
    ownerManifest: CANONICAL_MANIFEST_PATHS.moduleSymbolOwners,
  }
  commonsDebt.entries = recordArray(commonsDebt, 'entries').map((entry) => {
    const matching = observedEdges.filter(
      (edge) =>
        edge.fromFile === entry.from &&
        edge.specifier === entry.specifier &&
        edge.edgeKind === entry.edgeKind &&
        edge.syntax === entry.syntax,
    )
    const facadeIds = facades
      .filter((facade) => facade.file === entry.from || facade.file === entry.to)
      .map((facade) => String(facade.id))
      .sort()
    return {
      ...entry,
      canonicalImportEdgeIds: matching.map((edge) => String(edge.id)).sort(),
      canonicalFromOwnerEntryId: ownerEntryId(String(entry.from), '$file'),
      canonicalToOwnerEntryIds: [
        ...new Set(matching.map((edge) => String(edge.toOwnerEntryId))),
      ].sort(),
      canonicalFacadeIds: facadeIds,
    }
  })

  const guardManifest = structuredClone(input.guardManifest)
  guardManifest.canonicalProjection = {
    sourceDigest: sourceDigestValue,
    role: 'supplementary-guard-registry',
    canonicalGuard: 'packages/backend/tests/architecture/rfc294-canonical-manifests.test.ts',
  }

  const ledgerBaselines = structuredClone(input.ledgerBaselines)
  ledgerBaselines.canonicalProjection = {
    sourceDigest: sourceDigestValue,
    manifests: Object.values(CANONICAL_MANIFEST_PATHS).filter(
      (path) => path !== CANONICAL_MANIFEST_PATHS.report,
    ),
  }
  const specs = n1LedgerSpecs(artifacts)
  const existingLedgers = new Map(
    recordArray(ledgerBaselines, 'ledgers').map((entry) => [String(entry.id), entry]),
  )
  const projectedSpecs = specs.map((spec): N1LedgerSpec => {
    const permit = existingLedgers.get(spec.id)?.allowGrowth
    return permit !== null && typeof permit === 'object' && !Array.isArray(permit)
      ? { ...spec, allowGrowth: structuredClone(permit) as { readonly why: string } }
      : spec
  })
  const specIds = new Set(specs.map((entry) => entry.id))
  const retiredN1Ids = new Set(['rfc294-transaction-external-effects'])
  ledgerBaselines.ledgers = [
    ...recordArray(ledgerBaselines, 'ledgers').filter(
      (entry) => !specIds.has(String(entry.id)) && !retiredN1Ids.has(String(entry.id)),
    ),
    ...projectedSpecs,
  ]
  return { commonsManifest, commonsDebt, guardManifest, ledgerBaselines }
}

export function validateCanonicalArtifacts(artifacts: CanonicalArtifacts): string[] {
  const errors: string[] = []
  const manifests = Object.entries(artifacts).filter(([name]) => name !== 'report')
  const digests = new Set(manifests.map(([, manifest]) => manifest.sourceDigest))
  if (digests.size !== 1 || digests.has(undefined)) errors.push('sourceDigest mismatch')

  const owners = recordArray(artifacts.moduleSymbolOwners, 'entries')
  const ownerIds = owners.map((entry) => String(entry.id))
  const ownerSet = new Set(ownerIds)
  if (ownerIds.length !== ownerSet.size) errors.push('duplicate owner entry id')
  if (owners.some((entry) => entry.targetContext === 'unassigned' || entry.targetLayer === '')) {
    errors.push('unassigned owner entry')
  }
  const fileRoots = owners.filter((entry) => entry.symbol === '$file')
  const expectedFiles = Number(
    (artifacts.moduleSymbolOwners.denominator as Record<string, unknown> | undefined)
      ?.productionFiles,
  )
  if (
    fileRoots.length !== expectedFiles ||
    new Set(fileRoots.map((entry) => entry.file)).size !== expectedFiles
  ) {
    errors.push('production file root ownership is not exactly one-to-one')
  }

  const crossObserved = recordArray(artifacts.crossContextImports, 'observedEdges')
  const crossIds = new Set(crossObserved.map((entry) => String(entry.id)))
  for (const edge of crossObserved) {
    if (!ownerSet.has(String(edge.fromOwnerEntryId))) errors.push(`missing from owner: ${edge.id}`)
    if (!ownerSet.has(String(edge.toOwnerEntryId))) errors.push(`missing to owner: ${edge.id}`)
    if (edge.role === 'temporary-internal-debt' && edge.removeAfterWave === null) {
      errors.push(`unowned temporary debt: ${edge.id}`)
    }
  }

  const targetEdges = recordArray(artifacts.crossContextImports, 'targetEdges')
  const targetIds = targetEdges.map((entry) => String(entry.id))
  if (targetIds.length !== new Set(targetIds).size) errors.push('duplicate target edge id')
  if (stableJson(targetEdges) !== stableJson(TARGET_CONTEXT_EDGES)) {
    errors.push('target edge set differs from RFC-294 canonical edge matrix')
  }
  const pairRoles = new Set(
    targetEdges.map(
      (entry) => `${String(entry.fromContext)}->${String(entry.toContext)}:${String(entry.role)}`,
    ),
  )
  if (pairRoles.size !== targetEdges.length - 2) {
    // Two SC required edges intentionally share context+role but retain distinct contract IDs.
    errors.push('target edge role collapsed or duplicated outside the two SC required contracts')
  }

  for (const port of recordArray(artifacts.crossContextImports, 'requiredPorts')) {
    if (!ownerSet.has(String(port.ownerEntryId)))
      errors.push(`missing required-port owner: ${port.id}`)
    if (port.status !== 'active' && port.status !== 'declared-debt') {
      errors.push(`unclassified required port: ${port.id}`)
    }
    for (const ownerIdValue of [
      ...(Array.isArray(port.consumerOwnerEntryIds) ? port.consumerOwnerEntryIds : []),
      ...(Array.isArray(port.compositionOwnerEntryIds) ? port.compositionOwnerEntryIds : []),
    ]) {
      if (!ownerSet.has(String(ownerIdValue))) {
        errors.push(`missing required-port liveness owner: ${port.id}`)
      }
    }
    const providerAdapters = Array.isArray(port.providerAdapters) ? port.providerAdapters : []
    for (const adapter of providerAdapters) {
      if (adapter === null || typeof adapter !== 'object' || Array.isArray(adapter)) {
        errors.push(`invalid required-port provider adapter: ${port.id}`)
        continue
      }
      const value = adapter as Record<string, unknown>
      if (!crossIds.has(String(value.edgeId))) errors.push(`missing required-port edge: ${port.id}`)
      if (!ownerSet.has(String(value.ownerEntryId))) {
        errors.push(`missing required-port adapter owner: ${port.id}`)
      }
    }
    if (
      port.status === 'active' &&
      (!Array.isArray(port.consumerOwnerEntryIds) ||
        port.consumerOwnerEntryIds.length === 0 ||
        providerAdapters.length === 0 ||
        !Array.isArray(port.compositionFiles) ||
        port.compositionFiles.length !== 1)
    ) {
      errors.push(`inactive required port classified active: ${port.id}`)
    }
    if (port.status === 'declared-debt' && port.removeAfterWave === null) {
      errors.push(`unowned required-port debt: ${port.id}`)
    }
  }

  const exceptions = recordArray(artifacts.crossContextImports, 'architectureExceptions')
  const exceptionIds = exceptions.map((entry) => String(entry.id))
  if (exceptionIds.length !== new Set(exceptionIds).size)
    errors.push('duplicate architecture exception id')
  const requiredExceptionFields = [
    'rule',
    'fromPath',
    'fromSymbol',
    'toPath',
    'toSymbol',
    'edgeKind',
    'owner',
    'why',
    'introducedByRFC',
    'removeAfterWave',
    'expiresOn',
    'mutationTest',
  ]
  for (const exception of exceptions) {
    if (
      requiredExceptionFields.some(
        (field) => typeof exception[field] !== 'string' || String(exception[field]).trim() === '',
      )
    ) {
      errors.push(`incomplete architecture exception: ${String(exception.id)}`)
    }
    if (!ownerSet.has(String(exception.fromOwnerEntryId))) {
      errors.push(`missing exception from owner: ${String(exception.id)}`)
    }
    if (!ownerSet.has(String(exception.toOwnerEntryId))) {
      errors.push(`missing exception to owner: ${String(exception.id)}`)
    }
    if (/[?*{}]|\[|\]/.test(String(exception.fromPath) + String(exception.toPath))) {
      errors.push(`non-exact architecture exception path: ${String(exception.id)}`)
    }
  }

  const surfaces = recordArray(artifacts.publicSurfaces, 'entries')
  const surfaceIds = surfaces.map((entry) => String(entry.id))
  if (surfaceIds.length !== new Set(surfaceIds).size) errors.push('duplicate public surface id')
  if (stableJson(artifacts.publicSurfaces.targetContexts) !== stableJson(TARGET_PUBLIC_CONTEXTS)) {
    errors.push('public surface target contexts differ from RFC-294 table')
  }
  const opaqueTypeRefs = [
    ...new Set(
      surfaces.flatMap((surface) =>
        Array.isArray(surface.unresolvedTypeRefs)
          ? surface.unresolvedTypeRefs.map((value) => String(value))
          : [],
      ),
    ),
  ].sort()
  if (stableJson(opaqueTypeRefs) !== stableJson([...PUBLIC_SURFACE_OPAQUE_TYPE_ALLOWLIST].sort())) {
    errors.push('public surface opaque type allowlist mismatch')
  }
  for (const surface of surfaces) {
    if (!ownerSet.has(String(surface.ownerEntryId)))
      errors.push(`missing public owner: ${surface.id}`)
    for (const edgeIdValue of Array.isArray(surface.consumerEdgeIds)
      ? surface.consumerEdgeIds
      : []) {
      if (!crossIds.has(String(edgeIdValue)))
        errors.push(`missing public consumer edge: ${surface.id}`)
    }
    for (const consumer of Array.isArray(surface.productionConsumers)
      ? surface.productionConsumers
      : []) {
      if (
        consumer === null ||
        typeof consumer !== 'object' ||
        Array.isArray(consumer) ||
        !ownerSet.has(String((consumer as Record<string, unknown>).ownerEntryId))
      ) {
        errors.push(`missing public consumer owner: ${String(surface.id)}`)
      }
    }
    if (surface.status === 'legacy-context-debt' && surface.removeAfterWave === null) {
      errors.push(`unowned legacy public surface: ${String(surface.id)}`)
    }
  }

  const governedFields = recordArray(artifacts.publicSurfaces, 'governedFieldSurfaces')
  const governedFieldIds = governedFields.map((entry) => String(entry.id))
  if (governedFieldIds.length !== new Set(governedFieldIds).size) {
    errors.push('duplicate governed field surface id')
  }
  for (const field of governedFields) {
    const anchors = [
      field.owner,
      ...(Array.isArray(field.writers) ? field.writers : []),
      ...(Array.isArray(field.consumers) ? field.consumers : []),
    ]
    if (!Array.isArray(field.consumers) || field.consumers.length === 0) {
      errors.push(`governed field has no consumer: ${String(field.id)}`)
    }
    if (typeof field.rollback !== 'string' || field.rollback.trim() === '') {
      errors.push(`governed field has no rollback: ${String(field.id)}`)
    }
    for (const anchor of anchors) {
      if (anchor === null || typeof anchor !== 'object' || Array.isArray(anchor)) {
        errors.push(`invalid governed field anchor: ${String(field.id)}`)
        continue
      }
      const value = anchor as Record<string, unknown>
      if (!ownerSet.has(String(value.ownerEntryId))) {
        errors.push(`missing governed field owner: ${String(field.id)}`)
      }
      if (typeof value.sourceToken !== 'string' || value.sourceToken.trim() === '') {
        errors.push(`missing governed field source token: ${String(field.id)}`)
      }
    }
  }

  for (const manifestName of [
    'mutationEntrypoints',
    'transactionExternalEffects',
    'backgroundJobs',
    'facades',
  ] as const) {
    const entries = recordArray(artifacts[manifestName], 'entries')
    const ids = entries.map((entry) => String(entry.id))
    if (ids.length !== new Set(ids).size) errors.push(`duplicate ${manifestName} entry id`)
    for (const entry of entries) {
      if (!ownerSet.has(String(entry.ownerEntryId))) {
        errors.push(`missing ${manifestName} owner: ${String(entry.id)}`)
      }
    }
  }

  const taskAuthorityLedger = artifacts.mutationEntrypoints.taskExecutionAuthorityLedger
  if (
    taskAuthorityLedger === null ||
    typeof taskAuthorityLedger !== 'object' ||
    Array.isArray(taskAuthorityLedger)
  ) {
    errors.push('task-execution authority ledger is missing')
  } else {
    const ledger = taskAuthorityLedger as Record<string, unknown>
    const entries = Array.isArray(ledger.entries)
      ? (ledger.entries as Array<Record<string, unknown>>)
      : []
    const unknown = Array.isArray(ledger.unknown) ? ledger.unknown : []
    const gateways = Array.isArray(ledger.controlGateways)
      ? (ledger.controlGateways as Array<Record<string, unknown>>)
      : []
    const unknownGateways = Array.isArray(ledger.unknownControlGateways)
      ? ledger.unknownControlGateways
      : []
    if (entries.length === 0) errors.push('task-execution authority denominator is empty')
    if (unknown.length > 0) errors.push('task-execution authority ledger has unknown writers')
    if (unknownGateways.length > 0) {
      errors.push('task-execution control gateway ledger has unknown subtypes')
    }
    const authorityKinds = new Set(entries.map((entry) => String(entry.authorityKind)))
    for (const kind of [
      'worker-epoch',
      'control-revision',
      'recovery-proof',
      'terminal-maintenance',
    ]) {
      if (!authorityKinds.has(kind)) errors.push(`task-execution authority kind is empty: ${kind}`)
    }
    for (const entry of entries) {
      const id = String(entry.id)
      if (!ownerSet.has(String(entry.ownerEntryId))) {
        errors.push(`missing task-execution authority owner: ${id}`)
      }
      for (const field of [
        'consumer',
        'dataClass',
        'authorityKind',
        'revisionPredicate',
        'requiredBrandedProof',
      ]) {
        if (typeof entry[field] !== 'string' || String(entry[field]).trim() === '') {
          errors.push(`task-execution authority '${id}' lacks ${field}`)
        }
      }
      if (!Array.isArray(entry.allowedTables) || entry.allowedTables.length === 0) {
        errors.push(`task-execution authority '${id}' lacks allowedTables`)
      }
    }
    const gatewaySubtypes = new Set(gateways.map((gateway) => String(gateway.subtype)))
    for (const subtype of [
      'continuation-admission',
      'terminal-control',
      'gate-control',
      'membership-control',
      'daemon-shutdown',
      'recovery-candidate-revoke',
    ]) {
      if (!gatewaySubtypes.has(subtype)) {
        errors.push(`task-execution control subtype is empty: ${subtype}`)
      }
    }
    for (const gateway of gateways) {
      const id = String(gateway.id)
      if (!ownerSet.has(String(gateway.ownerEntryId))) {
        errors.push(`missing task-execution control gateway owner: ${id}`)
      }
      if (!Array.isArray(gateway.allowedTables) || gateway.allowedTables.length === 0) {
        errors.push(`task-execution control gateway '${id}' lacks allowedTables`)
      }
      if (!Array.isArray(gateway.allowedTransitions) || gateway.allowedTransitions.length === 0) {
        errors.push(`task-execution control gateway '${id}' lacks allowedTransitions`)
      }
    }
  }

  const taskEffectLedger = artifacts.transactionExternalEffects.taskExecutionEffectLedger
  if (
    taskEffectLedger === null ||
    typeof taskEffectLedger !== 'object' ||
    Array.isArray(taskEffectLedger)
  ) {
    errors.push('task-execution effect ledger is missing')
  } else {
    const ledger = taskEffectLedger as Record<string, unknown>
    const entries = Array.isArray(ledger.entries)
      ? (ledger.entries as Array<Record<string, unknown>>)
      : []
    const unknown = Array.isArray(ledger.unknown) ? ledger.unknown : []
    const bindings = Array.isArray(ledger.codeHostBindings)
      ? ledger.codeHostBindings
      : []
    if (entries.length === 0) errors.push('task-execution effect denominator is empty')
    if (unknown.length > 0) errors.push('task-execution effect ledger has unknown act sites')
    for (const entry of entries) {
      const id = String(entry.id)
      if (!ownerSet.has(String(entry.ownerEntryId))) {
        errors.push(`missing task-execution effect owner: ${id}`)
      }
      for (const field of [
        'effectKind',
        'operationFamily',
        'generationPolicy',
        'journaledBy',
        'attemptPolicy',
        'resourceKeySetResolver',
        'recoveryClass',
        'responseClassifier',
        'transportRetryPolicy',
        'recoveryProbeOrActorReplay',
        'auditRetention',
      ]) {
        if (typeof entry[field] !== 'string' || String(entry[field]).trim() === '') {
          errors.push(`task-execution effect '${id}' lacks ${field}`)
        }
      }
    }
    for (const bindingError of validateCodeHostRecoveryBindingManifest(
      bindings as Parameters<typeof validateCodeHostRecoveryBindingManifest>[0],
    )) {
      errors.push(`code-host recovery matrix: ${bindingError}`)
    }
  }

  const nodeRunSites = recordArray(artifacts.mutationEntrypoints, 'nodeRunInsertSites')
  if (nodeRunSites.length === 0) errors.push('node_runs INSERT inventory is empty')
  if (nodeRunSites.filter((entry) => entry.status === 'canonical-writer').length !== 1) {
    errors.push('node_runs canonical writer is not unique')
  }
  if (nodeRunSites.some((entry) => entry.status === 'unreviewed')) {
    errors.push('unreviewed node_runs INSERT site')
  }
  for (const site of nodeRunSites) {
    if (!ownerSet.has(String(site.ownerEntryId))) {
      errors.push(`missing node_runs INSERT owner: ${String(site.id)}`)
    }
  }

  for (const ambient of recordArray(artifacts.backgroundJobs, 'ambientWiringEntries')) {
    if (!ownerSet.has(String(ambient.ownerEntryId))) {
      errors.push(`missing ambient wiring owner: ${String(ambient.id)}`)
    }
  }
  if (
    !ownerSet.has(ownerEntryId('packages/backend/src/platform/background/definitions.ts', '$file'))
  ) {
    errors.push('background lifecycle definition contract is missing')
  }

  const implementationSccs = artifacts.crossContextImports.implementationSccs
  if (!Array.isArray(implementationSccs) || implementationSccs.length !== 0) {
    errors.push('required-port implementation graph contains SCC')
  }
  return errors.sort()
}
