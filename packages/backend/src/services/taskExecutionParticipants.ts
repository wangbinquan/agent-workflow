// Legacy orchestration adapter for RFC-328's exact provider-facing surface.
// Services consume public participants and never import task-execution
// application/domain/infrastructure/composition directly.
export * from '@/modules/task-execution/public/participants'

import type {
  createProcessEffectAttemptObserver,
  createTaskExecutionContext,
  taskExecutionModule,
} from '@/modules/task-execution/public/participants'

export type TaskExecutionContext = ReturnType<typeof createTaskExecutionContext>
export type ProcessEffectAttemptObserver = NonNullable<
  ReturnType<typeof createProcessEffectAttemptObserver>
>
export type ProcessSettlement = Parameters<ProcessEffectAttemptObserver['settle']>[0]
export type RuntimeStopTicket = Awaited<ReturnType<typeof taskExecutionModule.dispose>>[number]
