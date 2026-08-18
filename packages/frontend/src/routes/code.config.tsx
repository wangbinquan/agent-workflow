// RFC-310 PR-8 T85/T86/T89 —— 数字员工配置资源（员工 / 动作模板 / 验证
// profile / adapter）的统一列表页。
//
// 五类配置资源后端是同构 CRUD（mountConfigResource：list/create/get/revise/
// publish/archive + ACL），前端同样用一个参数化路由承载四族（automation
// policy 由 T87 的 rule builder 单独成页）：`/code/config/$kind`。同一张表、
// 同一个创建 Dialog，per-kind 只差列补充与创建时的最小必填（模板要
// capabilityId、adapter 要 purpose）。draft 内容的深度编辑在详情页。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, Link } from '@tanstack/react-router'
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { usePermission } from '@/hooks/useActor'
import { Route as RootRoute } from './__root'

export const CONFIG_KINDS = [
  'employees',
  'action-templates',
  'verification-profiles',
  'adapters',
] as const
export type ConfigKind = (typeof CONFIG_KINDS)[number]

export interface ConfigKindSpec {
  /** 后端 CRUD base（ACL 面同 base + /:id/acl）。 */
  apiBase: string
  /** usePermission 的前缀（backend PermissionPrefix 同名）。 */
  permissionPrefix:
    | 'digital-employees'
    | 'action-templates'
    | 'verification-profiles'
    | 'adapter-definitions'
  i18nKey: 'employees' | 'actionTemplates' | 'verificationProfiles' | 'adapters'
}

export const CONFIG_KIND_SPECS: Record<ConfigKind, ConfigKindSpec> = {
  employees: {
    apiBase: '/api/code/digital-employees',
    permissionPrefix: 'digital-employees',
    i18nKey: 'employees',
  },
  'action-templates': {
    apiBase: '/api/code/action-templates',
    permissionPrefix: 'action-templates',
    i18nKey: 'actionTemplates',
  },
  'verification-profiles': {
    apiBase: '/api/code/verification-profiles',
    permissionPrefix: 'verification-profiles',
    i18nKey: 'verificationProfiles',
  },
  adapters: {
    apiBase: '/api/code/development-adapters',
    permissionPrefix: 'adapter-definitions',
    i18nKey: 'adapters',
  },
}

export function isConfigKind(value: string): value is ConfigKind {
  return (CONFIG_KINDS as readonly string[]).includes(value)
}

/** Agent capability id 闭集（backend capabilityDefinition AGENT_CAPABILITY_IDS
 *  的前端镜像；模板创建时的必填选择）。 */
export const AGENT_CAPABILITY_IDS = [
  'requirement.analyze',
  'change.implement',
  'change.review',
  'mr.feedback.apply',
  'pipeline.repair',
  'verification.repair',
  'conflict.repair',
] as const

const ADAPTER_PURPOSES = ['requirement-source', 'pipeline-gate', 'pipeline-classifier'] as const

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
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/code/config/$kind',
  component: ConfigListPage,
})

function ConfigListPage(): ReactElement {
  const { t } = useTranslation()
  const params = Route.useParams()
  const navigate = Route.useNavigate()
  const kind: ConfigKind = isConfigKind(params.kind) ? params.kind : 'employees'
  const spec = CONFIG_KIND_SPECS[kind]
  const canCreate = usePermission(`${spec.permissionPrefix}:create`)

  const list = useQuery<{ items: ConfigIdentityRow[] }>({
    queryKey: ['code-config', kind],
    queryFn: ({ signal }) => api.get(spec.apiBase, undefined, signal),
  })

  const [createOpen, setCreateOpen] = useState(false)

  return (
    <div className="page">
      <PageHeader
        title={t('code.config.title')}
        back={<Link to="/code">{t('code.missions.backToCode')}</Link>}
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
        <p className="page__subtitle">{t('code.config.subtitle')}</p>
      </PageHeader>

      <Segmented<ConfigKind>
        value={kind}
        ariaLabel={t('code.config.kindSwitch')}
        testidPrefix="config-kind"
        onChange={(next) => {
          void navigate({ to: '/code/config/$kind', params: { kind: next } })
        }}
        options={CONFIG_KINDS.map((k) => ({
          value: k,
          label: t(`code.config.kind.${CONFIG_KIND_SPECS[k].i18nKey}`),
        }))}
      />

      {list.isLoading ? <LoadingState /> : null}
      {list.isError ? <ErrorBanner error={list.error} /> : null}
      {list.data !== undefined && list.data.items.length === 0 ? (
        <EmptyState title={t('code.config.emptyTitle')} description={t('code.config.emptyBody')} />
      ) : null}

      {list.data !== undefined && list.data.items.length > 0 ? (
        <TableViewport label={t('code.config.title')}>
          <table data-testid="config-list">
            <thead>
              <tr>
                <th>{t('code.config.colName')}</th>
                <th>{t('code.config.colDetail')}</th>
                <th>{t('code.config.colRevision')}</th>
                <th>{t('code.config.colVisibility')}</th>
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
                  </td>
                  <td>{row.capabilityId ?? row.purpose ?? '—'}</td>
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
                  <td>{row.visibility}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      ) : null}

      {createOpen ? <CreateDialog kind={kind} onClose={() => setCreateOpen(false)} /> : null}
    </div>
  )
}

function CreateDialog(props: { kind: ConfigKind; onClose: () => void }): ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = Route.useNavigate()
  const spec = CONFIG_KIND_SPECS[props.kind]
  const [name, setName] = useState('')
  const [capabilityId, setCapabilityId] = useState<string>(AGENT_CAPABILITY_IDS[1])
  const [purpose, setPurpose] = useState<string>(ADAPTER_PURPOSES[0])

  const create = useMutation({
    mutationFn: () =>
      api.post(spec.apiBase, {
        name,
        ...(props.kind === 'action-templates' ? { capabilityId } : {}),
        ...(props.kind === 'adapters' ? { purpose } : {}),
      }) as Promise<ConfigIdentityRow>,
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
      {props.kind === 'adapters' ? (
        <Field label={t('code.config.purpose')} required>
          <Select
            value={purpose}
            onChange={(v) => setPurpose(v)}
            options={ADAPTER_PURPOSES.map((p) => ({ value: p, label: p }))}
            ariaLabel={t('code.config.purpose')}
            data-testid="config-create-purpose"
          />
        </Field>
      ) : null}
    </Dialog>
  )
}
