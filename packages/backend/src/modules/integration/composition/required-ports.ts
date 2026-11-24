export type { IntegrationTriggerSnapshotFactory } from '../application/ports/integrationTriggerSnapshots'
// RFC-555: Development Automation implements the code-host event continuation in its designated integration adapter.
export type { CodeHostEventContinuationPort } from '../application/ports/codeHostEventResponse'
// RFC-556: Task Execution implements the webhook task-execution participant in its designated integration adapter.
export type { WebhookTaskExecutionParticipant } from '../application/ports/webhookExecution'
