import type { DaemonHostLifecyclePort } from '../application/ports/daemonHostLifecycle'
import type { DaemonRuntimeQueries } from '../public/queries'
import {
  createFileDaemonRuntimeQueries,
  type FileDaemonRuntimeQueryOptions,
} from '../infrastructure/local/fileDaemonRuntimeQueries'
import {
  createNativeDaemonHostLifecycle,
  type NativeDaemonHostOptions,
} from '../infrastructure/local/nativeDaemonHostLifecycle'

export type { DaemonHostLifecyclePort } from '../application/ports/daemonHostLifecycle'

export function selectDaemonHostLifecycle(
  selected: DaemonHostLifecyclePort | undefined,
  native: NativeDaemonHostOptions,
): DaemonHostLifecyclePort {
  return selected ?? createNativeDaemonHostLifecycle(native)
}

export function selectDaemonRuntimeQueries(
  selected: DaemonRuntimeQueries | undefined,
  file: FileDaemonRuntimeQueryOptions = {},
): DaemonRuntimeQueries {
  return selected ?? createFileDaemonRuntimeQueries(file)
}
