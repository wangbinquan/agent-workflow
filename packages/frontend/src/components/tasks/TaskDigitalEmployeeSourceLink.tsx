// A TaskEngine execution launched by the digital employee OS retains a stable
// Case id. Resolve the source-owned Case projection here so the task header can
// name the exact employee and deep-link its frozen job template without
// teaching TaskEngine about digital-employee authoring internals.

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

import { api } from '@/api/client'
import { typeRefKey } from '@/components/digital-employees/types'

interface DigitalEmployeeTaskSource {
  case: {
    employeeRef: { id: string; revision: number }
    typeRef: { typeId: string; revision: number }
  }
  capabilityActivation: {
    displayName: string
    jobTemplateRef: { id: string; revision: number }
  }
}

export function TaskDigitalEmployeeSourceLink({ caseId }: { caseId: string }) {
  const { t } = useTranslation()
  const source = useQuery<DigitalEmployeeTaskSource>({
    queryKey: ['employee-case', caseId, 'task-source-link'],
    queryFn: ({ signal }) =>
      api.get(`/api/employee-cases/${encodeURIComponent(caseId)}`, undefined, signal),
    staleTime: Number.POSITIVE_INFINITY,
  })

  if (source.data === undefined) {
    return (
      <Link
        className="data-table__link task-detail__source-link"
        data-testid="task-digital-employee-source-link"
        to="/tasks/employee-cases/$caseId"
        params={{ caseId }}
      >
        {t('tasks.digitalEmployeeSource')}
      </Link>
    )
  }

  return (
    <Link
      className="data-table__link task-detail__source-link"
      data-testid="task-digital-employee-source-link"
      to="/digital-employees/$typeRef"
      params={{ typeRef: typeRefKey(source.data.case.typeRef) }}
      search={{
        view: 'jobs',
        jobTemplateId: source.data.capabilityActivation.jobTemplateRef.id,
      }}
    >
      {source.data.capabilityActivation.displayName || source.data.case.employeeRef.id}
    </Link>
  )
}
