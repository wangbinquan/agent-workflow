// RFC-061 PR-B — scheduler-v2 barrel.
//
// In PR-B (T9-followup) this package will export:
//   - taskActor (full wake-queue main loop)
//   - taskActorRegistry (global Map<taskId, actor>)
//   - readyScanner (logical_runs projection scan implementing §7 SQL)
//   - dispatchAdapters (closures that bridge handlers to drizzle + runner)
//
// For now we export the pure decision core; the orchestrator layers
// build on top of it without changing the core.

export * from './actorRegistry'
export * from './daemonResume'
export * from './eventApplierWakeBridge'
export * from './readyScanner'
export * from './runnerAdapter'
export * from './runnerAdapterProduction'
export * from './runnerV2Invocation'
export * from './runnerV2'
export * from './runnerV2StdoutAggregator'
export * from './taskActor'
export * from './taskActorTick'
export * from './wakeQueue'
