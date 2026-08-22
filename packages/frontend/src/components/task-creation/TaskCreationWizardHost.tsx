import type { TaskCreationKind } from '@agent-workflow/shared'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Field } from '@/components/Form'
import { PageHeader } from '@/components/PageHeader'
import { Stepper, type StepperStep } from '@/components/Stepper'
import { TaskCreationKindPicker } from './TaskCreationKindPicker'
import { TaskCreationWizardShell } from './TaskCreationWizardShell'

/**
 * The only visual host for every task source.
 *
 * Source contracts contribute fields, validation and a submit command. They do
 * not own page width, the source catalog, the four-step frame, navigation or
 * material locking, so registering another source cannot create a bespoke
 * task-creation page.
 */
export interface TaskCreationReadyHostProps {
  readonly title: string
  readonly sourceId: TaskCreationKind
  readonly onSourceChange: (sourceId: TaskCreationKind) => void
  readonly availableSourceIds?: ReadonlySet<TaskCreationKind>
  readonly sourceSelectionDisabled?: boolean
  readonly sourceSelectionHint?: ReactNode
  readonly feedback?: ReactNode
  readonly materialDisabled?: boolean
  readonly busy?: boolean
  readonly steps: ReadonlyArray<StepperStep>
  readonly currentStep: number
  readonly maxReachable: number
  readonly onNavigate: (step: number) => void
  readonly nextEnabled: boolean
  readonly navigationDisabled?: boolean
  readonly finalActions?: ReactNode
  readonly stepContent: ReactNode
  readonly children?: ReactNode
}

export interface TaskCreationBlockingHostProps {
  readonly title: string
  readonly sourceId: TaskCreationKind
  readonly blockingContent: ReactNode
}

export type TaskCreationWizardHostProps = TaskCreationReadyHostProps | TaskCreationBlockingHostProps

export function TaskCreationWizardHost(props: TaskCreationWizardHostProps) {
  const { t } = useTranslation()
  if ('blockingContent' in props) {
    return (
      <div className="page" data-task-kind={props.sourceId}>
        <PageHeader title={props.title} />
        {props.blockingContent}
      </div>
    )
  }
  return (
    <TaskCreationWizardShell
      title={props.title}
      sourceId={props.sourceId}
      feedback={props.feedback}
    >
      <fieldset
        className="task-wizard__material"
        disabled={props.materialDisabled}
        aria-busy={props.busy || undefined}
      >
        <Stepper
          steps={props.steps}
          current={props.currentStep}
          maxReachable={props.maxReachable}
          onNavigate={props.onNavigate}
          nextEnabled={props.nextEnabled}
          navigationDisabled={props.navigationDisabled}
          rootTestid="task-wizard-stepper"
          finalActions={props.finalActions}
        >
          <div className="task-creation-step">
            {props.currentStep === 0 ? (
              <>
                <Field label={t('taskWizard.kindLabel')} group>
                  <TaskCreationKindPicker
                    value={props.sourceId}
                    onChange={props.onSourceChange}
                    availableKinds={props.availableSourceIds}
                    disabled={props.sourceSelectionDisabled}
                  />
                </Field>
                {props.sourceSelectionHint}
              </>
            ) : null}
            {props.stepContent}
          </div>
        </Stepper>
      </fieldset>
      {props.children}
    </TaskCreationWizardShell>
  )
}
