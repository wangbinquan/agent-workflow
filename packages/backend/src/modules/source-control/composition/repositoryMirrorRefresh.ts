// RFC-531 — the deployment's periodic mirror refresh (the daemon's `submodule-refresh` handle drives it). The profile
// selects it, as it selects the mirrors themselves: standalone refreshes its own mirror clones' submodules; a hosted
// deployment keeps no mirror to refresh.
import { startConfiguredSubmoduleRefreshLoop } from '../infrastructure/local/repositoryMirrorAutoRefresh'
import type {
  RepositoryMirrorRefresh,
  RepositoryMirrorRefreshSelection,
} from './deploymentSelections'

/** RFC-531: the standalone profile's mirror refresh — the configured submodule refresh over its mirror clones (the daemon
 * started this loop itself when the deployment had no remote). */
export const composeLocalRepositoryMirrorRefresh: RepositoryMirrorRefreshSelection = (input) =>
  startConfiguredSubmoduleRefreshLoop(
    input.store,
    input.configuration,
    undefined,
    input.appHome,
    input.secretBox,
  )

/** RFC-531: the hosted profile's mirror refresh. A hosted deployment keeps no mirror to refresh — each task fetches the
 * latest inside its own volume (RFC-370 §10 V17) — so it runs nothing; the daemon's handle stays registered. One frozen
 * handle: the hosted selection hands every session this same object. */
export const idleRepositoryMirrorRefresh: RepositoryMirrorRefresh = Object.freeze({
  stop: () => undefined,
  reconfigure: async () => false,
  awaitIdle: async () => undefined,
})
