import type { Actor } from '@/auth/actor'
import type { ProtectedMrLaunchGuard } from '@/modules/integration/public/mrTerminalControl'
import type { WorkStartTarget } from '../../public/participants'

export type WebhookOrchestrationTarget = Exclude<
  WorkStartTarget,
  { readonly kind: 'digital-employee' }
>

/**
 * Selected-provider task boundary used by Integration's webhook dispatcher.
 * The implementation owns the provider transaction and launch dependencies;
 * Integration only supplies the authorized target and frozen origin.
 */
export interface WebhookTaskExecutionParticipant<TResources = unknown, TInvoker = unknown> {
  launch(input: {
    readonly actor: Actor
    readonly target: WebhookOrchestrationTarget
    readonly invoker: TInvoker
    readonly resources: TResources
    readonly guard?: ProtectedMrLaunchGuard
  }): Promise<{ readonly taskId: string }>
  cancel(taskId: string): Promise<unknown>
}
