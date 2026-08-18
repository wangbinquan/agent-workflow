// RFC-310 PR-8 T87 —— first-match 规则构建器（actionPriority / employeeSelection 共用）。
//
// 语义即 UI：列表顺序就是求值优先级（首条命中即停），上移/下移是一等操作；
// 每条规则的 when 是谓词合取（全部满足才命中）。谓词行按 kind 切换输入面：
// enum 值走目录 vocabulary 下拉、set 走 ChipsInput、number 带比较算子。组合子
// （all/any/not）超出行式编辑的表达力，以 JSON 行如实呈现与编辑，不静默丢弃。

import { useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { ChipsInput } from '@/components/ChipsInput'
import { Field, NumberInput, TextArea, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'
import {
  AGENT_CAPABILITY_IDS,
  factEntry,
  LEAF_PREDICATE_KINDS,
  NUMBER_COMPARE_OPS,
  POLICY_FACT_CATALOG,
  type LeafPredicateKind,
} from '@/data/policyFactCatalog'

/** 谓词编辑态：叶子七种行式；组合子/未知形态以 JSON 行兜底（raw 原文保真）。 */
export type PredicateDraft =
  | { kind: 'enum-equals'; fact: string; value: string }
  | { kind: 'enum-in'; fact: string; values: string[] }
  | { kind: 'set-contains-any'; fact: string; values: string[] }
  | { kind: 'set-contains-all'; fact: string; values: string[] }
  | { kind: 'number-compare'; fact: string; op: string; value: number }
  | { kind: 'boolean-is'; fact: string; value: boolean }
  | { kind: 'path-class-any'; values: string[] }
  | { kind: 'json'; raw: string }

export interface RuleDraft {
  ruleId: string
  when: PredicateDraft[]
  /** actionPriority 的 capabilityId 或 employeeSelection 的 employeeRef。 */
  target: string
}

export function predicateToDraft(raw: unknown): PredicateDraft {
  if (raw !== null && typeof raw === 'object' && 'kind' in raw) {
    const kind = (raw as { kind: unknown }).kind
    if (typeof kind === 'string' && (LEAF_PREDICATE_KINDS as readonly string[]).includes(kind)) {
      return raw as PredicateDraft
    }
  }
  return { kind: 'json', raw: JSON.stringify(raw, null, 2) }
}

/** 编辑态 → 序列化谓词。JSON 行 parse 失败返回 Error（阻止保存并定位）。 */
export function draftToPredicate(draft: PredicateDraft): unknown | Error {
  if (draft.kind === 'json') {
    try {
      return JSON.parse(draft.raw)
    } catch {
      return new Error('invalid predicate JSON')
    }
  }
  return draft
}

export function rulesToDrafts(
  rules: readonly { ruleId: string; when: readonly unknown[] }[],
  targetOf: (rule: unknown) => string,
): RuleDraft[] {
  return rules.map((rule) => ({
    ruleId: rule.ruleId,
    when: rule.when.map(predicateToDraft),
    target: targetOf(rule),
  }))
}

function defaultPredicate(): PredicateDraft {
  return { kind: 'boolean-is', fact: 'requirement.bundleComplete', value: true }
}

function retargetPredicate(draft: PredicateDraft, kind: LeafPredicateKind): PredicateDraft {
  const fact = 'fact' in draft ? draft.fact : 'requirement.bundleComplete'
  switch (kind) {
    case 'enum-equals': {
      const entry = factEntry(fact)
      const first = entry?.vocabulary?.[0] ?? ''
      return { kind, fact, value: first }
    }
    case 'enum-in':
      return { kind, fact, values: [] }
    case 'set-contains-any':
    case 'set-contains-all':
      return { kind, fact, values: [] }
    case 'number-compare':
      return { kind, fact, op: 'gte', value: 0 }
    case 'boolean-is':
      return { kind, fact, value: true }
    case 'path-class-any':
      return { kind, values: [] }
  }
}

function PredicateEditor(props: {
  value: PredicateDraft
  onChange: (next: PredicateDraft) => void
  onRemove: () => void
  testid: string
}): ReactElement {
  const { t } = useTranslation()
  const draft = props.value
  const factOptions = useMemo(
    () => POLICY_FACT_CATALOG.map((entry) => ({ value: entry.id, label: entry.id })),
    [],
  )

  if (draft.kind === 'json') {
    return (
      <div className="policy-builder__predicate" data-testid={props.testid}>
        <Field label={t('code.policies.predicateJson')} hint={t('code.policies.predicateJsonHint')}>
          <TextArea
            value={draft.raw}
            onChange={(raw) => props.onChange({ kind: 'json', raw })}
            rows={4}
            monospace
            data-testid={`${props.testid}-json`}
          />
        </Field>
        <button type="button" className="btn btn--xs btn--danger" onClick={props.onRemove}>
          {t('code.policies.removePredicate')}
        </button>
      </div>
    )
  }

  const entry = 'fact' in draft ? factEntry(draft.fact) : undefined
  return (
    <div className="policy-builder__predicate" data-testid={props.testid}>
      <div className="policy-builder__predicate-row">
        <Select
          value={draft.kind}
          options={LEAF_PREDICATE_KINDS.map((kind) => ({ value: kind, label: kind }))}
          onChange={(kind) => props.onChange(retargetPredicate(draft, kind))}
          aria-label={t('code.policies.predicateKind')}
          data-testid={`${props.testid}-kind`}
        />
        {'fact' in draft ? (
          <Select
            value={draft.fact}
            options={factOptions}
            onChange={(fact) => {
              if (draft.kind === 'enum-equals') {
                const first = factEntry(fact)?.vocabulary?.[0] ?? ''
                props.onChange({ ...draft, fact, value: first })
              } else {
                props.onChange({ ...draft, fact })
              }
            }}
            aria-label={t('code.policies.predicateFact')}
            data-testid={`${props.testid}-fact`}
          />
        ) : null}
        {draft.kind === 'enum-equals' ? (
          entry?.vocabulary != null && entry.vocabulary.length > 0 ? (
            <Select
              value={draft.value}
              options={entry.vocabulary.map((v) => ({ value: v, label: v }))}
              onChange={(value) => props.onChange({ ...draft, value })}
              aria-label={t('code.policies.predicateValue')}
              data-testid={`${props.testid}-value`}
            />
          ) : (
            <TextInput
              value={draft.value}
              onChange={(value) => props.onChange({ ...draft, value })}
              aria-label={t('code.policies.predicateValue')}
              data-testid={`${props.testid}-value`}
            />
          )
        ) : null}
        {draft.kind === 'number-compare' ? (
          <>
            <Select
              value={draft.op}
              options={NUMBER_COMPARE_OPS.map((op) => ({ value: op, label: op }))}
              onChange={(op) => props.onChange({ ...draft, op })}
              aria-label={t('code.policies.predicateOp')}
            />
            <NumberInput
              value={draft.value}
              onChange={(value) => props.onChange({ ...draft, value: value ?? 0 })}
              aria-label={t('code.policies.predicateValue')}
            />
          </>
        ) : null}
        {draft.kind === 'boolean-is' ? (
          <Select
            value={draft.value ? 'true' : 'false'}
            options={[
              { value: 'true', label: 'true' },
              { value: 'false', label: 'false' },
            ]}
            onChange={(value) => props.onChange({ ...draft, value: value === 'true' })}
            aria-label={t('code.policies.predicateValue')}
            data-testid={`${props.testid}-value`}
          />
        ) : null}
        <button
          type="button"
          className="btn btn--xs btn--danger"
          onClick={props.onRemove}
          aria-label={t('code.policies.removePredicate')}
        >
          ×
        </button>
      </div>
      {draft.kind === 'enum-in' ||
      draft.kind === 'set-contains-any' ||
      draft.kind === 'set-contains-all' ||
      draft.kind === 'path-class-any' ? (
        <ChipsInput
          value={[...draft.values]}
          onChange={(values) => props.onChange({ ...draft, values })}
          placeholder={t('code.policies.predicateValuesPlaceholder')}
          testidPrefix={`${props.testid}-values`}
        />
      ) : null}
    </div>
  )
}

export function PolicyRuleBuilder(props: {
  mode: 'action' | 'selection'
  rules: RuleDraft[]
  onChange: (next: RuleDraft[]) => void
  testidPrefix: string
}): ReactElement {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<number | null>(null)

  const update = (index: number, next: RuleDraft): void => {
    const copy = [...props.rules]
    copy[index] = next
    props.onChange(copy)
  }
  const move = (index: number, delta: number): void => {
    const target = index + delta
    if (target < 0 || target >= props.rules.length) return
    const copy = [...props.rules]
    const [row] = copy.splice(index, 1)
    copy.splice(target, 0, row!)
    props.onChange(copy)
  }

  return (
    <div className="policy-builder" data-testid={props.testidPrefix}>
      <p className="page__hint">{t('code.policies.firstMatchHint')}</p>
      {props.rules.length === 0 ? <p className="page__hint">{t('code.policies.noRules')}</p> : null}
      <ol className="policy-builder__rules">
        {props.rules.map((rule, index) => (
          <li
            key={index}
            className="policy-builder__rule"
            data-testid={`${props.testidPrefix}-rule-${index}`}
          >
            <div className="policy-builder__rule-head">
              <span className="policy-builder__order">#{index + 1}</span>
              <TextInput
                value={rule.ruleId}
                onChange={(ruleId) => update(index, { ...rule, ruleId })}
                placeholder={t('code.policies.ruleIdPlaceholder')}
                aria-label={t('code.policies.ruleId')}
                data-testid={`${props.testidPrefix}-rule-${index}-id`}
              />
              {props.mode === 'action' ? (
                <Select
                  value={rule.target}
                  options={AGENT_CAPABILITY_IDS.map((id) => ({ value: id, label: id }))}
                  onChange={(target) => update(index, { ...rule, target })}
                  aria-label={t('code.policies.capability')}
                  data-testid={`${props.testidPrefix}-rule-${index}-capability`}
                />
              ) : (
                <TextInput
                  value={rule.target}
                  onChange={(target) => update(index, { ...rule, target })}
                  placeholder={t('code.policies.employeeRefPlaceholder')}
                  aria-label={t('code.policies.employeeRef')}
                  data-testid={`${props.testidPrefix}-rule-${index}-employee`}
                />
              )}
              <div className="policy-builder__rule-actions">
                <button
                  type="button"
                  className="btn btn--xs"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  aria-label={t('code.policies.moveUp')}
                  data-testid={`${props.testidPrefix}-rule-${index}-up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn btn--xs"
                  disabled={index === props.rules.length - 1}
                  onClick={() => move(index, 1)}
                  aria-label={t('code.policies.moveDown')}
                  data-testid={`${props.testidPrefix}-rule-${index}-down`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="btn btn--xs"
                  onClick={() => setExpanded(expanded === index ? null : index)}
                  data-testid={`${props.testidPrefix}-rule-${index}-toggle`}
                >
                  {t('code.policies.predicatesN', { n: rule.when.length })}
                </button>
                <button
                  type="button"
                  className="btn btn--xs btn--danger"
                  onClick={() => props.onChange(props.rules.filter((_, i) => i !== index))}
                  aria-label={t('code.policies.removeRule')}
                  data-testid={`${props.testidPrefix}-rule-${index}-remove`}
                >
                  ×
                </button>
              </div>
            </div>
            {expanded === index ? (
              <div className="policy-builder__predicates">
                {rule.when.map((predicate, pIndex) => (
                  <PredicateEditor
                    key={pIndex}
                    value={predicate}
                    onChange={(next) =>
                      update(index, {
                        ...rule,
                        when: rule.when.map((p, i) => (i === pIndex ? next : p)),
                      })
                    }
                    onRemove={() =>
                      update(index, { ...rule, when: rule.when.filter((_, i) => i !== pIndex) })
                    }
                    testid={`${props.testidPrefix}-rule-${index}-pred-${pIndex}`}
                  />
                ))}
                <button
                  type="button"
                  className="btn btn--xs"
                  onClick={() =>
                    update(index, { ...rule, when: [...rule.when, defaultPredicate()] })
                  }
                  data-testid={`${props.testidPrefix}-rule-${index}-add-pred`}
                >
                  {t('code.policies.addPredicate')}
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      <button
        type="button"
        className="btn btn--sm"
        onClick={() =>
          props.onChange([
            ...props.rules,
            {
              ruleId: `rule-${props.rules.length + 1}`,
              when: [defaultPredicate()],
              target: props.mode === 'action' ? 'change.implement' : '',
            },
          ])
        }
        data-testid={`${props.testidPrefix}-add-rule`}
      >
        {t('code.policies.addRule')}
      </button>
    </div>
  )
}
