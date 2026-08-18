// RFC-310 PR-8 T87/T88 —— AutomationPolicy 详情：分段编辑器 + publish + 模拟。
//
// 三页签：规则（actionPriority first-match builder + employeeSelection 变体 +
// fixed guards 只读表——「守卫先于规则」是产品宪法，无处可配）、设置（其余
// 段的字段级编辑；requirement 段嵌套过深以 JSON 如实呈现与编辑）、模拟
// （T88：fixture → 与生产同一求值器 → exact DecisionTrace）。发布失败的
// violations（duplicate-rule-id/predicate-invalid/…）逐条落地给人看，不吞进
// 一句「校验失败」。编辑态在本地，显式保存（PUT draft）；发布产 immutable
// revision（运行中 mission 仍 pin 旧 revision——页面顶栏如实标注）。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, Link } from '@tanstack/react-router'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api, ApiError } from '@/api/client'
import { ErrorBanner } from '@/components/ErrorBanner'
import { ChipsInput } from '@/components/ChipsInput'
import { Field, NumberInput, Switch, TextArea, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'
import {
  PolicyRuleBuilder,
  draftToPredicate,
  rulesToDrafts,
  type RuleDraft,
} from '@/components/code/PolicyRuleBuilder'
import { PolicySimulator } from '@/components/code/PolicySimulator'
import {
  defaultPolicyTemplate,
  FIXED_GUARD_ORDER,
  POLICY_HARD_CAPS,
} from '@/data/policyFactCatalog'
import { usePermission } from '@/hooks/useActor'
import { Route as RootRoute } from './__root'
import type { PolicyIdentity } from './code.policies'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/code/policies/$policyId',
  component: PolicyDetailPage,
})

type PolicyDetail = PolicyIdentity & { draft: unknown }

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** raw draft 深合并到默认模板：编辑器面对的永远是完整形状（缺段补默认）。 */
function normalizeContent(raw: unknown): Obj {
  const base = defaultPolicyTemplate()
  if (!isObj(raw)) return base
  const merge = (target: Obj, source: Obj): Obj => {
    const out: Obj = { ...target }
    for (const [key, value] of Object.entries(source)) {
      out[key] = isObj(value) && isObj(out[key]) ? merge(out[key] as Obj, value) : value
    }
    return out
  }
  return merge(base, raw)
}

interface PublishViolation {
  code: string
  where: string
  detail: string
}

function violationsOf(error: unknown): PublishViolation[] {
  if (error instanceof ApiError && isObj(error.details)) {
    const list = (error.details as { violations?: unknown }).violations
    if (Array.isArray(list)) {
      return list.filter(
        (v): v is PublishViolation =>
          isObj(v) && typeof v.code === 'string' && typeof v.detail === 'string',
      )
    }
  }
  return []
}

type Tab = 'rules' | 'settings' | 'simulate'

function PolicyDetailPage(): ReactElement {
  const { t } = useTranslation()
  const { policyId } = Route.useParams()
  const qc = useQueryClient()
  const canUpdate = usePermission('automation-policies:update')

  const detail = useQuery<PolicyDetail>({
    queryKey: ['code-policy', policyId],
    queryFn: ({ signal }) =>
      api.get(`/api/code/automation-policies/${encodeURIComponent(policyId)}`, undefined, signal),
  })

  const [tab, setTab] = useState<Tab>('rules')
  const [content, setContent] = useState<Obj | null>(null)
  const [actionRules, setActionRules] = useState<RuleDraft[]>([])
  const [selectionRules, setSelectionRules] = useState<RuleDraft[]>([])
  const [requirementJson, setRequirementJson] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // 服务端 draft → 编辑态（首载与外部刷新；本地有未保存改动时不覆盖）。
  useEffect(() => {
    if (detail.data === undefined || dirty) return
    const normalized = normalizeContent(detail.data.draft)
    setContent(normalized)
    const ap = (normalized.actionPriority as Obj | undefined)?.rules
    setActionRules(
      rulesToDrafts(
        Array.isArray(ap) ? (ap as { ruleId: string; when: unknown[] }[]) : [],
        (rule) => String((rule as Obj).capabilityId ?? ''),
      ),
    )
    const es = (normalized.employeeSelection as Obj | undefined)?.rules
    setSelectionRules(
      rulesToDrafts(
        Array.isArray(es) ? (es as { ruleId: string; when: unknown[] }[]) : [],
        (rule) => String((rule as Obj).employeeRef ?? ''),
      ),
    )
    setRequirementJson(JSON.stringify(normalized.requirement, null, 2))
  }, [detail.data, dirty])

  const touch = (): void => setDirty(true)
  const patchSection = (section: string, patch: Obj): void => {
    setContent((prev) =>
      prev === null ? prev : { ...prev, [section]: { ...(prev[section] as Obj), ...patch } },
    )
    touch()
  }

  /** 编辑态 → 序列化 content（谓词/JSON 段 parse 失败返回 Error）。 */
  const assemble = (): Obj | Error => {
    if (content === null) return new Error('not loaded')
    const serializeRules = (
      drafts: RuleDraft[],
      key: 'capabilityId' | 'employeeRef',
    ): unknown[] | Error => {
      const out: unknown[] = []
      for (const rule of drafts) {
        const when: unknown[] = []
        for (const predicate of rule.when) {
          const serialized = draftToPredicate(predicate)
          if (serialized instanceof Error) {
            return new Error(t('code.policies.predicateJsonError', { rule: rule.ruleId }))
          }
          when.push(serialized)
        }
        out.push({ ruleId: rule.ruleId, when, [key]: rule.target })
      }
      return out
    }
    const action = serializeRules(actionRules, 'capabilityId')
    if (action instanceof Error) return action
    const selection = serializeRules(selectionRules, 'employeeRef')
    if (selection instanceof Error) return selection
    let requirement: unknown
    try {
      requirement = JSON.parse(requirementJson)
    } catch {
      return new Error(t('code.policies.requirementJsonError'))
    }
    return {
      ...content,
      requirement,
      actionPriority: { rules: action },
      employeeSelection: { rules: selection },
    }
  }

  const save = useMutation({
    mutationFn: async () => {
      const assembled = assemble()
      if (assembled instanceof Error) throw assembled
      await api.put(`/api/code/automation-policies/${encodeURIComponent(policyId)}`, {
        draft: assembled,
      })
    },
    onSuccess: () => {
      setDirty(false)
      setSaveError(null)
      void qc.invalidateQueries({ queryKey: ['code-policy', policyId] })
    },
    onError: (error) => setSaveError(error instanceof Error ? error.message : String(error)),
  })

  const publish = useMutation({
    mutationFn: () =>
      api.post<{ revision: number }>(
        `/api/code/automation-policies/${encodeURIComponent(policyId)}/publish`,
        {},
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['code-policy', policyId] })
      void qc.invalidateQueries({ queryKey: ['code-policies'] })
    },
  })
  const publishViolations = useMemo(() => violationsOf(publish.error), [publish.error])

  if (detail.isLoading) return <LoadingState />
  if (detail.isError) return <ErrorBanner error={detail.error} />
  const policy = detail.data
  if (policy === undefined || content === null) return <LoadingState />

  return (
    <div className="page">
      <PageHeader
        title={policy.name}
        back={<Link to="/code/policies">{t('code.policies.backToList')}</Link>}
        actions={
          canUpdate ? (
            <div className="page__actions">
              <button
                type="button"
                className="btn btn--sm"
                disabled={!dirty || save.isPending}
                onClick={() => save.mutate()}
                data-testid="policy-save"
              >
                {dirty ? t('code.policies.save') : t('code.policies.saved')}
              </button>
              <button
                type="button"
                className="btn btn--sm btn--primary"
                disabled={dirty || publish.isPending}
                onClick={() => publish.mutate()}
                data-testid="policy-publish"
                title={dirty ? t('code.policies.publishNeedsSave') : undefined}
              >
                {t('code.policies.publish')}
              </button>
            </div>
          ) : null
        }
      >
        <p className="page__subtitle">
          {policy.publishedRevision === null
            ? t('code.policies.neverPublished')
            : t('code.policies.publishedAt', { n: policy.publishedRevision })}
        </p>
      </PageHeader>

      {saveError !== null ? <ErrorBanner error={new Error(saveError)} /> : null}
      {publish.isError && publishViolations.length === 0 ? (
        <ErrorBanner error={publish.error} />
      ) : null}
      {publishViolations.length > 0 ? (
        <section className="page__section" data-testid="policy-violations">
          <h3>{t('code.policies.violationsTitle')}</h3>
          <ul>
            {publishViolations.map((violation, index) => (
              <li key={index}>
                <StatusChip kind="danger" size="sm">
                  {violation.code}
                </StatusChip>{' '}
                <code>{violation.where}</code> — {violation.detail}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Segmented
        value={tab}
        onChange={setTab}
        options={[
          { value: 'rules', label: t('code.policies.tabRules') },
          { value: 'settings', label: t('code.policies.tabSettings') },
          { value: 'simulate', label: t('code.policies.tabSimulate') },
        ]}
        ariaLabel={t('code.policies.tabsLabel')}
      />

      {tab === 'rules' ? (
        <>
          <section className="page__section">
            <h3>{t('code.policies.fixedGuardsTitle')}</h3>
            <p className="page__hint">{t('code.policies.fixedGuardsHint')}</p>
            <ol className="policy-builder__guards" data-testid="policy-fixed-guards">
              {FIXED_GUARD_ORDER.map((guard) => (
                <li key={guard}>
                  <code>{guard}</code>
                </li>
              ))}
            </ol>
          </section>
          <section className="page__section">
            <h3>{t('code.policies.actionRulesTitle')}</h3>
            <PolicyRuleBuilder
              mode="action"
              rules={actionRules}
              onChange={(next) => {
                setActionRules(next)
                touch()
              }}
              testidPrefix="policy-action"
            />
          </section>
          <section className="page__section">
            <h3>{t('code.policies.selectionRulesTitle')}</h3>
            <p className="page__hint">{t('code.policies.selectionRulesHint')}</p>
            <PolicyRuleBuilder
              mode="selection"
              rules={selectionRules}
              onChange={(next) => {
                setSelectionRules(next)
                touch()
              }}
              testidPrefix="policy-selection"
            />
          </section>
        </>
      ) : null}

      {tab === 'settings' ? (
        <SettingsSections
          content={content}
          patchSection={patchSection}
          requirementJson={requirementJson}
          onRequirementJson={(next) => {
            setRequirementJson(next)
            touch()
          }}
        />
      ) : null}

      {tab === 'simulate' ? <PolicySimulator actionRules={actionRules} /> : null}
    </div>
  )
}

function SettingsSections(props: {
  content: Obj
  patchSection: (section: string, patch: Obj) => void
  requirementJson: string
  onRequirementJson: (next: string) => void
}): ReactElement {
  const { t } = useTranslation()
  const { content, patchSection } = props
  const admission = content.admission as Obj
  const feedback = content.feedback as Obj
  const pipeline = content.pipeline as Obj
  const conflict = content.conflict as Obj
  const delivery = content.delivery as Obj
  const verification = content.verification as Obj
  const retry = content.retry as Obj
  const readiness = content.readiness as Obj
  const notification = content.notification as Obj
  const retention = content.retention as Obj
  const gates = Array.isArray(pipeline.gates) ? (pipeline.gates as Obj[]) : []

  const toggleArrayValue = (values: unknown, value: string): string[] => {
    const list = Array.isArray(values) ? values.map(String) : []
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
  }

  return (
    <>
      <section className="page__section">
        <h3>{t('code.policies.secAdmission')}</h3>
        <Switch
          checked={
            Array.isArray(admission.allowedSubmissionKinds) &&
            (admission.allowedSubmissionKinds as unknown[]).includes('direct')
          }
          onChange={() =>
            patchSection('admission', {
              allowedSubmissionKinds: toggleArrayValue(admission.allowedSubmissionKinds, 'direct'),
            })
          }
          label={t('code.policies.admissionDirect')}
        />
        <Switch
          checked={
            Array.isArray(admission.allowedSubmissionKinds) &&
            (admission.allowedSubmissionKinds as unknown[]).includes('external-reference')
          }
          onChange={() =>
            patchSection('admission', {
              allowedSubmissionKinds: toggleArrayValue(
                admission.allowedSubmissionKinds,
                'external-reference',
              ),
            })
          }
          label={t('code.policies.admissionExternal')}
        />
        <Field label={t('code.policies.admissionDuplicate')}>
          <Select
            value={String(admission.duplicateExternalIdDisposition)}
            options={['reuse-active', 'new-generation', 'reject'].map((v) => ({
              value: v,
              label: v,
            }))}
            onChange={(v) => patchSection('admission', { duplicateExternalIdDisposition: v })}
          />
        </Field>
      </section>

      <section className="page__section">
        <h3>{t('code.policies.secFeedback')}</h3>
        {(['human', 'bot', 'self'] as const).map((cls) => (
          <Switch
            key={cls}
            checked={
              Array.isArray(feedback.allowedAuthorClasses) &&
              (feedback.allowedAuthorClasses as unknown[]).includes(cls)
            }
            onChange={() =>
              patchSection('feedback', {
                allowedAuthorClasses: toggleArrayValue(feedback.allowedAuthorClasses, cls),
              })
            }
            label={t('code.policies.feedbackClass', { cls })}
          />
        ))}
        <Field label={t('code.policies.feedbackBatch')}>
          <NumberInput
            value={Number(feedback.batchLimit)}
            onChange={(v) => patchSection('feedback', { batchLimit: v ?? 1 })}
            min={1}
            max={POLICY_HARD_CAPS.feedbackBatchLimit}
          />
        </Field>
        <Switch
          checked={feedback.requireLatestRevision === true}
          onChange={(v) => patchSection('feedback', { requireLatestRevision: v })}
          label={t('code.policies.feedbackLatest')}
        />
      </section>

      <section className="page__section">
        <h3>{t('code.policies.secPipeline')}</h3>
        <Field label={t('code.policies.pipelineStale')}>
          <NumberInput
            value={Number(pipeline.evidenceStaleAfterMs)}
            onChange={(v) => patchSection('pipeline', { evidenceStaleAfterMs: v ?? 0 })}
            min={0}
            max={POLICY_HARD_CAPS.missionWallTimeMs}
          />
        </Field>
        {gates.map((gate, index) => (
          <div className="policy-builder__gate" key={index} data-testid={`policy-gate-${index}`}>
            <TextInput
              value={String(gate.gateKey ?? '')}
              onChange={(gateKey) =>
                patchSection('pipeline', {
                  gates: gates.map((g, i) => (i === index ? { ...g, gateKey } : g)),
                })
              }
              placeholder={t('code.policies.gateKey')}
              aria-label={t('code.policies.gateKey')}
            />
            <Switch
              checked={gate.required === true}
              onChange={(required) =>
                patchSection('pipeline', {
                  gates: gates.map((g, i) => (i === index ? { ...g, required } : g)),
                })
              }
              label={t('code.policies.gateRequired')}
            />
            <Select
              value={String(gate.missingRunDisposition ?? 'observe-only')}
              options={['observe-only', 'trigger-if-missing'].map((v) => ({ value: v, label: v }))}
              onChange={(missingRunDisposition) =>
                patchSection('pipeline', {
                  gates: gates.map((g, i) => (i === index ? { ...g, missingRunDisposition } : g)),
                })
              }
              aria-label={t('code.policies.gateDisposition')}
            />
            <ChipsInput
              value={
                Array.isArray(gate.rerunnableCategories)
                  ? (gate.rerunnableCategories as string[])
                  : []
              }
              onChange={(rerunnableCategories) =>
                patchSection('pipeline', {
                  gates: gates.map((g, i) => (i === index ? { ...g, rerunnableCategories } : g)),
                })
              }
              placeholder={t('code.policies.gateCategories')}
            />
            <NumberInput
              value={Number(gate.maxReruns ?? 0)}
              onChange={(maxReruns) =>
                patchSection('pipeline', {
                  gates: gates.map((g, i) =>
                    i === index ? { ...g, maxReruns: maxReruns ?? 0 } : g,
                  ),
                })
              }
              min={0}
              max={POLICY_HARD_CAPS.pipelineRerunsPerGate}
              aria-label={t('code.policies.gateMaxReruns')}
            />
            <button
              type="button"
              className="btn btn--xs btn--danger"
              onClick={() =>
                patchSection('pipeline', { gates: gates.filter((_, i) => i !== index) })
              }
              aria-label={t('code.policies.gateRemove')}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn--xs"
          onClick={() =>
            patchSection('pipeline', {
              gates: [
                ...gates,
                {
                  gateKey: `gate-${gates.length + 1}`,
                  required: true,
                  missingRunDisposition: 'observe-only',
                  rerunnableCategories: [],
                  maxReruns: 1,
                  maxTriggers: 1,
                },
              ],
            })
          }
          data-testid="policy-gate-add"
        >
          {t('code.policies.gateAdd')}
        </button>
      </section>

      <section className="page__section">
        <h3>{t('code.policies.secConflict')}</h3>
        <Field label={t('code.policies.conflictMode')}>
          <Select
            value={String(conflict.mode)}
            options={['report-only', 'repair'].map((v) => ({ value: v, label: v }))}
            onChange={(mode) => patchSection('conflict', { mode })}
            data-testid="policy-conflict-mode"
          />
        </Field>
        <Field label={t('code.policies.conflictAttempts')}>
          <NumberInput
            value={Number(conflict.maxRepairAttempts)}
            onChange={(v) => patchSection('conflict', { maxRepairAttempts: v ?? 0 })}
            min={0}
            max={POLICY_HARD_CAPS.conflictRepairAttempts}
          />
        </Field>
      </section>

      <section className="page__section">
        <h3>{t('code.policies.secDelivery')}</h3>
        <Field label={t('code.policies.deliveryPrefix')}>
          <TextInput
            value={String(delivery.sourceBranchPrefix)}
            onChange={(v) => patchSection('delivery', { sourceBranchPrefix: v })}
          />
        </Field>
        <Field label={t('code.policies.deliveryCollision')}>
          <Select
            value={String(delivery.sourceBranchCollision)}
            options={['deterministic-suffix', 'block'].map((v) => ({ value: v, label: v }))}
            onChange={(v) => patchSection('delivery', { sourceBranchCollision: v })}
          />
        </Field>
        <Switch
          checked={delivery.draft === true}
          onChange={(v) => patchSection('delivery', { draft: v })}
          label={t('code.policies.deliveryDraft')}
        />
        <Field label={t('code.policies.deliveryHumanPush')}>
          <Select
            value={String(delivery.remoteHumanPushDisposition)}
            options={['restart-action-from-new-head', 'handoff'].map((v) => ({
              value: v,
              label: v,
            }))}
            onChange={(v) => patchSection('delivery', { remoteHumanPushDisposition: v })}
          />
        </Field>
      </section>

      <section className="page__section">
        <h3>{t('code.policies.secVerification')}</h3>
        <Field
          label={t('code.policies.verificationProfiles')}
          hint={t('code.policies.verificationProfilesHint')}
        >
          <ChipsInput
            value={
              Array.isArray(verification.requiredProfileRefs)
                ? (verification.requiredProfileRefs as string[])
                : []
            }
            onChange={(requiredProfileRefs) =>
              patchSection('verification', { requiredProfileRefs })
            }
            placeholder="profile-id@1"
            testidPrefix="policy-verification-profiles"
          />
        </Field>
        <Field label={t('code.policies.verificationStop')}>
          <Select
            value={String(verification.stopPolicy)}
            options={['first-failure', 'collect-all'].map((v) => ({ value: v, label: v }))}
            onChange={(stopPolicy) => patchSection('verification', { stopPolicy })}
          />
        </Field>
      </section>

      <section className="page__section">
        <h3>{t('code.policies.secRetry')}</h3>
        {(
          [
            ['sameSessionRetries', POLICY_HARD_CAPS.sameSessionRetries],
            ['freshSessionReruns', POLICY_HARD_CAPS.freshSessionReruns],
            ['actionRunsPerMission', POLICY_HARD_CAPS.actionRunsPerMission],
            ['commitsPerMission', POLICY_HARD_CAPS.commitsPerMission],
            ['missionWallTimeMs', POLICY_HARD_CAPS.missionWallTimeMs],
          ] as const
        ).map(([key, cap]) => (
          <Field key={key} label={t(`code.policies.retry_${key}`)} hint={`≤ ${cap}`}>
            <NumberInput
              value={Number(retry[key])}
              onChange={(v) => patchSection('retry', { [key]: v ?? 0 })}
              min={0}
              max={cap}
            />
          </Field>
        ))}
      </section>

      <section className="page__section">
        <h3>{t('code.policies.secReadiness')}</h3>
        <Field label={t('code.policies.readinessGates')}>
          <ChipsInput
            value={
              Array.isArray(readiness.additionalRequiredGateKeys)
                ? (readiness.additionalRequiredGateKeys as string[])
                : []
            }
            onChange={(additionalRequiredGateKeys) =>
              patchSection('readiness', { additionalRequiredGateKeys })
            }
            placeholder="gate-key"
          />
        </Field>
        <Switch
          checked={readiness.unresolvedFeedbackBlocksReady === true}
          onChange={(v) => patchSection('readiness', { unresolvedFeedbackBlocksReady: v })}
          label={t('code.policies.readinessFeedback')}
        />
      </section>

      <section className="page__section">
        <h3>{t('code.policies.secNotification')}</h3>
        <Field label={t('code.policies.notificationOverview')}>
          <Select
            value={String(notification.overviewComment)}
            options={['off', 'reuse-single'].map((v) => ({ value: v, label: v }))}
            onChange={(overviewComment) => patchSection('notification', { overviewComment })}
          />
        </Field>
        <Field label={t('code.policies.notificationEscalation')}>
          <NumberInput
            value={Number(notification.escalationIntervalMs)}
            onChange={(v) => patchSection('notification', { escalationIntervalMs: v ?? 0 })}
            min={0}
            max={POLICY_HARD_CAPS.missionWallTimeMs}
          />
        </Field>
      </section>

      <section className="page__section">
        <h3>{t('code.policies.secRetention')}</h3>
        {(
          [
            'requirementBundleTerminalTtlDays',
            'pipelineBundleTerminalTtlDays',
            'attemptLedgerTtlDays',
          ] as const
        ).map((key) => (
          <Field key={key} label={t(`code.policies.retention_${key}`)}>
            <NumberInput
              value={Number(retention[key])}
              onChange={(v) => patchSection('retention', { [key]: v ?? 1 })}
              min={1}
              max={POLICY_HARD_CAPS.retentionDays}
            />
          </Field>
        ))}
      </section>

      <section className="page__section">
        <h3>{t('code.policies.secRequirement')}</h3>
        <Field
          label={t('code.policies.requirementJson')}
          hint={t('code.policies.requirementJsonHint')}
        >
          <TextArea
            value={props.requirementJson}
            onChange={props.onRequirementJson}
            rows={16}
            monospace
            data-testid="policy-requirement-json"
          />
        </Field>
      </section>
    </>
  )
}
