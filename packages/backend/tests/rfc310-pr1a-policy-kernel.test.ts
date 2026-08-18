// RFC-310 PR-1A（T9–T12 + T18 语义半边）—— 规则内核测试。
//
// 锁的合同：①capability catalog 闭集与 agent 子集；②fact catalog 的
// phase/vocabulary/type publish 校验；③fixed guard 十步的每个 stop 分支；
// ④first-match 与 indeterminate 停机（不落 fallback）；⑤no-match ⇒
// blocked(no-policy-match)；⑥三个 work-set selector 的稳定排序/上限/digest；
// ⑦employee selection 四级与 route first-match（Java/C++/polyglot fixtures，
// 跨模块必须命中显式 polyglot，否则 blocked）；⑧replay oracle 100 次
// byte-identical（AC-1）。

import { describe, expect, test } from 'bun:test'

import {
  AGENT_CAPABILITY_IDS,
  CAPABILITY_DEFINITIONS,
  CAPABILITY_IDS,
  capabilityDefinition,
  isAgentCapability,
} from '@/modules/development-automation/domain/capabilityDefinition'
import {
  buildFactSnapshot,
  checkPredicateAgainstCatalog,
  evaluatePredicate,
  FACT_CATALOG,
  type FactCellValue,
  type MissionFactSnapshot,
} from '@/modules/development-automation/domain/facts'
import type { FactCell } from '@/modules/development-automation/domain/factCell'
import {
  canonicalDecisionBytes,
  canonicalDecisionDigest,
  replayOracle,
} from '@/modules/development-automation/engine/policy/canonicalTrace'
import {
  evaluatePolicy,
  type FixedGuardInput,
  type PolicyRule,
} from '@/modules/development-automation/engine/policy/evaluatePolicy'
import {
  resolveEmployeeSelection,
  selectActionTemplate,
  selectFeedbackWorkSet,
  selectPipelineWorkSet,
  selectVerificationWorkSet,
} from '@/modules/development-automation/engine/policy/workSelection'

function known(value: FactCellValue): FactCell<FactCellValue> {
  return { state: 'known', value, sourceRevision: 'r1' }
}

function snapshot(cells: Record<string, FactCell<FactCellValue>>): MissionFactSnapshot {
  return buildFactSnapshot({ missionRevision: 1, capturedAt: '2026-08-18T10:00:00+00:00', cells })
}

const PASSING_GUARDS: FixedGuardInput = {
  missionTerminal: false,
  mrTerminal: 'active',
  holdsLease: true,
  activeWritableAction: false,
  unsettledEffect: false,
  transitionFence: 'none',
  factIntegrityViolations: [],
  staleBaseline: false,
  authorityViolations: [],
  exhaustedBudgets: [],
  automationMode: 'active',
  uploadSeed: 'not-applicable',
  uploadPlanRef: null,
}

describe('T9 capability catalog', () => {
  test('closed catalog covers every id exactly once with fixed stages', () => {
    expect(CAPABILITY_DEFINITIONS).toHaveLength(CAPABILITY_IDS.length)
    expect(new Set(CAPABILITY_DEFINITIONS.map((d) => d.id)).size).toBe(CAPABILITY_IDS.length)
    for (const definition of CAPABILITY_DEFINITIONS) {
      expect(definition.contractVersion).toBe(1)
      expect(definition.stages).toEqual([
        'freeze-input',
        'materialize',
        'execute',
        'validate',
        'receipt',
      ])
    }
    expect(capabilityDefinition('change.implement').workspaceMode).toBe('edit-business-files')
    expect(capabilityDefinition('conflict.repair').workspaceMode).toBe('edit-conflicts')
    expect(capabilityDefinition('change.review').workspaceMode).toBe('read-only')
    expect(() => capabilityDefinition('mr.merge' as never)).toThrow()
    for (const id of AGENT_CAPABILITY_IDS) {
      expect(isAgentCapability(id)).toBe(true)
      expect(capabilityDefinition(id).allowedEffectKinds).toEqual([])
    }
  })

  test('no capability may produce merge/approve/resolve effects (AC-15 catalog side)', () => {
    for (const definition of CAPABILITY_DEFINITIONS) {
      for (const kind of definition.allowedEffectKinds) {
        expect(kind).not.toMatch(/merge|approve|resolve(?!d)|custom/)
      }
    }
  })
})

describe('T10 fact catalog + publish checks', () => {
  test('catalog ids are unique and evaluatePredicate honours vocabulary types', () => {
    expect(new Set(FACT_CATALOG.map((l) => l.id)).size).toBe(FACT_CATALOG.length)
    const snap = snapshot({
      'repository.languages': known(['java', 'cpp']),
      'mr.mergeable': known('yes'),
    })
    expect(
      evaluatePredicate(snap, {
        kind: 'set-contains-any',
        fact: 'repository.languages',
        values: ['java'],
      }).value,
    ).toBe(true)
    expect(
      evaluatePredicate(snap, { kind: 'enum-equals', fact: 'mr.mergeable', value: 'no' }).value,
    ).toBe(false)
    expect(
      evaluatePredicate(snap, {
        kind: 'enum-equals',
        fact: 'pipeline.completeness',
        value: 'complete',
      }),
    ).toEqual({ value: 'indeterminate', indeterminateFact: 'pipeline.completeness' })
  })

  test('publish checks reject unknown fact, wrong phase, foreign vocabulary, type mismatch', () => {
    expect(
      checkPredicateAgainstCatalog(
        { kind: 'enum-equals', fact: 'nope.fact', value: 'x' },
        'action-decision',
      ).map((v) => v.code),
    ).toEqual(['unknown-fact'])
    expect(
      checkPredicateAgainstCatalog(
        { kind: 'enum-equals', fact: 'pipeline.completeness', value: 'complete' },
        'admission-selection',
      ).map((v) => v.code),
    ).toContain('phase-not-allowed')
    expect(
      checkPredicateAgainstCatalog(
        { kind: 'enum-equals', fact: 'mr.mergeable', value: 'perhaps' },
        'readiness',
      ).map((v) => v.code),
    ).toContain('enum-outside-vocabulary')
    expect(
      checkPredicateAgainstCatalog(
        { kind: 'number-compare', fact: 'mr.mergeable', op: 'eq', value: 1 },
        'readiness',
      ).map((v) => v.code),
    ).toContain('type-mismatch')
    expect(
      checkPredicateAgainstCatalog(
        {
          kind: 'all',
          predicates: [
            { kind: 'set-contains-any', fact: 'repository.languages', values: ['java'] },
          ],
        },
        'admission-selection',
      ),
    ).toEqual([])
  })
})

describe('T11 fixed guards', () => {
  const snap = snapshot({})
  const rules: PolicyRule[] = [
    { ruleId: 'r-any', when: [], decision: { kind: 'collect-mr-facts' } },
  ]

  test('terminal guard wins over everything and maps MR closure correctly', () => {
    const merged = evaluatePolicy({
      guards: { ...PASSING_GUARDS, mrTerminal: 'merged' },
      snapshot: snap,
      rules,
    })
    expect(merged.selected).toEqual({ kind: 'mark-terminal', terminal: 'merged' })
    expect(merged.selectedBy).toBe('guard')
    const closed = evaluatePolicy({
      guards: { ...PASSING_GUARDS, mrTerminal: 'closed' },
      snapshot: snap,
      rules,
    })
    expect(closed.selected).toEqual({ kind: 'mark-terminal', terminal: 'closed-unmerged' })
  })

  test.each([
    ['lease', { holdsLease: false }, 'wait'],
    ['active action', { activeWritableAction: true }, 'wait'],
    ['unsettled effect', { unsettledEffect: true }, 'wait'],
    ['cancel fence', { transitionFence: 'cancel-pending' }, 'wait'],
    ['fact integrity', { factIntegrityViolations: ['bundle-digest-mismatch'] }, 'block'],
    ['stale baseline', { staleBaseline: true }, 'collect-mr-facts'],
    ['authority', { authorityViolations: ['connection-scope'] }, 'block'],
    ['budget', { exhaustedBudgets: ['actionRuns'] }, 'block'],
    ['tracking-only', { automationMode: 'tracking-only' }, 'wait'],
  ] as const)('guard stop: %s', (_label, override, expectedKind) => {
    const result = evaluatePolicy({
      guards: { ...PASSING_GUARDS, ...override } as FixedGuardInput,
      snapshot: snap,
      rules,
    })
    expect(result.selectedBy).toBe('guard')
    expect(result.selected.kind).toBe(expectedKind)
  })

  test('pending upload seeds preempt policy rules (upload-fulfillment guard)', () => {
    const result = evaluatePolicy({
      guards: {
        ...PASSING_GUARDS,
        uploadSeed: 'pending',
        uploadPlanRef: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      },
      snapshot: snap,
      rules,
    })
    expect(result.selected.kind).toBe('seed-repository-uploads')
  })

  test('all guards passing produces a full pass trace before rules run', () => {
    const result = evaluatePolicy({ guards: PASSING_GUARDS, snapshot: snap, rules })
    expect(result.guardTrace.every((n) => n.outcome === 'pass')).toBe(true)
    expect(result.guardTrace.map((n) => n.guard)).toEqual([
      'terminal',
      'lease-epoch',
      'active-effect-transition',
      'fact-integrity',
      'freshness',
      'authority',
      'budget',
      'safety',
      'automation-mode',
      'upload-fulfillment',
    ])
    expect(result.selectedBy).toBe('rule')
  })
})

describe('T11 first-match + indeterminate stop', () => {
  const rules: PolicyRule[] = [
    {
      ruleId: 'r1-needs-pipeline',
      when: [{ kind: 'boolean-is', fact: 'pipeline.requiredGatesAllPass', value: false }],
      decision: { kind: 'collect-pipeline-evidence', gateKeys: ['compile'] },
    },
    {
      ruleId: 'r2-fallback',
      when: [],
      decision: { kind: 'publish-readiness' },
    },
  ]

  test('first-match stops at the first true rule and traces the order', () => {
    const snap = snapshot({ 'pipeline.requiredGatesAllPass': known(false) })
    const result = evaluatePolicy({ guards: PASSING_GUARDS, snapshot: snap, rules })
    expect(result.matchedRuleId).toBe('r1-needs-pipeline')
    expect(result.ruleTrace).toHaveLength(1)
  })

  test('indeterminate fact stops evaluation; later fallback rules are NOT consulted (AC-29)', () => {
    const snap = snapshot({}) // pipeline fact 缺失 ⇒ indeterminate
    const result = evaluatePolicy({ guards: PASSING_GUARDS, snapshot: snap, rules })
    expect(result.matchedRuleId).toBeNull()
    // pipeline collect 需要上下文参数，纯 evaluator 显式 block 暴露而不是伪造参数
    expect(result.selected.kind).toBe('block')
    expect(result.ruleTrace).toEqual([
      { ruleId: 'r1-needs-pipeline', matched: false, stoppedOn: 'pipeline.requiredGatesAllPass' },
    ])
  })

  test('repository/mr groups map to their collect decisions on indeterminate', () => {
    const rulesRepo: PolicyRule[] = [
      {
        ruleId: 'r-lang',
        when: [{ kind: 'set-contains-any', fact: 'repository.languages', values: ['java'] }],
        decision: { kind: 'publish-readiness' },
      },
    ]
    const result = evaluatePolicy({
      guards: PASSING_GUARDS,
      snapshot: snapshot({}),
      rules: rulesRepo,
    })
    expect(result.selected).toEqual({ kind: 'collect-repository-facts' })
  })

  test('no matching rule blocks with no-policy-match; agent is never asked', () => {
    const rulesNone: PolicyRule[] = [
      {
        ruleId: 'r-java-only',
        when: [{ kind: 'set-contains-any', fact: 'repository.languages', values: ['java'] }],
        decision: { kind: 'publish-readiness' },
      },
    ]
    const snap = snapshot({ 'repository.languages': known(['go']) })
    const result = evaluatePolicy({ guards: PASSING_GUARDS, snapshot: snap, rules: rulesNone })
    expect(result.selected).toEqual({ kind: 'block', reason: 'no-policy-match' })
    expect(result.selectedBy).toBe('no-match')
  })
})

describe('T11 work selection receipts', () => {
  test('feedback: author-class ranking, stable ordering, batch limit, stable digest', () => {
    const items = [
      { threadRef: 't-bot', revision: 'r1', authorClass: 'bot', createdOrdinal: 1 },
      { threadRef: 't-b', revision: 'r2', authorClass: 'human', createdOrdinal: 5 },
      { threadRef: 't-a', revision: 'r9', authorClass: 'human', createdOrdinal: 5 },
      { threadRef: 't-early', revision: 'r1', authorClass: 'human', createdOrdinal: 2 },
      { threadRef: 't-self', revision: 'r1', authorClass: 'self', createdOrdinal: 0 },
    ] as const
    const first = selectFeedbackWorkSet({
      items,
      allowedAuthorClasses: ['human', 'bot'],
      batchLimit: 3,
      inputFactDigest: 'd1',
    })
    expect(first.itemRefs).toEqual(['t-early@r1', 't-a@r9', 't-b@r2'])
    const second = selectFeedbackWorkSet({
      items: [...items].reverse(),
      allowedAuthorClasses: ['human', 'bot'],
      batchLimit: 3,
      inputFactDigest: 'd1',
    })
    expect(second.digest).toBe(first.digest)
  })

  test('pipeline: only required failures, category-then-gate order', () => {
    const receipt = selectPipelineWorkSet({
      gates: [
        { gateKey: 'z-unit', required: true, status: 'fail', failureCategories: ['unit-test'] },
        { gateKey: 'a-compile', required: true, status: 'fail', failureCategories: ['compile'] },
        { gateKey: 'optional-lint', required: false, status: 'fail', failureCategories: ['lint'] },
        { gateKey: 'green', required: true, status: 'pass', failureCategories: [] },
      ],
      batchLimit: 10,
      inputFactDigest: 'd2',
    })
    expect(receipt.itemRefs).toEqual(['a-compile', 'z-unit'])
  })

  test('verification: step-then-ref stable order', () => {
    const receipt = selectVerificationWorkSet({
      failures: [
        { stepId: 'test', failureRef: 'f2' },
        { stepId: 'build', failureRef: 'f9' },
        { stepId: 'test', failureRef: 'f1' },
      ],
      inputFactDigest: 'd3',
    })
    expect(receipt.itemRefs).toEqual(['build:f9', 'test:f1', 'test:f2'])
  })
})

describe('T18 employee selection + template routes (Java / C++ / polyglot fixtures)', () => {
  const JAVA_SNAP = snapshot({
    'repository.languages': known(['java']),
    'repository.buildSystems': known(['maven']),
    'repository.moduleIds': known(['spring-app']),
  })
  const CPP_SNAP = snapshot({
    'repository.languages': known(['cpp']),
    'repository.buildSystems': known(['cmake']),
    'repository.moduleIds': known(['core']),
  })
  const MIXED_SNAP = snapshot({
    'repository.languages': known(['java', 'cpp']),
    'repository.buildSystems': known(['maven', 'cmake']),
    'repository.moduleIds': known(['spring-app', 'native-core']),
  })

  const selectionRules = [
    {
      ruleId: 'sel-java',
      when: [
        { kind: 'set-contains-all', fact: 'repository.languages', values: ['java'] } as const,
        {
          kind: 'not',
          predicate: { kind: 'set-contains-any', fact: 'repository.languages', values: ['cpp'] },
        } as const,
      ],
      employeeRef: 'emp-java@3',
    },
    {
      ruleId: 'sel-cpp',
      when: [
        { kind: 'set-contains-all', fact: 'repository.languages', values: ['cpp'] } as const,
        {
          kind: 'not',
          predicate: { kind: 'set-contains-any', fact: 'repository.languages', values: ['java'] },
        } as const,
      ],
      employeeRef: 'emp-cpp@2',
    },
    {
      ruleId: 'sel-polyglot',
      when: [
        {
          kind: 'set-contains-all',
          fact: 'repository.languages',
          values: ['java', 'cpp'],
        } as const,
      ],
      employeeRef: 'emp-polyglot@1',
    },
  ]

  test('explicit beats assignment; assignment beats rules; rules pick per language', () => {
    expect(
      resolveEmployeeSelection({
        explicitEmployeeRef: 'emp-explicit@1',
        assignment: {
          scope: 'repository',
          employeeRef: 'emp-assigned@1',
          selectionRules: null,
          executionPolicyRef: null,
          defaultRequirementSourceKey: null,
        },
        explicitFallbackRef: null,
        snapshot: JAVA_SNAP,
      }),
    ).toMatchObject({
      outcome: 'selected',
      employeeRef: 'emp-explicit@1',
      selectionMode: 'explicit',
    })

    const byRule = resolveEmployeeSelection({
      explicitEmployeeRef: null,
      assignment: {
        scope: 'repository-group',
        employeeRef: null,
        selectionRules,
        executionPolicyRef: null,
        defaultRequirementSourceKey: null,
      },
      explicitFallbackRef: null,
      snapshot: CPP_SNAP,
    })
    expect(byRule).toMatchObject({
      outcome: 'selected',
      employeeRef: 'emp-cpp@2',
      selectionMode: 'rule',
      matchedRuleId: 'sel-cpp',
    })

    const mixed = resolveEmployeeSelection({
      explicitEmployeeRef: null,
      assignment: {
        scope: 'repository-group',
        employeeRef: null,
        selectionRules,
        executionPolicyRef: null,
        defaultRequirementSourceKey: null,
      },
      explicitFallbackRef: null,
      snapshot: MIXED_SNAP,
    })
    expect(mixed).toMatchObject({ outcome: 'selected', employeeRef: 'emp-polyglot@1' })
  })

  test('no rule + no fallback blocks; indeterminate facts block instead of guessing', () => {
    expect(
      resolveEmployeeSelection({
        explicitEmployeeRef: null,
        assignment: {
          scope: 'global-default',
          employeeRef: null,
          selectionRules: [selectionRules[0]!],
          executionPolicyRef: null,
          defaultRequirementSourceKey: null,
        },
        explicitFallbackRef: null,
        snapshot: CPP_SNAP,
      }),
    ).toMatchObject({ outcome: 'blocked', reason: 'no-employee-match' })

    expect(
      resolveEmployeeSelection({
        explicitEmployeeRef: null,
        assignment: {
          scope: 'repository',
          employeeRef: null,
          selectionRules,
          executionPolicyRef: null,
          defaultRequirementSourceKey: null,
        },
        explicitFallbackRef: null,
        snapshot: snapshot({}),
      }),
    ).toMatchObject({ outcome: 'blocked', reason: 'selection-indeterminate' })
  })

  test('capability routes: modules pick java vs cpp template; cross-module needs explicit polyglot', () => {
    const routes = [
      {
        ruleId: 'route-java',
        when: [
          {
            kind: 'set-contains-all',
            fact: 'repository.changedPathClasses',
            values: ['java-module'],
          } as const,
          {
            kind: 'not',
            predicate: {
              kind: 'set-contains-any',
              fact: 'repository.changedPathClasses',
              values: ['cpp-module'],
            },
          } as const,
        ],
        templateRef: 'change.implement/java-spring@3',
      },
      {
        ruleId: 'route-cpp',
        when: [
          {
            kind: 'set-contains-all',
            fact: 'repository.changedPathClasses',
            values: ['cpp-module'],
          } as const,
          {
            kind: 'not',
            predicate: {
              kind: 'set-contains-any',
              fact: 'repository.changedPathClasses',
              values: ['java-module'],
            },
          } as const,
        ],
        templateRef: 'change.implement/cpp-cmake@4',
      },
      {
        ruleId: 'route-polyglot',
        when: [
          {
            kind: 'set-contains-all',
            fact: 'repository.changedPathClasses',
            values: ['java-module', 'cpp-module'],
          } as const,
        ],
        templateRef: 'change.implement/polyglot@1',
      },
    ]
    const routeSnap = (classes: string[]) =>
      snapshot({ 'repository.changedPathClasses': known(classes) })
    expect(
      selectActionTemplate({
        rules: routes,
        fallbackTemplateRef: null,
        snapshot: routeSnap(['java-module']),
      }),
    ).toMatchObject({ templateRef: 'change.implement/java-spring@3', matchedRuleId: 'route-java' })
    expect(
      selectActionTemplate({
        rules: routes,
        fallbackTemplateRef: null,
        snapshot: routeSnap(['cpp-module']),
      }),
    ).toMatchObject({ templateRef: 'change.implement/cpp-cmake@4' })
    expect(
      selectActionTemplate({
        rules: routes,
        fallbackTemplateRef: null,
        snapshot: routeSnap(['java-module', 'cpp-module']),
      }),
    ).toMatchObject({ templateRef: 'change.implement/polyglot@1', matchedRuleId: 'route-polyglot' })

    const noPolyglot = routes.slice(0, 2)
    expect(
      selectActionTemplate({
        rules: noPolyglot,
        fallbackTemplateRef: null,
        snapshot: routeSnap(['java-module', 'cpp-module']),
      }),
    ).toMatchObject({ outcome: 'blocked', reason: 'no-route-match' })
  })
})

describe('T12 canonical decision bytes + replay oracle', () => {
  test('AC-1: 100 replays of the same evaluation are byte-identical; digest is stable', () => {
    const rules: PolicyRule[] = [
      {
        ruleId: 'r-ready',
        when: [{ kind: 'boolean-is', fact: 'pipeline.requiredGatesAllPass', value: true }],
        decision: { kind: 'publish-readiness' },
      },
    ]
    const snap = snapshot({ 'pipeline.requiredGatesAllPass': known(true) })
    const evaluateOnce = () => {
      const result = evaluatePolicy({ guards: PASSING_GUARDS, snapshot: snap, rules })
      return {
        policyRef: 'policy@7',
        employeeRef: 'emp-java@3',
        factDigest: snap.digest,
        workSetDigest: null,
        guardTrace: result.guardTrace,
        ruleTrace: result.ruleTrace,
        selected: result.selected,
      }
    }
    expect(replayOracle(evaluateOnce, 100)).toBeNull()
    const digest1 = canonicalDecisionDigest(evaluateOnce())
    const digest2 = canonicalDecisionDigest(evaluateOnce())
    expect(digest1).toBe(digest2)
    expect(canonicalDecisionBytes(evaluateOnce())).toContain('"selected"')
  })

  test('any changed input changes the canonical digest', () => {
    const base = {
      policyRef: 'policy@7',
      employeeRef: null,
      factDigest: 'a'.repeat(64),
      workSetDigest: null,
      guardTrace: [],
      ruleTrace: [],
      selected: { kind: 'publish-readiness' } as const,
    }
    const d0 = canonicalDecisionDigest(base)
    expect(canonicalDecisionDigest({ ...base, policyRef: 'policy@8' })).not.toBe(d0)
    expect(canonicalDecisionDigest({ ...base, selected: { kind: 'collect-mr-facts' } })).not.toBe(
      d0,
    )
  })
})
