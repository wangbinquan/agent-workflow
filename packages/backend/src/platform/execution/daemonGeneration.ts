// RFC-304 §2.3 崩溃恢复 — this process, named once.
//
// The lease protocol fences a crash with the daemon's GENERATION: a token reads
// `<generation>:<nonce>`, and `decideLeaseAcquisition` grants immediately when a
// lease's generation is not the running one, because the process that minted it
// is gone and will never renew or release it.
//
// That fence only works if the generation actually changes across a restart.
// `daemonGeneration` was declared on `RunTaskOptions`, registered in
// `INHERITABLE_RUN_CONFIG_KEYS` so child tasks carry their parent's, and read by
// the scheduler — and set by nobody, so every daemon that ever ran used the
// literal fallback `'dev'`. Same generation before and after a restart means the
// branch never fires: a daemon killed while holding leases blocked each of those
// merge requests for the lease's full lifetime, and the only sign was that
// nothing happened on them for fifteen minutes.
//
// Minted at module load, so it is stable for the life of the process and
// different in the next one — which is exactly the property the fence needs.

import { ulid } from 'ulid'

/** This daemon process's generation. Stable while it runs, new when it restarts. */
export const DAEMON_GENERATION = ulid()

/**
 * The generation a run should use.
 *
 * An explicit one wins so a CHILD task runs under its parent's: a child that
 * minted its own would treat its parent's live leases as void and take a merge
 * request out from under a round that is still writing to it. That is why the
 * key is inheritable; this is the other half of it.
 */
export function resolveDaemonGeneration(explicit: string | undefined): string {
  return explicit !== undefined && explicit !== '' ? explicit : DAEMON_GENERATION
}
