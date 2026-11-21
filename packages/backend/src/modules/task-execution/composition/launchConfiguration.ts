export { createFileTaskLaunchConfigurationQueries } from '../infrastructure/local/fileTaskLaunchConfiguration'

import {
  resolveTaskLaunchRuntimeConfiguration,
  resolveTaskLaunchRuntimeFromReader,
  resolveTaskStartLaunchConfiguration,
  resolveTaskSubagentLiveCapture,
  resolveTaskSubagentLiveCaptureFromReader,
  requireTaskLaunchConfigurationInput,
  type TaskLaunchRuntimeConfiguration,
} from '../application/launchConfiguration'
import type {
  TaskLaunchConfigurationQueries,
  TaskLaunchConfigurationSnapshot,
} from '../application/ports/taskLaunchConfiguration'

/**
 * Root selection validates the reader without reading it or starting any effect. RFC-526: each read follows the mode the
 * caller selected (`kind`) — local synchronous reads or the selected queries; neither is a default for the other.
 */
export function composeTaskLaunchConfiguration(
  input:
    | {
        readonly kind: 'local-sync'
        readonly queries: Readonly<{ read(): TaskLaunchConfigurationSnapshot }>
      }
    | { readonly kind: 'selected'; readonly queries: TaskLaunchConfigurationQueries },
) {
  requireTaskLaunchConfigurationInput(input)
  const localRuntime = (): TaskLaunchRuntimeConfiguration =>
    input.kind === 'local-sync'
      ? resolveTaskLaunchRuntimeFromReader(() => input.queries.read())
      : {}
  const localStart = (): Awaited<ReturnType<typeof resolveTaskStartLaunchConfiguration>> => {
    if (input.kind !== 'local-sync') return {}
    const subagentLiveCapture = resolveTaskSubagentLiveCaptureFromReader(() => input.queries.read())
    return {
      ...(subagentLiveCapture === undefined ? {} : { subagentLiveCapture }),
      ...resolveTaskLaunchRuntimeFromReader(() => input.queries.read()),
    }
  }
  const selectedQueries = input.kind === 'selected' ? input.queries : undefined
  return Object.freeze({
    selectedQueries,
    // A continuous gate worker must retain the original live reader in local
    // mode too; boot-time legacy projections cannot select the resumed model.
    continuationQueries: input.queries,
    initialRuntime: localRuntime,
    initialStart: localStart,
    runtime: () =>
      input.kind === 'local-sync'
        ? localRuntime()
        : resolveTaskLaunchRuntimeConfiguration(input.queries),
    start: () =>
      input.kind === 'local-sync'
        ? localStart()
        : resolveTaskStartLaunchConfiguration(input.queries),
    drive: ():
      | Awaited<ReturnType<typeof resolveTaskStartLaunchConfiguration>>
      | Promise<Awaited<ReturnType<typeof resolveTaskStartLaunchConfiguration>>> =>
      input.kind === 'local-sync'
        ? localRuntime()
        : (async () => {
            const runtime = await resolveTaskLaunchRuntimeConfiguration(input.queries)
            const subagentLiveCapture = await resolveTaskSubagentLiveCapture(input.queries)
            return { ...runtime, subagentLiveCapture }
          })(),
    ...(input.kind === 'local-sync'
      ? {}
      : {
          preparationConfiguration: Object.freeze({
            async read() {
              const runtime = await resolveTaskLaunchRuntimeConfiguration(input.queries)
              return runtime.cloneTimeoutMs === undefined
                ? {}
                : { cloneTimeoutMs: runtime.cloneTimeoutMs }
            },
          }),
        }),
  })
}
