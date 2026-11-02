// RFC-401 A1 (design §9.2): agent rows are written through one participant —
// `modules/resource-catalog/infrastructure/agentMutationParticipant.ts`. The ordinary CRUD repository, the Intent
// agent port, the resource-package agent arm and the digital-employee template writer all call it; the dependency
// graph check has one write-time caller (the participant) plus the public validation query; Intent's own
// `agent-runtime-not-found` and the package planner's `BundleCycleError` are gone.
// Reads the production sources without importing them.
import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'

const ROOT = resolve(import.meta.dir, '../../../..')
const RC = 'packages/backend/src/modules/resource-catalog/'
const PARTICIPANT = RC + 'infrastructure/agentMutationParticipant.ts'
const WRITE_PROGRAM = RC + 'infrastructure/agentReferenceWrite.ts'
const GRAPH = RC + 'domain/agentDependencies.ts'
const GRAPH_QUERY = RC + 'application/agents/agentDependencyValidation.ts'
const INTENT_PORTS = RC + 'infrastructure/aggregateAdapters/intentApplyResourcePorts.ts'
const PACKAGE_ARMS =
  RC + 'infrastructure/aggregateAdapters/postgresqlResourcePackageMutationArms.ts'
const REPOSITORY = RC + 'infrastructure/agentRepository.ts'
const TEMPLATES = RC + 'infrastructure/digitalEmployeeAgentTemplateCatalog.ts'
/**
 * Test-only legacy writers (`createAgent` / `updateAgent` in `legacy/agent.ts`, zero production callers) still
 * replay the write program; RFC-401 Part B (G5) deletes them. Exact set: it can only shrink.
 */
const LEGACY_WRITE_PROGRAM_IMPORTERS = [RC + 'infrastructure/legacy/agent.ts']
const WRITE_PROGRAM_EXPORTS = [
  'createAgentReferenceWriteParticipant',
  'prepareAgentReferenceUpdate',
  'replaceAgentReferences',
]
/** Scene adapters that must hand their agent writes to the participant. */
const SCENES: readonly { readonly path: string; readonly fn: string }[] = [
  { path: INTENT_PORTS, fn: 'createAgentPort' },
  { path: PACKAGE_ARMS, fn: 'commitPostgresqlAgentPackageMutation' },
  { path: REPOSITORY, fn: 'createAgentRepository' },
  { path: TEMPLATES, fn: 'createDigitalEmployeeAgentTemplateRepository' },
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

export function agentWriteViolations(units: readonly SourceUnit[]): string[] {
  const found = new Set<string>()
  for (const unit of units) {
    if (unit.path !== WRITE_PROGRAM && unit.path !== PARTICIPANT) {
      const imported = importedNames(unit, '/agentReferenceWrite').filter((name) =>
        WRITE_PROGRAM_EXPORTS.includes(name),
      )
      if (imported.length > 0 && !LEGACY_WRITE_PROGRAM_IMPORTERS.includes(unit.path))
        found.add('write-program:' + unit.path)
    }
    if (unit.path !== GRAPH && unit.path !== PARTICIPANT && unit.path !== GRAPH_QUERY) {
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
  for (const scene of SCENES) {
    const unit = units.find((candidate) => candidate.path === scene.path)
    if (unit === undefined) continue
    let fn: ts.FunctionDeclaration | undefined
    walk(unit.source, (node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === scene.fn) fn = node
    })
    if (fn === undefined || !calls(fn, unit.source, 'createAgentMutationParticipant'))
      found.add('scene-bypass:' + scene.fn)
  }
  return [...found].sort()
}

test('live corpus: agent rows are written through the one participant', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  for (const path of [
    PARTICIPANT,
    WRITE_PROGRAM,
    GRAPH,
    GRAPH_QUERY,
    ...LEGACY_WRITE_PROGRAM_IMPORTERS,
  ])
    expect(
      UNITS.some((unit) => unit.path === path),
      path,
    ).toBe(true)
  expect(agentWriteViolations(UNITS)).toEqual([])
})

test('negative fixtures over the corpus: each way back is reported', () => {
  const replace = (path: string, edit: (text: string) => string) =>
    UNITS.map((unit) => (unit.path === path ? sourceUnit(path, edit(unit.text)) : unit))
  expect(
    agentWriteViolations(
      replace(
        RC + 'infrastructure/fusionResourceSeed.ts',
        (text) =>
          "import { createAgentReferenceWriteParticipant } from './agentReferenceWrite'\n" + text,
      ),
    ),
  ).toEqual(['write-program:' + RC + 'infrastructure/fusionResourceSeed.ts'])
  expect(
    agentWriteViolations(
      replace(
        PACKAGE_ARMS,
        (text) =>
          "import { assertAgentDependencyGraph } from '../../domain/agentDependencies'\n" + text,
      ),
    ),
  ).toEqual(['graph-check:' + PACKAGE_ARMS])
  expect(
    agentWriteViolations(
      replace(INTENT_PORTS, (text) =>
        text.replace(
          'const agents = createAgentMutationParticipant(transaction, { now })',
          'const agents = createIntentAgentWriter(transaction, { now })',
        ),
      ),
    ),
  ).toEqual(['scene-bypass:createAgentPort'])
})

test('negative fixtures over fabricated units alone: every matcher still bites', () => {
  const only = (path: string, text: string) => agentWriteViolations([sourceUnit(path, text)])
  expect(
    only(
      RC + 'infrastructure/x.ts',
      "import { replaceAgentReferences } from './agentReferenceWrite'",
    ),
  ).toEqual(['write-program:' + RC + 'infrastructure/x.ts'])
  expect(
    only(RC + 'infrastructure/x.ts', "throw new ValidationError('agent-runtime-not-found', 'x')"),
  ).toEqual(['intent-runtime-code:' + RC + 'infrastructure/x.ts'])
  expect(
    only('packages/backend/src/services/bundle/provider.ts', 'export class BundleCycleError {}'),
  ).toEqual(['bundle-cycle-error:packages/backend/src/services/bundle/provider.ts'])
  expect(
    only(RC + 'infrastructure/x.ts', "assertAgentDependencyGraph({ semantics: 'intent' })"),
  ).toEqual(['intent-graph-semantics:' + RC + 'infrastructure/x.ts'])
  expect(
    only(PACKAGE_ARMS, 'export async function commitPostgresqlAgentPackageMutation() {}'),
  ).toEqual(['scene-bypass:commitPostgresqlAgentPackageMutation'])
})
