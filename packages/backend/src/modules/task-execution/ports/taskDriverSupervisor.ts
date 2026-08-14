// RFC-303 — exact owner contract for process-local task drivers.
//
// A task row reaching `canceled` is not proof that its scheduler, subprocesses,
// permits, or runtime-session leases have settled.  The supervisor therefore
// exposes an identity-bound stop ticket whose promise resolves only when the
// exact attached driver releases its ownership slot.
import type { TaskStopCause } from '@/modules/task-execution/domain/sourceTermination'

export type TaskDriverStopResult =
  | Readonly<{ kind: 'released' }>
  | Readonly<{ kind: 'unreaped'; code: string }>

export type TaskDriverStopTicket = Readonly<{
  taskId: string
  generation: number
}>

export interface TaskDriverSupervisor {
  tryAttach(
    taskId: string,
    controller: AbortController,
  ): Promise<'attached' | 'rejected-status-or-source-fence'>
  requestStop(
    taskId: string,
    cause: TaskStopCause,
  ): Promise<TaskDriverStopTicket | 'no-active-owner'>
  awaitStopped(ticket: TaskDriverStopTicket): Promise<TaskDriverStopResult>
}
