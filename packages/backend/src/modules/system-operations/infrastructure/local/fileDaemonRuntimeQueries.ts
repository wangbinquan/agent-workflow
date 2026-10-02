import { readDaemonInfo } from '@/util/daemonInfo'
import type { DaemonRuntimeQueries } from '../../public/queries'

export interface FileDaemonRuntimeQueryOptions {
  readonly infoPath?: string
}

export function createFileDaemonRuntimeQueries(
  options: FileDaemonRuntimeQueryOptions = {},
): DaemonRuntimeQueries {
  return {
    readCurrent: () => readDaemonInfo(options.infoPath),
  }
}
