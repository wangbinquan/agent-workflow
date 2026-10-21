// RFC-386 / RFC-387: the application factory is the only coordinator constructor; legacy entry points are test-only.
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, sourceUnit, type SourceUnit } from './census'

const PREFIX = 'packages/backend/src/'
const FACTORY = 'modules/task-execution/application/drive/taskDriveCoordinatorFactory.ts'
const BUNDLE = 'cli/daemonModules/taskExecution.ts'
const CONSTRUCTION_SITES = [`${FACTORY}#createTaskDriveCoordinatorFactory/coordinatorFor`] as const
const ASSEMBLY_SITES = [
  `${BUNDLE}#composeDaemonTaskExecutionModules`,
  'services/task.ts#composeTestTaskDriveFactory',
]
const TEST_ONLY = [
  'startTask',
  'wakeHumanGateContinuation',
  'resumeDynamicWorkflowExecution',
  'retryRepositoryPreparation',
  'composeTestTaskDriveFactory',
]
const CONSUMERS = [
  'modules/task-execution/infrastructure/childExecutionLaunchOperations.ts',
  'modules/task-execution/infrastructure/childTaskLifecycleParticipant.ts',
] as const

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}

function functionPath(node: ts.Node): string {
  const names: string[] = []
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionDeclaration(parent)) names.unshift(parent.name?.text ?? '<anonymous>')
    else if (ts.isArrowFunction(parent) || ts.isFunctionExpression(parent))
      names.unshift('<callback>')
    else if (ts.isMethodDeclaration(parent)) names.unshift(parent.name.getText())
  }
  return names.join('/')
}

function called(node: ts.Node, name: string): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name
  )
}

export function driveFactoryViolations(units: readonly SourceUnit[]): string[] {
  const errors: string[] = []
  const constructions: string[] = []
  const assemblies: string[] = []
  for (const unit of units) {
    const path = unit.path.slice(PREFIX.length)
    walk(unit.source, (node) => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'DefaultTaskDriveCoordinator'
      )
        constructions.push(`${path}#${functionPath(node)}`)
      if (ts.isIdentifier(node) && node.text === 'createTaskDriveCoordinator')
        errors.push(`${path}: retired coordinator entry`)
      if (path !== 'services/task.ts' && TEST_ONLY.some((name) => called(node, name)))
        errors.push(`${path}: production caller of a test-only entry`)
      if (
        path === 'cli/daemonModules/adapters.ts' &&
        ts.isIdentifier(node) &&
        node.text === 'roomContinuation'
      )
        errors.push(`${path}: room continuation belongs to the session bundle`)
      if (called(node, 'createTaskDriveCoordinatorFactory'))
        assemblies.push(`${path}#${functionPath(node)}`)
    })
  }
  if (JSON.stringify(constructions.sort()) !== JSON.stringify([...CONSTRUCTION_SITES].sort()))
    errors.push(`coordinator constructors differ: ${constructions.join(', ')}`)
  if (JSON.stringify(assemblies.sort()) !== JSON.stringify([...ASSEMBLY_SITES].sort()))
    errors.push(`session factory assemblies differ: ${assemblies.join(', ')}`)
  for (const path of CONSUMERS) {
    const unit = units.find((candidate) => candidate.path === PREFIX + path)
    let profiles = 0
    if (unit)
      walk(unit.source, (node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'coordinatorFor'
        )
          profiles++
      })
    if (profiles !== 1) errors.push(`${path}: expected one drive profile; got ${profiles}`)
  }
  return errors
}

const unit = (path: string, text: string) => sourceUnit(PREFIX + path, text)
function valid(): SourceUnit[] {
  return [
    unit(
      FACTORY,
      'function createTaskDriveCoordinatorFactory() { function coordinatorFor() { return new DefaultTaskDriveCoordinator({}); } }',
    ),
    unit(
      'services/task.ts',
      'function composeTestTaskDriveFactory() { return createTaskDriveCoordinatorFactory({}); }',
    ),
    unit('cli/daemonModules/adapters.ts', 'const adapters = {};'),
    unit(
      BUNDLE,
      'function composeDaemonTaskExecutionModules() { const factory = createTaskDriveCoordinatorFactory({}); }',
    ),
    ...CONSUMERS.map((path) =>
      unit(path, 'function drive() { return factory.coordinatorFor({}); }'),
    ),
  ]
}

describe('RFC-386 coordinator construction inventory', () => {
  test('complete backend corpus has exactly one constructor and no legacy entry callers', () => {
    const units = backendUnits(resolve(import.meta.dir, '../../../..'))
    expect(units.length).toBeGreaterThanOrEqual(2000)
    expect(driveFactoryViolations(units)).toEqual([])
  }, 30_000)

  test('accepts the registered sites and rejects a missing corpus', () => {
    expect(driveFactoryViolations(valid())).toEqual([])
    expect(driveFactoryViolations([])).toHaveLength(4)
  })

  test('rejects missing, duplicated, moved and newly introduced constructors', () => {
    const fixtures = valid()
    expect(driveFactoryViolations(fixtures.slice(1))[0]).toContain(
      'coordinator constructors differ',
    )
    for (const [index, replacement] of [
      [
        0,
        fixtures[0]!.text.replace('return new', 'new DefaultTaskDriveCoordinator({}); return new'),
      ],
      [1, fixtures[1]!.text + 'function another() { return new DefaultTaskDriveCoordinator({}); }'],
      [2, 'function launchPrepared() { return new DefaultTaskDriveCoordinator({}); }'],
      [4, 'function drive() { return new DefaultTaskDriveCoordinator({}); }'],
      [5, 'function drive() { return new DefaultTaskDriveCoordinator({}); }'],
    ] as const) {
      const mutated = [...fixtures]
      mutated[index] = sourceUnit(fixtures[index]!.path, replacement)
      expect(driveFactoryViolations(mutated)[0]).toContain('coordinator constructors differ')
    }
    expect(
      driveFactoryViolations([
        ...fixtures,
        unit('extra.ts', 'new DefaultTaskDriveCoordinator({});'),
      ])[0],
    ).toContain('coordinator constructors differ')
  })

  test('rejects duplicate, per-call or missing session factory assembly', () => {
    for (const replacement of [
      '',
      'function composeDaemonTaskExecutionModules() { createTaskDriveCoordinatorFactory({}); createTaskDriveCoordinatorFactory({}); }',
      'function composeDaemonTaskExecutionModules() { function onRequest() { createTaskDriveCoordinatorFactory({}); } }',
    ]) {
      const fixtures = valid()
      fixtures[3] = unit(BUNDLE, replacement)
      expect(driveFactoryViolations(fixtures)).toEqual([
        expect.stringContaining('session factory assemblies differ'),
      ])
    }
  })

  test('rejects retired entry points, production test-wrapper callers and provider room adapters', () => {
    for (const text of [
      'createTaskDriveCoordinator({})',
      ...TEST_ONLY.map((name) => `${name}({})`),
      'const adapters = { roomContinuation() {} }',
    ]) {
      expect(
        driveFactoryViolations([...valid(), unit('cli/daemonModules/adapters.ts', text)]),
      ).not.toEqual([])
    }
  })

  test('both child entry points must consume a profile exactly once', () => {
    for (const index of [4, 5]) {
      for (const replacement of ['', 'factory.coordinatorFor({}); factory.coordinatorFor({});']) {
        const fixtures = valid()
        fixtures[index] = sourceUnit(fixtures[index]!.path, replacement)
        expect(driveFactoryViolations(fixtures)).toEqual([
          expect.stringContaining('expected one drive profile'),
        ])
      }
    }
  })
})
