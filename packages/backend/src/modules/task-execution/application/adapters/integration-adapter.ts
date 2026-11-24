// RFC-556 (RFC-294 S9 step 11): Task Execution's designated adapter for Integration's consumer-owned required ports
// (`@/modules/integration/composition/required-ports`, type-only). Task Execution implements the webhook task-execution
// participant in `infrastructure/taskExecutionTrigger.ts`; the instantiated port type moved here from that file.
import type { WebhookTaskExecutionParticipant } from '@/modules/integration/composition/required-ports'
import type { ExecutionInvoker } from '../../public/commands'
import type { TaskExecutionResourceAuthority } from '../ports/taskExecutionResourceSnapshots'

export type TaskExecutionTriggerParticipant = WebhookTaskExecutionParticipant<
  TaskExecutionResourceAuthority,
  ExecutionInvoker
>
