import type { CachedRepo, RepoGroupLayoutResponse } from '@agent-workflow/shared'
import { useMutation, useQueries, useQuery } from '@tanstack/react-query'
import { createRoute, Link } from '@tanstack/react-router'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { Card } from '@/components/Card'
import type {
  DigitalEmployeeDefinition,
  EmployeeTypePackage,
  ToolRegistration,
} from '@/components/digital-employees/types'
import { localized, typeRefKey } from '@/components/digital-employees/types'
import { ErrorBanner } from '@/components/ErrorBanner'
import { FilesDropzone, formatShortBytes } from '@/components/FileDropzone'
import { Field, TextArea, TextInput } from '@/components/Form'
import { FormSection } from '@/components/FormSection'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { Stepper } from '@/components/Stepper'
import { Route as RootRoute } from './__root'

type IntakeKind = 'body' | 'files' | 'body-and-files' | 'external-id'

interface UploadDraft {
  file: File
  placement: 'repository' | 'temporary'
  targetPath: string
  key: string
}

interface LaunchProjection {
  case: { id: string }
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/tasks/employee-cases/new',
  component: NewEmployeeCasePage,
})

function NewEmployeeCasePage(): ReactElement {
  const { t, i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language
  const zh = language.startsWith('zh')
  const navigate = Route.useNavigate()
  const [step, setStep] = useState(0)
  const [maxVisited, setMaxVisited] = useState(0)
  const [employeeId, setEmployeeId] = useState('')
  const [kind, setKind] = useState<IntakeKind>('body')
  const [target, setTarget] = useState<Record<string, string>>({})
  const [body, setBody] = useState('')
  const [externalId, setExternalId] = useState('')
  const [files, setFiles] = useState<UploadDraft[]>([])
  const [executionOptions, setExecutionOptions] = useState<Record<string, boolean>>({})

  const employees = useQuery<{ items: DigitalEmployeeDefinition[] }>({
    queryKey: ['digital-employees', 'launch'],
    queryFn: ({ signal }) => api.get('/api/digital-employees', undefined, signal),
  })
  const availableEmployees = useMemo(
    () =>
      (employees.data?.items ?? []).filter(
        (employee) => employee.publishedRevision !== null && employee.published?.enabled === true,
      ),
    [employees.data],
  )
  useEffect(() => {
    if (employeeId === '' && availableEmployees[0] !== undefined) {
      setEmployeeId(availableEmployees[0].id)
    }
  }, [availableEmployees, employeeId])
  const employee = availableEmployees.find((candidate) => candidate.id === employeeId) ?? null
  const typeRef = employee === null ? null : typeRefKey(employee.typeRef)
  const typeQuery = useQuery<EmployeeTypePackage>({
    queryKey: ['digital-employee-type', typeRef, 'launch'],
    enabled: typeRef !== null,
    queryFn: ({ signal }) =>
      api.get(
        `/api/digital-employee-types/${encodeURIComponent(typeRef ?? '')}`,
        undefined,
        signal,
      ),
  })
  const descriptor = typeQuery.data
  const employeeScope =
    employee?.publishedWorkScope !== null && typeof employee?.publishedWorkScope === 'object'
      ? (employee.publishedWorkScope as Record<string, unknown>)
      : {}
  const fixedRepositoryId =
    employeeScope.kind === 'repository' && typeof employeeScope.repositoryId === 'string'
      ? employeeScope.repositoryId
      : null
  const scopedRepositoryGroupId =
    employeeScope.kind === 'repository-group' && typeof employeeScope.repositoryGroupId === 'string'
      ? employeeScope.repositoryGroupId
      : null

  const requirementWorkItems = useMemo(
    () =>
      descriptor === undefined
        ? []
        : [
            ...new Set(
              [
                ...descriptor.workIntakeAuthoring.kindRequirements.map(
                  (requirement) => requirement.workItemRef,
                ),
                ...descriptor.workIntakeAuthoring.executionOptions.flatMap((option) =>
                  option.requiredWorkItemRef === null ? [] : [option.requiredWorkItemRef],
                ),
              ].filter((value): value is string => value !== null),
            ),
          ],
    [descriptor],
  )
  const requirementToolQueries = useQueries({
    queries: requirementWorkItems.map((workItemRef) => ({
      queryKey: ['digital-employee-tools', typeRef, workItemRef, 'launch-admission'],
      enabled: typeRef !== null,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get<{ items: ToolRegistration[] }>(
          `/api/digital-employee-types/${encodeURIComponent(typeRef ?? '')}/work-items/${encodeURIComponent(workItemRef)}/tools`,
          undefined,
          signal,
        ),
      staleTime: 10_000,
    })),
  })
  const toolsForWorkItem = (workItemRef: string): ToolRegistration[] => {
    const index = requirementWorkItems.indexOf(workItemRef)
    return index < 0 ? [] : (requirementToolQueries[index]?.data?.items ?? [])
  }
  const exactBinding = (workItemRef: string, slotRef: string) =>
    employee?.published?.exactToolBindings.find(
      (binding) => binding.workItemRef === workItemRef && binding.slotRef === slotRef,
    )
  const requirementAvailable = (
    workItemRef: string,
    slotRef: string,
    executorKind: 'agent' | 'workflow' | 'program' | null = null,
  ): boolean => {
    const binding = exactBinding(workItemRef, slotRef)
    if (binding === undefined) return false
    if (executorKind === null) return true
    const tool = toolsForWorkItem(workItemRef).find(
      (candidate) =>
        candidate.id === binding.registrationRef.id &&
        candidate.publishedRevision === binding.registrationRef.revision,
    )
    return tool?.state === 'published' && tool.content.implementation.kind === executorKind
  }
  const acceptedKinds = useMemo(
    () =>
      descriptor?.workIntakeAuthoring.acceptedKinds.filter((candidateKind) => {
        const requirement = descriptor.workIntakeAuthoring.kindRequirements.find(
          (candidate) => candidate.kind === candidateKind,
        )
        return (
          requirement === undefined ||
          employee?.published?.exactToolBindings.some(
            (binding) =>
              binding.workItemRef === requirement.workItemRef &&
              binding.slotRef === requirement.slotRef,
          ) === true
        )
      }) ?? [],
    [descriptor, employee?.published?.exactToolBindings],
  )
  const optionAvailabilityKey =
    descriptor?.workIntakeAuthoring.executionOptions
      .map((option) =>
        option.requiredWorkItemRef === null
          ? `${option.optionRef}:1`
          : `${option.optionRef}:${Number(
              requirementAvailable(
                option.requiredWorkItemRef,
                option.requiredSlotRef ?? '',
                option.requiredExecutorKind,
              ),
            )}`,
      )
      .join('|') ?? ''

  useEffect(() => {
    if (descriptor === undefined) return
    if (!acceptedKinds.includes(kind)) setKind(acceptedKinds[0] ?? 'body')
    setTarget((current) =>
      Object.fromEntries(
        descriptor.workIntakeAuthoring.targetFields.map((field) => [
          field.fieldRef,
          field.fieldRef === 'repositoryId' && fixedRepositoryId !== null
            ? fixedRepositoryId
            : (current[field.fieldRef] ?? ''),
        ]),
      ),
    )
  }, [acceptedKinds, descriptor, fixedRepositoryId, kind])

  useEffect(() => {
    if (descriptor === undefined) return
    const availableOptionRefs = new Set(
      optionAvailabilityKey
        .split('|')
        .filter((entry) => entry.endsWith(':1'))
        .map((entry) => entry.slice(0, -2)),
    )
    setExecutionOptions((current) =>
      Object.fromEntries(
        descriptor.workIntakeAuthoring.executionOptions.map((option) => {
          const available =
            option.requiredWorkItemRef === null || availableOptionRefs.has(option.optionRef)
          return [option.optionRef, available && (current[option.optionRef] ?? option.defaultValue)]
        }),
      ),
    )
  }, [descriptor, optionAvailabilityKey])

  const needsRepositories =
    descriptor?.workIntakeAuthoring.targetFields.some(
      (field) => field.inputKind === 'repository-picker',
    ) === true
  const needsGroups =
    descriptor?.workIntakeAuthoring.targetFields.some(
      (field) => field.inputKind === 'repository-group-picker',
    ) === true
  const repositories = useQuery<{ items: CachedRepo[] }>({
    queryKey: ['cached-repos', 'employee-case-launch'],
    enabled: needsRepositories,
    queryFn: ({ signal }) => api.get('/api/cached-repos', undefined, signal),
  })
  const groupLayout = useQuery<RepoGroupLayoutResponse>({
    queryKey: ['repo-group-layout', scopedRepositoryGroupId, 'employee-case-launch'],
    enabled: needsRepositories && scopedRepositoryGroupId !== null,
    queryFn: ({ signal }) =>
      api.get(
        `/api/repo-groups/${encodeURIComponent(scopedRepositoryGroupId ?? '')}/layout`,
        undefined,
        signal,
      ),
  })
  const groups = useQuery<{ items: Array<{ id: string; name: string }> }>({
    queryKey: ['repo-groups', 'employee-case-launch'],
    enabled: needsGroups,
    queryFn: ({ signal }) => api.get('/api/repo-groups', undefined, signal),
  })

  const needsBody = kind === 'body' || kind === 'body-and-files'
  const needsFiles = kind === 'files' || kind === 'body-and-files'
  const effectiveTarget =
    fixedRepositoryId === null ? target : { ...target, repositoryId: fixedRepositoryId }
  const repositoryOptions =
    scopedRepositoryGroupId === null
      ? (repositories.data?.items ?? []).map((repository) => ({
          value: repository.id,
          label: repository.urlRedacted,
        }))
      : (groupLayout.data?.repos ?? []).map((repository) => ({
          value: repository.cachedRepoId,
          label: repository.repoUrlRedacted,
          description: repository.mountPath,
        }))
  const fixedRepositoryLabel =
    fixedRepositoryId === null
      ? null
      : (repositoryOptions.find((repository) => repository.value === fixedRepositoryId)?.label ??
        fixedRepositoryId)
  const targetComplete =
    descriptor?.workIntakeAuthoring.targetFields.every(
      (field) => !field.required || (effectiveTarget[field.fieldRef] ?? '').trim() !== '',
    ) === true
  const filesValid =
    !needsFiles ||
    (files.length > 0 &&
      files.every(
        (draft) =>
          (draft.placement === 'temporary' || draft.targetPath.trim() !== '') &&
          draft.file.size <= (descriptor?.workIntakeAuthoring.files.maxFileBytes ?? 0),
      ) &&
      (() => {
        const repositoryPaths = files
          .filter((draft) => draft.placement === 'repository')
          .map((draft) => draft.targetPath.trim())
        return new Set(repositoryPaths).size === repositoryPaths.length
      })())
  const contentComplete =
    acceptedKinds.includes(kind) &&
    (!needsBody || body.trim() !== '') &&
    (!needsFiles || filesValid) &&
    (kind !== 'external-id' || externalId.trim() !== '')
  const ready = employee !== null && descriptor !== undefined && targetComplete && contentComplete

  const launch = useMutation({
    mutationFn: async () => {
      if (employee === null) throw new Error('digital employee is required')
      const completed: Array<{
        uploadRef: string
        placement: 'repository' | 'temporary'
        targetPath: string | null
      }> = []
      try {
        for (const draft of needsFiles ? files : []) {
          const uploaded = await api.postBytes<{ uploadRef: string }>(
            '/api/digital-employee-input-uploads',
            await draft.file.arrayBuffer(),
            {
              'x-upload-name': draft.file.name,
              'x-upload-idempotency-key': `${draft.key}-${crypto.randomUUID()}`,
            },
          )
          completed.push({
            uploadRef: uploaded.uploadRef,
            placement: draft.placement,
            targetPath: draft.placement === 'repository' ? draft.targetPath.trim() : null,
          })
        }
        return await api.post<LaunchProjection>(
          `/api/digital-employees/${encodeURIComponent(employee.id)}/cases`,
          {
            kind,
            target: Object.fromEntries(
              Object.entries(effectiveTarget).map(([key, value]) => [key, value.trim()]),
            ),
            body: needsBody ? body : null,
            externalId: kind === 'external-id' ? externalId.trim() : null,
            uploads: completed,
            executionOptions,
            idempotencyKey: `ui-case-${crypto.randomUUID()}`,
          },
        )
      } catch (error) {
        await Promise.allSettled(
          completed.map((upload) =>
            api.delete(
              `/api/digital-employee-input-uploads/${encodeURIComponent(upload.uploadRef)}`,
            ),
          ),
        )
        throw error
      }
    },
    onSuccess: (projection) => {
      void navigate({
        to: '/tasks/employee-cases/$caseId',
        params: { caseId: projection.case.id },
      })
    },
  })

  if (employees.isPending) return <LoadingState />
  if (employees.isError) return <ErrorBanner error={employees.error} />

  const unavailableKinds =
    descriptor?.workIntakeAuthoring.acceptedKinds.filter(
      (candidate) => !acceptedKinds.includes(candidate),
    ) ?? []
  const kindLabel = (value: IntakeKind): string => {
    if (zh) {
      return value === 'body'
        ? '写正文'
        : value === 'files'
          ? '传文件'
          : value === 'body-and-files'
            ? '正文和文件'
            : '输入需求 / 问题 ID'
    }
    return value === 'body'
      ? 'Write request'
      : value === 'files'
        ? 'Upload files'
        : value === 'body-and-files'
          ? 'Request and files'
          : 'Requirement / issue ID'
  }

  const steps = [
    { key: 'mode', title: t('taskWizard.stepMode') },
    { key: 'space', title: t('taskWizard.stepSpace') },
    { key: 'content', title: t('taskWizard.stepContent') },
    { key: 'confirm', title: t('taskWizard.stepConfirm') },
  ]
  const employeeReady = employee !== null && descriptor !== undefined
  const stepReady =
    step === 0
      ? employeeReady
      : step === 1
        ? employeeReady && targetComplete
        : step === 2
          ? employeeReady && targetComplete && contentComplete
          : ready
  const onNavigate = (next: number) => {
    if (next < 0 || next >= steps.length || launch.isPending) return
    if (next > step && !stepReady) return
    setStep(next)
    setMaxVisited((current) => Math.max(current, next))
  }
  const summaryEdit = (targetStep: number) => (
    <button
      type="button"
      className="btn btn--xs"
      onClick={() => onNavigate(targetStep)}
      data-testid={`employee-wizard-summary-edit-${targetStep}`}
    >
      {t('taskWizard.edit')}
    </button>
  )
  const bodySummary = body.trim().length > 240 ? `${body.trim().slice(0, 237)}…` : body.trim()
  const enabledExecutionOptions =
    descriptor?.workIntakeAuthoring.executionOptions.filter(
      (option) => executionOptions[option.optionRef] === true,
    ) ?? []

  return (
    <div
      className="page task-wizard employee-case-create-page"
      data-testid="employee-case-task-wizard"
    >
      <div>
        <PageHeader title={t('taskWizard.title')}>
          <p className="muted">
            {zh
              ? '从统一任务入口选择数字员工，并按相同的四步确认执行者、空间、内容和提交信息。'
              : 'Use the same four steps to confirm the employee, workspace, content, and submission.'}
          </p>
        </PageHeader>

        <div className="digital-employee-surface__body">
          {launch.isError ? <ErrorBanner error={launch.error} /> : null}
          <fieldset
            className="task-wizard__material"
            disabled={launch.isPending}
            aria-busy={launch.isPending || undefined}
          >
            <Stepper
              steps={steps}
              current={step}
              maxReachable={maxVisited}
              onNavigate={onNavigate}
              nextEnabled={stepReady}
              navigationDisabled={launch.isPending}
              rootTestid="employee-case-task-wizard-stepper"
              finalActions={
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={!ready || launch.isPending}
                  onClick={() => launch.mutate()}
                  data-testid="employee-case-launch"
                >
                  {launch.isPending
                    ? zh
                      ? '正在交给数字员工…'
                      : 'Assigning…'
                    : zh
                      ? '交给数字员工'
                      : 'Assign work'}
                </button>
              }
            >
              {availableEmployees.length === 0 ? (
                <NoticeBanner
                  tone="warning"
                  title={zh ? '还没有可用的数字员工' : 'No employee is available'}
                >
                  {zh
                    ? '请先在“数字员工”中创建并启用一个员工。'
                    : 'Create, publish and enable an employee from Digital Employees first.'}
                </NoticeBanner>
              ) : null}

              <div className="employee-case-create-grid">
                {step === 0 ? (
                  <FormSection title={zh ? '选择数字员工' : 'Choose a digital employee'}>
                    <Field label={zh ? '数字员工' : 'Digital employee'} required>
                      <Select
                        value={employeeId}
                        onChange={(value) => {
                          setEmployeeId(value)
                          setTarget({})
                          setMaxVisited(0)
                        }}
                        searchable
                        options={availableEmployees.map((candidate) => ({
                          value: candidate.id,
                          label: candidate.published?.displayName ?? candidate.name,
                          description: candidate.published?.workScopeSummary,
                        }))}
                        placeholder={zh ? '选择数字员工' : 'Choose an employee'}
                        disabled={launch.isPending}
                      />
                    </Field>
                    {employee !== null && descriptor !== undefined ? (
                      <NoticeBanner
                        tone="info"
                        title={localized(descriptor.displayName, language)}
                        size="compact"
                      >
                        {employee.published?.workScopeSummary ??
                          localized(descriptor.description, language)}
                      </NoticeBanner>
                    ) : typeQuery.isPending && employee !== null ? (
                      <LoadingState />
                    ) : typeQuery.isError ? (
                      <ErrorBanner error={typeQuery.error} />
                    ) : null}
                  </FormSection>
                ) : null}

                {step === 1 ? (
                  <FormSection title={zh ? '确认执行空间' : 'Confirm the workspace'}>
                    {descriptor !== undefined ? (
                      <>
                        {fixedRepositoryId !== null ? (
                          <NoticeBanner
                            tone="info"
                            size="compact"
                            title={
                              zh ? '目标仓库已由数字员工绑定' : 'Repository fixed by the employee'
                            }
                          >
                            <code>{fixedRepositoryLabel}</code>
                            <span>
                              {zh
                                ? ' · 启动任务时无需重复选择，也不能改到其他仓库。'
                                : ' · No second selection is required, and this task cannot target another repository.'}
                            </span>
                          </NoticeBanner>
                        ) : null}
                        {scopedRepositoryGroupId !== null ? (
                          <NoticeBanner
                            tone="info"
                            size="compact"
                            title={
                              zh
                                ? '从员工负责的仓库组中选择'
                                : 'Choose from the employee repository group'
                            }
                          >
                            {groupLayout.data === undefined
                              ? zh
                                ? '正在读取仓库组成员…'
                                : 'Loading repository group members…'
                              : zh
                                ? `该员工绑定的仓库组包含 ${groupLayout.data.totalRepos} 个仓库，本次任务需确定其中一个目标仓库。`
                                : `This employee group contains ${groupLayout.data.totalRepos} repositories. Choose one target for this task.`}
                          </NoticeBanner>
                        ) : null}
                        {groupLayout.isError ? <ErrorBanner error={groupLayout.error} /> : null}
                        {descriptor.workIntakeAuthoring.targetFields.map((field) =>
                          field.inputKind === 'repository-picker' &&
                          fixedRepositoryId !== null ? null : (
                            <Field
                              key={field.fieldRef}
                              label={localized(field.label, language)}
                              hint={localized(field.description, language)}
                              required={field.required}
                            >
                              {field.inputKind === 'repository-picker' ? (
                                <Select
                                  data-testid="employee-case-repository"
                                  value={target[field.fieldRef] ?? ''}
                                  onChange={(value) =>
                                    setTarget((current) => ({
                                      ...current,
                                      [field.fieldRef]: value,
                                    }))
                                  }
                                  searchable
                                  options={repositoryOptions}
                                  placeholder={
                                    field.placeholder === null
                                      ? zh
                                        ? '选择仓库'
                                        : 'Choose repository'
                                      : localized(field.placeholder, language)
                                  }
                                  disabled={launch.isPending || groupLayout.isPending}
                                />
                              ) : field.inputKind === 'repository-group-picker' ? (
                                <Select
                                  value={target[field.fieldRef] ?? ''}
                                  onChange={(value) =>
                                    setTarget((current) => ({
                                      ...current,
                                      [field.fieldRef]: value,
                                    }))
                                  }
                                  searchable
                                  options={(groups.data?.items ?? []).map((group) => ({
                                    value: group.id,
                                    label: group.name,
                                  }))}
                                  placeholder={zh ? '选择仓库组' : 'Choose repository group'}
                                  disabled={launch.isPending}
                                />
                              ) : (
                                <TextInput
                                  value={target[field.fieldRef] ?? ''}
                                  onChange={(value) =>
                                    setTarget((current) => ({
                                      ...current,
                                      [field.fieldRef]: value,
                                    }))
                                  }
                                  placeholder={
                                    field.placeholder === null
                                      ? undefined
                                      : localized(field.placeholder, language)
                                  }
                                  disabled={launch.isPending}
                                />
                              )}
                            </Field>
                          ),
                        )}
                        {repositories.isError ? <ErrorBanner error={repositories.error} /> : null}
                        {groups.isError ? <ErrorBanner error={groups.error} /> : null}
                      </>
                    ) : null}
                  </FormSection>
                ) : null}

                {step === 2 ? (
                  <FormSection title={zh ? '填写任务内容' : 'Provide task content'}>
                    {descriptor !== undefined ? (
                      <>
                        <Field label={zh ? '工作材料形式' : 'Work material'} group required>
                          <Segmented
                            value={kind}
                            onChange={setKind}
                            ariaLabel={zh ? '工作材料形式' : 'Work material kind'}
                            options={acceptedKinds.map((value) => ({
                              value,
                              label: kindLabel(value),
                            }))}
                            disabled={launch.isPending}
                          />
                        </Field>

                        {unavailableKinds.includes('external-id') ? (
                          <NoticeBanner
                            tone="info"
                            title={
                              zh
                                ? '需求 / 问题 ID 入口尚未启用'
                                : 'External ID intake is not enabled'
                            }
                            size="compact"
                          >
                            {zh
                              ? '正文和上传文档由平台直接受理，不需要准备工具。只有 ID 入口需要先给“准备工作材料”绑定一个能访问内建系统的 Agent 或脚本。'
                              : 'The platform accepts body text and uploads directly. External IDs require an Agent or script bound to Prepare work materials.'}{' '}
                            <Link
                              to="/digital-employees/$typeRef"
                              params={{ typeRef: typeRef ?? '' }}
                              search={{ view: 'toolbox', workItem: 'prepare-materials' }}
                            >
                              {zh ? '去配置准备工具' : 'Configure the acquisition tool'}
                            </Link>
                          </NoticeBanner>
                        ) : null}

                        {needsBody ? (
                          <Field
                            label={localized(descriptor.workIntakeAuthoring.body.label, language)}
                            hint={localized(
                              descriptor.workIntakeAuthoring.body.description,
                              language,
                            )}
                            required
                          >
                            <TextArea
                              value={body}
                              onChange={setBody}
                              placeholder={localized(
                                descriptor.workIntakeAuthoring.body.placeholder,
                                language,
                              )}
                              disabled={launch.isPending}
                            />
                          </Field>
                        ) : null}

                        {kind === 'external-id' ? (
                          <Field
                            label={localized(
                              descriptor.workIntakeAuthoring.externalId.label,
                              language,
                            )}
                            hint={localized(
                              descriptor.workIntakeAuthoring.externalId.description,
                              language,
                            )}
                            required
                          >
                            <TextInput
                              value={externalId}
                              onChange={setExternalId}
                              placeholder={localized(
                                descriptor.workIntakeAuthoring.externalId.placeholder,
                                language,
                              )}
                              disabled={launch.isPending}
                            />
                          </Field>
                        ) : null}

                        {needsFiles ? (
                          <Field
                            label={localized(descriptor.workIntakeAuthoring.files.label, language)}
                            hint={localized(
                              descriptor.workIntakeAuthoring.files.description,
                              language,
                            )}
                            required
                          >
                            <FilesDropzone
                              files={files.map((draft) => draft.file)}
                              onFilesChange={(next) => {
                                const previous = new Map(files.map((draft) => [draft.file, draft]))
                                setFiles(
                                  next.map(
                                    (file) =>
                                      previous.get(file) ?? {
                                        file,
                                        placement: 'repository',
                                        targetPath: file.name,
                                        key: crypto.randomUUID(),
                                      },
                                  ),
                                )
                              }}
                              maxCount={descriptor.workIntakeAuthoring.files.maxFiles}
                              title={zh ? '拖入或选择文件' : 'Drop or choose files'}
                              description={
                                zh
                                  ? '每个文件可选择随 MR 入库，或只作为本次任务的临时材料。'
                                  : 'Each file can be committed with the MR or kept as temporary task material.'
                              }
                              chooseLabel={zh ? '选择文件' : 'Choose files'}
                              removeLabel={zh ? '移除' : 'Remove'}
                              disabled={launch.isPending}
                            />
                            <div className="employee-case-upload-list">
                              {files.map((draft, index) => (
                                <Card
                                  key={draft.key}
                                  title={draft.file.name}
                                  actions={
                                    <span className="muted">
                                      {formatShortBytes(draft.file.size)}
                                    </span>
                                  }
                                >
                                  <Field label={zh ? '文件用途' : 'File placement'} group required>
                                    <Segmented
                                      value={draft.placement}
                                      onChange={(placement) =>
                                        setFiles((current) =>
                                          current.map((item, itemIndex) =>
                                            itemIndex === index ? { ...item, placement } : item,
                                          ),
                                        )
                                      }
                                      ariaLabel={
                                        zh
                                          ? `${draft.file.name} 文件用途`
                                          : `${draft.file.name} placement`
                                      }
                                      options={[
                                        {
                                          value: 'repository',
                                          label: zh ? '随 MR 入库' : 'Commit with MR',
                                        },
                                        {
                                          value: 'temporary',
                                          label: zh ? '仅作临时材料' : 'Temporary material',
                                        },
                                      ]}
                                      disabled={launch.isPending}
                                    />
                                  </Field>
                                  {draft.placement === 'repository' ? (
                                    <Field
                                      label={zh ? '提交到仓库路径' : 'Repository target path'}
                                      hint={
                                        zh
                                          ? '该路径会进入最终 Git 提交和 MR。'
                                          : 'This exact path is included in the final Git commit and MR.'
                                      }
                                      required
                                    >
                                      <TextInput
                                        aria-label={
                                          zh ? '提交到仓库路径' : 'Repository target path'
                                        }
                                        value={draft.targetPath}
                                        onChange={(value) =>
                                          setFiles((current) =>
                                            current.map((item, itemIndex) =>
                                              itemIndex === index
                                                ? { ...item, targetPath: value }
                                                : item,
                                            ),
                                          )
                                        }
                                        placeholder="docs/requirements/example.md"
                                        disabled={launch.isPending}
                                      />
                                    </Field>
                                  ) : (
                                    <NoticeBanner
                                      tone="info"
                                      size="compact"
                                      title={
                                        zh ? '平台分配临时落点' : 'Platform-assigned temporary path'
                                      }
                                    >
                                      <code>
                                        {`.agent-workflow/inputs/requirements/<case>/uploads/${index + 1}-<upload-id>`}
                                      </code>
                                      <span>
                                        {zh
                                          ? ' · 创建任务后替换为精确路径，自动注入后续 Agent 或脚本，不进入 Git。'
                                          : ' · Resolved after launch, injected into downstream executors, and excluded from Git.'}
                                      </span>
                                    </NoticeBanner>
                                  )}
                                </Card>
                              ))}
                            </div>
                          </Field>
                        ) : null}

                        {descriptor.workIntakeAuthoring.executionOptions.map((option) => {
                          const available =
                            option.requiredWorkItemRef === null ||
                            requirementAvailable(
                              option.requiredWorkItemRef,
                              option.requiredSlotRef ?? '',
                              option.requiredExecutorKind,
                            )
                          const enabled = executionOptions[option.optionRef] ?? option.defaultValue
                          const implementationReview =
                            option.optionRef === 'review-implementation-plan'
                          return (
                            <Field
                              key={option.optionRef}
                              label={localized(option.label, language)}
                              hint={localized(option.description, language)}
                              group
                            >
                              <Segmented
                                value={enabled ? 'enabled' : 'disabled'}
                                onChange={(value) =>
                                  setExecutionOptions((current) => ({
                                    ...current,
                                    [option.optionRef]: value === 'enabled',
                                  }))
                                }
                                ariaLabel={localized(option.label, language)}
                                testidPrefix={`employee-execution-option-${option.optionRef}`}
                                options={[
                                  {
                                    value: 'disabled',
                                    label: implementationReview
                                      ? zh
                                        ? '直接实现'
                                        : 'Implement directly'
                                      : zh
                                        ? '关闭'
                                        : 'Off',
                                  },
                                  {
                                    value: 'enabled',
                                    label: implementationReview
                                      ? zh
                                        ? '先评审方案'
                                        : 'Review plan first'
                                      : zh
                                        ? '启用'
                                        : 'On',
                                    disabled: !available,
                                    title: available
                                      ? undefined
                                      : zh
                                        ? '当前员工没有绑定这个选项要求的执行工具'
                                        : 'This employee lacks the executor required by this option',
                                  },
                                ]}
                                disabled={launch.isPending}
                              />
                              {!available ? (
                                <NoticeBanner
                                  tone="info"
                                  title={
                                    zh
                                      ? '当前员工暂不支持这个选项'
                                      : 'Not supported by this employee'
                                  }
                                  size="compact"
                                >
                                  {zh
                                    ? '先在岗位模板中给对应工作项绑定符合要求的 Agent，再创建带评审的任务。'
                                    : 'Bind a compatible Agent on the required work item before launching with review.'}
                                </NoticeBanner>
                              ) : null}
                            </Field>
                          )
                        })}
                      </>
                    ) : null}
                  </FormSection>
                ) : null}
              </div>

              {step === 3 ? (
                <dl className="wizard-summary" data-testid="employee-case-wizard-summary">
                  <div className="wizard-summary__row">
                    <dt>{t('taskWizard.kindLabel')}</dt>
                    <dd data-testid="employee-case-summary-employee">
                      {t('taskWizard.kindDigitalEmployee')}
                      {' · '}
                      {employee?.published?.displayName ?? employee?.name ?? '—'}
                      {summaryEdit(0)}
                    </dd>
                  </div>
                  <div className="wizard-summary__row">
                    <dt>{t('taskWizard.spaceLabel')}</dt>
                    <dd data-testid="employee-case-summary-space">
                      {descriptor?.workIntakeAuthoring.targetFields.length === 0
                        ? '—'
                        : descriptor?.workIntakeAuthoring.targetFields
                            .map((field) => {
                              const value = effectiveTarget[field.fieldRef] ?? ''
                              if (field.inputKind === 'repository-picker') {
                                return (
                                  repositoryOptions.find((option) => option.value === value)
                                    ?.label ?? value
                                )
                              }
                              if (field.inputKind === 'repository-group-picker') {
                                return (
                                  groups.data?.items.find((group) => group.id === value)?.name ??
                                  value
                                )
                              }
                              return value
                            })
                            .filter((value) => value !== '')
                            .join(' · ')}
                      {summaryEdit(1)}
                    </dd>
                  </div>
                  <div className="wizard-summary__row">
                    <dt>{zh ? '工作材料' : 'Work material'}</dt>
                    <dd data-testid="employee-case-summary-content">
                      <strong>{kindLabel(kind)}</strong>
                      {kind === 'external-id' ? (
                        <span>{externalId.trim()}</span>
                      ) : needsBody ? (
                        <span>{bodySummary}</span>
                      ) : null}
                      {files.length > 0 ? (
                        <ul className="wizard-summary__inputs">
                          {files.map((draft) => (
                            <li key={draft.key}>
                              {draft.file.name}
                              {' → '}
                              {draft.placement === 'repository'
                                ? draft.targetPath.trim()
                                : zh
                                  ? '平台临时目录'
                                  : 'Platform temporary directory'}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {summaryEdit(2)}
                    </dd>
                  </div>
                  <div className="wizard-summary__row">
                    <dt>{zh ? '执行策略' : 'Execution policy'}</dt>
                    <dd data-testid="employee-case-summary-options">
                      {enabledExecutionOptions.length === 0
                        ? zh
                          ? '使用岗位默认策略'
                          : 'Use job defaults'
                        : enabledExecutionOptions
                            .map((option) => localized(option.label, language))
                            .join(' · ')}
                      {summaryEdit(2)}
                    </dd>
                  </div>
                </dl>
              ) : null}
            </Stepper>
          </fieldset>
        </div>
      </div>
    </div>
  )
}
