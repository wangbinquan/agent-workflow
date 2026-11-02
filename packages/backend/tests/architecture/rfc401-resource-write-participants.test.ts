// RFC-401 Part A (design §9): each resource kind is written through one participant in
// `modules/resource-catalog/infrastructure/` — agents (A1), MCP servers and plugins (A2). The ordinary CRUD repository,
// the Intent port and the resource-package arm (and, for agents, the digital-employee template writer) all call it, and
// only the participant imports the kind's row-write program. For agents the dependency-graph check has one write-time
// caller (the participant) plus the public validation query, and Intent's own `agent-runtime-not-found` and the
// package planner's `BundleCycleError` are gone.
// Reads the production sources without importing them.
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'

const ROOT = resolve(import.meta.dir, '../../../..')
const RC = 'packages/backend/src/modules/resource-catalog/'
const INFRA = RC + 'infrastructure/'
const INTENT_PORTS = INFRA + 'aggregateAdapters/intentApplyResourcePorts.ts'
const PACKAGE_ARMS = INFRA + 'aggregateAdapters/postgresqlResourcePackageMutationArms.ts'
const GRAPH = RC + 'domain/agentDependencies.ts'
const GRAPH_QUERY = RC + 'application/agents/agentDependencyValidation.ts'

interface WriteStack {
  readonly kind: string
  readonly participant: string
  readonly factory: string
  /** Module suffix of the kind's row-write program and the atoms only the participant may import. */
  readonly program: string
  readonly programExports: readonly string[]
  /** Exact set: it can only shrink. */
  readonly legacyImporters: readonly string[]
  /** Scene adapters that must hand their writes to the participant. */
  readonly scenes: readonly { readonly path: string; readonly fn: string }[]
}

const STACKS: readonly WriteStack[] = [
  {
    kind: 'agent',
    participant: INFRA + 'agentMutationParticipant.ts',
    factory: 'createAgentMutationParticipant',
    program: '/agentReferenceWrite',
    programExports: [
      'createAgentReferenceWriteParticipant',
      'prepareAgentReferenceUpdate',
      'replaceAgentReferences',
    ],
    // Test-only legacy writers (`createAgent` / `updateAgent`, zero production callers) still replay the write
    // program; RFC-401 Part B (G5) deletes them.
    legacyImporters: [INFRA + 'legacy/agent.ts'],
    scenes: [
      { path: INTENT_PORTS, fn: 'createAgentPort' },
      { path: PACKAGE_ARMS, fn: 'commitPostgresqlAgentPackageMutation' },
      { path: INFRA + 'agentRepository.ts', fn: 'createAgentRepository' },
      {
        path: INFRA + 'digitalEmployeeAgentTemplateCatalog.ts',
        fn: 'createDigitalEmployeeAgentTemplateRepository',
      },
    ],
  },
  {
    kind: 'mcp',
    participant: INFRA + 'mcpMutationParticipant.ts',
    factory: 'createMcpMutationParticipant',
    program: '/mcpPersistence',
    programExports: ['insertMcpRowInTx', 'updateMcpRowInTx'],
    legacyImporters: [],
    scenes: [
      { path: INTENT_PORTS, fn: 'createMcpPort' },
      { path: PACKAGE_ARMS, fn: 'commitPostgresqlMcpPackageMutation' },
      { path: INFRA + 'mcpRepository.ts', fn: 'createMcpRepository' },
    ],
  },
  {
    kind: 'plugin',
    participant: INFRA + 'pluginMutationParticipant.ts',
    factory: 'createPluginMutationParticipant',
    program: '/pluginPersistence',
    programExports: ['insertPluginRowInTx', 'publishPluginRowInTx'],
    legacyImporters: [],
    scenes: [
      { path: INTENT_PORTS, fn: 'createPluginPort' },
      { path: PACKAGE_ARMS, fn: 'commitPostgresqlPluginPackageMutation' },
      { path: INFRA + 'pluginRepository.ts', fn: 'createPluginRepository' },
    ],
  },
]
const UNITS = backendUnits(ROOT)

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

function importedNames(unit: SourceUnit, moduleSuffix: string): string[] {
  const names: string[] = []
  for (const statement of unit.source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.endsWith(moduleSuffix)
    )
      continue
    const bindings = statement.importClause?.namedBindings
    if (bindings !== undefined && ts.isNamedImports(bindings))
      for (const element of bindings.elements)
        names.push((element.propertyName ?? element.name).text)
  }
  return names
}

function calls(node: ts.Node, source: ts.SourceFile, callee: string): boolean {
  let found = false
  walk(node, (inner) => {
    if (ts.isCallExpression(inner) && inner.expression.getText(source) === callee) found = true
  })
  return found
}

export function writeStackViolations(units: readonly SourceUnit[]): string[] {
  const found = new Set<string>()
  for (const unit of units) {
    for (const stack of STACKS) {
      if (unit.path === stack.participant || stack.legacyImporters.includes(unit.path)) continue
      const imported = importedNames(unit, stack.program).filter((name) =>
        stack.programExports.includes(name),
      )
      if (imported.length > 0) found.add(`${stack.kind}-write-program:${unit.path}`)
    }
    const agent = STACKS[0]!
    if (unit.path !== GRAPH && unit.path !== agent.participant && unit.path !== GRAPH_QUERY) {
      if (importedNames(unit, '/agentDependencies').includes('assertAgentDependencyGraph'))
        found.add('graph-check:' + unit.path)
    }
    walk(unit.source, (node) => {
      if (ts.isStringLiteralLike(node) && node.text === 'agent-runtime-not-found')
        found.add('intent-runtime-code:' + unit.path)
      if (ts.isIdentifier(node) && node.text === 'BundleCycleError')
        found.add('bundle-cycle-error:' + unit.path)
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(unit.source) === 'semantics' &&
        ts.isStringLiteralLike(node.initializer) &&
        node.initializer.text === 'intent'
      )
        found.add('intent-graph-semantics:' + unit.path)
    })
  }
  for (const stack of STACKS)
    for (const scene of stack.scenes) {
      const unit = units.find((candidate) => candidate.path === scene.path)
      if (unit === undefined) continue
      let fn: ts.FunctionDeclaration | undefined
      walk(unit.source, (node) => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === scene.fn) fn = node
      })
      if (fn === undefined || !calls(fn, unit.source, stack.factory))
        found.add('scene-bypass:' + scene.fn)
    }
  return [...found].sort()
}

test('live corpus: each kind is written through its one participant', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  for (const path of [
    GRAPH,
    GRAPH_QUERY,
    ...STACKS.flatMap((stack) => [stack.participant, ...stack.legacyImporters]),
  ])
    expect(
      UNITS.some((unit) => unit.path === path),
      path,
    ).toBe(true)
  expect(writeStackViolations(UNITS)).toEqual([])
})

test('negative fixtures over the corpus: each way back is reported', () => {
  const replace = (path: string, edit: (text: string) => string) =>
    UNITS.map((unit) => (unit.path === path ? sourceUnit(path, edit(unit.text)) : unit))
  expect(
    writeStackViolations(
      replace(
        INFRA + 'fusionResourceSeed.ts',
        (text) =>
          "import { createAgentReferenceWriteParticipant } from './agentReferenceWrite'\n" + text,
      ),
    ),
  ).toEqual(['agent-write-program:' + INFRA + 'fusionResourceSeed.ts'])
  expect(
    writeStackViolations(
      replace(
        INFRA + 'mcpRepository.ts',
        (text) => "import { insertMcpRowInTx } from './mcpPersistence'\n" + text,
      ),
    ),
  ).toEqual(['mcp-write-program:' + INFRA + 'mcpRepository.ts'])
  expect(
    writeStackViolations(
      replace(
        PACKAGE_ARMS,
        (text) =>
          "import { assertAgentDependencyGraph } from '../../domain/agentDependencies'\n" + text,
      ),
    ),
  ).toEqual(['graph-check:' + PACKAGE_ARMS])
  expect(
    writeStackViolations(
      replace(INTENT_PORTS, (text) =>
        text.replace(
          'const agents = createAgentMutationParticipant(transaction, { now })',
          'const agents = createIntentAgentWriter(transaction, { now })',
        ),
      ),
    ),
  ).toEqual(['scene-bypass:createAgentPort'])
  expect(
    writeStackViolations(
      replace(INTENT_PORTS, (text) =>
        text.replace(
          'const plugins = createPluginMutationParticipant(transaction, { now })',
          'const plugins = createIntentPluginWriter(transaction, { now })',
        ),
      ),
    ),
  ).toEqual(['scene-bypass:createPluginPort'])
})

test('negative fixtures over fabricated units alone: every matcher still bites', () => {
  const only = (path: string, text: string) => writeStackViolations([sourceUnit(path, text)])
  expect(
    only(INFRA + 'x.ts', "import { replaceAgentReferences } from './agentReferenceWrite'"),
  ).toEqual(['agent-write-program:' + INFRA + 'x.ts'])
  expect(
    only(INFRA + 'x.ts', "import { publishPluginRowInTx } from './pluginPersistence'"),
  ).toEqual(['plugin-write-program:' + INFRA + 'x.ts'])
  expect(only(INFRA + 'x.ts', "throw new ValidationError('agent-runtime-not-found', 'x')")).toEqual(
    ['intent-runtime-code:' + INFRA + 'x.ts'],
  )
  expect(
    only('packages/backend/src/services/bundle/provider.ts', 'export class BundleCycleError {}'),
  ).toEqual(['bundle-cycle-error:packages/backend/src/services/bundle/provider.ts'])
  expect(only(INFRA + 'x.ts', "assertAgentDependencyGraph({ semantics: 'intent' })")).toEqual([
    'intent-graph-semantics:' + INFRA + 'x.ts',
  ])
  // A scene that no longer calls its participant, and scenes that disappeared from the file, are both reported.
  expect(
    only(PACKAGE_ARMS, 'export async function commitPostgresqlMcpPackageMutation() {}'),
  ).toEqual([
    'scene-bypass:commitPostgresqlAgentPackageMutation',
    'scene-bypass:commitPostgresqlMcpPackageMutation',
    'scene-bypass:commitPostgresqlPluginPackageMutation',
  ])
})
