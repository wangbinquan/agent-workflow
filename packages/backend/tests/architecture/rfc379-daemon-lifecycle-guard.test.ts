// RFC-379 / RFC-376 hard gate: the daemon program is the sole lifecycle declaration.
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'
import {
  DAEMON_RUNTIME_JOBS,
  DAEMON_BACKGROUND_JOBS,
  DAEMON_CLOSE_PARTICIPANTS,
} from '../../src/cli/daemonLifecycleProgram'

const PREFIX = 'packages/backend/src/'
const PROGRAM = `${PREFIX}cli/daemonLifecycleProgram.ts`
const ROOTS = new Set(
  [
    'cli/start.ts',
    'bootstrap/daemonApplication.ts',
    'bootstrap/daemonHttpComposition.ts',
    'bootstrap/developmentPurposeRoot.ts',
    'bootstrap/daemonSession.ts',
    'bootstrap/daemonSessionAdapters.ts',
    'server.ts',
    'main.ts',
    'cli/dev.ts',
  ].map((path) => PREFIX + path),
)
const LISTS = new Set([
  'DAEMON_BOOT_STEPS',
  'DAEMON_RUNTIME_JOBS',
  'DAEMON_BACKGROUND_JOBS',
  'DAEMON_CLOSE_PARTICIPANTS',
])
const PROPERTIES = new Set([
  'runtimeFactories',
  'backgroundWriterFactories',
  'providerCloseParticipants',
])
const IDS = new Set<string>(
  [...DAEMON_RUNTIME_JOBS, ...DAEMON_BACKGROUND_JOBS, ...DAEMON_CLOSE_PARTICIPANTS].map(
    ({ id }) => id,
  ),
)
function walk(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}
function literal(node: ts.Node | undefined): string | undefined {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isIdentifier(node))
    ? node.text
    : undefined
}
function unwrap(node: ts.Expression): ts.Expression {
  return ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isParenthesizedExpression(node)
    ? unwrap(node.expression)
    : node
}

export function rootLifecycleLists(units: readonly SourceUnit[]): string[] {
  const violations: string[] = []
  for (const unit of units.filter(({ path }) => ROOTS.has(path)))
    walk(unit.source, (node) => {
      if (
        (ts.isPropertyAssignment(node) ||
          ts.isShorthandPropertyAssignment(node) ||
          ts.isPropertySignature(node)) &&
        PROPERTIES.has(literal(node.name) ?? '')
      )
        violations.push(`${unit.path}: root property ${literal(node.name)}`)
      if (
        ts.isArrayLiteralExpression(node) &&
        node.elements.some((element) => {
          if (IDS.has(literal(element) ?? '')) return true
          return (
            ts.isObjectLiteralExpression(element) &&
            element.properties.some(
              (property) =>
                ts.isPropertyAssignment(property) &&
                literal(property.name) === 'id' &&
                IDS.has(literal(property.initializer) ?? ''),
            )
          )
        })
      )
        violations.push(`${unit.path}: handwritten job array`)
    })
  return violations
}
export function duplicateLifecycleDeclarations(units: readonly SourceUnit[]): string[] {
  const violations: string[] = []
  for (const unit of units)
    walk(unit.source, (node) => {
      if (!ts.isVariableDeclaration(node) || !LISTS.has(literal(node.name) ?? '')) return
      if (unit.path !== PROGRAM) violations.push(`${unit.path}: redeclared ${literal(node.name)}`)
      const array = node.initializer === undefined ? undefined : unwrap(node.initializer)
      if (array === undefined || !ts.isArrayLiteralExpression(array)) return
      const seen = new Set<string>()
      for (const element of array.elements) {
        const property = ts.isObjectLiteralExpression(element)
          ? element.properties.find(
              (entry) => ts.isPropertyAssignment(entry) && literal(entry.name) === 'id',
            )
          : undefined
        const id =
          property !== undefined && ts.isPropertyAssignment(property)
            ? literal(property.initializer)
            : literal(element)
        if (id === undefined) continue
        if (seen.has(id)) violations.push(`${unit.path}: duplicate ${literal(node.name)} id ${id}`)
        seen.add(id)
      }
    })
  return violations
}
export function providerProgramComposition(units: readonly SourceUnit[]): string[] {
  const sites: string[] = []
  for (const unit of units)
    walk(unit.source, (node) => {
      if (!ts.isCallExpression(node) || literal(node.expression) !== 'composeDaemonLifecycle')
        return
      let owner: ts.Node | undefined = node.parent
      while (owner && !ts.isFunctionDeclaration(owner)) owner = owner.parent
      sites.push(
        `${unit.path}::${owner && ts.isFunctionDeclaration(owner) ? owner.name?.text : 'top-level'}`,
      )
    })
  return sites.length === 1 &&
    sites[0] === PREFIX + 'bootstrap/daemonSession.ts::composeDaemonSession'
    ? []
    : [`expected one program in composeDaemonSession, found ${sites.join(', ') || 'none'}`]
}

const ROOT = resolve(import.meta.dir, '../../../..')
const UNITS = backendUnits(ROOT)
const virtual = (text: string, path = PREFIX + 'bootstrap/daemonSession.ts') => [
  sourceUnit(path, text),
]
const compliant = `function composeDaemonSession() { return composeDaemonLifecycle({ runtimeJobs: {}, backgroundJobs: {}, closeParticipants: {} }) }`

describe('RFC-379 daemon lifecycle hard gate', () => {
  test('production corpus is non-vacuous and satisfies all three detections', () => {
    expect(UNITS.length).toBeGreaterThanOrEqual(2000)
    for (const root of ROOTS) expect(UNITS.some(({ path }) => path === root)).toBe(true)
    expect(UNITS.some(({ path }) => path === PROGRAM)).toBe(true)
    expect(rootLifecycleLists(UNITS)).toEqual([])
    expect(duplicateLifecycleDeclarations(UNITS)).toEqual([])
    expect(providerProgramComposition(UNITS)).toEqual([])
  }, 30_000)
  for (const property of PROPERTIES) {
    test(`L1 rejects ${property}, including shorthand and typed properties`, () => {
      for (const text of [
        `const input = { ${property}: [] }`,
        `const input = { ${property} }`,
        `interface Input { ${property}: unknown[] }`,
      ])
        expect(rootLifecycleLists(virtual(text))).toHaveLength(1)
    })
  }
  for (const array of [`['task-execution']`, `[{id: 'maintenance'}]`])
    test(`L1 rejects handwritten jobs ${array}`, () => {
      expect(rootLifecycleLists(virtual(`const jobs = ${array}`))).toHaveLength(1)
    })
  for (const name of LISTS)
    test(`L2 rejects external and duplicate ${name}`, () => {
      expect(
        duplicateLifecycleDeclarations(virtual(`const ${name} = []`, PREFIX + 'other.ts')),
      ).toHaveLength(1)
      for (const values of [`[{id:'x'},{id:'x'}]`, `['x','x']`])
        expect(
          duplicateLifecycleDeclarations(virtual(`const ${name} = ${values} as const`, PROGRAM)),
        ).toHaveLength(1)
    })
  for (const name of ['composeDaemonSession'])
    test(`L3 rejects zero/multiple programs in ${name}`, () => {
      expect(
        providerProgramComposition(
          virtual(compliant.replace(`function ${name}`, 'function unused')),
        ),
      ).toHaveLength(1)
      expect(
        providerProgramComposition(
          virtual(
            compliant.replace(
              `function ${name}() {`,
              `function ${name}() { composeDaemonLifecycle({});`,
            ),
          ),
        ),
      ).toHaveLength(1)
    })
  test('compliant virtual sources allow records, imports and the one declaration', () => {
    expect(rootLifecycleLists(virtual(compliant))).toEqual([])
    expect(providerProgramComposition(virtual(compliant))).toEqual([])
    expect(
      duplicateLifecycleDeclarations([
        ...virtual(`export const DAEMON_RUNTIME_JOBS = [{id:'a'}, {id:'b'}] as const`, PROGRAM),
        ...virtual(`import { DAEMON_RUNTIME_JOBS } from './daemonLifecycleProgram'`),
      ]),
    ).toEqual([])
  })
})
