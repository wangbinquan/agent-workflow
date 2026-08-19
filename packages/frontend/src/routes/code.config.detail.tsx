// RFC-310 PR-8 T85/T86/T89 —— 配置资源详情：`/code/config/$kind/$id`。
//
// 同一骨架承载四族：identity 头（发布修订 / 可见性 / Publish / Archive /
// ACL）+ per-kind 只读摘要（员工的 capability routes / 模板的执行合同 /
// profile 的 steps 表 / adapter 的 purpose·operations·secret 名单）+ draft
// 编辑 Dialog（name + 常用字段结构化 + 完整 JSON——publish 的 zod/闭包校验
// 是合法性的最终裁判，violations 逐条示人）。adapter 的 executableRef /
// secretProjection 是 daemon 高危字段：无 `scripts:author` 时编辑入口整体
// 禁用（后端亦按字段强制，这里不给「填了也保存不了」的假入口）。secret
// projection 永远只显示 key 名，不显示任何值。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, Link } from '@tanstack/react-router'
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api, ApiError } from '@/api/client'
import { Card } from '@/components/Card'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextArea, TextInput } from '@/components/Form'
import { FormSection } from '@/components/FormSection'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { AclPanel } from '@/components/AclPanel'
import { usePermission } from '@/hooks/useActor'
import { DevelopmentConfigEditor } from '@/components/code/DevelopmentConfigEditor'
import { JourneyNextAction, type JourneyProjection } from '@/components/code/JourneyNextAction'
import {
  asRecord,
  asRecords,
  employeePresetOf,
  exactRef,
  triggerOf,
  type PublishedResourceOption,
} from '@/components/code/employeePlaybook'
import { CONFIG_KIND_SPECS, isConfigKind, type ConfigKind } from './code.config'
import { missionStatusKind, missionStatusLabel, type MissionSummary } from './code.missions'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/code/config/$kind/$id',
  component: ConfigDetailPage,
})

interface ConfigDetail {
  id: string
  name: string
  publishedRevision: number | null
  ownerUserId: string | null
  visibility: 'private' | 'public'
  createdAt: number
  updatedAt: number
  archivedAt: number | null
  capabilityId?: string
  purpose?: string
  draft: unknown
  playbook?: unknown
  readyToPublish?: boolean
  assignmentCount?: number
  violations?: PublishViolation[]
  journey?: JourneyProjection
}

interface PublishViolation {
  code: string
  where: string
  detail: string
}

/** publish 422 的 violations（ValidationError details 透传）。 */
export function publishViolationsOf(error: unknown): PublishViolation[] {
  if (!(error instanceof ApiError)) return []
  const details = error.details as { violations?: unknown } | undefined
  if (details === undefined || !Array.isArray(details.violations)) return []
  return details.violations.filter(
    (v): v is PublishViolation =>
      v !== null &&
      typeof v === 'object' &&
      typeof (v as { code?: unknown }).code === 'string' &&
      typeof (v as { detail?: unknown }).detail === 'string',
  )
}

function ConfigDetailPage(): ReactElement {
  const { t } = useTranslation()
  const params = Route.useParams()
  const kind: ConfigKind = isConfigKind(params.kind) ? params.kind : 'employees'
  const spec = CONFIG_KIND_SPECS[kind]
  const qc = useQueryClient()
  const canUpdate = usePermission(`${spec.permissionPrefix}:update`)
  const canArchive = usePermission(`${spec.permissionPrefix}:archive`)
  const canAuthorScripts = usePermission('scripts:author')
  // adapter 的 draft 含 executableRef/secretProjection（daemon 高危字段）：
  // 编辑入口要求 scripts:author（后端字段级强制的前端如实呈现）。
  const canEditDraft = canUpdate && (kind !== 'adapters' || canAuthorScripts)

  const detail = useQuery<ConfigDetail>({
    queryKey: ['code-config', kind, params.id],
    queryFn: async ({ signal }) => {
      const found = await api.get<ConfigDetail>(
        kind === 'employees'
          ? `${spec.apiBase}/${encodeURIComponent(params.id)}/playbook`
          : `${spec.apiBase}/${encodeURIComponent(params.id)}`,
        undefined,
        signal,
      )
      return kind === 'employees' && found.playbook !== undefined
        ? { ...found, draft: found.playbook }
        : found
    },
  })

  const [surface, setSurface] = useState<'edit' | 'acl' | 'archive' | null>(null)
  const publish = useMutation({
    mutationFn: () => api.post(`${spec.apiBase}/${encodeURIComponent(params.id)}/publish`, {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['code-config', kind] })
      void qc.invalidateQueries({ queryKey: ['code-config', kind, params.id] })
    },
  })
  const archive = useMutation({
    mutationFn: () => api.post(`${spec.apiBase}/${encodeURIComponent(params.id)}/archive`, {}),
    onSuccess: () => {
      setSurface(null)
      void qc.invalidateQueries({ queryKey: ['code-config', kind] })
      void qc.invalidateQueries({ queryKey: ['code-config', kind, params.id] })
    },
  })

  if (detail.isLoading) return <LoadingState />
  if (detail.isError) return <ErrorBanner error={detail.error} />
  const row = detail.data
  if (row === undefined) return <LoadingState />
  const publishViolations = publishViolationsOf(publish.error)

  return (
    <div className={`page page--operations code-config-detail code-config-detail--${kind}`}>
      <div className="operations-surface">
        <PageHeader
          title={row.name}
          className="operations-surface__header"
          meta={
            <>
              {row.publishedRevision === null ? (
                <StatusChip kind="warn" size="sm">
                  {t('code.config.notPublished')}
                </StatusChip>
              ) : (
                <StatusChip kind="success" size="sm">
                  v{row.publishedRevision}
                </StatusChip>
              )}{' '}
              {row.archivedAt !== null ? (
                <StatusChip kind="neutral" size="sm">
                  {t('code.config.archived')}
                </StatusChip>
              ) : null}
            </>
          }
          actions={
            <>
              {canEditDraft ? (
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => setSurface('edit')}
                  data-testid="config-edit-open"
                >
                  {t('code.config.edit')}
                </button>
              ) : null}
              {canUpdate ? (
                <button
                  type="button"
                  className="btn btn--sm btn--primary"
                  disabled={publish.isPending}
                  onClick={() => publish.mutate()}
                  data-testid="config-publish"
                >
                  {publish.isPending ? t('code.config.publishing') : t('code.config.publish')}
                </button>
              ) : null}
              {canUpdate ? (
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => setSurface('acl')}
                  data-testid="config-acl-open"
                >
                  {t('code.config.acl')}
                </button>
              ) : null}
              {canArchive && row.archivedAt === null ? (
                <button
                  type="button"
                  className="btn btn--sm btn--danger"
                  onClick={() => setSurface('archive')}
                  data-testid="config-archive-open"
                >
                  {t('code.config.archive')}
                </button>
              ) : null}
            </>
          }
        />

        <div className="employee-manual-panel">
          {kind === 'adapters' && canUpdate && !canAuthorScripts ? (
            <p className="page__subtitle" data-testid="config-scripts-author-hint">
              {t('code.config.scriptsAuthorHint')}
            </p>
          ) : null}

          {publish.isError && publishViolations.length === 0 ? (
            <ErrorBanner error={publish.error} />
          ) : null}
          {publishViolations.length > 0 ? (
            <Card title={t('code.config.publishBlocked')} data-testid="config-publish-violations">
              <ul>
                {publishViolations.map((v, index) => (
                  <li key={`${v.code}-${index}`}>
                    <code>{v.code}</code> — {v.where}: {v.detail}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {kind === 'employees' && row.journey !== undefined ? (
            <JourneyNextAction
              journey={row.journey}
              commandPending={publish.isPending}
              onCommand={(command) => {
                if (command === 'open-employee-editor') setSurface('edit')
                if (command === 'publish-employee') publish.mutate()
              }}
            />
          ) : null}

          <DraftSummary
            kind={kind}
            draft={row.draft}
            assignmentCount={row.assignmentCount ?? 0}
            readyToPublish={row.readyToPublish === true}
            violations={row.violations ?? []}
          />

          {kind === 'employees' ? <EmployeeOutcomeSummary employeeId={row.id} /> : null}

          {kind !== 'employees' || canAuthorScripts ? (
            <FormSection
              title={
                kind === 'employees'
                  ? t('code.employeePlaybook.technicalDetails')
                  : t('code.config.editor.advancedReadOnly')
              }
              collapsible
              data-testid="config-draft-advanced"
            >
              <pre className="prompt-preview__pre" data-testid="config-draft-json">
                {JSON.stringify(row.draft, null, 2)}
              </pre>
            </FormSection>
          ) : null}

          {surface === 'edit' ? (
            <EditDialog
              kind={kind}
              detail={row}
              onClose={() => setSurface(null)}
              onSaved={() => {
                setSurface(null)
                void qc.invalidateQueries({ queryKey: ['code-config', kind, params.id] })
                void qc.invalidateQueries({ queryKey: ['code-config', kind] })
              }}
            />
          ) : null}

          {surface === 'acl' ? (
            <Dialog open title={t('acl.title')} onClose={() => setSurface(null)}>
              <AclPanel
                resourceBaseUrl={`${spec.apiBase}/${encodeURIComponent(row.id)}`}
                invalidateKey={['code-config', kind]}
                onSaved={() => setSurface(null)}
                onCancel={() => setSurface(null)}
              />
            </Dialog>
          ) : null}

          <ConfirmDialog
            open={surface === 'archive'}
            onClose={() => setSurface(null)}
            title={t('code.config.archiveTitle')}
            description={t('code.config.archiveBody', { name: row.name })}
            confirmLabel={t('code.config.archive')}
            tone="danger"
            onConfirm={() => archive.mutate()}
          />
        </div>
      </div>
    </div>
  )
}

function EmployeeOutcomeSummary({ employeeId }: { employeeId: string }): ReactElement {
  const { t } = useTranslation()
  const missions = useQuery<{ items: MissionSummary[] }>({
    queryKey: ['code-missions'],
    queryFn: ({ signal }) => api.get('/api/code/missions', undefined, signal),
  })
  if (missions.isPending) return <LoadingState />
  if (missions.isError) return <ErrorBanner error={missions.error} />

  const mine = (missions.data?.items ?? []).filter((mission) => mission.employeeId === employeeId)
  const terminal = mine.filter((mission) =>
    ['merged', 'completed-no-change', 'closed-unmerged', 'canceled', 'failed'].includes(
      mission.status,
    ),
  )
  const active = mine.length - terminal.length
  const ready = mine.filter(
    (mission) => mission.status === 'ready-to-merge' || mission.status === 'waiting-committer',
  ).length
  const delivered = terminal.filter(
    (mission) => mission.status === 'merged' || mission.status === 'completed-no-change',
  ).length

  return (
    <Card
      title={t('code.outcomes.employeeSummaryTitle')}
      actions={
        <Link to="/outcomes" search={{ employee: employeeId }} className="btn btn--xs">
          {t('code.outcomes.employeeSummaryOpen')}
        </Link>
      }
      data-testid="employee-outcome-summary"
    >
      <p>{t('code.outcomes.employeeSummaryHint')}</p>
      <div className="employee-outcome-summary__counts">
        <span>
          <strong>{active}</strong>
          {t('code.outcomes.employeeActive')}
        </span>
        <span>
          <strong>{ready}</strong>
          {t('code.outcomes.employeeReady')}
        </span>
        <span>
          <strong>{delivered}</strong>
          {t('code.outcomes.employeeDelivered')}
        </span>
      </div>
      {terminal.length > 0 ? (
        <ul className="employee-outcome-summary__history">
          {terminal.slice(0, 5).map((mission) => (
            <li key={mission.id}>
              <Link to="/code/missions/$missionId" params={{ missionId: mission.id }}>
                {mission.id.slice(-8)}
              </Link>
              <StatusChip kind={missionStatusKind(mission.status)} size="sm">
                {missionStatusLabel(t, mission.status)}
              </StatusChip>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  )
}

// ---------------------------------------------------------------- summaries

function DraftSummary(props: {
  kind: ConfigKind
  draft: unknown
  assignmentCount: number
  readyToPublish: boolean
  violations: PublishViolation[]
}): ReactElement | null {
  const draft = (props.draft ?? {}) as Record<string, unknown>
  if (props.kind === 'employees') {
    return (
      <EmployeeSummary
        draft={draft}
        assignmentCount={props.assignmentCount}
        readyToPublish={props.readyToPublish}
        violations={props.violations}
      />
    )
  }
  if (props.kind === 'action-templates') return <TemplateSummary draft={draft} />
  if (props.kind === 'verification-profiles') return <ProfileSummary draft={draft} />
  return <AdapterSummary draft={draft} />
}

/**
 * 资源引用的显示文本。两种形态都要认：
 *   · 裸字符串 —— template 的 `agentRef` / `verificationProfileRef`、adapter 的
 *     `executableRef` 等（domain 里就是 `z.string()`）；
 *   · **versioned ref** `{ id, revision }` —— employee 的 `defaultPolicyRef`、
 *     `fallbackTemplateRef`、`adapterRef` 等（domain `versionedRef`）。
 *
 * 只认字符串的旧版有两个后果，实走 UI 时都撞到了：把对象塞进 `<code>{…}</code>`
 * 直接 React error #31 整页白屏；而走 refText 的那些位置则**静默显示成「—」**
 * ——用户看到"没绑定"，实际上绑定得好好的。后者更坏：不报错，只是说谎。
 */
function refText(value: unknown): string {
  if (typeof value === 'string') return value.length > 0 ? value : '—'
  if (value !== null && typeof value === 'object') {
    const ref = value as { id?: unknown; revision?: unknown }
    if (typeof ref.id === 'string' && ref.id.length > 0) {
      return typeof ref.revision === 'number' ? `${ref.id}@v${ref.revision}` : ref.id
    }
  }
  return '—'
}

function EmployeeSummary(props: {
  draft: Record<string, unknown>
  assignmentCount: number
  readyToPublish: boolean
  violations: PublishViolation[]
}): ReactElement {
  const { t } = useTranslation()
  const templates = useQuery<{ items: PublishedResourceOption[] }>({
    queryKey: ['code-config', 'action-templates'],
    queryFn: ({ signal }) => api.get('/api/code/action-templates', undefined, signal),
  })
  const employees = useQuery<{ items: PublishedResourceOption[] }>({
    queryKey: ['code-config', 'employees'],
    queryFn: ({ signal }) => api.get('/api/code/digital-employees', undefined, signal),
  })
  const policies = useQuery<{ items: PublishedResourceOption[] }>({
    queryKey: ['code-policies'],
    queryFn: ({ signal }) => api.get('/api/code/automation-policies', undefined, signal),
  })
  const adapters = useQuery<{ items: PublishedResourceOption[] }>({
    queryKey: ['code-config', 'adapters'],
    queryFn: ({ signal }) => api.get('/api/integrations/development-adapters', undefined, signal),
  })
  const steps = asRecords(props.draft.steps)
  const problemTypes = asRecords(props.draft.problemTypes)
  const problemProducers = asRecords(props.draft.problemProducers)
  const problemHandlers = asRecords(props.draft.problemHandlers)
  const sources = asRecords(props.draft.requirementSources)
  const providers = asRecords(props.draft.pipelineProviders)
  const resources = [
    ...(templates.data?.items ?? []),
    ...(employees.data?.items ?? []),
    ...(policies.data?.items ?? []),
    ...(adapters.data?.items ?? []),
  ]
  const nameOf = (value: unknown): string => {
    const id = exactRef(value)?.id
    return id === undefined
      ? t('code.employeePlaybook.unavailableResource')
      : (resources.find((resource) => resource.id === id)?.name ??
          t('code.employeePlaybook.unavailableResource'))
  }
  const text = (value: unknown, fallback = ''): string =>
    typeof value === 'string' ? value : fallback
  const stepName = (target: unknown): string => {
    const value = text(target, 'reconcile')
    const found = steps.find((step) => step.stepId === value)
    return found === undefined
      ? t(`code.employeePlaybook.target.${value}`, { defaultValue: value })
      : text(found.displayName, value)
  }
  const triggerLabel = (step: Record<string, unknown>): string => {
    const key = {
      always: 'triggerAlways',
      'requirement-ready': 'triggerRequirementReady',
      'review-feedback': 'triggerReviewFeedback',
      'pipeline-failed': 'triggerPipelineFailed',
      'merge-conflict': 'triggerMergeConflict',
    }[triggerOf(step)]
    return t(`code.employeePlaybook.${key}`)
  }
  const producerLabel = (producer: Record<string, unknown>): string => {
    if (producer.kind === 'platform') {
      return t(`code.employeePlaybook.platform.${text(producer.capabilityId).replace('.', '_')}`, {
        defaultValue: text(producer.capabilityId),
      })
    }
    if (producer.kind === 'digital-employee') return nameOf(producer.employeeRef)
    if (producer.kind === 'approval-submit' || producer.kind === 'approval-observe') {
      return nameOf(producer.adapterRef)
    }
    return nameOf(producer.implementationRef)
  }
  const preset = employeePresetOf(props.draft)
  const presetLabel = t(
    preset === 'java'
      ? 'code.employeePlaybook.presetJava'
      : preset === 'cpp'
        ? 'code.employeePlaybook.presetCpp'
        : 'code.employeePlaybook.presetGeneral',
  )
  const collaborationSteps = steps.filter((step) => {
    const kind = asRecord(step.producer).kind
    return (
      kind === 'digital-employee' ||
      kind === 'approval-prepare' ||
      kind === 'approval-submit' ||
      kind === 'approval-observe'
    )
  })

  return (
    <div className="employee-manual" data-testid="config-summary-employee">
      <Card
        title={t('code.employeePlaybook.manualTitle')}
        actions={
          <StatusChip kind={props.readyToPublish ? 'success' : 'warn'} size="sm">
            {props.readyToPublish
              ? t('code.employeePlaybook.readyToPublish')
              : t('code.employeePlaybook.needsAttention', { count: props.violations.length })}
          </StatusChip>
        }
      >
        <div className="employee-manual__overview">
          <div>
            <span>{t('code.employeePlaybook.responsibility')}</span>
            <strong>{presetLabel}</strong>
          </div>
          <div>
            <span>{t('code.employeePlaybook.ruleSet')}</span>
            <strong>{nameOf(props.draft.defaultPolicyRef)}</strong>
          </div>
          <div>
            <span>{t('code.employeePlaybook.assignmentSummary')}</span>
            <strong>
              {t('code.employeePlaybook.assignmentCount', { count: props.assignmentCount })}
            </strong>
          </div>
        </div>
        {text(props.draft.description) !== '' ? <p>{text(props.draft.description)}</p> : null}
      </Card>

      <Card title={t('code.employeePlaybook.sequenceTitle')}>
        {steps.length === 0 ? (
          <p>{t('code.employeePlaybook.noBusinessSteps')}</p>
        ) : (
          <ol className="employee-manual__steps">
            {steps.map((step, index) => {
              const producer = asRecord(step.producer)
              const failure = asRecord(step.onFailure)
              const retry = asRecord(failure.retry)
              return (
                <li key={text(step.stepId, String(index))}>
                  <span className="employee-manual__step-number">{index + 1}</span>
                  <div>
                    <h4>
                      {text(
                        step.displayName,
                        t('code.employeePlaybook.stepNumber', { number: index + 1 }),
                      )}
                    </h4>
                    {text(step.description) !== '' ? <p>{text(step.description)}</p> : null}
                    <dl className="employee-manual__step-contract">
                      <div>
                        <dt>{t('code.employeePlaybook.trigger')}</dt>
                        <dd>{triggerLabel(step)}</dd>
                      </div>
                      <div>
                        <dt>{t('code.employeePlaybook.executor')}</dt>
                        <dd>{producerLabel(producer)}</dd>
                      </div>
                      <div>
                        <dt>{t('code.employeePlaybook.success')}</dt>
                        <dd>{stepName(step.onSuccess)}</dd>
                      </div>
                      <div>
                        <dt>{t('code.employeePlaybook.failure')}</dt>
                        <dd>
                          {t('code.employeePlaybook.failureLabel', {
                            same: typeof retry.sameScene === 'number' ? retry.sameScene : 0,
                            fresh: typeof retry.freshScene === 'number' ? retry.freshScene : 0,
                            target: stepName(failure.onExhausted),
                          })}
                        </dd>
                      </div>
                    </dl>
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </Card>

      <div className="employee-manual__grid">
        <Card title={t('code.employeePlaybook.problemsSummary')}>
          {problemTypes.length === 0 ? (
            <p>{t('code.employeePlaybook.noProblems')}</p>
          ) : (
            <ul className="employee-manual__compact-list">
              {problemTypes.map((problem) => {
                const typeId = text(problem.typeId)
                const producerNames = problemProducers
                  .filter((producer) =>
                    Array.isArray(producer.allowedTypeIds)
                      ? producer.allowedTypeIds.includes(typeId)
                      : false,
                  )
                  .map((producer) => text(producer.displayName))
                  .filter(Boolean)
                const handlers = problemHandlers.filter((handler) => handler.typeId === typeId)
                return (
                  <li key={typeId}>
                    <strong>{text(problem.displayName, typeId)}</strong>
                    <span>
                      {t('code.employeePlaybook.problemFlow', {
                        producer:
                          producerNames.join('、') || t('code.employeePlaybook.unconfigured'),
                        handler:
                          handlers
                            .map((handler) => producerLabel(asRecord(handler.handler)))
                            .join('、') || t('code.employeePlaybook.unconfigured'),
                      })}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        <Card title={t('code.employeePlaybook.externalCollaboration')}>
          {collaborationSteps.length === 0 ? (
            <p>{t('code.employeePlaybook.noExternalCollaboration')}</p>
          ) : (
            <ul className="employee-manual__compact-list">
              {collaborationSteps.map((step) => {
                const producer = asRecord(step.producer)
                return (
                  <li key={text(step.stepId)}>
                    <strong>{text(step.displayName)}</strong>
                    <span>{producerLabel(producer)}</span>
                    {producer.kind === 'digital-employee' ? (
                      <span>
                        {t('code.employeePlaybook.childWaitSummary', {
                          repository: text(asRecord(producer.repository).repositoryId),
                          completion: t(
                            `code.employeePlaybook.completion.${text(producer.completion)}`,
                            { defaultValue: text(producer.completion) },
                          ),
                        })}
                      </span>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
        </Card>
      </div>

      <Card title={t('code.employeePlaybook.connectionsSummary')}>
        <dl className="mission-kv">
          <dt>{t('code.employeePlaybook.requirementSystem')}</dt>
          <dd>
            {sources.length === 0
              ? t('code.employeePlaybook.noConnection')
              : sources.map((source) => nameOf(source.adapterRef)).join('、')}
          </dd>
          <dt>{t('code.employeePlaybook.pipelineSystem')}</dt>
          <dd>
            {providers.length === 0
              ? t('code.employeePlaybook.noConnection')
              : providers.map((provider) => nameOf(provider.adapterRef)).join('、')}
          </dd>
        </dl>
      </Card>
    </div>
  )
}

function TemplateSummary(props: { draft: Record<string, unknown> }): ReactElement {
  const { t } = useTranslation()
  const executor = (props.draft.executor ?? {}) as { kind?: string; agentRef?: string }
  const retry = (props.draft.retryDefaults ?? {}) as { sameSession?: number; freshSession?: number }
  return (
    <Card title={t('code.config.templateSummary')} data-testid="config-summary-template">
      <dl className="mission-kv">
        <dt>{t('code.config.colCapability')}</dt>
        <dd>
          <code>{refText(props.draft.capabilityId)}</code>
          {typeof props.draft.capabilityContractVersion === 'number'
            ? ` (contract v${props.draft.capabilityContractVersion})`
            : null}
        </dd>
        <dt>{t('code.config.executor')}</dt>
        <dd>
          <code>
            {executor.kind === 'agent' ? (executor.agentRef ?? '—') : (executor.kind ?? '—')}
          </code>
        </dd>
        <dt>{t('code.config.verificationProfile')}</dt>
        <dd>
          <code>{refText(props.draft.verificationProfileRef)}</code>
        </dd>
        <dt>{t('code.config.retryDefaults')}</dt>
        <dd>
          {t('code.config.retryText', {
            same: retry.sameSession ?? 0,
            fresh: retry.freshSession ?? 0,
          })}
        </dd>
      </dl>
      {typeof props.draft.promptSupplement === 'string' &&
      props.draft.promptSupplement.length > 0 ? (
        <>
          <h4>{t('code.config.promptSupplement')}</h4>
          <pre className="prompt-preview__pre">{props.draft.promptSupplement}</pre>
        </>
      ) : null}
    </Card>
  )
}

function ProfileSummary(props: { draft: Record<string, unknown> }): ReactElement {
  const { t } = useTranslation()
  const steps = Array.isArray(props.draft.steps) ? props.draft.steps : []
  return (
    <Card title={t('code.config.profileSummary')} data-testid="config-summary-profile">
      <dl className="mission-kv">
        <dt>{t('code.config.stopPolicy')}</dt>
        <dd>
          <code>{refText(props.draft.stopPolicy)}</code>
        </dd>
      </dl>
      {steps.length === 0 ? (
        <p>{t('code.config.noSteps')}</p>
      ) : (
        <TableViewport label={t('code.config.colStep')}>
          <table data-testid="config-profile-steps">
            <thead>
              <tr>
                <th>{t('code.config.colStep')}</th>
                <th>{t('code.config.colProgram')}</th>
                <th>{t('code.config.colTimeout')}</th>
                <th>{t('code.config.colExitCodes')}</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((step, index) => {
                const s = step as {
                  stepId?: string
                  programRef?: string
                  timeoutMs?: number
                  successExitCodes?: number[]
                }
                return (
                  <tr key={s.stepId ?? index}>
                    <td>
                      <code>{s.stepId ?? '—'}</code>
                    </td>
                    <td>
                      <code>{s.programRef ?? '—'}</code>
                    </td>
                    <td>{typeof s.timeoutMs === 'number' ? `${s.timeoutMs} ms` : '—'}</td>
                    <td>
                      {Array.isArray(s.successExitCodes) ? s.successExitCodes.join(', ') : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </TableViewport>
      )}
    </Card>
  )
}

function AdapterSummary(props: { draft: Record<string, unknown> }): ReactElement {
  const { t } = useTranslation()
  const operations = Array.isArray(props.draft.operations) ? props.draft.operations : []
  const secrets = Array.isArray(props.draft.secretProjection) ? props.draft.secretProjection : []
  const budget = (props.draft.outputBudget ?? {}) as {
    maxFiles?: number
    maxTotalBytes?: number
  }
  return (
    <Card title={t('code.config.adapterSummary')} data-testid="config-summary-adapter">
      <dl className="mission-kv">
        <dt>{t('code.config.purpose')}</dt>
        <dd>
          <code>{refText(props.draft.purpose)}</code>
        </dd>
        <dt>{t('code.config.operations')}</dt>
        <dd>{operations.length === 0 ? '—' : operations.map(String).join(', ')}</dd>
        <dt>{t('code.config.executable')}</dt>
        <dd>
          <code>{refText(props.draft.executableRef)}</code>
        </dd>
        <dt>{t('code.config.connection')}</dt>
        <dd>
          <code>{refText(props.draft.connectionRef)}</code>
        </dd>
        <dt>{t('code.config.secretProjection')}</dt>
        <dd data-testid="config-adapter-secrets">
          {/* 只显示 key 名——值永远不出 daemon。 */}
          {secrets.length === 0 ? '—' : secrets.map(String).join(', ')}
        </dd>
        <dt>{t('code.config.outputBudget')}</dt>
        <dd>
          {typeof budget.maxFiles === 'number' && typeof budget.maxTotalBytes === 'number'
            ? t('code.config.budgetText', {
                files: budget.maxFiles,
                bytes: budget.maxTotalBytes,
              })
            : '—'}
        </dd>
        <dt>{t('code.config.timeout')}</dt>
        <dd>{typeof props.draft.timeoutMs === 'number' ? `${props.draft.timeoutMs} ms` : '—'}</dd>
      </dl>
    </Card>
  )
}

// ------------------------------------------------------------------- editing

function EditDialog(props: {
  kind: ConfigKind
  detail: ConfigDetail
  onClose: () => void
  onSaved: () => void
}): ReactElement {
  const { t } = useTranslation()
  const canAuthorScripts = usePermission('scripts:author')
  const spec = CONFIG_KIND_SPECS[props.kind]
  const draftObject = (props.detail.draft ?? {}) as Record<string, unknown>
  const [name, setName] = useState(props.detail.name)
  const [guidedDraft, setGuidedDraft] = useState(draftObject)
  const [draftJson, setDraftJson] = useState(JSON.stringify(props.detail.draft ?? {}, null, 2))
  const [rawDirty, setRawDirty] = useState(false)
  const [jsonError, setJsonError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (payload: { name?: string; draft: unknown }) =>
      api.put(
        props.kind === 'employees'
          ? `${spec.apiBase}/${encodeURIComponent(props.detail.id)}/playbook`
          : `${spec.apiBase}/${encodeURIComponent(props.detail.id)}`,
        props.kind === 'employees'
          ? {
              ...(payload.name === undefined ? {} : { name: payload.name }),
              playbook: payload.draft,
            }
          : payload,
      ),
    onSuccess: props.onSaved,
  })

  const submit = (): void => {
    if (rawDirty) {
      setJsonError(t('code.config.editor.applyAdvancedFirst'))
      return
    }
    setJsonError(null)
    save.mutate({ ...(name !== props.detail.name ? { name } : {}), draft: guidedDraft })
  }

  const updateGuidedDraft = (next: Record<string, unknown>): void => {
    setGuidedDraft(next)
    setDraftJson(JSON.stringify(next, null, 2))
    setRawDirty(false)
    setJsonError(null)
  }

  const applyAdvancedJson = (): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(draftJson)
    } catch {
      setJsonError(t('code.config.draftInvalidJson'))
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      setJsonError(t('code.config.editor.draftMustBeObject'))
      return
    }
    updateGuidedDraft(parsed as Record<string, unknown>)
  }

  return (
    <Dialog
      open
      title={
        props.kind === 'employees'
          ? t('code.employeePlaybook.manualTitle')
          : t('code.config.editTitle')
      }
      size="lg"
      /* 装着用户输入的弹窗不接受"点遮罩关闭"：遮罩盖满视口，页头那颗同名
         按钮只是透过半透明遮罩看得见、其实点不到，那一下会命中遮罩并把已填
         内容静默丢弃（用户实报：「点击创建，弹窗就消失了，什么都没变化」）。
         ESC / 取消 / × 三条关闭路径保留。 */
      closeOnOverlayClick={false}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className="btn btn--sm" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={save.isPending || name.trim() === '' || rawDirty}
            onClick={submit}
            data-testid="config-edit-save"
          >
            {save.isPending ? t('code.config.saving') : t('code.config.save')}
          </button>
        </>
      }
    >
      {save.isError ? <ErrorBanner error={save.error} /> : null}
      {jsonError !== null ? <ErrorBanner error={new Error(jsonError)} /> : null}
      <Field label={t('code.config.name')} required>
        <TextInput value={name} onChange={setName} data-testid="config-edit-name" />
      </Field>
      <DevelopmentConfigEditor
        kind={props.kind}
        draft={guidedDraft}
        identityCapabilityId={props.detail.capabilityId}
        onChange={updateGuidedDraft}
      />
      {props.kind !== 'employees' || canAuthorScripts ? (
        <FormSection
          title={t('code.config.editor.advancedJson')}
          collapsible
          data-testid="config-edit-advanced"
        >
          <p className="form-section__hint">{t('code.config.editor.advancedJsonHint')}</p>
          <Field label={t('code.config.draftJsonTitle')}>
            <TextArea
              value={draftJson}
              onChange={(value) => {
                setDraftJson(value)
                setRawDirty(true)
                setJsonError(null)
              }}
              rows={14}
              monospace
              data-testid="config-edit-json"
            />
          </Field>
          <button
            type="button"
            className="btn btn--sm"
            disabled={!rawDirty}
            onClick={applyAdvancedJson}
            data-testid="config-edit-json-apply"
          >
            {t('code.config.editor.applyAdvanced')}
          </button>
        </FormSection>
      ) : null}
    </Dialog>
  )
}
