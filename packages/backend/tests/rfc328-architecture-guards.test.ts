// RFC-328 T25/T28 — source-complete authority guards. Each rule is exercised
// against the real backend corpus and an independent negative fixture so an
// empty glob or inert regex cannot make the architecture gate green.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { backendUnits, type SourceUnit } from './architecture/census'
import { buildCanonicalArtifacts, validateCanonicalArtifacts } from './architecture/rfc294Canonical'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')

type GuardUnit = Pick<SourceUnit, 'path' | 'text' | 'source'>

const WORKER_MUTATION_FILES = new Set([
  'packages/backend/src/services/lifecycle.ts',
  'packages/backend/src/services/nodeRunMint.ts',
  'packages/backend/src/services/runner.ts',
  'packages/backend/src/services/scheduler.ts',
  'packages/backend/src/services/scriptRun.ts',
])
const WORKER_MUTATION_CALLABLES = new Map<string, ReadonlySet<string>>([
  ['packages/backend/src/services/isolatedAgentRun.ts', new Set(['persistPendingSubResolves'])],
  ['packages/backend/src/services/commitPushRunner.ts', new Set(['persistMeta'])],
  ['packages/backend/src/services/review.ts', new Set(['dispatchReviewNodeUnlocked'])],
  [
    'packages/backend/src/services/runtimeSessionLease.ts',
    new Set([
      'claimNewRuntimeSession',
      'confirmRuntimeSessionResume',
      'rotateRuntimeSessionLease',
      'markRuntimeSessionResetPending',
      'discardRuntimeSessionLease',
    ]),
  ],
  [
    'packages/backend/src/services/runtime/opencode/sessionCapture.ts',
    new Set(['captureChildSessions', 'markCaptureFailed']),
  ],
  ['packages/backend/src/services/runtime/opencode/subagentLiveCapture.ts', new Set(['tickOnce'])],
  ['packages/backend/src/services/runtime/claudeCode/sessionCapture.ts', new Set(['persistRows'])],
  ['packages/backend/src/services/workgroup/rounds.ts', new Set(['stampWgRound'])],
  ['packages/backend/src/services/task.ts', new Set(['persistPreparedProjection'])],
])
const WORKER_MUTATION_TABLES = new Set(['tasks', 'nodeRuns', 'nodeRunOutputs', 'nodeRunEvents'])
const OWNED_MUTATION_GATEWAYS = new Set([
  'recordSpawnReceipt',
  'settleTerminal',
  'withOwnedTaskTx',
  'withTaskExecutionMutation',
  'withTaskExecutionTransaction',
  'withCurrentTaskExecutionMutation',
  'withCurrentTaskExecutionTransaction',
])

interface TaskEffectBoundaryContract {
  readonly callable: string
  /** The low-level call that crosses the logical execution-effect boundary. */
  readonly actCallees: ReadonlySet<string>
  /** Exactly one of these registration gateways must own that boundary. */
  readonly observerCallees: ReadonlySet<string>
}

const TASK_EFFECT_BOUNDARIES = new Map<string, readonly TaskEffectBoundaryContract[]>([
  [
    'packages/backend/src/services/commitPushRunner.ts',
    [
      {
        callable: 'runCommitPush',
        actCallees: new Set(['runGit']),
        observerCallees: new Set(['createLocalEffectAttemptObserver']),
      },
    ],
  ],
  [
    'packages/backend/src/services/isolatedAgentRun.ts',
    [
      {
        callable: 'createIsoUnderLock',
        actCallees: new Set(['createNodeIso']),
        observerCallees: new Set(['createLocalEffectAttemptObserver']),
      },
      {
        callable: 'mergeBackAndSettle',
        actCallees: new Set(['mergeBackNodeIso', 'snapshotNodeIsoFinal']),
        observerCallees: new Set(['createLocalEffectAttemptObserver']),
      },
    ],
  ],
  [
    'packages/backend/src/services/nodeIsolation.ts',
    [
      {
        callable: 'discardNodeIso',
        actCallees: new Set(['removeWorktree']),
        observerCallees: new Set(['createLocalEffectAttemptObserver']),
      },
    ],
  ],
  [
    'packages/backend/src/services/nodeRollback.ts',
    [
      {
        callable: 'rollbackNodeRunWorktrees',
        actCallees: new Set(['rollbackToSnapshot']),
        observerCallees: new Set(['createLocalEffectAttemptObserver']),
      },
    ],
  ],
  [
    'packages/backend/src/services/runner.ts',
    [
      {
        callable: 'runNode',
        actCallees: new Set(['runAgentProcess']),
        observerCallees: new Set(['createProcessEffectAttemptObserver']),
      },
    ],
  ],
  [
    'packages/backend/src/modules/task-execution/composition/nodeMechanics.ts',
    [
      {
        callable: 'runCodeHostCallNode',
        actCallees: new Set(['executeCodeHostCall']),
        observerCallees: new Set(['createCodeHostEffectAttemptObserver']),
      },
      {
        callable: 'runOneScriptAttempt',
        actCallees: new Set(['runScriptProcess']),
        observerCallees: new Set(['createProcessEffectAttemptObserver']),
      },
    ],
  ],
  [
    'packages/backend/src/services/task.ts',
    [
      {
        callable: 'runDeferredRepoPreparation',
        actCallees: new Set(['materializeSpace']),
        observerCallees: new Set(['createLocalEffectAttemptObserver']),
      },
    ],
  ],
])
const CANONICAL_MUTATION_SYMBOLS = new Map<string, ReadonlySet<string>>([
  [
    'packages/backend/src/services/lifecycle.ts',
    new Set([
      'abandonSupersededMergeStates',
      'setNodeRunStatus',
      'setNodeRunStatusTx',
      'setTaskStatus',
      'transitionNodeRunStatusTx',
      'writeTaskStatusTx',
    ]),
  ],
  ['packages/backend/src/services/nodeRunMint.ts', new Set(['mintNodeRunTx'])],
  ['packages/backend/src/services/commitPushRunner.ts', new Set(['persistMeta'])],
  ['packages/backend/src/services/task.ts', new Set(['persistPreparedProjection'])],
])

const FACTORY_ALLOWLIST = new Map<string, ReadonlySet<string>>([
  [
    'createWorkerIdentity',
    new Set([
      'packages/backend/src/modules/task-execution/composition.ts',
      'packages/backend/src/modules/task-execution/infrastructure/sqliteTaskExecutionEffect.ts',
    ]),
  ],
  [
    'createOwnershipToken',
    new Set([
      'packages/backend/src/modules/task-execution/infrastructure/sqliteTaskExecutionEffect.ts',
      'packages/backend/src/modules/task-execution/infrastructure/sqliteTaskOwnership.ts',
    ]),
  ],
  [
    'createClaimAttachPermit',
    new Set(['packages/backend/src/modules/task-execution/application/taskClaimGate.ts']),
  ],
  ['createExclusiveDaemonLockProof', new Set(['packages/backend/src/cli/start.ts'])],
  [
    'createVerifiedTakeoverProof',
    new Set(['packages/backend/src/modules/task-execution/application/recoverTaskExecutions.ts']),
  ],
  [
    'createVerifiedStopProof',
    new Set(['packages/backend/src/modules/task-execution/infrastructure/taskDriverLifecycle.ts']),
  ],
  [
    'createVerifiedOutcomeUnknownClosure',
    new Set([
      'packages/backend/src/modules/task-execution/application/recoverTaskExecutions.ts',
      'packages/backend/src/modules/task-execution/infrastructure/taskDriverLifecycle.ts',
    ]),
  ],
])

function callableName(node: ts.Node): string | null {
  let cursor: ts.Node | undefined = node
  while (cursor !== undefined) {
    if (ts.isFunctionDeclaration(cursor) && cursor.name !== undefined) return cursor.name.text
    if (
      (ts.isArrowFunction(cursor) || ts.isFunctionExpression(cursor)) &&
      ts.isVariableDeclaration(cursor.parent) &&
      ts.isIdentifier(cursor.parent.name)
    ) {
      return cursor.parent.name.text
    }
    cursor = cursor.parent
  }
  return null
}

function isInsideCanonicalMutationSymbol(node: ts.Node, path: string): boolean {
  const allowed = CANONICAL_MUTATION_SYMBOLS.get(path)
  if (allowed === undefined) return false
  let cursor: ts.Node | undefined = node
  while (cursor !== undefined) {
    if (
      ts.isFunctionDeclaration(cursor) &&
      cursor.name !== undefined &&
      allowed.has(cursor.name.text)
    ) {
      return true
    }
    if (
      (ts.isArrowFunction(cursor) || ts.isFunctionExpression(cursor)) &&
      ts.isVariableDeclaration(cursor.parent) &&
      ts.isIdentifier(cursor.parent.name) &&
      allowed.has(cursor.parent.name.text)
    ) {
      return true
    }
    cursor = cursor.parent
  }
  return false
}

function callName(node: ts.CallExpression): string | null {
  return ts.isIdentifier(node.expression)
    ? node.expression.text
    : ts.isPropertyAccessExpression(node.expression)
      ? node.expression.name.text
      : null
}

function namedCallable(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node) && node.name !== undefined) return node.name.text
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    ts.isVariableDeclaration(node.parent) &&
    ts.isIdentifier(node.parent.name)
  ) {
    return node.parent.name.text
  }
  return null
}

function taskEffectBoundaryViolations(unit: GuardUnit): string[] {
  const contracts = TASK_EFFECT_BOUNDARIES.get(unit.path)
  if (contracts === undefined) return []

  const violations: string[] = []
  const callableNodes = new Map<string, ts.Node>()
  const discover = (node: ts.Node): void => {
    const name = namedCallable(node)
    if (name !== null && contracts.some((contract) => contract.callable === name)) {
      callableNodes.set(name, node)
      return
    }
    ts.forEachChild(node, discover)
  }
  discover(unit.source)

  for (const contract of contracts) {
    const callable = callableNodes.get(contract.callable)
    if (callable === undefined) {
      violations.push(`missing task effect boundary callable: ${unit.path}#${contract.callable}`)
      continue
    }
    const observedActs = new Set<string>()
    const observedRegistrations = new Set<string>()
    const inspect = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const name = callName(node)
        if (name !== null && contract.actCallees.has(name)) observedActs.add(name)
        if (name !== null && contract.observerCallees.has(name)) observedRegistrations.add(name)
      }
      ts.forEachChild(node, inspect)
    }
    inspect(callable)
    for (const act of contract.actCallees) {
      if (!observedActs.has(act)) {
        violations.push(
          `missing task effect act boundary ${act}: ${unit.path}#${contract.callable}`,
        )
      }
    }
    if (observedActs.size > 0 && observedRegistrations.size === 0) {
      violations.push(`unregistered task effect boundary: ${unit.path}#${contract.callable}`)
    }
  }
  return violations
}

function containsIdentifier(node: ts.Node, name: string): boolean {
  let found = false
  const visit = (candidate: ts.Node): void => {
    if (ts.isIdentifier(candidate) && candidate.text === name) found = true
    if (!found) ts.forEachChild(candidate, visit)
  }
  visit(node)
  return found
}

function deferredMutationCallbackHasOwnedConsumer(node: ts.Node): boolean {
  let callback: ts.ArrowFunction | ts.FunctionExpression | undefined
  let cursor: ts.Node | undefined = node
  while (cursor !== undefined) {
    if (ts.isArrowFunction(cursor) || ts.isFunctionExpression(cursor)) {
      callback = cursor
      break
    }
    cursor = cursor.parent
  }
  if (
    callback === undefined ||
    !ts.isVariableDeclaration(callback.parent) ||
    !ts.isIdentifier(callback.parent.name)
  ) {
    return false
  }
  const callbackName = callback.parent.name.text
  let scope: ts.Node = callback.parent
  while (
    scope.parent !== undefined &&
    !ts.isFunctionLike(scope.parent) &&
    !ts.isSourceFile(scope.parent)
  ) {
    scope = scope.parent
  }
  scope = scope.parent ?? scope
  let ownedConsumer = false
  const visit = (candidate: ts.Node): void => {
    if (
      ts.isCallExpression(candidate) &&
      OWNED_MUTATION_GATEWAYS.has(callName(candidate) ?? '') &&
      candidate.arguments.some((argument) => containsIdentifier(argument, callbackName))
    ) {
      ownedConsumer = true
      return
    }
    if (!ownedConsumer) ts.forEachChild(candidate, visit)
  }
  visit(scope)
  return ownedConsumer
}

function rfc328GuardViolations(units: readonly GuardUnit[]): string[] {
  const violations: string[] = []
  for (const unit of units) {
    const path = unit.path
    const text = unit.text
    violations.push(...taskEffectBoundaryViolations(unit))
    if (
      path !== 'packages/backend/src/services/driverLease.ts' &&
      /from\s+['"]@\/services\/driverLease['"]/.test(text)
    ) {
      violations.push(`legacy driverLease production consumer: ${path}`)
    }
    if (
      path.includes('inMemoryTaskDriverSupervisor') ||
      path.includes('ports/taskDriverSupervisor') ||
      /InMemoryTaskDriverSupervisor|taskDriverSupervisor/.test(text)
    ) {
      violations.push(`legacy taskId runtime authority: ${path}`)
    }
    if (/\b(?:requestStop|tryAttach)\s*\(\s*taskId\s*[?:]?\s*:/.test(text)) {
      violations.push(`taskId-only stop/attach signature: ${path}`)
    }
    if (/\babortAll\s*\(\s*(?:cause|reason)\s*\?\s*:/.test(text)) {
      violations.push(`optional shutdown reason: ${path}`)
    }

    if (path !== 'packages/backend/src/modules/task-execution/domain/ownership.ts') {
      for (const [factory, allowed] of FACTORY_ALLOWLIST) {
        if (new RegExp(`\\b${factory}\\s*\\(`).test(text) && !allowed.has(path)) {
          violations.push(`raw capability factory ${factory}: ${path}`)
        }
      }
    }

    if (path.startsWith('packages/backend/src/modules/task-execution/')) {
      for (const match of text.matchAll(
        /from\s+['"]@\/modules\/([^/]+)\/(domain|application|engine|infrastructure|composition)\/([^'"]+)['"]/g,
      )) {
        const context = match[1]!
        const layer = match[2]!
        const rest = match[3]!
        if (context === 'task-execution') continue
        const requiredPortAdapter =
          path.includes('/application/adapters/') &&
          layer === 'composition' &&
          rest === 'required-ports'
        if (!requiredPortAdapter) {
          violations.push(`cross-context internal import ${context}/${layer}/${rest}: ${path}`)
        }
      }
    }

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ['insert', 'update', 'delete'].includes(node.expression.name.text) &&
        node.arguments[0] !== undefined &&
        ts.isIdentifier(node.arguments[0]) &&
        WORKER_MUTATION_TABLES.has(node.arguments[0].text)
      ) {
        const symbol = callableName(node)
        const isWorkerMutation =
          WORKER_MUTATION_FILES.has(path) ||
          (symbol !== null && WORKER_MUTATION_CALLABLES.get(path)?.has(symbol) === true)
        if (!isWorkerMutation) {
          ts.forEachChild(node, visit)
          return
        }
        let cursor: ts.Node | undefined = node
        let owned = false
        while (cursor !== undefined) {
          if (ts.isCallExpression(cursor)) {
            const name = callName(cursor)
            if (name !== null && OWNED_MUTATION_GATEWAYS.has(name)) {
              owned = true
              break
            }
          }
          cursor = cursor.parent
        }
        owned ||=
          (symbol !== null && CANONICAL_MUTATION_SYMBOLS.get(path)?.has(symbol) === true) ||
          isInsideCanonicalMutationSymbol(node, path) ||
          deferredMutationCallbackHasOwnedConsumer(node)
        if (!owned) {
          const line = unit.source.getLineAndCharacterOfPosition(node.getStart()).line + 1
          violations.push(`raw worker mutation ${node.arguments[0].text}: ${path}:${line}`)
        }
      }
      if (
        ts.isPropertyAssignment(node) &&
        ((ts.isIdentifier(node.name) && node.name.text === 'stableActionOrdinal') ||
          (ts.isStringLiteral(node.name) && node.name.text === 'stableActionOrdinal'))
      ) {
        const initializer = node.initializer.getText(unit.source)
        if (/\b(?:nodeRunId|isoKeyRunId|retryIndex)\b|\b(?:run|nodeRun)\.id\b/.test(initializer)) {
          const line = unit.source.getLineAndCharacterOfPosition(node.getStart()).line + 1
          violations.push(`volatile operation family ordinal: ${path}:${line}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(unit.source)
  }
  return [...new Set(violations)].sort()
}

describe('RFC-328 architecture guards', () => {
  const corpus = backendUnits(REPO_ROOT)

  test('real production corpus is non-empty and has no legacy/raw authority bypass', () => {
    expect(corpus.length).toBeGreaterThan(800)
    expect(rfc328GuardViolations(corpus)).toEqual([])
    const generated = buildCanonicalArtifacts(REPO_ROOT)
    expect(validateCanonicalArtifacts(generated)).toEqual([])
    const authority = generated.mutationEntrypoints.taskExecutionAuthorityLedger as Record<
      string,
      unknown
    >
    const effects = generated.transactionExternalEffects.taskExecutionEffectLedger as Record<
      string,
      unknown
    >
    expect((authority.entries as unknown[]).length).toBeGreaterThan(30)
    expect((effects.entries as unknown[]).length).toBeGreaterThan(8)
  }, 60_000)

  test('negative fixtures prove every RFC-328 source guard can bite', () => {
    const fixture = (path: string, sourceText: string): GuardUnit[] => [
      {
        path,
        text: sourceText,
        source: ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true),
      },
    ]
    expect(
      rfc328GuardViolations(
        fixture(
          'packages/backend/src/services/newAutoDriver.ts',
          `import { withDriverLease } from '@/services/driverLease'`,
        ),
      ),
    ).toContain(
      'legacy driverLease production consumer: packages/backend/src/services/newAutoDriver.ts',
    )
    expect(
      rfc328GuardViolations(
        fixture(
          'packages/backend/src/services/newRegistry.ts',
          'function requestStop(taskId: string, cause: string) {}',
        ),
      ),
    ).toContain('taskId-only stop/attach signature: packages/backend/src/services/newRegistry.ts')
    expect(
      rfc328GuardViolations(
        fixture(
          'packages/backend/src/services/newShutdown.ts',
          'function abortAll(cause?: string) {}',
        ),
      ),
    ).toContain('optional shutdown reason: packages/backend/src/services/newShutdown.ts')
    expect(
      rfc328GuardViolations(
        fixture(
          'packages/backend/src/services/rawOwner.ts',
          'const token = createOwnershipToken({})',
        ),
      ),
    ).toContain(
      'raw capability factory createOwnershipToken: packages/backend/src/services/rawOwner.ts',
    )
    expect(
      rfc328GuardViolations(
        fixture(
          'packages/backend/src/modules/task-execution/application/bad.ts',
          `import { hidden } from '@/modules/source-control/domain/hidden'`,
        ),
      ),
    ).toContain(
      'cross-context internal import source-control/domain/hidden: packages/backend/src/modules/task-execution/application/bad.ts',
    )
    expect(
      rfc328GuardViolations(
        fixture(
          'packages/backend/src/services/runner.ts',
          'function staleWriter(db: any) { db.update(nodeRuns).set({ status: "done" }).run() }',
        ),
      ).some((violation) => violation.startsWith('raw worker mutation nodeRuns:')),
    ).toBe(true)
    expect(
      rfc328GuardViolations(
        fixture(
          'packages/backend/src/services/newProcess.ts',
          'createLocalEffectAttemptObserver({ stableActionOrdinal: `merge:${nodeRunId}` })',
        ),
      ).some((violation) => violation.startsWith('volatile operation family ordinal:')),
    ).toBe(true)
    expect(
      rfc328GuardViolations(
        fixture(
          'packages/backend/src/services/runner.ts',
          'async function runNode() { await runAgentProcess({}) }',
        ),
      ),
    ).toContain(
      'unregistered task effect boundary: packages/backend/src/services/runner.ts#runNode',
    )
  })
})
