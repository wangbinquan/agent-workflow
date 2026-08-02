// RFC-248 T37 —— `/repos` 页「仓库组」分段的列表。
//
// 与远端仓库那一栏共用同一套骨架：`<TableViewport>` + `.data-table` +
// `.btn .btn--sm`，状态用 `<LoadingState>` / `<EmptyState>` / `<ErrorBanner>`。
// 不自写表格 chrome、不自写空态（CLAUDE.md 强制条款）。
//
// 展开一行显示 `RepoLayoutTree` —— 与编辑器的实时预览、任务详情的布局块是
// **同一个组件**，三处的树长得一模一样。

import { useState } from 'react'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import type { RepoGroup, RepoGroupLayoutResponse } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { QueryState } from '@/components/QueryState'
import { TableViewport } from '@/components/TableViewport'
import { RepoLayoutTree } from '@/components/repos/RepoLayoutTree'

export interface RepoGroupsPaneProps {
  list: UseQueryResult<{ items: RepoGroup[] }>
  onEdit: (g: RepoGroup) => void
  onDelete: (id: string) => void
  deleteError: unknown
  newAction: ReactNode
}

function LayoutRow({ groupId }: { groupId: string }) {
  const { t } = useTranslation()
  const layout = useQuery<RepoGroupLayoutResponse>({
    queryKey: ['repo-group-layout', groupId],
    queryFn: ({ signal }) =>
      api.get(`/api/repo-groups/${encodeURIComponent(groupId)}/layout`, undefined, signal),
  })
  // 展平失败（成环 / 超深度 / 挂载点冲突）是**这个组本身**的问题，`QueryState`
  // 把它渲染在它自己那一行，而不是把整张表打红。
  return (
    <QueryState
      query={layout}
      data={layout.data?.repos ?? []}
      emptyText={t('repoGroups.layout.empty')}
      testid={`repo-group-layout-state-${groupId}`}
    >
      {(repos) => <RepoLayoutTree repos={repos} testidPrefix={`repo-group-layout-${groupId}`} />}
    </QueryState>
  )
}

export function RepoGroupsPane({
  list,
  onEdit,
  onDelete,
  deleteError,
  newAction,
}: RepoGroupsPaneProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<string | null>(null)
  const items = list.data?.items ?? []

  if (list.isLoading) {
    return <LoadingState label={t('repoGroups.loading')} data-testid="repo-groups-loading" />
  }
  return (
    <>
      {list.error !== null && list.error !== undefined && (
        <ErrorBanner error={list.error} onRetry={() => void list.refetch()} />
      )}
      {deleteError !== null && deleteError !== undefined && <ErrorBanner error={deleteError} />}
      {items.length === 0 ? (
        <EmptyState
          title={t('repoGroups.empty')}
          description={t('repoGroups.emptyDescription')}
          action={newAction}
          data-testid="repo-groups-empty"
        />
      ) : (
        <TableViewport label={t('repoGroups.tabLabel')}>
          <table className="data-table" data-testid="repo-groups-table">
            <thead>
              <tr>
                <th>{t('repoGroups.columns.name')}</th>
                <th>{t('repoGroups.columns.repoCount')}</th>
                <th>{t('repoGroups.columns.memories')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((g) => (
                <>
                  <tr key={g.id} data-testid={`repo-group-row-${g.id}`}>
                    <td>
                      <button
                        type="button"
                        className="btn btn--xs"
                        onClick={() => setExpanded((cur) => (cur === g.id ? null : g.id))}
                        data-testid={`repo-group-expand-${g.id}`}
                      >
                        {expanded === g.id ? '▾' : '▸'}
                      </button>{' '}
                      {g.name}
                      {g.description !== '' && (
                        <div className="data-table__muted">{g.description}</div>
                      )}
                    </td>
                    <td>{g.flatRepoCount}</td>
                    <td>{g.boundMemories}</td>
                    <td>
                      <div className="data-table__actions">
                        <button
                          type="button"
                          className="btn btn--sm"
                          onClick={() => onEdit(g)}
                          data-testid={`repo-group-edit-${g.id}`}
                        >
                          {t('common.edit')}
                        </button>
                        <button
                          type="button"
                          className="btn btn--sm btn--danger"
                          onClick={() => onDelete(g.id)}
                          data-testid={`repo-group-delete-${g.id}`}
                        >
                          {t('common.delete')}
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expanded === g.id && (
                    <tr key={`${g.id}-layout`}>
                      <td colSpan={4}>
                        <LayoutRow groupId={g.id} />
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </TableViewport>
      )}
    </>
  )
}
