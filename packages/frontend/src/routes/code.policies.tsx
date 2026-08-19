// RFC-310 PR-8 T87 —— AutomationPolicy 列表 + 创建。
//
// policy 是 identity + immutable revisions 的配置资源（发布后 pin 给 mission
// 使用）；列表只读投影 identity 面，创建默认带完整模板 content（空 draft 无法
// 通过 publish 的 closed schema——「不暴露 JSON-only 必填路径」的第一步）。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, Link, useNavigate } from '@tanstack/react-router'
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { usePermission } from '@/hooks/useActor'
import { defaultPolicyTemplate } from '@/data/policyFactCatalog'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/code/policies',
  component: PoliciesPage,
})

export interface PolicyIdentity {
  id: string
  name: string
  publishedRevision: number | null
  ownerUserId: string | null
  visibility: 'private' | 'public'
  createdAt: number
  updatedAt: number
  archivedAt: number | null
}

function PoliciesPage(): ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const canCreate = usePermission('automation-policies:create')

  const policies = useQuery<{ items: PolicyIdentity[] }>({
    queryKey: ['code-policies'],
    queryFn: ({ signal }) => api.get('/api/code/automation-policies', undefined, signal),
  })

  const [createOpen, setCreateOpen] = useState(false)

  return (
    <div className="page">
      <PageHeader
        title={t('code.policies.title')}
        back={<Link to="/code">{t('code.policies.backToCode')}</Link>}
        actions={
          canCreate ? (
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={() => setCreateOpen(true)}
              data-testid="policy-create-open"
            >
              {t('code.policies.create')}
            </button>
          ) : null
        }
      >
        <p className="page__subtitle">{t('code.policies.subtitle')}</p>
      </PageHeader>

      {policies.isLoading ? <LoadingState /> : null}
      {policies.isError ? <ErrorBanner error={policies.error} /> : null}
      {policies.data !== undefined && policies.data.items.length === 0 ? (
        <EmptyState
          title={t('code.policies.emptyTitle')}
          description={t('code.policies.emptyBody')}
        />
      ) : null}

      {policies.data !== undefined && policies.data.items.length > 0 ? (
        <TableViewport label={t('code.policies.title')}>
          <table data-testid="policy-list">
            <thead>
              <tr>
                <th scope="col">{t('code.policies.colName')}</th>
                <th scope="col">{t('code.policies.colPublished')}</th>
                <th scope="col">{t('code.policies.colVisibility')}</th>
                <th scope="col">{t('code.policies.colUpdated')}</th>
              </tr>
            </thead>
            <tbody>
              {policies.data.items.map((policy) => (
                <tr key={policy.id}>
                  <td>
                    <Link to="/code/policies/$policyId" params={{ policyId: policy.id }}>
                      {policy.name}
                    </Link>
                  </td>
                  <td>
                    {policy.publishedRevision === null ? (
                      <StatusChip kind="neutral" size="sm">
                        {t('code.policies.draftOnly')}
                      </StatusChip>
                    ) : (
                      <StatusChip kind="success" size="sm">
                        {t('code.policies.revisionN', { n: policy.publishedRevision })}
                      </StatusChip>
                    )}
                  </td>
                  <td>{policy.visibility}</td>
                  <td>{new Date(policy.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      ) : null}

      {createOpen ? (
        <CreatePolicyDialog
          onClose={() => setCreateOpen(false)}
          onCreated={(id) => {
            setCreateOpen(false)
            void qc.invalidateQueries({ queryKey: ['code-policies'] })
            void navigate({ to: '/code/policies/$policyId', params: { policyId: id } })
          }}
        />
      ) : null}
    </div>
  )
}

function CreatePolicyDialog(props: {
  onClose: () => void
  onCreated: (id: string) => void
}): ReactElement {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const create = useMutation({
    mutationFn: () =>
      api.post<PolicyIdentity>('/api/code/automation-policies', {
        name: name.trim(),
        // 新 policy 直接带完整默认模板：closed schema 的必填面不经 JSON 暴露。
        draft: defaultPolicyTemplate(),
      }),
    onSuccess: (created) => props.onCreated(created.id),
  })
  return (
    <Dialog
      open
      title={t('code.policies.createTitle')}
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
            data-testid="policy-create-submit"
          >
            {t('code.policies.create')}
          </button>
        </>
      }
    >
      {create.isError ? <ErrorBanner error={create.error} /> : null}
      <Field label={t('code.policies.nameLabel')} required>
        <TextInput
          value={name}
          onChange={setName}
          placeholder={t('code.policies.namePlaceholder')}
          data-testid="policy-create-name"
        />
      </Field>
      <p className="page__hint">{t('code.policies.createHint')}</p>
    </Dialog>
  )
}
