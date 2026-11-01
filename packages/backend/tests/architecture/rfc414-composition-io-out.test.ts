// RFC-414: task-execution composition binds; it does not read or write the database, the filesystem, processes or git
// itself. Complements RFC-376's `composition-forbidden-import-files` (fs / child_process / drizzle reachability) with the
// persistence helpers and git, and pins the infrastructure owners the moved I/O landed in. Reads the production sources
// without importing them.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const TE = PREFIX + 'modules/task-execution/'
const COMPOSITION = TE + 'composition/'
const INFRA = TE + 'infrastructure/'
/** Module specifiers a task-execution composition file may not import (type-only imports included). */
const FORBIDDEN_IMPORTS = [
  /^drizzle-orm(?:\/|$)/,
  /^bun:sqlite$/,
  /^@\/platform\/persistence\/sessionTables$/,
  /^@\/platform\/persistence\/queryHelpers$/,
  /^(?:node:)?fs(?:\/promises)?$/,
  /^(?:node:)?child_process$/,
  /^@\/util\/git$/,
]
/** Calls a composition file may not make. */
const FORBIDDEN_CALLS = ['tablesOf(', 'Bun.spawn(']
/** The infrastructure owners RFC-414 introduced or moved symbols into. */
const OWNERS = new Map([
  ['readTaskStatus', INFRA + 'taskExecutionTaskReads.ts'],
  ['readTaskWorkspaceRef', INFRA + 'taskExecutionTaskReads.ts'],
  ['inspectDigitalEmployeeHumanReviewSnapshot', INFRA + 'digitalEmployeeExecutionReads.ts'],
  ['readDigitalEmployeeExecutionMetadata', INFRA + 'digitalEmployeeExecutionReads.ts'],
  ['runWorkspacePreparationGcPhase', INFRA + 'workspacePreparationGc.ts'],
  ['localActionWorkspaceEntries', INFRA + 'local/localActionWorkspaceEntries.ts'],
  ['countCanonicalFilesChanged', INFRA + 'local/canonicalDelta.ts'],
  ['executeTaskImageExecutionOperation', INFRA + 'crewstation/taskImageExecution.ts'],
  ['TASK_IMAGE_EXECUTION_OPERATIONS', INFRA + 'crewstation/taskImageExecution.ts'],
  ['executeTaskImageArchive', INFRA + 'crewstation/taskImageArchive.ts'],
  ['resolveNativePortContentDetailed', INFRA + 'local/filePortOutputValidation.ts'],
])
const UNITS = backendUnits(ROOT)

function specifiers(unit: SourceUnit): string[] {
  const found: string[] = []
  for (const statement of unit.source.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    )
      found.push(statement.moduleSpecifier.text)
  }
  return found
}

/** A composition file importing a forbidden module or making a forbidden call. */
function compositionIoViolations(units: readonly SourceUnit[]): string[] {
  const found: string[] = []
  for (const unit of units) {
    if (!unit.path.startsWith(COMPOSITION)) continue
    for (const specifier of specifiers(unit))
      if (FORBIDDEN_IMPORTS.some((pattern) => pattern.test(specifier)))
        found.push('import:' + unit.path + ' ' + specifier)
    for (const call of FORBIDDEN_CALLS)
      if (unit.text.includes(call)) found.push('call:' + unit.path + ' ' + call)
  }
  return found.sort()
}

// One AST walk per unit, cached by unit identity: the negative fixtures re-run the owner check over the same live corpus
// (2 × 11 times), and only the replaced or added units are new objects. Without the cache the test walked the whole
// corpus 22 times and ran past the 5 s default on the CI runner (main CI 41350432956, shard 2/44).
const scans = new WeakMap<SourceUnit, readonly string[]>()

function declaredNames(unit: SourceUnit): readonly string[] {
  const cached = scans.get(unit)
  if (cached !== undefined) return cached
  const names: string[] = []
  const visit = (node: ts.Node) => {
    if (
      (ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.name !== undefined &&
      ts.isIdentifier(node.name) &&
      OWNERS.has(node.name.text)
    )
      names.push(node.name.text)
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  scans.set(unit, names)
  return names
}

function ownershipViolations(units: readonly SourceUnit[]): string[] {
  const owners = new Map<string, string[]>()
  for (const unit of units) {
    if (!unit.path.startsWith(PREFIX)) continue
    for (const name of declaredNames(unit))
      owners.set(name, [...(owners.get(name) ?? []), unit.path])
  }
  const found: string[] = []
  for (const [name, owner] of OWNERS) {
    const paths = owners.get(name) ?? []
    if (paths.length !== 1 || paths[0] !== owner) found.push('owner:' + name)
  }
  return found.sort()
}

test('live corpus: task-execution composition does no persistence, filesystem, process or git work', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  expect(UNITS.filter((unit) => unit.path.startsWith(COMPOSITION)).length).toBeGreaterThan(80)
  for (const path of new Set(OWNERS.values()))
    expect(existsSync(resolve(ROOT, path)), path).toBe(true)
  expect(compositionIoViolations(UNITS)).toEqual([])
  expect(ownershipViolations(UNITS)).toEqual([])
})

test('negative fixtures: every forbidden import and call is detected in a composition file only', () => {
  const file = COMPOSITION + 'revived.ts'
  for (const specifier of [
    'drizzle-orm',
    'drizzle-orm/sqlite-core',
    'bun:sqlite',
    '@/platform/persistence/sessionTables',
    '@/platform/persistence/queryHelpers',
    'node:fs',
    'fs',
    'node:fs/promises',
    'node:child_process',
    '@/util/git',
  ]) {
    expect(
      compositionIoViolations([sourceUnit(file, `import { x } from '${specifier}'`)]),
      specifier,
    ).toEqual(['import:' + file + ' ' + specifier])
    expect(
      compositionIoViolations([sourceUnit(file, `export { x } from '${specifier}'`)]),
      specifier,
    ).toEqual(['import:' + file + ' ' + specifier])
    // Outside composition the same import is not this lock's business.
    expect(
      compositionIoViolations([
        sourceUnit(INFRA + 'revived.ts', `import { x } from '${specifier}'`),
      ]),
    ).toEqual([])
  }
  for (const call of FORBIDDEN_CALLS)
    expect(compositionIoViolations([sourceUnit(file, `const x = ${call}db)`)])).toEqual([
      'call:' + file + ' ' + call,
    ])
})

test('negative fixtures: a missing, duplicated or relocated infrastructure owner is detected', () => {
  for (const [name, owner] of OWNERS) {
    expect(ownershipViolations(UNITS.filter((unit) => unit.path !== owner))).toContain(
      'owner:' + name,
    )
    const duplicate = sourceUnit(COMPOSITION + 'duplicate.ts', `export function ${name}() {}`)
    expect(ownershipViolations([...UNITS, duplicate])).toContain('owner:' + name)
  }
  // Corpus-wide checks share the 20 s budget of the other full-corpus architecture scans.
}, 20_000)
