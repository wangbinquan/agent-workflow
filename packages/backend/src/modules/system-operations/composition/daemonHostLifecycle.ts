// RFC-524: bootstrap chooses between a selected host and the native one; this file only offers the native host.
export type {
  DaemonHostLifecyclePort,
  DaemonHostShutdownCallbacks,
} from '../application/ports/daemonHostLifecycle'
export {
  createNativeDaemonHostLifecycle,
  type NativeDaemonHostOptions,
} from '../infrastructure/local/nativeDaemonHostLifecycle'
// RFC-573: the read half on its own — the `status` command has no host to start, it only reads the run-info.
export { createFileDaemonRuntimeQueries } from '../infrastructure/local/fileDaemonRuntimeQueries'
