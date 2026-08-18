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
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { AclPanel } from '@/components/AclPanel'
import { usePermission } from '@/hooks/useActor'
import { CONFIG_KIND_SPECS, isConfigKind, type ConfigKind } from './code.config'
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
    queryFn: ({ signal }) =>
      api.get(`${spec.apiBase}/${encodeURIComponent(params.id)}`, undefined, signal),
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
  const violations = publishViolationsOf(publish.error)

  return (
    <div className="page">
      <PageHeader
        title={row.name}
        back={
          <Link to="/code/config/$kind" params={{ kind }}>
            {t('code.config.backToList')}
          </Link>
        }
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

      {kind === 'adapters' && canUpdate && !canAuthorScripts ? (
        <p className="page__subtitle" data-testid="config-scripts-author-hint">
          {t('code.config.scriptsAuthorHint')}
        </p>
      ) : null}

      {publish.isError && violations.length === 0 ? <ErrorBanner error={publish.error} /> : null}
      {violations.length > 0 ? (
        <Card title={t('code.config.publishBlocked')} data-testid="config-publish-violations">
          <ul>
            {violations.map((v, index) => (
              <li key={`${v.code}-${index}`}>
                <code>{v.code}</code> — {v.where}: {v.detail}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <DraftSummary kind={kind} draft={row.draft} />

      <Card title={t('code.config.draftJsonTitle')}>
        <pre className="prompt-preview__pre" data-testid="config-draft-json">
          {JSON.stringify(row.draft, null, 2)}
        </pre>
      </Card>

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
  )
}

// ---------------------------------------------------------------- summaries

function DraftSummary(props: { kind: ConfigKind; draft: unknown }): ReactElement | null {
  const draft = (props.draft ?? {}) as Record<string, unknown>
  if (props.kind === 'employees') return <EmployeeSummary draft={draft} />
  if (props.kind === 'action-templates') return <TemplateSummary draft={draft} />
  if (props.kind === 'verification-profiles') return <ProfileSummary draft={draft} />
  return <AdapterSummary draft={draft} />
}

function refText(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : '—'
}

function EmployeeSummary(props: { draft: Record<string, unknown> }): ReactElement {
  const { t } = useTranslation()
  const routes = Array.isArray(props.draft.capabilityRoutes) ? props.draft.capabilityRoutes : []
  const sources = Array.isArray(props.draft.requirementSources)
    ? props.draft.requirementSources
    : []
  const providers = Array.isArray(props.draft.pipelineProviders)
    ? props.draft.pipelineProviders
    : []
  return (
    <Card title={t('code.config.employeeSummary')} data-testid="config-summary-employee">
      {typeof props.draft.description === 'string' && props.draft.description.length > 0 ? (
        <p>{props.draft.description}</p>
      ) : null}
      <h4>{t('code.config.routesTitle')}</h4>
      {routes.length === 0 ? (
        <p>{t('code.config.noRoutes')}</p>
      ) : (
        <TableViewport label={t('code.config.routesTitle')}>
          <table data-testid="config-employee-routes">
            <thead>
              <tr>
                <th>{t('code.config.colCapability')}</th>
                <th>{t('code.config.colRules')}</th>
                <th>{t('code.config.colFallback')}</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((route, index) => {
                const r = route as {
                  capabilityId?: string
                  rules?: unknown[]
                  fallbackTemplateRef?: string | null
                }
                return (
                  <tr key={r.capabilityId ?? index}>
                    <td>
                      <code>{r.capabilityId ?? '—'}</code>
                    </td>
                    <td>{Array.isArray(r.rules) ? r.rules.length : 0}</td>
                    <td>
                      <code>{r.fallbackTemplateRef ?? '—'}</code>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </TableViewport>
      )}
      <h4>{t('code.config.bindingsTitle')}</h4>
      <dl className="mission-kv">
        <dt>{t('code.config.defaultPolicy')}</dt>
        <dd>
          <code>{refText(props.draft.defaultPolicyRef)}</code>
        </dd>
        <dt>{t('code.config.requirementSources')}</dt>
        <dd>
          {sources.length === 0
            ? '—'
            : sources
                .map((s) => {
                  const b = s as { sourceKey?: string; isDefault?: boolean }
                  return `${b.sourceKey ?? '?'}${b.isDefault === true ? ' (default)' : ''}`
                })
                .join(', ')}
        </dd>
        <dt>{t('code.config.pipelineProviders')}</dt>
        <dd>
          {providers.length === 0
            ? '—'
            : providers.map((p) => (p as { providerKey?: string }).providerKey ?? '?').join(', ')}
        </dd>
      </dl>
    </Card>
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
  const spec = CONFIG_KIND_SPECS[props.kind]
  const draftObject = (props.detail.draft ?? {}) as Record<string, unknown>
  const [name, setName] = useState(props.detail.name)
  // 常用字段结构化：员工的 description / 模板的 promptSupplement；其余内容仍
  // 走 JSON（publish 校验兜住合法性——PR-8 首版分层，深度表单随后续批次）。
  const [description, setDescription] = useState(
    typeof draftObject.description === 'string' ? draftObject.description : '',
  )
  const [promptSupplement, setPromptSupplement] = useState(
    typeof draftObject.promptSupplement === 'string' ? draftObject.promptSupplement : '',
  )
  const [draftJson, setDraftJson] = useState(JSON.stringify(props.detail.draft ?? {}, null, 2))
  const [jsonError, setJsonError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (payload: { name?: string; draft: unknown }) =>
      api.put(`${spec.apiBase}/${encodeURIComponent(props.detail.id)}`, payload),
    onSuccess: props.onSaved,
  })

  const submit = (): void => {
    let parsed: unknown
    try {
      parsed = JSON.parse(draftJson)
    } catch {
      setJsonError(t('code.config.draftInvalidJson'))
      return
    }
    setJsonError(null)
    const merged =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? {
            ...(parsed as Record<string, unknown>),
            ...(props.kind === 'employees' ? { description } : {}),
            ...(props.kind === 'action-templates' ? { promptSupplement } : {}),
          }
        : parsed
    save.mutate({ ...(name !== props.detail.name ? { name } : {}), draft: merged })
  }

  return (
    <Dialog
      open
      title={t('code.config.editTitle')}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className="btn btn--sm" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={save.isPending || name.trim() === ''}
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
      {props.kind === 'employees' ? (
        <Field label={t('code.config.description')}>
          <TextArea
            value={description}
            onChange={setDescription}
            rows={3}
            data-testid="config-edit-description"
          />
        </Field>
      ) : null}
      {props.kind === 'action-templates' ? (
        <Field label={t('code.config.promptSupplement')} hint={t('code.config.promptHint')}>
          <TextArea
            value={promptSupplement}
            onChange={setPromptSupplement}
            rows={5}
            monospace
            data-testid="config-edit-prompt"
          />
        </Field>
      ) : null}
      <Field label={t('code.config.draftJsonTitle')} hint={t('code.config.draftJsonHint')}>
        <TextArea
          value={draftJson}
          onChange={setDraftJson}
          rows={14}
          monospace
          data-testid="config-edit-json"
        />
      </Field>
    </Dialog>
  )
}
