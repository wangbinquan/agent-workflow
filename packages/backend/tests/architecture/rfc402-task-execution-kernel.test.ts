import { buildTaskOwnedEffectEntries } from './rfc328TaskExecutionLedger'
// RFC-402: imports and construction sites are checked from source, without loading production.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'
import { createGateCorpus } from './rfc294Gates'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const TE = PREFIX + 'modules/task-execution/'
const KERNEL = TE + 'engine/kernel/'
const SCRIPT = TE + 'engine/node/script/'
const DELETED = [
  'schedulerAssembly',
  'taskWriteLocks',
  'processNodeConcurrency',
  'taskFanoutPools',
  'isolatedAgentRun',
  'nodeIsolation',
  'taskExecutionParticipants',
].map((name) => PREFIX + 'services/' + name + '.ts')
const UNITS = backendUnits(ROOT)

function boundaryViolations(units: readonly SourceUnit[]): string[] {
  const corpus = createGateCorpus(units)
  const violations: string[] = []
  for (const unit of units) {
    if (DELETED.includes(unit.path)) violations.push('deleted-file:' + unit.path)
    if (unit.path.startsWith(SCRIPT) && /\b(?:TaskMechanicsState|legacyArgs)\b/.test(unit.text))
      violations.push('script-bag:' + unit.path)
  }
  for (const edge of corpus.edges) {
    const target = edge.target
    if (DELETED.some((path) => target === path || target === path.replace(/\.ts$/, '')))
      violations.push('deleted-reference:' + edge.from.path)
    if (
      edge.from.path.startsWith(KERNEL) &&
      ![TE + 'domain/', TE + 'application/ports/', KERNEL, PREFIX + 'platform/contracts/'].some(
        (prefix) => target.startsWith(prefix),
      ) &&
      target !== '@agent-workflow/shared' &&
      !target.startsWith('packages/shared/src/') &&
      !target.startsWith('node:')
    )
      violations.push('kernel-import:' + edge.from.path + ' -> ' + target)
    if (
      edge.from.path.startsWith(SCRIPT) &&
      /(?:^|\/)(?:composition|services|infrastructure)\//.test(target)
    )
      violations.push('script-import:' + edge.from.path + ' -> ' + target)
  }
  return violations.sort()
}

function permitViolations(units: readonly SourceUnit[]): string[] {
  const violations: string[] = []
  for (const unit of units) {
    const factoryNames = new Set(['createExecutionPermitRegistry'])
    for (const statement of unit.source.statements) {
      if (ts.isImportDeclaration(statement)) {
        const bindings = statement.importClause?.namedBindings
        if (bindings && ts.isNamedImports(bindings))
          for (const entry of bindings.elements) {
            if ((entry.propertyName ?? entry.name).text === 'createExecutionPermitRegistry')
              factoryNames.add(entry.name.text)
          }
      }
    }
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : ''
        if (factoryNames.has(name) && !unit.path.startsWith(PREFIX + 'bootstrap/'))
          violations.push('registry-construction:' + unit.path)
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
    if (unit.path === KERNEL + 'permits.ts') {
      // All maps and semaphores must be created inside the factory, not in a module initializer.
      const moduleState = (node: ts.Node) => {
        if (ts.isFunctionLike(node)) return
        if (ts.isNewExpression(node) || ts.isCallExpression(node))
          violations.push('module-permit-state:' + unit.path)
        ts.forEachChild(node, moduleState)
      }
      for (const statement of unit.source.statements)
        if (ts.isVariableStatement(statement)) moduleState(statement)
    }
  }
  return violations.sort()
}

test('live corpus: deleted services are absent, kernel imports stay inward, script owns its execution', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  expect(UNITS.filter((unit) => unit.path.startsWith(KERNEL))).toHaveLength(7)
  expect(UNITS.filter((unit) => unit.path.startsWith(SCRIPT))).toHaveLength(4)
  for (const path of DELETED) expect(existsSync(resolve(ROOT, path)), path).toBe(false)
  expect(boundaryViolations(UNITS)).toEqual([])
  expect(permitViolations(UNITS)).toEqual([])
})

test('negative fixtures: every forbidden kernel target and nested script owner is rejected', () => {
  for (const target of [
    'composition/x',
    'infrastructure/x',
    'public/participants',
    'engine/node/script/x',
  ]) {
    const fixture = sourceUnit(
      KERNEL + 'nested/bad.ts',
      `import type { X } from '@/modules/task-execution/${target}'`,
    )
    expect(boundaryViolations([fixture]).some((item) => item.startsWith('kernel-import:'))).toBe(
      true,
    )
  }
  for (const target of ['@/services/x', '@/platform/workspace/local/isolation', 'some-package']) {
    expect(
      boundaryViolations([sourceUnit(KERNEL + 'bad.ts', `export * from '${target}'`)]).length,
    ).toBe(1)
  }
  for (const target of ['composition/x', 'infrastructure/x']) {
    expect(
      boundaryViolations([
        sourceUnit(
          SCRIPT + 'nested/bad.ts',
          `import { x } from '@/modules/task-execution/${target}'`,
        ),
      ]).length,
    ).toBe(1)
  }
  for (const source of [
    "import { x } from '@/services/x'",
    'const state: TaskMechanicsState = x',
    'legacyArgs(state, request)',
  ])
    expect(boundaryViolations([sourceUnit(SCRIPT + 'nested/bad.ts', source)]).length).toBe(1)
})

test('negative fixtures: deleted paths, re-exports, dynamic imports and aliased constructors remain visible', () => {
  for (const path of DELETED) {
    const specifier = '@/' + path.slice(PREFIX.length).replace(/\.ts$/, '')
    expect(boundaryViolations([sourceUnit(path, 'export const x = 1')])).toHaveLength(1)
    for (const text of [
      `import { x } from '${specifier}'`,
      `export * from '${specifier}'`,
      `const x = import('${specifier}')`,
    ])
      expect(boundaryViolations([sourceUnit(TE + 'composition/bad.ts', text)])).toHaveLength(1)
  }
  expect(
    permitViolations([
      sourceUnit(
        TE + 'composition/bad.ts',
        `import { createExecutionPermitRegistry as make } from '../engine/kernel/permits'; const r = make()`,
      ),
    ]),
  ).toHaveLength(1)
  expect(
    permitViolations([sourceUnit(KERNEL + 'permits.ts', 'const locks = new Map()')]),
  ).toHaveLength(1)
  expect(
    permitViolations([
      sourceUnit(
        KERNEL + 'permits.ts',
        'export function createExecutionPermitRegistry() { const locks = new Map(); return locks }',
      ),
    ]),
  ).toEqual([])
  expect(
    permitViolations([
      sourceUnit(
        PREFIX + 'bootstrap/example.ts',
        'const permits = createExecutionPermitRegistry()',
      ),
    ]),
  ).toEqual([])
})

test('script effect census counts the attempt policy once and rejects broken resource forwarding', () => {
  const attemptPath = SCRIPT + 'runOneScriptAttempt.ts'
  const bindingPath = TE + 'composition/scriptNodeExecution.ts'
  const units = UNITS.filter((unit) => [attemptPath, bindingPath].includes(unit.path))
  expect(units).toHaveLength(2)
  const observed = buildTaskOwnedEffectEntries(units)
  expect(observed.unknown).toEqual([])
  expect(observed.entries).toHaveLength(1)
  expect(observed.entries[0]!.file).toBe(attemptPath)
  expect(observed.entries[0]!.symbol).toBe('runOneScriptAttempt')
  const mutated = (path: string, from: string, to: string) =>
    units.map((unit) => (unit.path === path ? sourceUnit(path, unit.text.replace(from, to)) : unit))
  expect(
    buildTaskOwnedEffectEntries(mutated(bindingPath, 'input.resources', '[]')).unknown.length,
  ).toBeGreaterThan(0)
  expect(
    buildTaskOwnedEffectEntries(mutated(bindingPath, 'description.resourceKeys', '[]')).unknown
      .length,
  ).toBeGreaterThan(0)
  expect(
    buildTaskOwnedEffectEntries(
      mutated(attemptPath, 'resources: a.isReadonly', 'missingResources: a.isReadonly'),
    ).unknown.length,
  ).toBeGreaterThan(0)
  expect(
    buildTaskOwnedEffectEntries(
      mutated(
        attemptPath,
        'ports.effect.createProcessEffectAttemptObserver',
        'ports.effect.missingObserver',
      ),
    ).entries,
  ).toEqual([])
})

test('kernel effect census counts isolation create, merge and cleanup once each and rejects a rewritten forwarder', () => {
  const bindingPath = TE + 'infrastructure/executionKernelBinding.ts'
  const paths = [
    KERNEL + 'isolation.ts',
    KERNEL + 'merge.ts',
    KERNEL + 'isolationCleanup.ts',
    bindingPath,
  ]
  const units = UNITS.filter((unit) => paths.includes(unit.path))
  expect(units).toHaveLength(4)
  const sites = (observed: ReturnType<typeof buildTaskOwnedEffectEntries>) =>
    observed.entries
      .map((entry) => `${entry.file.slice(KERNEL.length)}#${entry.symbol}#${entry.effectKind}`)
      .sort()
  const observed = buildTaskOwnedEffectEntries(units)
  expect(observed.unknown).toEqual([])
  expect(sites(observed)).toEqual([
    'isolation.ts#createIsoUnderLock#isolation-create',
    'isolationCleanup.ts#discardNodeIso#workspace-cleanup',
    'merge.ts#mergeBackAndSettle#isolation-merge',
  ])
  const mutated = (path: string, from: string, to: string) =>
    units.map((unit) => {
      if (unit.path !== path) return unit
      expect(unit.text).toContain(from)
      return sourceUnit(path, unit.text.replace(from, to))
    })
  // The forwarder may not set an act-site field, drop the caller's policy or add one of its own.
  for (const broken of [
    mutated(
      bindingPath,
      '{ ...request, persistence: input.effects }',
      "{ ...request, kind: 'isolation-other', persistence: input.effects }",
    ),
    mutated(
      bindingPath,
      '{ ...request, persistence: input.effects }',
      '{ ...other, persistence: input.effects }',
    ),
    mutated(
      bindingPath,
      'persistence: context.persistence.effects,',
      'persistence: context.persistence.effects, resourceKeys: [],',
    ),
  ]) {
    expect(buildTaskOwnedEffectEntries(broken).unknown.length).toBeGreaterThan(0)
  }
  expect(
    buildTaskOwnedEffectEntries(mutated(KERNEL + 'merge.ts', 'resourceKeys: [', 'missingKeys: ['))
      .unknown.length,
  ).toBeGreaterThan(0)
  expect(
    sites(
      buildTaskOwnedEffectEntries(
        mutated(
          KERNEL + 'isolation.ts',
          'args.binding.createLocalEffectAttemptObserver',
          'args.binding.missingObserver',
        ),
      ),
    ),
  ).not.toContain('isolation.ts#createIsoUnderLock#isolation-create')
})
