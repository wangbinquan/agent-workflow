export { createFileTaskLaunchConfigurationQueries } from '../infrastructure/local/fileTaskLaunchConfiguration'

import {
  resolveTaskLaunchRuntimeConfiguration,
  resolveTaskLaunchRuntimeFromReader,
  resolveTaskStartLaunchConfiguration,
  resolveTaskSubagentLiveCapture,
  resolveTaskSubagentLiveCaptureFromReader,
  type TaskLaunchRuntimeConfiguration,
} from '../application/launchConfiguration'
import type {
  TaskLaunchConfigurationQueries,
  TaskLaunchConfigurationSnapshot,
} from '../application/ports/taskLaunchConfiguration'

/** Root selection validates the reader without reading it or starting any effect. */
export function composeTaskLaunchConfiguration(
  input:
    | {
        readonly kind: 'local-sync'
        readonly queries: Readonly<{ read(): TaskLaunchConfigurationSnapshot }>
      }
    | { readonly kind: 'selected'; readonly queries: TaskLaunchConfigurationQueries },
) {
  if (
    (input.kind !== 'local-sync' && input.kind !== 'selected') ||
    input.queries === null ||
    input.queries === undefined ||
    typeof input.queries.read !== 'function'
  ) {
    throw new TypeError('task-launch-configuration-incomplete')
  }
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
      selectedQueries === undefined
        ? localRuntime()
        : resolveTaskLaunchRuntimeConfiguration(selectedQueries),
    start: () =>
      selectedQueries === undefined
        ? localStart()
        : resolveTaskStartLaunchConfiguration(selectedQueries),
    drive: ():
      | Awaited<ReturnType<typeof resolveTaskStartLaunchConfiguration>>
      | Promise<Awaited<ReturnType<typeof resolveTaskStartLaunchConfiguration>>> =>
      selectedQueries === undefined
        ? localRuntime()
        : (async () => {
            const runtime = await resolveTaskLaunchRuntimeConfiguration(selectedQueries)
            const subagentLiveCapture = await resolveTaskSubagentLiveCapture(selectedQueries)
            return { ...runtime, subagentLiveCapture }
          })(),
    ...(selectedQueries === undefined
      ? {}
      : {
          preparationConfiguration: Object.freeze({
            async read() {
              const runtime = await resolveTaskLaunchRuntimeConfiguration(selectedQueries)
              return runtime.cloneTimeoutMs === undefined
                ? {}
                : { cloneTimeoutMs: runtime.cloneTimeoutMs }
            },
          }),
        }),
  })
}
