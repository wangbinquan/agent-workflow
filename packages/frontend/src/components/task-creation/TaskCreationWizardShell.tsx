import type { ReactNode } from 'react'

import { PageHeader } from '@/components/PageHeader'

export function TaskCreationWizardShell(props: {
  title: string
  sourceId?: string
  feedback?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="page task-wizard" data-testid="task-wizard" data-task-kind={props.sourceId}>
      <PageHeader title={props.title} />
      {props.feedback}
      {props.children}
    </div>
  )
}
