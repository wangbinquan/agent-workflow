// RFC-310 PR-5 T61 —— Mission 详情：状态/阻塞/readiness/来源/问答/动作/effect。
//
// 页面是只读投影 + 少量命令（cancel/retry/answers/source select/refresh）；
// 所有推进由 daemon reconcile 完成，5s 轮询把它演给人看。blockCode 原样示人
// ——「诚实接线边界」是产品语义（开单 ≠ 在跑），不是要藏起来的错误。

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createRoute, Link } from '@tanstack/react-router'
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextArea } from '@/components/Form'
import { LoadingState } from '@/components/LoadingState'
import { PageHeader } from '@/components/PageHeader'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { usePermission } from '@/hooks/useActor'
import { missionStatusKind } from './code.missions'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/code/missions/$missionId',
  component: MissionDetailPage,
})

interface MissionDetail {
  id: string
  status: string
  automationMode: string
  transitionFence: string
  repositoryId: string
  sourceKind: string
  externalId: string | null
  resolvedSourceKey: string | null
  deliveryKind: string
  employeeId: string | null
  employeeRevision: number | null
  policyId: string | null
  policyRevision: number | null
  blockCode: string | null
  blockDetail: string | null
  terminalKind: string | null
  createdAt: number
  updatedAt: number
  sources: {
    generation: number
    sourceKind: string
    externalId: string | null
    sourceRevision: string | null
    bundleRef: string | null
    manifestDigest: string | null
    state: string
  }[]
  readiness: unknown
  questions: {
    questionSetRef: string
    origin: string
    channel: string
    items: { questionId: string; text: string; answerKind: string; choices: string[] | null }[]
  } | null
  action: {
    lastOutcome: string | null
    lastCapability: string | null
    candidateRef: string | null
    clarificationState: string | null
  }
  effects: {
    id: string
    effectKind: string
    state: string
    intentDigest: string
    createdAt: number
    settledAt: number | null
  }[]
}

interface ManifestFile {
  relativePath: string
  role: string
  mediaType: string
  bytes: number
  sha256: string
}

function MissionDetailPage(): ReactElement {
  const { t } = useTranslation()
  const { missionId } = Route.useParams()
  const qc = useQueryClient()
  const canInteract = usePermission('development-missions:interact')
  const canCancel = usePermission('development-missions:cancel')
  const canRetry = usePermission('development-missions:retry')

  const detail = useQuery<MissionDetail>({
    queryKey: ['code-mission', missionId],
    queryFn: ({ signal }) =>
      api.get(`/api/code/missions/${encodeURIComponent(missionId)}`, undefined, signal),
    refetchInterval: 5_000,
  })
  const manifest = useQuery<{
    manifest: { bundleId: string; files: ManifestFile[]; totals: { files: number; bytes: number } }
  }>({
    queryKey: ['code-mission-manifest', missionId],
    queryFn: ({ signal }) =>
      api.get(
        `/api/code/missions/${encodeURIComponent(missionId)}/requirement-manifest`,
        undefined,
        signal,
      ),
    retry: false,
    refetchInterval: 15_000,
  })

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['code-mission', missionId] })
    void qc.invalidateQueries({ queryKey: ['code-mission-manifest', missionId] })
  }

  const cancel = useMutation({
    mutationFn: () => api.post(`/api/code/missions/${encodeURIComponent(missionId)}/cancel`, {}),
    onSuccess: invalidate,
  })
  const retry = useMutation({
    mutationFn: () => api.post(`/api/code/missions/${encodeURIComponent(missionId)}/retry`, {}),
    onSuccess: invalidate,
  })
  const refreshPreview = useMutation({
    mutationFn: () =>
      api.post<{ changed: boolean; newSourceRevision: string }>(
        `/api/code/missions/${encodeURIComponent(missionId)}/source-refresh/preview`,
        {},
      ),
  })
  const refreshApply = useMutation({
    mutationFn: () =>
      api.post(`/api/code/missions/${encodeURIComponent(missionId)}/source-refresh`, {}),
    onSuccess: invalidate,
  })

  if (detail.isLoading) return <LoadingState />
  if (detail.isError) return <ErrorBanner error={detail.error} />
  const mission = detail.data
  if (mission === undefined) return <LoadingState />

  const terminal =
    mission.status === 'merged' ||
    mission.status === 'closed-unmerged' ||
    mission.status === 'completed-no-change' ||
    mission.status === 'canceled'

  return (
    <div className="page">
      <PageHeader
        title={t('code.missions.detailTitle', { id: mission.id.slice(-8) })}
        back={<Link to="/code/missions">{t('code.missions.backToList')}</Link>}
        meta={
          <>
            <StatusChip kind={missionStatusKind(mission.status)}>{mission.status}</StatusChip>{' '}
            <span className="page__meta-item">{mission.repositoryId}</span>{' '}
            <span className="page__meta-item">{mission.deliveryKind}</span>
          </>
        }
        actions={
          <>
            {canRetry && mission.status === 'blocked' ? (
              <button
                type="button"
                className="btn btn--sm"
                disabled={retry.isPending}
                onClick={() => retry.mutate()}
                data-testid="mission-retry"
              >
                {t('code.missions.retry')}
              </button>
            ) : null}
            {canCancel && !terminal ? (
              <button
                type="button"
                className="btn btn--sm btn--danger"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate()}
                data-testid="mission-cancel"
              >
                {t('common.cancel')}
              </button>
            ) : null}
          </>
        }
      />
      {cancel.isError ? <ErrorBanner error={cancel.error} /> : null}
      {retry.isError ? <ErrorBanner error={retry.error} /> : null}

      {mission.blockCode !== null ? (
        <section className="page__section" data-testid="mission-block">
          <h3>{t('code.missions.blockTitle')}</h3>
          <p>
            <code>{mission.blockCode}</code>
          </p>
          {mission.blockDetail !== null ? <p>{mission.blockDetail}</p> : null}
        </section>
      ) : null}

      {mission.questions !== null && canInteract ? (
        <AnswersSection
          missionId={mission.id}
          questions={mission.questions}
          onSubmitted={invalidate}
        />
      ) : null}

      <section className="page__section">
        <h3>{t('code.missions.actionTitle')}</h3>
        <dl className="mission-kv">
          <dt>{t('code.missions.actionOutcome')}</dt>
          <dd>{mission.action.lastOutcome ?? '—'}</dd>
          <dt>{t('code.missions.actionCapability')}</dt>
          <dd>{mission.action.lastCapability ?? '—'}</dd>
          <dt>{t('code.missions.actionCandidate')}</dt>
          <dd>
            {mission.action.candidateRef === null ? (
              '—'
            ) : (
              <code>{mission.action.candidateRef.slice(0, 16)}…</code>
            )}
          </dd>
        </dl>
      </section>

      <section className="page__section">
        <h3>{t('code.missions.sourcesTitle')}</h3>
        {mission.sourceKind === 'external-reference' && canInteract ? (
          <p>
            <button
              type="button"
              className="btn btn--xs"
              disabled={refreshPreview.isPending}
              onClick={() => refreshPreview.mutate()}
            >
              {t('code.missions.refreshPreview')}
            </button>{' '}
            {refreshPreview.data !== undefined ? (
              refreshPreview.data.changed ? (
                <>
                  <StatusChip kind="warn" size="sm">
                    {t('code.missions.refreshChanged', {
                      revision: refreshPreview.data.newSourceRevision,
                    })}
                  </StatusChip>{' '}
                  <button
                    type="button"
                    className="btn btn--xs btn--primary"
                    disabled={refreshApply.isPending}
                    onClick={() => refreshApply.mutate()}
                  >
                    {t('code.missions.refreshApply')}
                  </button>
                </>
              ) : (
                <StatusChip kind="success" size="sm">
                  {t('code.missions.refreshUnchanged')}
                </StatusChip>
              )
            ) : null}
          </p>
        ) : null}
        {refreshPreview.isError ? <ErrorBanner error={refreshPreview.error} /> : null}
        {mission.sources.length === 0 ? (
          <p>{t('code.missions.noSources')}</p>
        ) : (
          <TableViewport label={t('code.missions.sourcesTitle')}>
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('code.missions.colGeneration')}</th>
                  <th scope="col">{t('code.missions.colSource')}</th>
                  <th scope="col">{t('code.missions.colRevision')}</th>
                  <th scope="col">{t('code.missions.colState')}</th>
                </tr>
              </thead>
              <tbody>
                {mission.sources.map((source) => (
                  <tr key={source.generation}>
                    <td>{source.generation}</td>
                    <td>{source.externalId ?? t('code.missions.sourceDirect')}</td>
                    <td>{source.sourceRevision ?? '—'}</td>
                    <td>{source.state}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        )}
      </section>

      <section className="page__section">
        <h3>{t('code.missions.manifestTitle')}</h3>
        {manifest.isError ? <p>{t('code.missions.noManifest')}</p> : null}
        {manifest.data !== undefined ? (
          <ManifestSection missionId={mission.id} files={manifest.data.manifest.files} />
        ) : null}
      </section>

      <section className="page__section">
        <h3>{t('code.missions.effectsTitle')}</h3>
        {mission.effects.length === 0 ? (
          <p>{t('code.missions.noEffects')}</p>
        ) : (
          <TableViewport label={t('code.missions.effectsTitle')}>
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('code.missions.colEffect')}</th>
                  <th scope="col">{t('code.missions.colState')}</th>
                  <th scope="col">{t('code.missions.colCreated')}</th>
                </tr>
              </thead>
              <tbody>
                {mission.effects.map((effect) => (
                  <tr key={effect.id}>
                    <td>{effect.effectKind}</td>
                    <td>
                      <StatusChip
                        size="sm"
                        kind={
                          effect.state === 'confirmed'
                            ? 'success'
                            : effect.state === 'failed' || effect.state === 'invalidated'
                              ? 'danger'
                              : 'info'
                        }
                      >
                        {effect.state}
                      </StatusChip>
                    </td>
                    <td>{new Date(effect.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableViewport>
        )}
      </section>

      <section className="page__section">
        <h3>{t('code.missions.readinessTitle')}</h3>
        {mission.readiness === null ? (
          <p>{t('code.missions.noReadiness')}</p>
        ) : (
          <pre className="mission-readiness" data-testid="mission-readiness">
            {JSON.stringify(mission.readiness, null, 2)}
          </pre>
        )}
      </section>
    </div>
  )
}

function AnswersSection(props: {
  missionId: string
  questions: NonNullable<MissionDetail['questions']>
  onSubmitted: () => void
}): ReactElement {
  const { t } = useTranslation()
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const submit = useMutation({
    mutationFn: () =>
      api.post(`/api/code/missions/${encodeURIComponent(props.missionId)}/answers`, {
        questionSetRef: props.questions.questionSetRef,
        answers: props.questions.items.map((item) => ({
          questionId: item.questionId,
          answer: answers[item.questionId] ?? '',
        })),
      }),
    onSuccess: props.onSubmitted,
  })
  const complete = props.questions.items.every(
    (item) => (answers[item.questionId] ?? '').trim() !== '',
  )
  return (
    <section className="page__section" data-testid="mission-questions">
      <h3>{t('code.missions.questionsTitle')}</h3>
      {submit.isError ? <ErrorBanner error={submit.error} /> : null}
      {props.questions.items.map((item) => (
        <Field key={item.questionId} label={item.text} required>
          <TextArea
            value={answers[item.questionId] ?? ''}
            onChange={(next) => setAnswers((prev) => ({ ...prev, [item.questionId]: next }))}
            rows={2}
            data-testid={`mission-answer-${item.questionId}`}
          />
        </Field>
      ))}
      <button
        type="button"
        className="btn btn--sm btn--primary"
        disabled={!complete || submit.isPending}
        onClick={() => submit.mutate()}
        data-testid="mission-answers-submit"
      >
        {t('code.missions.submitAnswers')}
      </button>
    </section>
  )
}

function ManifestSection(props: { missionId: string; files: ManifestFile[] }): ReactElement {
  const { t } = useTranslation()
  const [viewing, setViewing] = useState<{ file: ManifestFile; text: string } | null>(null)
  const view = useMutation({
    mutationFn: async (file: ManifestFile) => {
      const blob = await api.getBlob(
        `/api/code/missions/${encodeURIComponent(props.missionId)}/requirement-files/${file.sha256}`,
      )
      const text = await blob.slice(0, 256 * 1024).text()
      return { file, text }
    },
    onSuccess: (result) => setViewing(result),
  })
  return (
    <>
      {view.isError ? <ErrorBanner error={view.error} /> : null}
      <TableViewport label={t('code.missions.manifestTitle')}>
        <table data-testid="mission-manifest">
          <thead>
            <tr>
              <th scope="col">{t('code.missions.colFile')}</th>
              <th scope="col">{t('code.missions.colRole')}</th>
              <th scope="col">{t('code.missions.colBytes')}</th>
              <th scope="col" aria-label={t('code.missions.colActions')} />
            </tr>
          </thead>
          <tbody>
            {props.files.map((file) => (
              <tr key={file.sha256 + file.relativePath}>
                <td>{file.relativePath}</td>
                <td>{file.role}</td>
                <td>{file.bytes}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn--xs"
                    disabled={view.isPending}
                    onClick={() => view.mutate(file)}
                  >
                    {t('code.missions.viewFile')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableViewport>
      {viewing !== null ? (
        <Dialog open title={viewing.file.relativePath} onClose={() => setViewing(null)}>
          <pre className="mission-file-preview">{viewing.text}</pre>
        </Dialog>
      ) : null}
    </>
  )
}
