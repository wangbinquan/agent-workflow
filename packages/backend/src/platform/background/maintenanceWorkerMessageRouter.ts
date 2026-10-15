// RFC-338 — maintenance Worker inbound message routing.
//
// The supervisor legitimately posts `drain` before the Worker has answered
// `init`: daemon boot starts the maintenance service and immediately pauses it
// until the first provider session resume (cli/start.ts ->
// createPausableDaemonRuntimeServiceBindings). Routing every pre-ready frame
// into initialise() made that boot report
// `maintenance-worker-already-initialised`, close the connection the in-flight
// init was still opening ("Cannot use a closed database"), leave the generation
// unable to answer the supervisor's `wake` after `ready`
// (`maintenance-worker-first-message-must-be-init`), and stall each boot for
// the full 10s drain timeout. Routing is therefore a total decision table over
// the three lifecycle phases, and protocol violations never imply a teardown.

import {
  MaintenanceWorkerRequestSchema,
  type MaintenanceWorkerRequest,
} from './maintenanceProtocol'

export type MaintenanceWorkerInitRequest = Extract<MaintenanceWorkerRequest, { type: 'init' }>

/** `idle` also covers a Worker whose init failed and released its connection. */
export type MaintenanceWorkerPhase = 'idle' | 'initialising' | 'ready'

export type MaintenanceWorkerRouterAction =
  | { readonly kind: 'initialise'; readonly request: MaintenanceWorkerInitRequest }
  | { readonly kind: 'wake' }
  | { readonly kind: 'drain' }
  /** Mark the drain only; the in-flight initialise() owes the receipt. */
  | { readonly kind: 'defer-drain' }
  | { readonly kind: 'ignore'; readonly reason: 'wake-before-ready' }
  | { readonly kind: 'fail'; readonly error: string }

/** Throws only for frames the protocol schema rejects. */
export function routeMaintenanceWorkerRequest(
  phase: MaintenanceWorkerPhase,
  raw: unknown,
): MaintenanceWorkerRouterAction {
  const request = MaintenanceWorkerRequestSchema.parse(raw)
  if (request.type === 'init') {
    if (phase === 'idle') return { kind: 'initialise', request }
    return {
      kind: 'fail',
      error:
        phase === 'ready'
          ? 'maintenance-worker-init-after-ready'
          : 'maintenance-worker-already-initialised',
    }
  }
  if (request.type === 'wake') {
    // No queue is needed: initialise() polls the ledger once it is ready, and a
    // wake for a generation that never initialised is stale by definition.
    return phase === 'ready' ? { kind: 'wake' } : { kind: 'ignore', reason: 'wake-before-ready' }
  }
  // A drain that races init must not close the connection underneath it.
  return phase === 'initialising' ? { kind: 'defer-drain' } : { kind: 'drain' }
}
