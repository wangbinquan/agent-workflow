import { runWithTaskExecutionContext } from '../taskExecutionContext'
import type { TaskExecutionContextRef } from '../ports/taskExecutionTopology'
import type {
  ResolvedTaskDriveConfig,
  TaskDriveCoordinator,
  TaskDriveSubmission,
} from './taskDriveTypes'

export interface TaskDriveAttachment {
  readonly execution: TaskExecutionContextRef
}

export type TaskDriveAttachOutcome =
  | Readonly<{ kind: 'attached'; attachment: TaskDriveAttachment }>
  | Readonly<{ kind: 'not-attached' }>

export interface TaskDriverLifecyclePort {
  attach(input: {
    readonly taskId: string
    readonly intentId: string
    readonly controller: AbortController
  }): Promise<TaskDriveAttachOutcome>
  releaseAndFinalize(input: {
    readonly taskId: string
    readonly controller: AbortController
  }): Promise<void>
}

export interface TaskDriveContext {
  readonly taskId: string
  readonly execution: TaskExecutionContextRef
  readonly signal: AbortSignal
  readonly runtime: ResolvedTaskDriveConfig
}

export type RepositoryPreparationStepOutcome =
  | Readonly<{ kind: 'ready' }>
  | Readonly<{ kind: 'terminal-won' }>

export interface RepositoryPreparationStep {
  run(context: TaskDriveContext): Promise<RepositoryPreparationStepOutcome>
}

/**
 * Command-specific continuation work that historically ran after attach but
 * before scheduler kickoff (resume rollback and retry rollback). It is awaited
 * before a background receipt so command errors keep their existing response
 * semantics; repository preparation and engine drive remain the detached body.
 */
export interface AdmittedContinuationStep {
  run(context: TaskDriveContext): Promise<RepositoryPreparationStepOutcome>
}

/**
 * RFC-333 linked gate effects run after command-specific admission work and
 * before the background receipt/engine. Keeping this as a distinct phase makes
 * the "rollback settled before rerun" ordering observable and testable.
 */
export interface GateContinuationPreDriveStep {
  run(context: TaskDriveContext): Promise<RepositoryPreparationStepOutcome>
}

export interface TaskEngineOrchestrationPort {
  drive(context: TaskDriveContext): Promise<void>
}

export interface TaskDriveFailureReporter {
  report(input: {
    readonly taskId: string
    readonly intentId: string
    readonly execution: TaskExecutionContextRef
    readonly stage: 'admission-continuation' | 'gate-continuation-effect' | 'drive'
    readonly error: unknown
  }): Promise<void> | void
}

export interface DefaultTaskDriveCoordinatorOptions {
  readonly runtime: ResolvedTaskDriveConfig
  readonly lifecycle: TaskDriverLifecyclePort
  readonly admittedContinuation?: AdmittedContinuationStep
  readonly gateContinuationPreDrive?: GateContinuationPreDriveStep
  readonly repositoryPreparation: RepositoryPreparationStep
  readonly engineOrchestrator: TaskEngineOrchestrationPort
  readonly failureReporter: TaskDriveFailureReporter
}

/**
 * The one application owner of a post-admission task drive.
 *
 * Commands submit durable ids only. The instance already owns the resolved
 * runtime profile and all mechanics needed to attach, drive and release the
 * exact durable execution.
 */
export class DefaultTaskDriveCoordinator implements TaskDriveCoordinator {
  constructor(private readonly options: DefaultTaskDriveCoordinatorOptions) {}

  async submit(input: TaskDriveSubmission) {
    const controller = new AbortController()
    const attached = await this.options.lifecycle.attach({
      taskId: input.taskId,
      intentId: input.intentId,
      controller,
    })
    if (attached.kind === 'not-attached') {
      return { kind: 'not-attached' as const, taskId: input.taskId }
    }

    const context = this.contextFor(input.taskId, controller, attached.attachment)
    if (this.options.admittedContinuation !== undefined) {
      try {
        const outcome = await runWithTaskExecutionContext(
          attached.attachment.execution,
          async () => await this.options.admittedContinuation?.run(context),
        )
        if (outcome?.kind === 'terminal-won') {
          await this.options.lifecycle.releaseAndFinalize({
            taskId: input.taskId,
            controller,
          })
          return input.completionMode === 'background'
            ? { kind: 'accepted' as const, taskId: input.taskId }
            : { kind: 'settled' as const, taskId: input.taskId }
        }
      } catch (error) {
        try {
          await this.reportFailure(input, attached.attachment, 'admission-continuation', error)
        } finally {
          await this.options.lifecycle.releaseAndFinalize({
            taskId: input.taskId,
            controller,
          })
        }
        throw error
      }
    }

    if (this.options.gateContinuationPreDrive !== undefined) {
      try {
        const outcome = await runWithTaskExecutionContext(
          attached.attachment.execution,
          async () => await this.options.gateContinuationPreDrive?.run(context),
        )
        if (outcome?.kind === 'terminal-won') {
          await this.options.lifecycle.releaseAndFinalize({
            taskId: input.taskId,
            controller,
          })
          return input.completionMode === 'background'
            ? { kind: 'accepted' as const, taskId: input.taskId }
            : { kind: 'settled' as const, taskId: input.taskId }
        }
      } catch (error) {
        try {
          await this.reportFailure(input, attached.attachment, 'gate-continuation-effect', error)
        } finally {
          await this.options.lifecycle.releaseAndFinalize({
            taskId: input.taskId,
            controller,
          })
        }
        throw error
      }
    }

    const completion = this.driveAttached(input, controller, attached.attachment, context)
    if (input.completionMode === 'background') {
      // The reporter has already translated/logged the failure. Background
      // submission deliberately has no caller awaiting this promise.
      void completion.catch(() => undefined)
      return { kind: 'accepted' as const, taskId: input.taskId }
    }

    await completion
    return { kind: 'settled' as const, taskId: input.taskId }
  }

  private async driveAttached(
    input: TaskDriveSubmission,
    controller: AbortController,
    attachment: TaskDriveAttachment,
    context: TaskDriveContext,
  ): Promise<void> {
    try {
      await runWithTaskExecutionContext(attachment.execution, async () => {
        const preparation = await this.options.repositoryPreparation.run(context)
        if (preparation.kind === 'ready') {
          await this.options.engineOrchestrator.drive(context)
        }
      })
    } catch (error) {
      await this.reportFailure(input, attachment, 'drive', error)
      throw error
    } finally {
      await this.options.lifecycle.releaseAndFinalize({
        taskId: input.taskId,
        controller,
      })
    }
  }

  private contextFor(
    taskId: string,
    controller: AbortController,
    attachment: TaskDriveAttachment,
  ): TaskDriveContext {
    return Object.freeze({
      taskId,
      execution: attachment.execution,
      signal: controller.signal,
      runtime: this.options.runtime,
    })
  }

  private async reportFailure(
    input: TaskDriveSubmission,
    attachment: TaskDriveAttachment,
    stage: 'admission-continuation' | 'gate-continuation-effect' | 'drive',
    error: unknown,
  ): Promise<void> {
    await this.options.failureReporter.report({
      taskId: input.taskId,
      intentId: input.intentId,
      execution: attachment.execution,
      stage,
      error,
    })
  }
}

export const skipRepositoryPreparation: RepositoryPreparationStep = Object.freeze({
  async run() {
    return { kind: 'ready' as const }
  },
})
