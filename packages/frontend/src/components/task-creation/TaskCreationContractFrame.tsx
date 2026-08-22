import { TaskCreationWizardHost, type TaskCreationWizardHostProps } from './TaskCreationWizardHost'

/**
 * The only mount point for task-creation page chrome and four-step navigation.
 * Source contracts may prepare fields and commands, but cannot mount their own
 * wizard host.
 */
export function TaskCreationContractFrame(props: TaskCreationWizardHostProps) {
  return <TaskCreationWizardHost {...props} />
}
