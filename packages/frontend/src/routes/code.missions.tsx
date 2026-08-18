// RFC-310 PR-5 T61 —— DevelopmentMission 列表 + launch（三形态）。
//
// launch 表单承载 §5.1 的三种入口：正文-only、正文/文件（逐文件指定仓库
// 目标路径，先经 mission-input-uploads 换 uploadRef）、外部需求 ID。员工
// 显式选择（requestedEmployee 用已发布 revision）；idempotencyKey 由前端
// 一次性生成（重复点击提交是幂等重放，不产生第二个 mission）。列表 10s
// 轮询——mission 状态由 daemon reconcile 推进，页面只读投影。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, Link } from '@tanstack/react-router'
import { useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextArea, TextInput } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { StatusChip, type StatusChipKind } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { usePermission } from '@/hooks/useActor'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/code/missions',
  component: MissionsPage,
})

export interface MissionSummary {
  id: string
  status: string
  automationMode: string
  repositoryId: string
  sourceKind: string
  externalId: string | null
  deliveryKind: string
  employeeId: string | null
  blockCode: string | null
  terminalKind: string | null
  createdAt: number
  updatedAt: number
}

export function missionStatusKind(status: string): StatusChipKind {
  if (status === 'merged' || status === 'completed-no-change') return 'success'
  if (status === 'blocked' || status === 'failed') return 'danger'
  if (status === 'awaiting-information' || status === 'waiting-committer') return 'warn'
  if (status === 'canceled' || status === 'closed-unmerged') return 'neutral'
  return 'info'
}

type LaunchKind = 'body' | 'uploads' | 'external'

interface UploadDraft {
  file: File
  targetPath: string
}

function MissionsPage(): ReactElement {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const canLaunch = usePermission('development-missions:launch')

  const missions = useQuery<{ items: MissionSummary[] }>({
    queryKey: ['code-missions'],
    queryFn: ({ signal }) => api.get('/api/code/missions', undefined, signal),
    refetchInterval: 10_000,
  })

  const [launchOpen, setLaunchOpen] = useState(false)

  return (
    <div className="page">
      <PageHeader
        title={t('code.missions.title')}
        back={<Link to="/code">{t('code.missions.backToCode')}</Link>}
        actions={
          canLaunch ? (
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={() => setLaunchOpen(true)}
              data-testid="mission-launch-open"
            >
              {t('code.missions.launch')}
            </button>
          ) : null
        }
      >
        <p className="page__subtitle">{t('code.missions.subtitle')}</p>
      </PageHeader>

      {missions.isLoading ? <LoadingState /> : null}
      {missions.isError ? <ErrorBanner error={missions.error} /> : null}
      {missions.data !== undefined && missions.data.items.length === 0 ? (
        <EmptyState
          title={t('code.missions.emptyTitle')}
          description={t('code.missions.emptyBody')}
        />
      ) : null}

      {missions.data !== undefined && missions.data.items.length > 0 ? (
        <TableViewport label={t('code.missions.title')}>
          <table data-testid="mission-list">
            <thead>
              <tr>
                <th scope="col">{t('code.missions.colMission')}</th>
                <th scope="col">{t('code.missions.colStatus')}</th>
                <th scope="col">{t('code.missions.colRepository')}</th>
                <th scope="col">{t('code.missions.colSource')}</th>
                <th scope="col">{t('code.missions.colBlock')}</th>
                <th scope="col">{t('code.missions.colUpdated')}</th>
              </tr>
            </thead>
            <tbody>
              {missions.data.items.map((mission) => (
                <tr key={mission.id}>
                  <td>
                    <Link to="/code/missions/$missionId" params={{ missionId: mission.id }}>
                      {mission.id.slice(-8)}
                    </Link>
                  </td>
                  <td>
                    <StatusChip kind={missionStatusKind(mission.status)} size="sm">
                      {mission.status}
                    </StatusChip>
                  </td>
                  <td>{mission.repositoryId}</td>
                  <td>
                    {mission.sourceKind === 'direct'
                      ? t('code.missions.sourceDirect')
                      : (mission.externalId ?? t('code.missions.sourceExternal'))}
                  </td>
                  <td>{mission.blockCode ?? '—'}</td>
                  <td>{new Date(mission.updatedAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      ) : null}

      {launchOpen ? (
        <LaunchDialog
          onClose={() => setLaunchOpen(false)}
          onLaunched={() => {
            setLaunchOpen(false)
            void qc.invalidateQueries({ queryKey: ['code-missions'] })
          }}
        />
      ) : null}
    </div>
  )
}

interface EmployeeSummary {
  id: string
  name: string
  publishedRevision: number | null
}

function LaunchDialog(props: { onClose: () => void; onLaunched: () => void }): ReactElement {
  const { t } = useTranslation()
  const [kind, setKind] = useState<LaunchKind>('body')
  const [repositoryId, setRepositoryId] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [externalId, setExternalId] = useState('')
  const [sourceKey, setSourceKey] = useState('')
  const [uploads, setUploads] = useState<UploadDraft[]>([])
  // 幂等键在对话框生命周期内固定：网络重试/重复点击是同一 launch 的重放。
  const [idempotencyKey] = useState(() => `ui-${crypto.randomUUID()}`)

  const repos = useQuery<{ items: { id: string; urlRedacted: string | null }[] }>({
    queryKey: ['cached-repos'],
    queryFn: ({ signal }) => api.get('/api/cached-repos', undefined, signal),
  })
  const employees = useQuery<{ items: EmployeeSummary[] }>({
    queryKey: ['digital-employees'],
    queryFn: ({ signal }) => api.get('/api/code/digital-employees', undefined, signal),
  })

  const publishedEmployees = useMemo(
    () => (employees.data?.items ?? []).filter((e) => e.publishedRevision !== null),
    [employees.data],
  )

  const launch = useMutation({
    mutationFn: async () => {
      const uploadRefs: { uploadRef: string; repositoryTargetPath: string }[] = []
      for (const draft of uploads) {
        const bytes = await draft.file.arrayBuffer()
        const uploaded = await api.postBytes<{ uploadRef: string }>(
          '/api/code/mission-input-uploads',
          bytes,
          { 'x-upload-name': draft.file.name },
        )
        uploadRefs.push({
          uploadRef: uploaded.uploadRef,
          repositoryTargetPath: draft.targetPath.trim(),
        })
      }
      const employee = publishedEmployees.find((e) => e.id === employeeId)
      const submission =
        kind === 'external'
          ? {
              kind: 'external-reference' as const,
              externalId: externalId.trim(),
              ...(sourceKey.trim() === '' ? {} : { sourceKey: sourceKey.trim() }),
            }
          : {
              kind: 'direct' as const,
              title: title.trim(),
              body: body.trim() === '' ? null : body,
              uploads: uploadRefs,
            }
      return api.post<{ missionId: string; status: string; created: boolean }>(
        '/api/code/missions',
        {
          idempotencyKey,
          repositoryId,
          repositoryGroupId: null,
          submission,
          delivery: { kind: 'create-merge-request' },
          requestedEmployee:
            employee === undefined
              ? null
              : { id: employee.id, revision: employee.publishedRevision },
          requestedPolicy: null,
          actorUserId: null,
        },
      )
    },
    onSuccess: () => props.onLaunched(),
  })

  const submittable =
    repositoryId !== '' &&
    (kind === 'external'
      ? externalId.trim() !== ''
      : title.trim() !== '' &&
        (kind === 'body'
          ? body.trim() !== ''
          : uploads.length > 0 && uploads.every((u) => u.targetPath.trim() !== '')))

  return (
    <Dialog
      open
      title={t('code.missions.launchTitle')}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className="btn btn--sm" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={!submittable || launch.isPending}
            onClick={() => launch.mutate()}
            data-testid="mission-launch-submit"
          >
            {launch.isPending ? t('code.missions.launching') : t('code.missions.launch')}
          </button>
        </>
      }
    >
      {launch.isError ? <ErrorBanner error={launch.error} /> : null}
      <Field label={t('code.missions.formKind')}>
        <Segmented
          value={kind}
          onChange={(next) => setKind(next as LaunchKind)}
          ariaLabel={t('code.missions.formKind')}
          options={[
            { value: 'body', label: t('code.missions.kindBody') },
            { value: 'uploads', label: t('code.missions.kindUploads') },
            { value: 'external', label: t('code.missions.kindExternal') },
          ]}
        />
      </Field>
      <Field label={t('code.missions.formRepository')} required>
        <Select
          value={repositoryId}
          onChange={setRepositoryId}
          options={(repos.data?.items ?? []).map((repo) => ({
            value: repo.id,
            label: repo.urlRedacted ?? repo.id,
          }))}
          placeholder={t('code.missions.pickRepository')}
          data-testid="mission-repo-select"
        />
      </Field>
      <Field label={t('code.missions.formEmployee')} hint={t('code.missions.employeeHint')}>
        <Select
          value={employeeId}
          onChange={setEmployeeId}
          options={publishedEmployees.map((e) => ({ value: e.id, label: e.name }))}
          placeholder={t('code.missions.pickEmployee')}
          data-testid="mission-employee-select"
        />
      </Field>
      {kind !== 'external' ? (
        <>
          <Field label={t('code.missions.formTitle')} required>
            <TextInput value={title} onChange={setTitle} data-testid="mission-title" />
          </Field>
          <Field label={t('code.missions.formBody')} required={kind === 'body'}>
            <TextArea value={body} onChange={setBody} rows={6} data-testid="mission-body" />
          </Field>
        </>
      ) : (
        <>
          <Field label={t('code.missions.formExternalId')} required>
            <TextInput value={externalId} onChange={setExternalId} data-testid="mission-external" />
          </Field>
          <Field label={t('code.missions.formSourceKey')} hint={t('code.missions.sourceKeyHint')}>
            <TextInput value={sourceKey} onChange={setSourceKey} />
          </Field>
        </>
      )}
      {kind === 'uploads' ? (
        <Field
          label={t('code.missions.formUploads')}
          required
          hint={t('code.missions.uploadsHint')}
        >
          <input
            type="file"
            multiple
            data-testid="mission-upload-files"
            onChange={(event) => {
              const files = [...(event.currentTarget.files ?? [])]
              setUploads(files.map((file) => ({ file, targetPath: file.name })))
            }}
          />
          {uploads.map((draft, index) => (
            <div key={draft.file.name} className="mission-upload-row">
              <span className="mission-upload-row__name">{draft.file.name}</span>
              <TextInput
                value={draft.targetPath}
                onChange={(next) =>
                  setUploads((prev) =>
                    prev.map((row, i) => (i === index ? { ...row, targetPath: next } : row)),
                  )
                }
                data-testid={`mission-upload-target-${index}`}
              />
            </div>
          ))}
        </Field>
      ) : null}
    </Dialog>
  )
}
