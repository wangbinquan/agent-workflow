// RFC-310 guided digital employee mission launch.
//
// The wizard deliberately separates business choices from the platform's
// immutable execution contract, then runs the same server-side employee /
// policy / requirement-source selectors as launch. Uploaded files are staged
// only for that preflight and are discarded on edits or abandonment.

import { useMutation, useQuery } from '@tanstack/react-query'
import { createRoute, Link } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { Card } from '@/components/Card'
import { ChoiceCards } from '@/components/ChoiceCards'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FilesDropzone, formatShortBytes } from '@/components/FileDropzone'
import { Field, Switch, TextArea, TextInput } from '@/components/Form'
import { FormSection } from '@/components/FormSection'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { Select } from '@/components/Select'
import { StatusChip } from '@/components/StatusChip'
import { Stepper } from '@/components/Stepper'
import { TableViewport } from '@/components/TableViewport'
import { Route as RootRoute } from './__root'

interface MissionLaunchSearch extends Record<string, unknown> {
  employee?: string
}

export function validateMissionLaunchSearch(search: Record<string, unknown>): MissionLaunchSearch {
  const { employee: _employee, ...adjacent } = search
  return typeof search.employee === 'string' && search.employee !== ''
    ? { ...adjacent, employee: search.employee }
    : adjacent
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/code/missions/new',
  validateSearch: validateMissionLaunchSearch,
  component: MissionLaunchPage,
})

type SubmissionKind = 'direct' | 'external'
type DeliveryChoice = 'create' | 'adopt'
type EmployeeChoice = 'assignment' | 'explicit'
type CollisionMode = 'create-only' | 'replace-existing'
type ContentPolicy = 'preserve-upload' | 'agent-editable'
type FileMode = 'regular' | 'executable'

interface VersionedRef {
  id: string
  revision: number
}

interface UploadDraft {
  file: File
  /** Stable across preflight retries; prevents an ambiguous upload response from creating twins. */
  idempotencyKey: string
  targetPath: string
  collisionMode: CollisionMode
  contentPolicy: ContentPolicy
  fileMode: FileMode
}

interface UploadedDraft extends UploadDraft {
  uploadRef: string
  bytes: number
  sha256: string
}

interface RepoSummary {
  id: string
  urlRedacted: string | null
}

interface ConfigSummary {
  id: string
  name: string
  publishedRevision: number | null
}

export interface MissionAdmissionPreview {
  outcome: 'ready' | 'needs-source-selection' | 'blocked'
  employee: VersionedRef | null
  policy: VersionedRef | null
  requirementSource: { sourceKey: string; adapter: VersionedRef } | null
  sourceOptions: string[]
  block: { code: string; detail: string | null } | null
}

interface DirectInputPreview {
  employee: VersionedRef
  policy: VersionedRef
  baseline: { snapshotRef: string; sha: string }
  dispositions: Array<{
    repositoryTargetPath: string
    disposition: 'create' | 'replace' | 'already-present' | 'blocked'
    effectiveCollisionMode: CollisionMode | null
    effectiveContentPolicy: ContentPolicy | null
    blockedReason: string | null
  }>
}

interface LaunchPayloadInput {
  idempotencyKey: string
  repositoryId: string
  repositoryGroupId: string | null
  submissionKind: SubmissionKind
  title: string
  body: string
  externalId: string
  sourceKey: string
  uploads: readonly UploadedDraft[]
  deliveryChoice: DeliveryChoice
  targetRef: string
  mergeRequestRef: string
  requestedEmployee: VersionedRef | null
  requestedPolicy: VersionedRef | null
}

/** Pure payload builder shared with the rendered-journey regression. */
export function buildMissionLaunchPayload(input: LaunchPayloadInput): Record<string, unknown> {
  const submission =
    input.submissionKind === 'external'
      ? {
          kind: 'external-reference' as const,
          externalId: input.externalId.trim(),
          ...(input.sourceKey.trim() === '' ? {} : { sourceKey: input.sourceKey.trim() }),
        }
      : {
          kind: 'direct' as const,
          title: input.title.trim(),
          body: input.body.trim() === '' ? null : input.body,
          uploads: input.uploads.map((upload) => ({
            uploadRef: upload.uploadRef,
            repositoryTargetPath: upload.targetPath.trim(),
            collisionMode: upload.collisionMode,
            contentPolicy: upload.contentPolicy,
            fileMode: upload.fileMode,
          })),
        }
  const delivery =
    input.deliveryChoice === 'adopt'
      ? { kind: 'adopt-merge-request' as const, mergeRequestRef: input.mergeRequestRef.trim() }
      : {
          kind: 'create-merge-request' as const,
          ...(input.targetRef.trim() === '' ? {} : { targetRef: input.targetRef.trim() }),
        }
  return {
    idempotencyKey: input.idempotencyKey,
    repositoryId: input.repositoryId,
    repositoryGroupId: input.repositoryGroupId,
    submission,
    delivery,
    requestedEmployee: input.requestedEmployee,
    requestedPolicy: input.requestedPolicy,
    actorUserId: null,
  }
}

function MissionLaunchPage(): ReactElement {
  const { t } = useTranslation()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const [step, setStep] = useState(0)
  const [maxReachable, setMaxReachable] = useState(0)
  const [repositoryId, setRepositoryId] = useState('')
  const [deliveryChoice, setDeliveryChoice] = useState<DeliveryChoice>('create')
  const [targetRef, setTargetRef] = useState('')
  const [mergeRequestRef, setMergeRequestRef] = useState('')
  const [submissionKind, setSubmissionKind] = useState<SubmissionKind>('direct')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [externalId, setExternalId] = useState('')
  const [sourceKey, setSourceKey] = useState('')
  const [uploadDrafts, setUploadDrafts] = useState<UploadDraft[]>([])
  const [employeeChoice, setEmployeeChoice] = useState<EmployeeChoice>(
    search.employee === undefined ? 'assignment' : 'explicit',
  )
  const [employeeId, setEmployeeId] = useState(search.employee ?? '')
  const [policyId, setPolicyId] = useState('')
  const [uploaded, setUploaded] = useState<UploadedDraft[]>([])
  const [admission, setAdmission] = useState<MissionAdmissionPreview | null>(null)
  const [directPreview, setDirectPreview] = useState<DirectInputPreview | null>(null)
  const [idempotencyKey] = useState(() => `ui-${crypto.randomUUID()}`)
  const uploadedRef = useRef<UploadedDraft[]>([])
  const launchedRef = useRef(false)
  const disposedRef = useRef(false)

  const repos = useQuery<{ items: RepoSummary[] }>({
    queryKey: ['cached-repos'],
    queryFn: ({ signal }) => api.get('/api/cached-repos', undefined, signal),
  })
  const employees = useQuery<{ items: ConfigSummary[] }>({
    queryKey: ['digital-employees'],
    queryFn: ({ signal }) => api.get('/api/code/digital-employees', undefined, signal),
  })
  const policies = useQuery<{ items: ConfigSummary[] }>({
    queryKey: ['automation-policies'],
    queryFn: ({ signal }) => api.get('/api/code/automation-policies', undefined, signal),
  })
  const publishedEmployees = useMemo(
    () => (employees.data?.items ?? []).filter((row) => row.publishedRevision !== null),
    [employees.data],
  )
  const publishedPolicies = useMemo(
    () => (policies.data?.items ?? []).filter((row) => row.publishedRevision !== null),
    [policies.data],
  )
  const requestedEmployee =
    employeeChoice === 'explicit'
      ? (() => {
          const row = publishedEmployees.find((candidate) => candidate.id === employeeId)
          return row?.publishedRevision == null
            ? null
            : { id: row.id, revision: row.publishedRevision }
        })()
      : null
  const requestedPolicy = (() => {
    const row = publishedPolicies.find((candidate) => candidate.id === policyId)
    return row?.publishedRevision == null ? null : { id: row.id, revision: row.publishedRevision }
  })()

  const deleteUploads = (rows: readonly UploadedDraft[]): void => {
    for (const row of rows) {
      void api
        .delete(`/api/code/mission-input-uploads/${encodeURIComponent(row.uploadRef)}`)
        .catch(() => {})
    }
  }
  const invalidatePreflight = (): void => {
    const stale = uploadedRef.current
    uploadedRef.current = []
    setUploaded([])
    setAdmission(null)
    setDirectPreview(null)
    deleteUploads(stale)
  }

  useEffect(() => {
    uploadedRef.current = uploaded
  }, [uploaded])
  useEffect(() => {
    // 必须在挂载时重置：cleanup 把它置 true 后从不复位，于是任何一次重挂载
    // （StrictMode 的双调用、路由 search 变化导致的重建）都会让这个页面**永久**
    // 认为自己已经关闭——之后每次 preflight 都在上传完成后把文件删掉并抛
    // "mission launch page closed while uploads were staging"，而页面明明还开着。
    // RFC-310 T140 的浏览器旅程实跑抓到这条。
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      if (!launchedRef.current) deleteUploads(uploadedRef.current)
    }
  }, [])

  const ensureUploaded = async (): Promise<UploadedDraft[]> => {
    if (uploadDrafts.length === 0) return []
    if (
      uploaded.length === uploadDrafts.length &&
      uploaded.every((row, index) => row.file === uploadDrafts[index]!.file)
    ) {
      return uploaded
    }
    const settled = await Promise.allSettled(
      uploadDrafts.map(async (draft) => {
        const response = await api.postBytes<{
          uploadRef: string
          bytes: number
          sha256: string
        }>('/api/code/mission-input-uploads', await draft.file.arrayBuffer(), {
          'x-upload-name': draft.file.name,
          'x-upload-idempotency-key': draft.idempotencyKey,
        })
        return { ...draft, ...response }
      }),
    )
    const completed = settled.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    )
    const failure = settled.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') {
      deleteUploads(completed)
      throw failure.reason
    }
    if (disposedRef.current) {
      deleteUploads(completed)
      throw new Error('mission launch page closed while uploads were staging')
    }
    uploadedRef.current = completed
    setUploaded(completed)
    return completed
  }

  const preflight = useMutation({
    mutationFn: async () => {
      const admissionResult = await api.post<MissionAdmissionPreview>(
        '/api/code/missions/preview',
        {
          repositoryId,
          repositoryGroupId: null,
          submission:
            submissionKind === 'direct'
              ? { kind: 'direct' }
              : {
                  kind: 'external-reference',
                  ...(sourceKey.trim() === '' ? {} : { sourceKey: sourceKey.trim() }),
                },
          requestedEmployee,
          requestedPolicy,
          actorUserId: null,
        },
      )
      if (admissionResult.outcome !== 'ready') {
        return { admission: admissionResult, direct: null }
      }
      if (submissionKind !== 'direct' || uploadDrafts.length === 0) {
        return { admission: admissionResult, direct: null }
      }
      const rows = await ensureUploaded()
      const direct = await api.post<DirectInputPreview>('/api/code/missions/direct-input/preview', {
        repositoryId,
        repositoryGroupId: null,
        uploads: rows.map((row) => ({
          uploadRef: row.uploadRef,
          repositoryTargetPath: row.targetPath.trim(),
          collisionMode: row.collisionMode,
          contentPolicy: row.contentPolicy,
          fileMode: row.fileMode,
        })),
        requestedEmployee,
        requestedPolicy,
        actorUserId: null,
      })
      return { admission: admissionResult, direct }
    },
    onSuccess: (result) => {
      setAdmission(result.admission)
      setDirectPreview(result.direct)
    },
  })

  const launch = useMutation({
    mutationFn: () =>
      api.post<{ missionId: string; status: string; created: boolean }>(
        '/api/code/missions',
        buildMissionLaunchPayload({
          idempotencyKey,
          repositoryId,
          repositoryGroupId: null,
          submissionKind,
          title,
          body,
          externalId,
          sourceKey,
          uploads: uploaded,
          deliveryChoice,
          targetRef,
          mergeRequestRef,
          requestedEmployee,
          requestedPolicy,
        }),
      ),
    onSuccess: (result) => {
      launchedRef.current = true
      void navigate({ to: '/code/missions/$missionId', params: { missionId: result.missionId } })
    },
  })

  const stepReady = [
    repositoryId !== '' && (deliveryChoice === 'create' || mergeRequestRef.trim() !== ''),
    submissionKind === 'external'
      ? externalId.trim() !== ''
      : title.trim() !== '' &&
        (body.trim() !== '' || uploadDrafts.length > 0) &&
        uploadDrafts.every((row) => row.targetPath.trim() !== ''),
    employeeChoice === 'assignment' || requestedEmployee !== null,
    true,
  ]
  const uploadBlocked =
    directPreview?.dispositions.some((row) => row.disposition === 'blocked') ?? false
  const launchReady = admission?.outcome === 'ready' && !uploadBlocked
  const busy = preflight.isPending || launch.isPending

  const move = (next: number): void => {
    if (next > step && !stepReady[step]) return
    if (next > step) setMaxReachable((value) => Math.max(value, next))
    setStep(next)
  }
  const change = (apply: () => void): void => {
    invalidatePreflight()
    apply()
  }

  const selectedRepo = repos.data?.items.find((row) => row.id === repositoryId)
  const selectedEmployee =
    employeeChoice === 'assignment'
      ? t('code.missions.wizard.assignmentResolved')
      : (publishedEmployees.find((row) => row.id === employeeId)?.name ?? '—')
  const selectedPolicy =
    publishedPolicies.find((row) => row.id === policyId)?.name ??
    t('code.missions.wizard.employeeDefaultPolicy')
  const stepTitles = [
    t('code.missions.wizard.stepRepository'),
    t('code.missions.wizard.stepRequirement'),
    t('code.missions.wizard.stepAutomation'),
    t('code.missions.wizard.stepReview'),
  ]

  return (
    <div className="page page--operations page--mission-wizard">
      <div className="operations-surface">
        <PageHeader title={t('code.missions.wizard.title')} className="operations-surface__header">
          <p className="page__subtitle">{t('code.missions.wizard.subtitle')}</p>
        </PageHeader>

        <div className="mission-wizard-panel">
          {repos.isError ? <ErrorBanner error={repos.error} /> : null}
          {employees.isError ? <ErrorBanner error={employees.error} /> : null}
          {policies.isError ? <ErrorBanner error={policies.error} /> : null}
          {preflight.isError ? <ErrorBanner error={preflight.error} /> : null}
          {launch.isError ? <ErrorBanner error={launch.error} /> : null}

          <Stepper
            steps={[
              { key: 'repository', title: stepTitles[0]! },
              { key: 'requirement', title: stepTitles[1]! },
              { key: 'automation', title: stepTitles[2]! },
              { key: 'review', title: stepTitles[3]! },
            ]}
            current={step}
            maxReachable={Math.max(step, maxReachable)}
            onNavigate={move}
            nextEnabled={stepReady[step]}
            nextLabel={
              step + 1 < stepTitles.length
                ? t('code.missions.wizard.continueTo', { step: stepTitles[step + 1] })
                : undefined
            }
            navigationDisabled={busy}
            rootTestid="mission-launch-wizard"
            finalActions={
              <>
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => preflight.mutate()}
                  data-testid="mission-preflight"
                >
                  {preflight.isPending
                    ? t('code.missions.wizard.preflightRunning')
                    : admission === null
                      ? t('code.missions.wizard.preflight')
                      : t('code.missions.wizard.preflightAgain')}
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={!launchReady || busy}
                  onClick={() => launch.mutate()}
                  data-testid="mission-launch-submit"
                >
                  {launch.isPending
                    ? t('code.missions.launching')
                    : t('code.missions.wizard.launch')}
                </button>
              </>
            }
          >
            {step === 0 ? (
              <div className="mission-wizard__section">
                <NoticeBanner tone="info" title={t('code.missions.wizard.repositoryWhyTitle')}>
                  {t('code.missions.wizard.repositoryWhyBody')}
                </NoticeBanner>
                <Field label={t('code.missions.formRepository')} required>
                  <Select
                    value={repositoryId}
                    onChange={(value) => change(() => setRepositoryId(value))}
                    options={(repos.data?.items ?? []).map((repo) => ({
                      value: repo.id,
                      label: repo.urlRedacted ?? repo.id,
                    }))}
                    placeholder={t('code.missions.pickRepository')}
                    searchable
                    disabled={busy}
                    data-testid="mission-repo-select"
                  />
                </Field>
                <Field label={t('code.missions.wizard.deliveryLabel')} group required>
                  <ChoiceCards<DeliveryChoice>
                    value={deliveryChoice}
                    onChange={(value) => change(() => setDeliveryChoice(value))}
                    disabled={busy}
                    testidPrefix="mission-delivery"
                    options={[
                      {
                        value: 'create',
                        label: t('code.missions.wizard.deliveryCreate'),
                        description: t('code.missions.wizard.deliveryCreateHint'),
                      },
                      {
                        value: 'adopt',
                        label: t('code.missions.wizard.deliveryAdopt'),
                        description: t('code.missions.wizard.deliveryAdoptHint'),
                      },
                    ]}
                  />
                </Field>
                {deliveryChoice === 'create' ? (
                  <Field
                    label={t('code.missions.wizard.targetRef')}
                    hint={t('code.missions.wizard.targetRefHint')}
                  >
                    <TextInput
                      value={targetRef}
                      onChange={(value) => change(() => setTargetRef(value))}
                      placeholder="main"
                      disabled={busy}
                      data-testid="mission-target-ref"
                    />
                  </Field>
                ) : (
                  <Field
                    label={t('code.missions.wizard.mergeRequestRef')}
                    hint={t('code.missions.wizard.mergeRequestRefHint')}
                    required
                  >
                    <TextInput
                      value={mergeRequestRef}
                      onChange={(value) => change(() => setMergeRequestRef(value))}
                      placeholder="123"
                      disabled={busy}
                      data-testid="mission-mr-ref"
                    />
                  </Field>
                )}
              </div>
            ) : null}

            {step === 1 ? (
              <div className="mission-wizard__section">
                <Field label={t('code.missions.formKind')} group required>
                  <ChoiceCards<SubmissionKind>
                    value={submissionKind}
                    onChange={(value) => change(() => setSubmissionKind(value))}
                    disabled={busy}
                    testidPrefix="mission-source-kind"
                    options={[
                      {
                        value: 'direct',
                        label: t('code.missions.wizard.directLabel'),
                        description: t('code.missions.wizard.directHint'),
                      },
                      {
                        value: 'external',
                        label: t('code.missions.wizard.externalLabel'),
                        description: t('code.missions.wizard.externalHint'),
                      },
                    ]}
                  />
                </Field>
                {submissionKind === 'direct' ? (
                  <>
                    <Field label={t('code.missions.formTitle')} required>
                      <TextInput
                        value={title}
                        onChange={(value) => change(() => setTitle(value))}
                        disabled={busy}
                        data-testid="mission-title"
                      />
                    </Field>
                    <Field
                      label={t('code.missions.formBody')}
                      hint={t('code.missions.wizard.bodyHint')}
                    >
                      <TextArea
                        value={body}
                        onChange={(value) => change(() => setBody(value))}
                        rows={8}
                        disabled={busy}
                        data-testid="mission-body"
                      />
                    </Field>
                    <Field
                      label={t('code.missions.formUploads')}
                      hint={t('code.missions.wizard.filesHint')}
                      group
                    >
                      <FilesDropzone
                        files={uploadDrafts.map((row) => row.file)}
                        onFilesChange={(files) =>
                          change(() => {
                            const previous = new Map(uploadDrafts.map((row) => [row.file, row]))
                            setUploadDrafts(
                              files.map(
                                (file) =>
                                  previous.get(file) ?? {
                                    file,
                                    idempotencyKey: `ui-file-${crypto.randomUUID()}`,
                                    targetPath: file.name,
                                    collisionMode: 'create-only',
                                    contentPolicy: 'preserve-upload',
                                    fileMode: 'regular',
                                  },
                              ),
                            )
                          })
                        }
                        disabled={busy}
                        title={t('code.missions.wizard.filesDropTitle')}
                        description={t('code.missions.wizard.filesDropBody')}
                        chooseLabel={t('code.missions.wizard.filesChoose')}
                        removeLabel={t('common.remove')}
                        maxCount={100}
                        data-testid="mission-upload-files"
                      />
                    </Field>
                    {uploadDrafts.map((draft, index) => (
                      <Card
                        key={draft.idempotencyKey}
                        title={draft.file.name}
                        className="mission-upload-card"
                        actions={<span className="muted">{formatShortBytes(draft.file.size)}</span>}
                      >
                        <div className="mission-upload-card__fields">
                          <Field label={t('code.missions.wizard.fileTarget')} required>
                            <TextInput
                              value={draft.targetPath}
                              onChange={(value) =>
                                change(() =>
                                  setUploadDrafts((rows) =>
                                    rows.map((row, rowIndex) =>
                                      rowIndex === index ? { ...row, targetPath: value } : row,
                                    ),
                                  ),
                                )
                              }
                              disabled={busy}
                              data-testid={`mission-upload-target-${index}`}
                            />
                          </Field>
                          <Field label={t('code.missions.wizard.collisionMode')}>
                            <Select<CollisionMode>
                              value={draft.collisionMode}
                              onChange={(value) =>
                                change(() =>
                                  setUploadDrafts((rows) =>
                                    rows.map((row, rowIndex) =>
                                      rowIndex === index ? { ...row, collisionMode: value } : row,
                                    ),
                                  ),
                                )
                              }
                              disabled={busy}
                              options={[
                                {
                                  value: 'create-only',
                                  label: t('code.missions.wizard.collisionCreate'),
                                },
                                {
                                  value: 'replace-existing',
                                  label: t('code.missions.wizard.collisionReplace'),
                                },
                              ]}
                              data-testid={`mission-upload-collision-${index}`}
                            />
                          </Field>
                          <Field label={t('code.missions.wizard.contentPolicy')}>
                            <Select<ContentPolicy>
                              value={draft.contentPolicy}
                              onChange={(value) =>
                                change(() =>
                                  setUploadDrafts((rows) =>
                                    rows.map((row, rowIndex) =>
                                      rowIndex === index ? { ...row, contentPolicy: value } : row,
                                    ),
                                  ),
                                )
                              }
                              disabled={busy}
                              options={[
                                {
                                  value: 'preserve-upload',
                                  label: t('code.missions.wizard.contentPreserve'),
                                  description: t('code.missions.wizard.contentPreserveHint'),
                                },
                                {
                                  value: 'agent-editable',
                                  label: t('code.missions.wizard.contentEditable'),
                                  description: t('code.missions.wizard.contentEditableHint'),
                                },
                              ]}
                              data-testid={`mission-upload-content-${index}`}
                            />
                          </Field>
                          <Switch
                            checked={draft.fileMode === 'executable'}
                            onChange={(checked) =>
                              change(() =>
                                setUploadDrafts((rows) =>
                                  rows.map((row, rowIndex) =>
                                    rowIndex === index
                                      ? { ...row, fileMode: checked ? 'executable' : 'regular' }
                                      : row,
                                  ),
                                ),
                              )
                            }
                            disabled={busy}
                            label={t('code.missions.wizard.executable')}
                            hint={t('code.missions.wizard.executableHint')}
                            data-testid={`mission-upload-executable-${index}`}
                          />
                        </div>
                      </Card>
                    ))}
                  </>
                ) : (
                  <>
                    <NoticeBanner tone="info" title={t('code.missions.wizard.externalInfoTitle')}>
                      {t('code.missions.wizard.externalInfoBody')}
                    </NoticeBanner>
                    <Field label={t('code.missions.formExternalId')} required>
                      <TextInput
                        value={externalId}
                        onChange={(value) => change(() => setExternalId(value))}
                        disabled={busy}
                        data-testid="mission-external"
                      />
                    </Field>
                    <Field
                      label={t('code.missions.formSourceKey')}
                      hint={t('code.missions.sourceKeyHint')}
                    >
                      <TextInput
                        value={sourceKey}
                        onChange={(value) => change(() => setSourceKey(value))}
                        disabled={busy}
                        data-testid="mission-source-key"
                      />
                    </Field>
                  </>
                )}
              </div>
            ) : null}

            {step === 2 ? (
              <div className="mission-wizard__section">
                <NoticeBanner tone="info" title={t('code.missions.wizard.rulesTitle')}>
                  {t('code.missions.wizard.rulesBody')}
                </NoticeBanner>
                <Field label={t('code.missions.formEmployee')} group required>
                  <ChoiceCards<EmployeeChoice>
                    value={employeeChoice}
                    onChange={(value) => change(() => setEmployeeChoice(value))}
                    disabled={busy}
                    testidPrefix="mission-employee-choice"
                    options={[
                      {
                        value: 'assignment',
                        label: t('code.missions.wizard.employeeAuto'),
                        description: t('code.missions.wizard.employeeAutoHint'),
                      },
                      {
                        value: 'explicit',
                        label: t('code.missions.wizard.employeeExplicit'),
                        description: t('code.missions.wizard.employeeExplicitHint'),
                      },
                    ]}
                  />
                </Field>
                {employeeChoice === 'explicit' ? (
                  <Field label={t('code.missions.wizard.employeePublished')} required>
                    <Select
                      value={employeeId}
                      onChange={(value) => change(() => setEmployeeId(value))}
                      options={publishedEmployees.map((employee) => ({
                        value: employee.id,
                        label: employee.name,
                        badge: `v${employee.publishedRevision}`,
                      }))}
                      placeholder={t('code.missions.pickEmployee')}
                      searchable
                      disabled={busy}
                      data-testid="mission-employee-select"
                    />
                  </Field>
                ) : (
                  <NoticeBanner
                    tone="info"
                    size="compact"
                    action={
                      <Link to="/code/assignments">
                        {t('code.missions.wizard.openAssignments')}
                      </Link>
                    }
                  >
                    {t('code.missions.wizard.assignmentHint')}
                  </NoticeBanner>
                )}
                <Field
                  label={t('code.missions.wizard.policyOverride')}
                  hint={t('code.missions.wizard.policyOverrideHint')}
                >
                  <Select
                    value={policyId}
                    onChange={(value) => change(() => setPolicyId(value))}
                    options={publishedPolicies.map((policy) => ({
                      value: policy.id,
                      label: policy.name,
                      badge: `v${policy.publishedRevision}`,
                    }))}
                    placeholder={t('code.missions.wizard.employeeDefaultPolicy')}
                    searchable
                    disabled={busy}
                    data-testid="mission-policy-select"
                  />
                </Field>
                <div className="mission-wizard__resource-links">
                  <Link to="/code/config/$kind" params={{ kind: 'employees' }}>
                    {t('code.missions.wizard.manageEmployees')}
                  </Link>
                  <Link to="/code/policies">{t('code.missions.wizard.managePolicies')}</Link>
                </div>
              </div>
            ) : null}

            {step === 3 ? (
              <div className="mission-wizard__section" data-testid="mission-review-step">
                <div className="mission-wizard__review-grid">
                  <Card title={t('code.missions.wizard.reviewRepository')}>
                    <dl className="mission-kv">
                      <dt>{t('code.missions.formRepository')}</dt>
                      <dd>{selectedRepo?.urlRedacted ?? repositoryId}</dd>
                      <dt>{t('code.missions.wizard.deliveryLabel')}</dt>
                      <dd>
                        {deliveryChoice === 'create'
                          ? t('code.missions.wizard.deliveryCreate')
                          : t('code.missions.wizard.deliveryAdopt')}
                      </dd>
                    </dl>
                  </Card>
                  <Card title={t('code.missions.wizard.reviewRequirement')}>
                    <dl className="mission-kv">
                      <dt>{t('code.missions.formKind')}</dt>
                      <dd>
                        {submissionKind === 'direct'
                          ? t('code.missions.wizard.directLabel')
                          : t('code.missions.wizard.externalLabel')}
                      </dd>
                      <dt>{t('code.missions.formTitle')}</dt>
                      <dd>{submissionKind === 'direct' ? title : externalId}</dd>
                      <dt>{t('code.missions.formUploads')}</dt>
                      <dd>{submissionKind === 'direct' ? uploadDrafts.length : 0}</dd>
                    </dl>
                  </Card>
                  <Card title={t('code.missions.wizard.reviewAutomation')}>
                    <dl className="mission-kv">
                      <dt>{t('code.missions.formEmployee')}</dt>
                      <dd>{selectedEmployee}</dd>
                      <dt>{t('code.missions.wizard.policyOverride')}</dt>
                      <dd>{selectedPolicy}</dd>
                    </dl>
                  </Card>
                </div>

                {admission === null && !preflight.isPending ? (
                  <NoticeBanner
                    tone="info"
                    title={t('code.missions.wizard.preflightRequiredTitle')}
                  >
                    {t('code.missions.wizard.preflightRequiredBody')}
                  </NoticeBanner>
                ) : null}
                {admission?.outcome === 'blocked' ? (
                  <NoticeBanner
                    tone="error"
                    title={t('code.missions.wizard.preflightBlocked')}
                    testid="mission-preflight-blocked"
                  >
                    <code>{admission.block?.code}</code>
                    {admission.block?.detail == null ? null : ` — ${admission.block.detail}`}
                  </NoticeBanner>
                ) : null}
                {admission?.outcome === 'needs-source-selection' ? (
                  <NoticeBanner
                    tone="warning"
                    title={t('code.missions.wizard.sourceSelectionTitle')}
                    testid="mission-source-selection"
                  >
                    <Field label={t('code.missions.formSourceKey')} required>
                      <Select
                        value={sourceKey}
                        onChange={(value) => change(() => setSourceKey(value))}
                        options={admission.sourceOptions.map((value) => ({ value, label: value }))}
                        placeholder={t('code.missions.wizard.sourceSelectionPlaceholder')}
                        data-testid="mission-source-option-select"
                      />
                    </Field>
                  </NoticeBanner>
                ) : null}
                {admission?.outcome === 'ready' ? (
                  <NoticeBanner
                    tone={uploadBlocked ? 'error' : 'success'}
                    title={
                      uploadBlocked
                        ? t('code.missions.wizard.uploadBlockedTitle')
                        : t('code.missions.wizard.preflightReady')
                    }
                    testid="mission-preflight-ready"
                  >
                    {uploadBlocked
                      ? t('code.missions.wizard.uploadBlockedBody')
                      : t('code.missions.wizard.preflightReadyBody', {
                          employee: admission.employee?.id ?? '—',
                          policy: admission.policy?.id ?? '—',
                        })}
                  </NoticeBanner>
                ) : null}

                {directPreview !== null ? (
                  <FormSection title={t('code.missions.wizard.uploadPlanTitle')}>
                    <p className="page__subtitle">
                      {t('code.missions.wizard.baselineSha', {
                        sha: directPreview.baseline.sha.slice(0, 12),
                      })}
                    </p>
                    <TableViewport label={t('code.missions.wizard.uploadPlanTitle')}>
                      <table data-testid="mission-upload-preview">
                        <thead>
                          <tr>
                            <th>{t('code.missions.wizard.fileTarget')}</th>
                            <th>{t('code.missions.wizard.disposition')}</th>
                            <th>{t('code.missions.wizard.contentPolicy')}</th>
                            <th>{t('code.missions.colBlock')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {directPreview.dispositions.map((row) => (
                            <tr key={row.repositoryTargetPath}>
                              <td>
                                <code>{row.repositoryTargetPath}</code>
                              </td>
                              <td>
                                <StatusChip
                                  kind={row.disposition === 'blocked' ? 'danger' : 'success'}
                                  size="sm"
                                >
                                  {t(`code.missions.wizard.dispositionValue.${row.disposition}`)}
                                </StatusChip>
                              </td>
                              <td>{row.effectiveContentPolicy ?? '—'}</td>
                              <td>{row.blockedReason ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableViewport>
                  </FormSection>
                ) : null}
              </div>
            ) : null}
          </Stepper>
        </div>
      </div>
    </div>
  )
}
