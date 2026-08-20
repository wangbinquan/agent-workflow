import type { CachedRepo } from '@agent-workflow/shared'
import { useMutation, useQuery } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { Card } from '@/components/Card'
import type {
  DigitalEmployeeDefinition,
  EmployeeTypePackage,
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
import { Route as RootRoute } from './__root'

type IntakeKind = 'body' | 'files' | 'body-and-files' | 'external-id'

interface UploadDraft {
  file: File
  targetPath: string
  key: string
}

interface RepositoryGroup {
  id: string
  name: string
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
  const { i18n } = useTranslation()
  const language = i18n.resolvedLanguage ?? i18n.language
  const zh = language.startsWith('zh')
  const navigate = Route.useNavigate()
  const [employeeId, setEmployeeId] = useState('')
  const [kind, setKind] = useState<IntakeKind>('body')
  const [target, setTarget] = useState<Record<string, string>>({})
  const [body, setBody] = useState('')
  const [externalId, setExternalId] = useState('')
  const [files, setFiles] = useState<UploadDraft[]>([])

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

  useEffect(() => {
    if (descriptor === undefined) return
    const accepted = descriptor.workIntakeAuthoring.acceptedKinds
    if (!accepted.includes(kind)) setKind(accepted[0] ?? 'body')
    setTarget((current) =>
      Object.fromEntries(
        descriptor.workIntakeAuthoring.targetFields.map((field) => [
          field.fieldRef,
          current[field.fieldRef] ?? '',
        ]),
      ),
    )
  }, [descriptor, kind])

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
  const groups = useQuery<{ items: RepositoryGroup[] }>({
    queryKey: ['repo-groups', 'employee-case-launch'],
    enabled: needsGroups,
    queryFn: ({ signal }) => api.get('/api/repo-groups', undefined, signal),
  })

  const needsBody = kind === 'body' || kind === 'body-and-files'
  const needsFiles = kind === 'files' || kind === 'body-and-files'
  const targetComplete =
    descriptor?.workIntakeAuthoring.targetFields.every(
      (field) => !field.required || (target[field.fieldRef] ?? '').trim() !== '',
    ) === true
  const filesValid =
    !needsFiles ||
    (files.length > 0 &&
      files.every(
        (draft) =>
          draft.targetPath.trim() !== '' &&
          draft.file.size <= (descriptor?.workIntakeAuthoring.files.maxFileBytes ?? 0),
      ) &&
      new Set(files.map((draft) => draft.targetPath.trim())).size === files.length)
  const ready =
    employee !== null &&
    descriptor !== undefined &&
    targetComplete &&
    (!needsBody || body.trim() !== '') &&
    (!needsFiles || filesValid) &&
    (kind !== 'external-id' || externalId.trim() !== '')

  const launch = useMutation({
    mutationFn: async () => {
      if (employee === null) throw new Error('digital employee is required')
      const completed: Array<{ uploadRef: string; targetPath: string }> = []
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
          completed.push({ uploadRef: uploaded.uploadRef, targetPath: draft.targetPath.trim() })
        }
        return await api.post<LaunchProjection>(
          `/api/digital-employees/${encodeURIComponent(employee.id)}/cases`,
          {
            kind,
            target: Object.fromEntries(
              Object.entries(target).map(([key, value]) => [key, value.trim()]),
            ),
            body: needsBody ? body : null,
            externalId: kind === 'external-id' ? externalId.trim() : null,
            uploads: completed,
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

  const acceptedKinds = descriptor?.workIntakeAuthoring.acceptedKinds ?? []
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

  return (
    <div className="page page--operations employee-case-create-page">
      <div className="operations-surface">
        <PageHeader
          className="operations-surface__header"
          title={zh ? '交给数字员工' : 'Assign work to a digital employee'}
        >
          <p className="operations-surface__subtitle">
            {zh
              ? '选择一个数字员工并给出工作材料；它会按所属分类的固定职责图执行。'
              : 'Choose an employee and provide the work material. Its type owns the fixed responsibility map.'}
          </p>
        </PageHeader>

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
          <FormSection title={zh ? '1. 谁来负责' : '1. Who owns this work'}>
            <Field label={zh ? '数字员工' : 'Digital employee'} required>
              <Select
                value={employeeId}
                onChange={(value) => {
                  setEmployeeId(value)
                  setTarget({})
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

          <FormSection title={zh ? '2. 给它什么工作' : '2. What work should it do'}>
            {descriptor !== undefined ? (
              <>
                {descriptor.workIntakeAuthoring.targetFields.map((field) => (
                  <Field
                    key={field.fieldRef}
                    label={localized(field.label, language)}
                    hint={localized(field.description, language)}
                    required={field.required}
                  >
                    {field.inputKind === 'repository-picker' ? (
                      <Select
                        value={target[field.fieldRef] ?? ''}
                        onChange={(value) =>
                          setTarget((current) => ({ ...current, [field.fieldRef]: value }))
                        }
                        searchable
                        options={(repositories.data?.items ?? []).map((repository) => ({
                          value: repository.id,
                          label: repository.urlRedacted,
                        }))}
                        placeholder={
                          field.placeholder === null
                            ? zh
                              ? '选择仓库'
                              : 'Choose repository'
                            : localized(field.placeholder, language)
                        }
                        disabled={launch.isPending}
                      />
                    ) : field.inputKind === 'repository-group-picker' ? (
                      <Select
                        value={target[field.fieldRef] ?? ''}
                        onChange={(value) =>
                          setTarget((current) => ({ ...current, [field.fieldRef]: value }))
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
                          setTarget((current) => ({ ...current, [field.fieldRef]: value }))
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
                ))}

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

                {needsBody ? (
                  <Field
                    label={localized(descriptor.workIntakeAuthoring.body.label, language)}
                    hint={localized(descriptor.workIntakeAuthoring.body.description, language)}
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
                    label={localized(descriptor.workIntakeAuthoring.externalId.label, language)}
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
                    hint={localized(descriptor.workIntakeAuthoring.files.description, language)}
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
                          ? '每个文件都要指定提交到仓库中的路径。'
                          : 'Each file needs an exact path in the target repository.'
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
                            <span className="muted">{formatShortBytes(draft.file.size)}</span>
                          }
                        >
                          <Field label={zh ? '提交到仓库路径' : 'Repository target path'} required>
                            <TextInput
                              value={draft.targetPath}
                              onChange={(value) =>
                                setFiles((current) =>
                                  current.map((item, itemIndex) =>
                                    itemIndex === index ? { ...item, targetPath: value } : item,
                                  ),
                                )
                              }
                              placeholder="src/example.txt"
                              disabled={launch.isPending}
                            />
                          </Field>
                        </Card>
                      ))}
                    </div>
                  </Field>
                ) : null}
              </>
            ) : null}
          </FormSection>
        </div>

        {launch.isError ? <ErrorBanner error={launch.error} /> : null}
        <div className="employee-case-create-actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={!ready || launch.isPending}
            onClick={() => launch.mutate()}
          >
            {launch.isPending
              ? zh
                ? '正在交给数字员工…'
                : 'Assigning…'
              : zh
                ? '交给数字员工'
                : 'Assign work'}
          </button>
        </div>
      </div>
    </div>
  )
}
