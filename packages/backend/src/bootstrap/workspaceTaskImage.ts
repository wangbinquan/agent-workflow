import {
  WORKSPACE_RESULT_PREFIX,
  decodeWorkspaceHelperArguments,
} from '@/platform/crewstation/workspaceProtocol'
import { executeTaskImageWorkspaceOperation } from '@/modules/source-control/composition/taskImageWorkspace'
import {
  executeTaskImageExecutionOperation,
  TASK_IMAGE_EXECUTION_OPERATIONS,
} from '@/modules/task-execution/composition/taskImageExecution'

/** Runs only in the CS task image. Control-plane services call this through
 * command subtasks; they never gain native Git, filesystem or script effects. */
export async function runWorkspaceTaskImageCommand(chunks: readonly string[]): Promise<number> {
  const stop = new AbortController()
  const onStop = () => stop.abort()
  process.once('SIGTERM', onStop)
  process.once('SIGINT', onStop)
  try {
    const request = decodeWorkspaceHelperArguments(chunks)
    const value = await executeWorkspaceTaskImageOperation(
      request.operation,
      request.input,
      stop.signal,
    )
    console.log(`${WORKSPACE_RESULT_PREFIX}${JSON.stringify({ ok: true, value })}`)
    return 0
  } catch (error) {
    console.log(
      `${WORKSPACE_RESULT_PREFIX}${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}`,
    )
    return 1
  } finally {
    process.off('SIGTERM', onStop)
    process.off('SIGINT', onStop)
  }
}

/** The task-image root selects each command's existing domain owner. */
export async function executeWorkspaceTaskImageOperation(
  operation: string,
  value: unknown,
  signal?: AbortSignal,
  volumeRoot = '/work',
): Promise<unknown> {
  if ((TASK_IMAGE_EXECUTION_OPERATIONS as readonly string[]).includes(operation)) {
    return executeTaskImageExecutionOperation(operation, value, signal, volumeRoot)
  }
  return executeTaskImageWorkspaceOperation(operation, value, signal, volumeRoot)
}
