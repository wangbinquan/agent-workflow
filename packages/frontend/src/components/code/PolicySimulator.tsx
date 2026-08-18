// RFC-310 PR-8 T88 —— policy fixture simulator 与 exact DecisionTrace。
//
// 与生产同一纯求值器（POST preview-decision 直通 evaluatePolicy）：guards
// fixture + cells fixture + 当前编辑中的 actionPriority 规则 → guard trace
// 逐条（pass/stop）、rule trace 逐条（matched/miss）、selected 决策高亮。
// no-match（守卫全过但没有规则命中）是一条明确诊断而不是空白——它就是
// 生产里 mission 会 block('no-policy-match') 的形态。preview-selection 面板
// 用同一份 cells 模拟员工选择。

import { useMutation } from '@tanstack/react-query'
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, Switch, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'
import { defaultGuardFixture, factEntry, POLICY_FACT_CATALOG } from '@/data/policyFactCatalog'
import { draftToPredicate, type RuleDraft } from './PolicyRuleBuilder'

interface CellRow {
  fact: string
  value: string
}

interface GuardTraceNode {
  guard: string
  outcome: 'pass' | 'stop'
  detail: string | null
}
interface RuleTraceNode {
  ruleId: string
  matched: boolean
  stoppedOn: string | null
}
interface PreviewResult {
  selected: Record<string, unknown> & { kind: string }
  selectedBy: 'guard' | 'rule' | 'no-match'
  matchedRuleId: string | null
  guardTrace: GuardTraceNode[]
  ruleTrace: RuleTraceNode[]
}

function cellValueOf(fact: string, raw: string): unknown {
  const entry = factEntry(fact)
  if (entry === undefined) return raw
  if (entry.type === 'boolean') return raw.trim() === 'true'
  if (entry.type === 'number') return Number(raw)
  if (entry.type === 'string-set') {
    return raw
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0)
  }
  return raw
}

export function PolicySimulator(props: { actionRules: RuleDraft[] }): ReactElement {
  const { t } = useTranslation()
  const [guards, setGuards] = useState<Record<string, unknown>>(defaultGuardFixture)
  const [cells, setCells] = useState<CellRow[]>([
    { fact: 'requirement.bundleComplete', value: 'true' },
  ])
  const [employeeRef, setEmployeeRef] = useState('')

  const setGuard = (key: string, value: unknown): void =>
    setGuards((prev) => ({ ...prev, [key]: value }))

  const buildCells = (): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const row of cells) {
      if (row.fact.trim() === '') continue
      out[row.fact] = {
        state: 'known',
        value: cellValueOf(row.fact, row.value),
        sourceRevision: 'fixture',
      }
    }
    return out
  }

  const preview = useMutation({
    mutationFn: async (): Promise<PreviewResult> => {
      const rules = props.actionRules.map((rule) => {
        const when = rule.when.map(draftToPredicate)
        const broken = when.find((p) => p instanceof Error)
        if (broken instanceof Error) throw new Error(`rule ${rule.ruleId}: ${broken.message}`)
        return {
          ruleId: rule.ruleId,
          when,
          decision: {
            kind: 'run-agent-action',
            capabilityId: rule.target,
            templateRef: 'pending-route',
            workSetRef: 'none',
          },
        }
      })
      return api.post('/api/code/automation-policies/preview-decision', {
        guards,
        cells: buildCells(),
        rules,
      })
    },
  })

  const selection = useMutation({
    mutationFn: async (): Promise<Record<string, unknown>> =>
      api.post('/api/code/digital-employees/preview-selection', {
        explicitEmployeeRef: employeeRef.trim() === '' ? null : employeeRef.trim(),
        assignment: null,
        explicitFallbackRef: null,
        cells: buildCells(),
      }),
  })

  return (
    <div className="policy-simulator" data-testid="policy-simulator">
      <section className="page__section">
        <h3>{t('code.policies.simGuards')}</h3>
        <div className="policy-simulator__guards">
          <Switch
            checked={guards.missionTerminal === true}
            onChange={(v) => setGuard('missionTerminal', v)}
            label={t('code.policies.simGuardTerminal')}
          />
          <Switch
            checked={guards.activeWritableAction === true}
            onChange={(v) => setGuard('activeWritableAction', v)}
            label={t('code.policies.simGuardActiveAction')}
          />
          <Switch
            checked={guards.unsettledEffect === true}
            onChange={(v) => setGuard('unsettledEffect', v)}
            label={t('code.policies.simGuardUnsettled')}
          />
          <Field label={t('code.policies.simGuardMrTerminal')}>
            <Select
              value={String(guards.mrTerminal)}
              options={['active', 'merged', 'closed', 'not-applicable'].map((v) => ({
                value: v,
                label: v,
              }))}
              onChange={(v) => setGuard('mrTerminal', v)}
              data-testid="sim-guard-mr-terminal"
            />
          </Field>
          <Field label={t('code.policies.simGuardMode')}>
            <Select
              value={String(guards.automationMode)}
              options={['active', 'tracking-only'].map((v) => ({ value: v, label: v }))}
              onChange={(v) => setGuard('automationMode', v)}
            />
          </Field>
          <Field label={t('code.policies.simGuardUploadSeed')}>
            <Select
              value={String(guards.uploadSeed)}
              options={['not-applicable', 'pending', 'seeded', 'published'].map((v) => ({
                value: v,
                label: v,
              }))}
              onChange={(v) => setGuard('uploadSeed', v)}
            />
          </Field>
        </div>
      </section>

      <section className="page__section">
        <h3>{t('code.policies.simCells')}</h3>
        <p className="page__hint">{t('code.policies.simCellsHint')}</p>
        {cells.map((row, index) => (
          <div className="policy-simulator__cell-row" key={index} data-testid={`sim-cell-${index}`}>
            <Select
              value={row.fact}
              options={POLICY_FACT_CATALOG.map((entry) => ({ value: entry.id, label: entry.id }))}
              onChange={(fact) =>
                setCells((prev) => prev.map((r, i) => (i === index ? { ...r, fact } : r)))
              }
              aria-label={t('code.policies.simCellFact')}
              data-testid={`sim-cell-${index}-fact`}
            />
            <TextInput
              value={row.value}
              onChange={(value) =>
                setCells((prev) => prev.map((r, i) => (i === index ? { ...r, value } : r)))
              }
              placeholder={t('code.policies.simCellValuePlaceholder')}
              aria-label={t('code.policies.simCellValue')}
              data-testid={`sim-cell-${index}-value`}
            />
            <button
              type="button"
              className="btn btn--xs btn--danger"
              onClick={() => setCells((prev) => prev.filter((_, i) => i !== index))}
              aria-label={t('code.policies.simCellRemove')}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn--xs"
          onClick={() => setCells((prev) => [...prev, { fact: 'repository.languages', value: '' }])}
          data-testid="sim-cell-add"
        >
          {t('code.policies.simCellAdd')}
        </button>
      </section>

      <section className="page__section">
        <button
          type="button"
          className="btn btn--sm btn--primary"
          disabled={preview.isPending}
          onClick={() => preview.mutate()}
          data-testid="sim-run"
        >
          {t('code.policies.simRun')}
        </button>
        {preview.isError ? <ErrorBanner error={preview.error} /> : null}
        {preview.data !== undefined ? <TraceView result={preview.data} /> : null}
      </section>

      <section className="page__section">
        <h3>{t('code.policies.simSelectionTitle')}</h3>
        <Field label={t('code.policies.simSelectionEmployee')}>
          <TextInput
            value={employeeRef}
            onChange={setEmployeeRef}
            placeholder="employee-id@3"
            data-testid="sim-selection-employee"
          />
        </Field>
        <button
          type="button"
          className="btn btn--sm"
          disabled={selection.isPending}
          onClick={() => selection.mutate()}
          data-testid="sim-selection-run"
        >
          {t('code.policies.simSelectionRun')}
        </button>
        {selection.isError ? <ErrorBanner error={selection.error} /> : null}
        {selection.data !== undefined ? (
          <pre className="policy-simulator__selection" data-testid="sim-selection-result">
            {JSON.stringify(selection.data, null, 2)}
          </pre>
        ) : null}
      </section>
    </div>
  )
}

function TraceView(props: { result: PreviewResult }): ReactElement {
  const { t } = useTranslation()
  const { result } = props
  return (
    <div className="policy-simulator__trace" data-testid="sim-trace">
      <div className="policy-simulator__selected" data-testid="sim-selected">
        <h4>{t('code.policies.simSelected')}</h4>
        <StatusChip
          kind={
            result.selectedBy === 'rule'
              ? 'success'
              : result.selectedBy === 'no-match'
                ? 'warn'
                : 'info'
          }
          size="sm"
        >
          {result.selectedBy === 'no-match'
            ? t('code.policies.simNoMatch')
            : `${result.selected.kind} (${result.selectedBy}${
                result.matchedRuleId === null ? '' : `: ${result.matchedRuleId}`
              })`}
        </StatusChip>
        {result.selectedBy === 'no-match' ? (
          <p className="page__hint">{t('code.policies.simNoMatchHint')}</p>
        ) : null}
        <pre>{JSON.stringify(result.selected, null, 2)}</pre>
      </div>
      <div>
        <h4>{t('code.policies.simGuardTrace')}</h4>
        <ul className="policy-simulator__trace-list" data-testid="sim-guard-trace">
          {result.guardTrace.map((node, index) => (
            <li key={index}>
              <StatusChip kind={node.outcome === 'pass' ? 'success' : 'danger'} size="sm">
                {node.outcome}
              </StatusChip>{' '}
              {node.guard}
              {node.detail === null ? '' : ` — ${node.detail}`}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h4>{t('code.policies.simRuleTrace')}</h4>
        <ul className="policy-simulator__trace-list" data-testid="sim-rule-trace">
          {result.ruleTrace.length === 0 ? <li>{t('code.policies.simRuleTraceEmpty')}</li> : null}
          {result.ruleTrace.map((node, index) => (
            <li key={index}>
              <StatusChip kind={node.matched ? 'success' : 'neutral'} size="sm">
                {node.matched ? t('code.policies.simMatched') : t('code.policies.simMissed')}
              </StatusChip>{' '}
              {node.ruleId}
              {node.stoppedOn === null ? '' : ` — ${node.stoppedOn}`}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
