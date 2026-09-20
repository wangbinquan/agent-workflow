import { DomainError } from '@/util/errors'

interface PreparedWorkspace {
  readonly taskId: string
  commit(): void
}
interface Admission<Result> {
  readonly taskId: string
  readonly failed: boolean
  readonly projection: Result
}
interface LaunchGuard {
  taskCommitted(taskId: string): Promise<void>
  launchSettled(taskId: string): Promise<void>
  failed(code: string): Promise<void>
  release(): void
}

/** Task owns the admission boundary. A committed workspace is never rolled back
 * when event publication, dispatch, or a source receipt subsequently fails.
 * Adapters supply transaction and filesystem effects; none run concurrently. */
export async function launchTask<
  Context extends { readonly taskId: string },
  Workspace extends PreparedWorkspace,
  Inputs,
  Cleanup,
  Result,
  Accepted extends Admission<Result>,
>(ports: {
  preflight(): Promise<Context>
  prepare(context: Context): Promise<Workspace>
  initialInputs(): Inputs
  applyUploads(context: Context, workspace: Workspace, inputs: Inputs): Promise<void>
  admit(context: Context, workspace: Workspace, inputs: Inputs): Promise<Accepted>
  rollback(workspace: Workspace): Promise<Cleanup>
  uploadFailure(error: unknown, report: Cleanup): unknown
  publish(admission: Accepted): Promise<unknown>
  submit(admission: Accepted): Promise<unknown>
  guard: LaunchGuard | undefined
}): Promise<Accepted['projection']> {
  let workspace: Workspace | undefined
  let databaseCommitted = false
  let rolledBack = false
  let guardSettled = false
  try {
    const context = await ports.preflight()
    workspace = await ports.prepare(context)
    if (workspace.taskId !== context.taskId) {
      await ports.rollback(workspace)
      rolledBack = true
      throw new Error(
        `task-route-workspace-id-mismatch: expected '${context.taskId}', got '${workspace.taskId}'`,
      )
    }
    const inputs = ports.initialInputs()
    try {
      await ports.applyUploads(context, workspace, inputs)
    } catch (error) {
      const report = await ports.rollback(workspace)
      rolledBack = true
      throw ports.uploadFailure(error, report)
    }
    const admission = await ports.admit(context, workspace, inputs)
    databaseCommitted = true
    await ports.guard?.taskCommitted(admission.taskId)
    workspace.commit()
    await ports.publish(admission)
    if (!admission.failed) await ports.submit(admission)
    await ports.guard?.launchSettled(admission.taskId)
    guardSettled = true
    return admission.projection
  } catch (error) {
    if (workspace !== undefined && !databaseCommitted && !rolledBack) {
      await ports.rollback(workspace)
    }
    if (ports.guard !== undefined && !guardSettled) {
      try {
        await ports.guard.failed(error instanceof DomainError ? error.code : 'launch-failed')
      } catch {
        // The original failure is authoritative; the source guard owns recovery
        // of its failed failure-receipt write.
      }
    }
    throw error
  } finally {
    ports.guard?.release()
  }
}
