// RFC-310 PR-8 T90 —— repository / repo-group / global 三级数字员工 assignment。
//
// 三级解析（repository > repository-group > global-default）在 admission 时
// 定案；本页是唯一配置入口（旧 /code 五格矩阵随 PR-10 退役）。每个 scope 至
// 多一行：员工 + selection/execution policy + 默认需求源 key。引用一律用
// **已发布修订**（未发布资源在下拉里禁选并逐条提示——「开单 ≠ 在跑」的
// 配置面版本：不让用户把跑不起来的组合存出去）。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { createRoute } from '@tanstack/react-router'

import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { EmptyState } from '@/components/EmptyState'
import { Field } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { Select } from '@/components/Select'
import { TableViewport } from '@/components/TableViewport'
import { TextInput } from '@/components/Form'
import { Route as RootRoute } from './__root'

interface AssignmentRow {
  scopeKind: 'repository' | 'repository-group' | 'global-default'
  scopeRef: string | null
  employeeId: string | null
  employeeRevision: number | null
  selectionPolicyId: string | null
  selectionPolicyRevision: number | null
  executionPolicyId: string | null
  executionPolicyRevision: number | null
  defaultRequirementSourceKey: string | null
}

interface IdentityRow {
  id: string
  name: string
  publishedRevision: number | null
}

const SCOPE_ORDER = ['global-default', 'repository-group', 'repository'] as const

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/code/assignments',
  component: CodeAssignmentsPage,
})

export function CodeAssignmentsPage(): ReactElement {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const assignments = useQuery<{ items: AssignmentRow[] }>({
    queryKey: ['code-assignments'],
    queryFn: ({ signal }) => api.get('/api/code/repository-assignments', undefined, signal),
  })
  const employees = useQuery<IdentityRow[]>({
    queryKey: ['code-employees-identity'],
    queryFn: ({ signal }) => api.get('/api/code/digital-employees', undefined, signal),
  })
  const policies = useQuery<IdentityRow[]>({
    queryKey: ['code-policies-identity'],
    queryFn: ({ signal }) => api.get('/api/code/automation-policies', undefined, signal),
  })
  const repos = useQuery<{ id: string; urlRedacted: string | null }[]>({
    queryKey: ['cached-repos-for-assignments'],
    queryFn: ({ signal }) => api.get('/api/cached-repos', undefined, signal),
  })
  const groups = useQuery<{ id: string; name: string }[]>({
    queryKey: ['repo-groups-for-assignments'],
    queryFn: ({ signal }) => api.get('/api/repo-groups', undefined, signal),
  })
  const [editing, setEditing] = useState<AssignmentRow | null>(null)
  const remove = useMutation({
    mutationFn: (row: AssignmentRow) =>
      api.delete(
        `/api/code/repository-assignments/${row.scopeKind}${
          row.scopeRef === null ? '' : `?scopeRef=${encodeURIComponent(row.scopeRef)}`
        }`,
      ),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['code-assignments'] }),
  })

  if (assignments.isLoading) return <LoadingState />
  if (assignments.isError) return <ErrorBanner error={assignments.error} />
  const items = assignments.data?.items ?? []
  const employeeName = (id: string | null): string =>
    id === null ? '—' : (employees.data?.find((e) => e.id === id)?.name ?? id)
  const policyName = (id: string | null): string =>
    id === null ? '—' : (policies.data?.find((p) => p.id === id)?.name ?? id)
  const unpublishedWarnings = (row: AssignmentRow): string[] => {
    const warnings: string[] = []
    const emp = employees.data?.find((e) => e.id === row.employeeId)
    if (row.employeeId !== null && emp !== undefined && emp.publishedRevision === null) {
      warnings.push(t('code.assignments.warnEmployeeUnpublished'))
    }
    for (const pid of [row.selectionPolicyId, row.executionPolicyId]) {
      const pol = policies.data?.find((p) => p.id === pid)
      if (pid !== null && pol !== undefined && pol.publishedRevision === null) {
        warnings.push(t('code.assignments.warnPolicyUnpublished'))
      }
    }
    return warnings
  }

  return (
    <div className="page" data-testid="code-assignments-page">
      <PageHeader
        title={t('code.assignments.title')}
        meta={t('code.assignments.description')}
        actions={
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() =>
              setEditing({
                scopeKind: 'repository',
                scopeRef: null,
                employeeId: null,
                employeeRevision: null,
                selectionPolicyId: null,
                selectionPolicyRevision: null,
                executionPolicyId: null,
                executionPolicyRevision: null,
                defaultRequirementSourceKey: null,
              })
            }
            data-testid="assignment-create"
          >
            {t('code.assignments.create')}
          </button>
        }
      />
      {remove.isError ? <ErrorBanner error={remove.error} /> : null}
      {items.length === 0 ? (
        <EmptyState title={t('code.assignments.empty')} />
      ) : (
        SCOPE_ORDER.map((scope) => {
          const rows = items.filter((r) => r.scopeKind === scope)
          if (rows.length === 0) return null
          return (
            <section key={scope} className="page__section">
              <h3>{t(`code.assignments.scope.${scope}`)}</h3>
              <TableViewport label={t(`code.assignments.scope.${scope}`)}>
                <table className="table" data-testid={`assignments-${scope}`}>
                  <thead>
                    <tr>
                      <th>{t('code.assignments.colScope')}</th>
                      <th>{t('code.assignments.colEmployee')}</th>
                      <th>{t('code.assignments.colSelectionPolicy')}</th>
                      <th>{t('code.assignments.colExecutionPolicy')}</th>
                      <th>{t('code.assignments.colSourceKey')}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={`${row.scopeKind}:${row.scopeRef ?? 'global'}`}>
                        <td>{row.scopeRef ?? t('code.assignments.globalScope')}</td>
                        <td>
                          {employeeName(row.employeeId)}
                          {unpublishedWarnings(row).map((w) => (
                            <span key={w} className="chip chip--warn" title={w}>
                              ⚠
                            </span>
                          ))}
                        </td>
                        <td>{policyName(row.selectionPolicyId)}</td>
                        <td>{policyName(row.executionPolicyId)}</td>
                        <td>{row.defaultRequirementSourceKey ?? '—'}</td>
                        <td className="page__actions">
                          <button
                            type="button"
                            className="btn btn--xs"
                            onClick={() => setEditing(row)}
                          >
                            {t('common.edit')}
                          </button>
                          <button
                            type="button"
                            className="btn btn--xs btn--danger"
                            onClick={() => remove.mutate(row)}
                          >
                            {t('common.delete')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableViewport>
            </section>
          )
        })
      )}
      {editing !== null ? (
        <AssignmentDialog
          row={editing}
          employees={employees.data ?? []}
          policies={policies.data ?? []}
          repos={repos.data ?? []}
          groups={groups.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void queryClient.invalidateQueries({ queryKey: ['code-assignments'] })
          }}
        />
      ) : null}
    </div>
  )
}

function AssignmentDialog(props: {
  row: AssignmentRow
  employees: IdentityRow[]
  policies: IdentityRow[]
  repos: { id: string; urlRedacted: string | null }[]
  groups: { id: string; name: string }[]
  onClose: () => void
  onSaved: () => void
}): ReactElement {
  const { t } = useTranslation()
  const [scopeKind, setScopeKind] = useState(props.row.scopeKind)
  const [scopeRef, setScopeRef] = useState(props.row.scopeRef ?? '')
  const [employeeId, setEmployeeId] = useState(props.row.employeeId ?? '')
  const [selectionPolicyId, setSelectionPolicyId] = useState(props.row.selectionPolicyId ?? '')
  const [executionPolicyId, setExecutionPolicyId] = useState(props.row.executionPolicyId ?? '')
  const [sourceKey, setSourceKey] = useState(props.row.defaultRequirementSourceKey ?? '')

  const publishedOnly = (rows: IdentityRow[]) => rows.filter((r) => r.publishedRevision !== null)
  const revisionOf = (rows: IdentityRow[], id: string): number | null =>
    rows.find((r) => r.id === id)?.publishedRevision ?? null

  const save = useMutation({
    mutationFn: () =>
      api.put('/api/code/repository-assignments', {
        scopeKind,
        scopeRef: scopeKind === 'global-default' ? null : scopeRef || null,
        employee:
          employeeId === ''
            ? null
            : { id: employeeId, revision: revisionOf(props.employees, employeeId) ?? 1 },
        selectionPolicy:
          selectionPolicyId === ''
            ? null
            : {
                id: selectionPolicyId,
                revision: revisionOf(props.policies, selectionPolicyId) ?? 1,
              },
        executionPolicy:
          executionPolicyId === ''
            ? null
            : {
                id: executionPolicyId,
                revision: revisionOf(props.policies, executionPolicyId) ?? 1,
              },
        defaultRequirementSourceKey: sourceKey === '' ? null : sourceKey,
      }),
    onSuccess: props.onSaved,
  })

  return (
    <Dialog
      open
      title={t('code.assignments.dialogTitle')}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className="btn btn--sm" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={save.isPending || (scopeKind !== 'global-default' && scopeRef === '')}
            onClick={() => save.mutate()}
            data-testid="assignment-save"
          >
            {t('common.save')}
          </button>
        </>
      }
    >
      {save.isError ? <ErrorBanner error={save.error} /> : null}
      <Field label={t('code.assignments.colScope')} required>
        <Select
          value={scopeKind}
          onChange={(next) => {
            setScopeKind(next as AssignmentRow['scopeKind'])
            setScopeRef('')
          }}
          options={SCOPE_ORDER.map((s) => ({ value: s, label: t(`code.assignments.scope.${s}`) }))}
          data-testid="assignment-scope-kind"
        />
      </Field>
      {scopeKind === 'repository' ? (
        <Field label={t('code.assignments.repoRef')} required>
          <Select
            value={scopeRef}
            onChange={setScopeRef}
            options={props.repos.map((r) => ({ value: r.id, label: r.urlRedacted ?? r.id }))}
            data-testid="assignment-scope-ref"
          />
        </Field>
      ) : null}
      {scopeKind === 'repository-group' ? (
        <Field label={t('code.assignments.groupRef')} required>
          <Select
            value={scopeRef}
            onChange={setScopeRef}
            options={props.groups.map((g) => ({ value: g.id, label: g.name }))}
            data-testid="assignment-scope-ref"
          />
        </Field>
      ) : null}
      <Field label={t('code.assignments.colEmployee')} hint={t('code.assignments.publishedOnly')}>
        <Select
          value={employeeId}
          onChange={setEmployeeId}
          options={[
            { value: '', label: '—' },
            ...publishedOnly(props.employees).map((e) => ({ value: e.id, label: e.name })),
          ]}
          data-testid="assignment-employee"
        />
      </Field>
      <Field label={t('code.assignments.colSelectionPolicy')}>
        <Select
          value={selectionPolicyId}
          onChange={setSelectionPolicyId}
          options={[
            { value: '', label: '—' },
            ...publishedOnly(props.policies).map((p) => ({ value: p.id, label: p.name })),
          ]}
          data-testid="assignment-selection-policy"
        />
      </Field>
      <Field label={t('code.assignments.colExecutionPolicy')}>
        <Select
          value={executionPolicyId}
          onChange={setExecutionPolicyId}
          options={[
            { value: '', label: '—' },
            ...publishedOnly(props.policies).map((p) => ({ value: p.id, label: p.name })),
          ]}
          data-testid="assignment-execution-policy"
        />
      </Field>
      <Field label={t('code.assignments.colSourceKey')}>
        <TextInput value={sourceKey} onChange={setSourceKey} data-testid="assignment-source-key" />
      </Field>
    </Dialog>
  )
}
