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
import { Card } from '@/components/Card'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextArea, TextInput } from '@/components/Form'
import { FormSection } from '@/components/FormSection'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner, type NoticeBannerTone } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'
import { TableViewport } from '@/components/TableViewport'
import { EvidenceBrowser, type PipelineEvidenceSummary } from '@/components/code/EvidenceBrowser'
import { JourneyNextAction, type JourneyProjection } from '@/components/code/JourneyNextAction'
import {
  MissionTimeline,
  type TimelineDecision,
  type TimelineEffect,
} from '@/components/code/MissionTimeline'
import { usePermission } from '@/hooks/useActor'
import { missionStatusKind, missionStatusLabel } from './code.missions'
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
  collaboration?: {
    children: {
      stepRunId: string
      childMissionId: string | null
      status: string | null
      completionSatisfied: boolean
      observedAt: number | null
      deadlineAt: number | null
    }[]
    approvals: {
      stepRunId: string
      externalRequestRef: string | null
      status: string
      nextObserveAt: number | null
      deadlineAt: number
      updatedAt: number
    }[]
  }
  /** PR-8 T92 合同：detail 投影的 pipeline evidence 摘要（主 session 接线；
   *  缺席（undefined/null）= 尚未采集或投影未接，区块优雅降级。 */
  pipeline?: PipelineEvidenceSummary | null
  mergeRequest: { iid: string; state: string; href: string | null } | null
  journey: JourneyProjection
}

interface MissionReadiness {
  evaluatedForHead: string | null
  factDigest: string
  automationReady: boolean
  hostMergeable: 'yes' | 'no' | 'unknown'
  machineHolds: Array<{ kind: string; detail: string }>
  humanHolds: Array<{ kind: string; detail: string }>
  status: 'working' | 'waiting-committer' | 'ready-to-merge'
}

export function missionGuidance(input: {
  status: string
  automationMode: string
  questions: MissionDetail['questions']
}): { tone: NoticeBannerTone; title: string; body: string } {
  if (input.status === 'merged') {
    return { tone: 'success', title: 'mergedTitle', body: 'mergedBody' }
  }
  if (input.status === 'ready-to-merge' || input.status === 'waiting-committer') {
    return { tone: 'success', title: 'readyTitle', body: 'readyBody' }
  }
  if (input.questions !== null || input.status === 'awaiting-information') {
    return { tone: 'warning', title: 'answersTitle', body: 'answersBody' }
  }
  if (input.status === 'blocked' || input.status === 'failed') {
    return { tone: 'error', title: 'blockedTitle', body: 'blockedBody' }
  }
  if (input.automationMode === 'tracking-only') {
    return { tone: 'warning', title: 'handoffTitle', body: 'handoffBody' }
  }
  if (input.status === 'watching') {
    return { tone: 'info', title: 'watchingTitle', body: 'watchingBody' }
  }
  if (input.status === 'closed-unmerged' || input.status === 'canceled') {
    return { tone: 'info', title: 'terminalTitle', body: 'terminalBody' }
  }
  return { tone: 'info', title: 'workingTitle', body: 'workingBody' }
}

function parsedReadiness(value: unknown): MissionReadiness | null {
  if (value === null || typeof value !== 'object') return null
  const row = value as Partial<MissionReadiness>
  if (
    typeof row.automationReady !== 'boolean' ||
    (row.hostMergeable !== 'yes' &&
      row.hostMergeable !== 'no' &&
      row.hostMergeable !== 'unknown') ||
    !Array.isArray(row.machineHolds) ||
    !Array.isArray(row.humanHolds) ||
    (row.status !== 'working' &&
      row.status !== 'waiting-committer' &&
      row.status !== 'ready-to-merge')
  ) {
    return null
  }
  return row as MissionReadiness
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
  const canHandoff = usePermission('development-missions:handoff')
  const canAttach = usePermission('development-missions:attach')
  const canResume = usePermission('development-missions:resume')
  const [attachOpen, setAttachOpen] = useState(false)

  const detail = useQuery<MissionDetail>({
    queryKey: ['code-mission', missionId],
    queryFn: ({ signal }) =>
      api.get(`/api/code/missions/${encodeURIComponent(missionId)}`, undefined, signal),
    refetchInterval: 5_000,
  })
  const repos = useQuery<{ items: { id: string; urlRedacted: string | null }[] }>({
    queryKey: ['cached-repos'],
    queryFn: ({ signal }) => api.get('/api/cached-repos', undefined, signal),
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
  const handoff = useMutation({
    mutationFn: () => api.post(`/api/code/missions/${encodeURIComponent(missionId)}/handoff`, {}),
    onSuccess: invalidate,
  })
  const resume = useMutation({
    mutationFn: () => api.post(`/api/code/missions/${encodeURIComponent(missionId)}/resume`, {}),
    onSuccess: invalidate,
  })
  const trace = useQuery<{ items: TimelineDecision[] }>({
    queryKey: ['code-mission-trace', missionId],
    queryFn: ({ signal }) =>
      api.get(
        `/api/code/missions/${encodeURIComponent(missionId)}/decision-trace`,
        undefined,
        signal,
      ),
    refetchInterval: 15_000,
  })
  // T91 configuration upgrade 呈现：policy 已有新发布 revision 时提示（升级
  // 执行面属 PR-9，这里只示人不动作）。
  const policyId = detail.data?.policyId ?? null
  const policyIdentity = useQuery<{ publishedRevision: number | null }>({
    queryKey: ['code-mission-policy', policyId],
    queryFn: ({ signal }) =>
      api.get(`/api/code/automation-policies/${encodeURIComponent(policyId!)}`, undefined, signal),
    enabled: policyId !== null,
    retry: false,
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
  const guidance = missionGuidance(mission)
  const readiness = parsedReadiness(mission.readiness)
  const collaboration = mission.collaboration ?? { children: [], approvals: [] }
  const repositoryLabel =
    (repos.data?.items ?? []).find((repository) => repository.id === mission.repositoryId)
      ?.urlRedacted ?? mission.repositoryId

  return (
    <div className="page page--operations code-mission-detail">
      <div className="operations-surface">
        <PageHeader
          title={t('code.missions.detailTitle', { id: mission.id.slice(-8) })}
          className="operations-surface__header"
          meta={
            <>
              <StatusChip kind={missionStatusKind(mission.status)}>
                {missionStatusLabel(t, mission.status)}
              </StatusChip>{' '}
              <span className="page__meta-item">{repositoryLabel}</span>{' '}
              <span className="page__meta-item">
                {mission.deliveryKind === 'create-merge-request'
                  ? t('code.missions.guidance.deliveryCreated')
                  : t('code.missions.guidance.deliveryAdopted')}
              </span>
            </>
          }
          actions={
            <>
              {mission.journey === undefined &&
              canResume &&
              !terminal &&
              mission.automationMode === 'tracking-only' ? (
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={resume.isPending}
                  onClick={() => resume.mutate()}
                  data-testid="mission-resume"
                >
                  {t('code.missions.resume')}
                </button>
              ) : null}
              {mission.journey === undefined &&
              canAttach &&
              !terminal &&
              mission.automationMode === 'tracking-only' ? (
                <button
                  type="button"
                  className="btn btn--sm"
                  onClick={() => setAttachOpen(true)}
                  data-testid="mission-attach-open"
                >
                  {t('code.missions.attachMr')}
                </button>
              ) : null}
              {canHandoff && !terminal && mission.automationMode === 'active' ? (
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={handoff.isPending}
                  onClick={() => handoff.mutate()}
                  data-testid="mission-handoff"
                >
                  {t('code.missions.handoff')}
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
        <div className="employee-manual-panel">
          {mission.journey !== undefined ? (
            <JourneyNextAction
              journey={mission.journey}
              commandPending={retry.isPending || resume.isPending}
              onCommand={(command) => {
                if (command === 'retry') retry.mutate()
                if (command === 'resume') resume.mutate()
                if (command === 'attach-merge-request') setAttachOpen(true)
                if (command === 'submit-answers') {
                  document
                    .getElementById('mission-questions')
                    ?.scrollIntoView({ behavior: 'smooth' })
                }
              }}
            />
          ) : null}
          {collaboration.children.length > 0 || collaboration.approvals.length > 0 ? (
            <section className="page__section" data-testid="mission-collaboration">
              <h3>{t('code.missions.collaborationTitle')}</h3>
              <div className="mission-readiness__holds">
                {collaboration.children.map((child) => (
                  <Card
                    key={child.stepRunId}
                    title={t('code.missions.childMissionTitle')}
                    actions={
                      <StatusChip kind={child.completionSatisfied ? 'success' : 'info'} size="sm">
                        {child.status ?? t('code.missions.collaborationPending')}
                      </StatusChip>
                    }
                  >
                    {child.childMissionId === null ? (
                      <p>{t('code.missions.childMissionCreating')}</p>
                    ) : (
                      <Link
                        to="/code/missions/$missionId"
                        params={{ missionId: child.childMissionId }}
                      >
                        {t('code.missions.openChildMission')}
                      </Link>
                    )}
                    {child.deadlineAt === null ? null : (
                      <p className="form-field__hint">
                        {t('code.missions.collaborationDeadline', {
                          time: new Date(child.deadlineAt).toLocaleString(),
                        })}
                      </p>
                    )}
                  </Card>
                ))}
                {collaboration.approvals.map((approval) => (
                  <Card
                    key={approval.stepRunId}
                    title={t('code.missions.approvalTitle')}
                    actions={
                      <StatusChip
                        kind={approval.status === 'approved' ? 'success' : 'info'}
                        size="sm"
                      >
                        {approval.status}
                      </StatusChip>
                    }
                  >
                    {approval.externalRequestRef !== null &&
                    /^https?:\/\//.test(approval.externalRequestRef) ? (
                      <a href={approval.externalRequestRef} target="_blank" rel="noreferrer">
                        {t('code.missions.openApproval')}
                      </a>
                    ) : (
                      <p>{t('code.missions.approvalWaiting')}</p>
                    )}
                    <p className="form-field__hint">
                      {t('code.missions.collaborationDeadline', {
                        time: new Date(approval.deadlineAt).toLocaleString(),
                      })}
                    </p>
                  </Card>
                ))}
              </div>
            </section>
          ) : null}
          {attachOpen ? (
            <AttachMrDialog
              missionId={mission.id}
              onClose={() => setAttachOpen(false)}
              onAttached={() => {
                setAttachOpen(false)
                invalidate()
              }}
            />
          ) : null}
          {cancel.isError ? <ErrorBanner error={cancel.error} /> : null}
          {retry.isError ? <ErrorBanner error={retry.error} /> : null}
          {handoff.isError ? <ErrorBanner error={handoff.error} /> : null}
          {resume.isError ? <ErrorBanner error={resume.error} /> : null}

          <NoticeBanner
            tone={guidance.tone}
            title={t(`code.missions.guidance.${guidance.title}`)}
            testid="mission-guidance"
          >
            {t(`code.missions.guidance.${guidance.body}`)}
          </NoticeBanner>

          {policyIdentity.data !== undefined &&
          policyIdentity.data.publishedRevision !== null &&
          mission.policyRevision !== null &&
          policyIdentity.data.publishedRevision > mission.policyRevision ? (
            <section className="page__section" data-testid="mission-config-upgrade">
              <StatusChip kind="warn" size="sm">
                {t('code.missions.configOutdated', {
                  pinned: mission.policyRevision,
                  published: policyIdentity.data.publishedRevision,
                })}
              </StatusChip>{' '}
              <span>{t('code.missions.configUpgradeHint')}</span>
            </section>
          ) : null}

          {mission.blockCode !== null ? (
            <NoticeBanner tone="error" title={t('code.missions.blockTitle')} testid="mission-block">
              <code>{mission.blockCode}</code>
              {mission.blockDetail !== null ? ` — ${mission.blockDetail}` : null}
            </NoticeBanner>
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
            <h3>{t('code.missions.evidenceTitle')}</h3>
            {mission.pipeline === undefined || mission.pipeline === null ? (
              <p data-testid="evidence-not-collected">{t('code.missions.evidenceNone')}</p>
            ) : (
              <EvidenceBrowser missionId={mission.id} pipeline={mission.pipeline} />
            )}
          </section>

          <section className="page__section">
            <h3>{t('code.missions.timelineTitle')}</h3>
            <MissionTimeline
              decisions={trace.data?.items ?? []}
              effects={mission.effects as TimelineEffect[]}
            />
          </section>

          <section className="page__section">
            <h3>{t('code.missions.readinessTitle')}</h3>
            {readiness === null ? (
              <p>{t('code.missions.noReadiness')}</p>
            ) : (
              <div data-testid="mission-readiness">
                <div className="mission-readiness__summary">
                  <Card title={t('code.missions.readiness.automation')}>
                    <StatusChip kind={readiness.automationReady ? 'success' : 'warn'}>
                      {readiness.automationReady
                        ? t('code.missions.readiness.ready')
                        : t('code.missions.readiness.inProgress')}
                    </StatusChip>
                  </Card>
                  <Card title={t('code.missions.readiness.hostMergeable')}>
                    <StatusChip
                      kind={
                        readiness.hostMergeable === 'yes'
                          ? 'success'
                          : readiness.hostMergeable === 'no'
                            ? 'danger'
                            : 'warn'
                      }
                    >
                      {t(`code.missions.readiness.mergeable.${readiness.hostMergeable}`)}
                    </StatusChip>
                  </Card>
                  <Card title={t('code.missions.readiness.head')}>
                    {readiness.evaluatedForHead === null ? (
                      '—'
                    ) : (
                      <code>{readiness.evaluatedForHead.slice(0, 12)}</code>
                    )}
                  </Card>
                </div>
                <div className="mission-readiness__holds">
                  <Card title={t('code.missions.readiness.machineHolds')}>
                    {readiness.machineHolds.length === 0 ? (
                      <p>{t('code.missions.readiness.none')}</p>
                    ) : (
                      <ul>
                        {readiness.machineHolds.map((hold, index) => (
                          <li key={`${hold.kind}-${index}`}>
                            {t(`code.missions.readiness.hold.${hold.kind}`)} — {hold.detail}
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                  <Card title={t('code.missions.readiness.humanHolds')}>
                    {readiness.humanHolds.length === 0 ? (
                      <p>{t('code.missions.readiness.none')}</p>
                    ) : (
                      <ul>
                        {readiness.humanHolds.map((hold, index) => (
                          <li key={`${hold.kind}-${index}`}>
                            {t(`code.missions.readiness.hold.${hold.kind}`)} — {hold.detail}
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                </div>
                <FormSection
                  title={t('code.missions.readiness.advanced')}
                  collapsible
                  data-testid="mission-readiness-advanced"
                >
                  <pre className="mission-readiness">{JSON.stringify(readiness, null, 2)}</pre>
                </FormSection>
              </div>
            )}
          </section>
        </div>
      </div>
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
    <section id="mission-questions" className="page__section" data-testid="mission-questions">
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

function AttachMrDialog(props: {
  missionId: string
  onClose: () => void
  onAttached: () => void
}): ReactElement {
  const { t } = useTranslation()
  const [mrIid, setMrIid] = useState('')
  const [endpoint, setEndpoint] = useState<'auto' | 'gitlab' | 'github'>('auto')
  const [project, setProject] = useState('')
  const attach = useMutation({
    mutationFn: () =>
      api.post(`/api/code/missions/${encodeURIComponent(props.missionId)}/attach-mr`, {
        mrIid: mrIid.trim(),
        ...(endpoint === 'auto' ? {} : { codeHostEndpointRef: endpoint }),
        ...(project.trim() === '' ? {} : { stableProjectRef: project.trim() }),
      }),
    onSuccess: props.onAttached,
  })
  return (
    <Dialog
      open
      title={t('code.missions.attachTitle')}
      onClose={props.onClose}
      footer={
        <>
          <button type="button" className="btn btn--sm" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={mrIid.trim() === '' || attach.isPending}
            onClick={() => attach.mutate()}
            data-testid="mission-attach-submit"
          >
            {t('code.missions.attachSubmit')}
          </button>
        </>
      }
    >
      {attach.isError ? <ErrorBanner error={attach.error} /> : null}
      <p>{t('code.missions.attachHint')}</p>
      <Field label={t('code.missions.attachMrIid')} required>
        <TextInput value={mrIid} onChange={setMrIid} data-testid="mission-attach-iid" />
      </Field>
      <Field label={t('code.missions.attachEndpoint')}>
        <Select<'auto' | 'gitlab' | 'github'>
          value={endpoint}
          onChange={setEndpoint}
          options={[
            { value: 'auto', label: t('code.missions.attachEndpointAuto') },
            { value: 'gitlab', label: 'GitLab' },
            { value: 'github', label: 'GitHub' },
          ]}
        />
      </Field>
      <Field label={t('code.missions.attachProject')} hint={t('code.missions.attachProjectHint')}>
        <TextInput value={project} onChange={setProject} data-testid="mission-attach-project" />
      </Field>
    </Dialog>
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
