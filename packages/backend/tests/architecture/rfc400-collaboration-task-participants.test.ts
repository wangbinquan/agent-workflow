// RFC-400: collaboration writes through TE-owned participants; public signatures have no legacy Actor.
// The signature walk covers every public filename, aliases, re-exports and inferred callable results.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, packageSrcUnits, sourceUnit, type SourceUnit } from './census'
import { createGateCorpus, crossContextInternalPairs, resolveImport } from './rfc294Gates'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const COL = PREFIX + 'modules/collaboration/'
const TE = PREFIX + 'modules/task-execution/'
const BRIDGE = PREFIX + 'services/humanGateComposition.ts'
const ACTOR = PREFIX + 'auth/actor.ts'
const UNITS = backendUnits(ROOT)

function boundaryViolations(units: readonly SourceUnit[]) {
  const corpus = createGateCorpus(units)
  const internalPairs = crossContextInternalPairs(corpus).filter(
    (pair) => pair.startsWith(COL) && pair.includes(' -> ' + TE),
  )
  const bridgeReferences = corpus.edges
    .filter((edge) => edge.target === BRIDGE || edge.target === BRIDGE.replace(/\.ts$/, ''))
    .map((edge) => `${edge.from.path} -> ${BRIDGE}`)
  const compositionBackEdges = corpus.edges
    .filter(
      (edge) =>
        edge.from.path.startsWith(COL) &&
        edge.from.path !== COL + 'composition.ts' &&
        !edge.from.path.startsWith(COL + 'composition/') &&
        (edge.target === COL + 'composition.ts' || edge.target === COL + 'composition'),
    )
    .map((edge) => `${edge.from.path} -> ${COL}composition.ts`)
  return {
    internalPairs,
    bridgePresent: units.some((unit) => unit.path === BRIDGE),
    bridgeReferences: [...new Set(bridgeReferences)].sort(),
    compositionBackEdges: [...new Set(compositionBackEdges)].sort(),
  }
}

// RFC-400's owner factories are assembly inputs, including L (which opens its own transaction).
// Existing unrelated TE public transaction APIs remain governed by the RFC-294 debt ledger.
const OWNER_FACTORIES = new Map<string, ReadonlySet<string>>([
  [
    TE + 'infrastructure/humanGateTaskParticipants.ts',
    new Set([
      'createTaskNodeStatusEventsParticipantInTx',
      'createHumanGateNodeRunStateParticipantInTx',
      'createTaskDecisionParticipantInTx',
      'createHumanGateNodeRunMintParticipantInTx',
      'createHumanGateTaskTransitionParticipantInTx',
      'createHumanGateNodeRunMintOperations',
    ]),
  ],
  [
    TE + 'infrastructure/taskAuthorization.ts',
    new Set(['createTaskAuthorizationQueries', 'createTaskAuthorizationParticipantInTx']),
  ],
  [TE + 'infrastructure/nodeRunMintParticipant.ts', new Set(['createNodeRunMintParticipantInTx'])],
  [
    TE + 'infrastructure/nodeRunLifecyclePersistence.ts',
    new Set(['DrizzleNodeRunLifecyclePersistence']),
  ],
])

/** A source-only TypeScript program resolves aliases/namespaces without loading any application.
 * Standard library declarations preserve inferred Promise/container results. Explicit type
 * arguments are also walked syntactically, including Pick<Actor, ...> and import('...').Actor. */
function publicSignatureViolations(units: readonly SourceUnit[]) {
  const files = new Map(units.map((unit) => [unit.path, unit]))
  const fileNames = new Set(files.keys())
  const localPath = (path: string) => path.replace(/^\//, '')
  const options: ts.CompilerOptions = { types: [], target: ts.ScriptTarget.Latest }
  const libraryHost = ts.createCompilerHost(options)
  const libraryDirectory = dirname(ts.getDefaultLibFilePath(options))
  const isLibrary = (path: string) =>
    path.startsWith(libraryDirectory + '/lib.') && path.endsWith('.d.ts')
  const host: ts.CompilerHost = {
    getSourceFile: (path, languageVersion) =>
      files.get(localPath(path))?.source ??
      (isLibrary(path) ? libraryHost.getSourceFile(path, languageVersion) : undefined),
    getDefaultLibFileName: () => ts.getDefaultLibFilePath(options),
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getDirectories: () => [],
    fileExists: (path) =>
      files.has(localPath(path)) || (isLibrary(path) && libraryHost.fileExists(path)),
    readFile: (path) =>
      files.get(localPath(path))?.text ??
      (isLibrary(path) ? libraryHost.readFile(path) : undefined),
    getCanonicalFileName: (path) => localPath(path),
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    resolveModuleNames: (names, from) =>
      names.map((name) => {
        const target = resolveImport(localPath(from), name, fileNames)
        return files.has(target)
          ? { resolvedFileName: target, extension: ts.Extension.Ts }
          : undefined
      }),
  }
  const checker = ts.createProgram([...files.keys()], options, host).getTypeChecker()
  const actorLeaks = new Set<string>()
  const constructorLeaks = new Set<string>()
  const visitedDeclarations = new Set<ts.Declaration>()
  const visitedTypes = new Set<ts.Type>()
  const visitedSymbols = new Set<ts.Symbol>()
  let publicExports = 0

  function canonical(symbol: ts.Symbol): ts.Symbol {
    return symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
  }
  function signature(node: ts.SignatureDeclaration, root: string): void {
    for (const parameter of node.parameters) declaration(parameter, root)
    for (const parameter of node.typeParameters ?? []) declaration(parameter, root)
    if (node.type) typeNode(node.type, root)
    else {
      const inferred = checker.getSignatureFromDeclaration(node)
      if (inferred) type(checker.getReturnTypeOfSignature(inferred), root)
    }
  }
  function typeNode(node: ts.Node, root: string): void {
    const reference = ts.isTypeReferenceNode(node)
      ? node.typeName
      : ts.isTypeQueryNode(node)
        ? node.exprName
        : ts.isImportTypeNode(node)
          ? node.qualifier
          : ts.isExpressionWithTypeArguments(node)
            ? node.expression
            : undefined
    if (reference) {
      const resolved = checker.getSymbolAtLocation(reference)
      if (resolved) symbol(resolved, root)
    }
    ts.forEachChild(node, (child) => typeNode(child, root))
  }
  function declaration(node: ts.Declaration, root: string): void {
    if (visitedDeclarations.has(node) || !files.has(localPath(node.getSourceFile().fileName)))
      return
    visitedDeclarations.add(node)
    if (
      node.getSourceFile().fileName === ACTOR &&
      (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) &&
      ['Actor', 'ActorSource'].includes(node.name.text)
    ) {
      actorLeaks.add(`${root} -> ${ACTOR}#${node.name.text}`)
      return
    }
    if (ts.isTypeAliasDeclaration(node)) {
      typeNode(node.type, root)
      for (const parameter of node.typeParameters ?? []) declaration(parameter, root)
    } else if (ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node)) {
      for (const parameter of node.typeParameters ?? []) declaration(parameter, root)
      for (const heritage of node.heritageClauses ?? []) typeNode(heritage, root)
      for (const member of node.members) {
        const hidden =
          ts.canHaveModifiers(member) &&
          ts
            .getModifiers(member)
            ?.some(
              (modifier) =>
                modifier.kind === ts.SyntaxKind.PrivateKeyword ||
                modifier.kind === ts.SyntaxKind.ProtectedKeyword,
            )
        if (!hidden && !(member.name && ts.isPrivateIdentifier(member.name)))
          declaration(member, root)
      }
    } else if (ts.isTypeParameterDeclaration(node)) {
      if (node.constraint) typeNode(node.constraint, root)
      if (node.default) typeNode(node.default, root)
    } else if (ts.isFunctionLike(node)) {
      signature(node, root)
    } else if (
      ts.isVariableDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isParameter(node)
    ) {
      if (node.type) typeNode(node.type, root)
      else type(checker.getTypeAtLocation(node), root)
    } else if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
      type(checker.getTypeAtLocation(node), root)
    }
  }
  function symbol(value: ts.Symbol, root: string): void {
    value = canonical(value)
    if (root.startsWith(TE + 'public/')) {
      for (const node of value.declarations ?? []) {
        const path = localPath(node.getSourceFile().fileName)
        if (OWNER_FACTORIES.get(path)?.has(value.name))
          constructorLeaks.add(`${root} -> ${path}#${value.name}`)
      }
    }
    if (visitedSymbols.has(value)) return
    visitedSymbols.add(value)
    for (const node of value.declarations ?? []) declaration(node, root)
    if (value.flags & ts.SymbolFlags.Module) {
      for (const member of checker.getExportsOfModule(value)) symbol(member, root)
    }
  }
  function type(value: ts.Type, root: string): void {
    if (visitedTypes.has(value)) return
    visitedTypes.add(value)
    if (value.aliasSymbol) symbol(value.aliasSymbol, root)
    if (value.symbol) symbol(value.symbol, root)
    for (const argument of value.aliasTypeArguments ?? []) type(argument, root)
    if (value.isUnionOrIntersection()) for (const item of value.types) type(item, root)
    if (value.flags & ts.TypeFlags.Object) {
      if ((value as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference)
        for (const argument of checker.getTypeArguments(value as ts.TypeReference))
          type(argument, root)
      // Container arguments carry project types. Expanding the library's own methods
      // (Promise.then, Array.map, etc.) would instantiate unbounded recursive generics.
      if (
        value.symbol?.declarations?.length &&
        value.symbol.declarations.every((node) => isLibrary(node.getSourceFile().fileName))
      )
        return
      for (const property of checker.getPropertiesOfType(value)) {
        symbol(property, root)
        const location = property.valueDeclaration ?? property.declarations?.[0]
        if (location) type(checker.getTypeOfSymbolAtLocation(property, location), root)
      }
      for (const call of [...value.getCallSignatures(), ...value.getConstructSignatures()]) {
        if (call.declaration && !ts.isJSDocSignature(call.declaration))
          signature(call.declaration, root)
        for (const parameter of call.getParameters()) {
          symbol(parameter, root)
          const location = parameter.valueDeclaration ?? parameter.declarations?.[0]
          if (location) type(checker.getTypeOfSymbolAtLocation(parameter, location), root)
        }
        type(checker.getReturnTypeOfSignature(call), root)
      }
    }
  }
  function ownerFactory(value: ts.Symbol, seen = new Set<ts.Symbol>()): string | undefined {
    value = canonical(value)
    if (seen.has(value)) return undefined
    seen.add(value)
    for (const node of value.declarations ?? []) {
      const path = localPath(node.getSourceFile().fileName)
      if (OWNER_FACTORIES.get(path)?.has(value.name)) return `${path}#${value.name}`
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const target = checker.getSymbolAtLocation(node.initializer)
        const found = target && ownerFactory(target, seen)
        if (found) return found
      }
    }
    return undefined
  }
  for (const unit of units) {
    if (!/^packages\/backend\/src\/modules\/[^/]+\/public\//.test(unit.path)) continue
    const module = checker.getSymbolAtLocation(unit.source)
    if (!module) continue
    for (const exported of checker.getExportsOfModule(module)) {
      publicExports++
      const root = `${unit.path}#${exported.name}`
      if (unit.path.startsWith(TE)) {
        const owner = ownerFactory(exported)
        if (owner) constructorLeaks.add(`${root} -> ${owner}`)
      }
      symbol(exported, root)
    }
  }
  return {
    publicExports,
    actorLeaks: [...actorLeaks].sort(),
    constructorLeaks: [...constructorLeaks].sort(),
  }
}

const fixture = (path: string, text: string) => sourceUnit(PREFIX + path, text)

test('collaboration has no TE internal imports, retired bridge or composition back-edge', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  expect(boundaryViolations(UNITS)).toEqual({
    internalPairs: [],
    bridgePresent: false,
    bridgeReferences: [],
    compositionBackEdges: [],
  })
  expect(existsSync(resolve(ROOT, BRIDGE))).toBe(false)
  // The exact R1 / R2 ledger (architecture/commons-debt.json) is owned by rfc317-module-boundary;
  // repeating it here would turn this lock red for unrelated edges elsewhere in the tree.
})

test('every public export signature is free of legacy Actor and RFC-400 constructors stay internal', () => {
  const result = publicSignatureViolations([...UNITS, ...packageSrcUnits(ROOT, 'shared')])
  expect(result.publicExports).toBeGreaterThanOrEqual(500)
  expect(result.actorLeaks).toEqual([])
  expect(result.constructorLeaks).toEqual([])
}, 30_000)

test('internal imports, a restored bridge and composition back-edges turn the boundary checks red', () => {
  const units = [
    fixture(
      'modules/collaboration/infrastructure/probe.ts',
      `
      import type { Hidden } from '@/modules/task-execution/application/hidden'
      import { context } from '../composition'
      export { bridge } from '@/services/humanGateComposition'
    `,
    ),
    fixture('modules/task-execution/application/hidden.ts', 'export interface Hidden {}'),
    fixture('modules/collaboration/composition.ts', 'export const context = 1'),
    fixture('services/humanGateComposition.ts', 'export const bridge = 1'),
  ]
  expect(boundaryViolations(units)).toEqual({
    internalPairs: [COL + 'infrastructure/probe.ts -> ' + TE + 'application/hidden.ts'],
    bridgePresent: true,
    bridgeReferences: [COL + 'infrastructure/probe.ts -> ' + BRIDGE],
    compositionBackEdges: [COL + 'infrastructure/probe.ts -> ' + COL + 'composition.ts'],
  })
  expect(
    boundaryViolations(units.filter((unit) => unit.path !== BRIDGE)).bridgeReferences,
  ).toHaveLength(1)
})

test('Actor hidden by aliases, namespace imports and named/star re-exports is detected from every public filename', () => {
  for (const publicFile of [
    'operations',
    'catalog',
    'taskRoutes',
    'participants',
    'queries',
    'commands',
    'events',
    'types',
  ]) {
    for (const signature of [
      'export interface Input { actor: Renamed }',
      'export function invoke(input: { actor: Renamed }): void {}',
      'export const invoke = (actor: Renamed) => actor',
      'declare const actor: Renamed; export async function invoke() { return actor }',
      'declare const actor: Renamed; export const invoke = () => ({ actor })',
      'export type Input = Pick<Renamed, "source">',
      'export type Input = { source: import("../application/barrel").Source }',
      'export type Input = { actor: Namespace.Renamed }',
      'export type { Renamed as Input } from "../application/barrel"',
      'export * from "../application/barrel"',
    ]) {
      const result = publicSignatureViolations([
        fixture(
          'auth/actor.ts',
          'export interface Actor { source: ActorSource }; export type ActorSource = "session"',
        ),
        fixture(
          'modules/probe/application/hidden.ts',
          'export type { Actor as Renamed, ActorSource as Source } from "@/auth/actor"',
        ),
        fixture('modules/probe/application/barrel.ts', 'export * from "./hidden"'),
        fixture(
          `modules/probe/public/${publicFile}.ts`,
          `import type { Renamed } from '../application/barrel'; import type * as Namespace from '../application/barrel'; ${signature}`,
        ),
      ])
      expect(result.publicExports).toBeGreaterThan(0)
      expect(result.actorLeaks.length, `${publicFile}: ${signature}`).toBeGreaterThan(0)
    }
  }
}, 30_000)

test('private implementation annotations do not taint a closed public signature; safe aliases remain safe', () => {
  const result = publicSignatureViolations([
    fixture('auth/actor.ts', 'export interface Actor { userId: string }'),
    fixture(
      'modules/probe/application/impl.ts',
      `
      import type { Actor } from '@/auth/actor'
      export interface Closed { userId: string }
      export function invoke(input: Closed): Closed { const local: Actor = input; return local }
    `,
    ),
    fixture(
      'modules/probe/public/operations.ts',
      'export { invoke as apply } from "../application/impl"',
    ),
  ])
  expect(result.publicExports).toBe(1)
  expect(result.actorLeaks).toEqual([])
})

test('a constructor cannot escape through a renamed public export or a local value alias', () => {
  for (const [file, name, definition] of [
    [
      'humanGateTaskParticipants',
      'createTaskDecisionParticipantInTx',
      'export function createTaskDecisionParticipantInTx(tx: object) { return tx }',
    ],
    [
      'nodeRunMintParticipant',
      'createNodeRunMintParticipantInTx',
      'export function createNodeRunMintParticipantInTx(tx: object) { return tx }',
    ],
    [
      'nodeRunLifecyclePersistence',
      'DrizzleNodeRunLifecyclePersistence',
      'export class DrizzleNodeRunLifecyclePersistence { constructor(db: object) {} }',
    ],
  ] as const) {
    for (const exposed of [
      `export { ${name} as hidden } from "../infrastructure/${file}"`,
      `import { ${name} as factory } from "../infrastructure/${file}"; export const hidden = factory`,
      `export * as hidden from "../infrastructure/${file}"`,
    ]) {
      const result = publicSignatureViolations([
        fixture(`modules/task-execution/infrastructure/${file}.ts`, definition),
        fixture('modules/task-execution/public/queries.ts', exposed),
      ])
      expect(result.constructorLeaks).toEqual([
        `${TE}public/queries.ts#hidden -> ${TE}infrastructure/${file}.ts#${name}`,
      ])
    }
  }
})
