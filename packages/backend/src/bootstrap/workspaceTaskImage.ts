import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  decodeWorkspaceHelperArguments,
  workspaceHelperFailureOf,
  type WorkspaceHelperOutcome,
} from '@/platform/crewstation/workspaceProtocol'
import { requireWorkPath } from '@/platform/crewstation/workVolumePath'
import { executeTaskImageWorkspaceOperation } from '@/modules/source-control/composition/taskImageWorkspace'
import { taskImageGitEnvironment } from '@/modules/source-control/composition/crewstationGitCredentials'
import {
  executeTaskImageExecutionOperation,
  TASK_IMAGE_EXECUTION_OPERATIONS,
} from '@/modules/task-execution/composition/taskImageExecution'
import {
  executeTaskImageDevelopmentOperation,
  TASK_IMAGE_DEVELOPMENT_OPERATIONS,
} from '@/modules/development-automation/composition/taskImageWorkspace'
import { executeTaskImageSystemWorkspace } from '@/modules/runtime-management/composition/taskImageMaterial'
import { executeTaskImageEvidence } from '@/modules/development-automation/composition/taskImageEvidence'
import { executeTaskImageVerification } from '@/modules/development-automation/composition/taskImageVerification'
import { executeTaskImageDevelopmentAdapter } from '@/modules/integration/composition/taskImageDevelopmentAdapter'
import { executeTaskImageArchive } from '@/modules/task-execution/composition/taskImageArchive'
import { executeTaskImagePlugin } from '@/modules/resource-catalog/composition/taskImagePlugin'
import { executeTaskImageMcpProbe } from '@/modules/resource-catalog/composition/taskImageMcpProbe'
import {
  executeTaskImageObserver,
  TASK_IMAGE_OBSERVER_OPERATIONS,
} from '@/modules/event-center/composition'

/** The outcome is published atomically: a reader sees either no file or the
 * complete outcome, never a partial one, even across a container restart. */
export function writeWorkspaceHelperOutcome(
  resultPath: string,
  outcome: WorkspaceHelperOutcome,
  volumeRoot = '/work',
): void {
  const target = requireWorkPath(resultPath, volumeRoot)
  mkdirSync(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  const fd = openSync(temporary, 'w', 0o600)
  try {
    writeSync(fd, JSON.stringify(outcome))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporary, target)
  const directory = openSync(dirname(target), 'r')
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
}

/** Runs only in the CS task image. Control-plane services call this through
 * command subtasks; they never gain native Git, filesystem or script effects.
 * Stdout and stderr carry only the native operation's own output. */
export async function runWorkspaceTaskImageCommand(
  chunks: readonly string[],
  volumeRoot = '/work',
): Promise<number> {
  const stop = new AbortController()
  const onStop = () => stop.abort()
  process.once('SIGTERM', onStop)
  process.once('SIGINT', onStop)
  let resultPath: string | undefined
  try {
    Object.assign(process.env, taskImageGitEnvironment(process.env))
    const request = decodeWorkspaceHelperArguments(chunks)
    resultPath = request.resultPath
    const value = await executeWorkspaceTaskImageOperation(
      request.operation,
      request.input,
      stop.signal,
      volumeRoot,
    )
    writeWorkspaceHelperOutcome(resultPath, { ok: true, value: value ?? null }, volumeRoot)
    return 0
  } catch (error) {
    const failure = workspaceHelperFailureOf(error)
    if (resultPath !== undefined) {
      try {
        writeWorkspaceHelperOutcome(resultPath, { ok: false, error: failure }, volumeRoot)
      } catch (writeError) {
        console.error(
          `workspace helper could not record its outcome: ${writeError instanceof Error ? writeError.message : String(writeError)}`,
        )
      }
    }
    console.error(`${failure.code}: ${failure.message}`)
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
  if (operation === 'archive-task-files') return executeTaskImageArchive(value, volumeRoot)
  if (operation === 'plugin-installation') return executeTaskImagePlugin(value, signal, volumeRoot)
  if (operation === 'mcp-probe') return executeTaskImageMcpProbe(value)
  if (operation === 'evidence-files') return executeTaskImageEvidence(value, volumeRoot)
  if (operation === 'development-adapter')
    return executeTaskImageDevelopmentAdapter(value, signal, volumeRoot)
  if (operation === 'verification-command')
    return executeTaskImageVerification(value, signal, volumeRoot)
  if ((TASK_IMAGE_OBSERVER_OPERATIONS as readonly string[]).includes(operation))
    return executeTaskImageObserver(operation, value, signal, volumeRoot)
  if (operation === 'system-workspace') return executeTaskImageSystemWorkspace(value, volumeRoot)
  if ((TASK_IMAGE_EXECUTION_OPERATIONS as readonly string[]).includes(operation)) {
    return executeTaskImageExecutionOperation(operation, value, signal, volumeRoot)
  }
  if ((TASK_IMAGE_DEVELOPMENT_OPERATIONS as readonly string[]).includes(operation))
    return executeTaskImageDevelopmentOperation(operation, value, volumeRoot)
  return executeTaskImageWorkspaceOperation(operation, value, signal, volumeRoot)
}
