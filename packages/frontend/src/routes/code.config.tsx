// RFC-310 PR-8 T85/T86/T89 —— 数字员工配置资源（员工 / 动作模板 / 验证
// profile）的统一列表页。RFC-323 将 Adapter 生命周期移入职责泳道卡片。
//
// 后端/shared 仍保留四类版本化资源的 API 合同；RFC-323 将 Adapter 生命周期
// 收进职责泳道 Dialog，所以这个旧参数化页面只承载员工、动作模板和验证
// profile 三族。`kind=adapters` 在取数前重定向，不再渲染列表、详情或 raw JSON。

import {
  DEVELOPMENT_CONFIG_API_BASE,
  buildDevelopmentConfigCreateBody,
} from '@agent-workflow/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, Link, redirect } from '@tanstack/react-router'
import { useEffect, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextArea, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { usePermission } from '@/hooks/useActor'
import { AGENT_CAPABILITY_IDS } from '@/data/policyFactCatalog'
import {
  buildInitialEmployeePlaybook,
  type EmployeePreset,
  type PublishedResourceOption,
} from '@/components/code/employeePlaybook'
import { Route as RootRoute } from './__root'

// 这是旧配置 UI 的有意子集，不是 shared 后端资源清单的镜像。Adapter 仍有
// Integration API，但唯一业务管理入口是数字员工职责泳道卡片。
export const CONFIG_KINDS = ['employees', 'action-templates', 'verification-profiles'] as const
export type ConfigKind = (typeof CONFIG_KINDS)[number]

export interface ConfigKindSpec {
  /** 后端 CRUD base（ACL 面同 base + /:id/acl）。 */
  apiBase: string
  /** usePermission 的前缀（backend PermissionPrefix 同名）。 */
  permissionPrefix: 'digital-employees' | 'action-templates' | 'verification-profiles'
  i18nKey: 'employees' | 'actionTemplates' | 'verificationProfiles'
}

// 保留的三族 apiBase 仍取 shared 的单一事实源
// `DEVELOPMENT_CONFIG_API_BASE`，由 code-config-api-base 测试逐条对账。
export const CONFIG_KIND_SPECS: Record<ConfigKind, ConfigKindSpec> = {
  employees: {
    apiBase: DEVELOPMENT_CONFIG_API_BASE.employees,
    permissionPrefix: 'digital-employees',
    i18nKey: 'employees',
  },
  'action-templates': {
    apiBase: DEVELOPMENT_CONFIG_API_BASE['action-templates'],
    permissionPrefix: 'action-templates',
    i18nKey: 'actionTemplates',
  },
  'verification-profiles': {
    apiBase: DEVELOPMENT_CONFIG_API_BASE['verification-profiles'],
    permissionPrefix: 'verification-profiles',
    i18nKey: 'verificationProfiles',
  },
}

export function isConfigKind(value: string): value is ConfigKind {
  return (CONFIG_KINDS as readonly string[]).includes(value)
}

export interface ConfigIdentityRow {
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
  description?: string
  businessStatus?: 'enabled' | 'disabled'
  stepCount?: number
}

interface ConfigListSearch extends Record<string, unknown> {
  create?: boolean
}

export function validateConfigListSearch(search: Record<string, unknown>): ConfigListSearch {
  const { create: _create, ...adjacent } = search
  // `?create=1` 经 TanStack 的默认解析（JSON.parse 每个值）会变成**数字 1**，不是
  // 字符串 '1'。少认这一种，`/code` 的首屏主动作（href 正是 `?create=1`）点进来
  // 就只落到列表页、对话框不开——零配置操作链的第一跳当场断掉，而且不报错。
  // 既有 `workflows.tsx` / `tasks.new.tsx` 的同名开关本来就三种都认。
  const create = search.create
  return create === true || create === 1 || create === '1' || create === 'true'
    ? { ...adjacent, create: true }
    : adjacent
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/code/config/$kind',
  validateSearch: validateConfigListSearch,
  beforeLoad: ({ params }) => {
    if (params.kind === 'adapters') throw redirect({ to: '/digital-employees' })
  },
  component: ConfigListPage,
})

function ConfigListPage(): ReactElement {
  const { t } = useTranslation()
  const params = Route.useParams()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const kind: ConfigKind = isConfigKind(params.kind) ? params.kind : 'employees'
  const spec = CONFIG_KIND_SPECS[kind]
  const canCreate = usePermission(`${spec.permissionPrefix}:create`)

  const list = useQuery<{ items: ConfigIdentityRow[] }>({
    queryKey: ['code-config', kind],
    queryFn: ({ signal }) => api.get(spec.apiBase, undefined, signal),
  })

  const [createOpen, setCreateOpen] = useState(false)
  useEffect(() => {
    if (search.create === true && canCreate) setCreateOpen(true)
  }, [canCreate, kind, search.create])
  const closeCreate = (): void => {
    setCreateOpen(false)
    if (search.create === true) {
      void navigate({ search: (previous) => ({ ...previous, create: undefined }), replace: true })
    }
  }

  return (
    <div className={`page page--operations code-config-page code-config-page--${kind}`}>
      <div className="operations-surface">
        <PageHeader
          title={
            kind === 'employees'
              ? t('code.employeePlaybook.employeesTitle')
              : t(`code.config.kind.${spec.i18nKey}`)
          }
          className="operations-surface__header"
          actions={
            canCreate ? (
              <button
                type="button"
                className="btn btn--sm btn--primary"
                onClick={() => setCreateOpen(true)}
                data-testid="config-create-open"
              >
                {t('code.config.create')}
              </button>
            ) : null
          }
        >
          <p className="operations-surface__subtitle">
            {kind === 'employees'
              ? t('code.employeePlaybook.employeesSubtitle')
              : t('code.config.technicalSubtitle')}
          </p>
        </PageHeader>

        {list.isLoading ? <LoadingState /> : null}
        {list.isError ? <ErrorBanner error={list.error} /> : null}
        {list.data !== undefined && list.data.items.length === 0 ? (
          <EmptyState
            title={
              kind === 'employees'
                ? t('code.employeePlaybook.employeesEmpty')
                : t('code.config.emptyTitle')
            }
            description={
              kind === 'employees'
                ? t('code.employeePlaybook.employeesEmptyHint')
                : t('code.config.emptyBody')
            }
            action={
              canCreate ? (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => setCreateOpen(true)}
                >
                  {t('code.employeePlaybook.createEmployee')}
                </button>
              ) : undefined
            }
          />
        ) : null}

        {list.data !== undefined && list.data.items.length > 0 ? (
          <TableViewport label={t('code.config.title')}>
            <table data-testid="config-list">
              <thead>
                <tr>
                  <th>{t('code.config.colName')}</th>
                  <th>
                    {kind === 'employees'
                      ? t('code.employeePlaybook.colSteps')
                      : t('code.config.colDetail')}
                  </th>
                  <th>{t('code.config.colRevision')}</th>
                  <th>
                    {kind === 'employees'
                      ? t('code.employeePlaybook.colStatus')
                      : t('code.config.colVisibility')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((row) => (
                  <tr key={row.id} data-testid={`config-row-${row.id}`}>
                    <td>
                      <Link
                        to="/code/config/$kind/$id"
                        params={{ kind, id: row.id }}
                        data-testid={`config-link-${row.id}`}
                      >
                        {row.name}
                      </Link>
                      {kind === 'employees' &&
                      row.description !== undefined &&
                      row.description !== '' ? (
                        <p className="operations-surface__subtitle">{row.description}</p>
                      ) : null}
                    </td>
                    <td>
                      {kind === 'employees'
                        ? t('code.employeePlaybook.stepCount', { count: row.stepCount ?? 0 })
                        : (row.capabilityId ?? row.purpose ?? '—')}
                    </td>
                    <td>
                      {row.publishedRevision === null ? (
                        <StatusChip kind="warn" size="sm">
                          {t('code.config.notPublished')}
                        </StatusChip>
                      ) : (
                        <code>v{row.publishedRevision}</code>
                      )}
                      {row.archivedAt !== null ? (
                        <StatusChip kind="neutral" size="sm">
                          {t('code.config.archived')}
                        </StatusChip>
                      ) : null}
                    </td>
                    <td>
                      {kind === 'employees' ? (
                        <StatusChip
                          kind={row.businessStatus === 'disabled' ? 'neutral' : 'success'}
                          size="sm"
                        >
                          {row.businessStatus === 'disabled'
                            ? t('code.employeePlaybook.disabled')
                            : t('code.employeePlaybook.enabledShort')}
                        </StatusChip>
                      ) : (
                        row.visibility
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        ) : null}

        {createOpen ? <CreateDialog kind={kind} onClose={closeCreate} /> : null}
      </div>
    </div>
  )
}

function CreateDialog(props: { kind: ConfigKind; onClose: () => void }): ReactElement {
  return props.kind === 'employees' ? (
    <EmployeeCreateDialog onClose={props.onClose} />
  ) : (
    <TechnicalCreateDialog kind={props.kind} onClose={props.onClose} />
  )
}

function EmployeeCreateDialog(props: { onClose: () => void }): ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = Route.useNavigate()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [preset, setPreset] = useState<EmployeePreset>('general')
  const [policyId, setPolicyId] = useState('')
  const policies = useQuery<{ items: PublishedResourceOption[] }>({
    queryKey: ['code-policies'],
    queryFn: ({ signal }) => api.get('/api/code/automation-policies', undefined, signal),
  })
  const templates = useQuery<{ items: PublishedResourceOption[] }>({
    queryKey: ['code-config', 'action-templates'],
    queryFn: ({ signal }) => api.get('/api/code/action-templates', undefined, signal),
  })
  const publishedPolicies = (policies.data?.items ?? []).filter(
    (policy) => policy.publishedRevision !== null,
  )
  const effectivePolicyId = policyId || publishedPolicies[0]?.id || ''
  const selectedPolicy = publishedPolicies.find((policy) => policy.id === effectivePolicyId)
  const implementations = (templates.data?.items ?? []).filter(
    (template) => template.publishedRevision !== null,
  )

  const create = useMutation({
    mutationFn: () => {
      if (selectedPolicy === undefined) throw new Error(t('code.employeePlaybook.noRuleSet'))
      return api.post(
        CONFIG_KIND_SPECS.employees.apiBase,
        buildDevelopmentConfigCreateBody({
          kind: 'employees',
          name,
          employeeDraft: buildInitialEmployeePlaybook({
            description,
            preset,
            policy: selectedPolicy,
            implementations,
            stepName: (nameKey) => t(`code.employeePlaybook.standardStep.${nameKey}`),
          }),
        }),
      ) as Promise<ConfigIdentityRow>
    },
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ['code-config', 'employees'] })
      props.onClose()
      void navigate({
        to: '/code/config/$kind/$id',
        params: { kind: 'employees', id: created.id },
      })
    },
  })

  return (
    <Dialog
      open
      title={t('code.employeePlaybook.createEmployee')}
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
            disabled={name.trim() === '' || selectedPolicy === undefined || create.isPending}
            onClick={() => create.mutate()}
            data-testid="config-create-submit"
          >
            {create.isPending
              ? t('code.config.creating')
              : t('code.employeePlaybook.createAndConfigure')}
          </button>
        </>
      }
    >
      {create.isError ? <ErrorBanner error={create.error} /> : null}
      <p>{t('code.employeePlaybook.createHint')}</p>
      <Field label={t('code.config.name')} required>
        <TextInput value={name} onChange={setName} data-testid="config-create-name" />
      </Field>
      <Field label={t('code.config.description')}>
        <TextArea value={description} onChange={setDescription} rows={3} />
      </Field>
      <Field label={t('code.employeePlaybook.preset')}>
        <Select
          value={preset}
          onChange={(value) => setPreset(value as EmployeePreset)}
          options={[
            { value: 'general', label: t('code.employeePlaybook.presetGeneral') },
            { value: 'java', label: t('code.employeePlaybook.presetJava') },
            { value: 'cpp', label: t('code.employeePlaybook.presetCpp') },
          ]}
        />
      </Field>
      {publishedPolicies.length === 0 ? (
        <ErrorBanner error={new Error(t('code.employeePlaybook.noRuleSet'))} />
      ) : (
        <Field
          label={t('code.employeePlaybook.ruleSet')}
          hint={t('code.employeePlaybook.ruleSetHint')}
        >
          <Select
            value={effectivePolicyId}
            onChange={setPolicyId}
            options={publishedPolicies.map((policy) => ({ value: policy.id, label: policy.name }))}
          />
        </Field>
      )}
      <p className="form-field__hint">
        {t('code.employeePlaybook.detectedExecutors', { count: implementations.length })}
      </p>
    </Dialog>
  )
}

function TechnicalCreateDialog(props: { kind: ConfigKind; onClose: () => void }): ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = Route.useNavigate()
  const spec = CONFIG_KIND_SPECS[props.kind]
  const [name, setName] = useState('')
  const [capabilityId, setCapabilityId] = useState<string>(AGENT_CAPABILITY_IDS[1])

  const create = useMutation({
    // 载荷由 shared 的共用契约产出（不在页面里即兴拼）——后端契约测试拿同一个
    // 函数打真实 app，前后端形状不可能对不上。
    mutationFn: () =>
      api.post(
        spec.apiBase,
        buildDevelopmentConfigCreateBody({
          kind: props.kind,
          name,
          capabilityId,
        }),
      ) as Promise<ConfigIdentityRow>,
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ['code-config', props.kind] })
      props.onClose()
      void navigate({ to: '/code/config/$kind/$id', params: { kind: props.kind, id: created.id } })
    },
  })

  return (
    <Dialog
      open
      title={t('code.config.createTitle', {
        kind: t(`code.config.kind.${spec.i18nKey}`),
      })}
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
            disabled={name.trim() === '' || create.isPending}
            onClick={() => create.mutate()}
            data-testid="config-create-submit"
          >
            {create.isPending ? t('code.config.creating') : t('code.config.create')}
          </button>
        </>
      }
    >
      {create.isError ? <ErrorBanner error={create.error} /> : null}
      <Field label={t('code.config.name')} required>
        <TextInput value={name} onChange={setName} data-testid="config-create-name" />
      </Field>
      {props.kind === 'action-templates' ? (
        <Field label={t('code.config.capability')} required>
          <Select
            value={capabilityId}
            onChange={(v) => setCapabilityId(v)}
            options={AGENT_CAPABILITY_IDS.map((id) => ({ value: id, label: id }))}
            ariaLabel={t('code.config.capability')}
            data-testid="config-create-capability"
          />
        </Field>
      ) : null}
    </Dialog>
  )
}
