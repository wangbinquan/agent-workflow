// RFC-403: structural locks read the production owners without importing executable modules.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'
import { createGateCorpus } from './rfc294Gates'
import {
  buildTaskOwnedEffectEntries,
  classifyTaskExecutionAuthority,
} from './rfc328TaskExecutionLedger'

const ROOT = resolve(import.meta.dir, '../../../..')
const PREFIX = 'packages/backend/src/'
const TE = PREFIX + 'modules/task-execution/'
const NODE = TE + 'engine/node/'
const MECHANICS = TE + 'composition/nodeMechanics.ts'
const COMPOSITION = TE + 'composition/nodeExecution.ts'
const LEAVES = [
  ['code-host-call', 'CodeHostCall', 'runCodeHostCallNode', 'CodeHost'],
  ['input', 'Input', 'runInputNode', 'Input'],
  ['output', 'Output', 'runOutputNode', 'Output'],
  ['review', 'Review', null, 'Review'],
  ['clarify', 'Clarify', 'settleIdleClarify', 'Clarify'],
  ['clarify-cross-agent', 'CrossClarify', 'runCrossClarifyNode', 'CrossClarify'],
] as const
const DELETED = [
  'codeHostCallNodeExecutor',
  'virtualIoNodeExecutors',
  'humanGateNodeExecutors',
].map((name) => NODE + name + '.ts')
const MOVED_BODIES = [
  'runCodeHostCallNode',
  'runInputNode',
  'runOutputNode',
  'runReviewNode',
  'runIdleClarifyNode',
  'runCrossClarifyNode',
]
const HELPERS = new Map([
  ['judgeBranchActivation', TE + 'application/nodeBranchActivation.ts'],
  ['recordSkippedRun', TE + 'application/nodeBranchActivation.ts'],
  ['readPortRowAtFrame', TE + 'application/nodeInputs.ts'],
  ['pickString', TE + 'domain/nodeFields.ts'],
  ['NodeStatusEvents', TE + 'application/ports/nodeExecutionSupport.ts'],
  ['ExecutionDiagnostics', TE + 'application/ports/nodeExecutionSupport.ts'],
])
const UNITS = backendUnits(ROOT)
const isLeaf = (path: string) => LEAVES.some(([key]) => path.startsWith(NODE + key + '/'))

function boundaryViolations(units: readonly SourceUnit[]): string[] {
  const violations: string[] = []
  for (const unit of units) {
    if (DELETED.includes(unit.path)) violations.push('deleted-file:' + unit.path)
    if (
      isLeaf(unit.path) &&
      /\b(?:legacyArgs|TaskMechanicsState|SchedulerState|OneNodeArgs)\b/.test(unit.text)
    )
      violations.push('leaf-bag:' + unit.path)
    if (
      unit.path === MECHANICS &&
      MOVED_BODIES.some((name) => new RegExp(`\\b${name}\\b`).test(unit.text))
    )
      violations.push('legacy-body:' + unit.path)
  }
  for (const edge of createGateCorpus(units).edges) {
    const target = edge.target
    if (DELETED.some((path) => target === path || target === path.replace(/\.ts$/, '')))
      violations.push('deleted-reference:' + edge.from.path)
    if (!isLeaf(edge.from.path)) continue
    const ownDirectory = edge.from.path.slice(0, edge.from.path.lastIndexOf('/') + 1)
    if (
      ![
        TE + 'domain/',
        TE + 'application/',
        TE + 'engine/kernel/',
        NODE + 'shared/',
        ownDirectory,
        PREFIX + 'platform/contracts/',
      ].some((prefix) => target.startsWith(prefix)) &&
      target !== NODE + 'nodeExecutor.ts' &&
      target !== NODE + 'nodeExecutor' &&
      target !== '@agent-workflow/shared' &&
      !target.startsWith('packages/shared/src/') &&
      !target.startsWith('node:')
    )
      violations.push('leaf-import:' + edge.from.path + ' -> ' + target)
  }
  return violations.sort()
}

function ownershipViolations(units: readonly SourceUnit[]): string[] {
  const violations: string[] = []
  const byPath = new Map(units.map((unit) => [unit.path, unit]))
  const composition = (byPath.get(COMPOSITION)?.text ?? '')
    .replace(/\s+/g, '')
    .replace(/,(?=\))/g, '')
  for (const [key, stem, body, binding] of LEAVES) {
    const executorPath =
      NODE + key + '/' + stem[0]!.toLowerCase() + stem.slice(1) + 'NodeExecutor.ts'
    const executor = byPath.get(executorPath)
    if (
      executor === undefined ||
      !executor.text.includes(`class ${stem}NodeExecutor implements NodeExecutor<'${key}'>`) ||
      !executor.text.includes(
        `execute(request: NodeStepRequest<'${key}'>): Promise<NodeStepOutcome>`,
      )
    )
      violations.push('executor-owner:' + key)
    if (
      body !== null &&
      !byPath.get(NODE + key + '/' + body + '.ts')?.text.includes(`export async function ${body}(`)
    )
      violations.push('body-owner:' + key)
    if (!composition.includes(`new${stem}NodeExecutor(create${binding}NodeExecutionPorts(state))`))
      violations.push('explicit-binding:' + key)
  }
  for (const [name, owner] of HELPERS) {
    const found: string[] = []
    for (const unit of units.filter((candidate) => candidate.path.startsWith(TE))) {
      const visit = (node: ts.Node) => {
        if (
          (ts.isFunctionDeclaration(node) ||
            ts.isInterfaceDeclaration(node) ||
            ts.isTypeAliasDeclaration(node) ||
            ts.isVariableDeclaration(node)) &&
          node.name !== undefined &&
          ts.isIdentifier(node.name) &&
          node.name.text === name
        )
          found.push(unit.path)
        if (
          ts.isExportDeclaration(node) &&
          node.exportClause &&
          ts.isNamedExports(node.exportClause) &&
          node.exportClause.elements.some(
            (entry) => entry.name.text === name || entry.propertyName?.text === name,
          )
        )
          violations.push('helper-reexport:' + name)
        ts.forEachChild(node, visit)
      }
      visit(unit.source)
    }
    if (found.length !== 1 || found[0] !== owner) violations.push('helper-owner:' + name)
  }
  return violations.sort()
}

function replaceUnit(units: readonly SourceUnit[], path: string, from: string, to: string) {
  const original = units.find((unit) => unit.path === path)
  if (original === undefined || !original.text.includes(from))
    throw new Error('fixture anchor missing: ' + path + ':' + from)
  return units.map((unit) =>
    unit.path === path ? sourceUnit(path, unit.text.replace(from, to)) : unit,
  )
}

function skippedTransitionEvents(unit: SourceUnit): string[] {
  const events: string[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(unit.source) === 'ports.ledger.transitionNodeRunStatus'
    ) {
      const argument = node.arguments[0]
      const event =
        argument && ts.isObjectLiteralExpression(argument)
          ? argument.properties.find(
              (property) =>
                ts.isPropertyAssignment(property) && property.name.getText(unit.source) === 'event',
            )
          : undefined
      if (
        event &&
        ts.isPropertyAssignment(event) &&
        ts.isObjectLiteralExpression(event.initializer)
      ) {
        const kind = event.initializer.properties.find(
          (property) =>
            ts.isPropertyAssignment(property) && property.name.getText(unit.source) === 'kind',
        )
        if (kind && ts.isPropertyAssignment(kind) && ts.isStringLiteral(kind.initializer))
          events.push(kind.initializer.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(unit.source)
  return events
}

test('live corpus: six executors own their bodies, explicit ports, and unique shared support', () => {
  expect(UNITS.length).toBeGreaterThanOrEqual(2000)
  for (const path of DELETED) expect(existsSync(resolve(ROOT, path)), path).toBe(false)
  expect(boundaryViolations(UNITS)).toEqual([])
  expect(ownershipViolations(UNITS)).toEqual([])
})

test('negative fixtures: every leaf rejects nested bags and imports outside the permitted layers', () => {
  for (const [key] of LEAVES) {
    const file = NODE + key + '/nested/bad.ts'
    for (const name of ['legacyArgs', 'TaskMechanicsState', 'SchedulerState', 'OneNodeArgs'])
      expect(boundaryViolations([sourceUnit(file, `const x: ${name} = input`)])).toContain(
        'leaf-bag:' + file,
      )
    for (const target of [
      '@/services/x',
      '@/modules/task-execution/composition/x',
      '@/modules/task-execution/infrastructure/x',
      '@/modules/task-execution/public/types',
      '@/modules/collaboration/public/participants',
      '@/platform/workspace/local/isolation',
      'unlisted-package',
    ])
      for (const text of [
        `import type { X } from '${target}'`,
        `export * from '${target}'`,
        `const module = import('${target}')`,
      ])
        expect(
          boundaryViolations([sourceUnit(file, text)]).some((item) =>
            item.startsWith('leaf-import:'),
          ),
        ).toBe(true)
  }
})

test('negative fixtures: deleted shells, references and every legacy body are rejected', () => {
  for (const path of DELETED) {
    expect(boundaryViolations([sourceUnit(path, 'export const revived = true')])).toContain(
      'deleted-file:' + path,
    )
    const target = '@/' + path.slice(PREFIX.length).replace(/\.ts$/, '')
    for (const text of [
      `import { X } from '${target}'`,
      `export * from '${target}'`,
      `const shell = import('${target}')`,
    ])
      expect(boundaryViolations([sourceUnit(COMPOSITION, text)])).toContain(
        'deleted-reference:' + COMPOSITION,
      )
  }
  for (const name of MOVED_BODIES)
    expect(boundaryViolations([sourceUnit(MECHANICS, `export function ${name}() {}`)])).toContain(
      'legacy-body:' + MECHANICS,
    )
})

test('negative fixtures: every missing executor, body and explicit binding is detected', () => {
  for (const [key, stem, body, binding] of LEAVES) {
    const executor = NODE + key + '/' + stem[0]!.toLowerCase() + stem.slice(1) + 'NodeExecutor.ts'
    expect(ownershipViolations(UNITS.filter((unit) => unit.path !== executor))).toContain(
      'executor-owner:' + key,
    )
    for (const [from, to] of [
      [`implements NodeExecutor<'${key}'>`, 'implements LegacyExecutor'],
      [`execute(request: NodeStepRequest<'${key}'>)`, 'execute(request: LegacyRequest)'],
    ])
      expect(ownershipViolations(replaceUnit(UNITS, executor, from!, to!))).toContain(
        'executor-owner:' + key,
      )
    if (body !== null)
      expect(
        ownershipViolations(UNITS.filter((unit) => unit.path !== NODE + key + '/' + body + '.ts')),
      ).toContain('body-owner:' + key)
    expect(
      ownershipViolations(
        replaceUnit(
          UNITS,
          COMPOSITION,
          `create${binding}NodeExecutionPorts(state)`,
          'legacyArgs(state, request)',
        ),
      ),
    ).toContain('explicit-binding:' + key)
  }
})

test('all moved leaves and their bindings retain worker classification, without classifying unknown siblings', () => {
  const files = UNITS.filter((unit) => isLeaf(unit.path)).map((unit) => unit.path)
  files.push(
    ...[
      'codeHostNodeExecution',
      'virtualIoNodeExecution',
      'humanGateNodeExecution',
      'nodeBranchActivation',
    ].map((name) => TE + 'composition/' + name + '.ts'),
    TE + 'application/nodeBranchActivation.ts',
  )
  expect(files.length).toBeGreaterThanOrEqual(16)
  for (const file of files) {
    expect(classifyTaskExecutionAuthority({ file, callable: 'execute' })?.authorityKind, file).toBe(
      'worker-epoch',
    )
    const sibling = file.slice(0, file.lastIndexOf('/') + 1) + 'unclassified.ts'
    expect(
      classifyTaskExecutionAuthority({ file: sibling, callable: 'execute' }),
      sibling,
    ).toBeNull()
  }
})

test('the shared skip owner retains its three named transitions and rejects a missing or generic writer', () => {
  const path = TE + 'application/nodeBranchActivation.ts'
  const unit = UNITS.find((candidate) => candidate.path === path)!
  const expected = ['mark-skipped', 'cancel-by-supersede', 'mark-skipped']
  expect(skippedTransitionEvents(unit)).toEqual(expected)
  for (const replacement of ['ports.ledger.set', 'ports.ledger.missingTransition']) {
    const fixture = sourceUnit(
      path,
      unit.text.replace('ports.ledger.transitionNodeRunStatus', replacement),
    )
    expect(skippedTransitionEvents(fixture)).not.toEqual(expected)
  }
  expect(
    skippedTransitionEvents(
      sourceUnit(path, unit.text.replace("kind: 'cancel-by-supersede'", "kind: 'mark-skipped'")),
    ),
  ).not.toEqual(expected)
})

test('negative fixtures: each shared helper rejects missing, duplicate and wrong owners and re-exports', () => {
  for (const [name, owner] of HELPERS) {
    expect(ownershipViolations(UNITS.filter((unit) => unit.path !== owner))).toContain(
      'helper-owner:' + name,
    )
    const extra = sourceUnit(TE + 'application/duplicate.ts', `export function ${name}() {}`)
    expect(ownershipViolations([...UNITS, extra])).toContain('helper-owner:' + name)
    expect(ownershipViolations([...UNITS.filter((unit) => unit.path !== owner), extra])).toContain(
      'helper-owner:' + name,
    )
    expect(
      ownershipViolations([
        ...UNITS,
        sourceUnit(TE + 'application/shim.ts', `export { ${name} } from './owner'`),
      ]),
    ).toContain('helper-reexport:' + name)
  }
})

test('code-host effect census counts the engine act once with retained generation and per-send policy', () => {
  const body = NODE + 'code-host-call/runCodeHostCallNode.ts'
  const binding = TE + 'composition/codeHostNodeExecution.ts'
  const units = UNITS.filter((unit) => [body, binding].includes(unit.path))
  expect(units).toHaveLength(2)
  const observed = buildTaskOwnedEffectEntries(units)
  expect(observed.unknown).toEqual([])
  expect(observed.entries).toHaveLength(1)
  expect(observed.entries[0]).toMatchObject({
    file: body,
    symbol: 'runCodeHostCallNode',
    effectKind: 'code-host-mutation',
    generationPolicy: 'next-retained-generation',
    attemptPolicy: 'per-http-send',
    resourceKeySetResolver: 'explicit-multi-resource-set',
  })
  const observerSpread = 'createCodeHostEffectAttemptObserver({\n          ...input,'
  for (const [path, from, to] of [
    [binding, observerSpread, observerSpread + " action: 'custom',"],
    [binding, observerSpread, observerSpread.replace('...input,', '...other,')],
    [binding, observerSpread, observerSpread + ' extra: true,'],
    [
      binding,
      'context: state.opts.executionContext',
      'missingContext: state.opts.executionContext',
    ],
    [body, 'ports.requests.executeCodeHostCall', 'ports.requests.missingAct'],
    [body, 'resourceKeys: [', 'missingKeys: ['],
    [
      body,
      'initialRetryAuthority: attemptPlan.retryAuthority,',
      'initialRetryAuthority: attemptPlan.retryAuthority, extra: true,',
    ],
  ]) {
    expect(
      buildTaskOwnedEffectEntries(replaceUnit(units, path!, from!, to!)).unknown.length,
      `${path}: ${to}`,
    ).toBeGreaterThan(0)
  }
  expect(
    buildTaskOwnedEffectEntries(
      replaceUnit(
        units,
        body,
        'ports.effects.createCodeHostEffectAttemptObserver',
        'ports.effects.missingObserver',
      ),
    ).entries,
  ).toEqual([])
})
