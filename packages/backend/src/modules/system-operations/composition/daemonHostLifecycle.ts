// RFC-524: bootstrap chooses between a selected host and the native one; this file only offers the native host.
export type {
  DaemonHostLifecyclePort,
  DaemonHostShutdownCallbacks,
} from '../application/ports/daemonHostLifecycle'
export {
  createNativeDaemonHostLifecycle,
  type NativeDaemonHostOptions,
} from '../infrastructure/local/nativeDaemonHostLifecycle'
