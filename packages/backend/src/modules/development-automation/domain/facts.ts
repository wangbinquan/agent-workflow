// RFC-310 T10 —— FactCatalog 与 MissionFactSnapshot（design.md §4.1）。
//
// 规则只能读 code-owned closed catalog 里登记的 typed facts；每个 leaf 声明
// 类型、closed vocabulary（enum）、provenance 与允许出现的 decision phase。
// publish 校验用 catalog 拒绝：未知 fact、越 phase 读取、enum 越 vocabulary。
// evaluator 对 unknown/stale 得 indeterminate（factCell.ts），前一条规则
// indeterminate 时禁止落到后续 fallback。

import { z } from 'zod'

import { canonicalDigest } from './canonicalJson'
import { evaluateCell, factCellSchema, type FactCell, type TriState } from './factCell'
import type { FactPredicate } from './predicate'

export type FactValueType = 'enum' | 'string-set' | 'number' | 'boolean'

export type FactProvenance =
  | 'program'
  | 'external-authoritative'
  | 'human-confirmed'
  | 'agent-validated'

export type DecisionPhase = 'admission-selection' | 'action-decision' | 'readiness'

export interface FactLeafSpec {
  readonly id: string
  readonly group:
    | 'repository'
    | 'requirement'
    | 'mr'
    | 'pipeline'
    | 'verification'
    | 'action'
    | 'budget'
  readonly type: FactValueType
  /** enum 的 closed vocabulary；其他类型为 null。 */
  readonly vocabulary: readonly string[] | null
  readonly provenance: FactProvenance
  readonly phases: readonly DecisionPhase[]
}

const ALL_PHASES: readonly DecisionPhase[] = ['admission-selection', 'action-decision', 'readiness']
const POST_ADMISSION: readonly DecisionPhase[] = ['action-decision', 'readiness']

function leaf(
  id: string,
  group: FactLeafSpec['group'],
  type: FactValueType,
  opts: {
    vocabulary?: readonly string[]
    provenance?: FactProvenance
    phases?: readonly DecisionPhase[]
  } = {},
): FactLeafSpec {
  return {
    id,
    group,
    type,
    vocabulary: opts.vocabulary ?? null,
    provenance: opts.provenance ?? 'program',
    phases: opts.phases ?? ALL_PHASES,
  }
}

/** 首版 closed catalog（design §4.1 表）；扩展走 RFC/contract 升版。 */
export const FACT_CATALOG: readonly FactLeafSpec[] = [
  // repository（admission 起即可用）
  leaf('repository.languages', 'repository', 'string-set'),
  leaf('repository.buildSystems', 'repository', 'string-set'),
  leaf('repository.moduleIds', 'repository', 'string-set'),
  leaf('repository.changedPathClasses', 'repository', 'string-set', { phases: POST_ADMISSION }),
  leaf('repository.defaultBranchKnown', 'repository', 'boolean'),
  // requirement
  leaf('requirement.sourceKind', 'requirement', 'enum', {
    vocabulary: ['direct', 'external'],
  }),
  leaf('requirement.bundleComplete', 'requirement', 'boolean', { phases: POST_ADMISSION }),
  leaf('requirement.clarificationState', 'requirement', 'enum', {
    vocabulary: ['none', 'questions-published', 'answers-committed'],
    phases: POST_ADMISSION,
  }),
  leaf('requirement.uploadSeedState', 'requirement', 'enum', {
    vocabulary: ['not-applicable', 'pending', 'seeded', 'published'],
    phases: POST_ADMISSION,
  }),
  // 经 semantic validator 固化的认知 facts（provenance=agent-validated）
  leaf('requirement.affectedModuleIds', 'requirement', 'string-set', {
    provenance: 'agent-validated',
    phases: POST_ADMISSION,
  }),
  leaf('requirement.scopeDisposition', 'requirement', 'enum', {
    vocabulary: ['ready', 'needs-information', 'already-satisfied-candidate'],
    provenance: 'agent-validated',
    phases: POST_ADMISSION,
  }),
  // MR
  leaf('mr.exists', 'mr', 'boolean', { phases: POST_ADMISSION }),
  leaf('mr.draft', 'mr', 'boolean', {
    provenance: 'external-authoritative',
    phases: POST_ADMISSION,
  }),
  leaf('mr.conflict', 'mr', 'boolean', {
    provenance: 'external-authoritative',
    phases: POST_ADMISSION,
  }),
  leaf('mr.mergeable', 'mr', 'enum', {
    vocabulary: ['yes', 'no', 'unknown'],
    provenance: 'external-authoritative',
    phases: POST_ADMISSION,
  }),
  leaf('mr.approvalHold', 'mr', 'boolean', {
    provenance: 'external-authoritative',
    phases: POST_ADMISSION,
  }),
  leaf('mr.unhandledFeedbackCount', 'mr', 'number', { phases: POST_ADMISSION }),
  leaf('mr.terminalState', 'mr', 'enum', {
    vocabulary: ['active', 'merged', 'closed'],
    provenance: 'external-authoritative',
    phases: POST_ADMISSION,
  }),
  // pipeline
  leaf('pipeline.completeness', 'pipeline', 'enum', {
    vocabulary: ['complete', 'partial'],
    phases: POST_ADMISSION,
  }),
  leaf('pipeline.requiredGatesAllPass', 'pipeline', 'boolean', { phases: POST_ADMISSION }),
  leaf('pipeline.failingRequiredGateKeys', 'pipeline', 'string-set', { phases: POST_ADMISSION }),
  leaf('pipeline.failureCategories', 'pipeline', 'string-set', { phases: POST_ADMISSION }),
  leaf('pipeline.missingRequiredGateKeys', 'pipeline', 'string-set', { phases: POST_ADMISSION }),
  leaf('pipeline.anyRunning', 'pipeline', 'boolean', { phases: POST_ADMISSION }),
  // action（prior action 台账投影）
  // verification（RFC-310 T58 余项收口，2026-08-20）：平台自跑的 verification
  // profile 结果此前只落 `__delivery.*` 内部 cells，规则谓词读不到——于是
  // `verification.repair` 这条能力**存在却永远排不上**，失败一律以 typed block
  // `verification-failed:<profile>` 收场。升进 catalog 后，规则可以像 pipeline
  // 那样按结果路由修复；没有规则接手时链上那条 block 仍是兜底（同 pipeline 形态）。
  leaf('verification.lastOutcome', 'verification', 'enum', {
    vocabulary: ['not-run', 'passed', 'failed'],
    phases: POST_ADMISSION,
  }),
  leaf('verification.allRequiredPassed', 'verification', 'boolean', { phases: POST_ADMISSION }),
  leaf('verification.failedProfileRefs', 'verification', 'string-set', { phases: POST_ADMISSION }),
  leaf('action.pendingKind', 'action', 'enum', {
    vocabulary: ['none', 'agent', 'program', 'effect'],
    phases: POST_ADMISSION,
  }),
  leaf('action.lastOutcome', 'action', 'enum', {
    // PR-5 T54：'completed' = read-only 能力（analyze/review）的完成 outcome。
    vocabulary: [
      'none',
      'changed',
      'no-change',
      'needs-information',
      'blocked',
      'failed',
      'completed',
    ],
    phases: POST_ADMISSION,
  }),
  leaf('action.lastFailureCategory', 'action', 'enum', {
    vocabulary: [
      'none',
      'transient',
      'stale-input',
      'configuration',
      'permission',
      'invalid-user-input',
      'business-failure',
      'contract-violation',
    ],
    phases: POST_ADMISSION,
  }),
  leaf('action.candidateState', 'action', 'enum', {
    vocabulary: ['none', 'prepared', 'verified', 'published'],
    phases: POST_ADMISSION,
  }),
  // budget（剩余量）
  leaf('budget.actionRunsRemaining', 'budget', 'number', { phases: POST_ADMISSION }),
  leaf('budget.pipelineRerunsRemaining', 'budget', 'number', { phases: POST_ADMISSION }),
  leaf('budget.commitsRemaining', 'budget', 'number', { phases: POST_ADMISSION }),
]

const CATALOG_BY_ID = new Map(FACT_CATALOG.map((l) => [l.id, l]))

export function factLeaf(id: string): FactLeafSpec | undefined {
  return CATALOG_BY_ID.get(id)
}

export type FactCellValue = string | number | boolean | readonly string[]

export interface MissionFactSnapshot {
  readonly schemaVersion: 1
  readonly missionRevision: number
  readonly capturedAt: string
  readonly cells: Readonly<Record<string, FactCell<FactCellValue>>>
  readonly digest: string
}

const cellValueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string())])

export const missionFactSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    missionRevision: z.number().int().nonnegative(),
    capturedAt: z.string().datetime({ offset: true }),
    cells: z.record(factCellSchema(cellValueSchema)),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    for (const [id, cell] of Object.entries(snapshot.cells)) {
      // `__` 前缀是行投影的内部命名空间（如 `__mr.headSha`）：不进 closed
      // catalog、predicate 也读不到（catalog 查无此 id ⇒ indeterminate）。
      if (id.startsWith('__')) continue
      const spec = CATALOG_BY_ID.get(id)
      if (spec === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `fact '${id}' is not in the closed catalog`,
          path: ['cells', id],
        })
        continue
      }
      if (cell.state !== 'known') continue
      const value = cell.value
      const typeOk =
        (spec.type === 'enum' && typeof value === 'string') ||
        (spec.type === 'string-set' && Array.isArray(value)) ||
        (spec.type === 'number' && typeof value === 'number') ||
        (spec.type === 'boolean' && typeof value === 'boolean')
      if (!typeOk) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `fact '${id}' value does not match catalog type '${spec.type}'`,
          path: ['cells', id],
        })
      }
      if (spec.type === 'enum' && typeof value === 'string' && spec.vocabulary !== null) {
        if (!spec.vocabulary.includes(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `fact '${id}' value '${value}' outside closed vocabulary`,
            path: ['cells', id],
          })
        }
      }
    }
  })

/**
 * snapshot 构造。digest 是**内容寻址**：只覆盖 cells——capturedAt 与
 * missionRevision 是记录性元数据，不参与（同 §4.6 receipt id/decidedAt 不进
 * canonical core 的原则；PR-2 reconciler 实测：若把 revision 掺进 digest，
 * readiness 落盘 bump revision 后同 facts 的 decision 去重永不命中）。
 */
export function buildFactSnapshot(input: {
  missionRevision: number
  capturedAt: string
  cells: Record<string, FactCell<FactCellValue>>
}): MissionFactSnapshot {
  const digest = canonicalDigest({ schemaVersion: 1, cells: input.cells })
  return {
    schemaVersion: 1,
    missionRevision: input.missionRevision,
    capturedAt: input.capturedAt,
    cells: input.cells,
    digest,
  }
}

export interface PredicateEvaluation {
  readonly value: TriState
  /** 首个 indeterminate 的 fact id（trace/collect 用）。 */
  readonly indeterminateFact: string | null
}

function missing(id: string): PredicateEvaluation {
  return { value: 'indeterminate', indeterminateFact: id }
}

/** 三值求值：all/any 短路遵循 Kleene 逻辑，not(indeterminate)=indeterminate。 */
export function evaluatePredicate(
  snapshot: MissionFactSnapshot,
  predicate: FactPredicate,
): PredicateEvaluation {
  switch (predicate.kind) {
    case 'all': {
      let indeterminate: string | null = null
      for (const child of predicate.predicates) {
        const r = evaluatePredicate(snapshot, child)
        if (r.value === false) return { value: false, indeterminateFact: null }
        if (r.value === 'indeterminate' && indeterminate === null) {
          indeterminate = r.indeterminateFact
        }
      }
      return indeterminate === null
        ? { value: true, indeterminateFact: null }
        : { value: 'indeterminate', indeterminateFact: indeterminate }
    }
    case 'any': {
      let indeterminate: string | null = null
      for (const child of predicate.predicates) {
        const r = evaluatePredicate(snapshot, child)
        if (r.value === true) return { value: true, indeterminateFact: null }
        if (r.value === 'indeterminate' && indeterminate === null) {
          indeterminate = r.indeterminateFact
        }
      }
      return indeterminate === null
        ? { value: false, indeterminateFact: null }
        : { value: 'indeterminate', indeterminateFact: indeterminate }
    }
    case 'not': {
      const r = evaluatePredicate(snapshot, predicate.predicate)
      if (r.value === 'indeterminate') return r
      return { value: !r.value, indeterminateFact: null }
    }
    case 'path-class-any': {
      const cell = snapshot.cells['repository.changedPathClasses']
      if (cell === undefined) return missing('repository.changedPathClasses')
      const value = evaluateCell(cell, (v) =>
        Array.isArray(v) ? predicate.values.some((c) => v.includes(c)) : false,
      )
      return value === 'indeterminate'
        ? missing('repository.changedPathClasses')
        : { value, indeterminateFact: null }
    }
    default: {
      const cell = snapshot.cells[predicate.fact]
      if (cell === undefined) return missing(predicate.fact)
      const value = evaluateCell(cell, (v) => {
        if (v === null) return false
        switch (predicate.kind) {
          case 'enum-equals':
            return v === predicate.value
          case 'enum-in':
            return typeof v === 'string' && predicate.values.includes(v)
          case 'set-contains-any':
            return Array.isArray(v) && predicate.values.some((x) => v.includes(x))
          case 'set-contains-all':
            return Array.isArray(v) && predicate.values.every((x) => v.includes(x))
          case 'number-compare': {
            if (typeof v !== 'number') return false
            const target = predicate.value
            if (predicate.op === 'eq') return v === target
            if (predicate.op === 'lt') return v < target
            if (predicate.op === 'lte') return v <= target
            if (predicate.op === 'gt') return v > target
            return v >= target
          }
          case 'boolean-is':
            return v === predicate.value
        }
      })
      return value === 'indeterminate'
        ? missing(predicate.fact)
        : { value, indeterminateFact: null }
    }
  }
}

export interface PredicateCatalogViolation {
  readonly code: 'unknown-fact' | 'enum-outside-vocabulary' | 'phase-not-allowed' | 'type-mismatch'
  readonly factId: string
  readonly detail: string
}

/** policy publish 校验：predicate 引用面必须全部合法（design §4.2 publish 拒绝清单）。 */
export function checkPredicateAgainstCatalog(
  predicate: FactPredicate,
  phase: DecisionPhase,
): PredicateCatalogViolation[] {
  const violations: PredicateCatalogViolation[] = []
  const visit = (p: FactPredicate): void => {
    if (p.kind === 'all' || p.kind === 'any') {
      for (const child of p.predicates) visit(child)
      return
    }
    if (p.kind === 'not') {
      visit(p.predicate)
      return
    }
    const factId = p.kind === 'path-class-any' ? 'repository.changedPathClasses' : p.fact
    const spec = CATALOG_BY_ID.get(factId)
    if (spec === undefined) {
      violations.push({ code: 'unknown-fact', factId, detail: 'not in closed catalog' })
      return
    }
    if (!spec.phases.includes(phase)) {
      violations.push({
        code: 'phase-not-allowed',
        factId,
        detail: `phase '${phase}' cannot read this fact`,
      })
    }
    const expectType: Record<string, FactValueType> = {
      'enum-equals': 'enum',
      'enum-in': 'enum',
      'set-contains-any': 'string-set',
      'set-contains-all': 'string-set',
      'number-compare': 'number',
      'boolean-is': 'boolean',
      'path-class-any': 'string-set',
    }
    const expected = expectType[p.kind]!
    if (spec.type !== expected) {
      violations.push({
        code: 'type-mismatch',
        factId,
        detail: `predicate expects ${expected}, catalog says ${spec.type}`,
      })
    }
    if ((p.kind === 'enum-equals' || p.kind === 'enum-in') && spec.vocabulary !== null) {
      const values = p.kind === 'enum-equals' ? [p.value] : p.values
      for (const value of values) {
        if (!spec.vocabulary.includes(value)) {
          violations.push({
            code: 'enum-outside-vocabulary',
            factId,
            detail: `'${value}' outside vocabulary`,
          })
        }
      }
    }
  }
  visit(predicate)
  return violations
}
